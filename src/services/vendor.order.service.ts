import { prisma } from "../config/prisma.ts";
import type { OrderStatus, CourierShipmentKind } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import courierService, { BOOKING_PENDING } from "./courier.service.ts";
import { lockOrderForReservation, orderReservationIntact } from "./order-reservation.ts";

import {
  money,
  allocateStockForOrderItem,
  releaseAllocationsForOrderItemInWarehouse,
} from "./order.service.ts";
import { StockMovementType } from "@prisma/client";
import {
  runStockMutation,
  applyStockDelta,
} from "../modules/shared/stock-mutations.ts";
import {
  packageWeightKg,
  shipmentWeightKg,
  PACKAGE_WEIGHT_SELECT,
} from "../modules/shared/package-weight.ts";
// ------------------------------------------------------------------
// NOTE: VendorOrder <-> CourierOrder is a ONE-TO-MANY relation
// (VendorOrder.courierOrders: CourierOrder[]) because a single vendor
// order can accumulate multiple courier shipments over its life
// (regular forward leg, reverse-return leg, exchange legs — see
// CourierShipmentKind, and now also multiple REGULAR legs when stock
// was split across warehouses). VendorOrder.courierOrderId is a plain
// scalar column pointing at the "active"/most-recent shipment.
// ------------------------------------------------------------------

function pickActiveCourierOrder<T extends { id: string }>(
  courierOrders: T[],
  courierOrderId: string | null | undefined,
) {
  if (!courierOrders.length) return undefined;
  if (courierOrderId) {
    const match = courierOrders.find((c) => c.id === courierOrderId);
    if (match) return match;
  }
  return courierOrders[0]; // assumes caller ordered by createdAt desc
}

/** Phase 4 (M-a): the vendor order changed between the read and the guarded write. */
export class VendorOrderStatusConflictError extends Error {
  readonly code = "VENDOR_ORDER_STATUS_CHANGED";
  constructor(message = "This order changed in the meantime (it may have been cancelled) — refresh and try again.") {
    super(message);
    this.name = "VendorOrderStatusConflictError";
  }
}

/**
 * COD fraud review: a PENDING COD order whose riskScore is at or above this
 * threshold is reserved for FinixMart's fraud review — the vendor's manual COD
 * confirmation must not bypass it. Same threshold the platform already uses:
 * placeOrder auto-confirms COD only when riskScore < 60, and
 * AdminOrderService.confirmOrderBySystem skips riskScore >= 60 (a missing score
 * counts as 0 there, and here). riskScore: higher = riskier.
 */
export const COD_REVIEW_RISK_THRESHOLD = 60;

const riskOf = (order: { riskScore?: unknown } | null | undefined) => Number(order?.riskScore ?? 0);

/** True when a vendor may NOT confirm this COD order — it awaits FinixMart's review. */
export function codReviewRequired(vo: { status?: string; order?: { paymentmethod?: string; riskScore?: unknown } | null }) {
  return vo.status === "PENDING" && vo.order?.paymentmethod === "COD" && riskOf(vo.order) >= COD_REVIEW_RISK_THRESHOLD;
}

/** Why an action is not offered to the store (shown as an explanation, never as a button). */
export type VendorActionNote =
  | "COD_REVIEW_REQUIRED"
  | "STOCK_RELEASED"
  | "AWAITING_PAYMENT"
  | "PAID_AWAITING_CONFIRMATION"
  | "BOOKING_NEEDS_ATTENTION";

/**
 * What the store may do with this vendor order right now — derived from the
 * same rules updateStatus / confirmCodOrder / markForDelivery /
 * confirmReturnReceipt enforce (they re-check; this drives the drawer).
 */
export function vendorOrderActions(
  vo: {
    status: string;
    order?: { paymentmethod?: string; riskScore?: unknown } | null;
    courierOrders?: { status: string; courierTrackingId?: string | null; courierStatus?: string | null; returnedAt?: Date | string | null; vendorConfirmedReturnAt?: Date | string | null; id?: string }[];
    courierOrderId?: string | null;
  },
  facts: { reservationIntact: boolean; paid: boolean },
) {
  const isCod = vo.order?.paymentmethod === "COD";
  const notes: VendorActionNote[] = [];
  const nextStatus = vo.status === "CONFIRMED" ? "PROCESSING" : vo.status === "PROCESSING" ? "PACKAGING" : null;

  let canConfirmCod = false;
  if (vo.status === "PENDING") {
    if (isCod) {
      if (codReviewRequired(vo)) notes.push("COD_REVIEW_REQUIRED");
      else if (!facts.reservationIntact) notes.push("STOCK_RELEASED");
      else canConfirmCod = true;
    } else {
      notes.push(facts.paid ? "PAID_AWAITING_CONFIRMATION" : "AWAITING_PAYMENT");
    }
  }

  const courierOrders = vo.courierOrders ?? [];
  const bookingBlocked = courierOrders.some((co) => {
    const st = deriveBookingState(co);
    return st === "IN_FLIGHT" || st === "NEEDS_RECONCILIATION";
  });
  let canMarkForDelivery = false;
  if (vo.status === "PACKAGING") {
    if (bookingBlocked) notes.push("BOOKING_NEEDS_ATTENTION");
    else if (!isCod && !facts.paid) notes.push("AWAITING_PAYMENT");
    else canMarkForDelivery = true;
  }

  const active = courierOrders.length ? pickActiveCourierOrder(courierOrders as any, vo.courierOrderId ?? null) : null;
  const canConfirmReturn = !!active?.returnedAt && !active?.vendorConfirmedReturnAt;

  return { nextStatus, canConfirmCod, canMarkForDelivery, canConfirmReturn, notes };
}

export class CodReviewRequiredError extends Error {
  readonly code = "COD_REVIEW_REQUIRED";
  constructor(message = "This high-risk cash-on-delivery order is awaiting FinixMart's fraud review and can't be confirmed by the store.") {
    super(message);
    this.name = "CodReviewRequiredError";
  }
}

/**
 * Phase 4 (M-b): a vendor-facing booking state for one courier row, derived
 * server-side so the raw intent text (and its claim token) is never sent.
 *   BOOKED               — the provider confirmed (tracking id set)
 *   PENDING              — unclaimed intent; Mark for delivery may retry it
 *   IN_FLIGHT            — a booking request is being submitted right now
 *   NEEDS_RECONCILIATION — UNKNOWN / CONFIRM_FAILED / legacy "in progress":
 *                          may exist at the courier; support must reconcile
 */
export type BookingState = "BOOKED" | "PENDING" | "IN_FLIGHT" | "NEEDS_RECONCILIATION" | "CANCELLED";

export function deriveBookingState(co: {
  status: string;
  courierTrackingId?: string | null;
  courierStatus?: string | null;
}): BookingState {
  if (co.status === "CANCELLED") return "CANCELLED";
  if (co.courierTrackingId) return "BOOKED";
  if (co.courierStatus === BOOKING_PENDING) return "PENDING";
  if (/^Booking submitting \[claim:/.test(co.courierStatus ?? "")) return "IN_FLIGHT";
  return "NEEDS_RECONCILIATION";
}

function withBookingStates<T>(vendorOrder: T): T {
  const vo = vendorOrder as any;
  if (!vo || !Array.isArray(vo.courierOrders)) return vendorOrder;
  return {
    ...vo,
    courierOrders: vo.courierOrders.map(({ courierStatus, ...co }: any) => ({
      ...co,
      bookingState: deriveBookingState({ ...co, courierStatus }),
    })),
  };
}

const vendorOrderListInclude = {
  order: {
    select: {
      id: true,
      totalAmount: true, 
      orderNumber: true,
      paymentStatus: true,
      paymentmethod: true,
      createdAt: true,
      confirmedAt: true,
      address: {
        select: {
          receiverFullName: true,
          phone: true,
          city: true,
          address: true,
          zone: true,
        },
      },
      user: { select: { id: true, name: true, email: true, phone: true } },
    },
  },
  items: {
    include: {
      variant: {
        include: {
          product: { select: { id: true, name: true, slug: true } },
          images: {
            take: 1,
            orderBy: { sortOrder: "asc" as const },
            select: { url: true, altText: true },
          },
          attributes: {
            include: { attributeValue: { include: { attribute: true } } },
          },
        },
      },
    },
  },
  // NOTE: courierOrderId is a scalar column on VendorOrder — when using
  // `include` (as this whole object is), scalar fields are returned
  // automatically and must NOT be listed explicitly here (that's only
  // valid inside a `select` block). Listing it caused:
  // "Invalid scalar field `courierOrderId` for include statement".
  courierOrders: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: {
      id: true,
      courierTrackingId: true,
      courierOrderId: true,
      status: true,
      courierStatus: true, // Phase 4: input to bookingState only — stripped before sending
      shipmentKind: true,
      lastStatusUpdate: true,
      courier_providers: {
        select: { name: true, displayName: true, logo: true },
      },
    },
  },
} as const;

const vendorOrderDetailInclude = {
  order: {
    include: {
      address: { include: { location: true } },
      user: { select: { id: true, name: true, email: true, phone: true } },
      payments: {
        orderBy: { createdAt: "desc" as const },
        take: 1,
        select: { method: true, status: true, amount: true, paidAt: true },
      },
    },
  },
  items: {
    include: {
      variant: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              slug: true,
              images: { take: 1, orderBy: { sortOrder: "asc" as const } },
            },
          },
          images: { take: 1, orderBy: { sortOrder: "asc" as const } },
          attributes: {
            include: { attributeValue: { include: { attribute: true } } },
          },
        },
      },
    },
  },
  courierOrders: {
    orderBy: { createdAt: "desc" as const },
    include: {
      courier_tracking_history: { orderBy: { timestamp: "desc" as const } },
      courier_providers: {
        select: { name: true, displayName: true, logo: true },
      },
    },
  },
  // PHASE 2 BATCH 1C-7B (G2): the vendor order's physical returns — creation
  // remains exclusively via confirmReturnReceipt; this is READ exposure of
  // the already-validated VendorReturn rows (consumed/available state,
  // condition, quantities, refund linkage).
  returns: {
    orderBy: { createdAt: "desc" as const },
    include: {
      items: {
        select: { id: true, orderItemId: true, variantId: true, quantity: true },
      },
      refund: { select: { id: true, status: true } },
    },
  },
  vendor: { select: { storeName: true, pickupAddress: true } },
} as const;

// ============================================================
// MASTER-ORDER STATUS AGGREGATION
// Derives Order.status/fulfillmentStatus from child VendorOrder
// statuses. Used by both vendor and admin services so the logic
// lives in one place.
// ============================================================

const STATUS_RANK: Record<string, number> = {
  CANCELLED: -1,
  PENDING: 0,
  CONFIRMED: 1,
  PROCESSING: 2,
  PACKAGING: 3,
  SHIPPED: 4,
  DELIVERED: 5,
  RETURNED: 6,
  FAILED_TO_DELIVER: 6,
};

export async function recalculateMasterOrderStatus(tx: any, orderId: string) {
  const siblings = await tx.vendorOrder.findMany({
    where: { orderId },
    select: { status: true },
  });
  if (!siblings.length) return;

  const active = siblings.filter((s: any) => s.status !== "CANCELLED");

  if (!active.length) {
    await tx.order.update({
      where: { id: orderId },
      data: { status: "CANCELLED" },
    });
    return;
  }

  const deliveredCount = active.filter(
    (s: any) => s.status === "DELIVERED",
  ).length;
  const allDelivered = deliveredCount === active.length;
  const someDelivered = deliveredCount > 0 && !allDelivered;

  if (allDelivered) {
    await tx.order.update({
      where: { id: orderId },
      data: { status: "DELIVERED", fulfillmentStatus: "FULFILLED" },
    });
    return;
  }
  if (someDelivered) {
    await tx.order.update({
      where: { id: orderId },
      data: { fulfillmentStatus: "PARTIALLY_FULFILLED" },
    });
    return;
  }

  const minRank = Math.min(
    ...active.map((s: any) => STATUS_RANK[s.status] ?? 0),
  );
  const laggingStatus = Object.entries(STATUS_RANK).find(
    ([, r]) => r === minRank,
  )?.[0];
  await tx.order.update({
    where: { id: orderId },
    data: { status: (laggingStatus ?? "PROCESSING") as OrderStatus },
  });
}

export const VendorOrderService = {
  async getAll(vendorId: string, filters: any) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 10;
    const skip = (page - 1) * limit;

    const where: any = { vendorId };
    if (filters.status) where.status = filters.status;
    if (filters.fulfillmentStatus)
      where.fulfillmentStatus = filters.fulfillmentStatus;
    if (filters.fromDate || filters.toDate) {
      where.createdAt = {};
      if (filters.fromDate) where.createdAt.gte = new Date(filters.fromDate);
      if (filters.toDate) where.createdAt.lte = new Date(filters.toDate);
    }
    if (filters.search) {
      where.OR = [
        {
          order: {
            orderNumber: { contains: filters.search, mode: "insensitive" },
          },
        },
        {
          order: {
            user: { name: { contains: filters.search, mode: "insensitive" } },
          },
        },
        {
          order: {
            address: {
              receiverFullName: {
                contains: filters.search,
                mode: "insensitive",
              },
            },
          },
        },
      ];
    }

    const [vendorOrders, total] = await Promise.all([
      prisma.vendorOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: vendorOrderListInclude,
      }),
      prisma.vendorOrder.count({ where }),
    ]);

    return {
      vendorOrders: vendorOrders.map(withBookingStates),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    };
  },

  async getById(vendorOrderId: string, vendorId: string) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      include: vendorOrderDetailInclude,
    });
    if (!vendorOrder) return null;
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");
    // Facts the action rules need that the payload doesn't carry.
    const [reservationIntact, paidCount] = await Promise.all([
      orderReservationIntact(prisma, vendorOrder.orderId),
      prisma.payment.count({ where: { orderId: vendorOrder.orderId, status: "PAID" } }),
    ]);
    const vendorActions = vendorOrderActions(vendorOrder as any, { reservationIntact, paid: paidCount > 0 });
    // codReviewRequired lets the drawer hide the manual COD confirmation (the endpoint refuses it anyway).
    return { ...withBookingStates(vendorOrder), codReviewRequired: codReviewRequired(vendorOrder), vendorActions };
  },

  async getOrderItems(vendorOrderId: string, vendorId: string) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      select: {
        vendorId: true,
        items: {
          include: {
            variant: {
              include: {
                product: { select: { id: true, name: true, slug: true } },
                images: { take: 1, orderBy: { sortOrder: "asc" } },
                attributes: {
                  include: { attributeValue: { include: { attribute: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");
    return vendorOrder.items;
  },

  async getStatistics(vendorId: string) {
    const [
      total,
      pending,
      confirmed,
      processing,
      packaging,
      shipped,
      delivered,
      cancelled,
      returned,
      revenueResult,
      pendingCodCount,
    ] = await Promise.all([
      prisma.vendorOrder.count({ where: { vendorId } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "PENDING" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "CONFIRMED" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "PROCESSING" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "PACKAGING" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "SHIPPED" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "DELIVERED" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "CANCELLED" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "RETURNED" } }),
      prisma.vendorOrder.aggregate({
        where: { vendorId, status: "DELIVERED" },
        _sum: { subtotal: true },
      }),
      prisma.vendorOrder.count({
        where: { vendorId, status: "PENDING", order: { paymentmethod: "COD" } },
      }),
    ]);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [todayOrders, todayRevenue] = await Promise.all([
      prisma.vendorOrder.count({
        where: { vendorId, createdAt: { gte: todayStart } },
      }),
      prisma.vendorOrder.aggregate({
        where: {
          vendorId,
          status: "DELIVERED",
          deliveredAt: { gte: todayStart },
        },
        _sum: { subtotal: true },
      }),
    ]);

    return {
      total,
      byStatus: {
        pending,
        confirmed,
        processing,
        packaging,
        shipped,
        delivered,
        cancelled,
        returned,
      },
      pendingCodConfirmations: pendingCodCount,
      totalRevenue: revenueResult._sum.subtotal ?? new Decimal(0),
      today: {
        orders: todayOrders,
        revenue: todayRevenue._sum.subtotal ?? new Decimal(0),
      },
    };
  },

  async getRevenue(vendorId: string, period: "daily" | "weekly" | "monthly") {
    const now = new Date();
    let fromDate: Date;
    if (period === "daily") {
      fromDate = new Date(now);
      fromDate.setDate(now.getDate() - 30);
    } else if (period === "weekly") {
      fromDate = new Date(now);
      fromDate.setDate(now.getDate() - 12 * 7);
    } else {
      fromDate = new Date(now);
      fromDate.setMonth(now.getMonth() - 12);
    }

    const vendorOrders = await prisma.vendorOrder.findMany({
      where: { vendorId, status: "DELIVERED", deliveredAt: { gte: fromDate } },
      select: { subtotal: true, deliveredAt: true },
      orderBy: { deliveredAt: "asc" },
    });

    const grouped: Record<string, { revenue: Decimal; orders: number }> = {};
    for (const vo of vendorOrders) {
      if (!vo.deliveredAt) continue;
      let key: string;
      if (period === "daily") key = vo.deliveredAt.toISOString().split("T")[0];
      else if (period === "weekly") {
        const d = new Date(vo.deliveredAt);
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        key = weekStart.toISOString().split("T")[0];
      } else
        key = `${vo.deliveredAt.getFullYear()}-${String(vo.deliveredAt.getMonth() + 1).padStart(2, "0")}`;

      if (!grouped[key]) grouped[key] = { revenue: new Decimal(0), orders: 0 };
      grouped[key].revenue = grouped[key].revenue.plus(vo.subtotal);
      grouped[key].orders += 1;
    }
    return Object.entries(grouped).map(([date, data]) => ({
      date,
      revenue: data.revenue.toString(),
      orders: data.orders,
    }));
  },

  async updateStatus(
    vendorOrderId: string,
    vendorId: string,
    newStatus: "PROCESSING" | "PACKAGING",
  ) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      select: { vendorId: true, status: true, orderId: true },
    });
    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");

    const allowedTransitions: Record<string, string[]> = {
      CONFIRMED: ["PROCESSING"],
      PROCESSING: ["PACKAGING"],
    };
    const allowed = allowedTransitions[vendorOrder.status] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Cannot transition from ${vendorOrder.status} to ${newStatus}. Allowed: ${allowed.join(", ") || "none"}`,
      );
    }

    // Phase 4 (M-a): guarded on the status read above — a cancellation or
    // fraud rejection that committed in between is never overwritten (it has
    // already released the stock and may have created a refund).
    const updated = await prisma.$transaction(async (tx) => {
      const moved = await tx.vendorOrder.updateMany({
        where: { id: vendorOrderId, vendorId, status: vendorOrder.status },
        data: { status: newStatus },
      });
      if (moved.count !== 1) throw new VendorOrderStatusConflictError();
      await recalculateMasterOrderStatus(tx, vendorOrder.orderId);
      return tx.vendorOrder.findUniqueOrThrow({
        where: { id: vendorOrderId },
        include: vendorOrderListInclude,
      });
    });

    await prisma.notification.create({
      data: {
        type: "ORDER",
        title: `Order ${newStatus}`,
        message: `Vendor order ${vendorOrderId} moved to ${newStatus}.`,
        targetType: "EMPLOYEE",
        targetId: vendorId,
        orderId: vendorOrder.orderId,
      },
    });

    return withBookingStates(updated);
  },

  /**
   * PACKAGING → per-warehouse bulk courier booking(s) → SHIPPED.
   *
   * ============================================================
   * DESIGN NOTES (read before touching this function)
   * ============================================================
   *
   * 1. WAREHOUSE GROUPING
   *    Each order item can be allocated across multiple warehouses
   *    (OrderItemAllocation, written at placeOrder time). This
   *    function groups all *pending* allocations (quantity - shippedQty
   *    > 0) by warehouseId. Every warehouse with pending allocations
   *    gets exactly ONE bulk CourierOrder — rack/row/shelf differences
   *    inside the same warehouse do NOT create separate shipments.
   *
   * 2. IDEMPOTENCY / CRASH RECOVERY
   *    Booking a courier order is an external API call that cannot be
   *    part of a DB transaction. If the process crashes (or the DB
   *    write fails) *after* a courier booking succeeds but *before*
   *    stock is dispatched, a naive "already has a courier order ->
   *    reject" guard would permanently strand the VendorOrder in
   *    PACKAGING with no way to retry.
   *
   *    Instead: on every call, we look at EXISTING non-cancelled
   *    REGULAR CourierOrders for this VendorOrder, keyed by
   *    warehouseId. For a warehouse that already has one, we reuse it
   *    (skip the booking API call) and only (re)run the stock-dispatch
   *    step for its allocations. For a warehouse with no existing
   *    booking, we book fresh. This makes the whole function safely
   *    retryable — calling it twice in a row (e.g. after a crash) picks
   *    up exactly where it left off instead of double-booking or
   *    erroring out permanently.
   *
   * 3. RACE CONDITION
   *    Status is checked once up front, but the courier API calls can
   *    take real wall-clock time. The final DB write uses a conditional
   *    `updateMany` (status still PACKAGING/SHIPPED-partial) instead of
   *    a blind `update`, so a concurrent cancellation is detected and
   *    surfaced instead of being silently overwritten.
   *
   * 4. ATOMICITY
   *    All DB writes (stock dispatch, allocation.shippedQty, VendorOrder
   *    status, master order status) happen in a single transaction.
   *    Only the courier API calls are outside it, by necessity.
   */
  async markForDelivery(
    vendorOrderId: string,
    vendorId: string,
    specialInstruction?: string,
  ) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      include: {
        order: {
          include: {
            address: { include: { location: true } },
            user: { select: { name: true, phone: true } },
          },
        },
        items: {
          include: {
            variant: {
              include: {
                product: { select: { name: true, warranty: { select: PACKAGE_WEIGHT_SELECT } } },
              },
            },
            allocations: true, // source of truth for which warehouse(s) this ships from
          },
        },
        // Existing REGULAR, non-cancelled shipments — used for idempotent resume.
        courierOrders: {
          where: { shipmentKind: "REGULAR", status: { not: "CANCELLED" } },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");

    // PACKAGING = normal entry point. SHIPPED = allowed ONLY as a resume
    // path (some warehouse groups already booked/dispatched, some not —
    // see idempotency note above). Anything else is a hard error.
    if (
      vendorOrder.status !== "PACKAGING" &&
      vendorOrder.status !== "SHIPPED"
    ) {
      throw new Error(
        `Order must be in PACKAGING status before marking for delivery. Current: ${vendorOrder.status}`,
      );
    }

    const orderAddress = vendorOrder.order.address;
    if (!orderAddress) throw new Error("Order has no delivery address");

    // ── Step 1: group PENDING allocations by warehouse ────────────────
    interface GroupItem {
      item: (typeof vendorOrder.items)[number];
      quantity: number;
      allocations: (typeof vendorOrder.items)[number]["allocations"];
    }
    const groups = new Map<string, GroupItem[]>();

    for (const item of vendorOrder.items) {
      const pendingAllocs = item.allocations.filter(
        (a) => a.quantity - a.shippedQty > 0,
      );
      if (!pendingAllocs.length) continue; // this item is fully shipped already (resume case)

      const byWarehouse = new Map<string, number>();
      for (const a of pendingAllocs) {
        byWarehouse.set(
          a.warehouseId,
          (byWarehouse.get(a.warehouseId) ?? 0) + (a.quantity - a.shippedQty),
        );
      }
      for (const [warehouseId, qty] of byWarehouse) {
        if (!groups.has(warehouseId)) groups.set(warehouseId, []);
        groups.get(warehouseId)!.push({
          item,
          quantity: qty,
          allocations: pendingAllocs.filter(
            (a) => a.warehouseId === warehouseId,
          ),
        });
      }
    }

    // delivery by the provider). The authoritative source is the Payment row.
    if (vendorOrder.order.paymentmethod !== "COD") {
      const prepaidPayment = await prisma.payment.findFirst({
        where: { orderId: vendorOrder.orderId, status: "PAID" },
        select: { id: true },
      });
      if (!prepaidPayment) {
        throw new Error(
          "Courier booking requires a verified successful payment for this order",
        );
      }
    }
    if (groups.size === 0) {
      if (vendorOrder.status === "SHIPPED") {
        throw new Error("This vendor order has already been fully shipped");
      }
      throw new Error(
        "No pending stock allocation found for this vendor order — nothing to ship",
      );
    }

    // Map existing non-cancelled courier orders by their warehouseId, so we
    // can skip re-booking a warehouse that was already booked in a prior
    // (possibly crashed) attempt.
    const existingByWarehouse = new Map<
      string,
      (typeof vendorOrder.courierOrders)[number]
    >();
    for (const co of vendorOrder.courierOrders) {
      if (co.warehouseId && !existingByWarehouse.has(co.warehouseId)) {
        existingByWarehouse.set(co.warehouseId, co);
      }
    }

    // 1C-13: a claimed booking whose provider outcome is UNKNOWN (request
    // sent, response lost) must be reconciled before anything ships —
    // it is never blindly re-booked and its stock is never dispatched on
    // an unconfirmed consignment. Such rows have no tracking id yet.
    for (const [whId, co] of existingByWarehouse) {
      if (groups.has(whId) && !co.courierTrackingId) {
        throw new Error(
          `Courier booking outcome unknown for warehouse ${whId} (booking …${co.id.slice(-12)}) — reconciliation with the courier provider is required before mark-for-delivery can proceed; no second consignment will be created for it`,
        );
      }
    }

    // ── Step 2: COD split (pro-rata across NEW bookings only) ─────────
    // Courier collects COD once per consignment. If a warehouse group
    // already has a booking (resume case), its COD was already fixed at
    // that booking's time — we must not re-quote it.
    const isCod = vendorOrder.order.paymentmethod === "COD";
    const totalCod = isCod
      ? money(vendorOrder.subtotal).plus(money(vendorOrder.shippingCost))
      : new Decimal(0);

    const warehousesNeedingBooking = [...groups.keys()].filter(
      (whId) => !existingByWarehouse.has(whId),
    );

    const groupTotals = new Map<string, Decimal>();
    let grandTotal = new Decimal(0);
    for (const whId of warehousesNeedingBooking) {
      const t = groups
        .get(whId)!
        .reduce(
          (s, gi) => s.plus(money(gi.item.price).times(gi.quantity)),
          new Decimal(0),
        );
      groupTotals.set(whId, t);
      grandTotal = grandTotal.plus(t);
    }
    const codFor = new Map<string, Decimal>();
    let assigned = new Decimal(0);
    warehousesNeedingBooking.forEach((whId, i) => {
      if (i === warehousesNeedingBooking.length - 1) {
        codFor.set(whId, totalCod.minus(assigned));
      } else {
        const share = grandTotal.isZero()
          ? new Decimal(0)
          : totalCod.times(groupTotals.get(whId)!).dividedBy(grandTotal);
        codFor.set(whId, share);
        assigned = assigned.plus(share);
      }
    });

    // ── Step 3: book couriers only for warehouses without one yet ─────
    // Courier API is an external call — kept outside the DB transaction.
    // If any NEW booking fails partway through, we compensate by
    // cancelling the ones we just created in THIS call (never touches
    // bookings that existed before this call started).
    //
    // ⚠️ FALLBACK: stock allocation (order.service.ts, at checkout time)
    // only ever considers STOCK when picking a warehouse — it has no
    // idea whether any courier can actually pick up from that
    // warehouse's location. So a warehouse can end up holding a
    // shipment's allocation despite having zero courier pickup coverage,
    // even when another of the vendor's warehouses has the same stock
    // AND working courier coverage. Previously that failed the entire
    // vendor order. Now: on that specific failure, move the group's
    // allocation to a different warehouse (excluding every warehouse
    // already tried in this call) and retry, up to
    // MAX_REALLOCATION_ATTEMPTS times per group.
    const MAX_REALLOCATION_ATTEMPTS = 3;
    const NO_COVERAGE_MESSAGE = "Service area mapping not found for selected courier";

    const newlyCreated: {
      courierResult: Awaited<
        ReturnType<typeof courierService.createCourierOrderForVendor>
      >;
      warehouseId: string;
      groupItems: GroupItem[];
    }[] = [];

    type PendingGroup = {
      warehouseId: string;
      groupItems: GroupItem[];
      failedWarehouseIds: string[];
    };
    const pending: PendingGroup[] = warehousesNeedingBooking.map((whId) => ({
      warehouseId: whId,
      groupItems: groups.get(whId)!,
      failedWarehouseIds: [],
    }));

    // codFor was computed once against the *original* warehouse groups.
    // A group that gets moved to a new warehouseId after a fallback
    // won't have an entry there — fall back to that group's own COD
    // share in that case.
    const codForWarehouse = (warehouseId: string, groupItems: GroupItem[]): Decimal => {
      const existing = codFor.get(warehouseId);
      if (existing) return existing;
      if (!isCod) return new Decimal(0);
      return groupItems.reduce(
        (s, gi) => s.plus(money(gi.item.price).times(gi.quantity)),
        new Decimal(0),
      );
    };

    try {
      while (pending.length > 0) {
        const current = pending.shift()!;
        const { warehouseId, groupItems, failedWarehouseIds } = current;

        const warehouse = await prisma.vendorWarehouse.findFirst({
          where: { id: warehouseId, vendorId },
          include: { location: true },
        });
        if (!warehouse)
          throw new Error(
            `Warehouse ${warehouseId} not found for vendor ${vendorId}`,
          );

        const totalQty = groupItems.reduce((s, gi) => s + gi.quantity, 0);
        // This warehouse group's shipment weight: Σ(package weight × qty
        // allocated here) — same shared formula as checkout pricing and the
        // cart preview, so the courier is booked with the weight it was quoted on.
        const totalWeight = shipmentWeightKg(
          groupItems.map((gi) => ({
            unitWeightKg: packageWeightKg(
              gi.item.variant.product.warranty,
              `courier booking variant ${gi.item.variantId}`,
            ),
            quantity: gi.quantity,
          })),
        );
        const itemDesc = groupItems
          .map((gi) => `${gi.item.variant.product.name} x${gi.quantity}`)
          .join(", ");

        // 1C-13: courier selection is a pure quote (no side effects) — done
        // before the claim so the intent row can carry its courierProviderId.
        const selectedCourier = await courierService.selectBestCourier({
          vendorWarehouseLocationId: warehouse.locationId,
          customerDeliveryLocationId: orderAddress.locationId,
          orderWeight: totalWeight,
          codAmount: codForWarehouse(warehouseId, groupItems).toNumber(),
          deliveryType: "NORMAL",
          warehouseId: warehouse.id, // Pathao/RedX price from this warehouse's own pickup store
        });

        // ── 1C-13: atomically claim the booking intent ────────────
        // The CourierOrder row is persisted BEFORE the provider call with a
        // deterministic merchant reference ("<vendorOrderId>-<warehouseId>"),
        // so a lost response leaves a reconcilable marker instead of an
        // orphan shipment. The partial unique index (vendorOrderId,
        // warehouseId) WHERE REGULAR AND status <> 'CANCELLED' makes a
        // concurrent claim for the same logical shipment impossible at the
        // database level.
        const attemptCount = await prisma.courierOrder.count({
          where: { vendorOrderId, warehouseId, shipmentKind: "REGULAR" },
        });
        const merchantReference =
          attemptCount === 0
            ? `${vendorOrderId}-${warehouseId}`
            : `${vendorOrderId}-${warehouseId}-${attemptCount + 1}`;
        let intentId = "";
        await runStockMutation(prisma, async (tx) => {
          const intent = await tx.courierOrder.create({
            data: {
              orderId: vendorOrder.orderId,
              vendorId,
              vendorOrderId,
              warehouseId,
              courierProviderId: selectedCourier.courierProviderId,
              merchantReference,
              // provider pickup store the quote was priced for (Pathao/RedX) —
              // persisted with the intent so an UNKNOWN outcome stays reconcilable
              pickupStoreId: selectedCourier.pricing.pickupStoreId ?? null,
              recipientName: orderAddress.receiverFullName,
              recipientPhone: orderAddress.phone,
              recipientAddress: orderAddress.address,
              deliveryLocationId: orderAddress.locationId,
              itemDescription: itemDesc,
              itemQuantity: totalQty,
              itemWeight: totalWeight,
              specialInstruction: specialInstruction,
              codAmount: codForWarehouse(warehouseId, groupItems).toNumber(),
              deliveryCharge: 0,
              codCharge: 0,
              totalCharge: 0,
              deliveryType: "STANDARD",
              status: "PENDING_PICKUP",
              // Phase 0: the only claimable state (legacy "Booking in progress"
              // rows may already have been sent to a provider and stay blocked)
              courierStatus: BOOKING_PENDING,
              lastStatusUpdate: new Date(),
            },
          });
          intentId = intent.id;
        });

        let courierResult: Awaited<
          ReturnType<typeof courierService.createCourierOrderForVendor>
        >;
        try {
          courierResult = await courierService.createCourierOrderForVendor(
            vendorOrder.orderId,
            vendorId,
            {
              recipientName: orderAddress.receiverFullName,
              recipientPhone: orderAddress.phone,
              recipientAddress: orderAddress.address,
              recipientLocationId: orderAddress.locationId,
              vendorWarehouseLocationId: warehouse.locationId,
              itemDescription: itemDesc,
              itemQuantity: totalQty,
              itemWeight: totalWeight,
              codAmount: codForWarehouse(warehouseId, groupItems).toNumber(),
              deliveryType: "NORMAL",
              specialInstructions: specialInstruction,
              vendorOrderId,
              warehouseId: warehouse.id,
              intentId,
              merchantReference,
              preselectedCourier: selectedCourier,
            },
          );
        } catch (err: any) {
          // Phase 0: createCourierOrderForVendor records the outcome on the
          // intent itself (guarded on its claim) and tags every error. An
          // untagged error is treated as UNRESOLVED, never as REJECTED.
          const outcome = err?.courierBookingOutcome ?? "UNKNOWN";

          if (outcome !== "REJECTED") {
            // UNKNOWN / CONFIRM_FAILED / STALE / NOT_CLAIMED /
            // OUTCOME_NOT_RECORDED: the provider may have created the shipment
            // (or this request no longer owns the intent). The intent row stays
            // a reconciliation marker — NO rebooking, NO reallocation, NO stock
            // dispatch until the outcome is resolved.
            const unresolvedErr = new Error(
              `Courier booking outcome unresolved (${outcome}) for shipment ${merchantReference} — reconciliation with the courier provider is required before this warehouse can ship`,
            );
            (unresolvedErr as any).courierBookingOutcome = outcome;
            throw unresolvedErr;
          }

          // REJECTED: nothing was created at the provider and the service has
          // already cancelled the intent, which frees the logical shipment for
          // a clean retry (and for the warehouse reallocation fallback below).
          const noCoverage = err?.message?.includes(NO_COVERAGE_MESSAGE);

          if (!noCoverage || failedWarehouseIds.length >= MAX_REALLOCATION_ATTEMPTS) {
            // A real API failure (not a coverage gap), or we've already
            // tried moving this group enough times — stop pretending we
            // can route around it.
            throw err;
          }

          console.warn(
            `[markForDelivery] Warehouse ${warehouseId} (vendorOrder ${vendorOrderId}) has no courier pickup coverage — ` +
              `attempting to move ${groupItems.length} item group(s) to a different warehouse ` +
              `(attempt ${failedWarehouseIds.length + 1}/${MAX_REALLOCATION_ATTEMPTS}).`,
          );

          const alreadyTried = [
            ...failedWarehouseIds,
            warehouseId,
            ...newlyCreated.map((c) => c.warehouseId), // never move INTO an already-booked warehouse from this same call
          ];

          const movedByWarehouse = new Map<string, GroupItem[]>();

          await runStockMutation(prisma, async (tx) => {
            for (const gi of groupItems) {
              const released = await releaseAllocationsForOrderItemInWarehouse(
                tx,
                gi.item.id,
                warehouseId,
              );
              if (released <= 0) continue;

              try {
                await allocateStockForOrderItem(
                  tx,
                  gi.item.id,
                  gi.item.variantId,
                  vendorId,
                  released,
                  alreadyTried,
                );
              } catch (allocErr) {
                // No other warehouse has enough sellable stock either —
                // put it back where it was rather than losing the
                // reservation, and let this surface as a real failure.
                await allocateStockForOrderItem(
                  tx,
                  gi.item.id,
                  gi.item.variantId,
                  vendorId,
                  released,
                  alreadyTried.filter((id) => id !== warehouseId),
                );
                throw allocErr;
              }

              const freshAllocs = await tx.orderItemAllocation.findMany({
                where: { orderItemId: gi.item.id },
              });
              for (const a of freshAllocs) {
                const toShip = a.quantity - a.shippedQty;
                if (toShip <= 0 || alreadyTried.includes(a.warehouseId)) continue;
                if (!movedByWarehouse.has(a.warehouseId)) movedByWarehouse.set(a.warehouseId, []);
                movedByWarehouse.get(a.warehouseId)!.push({
                  item: gi.item,
                  quantity: toShip,
                  allocations: freshAllocs.filter((x: any) => x.warehouseId === a.warehouseId),
                });
              }
            }
          });

          if (movedByWarehouse.size === 0) {
            throw new Error(
              `Could not find an alternate warehouse with both stock and courier coverage for: ${itemDesc}. Original error: ${err.message}`,
            );
          }

          for (const [whId, items] of movedByWarehouse) {
            const existingPending = pending.find((p) => p.warehouseId === whId);
            if (existingPending) {
              existingPending.groupItems.push(...items);
              existingPending.failedWarehouseIds = [
                ...new Set([...existingPending.failedWarehouseIds, ...alreadyTried]),
              ];
            } else {
              pending.push({ warehouseId: whId, groupItems: items, failedWarehouseIds: alreadyTried });
            }
          }
          continue; // next loop iteration picks up the moved group(s)
        }

        if (!courierResult.success)
          throw new Error(
            `Courier booking failed for warehouse ${warehouseId}`,
          );
        newlyCreated.push({ courierResult, warehouseId, groupItems });
      }
    } catch (err) {
      // 1C-13: booking-intent rows are finalized by the outcome handler in
      // the booking loop itself — CANCELLED on definitive rejection (freeing
      // the logical shipment for a clean retry), left as a reconciliation
      // marker on UNKNOWN outcomes. Successfully booked rows are REAL live
      // consignments: cancelling them locally would desync FinixMart from the
      // provider, so no blanket compensation happens here. Stock was only
      // dispatched for successfully booked warehouses (Step 4 runs after the
      // loop) — a thrown error means no dispatch happened for the failed
      // group. VendorOrder stays PACKAGING and the call can be retried.
      throw err;
    }

    // All warehouse groups we need to dispatch stock for in this call —
    // both freshly booked ones and pre-existing ones being resumed.
    const allGroupsToProcess: {
      warehouseId: string;
      groupItems: GroupItem[];
      courierOrderId: string;
    }[] = [
      ...newlyCreated.map((c) => ({
        warehouseId: c.warehouseId,
        groupItems: c.groupItems,
        courierOrderId: c.courierResult.courierOrder.id,
      })),
      ...[...existingByWarehouse.entries()]
        .filter(([whId]) => groups.has(whId))
        .map(([whId, co]) => ({
          warehouseId: whId,
          groupItems: groups.get(whId)!,
          courierOrderId: co.id,
        })),
    ];

    // ── Step 4: DB transaction — dispatch stock from allocation rows ──
    // Re-checks VendorOrder status inside the transaction (via a
    // conditional updateMany) so a concurrent cancellation between Step 0
    // and here is caught instead of silently overwritten.
    const activeCourierOrderId =
      allGroupsToProcess[allGroupsToProcess.length - 1].courierOrderId;

    const updated = await runStockMutation(prisma, async (tx) =>{
      for (const { warehouseId, groupItems } of allGroupsToProcess) {
        for (const gi of groupItems) {
          for (const alloc of gi.allocations) {
            const toShip = alloc.quantity - alloc.shippedQty;
            if (toShip <= 0) continue;

            const stockRow = await tx.warehouseStock.findFirst({
              where: {
                variantId: gi.item.variantId,
                warehouseId: alloc.warehouseId,
                rackId: alloc.rackId,
                rowNumber: alloc.rowNumber,
                shelfNumber: alloc.shelfNumber,
              },
            });
            if (!stockRow) {
              throw new Error(
                `Stock row missing for variant ${gi.item.variantId} @ warehouse ${alloc.warehouseId}`,
              );
            }

            const take = Math.min(
              toShip,
              stockRow.reservedQty,
              stockRow.quantity,
            );
            if (take <= 0) {
              throw new Error(
                `Reservation mismatch for variant ${gi.item.variantId}: nothing left to dispatch`,
              );
            }

            await applyStockDelta(tx, {
              variantId: gi.item.variantId,
              warehouseId: alloc.warehouseId,
              rackId: alloc.rackId,
              rowNumber: alloc.rowNumber,
              shelfNumber: alloc.shelfNumber,
              quantityDelta: -take,
              reservedDelta: -take,
              reason: `Ship (vendor order ${vendorOrderId})`,
            });
            await tx.orderItemAllocation.update({
              where: { id: alloc.id },
              data: { shippedQty: { increment: take } },
            });

            await tx.stockMovement.create({
              data: {
                variantId: gi.item.variantId,
                fromWarehouseId: warehouseId,
                rackId: alloc.rackId,
                movementType: StockMovementType.SALE_DEDUCT,
                quantity: take,
                referenceId: vendorOrderId,
                createdBy: "vendor_order_service",
              },
            });
          }
        }
      }

      // Conditional update: only flips to SHIPPED if the row is still in a
      // state we expect (PACKAGING on first pass, SHIPPED if resuming a
      // partially-completed prior call). If a concurrent cancel changed
      // this in between, matchCount will be 0 and we abort the transaction.
      const result = await tx.vendorOrder.updateMany({
        where: { id: vendorOrderId, status: { in: ["PACKAGING", "SHIPPED"] } },
        data: {
          courierOrderId: activeCourierOrderId,
          status: "SHIPPED",
          shippedAt: vendorOrder.status === "SHIPPED" ? undefined : new Date(),
        },
      });
      if (result.count === 0) {
        throw new Error(
          "Vendor order status changed concurrently (e.g. cancelled) — aborting dispatch",
        );
      }

      await recalculateMasterOrderStatus(tx, vendorOrder.orderId);

      return tx.vendorOrder.findUniqueOrThrow({ where: { id: vendorOrderId } });
    });

    // Notify only for the shipments booked in THIS call (avoid re-notifying
    // for warehouses that were already booked in a previous attempt).
    for (const c of newlyCreated) {
      await prisma.notification.create({
        data: {
          type: "COURIER",
          title: "Courier Pickup Requested",
          message: `Shipping label ready — tracking ID ${c.courierResult.courierOrder.trackingId}. Please hand over to the courier.`,
          targetType: "VENDOR",
          targetId: vendorId,
          orderId: vendorOrder.orderId,
          courierOrderId: c.courierResult.courierOrder.id,
          actionUrl: `/vendor/orders/${vendorOrderId}/shipping-label`,
        },
      });
    }

    return {
      vendorOrder: updated,
      courierOrders: allGroupsToProcess.map((g) => ({
        warehouseId: g.warehouseId,
        courierOrderId: g.courierOrderId,
      })),
      newlyBooked: newlyCreated.map((c) => c.courierResult.courierOrder),
      shippingLabelUrl: `/api/vendor-orders/${vendorOrderId}/shipping-label`,
    };
  },

  /** COD-only confirm path — admin.confirmOrder() rejects COD orders explicitly. */
  async confirmCodOrder(
    vendorOrderId: string,
    vendorId: string,
    confirmedByName: string,
    note?: string,
  ) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            paymentmethod: true,
            status: true,
            userId: true,
            riskScore: true,
          },
        },
      },
    });

    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");
    if (vendorOrder.order.paymentmethod !== "COD")
      throw new Error("This order is not a COD order");
    if (vendorOrder.status !== "PENDING")
      throw new Error(
        `Order is not in PENDING status. Current: ${vendorOrder.status}`,
      );
    // Fraud review: high-risk COD orders are confirmed by FinixMart, never by the store.
    // (riskScore is fixed at placement, so this pre-transaction check cannot go stale.)
    if (riskOf(vendorOrder.order) >= COD_REVIEW_RISK_THRESHOLD) throw new CodReviewRequiredError();

    await prisma.$transaction(async (tx) => {
      // H1: an order whose stock reservation was released can't be confirmed
      // for fulfilment — it could never be booked with a courier.
      await lockOrderForReservation(tx, vendorOrder.orderId);
      if (!(await orderReservationIntact(tx, vendorOrder.orderId))) {
        throw new Error("This order's stock reservation was released, so it can't be confirmed. Contact FinixMart support to review it.");
      }
      // Phase 4 (M-a): guarded on PENDING — a fraud rejection or customer
      // cancellation (both move every vendor order to CANCELLED in the same
      // transaction) that committed after the read above is never undone.
      const moved = await tx.vendorOrder.updateMany({
        where: { id: vendorOrderId, vendorId, status: "PENDING" },
        data: { status: "CONFIRMED" },
      });
      if (moved.count !== 1) throw new VendorOrderStatusConflictError();
      await recalculateMasterOrderStatus(tx, vendorOrder.orderId);

      await tx.auditLog.create({
        data: {
          action: "COD_ORDER_CONFIRMED_BY_VENDOR",
          entity: "VendorOrder",
          entityId: vendorOrderId,
          newData: { confirmedByName, note, vendorId },
        },
      });
    });

    if (vendorOrder.order.userId) {
      await prisma.notification.create({
        data: {
          type: "ORDER",
          title: "Order Confirmed",
          message: `Your order ${vendorOrder.order.orderNumber} has been confirmed.`,
          targetType: "USER",
          targetId: vendorOrder.order.userId,
          orderId: vendorOrder.orderId,
          actionUrl: `/orders/${vendorOrder.orderId}`,
        },
      });
    }

    return { success: true };
  },

  /**
   * Vendor confirms physical receipt of a returned parcel in sellable
   * condition. This is the gate that unblocks admin.approveRefund()'s
   * COGS-reversal accounting and restores physical warehouse stock.
   */
  async confirmReturnReceipt(
    vendorOrderId: string,
    vendorId: string,
    sellable: boolean,
    note?: string,
  ) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      include: {
        courierOrders: {
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true, returnedAt: true, vendorConfirmedReturnAt: true },
        },
        returns: { select: { id: true, condition: true, status: true } },
        items: { include: { allocations: true } }, // exact dispatch location জানতে দরকার
      },
    });
    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");

    const activeCourierOrder = pickActiveCourierOrder(
      vendorOrder.courierOrders,
      vendorOrder.courierOrderId,
    );
    if (!activeCourierOrder?.returnedAt)
      throw new Error("Courier has not yet reported this parcel as returned");

    // PHASE 2 BATCH 1C-5: persistent Return/RMA foundation + idempotency.
    // The VendorReturn row's unique (vendorOrderId, condition) constraint is
    // the transaction-safe idempotency guard: a concurrent duplicate
    // confirmation aborts on P2002 and is answered with the existing record
    // — stock can never be restocked twice for the same physical return.
    const condition = sellable ? "SELLABLE" : "DAMAGED";
    const alreadyConfirmed = vendorOrder.returns?.find(
      (r: any) => r.condition === condition && r.status === "CONFIRMED",
    );
    // 1C-19: the authoritative receipt-guard flag lives on the CourierOrder
    // (the webhook writes courierOrder.vendorConfirmedReturnAt); the old
    // check read vendorOrder.vendorConfirmedReturnAt, which does not exist
    // on VendorOrder, so the guard never fired and protection relied solely
    // on the VendorReturn unique index.
    if (alreadyConfirmed || activeCourierOrder.vendorConfirmedReturnAt) {
      const existing = await prisma.vendorReturn.findFirst({
        where: { vendorOrderId, condition },
        select: { id: true, status: true },
      });
      return {
        success: true,
        sellable,
        alreadyConfirmed: true,
        returnId: existing?.id ?? null,
      };
    }

    try {
      const result = await runStockMutation(prisma, async (tx) => {
        // 1C-19: re-verify the receipt flag INSIDE the transaction. The
        // (vendorOrderId, condition) unique index no longer exists (dropped
        // in 1C-5D), so the stale P2002 backstop cannot deduplicate
        // concurrent confirmations: all of them pass the outside pre-checks
        // before any commit and would each create a VendorReturn and restock
        // again. The courierOrder write below is the serialization point —
        // under Serializable the loser retries, re-reads the committed flag,
        // and converges to the idempotent answer.
        const freshCourier = await tx.courierOrder.findUnique({
          where: { id: activeCourierOrder.id },
          select: { vendorConfirmedReturnAt: true },
        });
        if (freshCourier?.vendorConfirmedReturnAt) {
          return { alreadyConfirmed: true };
        }

        // Create the persistent Return/RMA record (1C-5).
        const vendorReturn = await tx.vendorReturn.create({
          data: {
            vendorOrderId,
            vendorId,
            condition,
            status: "CONFIRMED",
            confirmedBy: vendorId,
            note,
          },
        });

        for (const item of vendorOrder.items) {
          await tx.vendorReturnItem.create({
            data: {
              returnId: vendorReturn.id,
              orderItemId: item.id,
              variantId: item.variantId,
              quantity: item.quantity,
            },
          });
        }

        await tx.courierOrder.update({
          where: { id: activeCourierOrder.id },
          data: { vendorConfirmedReturnAt: new Date() },
        });

        if (sellable) {
          for (const item of vendorOrder.items) {
            for (const alloc of item.allocations) {
              if (alloc.shippedQty <= 0) continue;
              await applyStockDelta(tx, {
                variantId: item.variantId,
                warehouseId: alloc.warehouseId,
                rackId: alloc.rackId,
                rowNumber: alloc.rowNumber,
                shelfNumber: alloc.shelfNumber,
                quantityDelta: alloc.shippedQty,
                reason: `Return confirmed sellable (${vendorOrderId})`,
              });
              await tx.stockMovement.create({
                data: {
                  variantId: item.variantId,
                  toWarehouseId: alloc.warehouseId,
                  rackId: alloc.rackId,
                  movementType: "RETURN",
                  quantity: alloc.shippedQty,
                  reason: note ?? "Return confirmed sellable",
                  // durable tie to the persistent Return/RMA (Batch 1C-5)
                  referenceId: vendorReturn.id,
                  createdBy: vendorId,
                },
              });
            }
          }
        }

        await tx.auditLog.create({
          data: {
            action: "VENDOR_CONFIRMED_RETURN_RECEIPT",
            entity: "VendorReturn",
            entityId: vendorReturn.id,
            newData: { sellable, note, vendorOrderId, vendorId },
            userId: null,
          },
        });

        return { returnId: vendorReturn.id };
      });

      if ((result as any).alreadyConfirmed) {
        // 1C-19: a concurrent confirmation won the race — answer idempotently.
        const existing = await prisma.vendorReturn.findFirst({
          where: { vendorOrderId, condition },
          select: { id: true },
        });
        return { success: true, sellable, alreadyConfirmed: true, returnId: existing?.id ?? null };
      }

      return { success: true, sellable, returnId: result.returnId };
    } catch (err: any) {
      if (err?.code === "P2002") {
        // concurrent duplicate confirmation — safe idempotent response
        const existing = await prisma.vendorReturn.findFirst({
          where: { vendorOrderId, condition },
          select: { id: true },
        });
        return {
          success: true,
          sellable,
          alreadyConfirmed: true,
          returnId: existing?.id ?? null,
        };
      }
      throw err;
    }
  },

  async getShippingLabel(vendorOrderId: string, vendorId: string) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      include: {
        courierOrders: {
          orderBy: { createdAt: "desc" },
          include: {
            courier_providers: {
              select: { name: true, displayName: true, logo: true },
            },
          },
        },
        order: {
          include: {
            address: { include: { location: true } },
            user: { select: { name: true, phone: true } },
          },
        },
        vendor: { select: { storeName: true, pickupAddress: true } },
        items: {
          include: {
            variant: { include: { product: { select: { name: true } } } },
          },
        },
      },
    });

    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");

    // Multiple shipments possible now — return ALL active courier orders,
    // not just one. Callers that render a single label should iterate.
    const activeCourierOrders = vendorOrder.courierOrders.filter(
      (c) => c.status !== "CANCELLED",
    );
    if (!activeCourierOrders.length)
      throw new Error(
        "Shipping label is not yet available. Please mark the order for delivery first.",
      );

    return { ...vendorOrder, courierOrders: activeCourierOrders };
  },

  async getTracking(vendorOrderId: string, vendorId: string) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      select: {
        vendorId: true,
        status: true,
        fulfillmentStatus: true,
        shippedAt: true,
        deliveredAt: true,
        courierOrderId: true,
        courierOrders: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            courierTrackingId: true,
            courierOrderId: true,
            status: true,
            shipmentKind: true,
            lastStatusUpdate: true,
            warehouseId: true,
            courier_providers: { select: { name: true, displayName: true } },
            courier_tracking_history: {
              orderBy: { timestamp: "desc" },
              select: {
                id: true,
                status: true,
                courierStatus: true,
                messageEn: true,
                messageBn: true,
                location: true,
                timestamp: true,
              },
            },
          },
        },
      },
    });

    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");

    const activeCourierOrders = vendorOrder.courierOrders.filter(
      (c) => c.status !== "CANCELLED",
    );
    if (!activeCourierOrders.length)
      throw new Error("No courier assigned yet for this order");

    // Return all shipments — UI should render "Shipment 1/2" style if
    // this order was split across warehouses.
    return { ...vendorOrder, courierOrders: activeCourierOrders };
  },
};