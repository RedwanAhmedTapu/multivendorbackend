import { prisma } from "../config/prisma.ts";
import type {
  OrderStatus,
  PaymentStatus,
  RefundType,
  RefundStatus,
  CourierOrderStatus,
  CourierShipmentKind,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import courierService, { BOOKING_PENDING } from "./courier.service.ts";
import { recalculateMasterOrderStatus, COD_REVIEW_RISK_THRESHOLD } from "./vendor.order.service.ts";
import { AccountingService } from "./accounting.services.ts";
import { paymentService } from "./payment.service.ts";
import { releaseAllocationsForOrderItem, createCancellationRefundOnce } from "./order.service.ts";
import { getPlatformSetting } from "../modules/shared/platform-settings.ts";
import { postDeliveryVoucherForVendorOrder, reverseEvent0aForOrder } from "./order-accounting.service.ts";
import { accrueAgentCommissionForDeliverySafe } from "../modules/agent/services/agent-commission.service.ts";
import { runStockMutation } from "../modules/shared/stock-mutations.ts";
import { lockRefundableBalance, REFUND_EPSILON } from "./refund-balance.ts";
import { isReservationIntact, lockOrderForReservation, orderReservationIntact, STOCK_HOLD_REASON } from "./order-reservation.ts";
import { reconciliationOf } from "./payment-reconciliation.ts";

const accountingService = new AccountingService();

export interface AdminOrderFilters {
  page?: number;
  limit?: number;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  vendorId?: string;
  userId?: string;
  search?: string;
  fromDate?: string;
  toDate?: string;
}

// ------------------------------------------------------------------
// NOTE: VendorOrder <-> CourierOrder is now a ONE-TO-MANY relation
// (VendorOrder.courierOrders: CourierOrder[]), because a single vendor
// order can have multiple courier shipments over its lifetime (regular
// forward leg, reverse-return leg, exchange legs, etc — see
// CourierShipmentKind). VendorOrder.courierOrderId is still a plain
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

const orderListInclude = {
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      isVerified: true,
    },
  },
  address: {
    select: {
      receiverFullName: true,
      phone: true,
      city: true,
      address: true,
      zone: true,
    },
  },
  vendorOrders: {
    select: {
      id: true,
      status: true,
      fulfillmentStatus: true,
      subtotal: true,
      vendor: { select: { id: true, storeName: true } },
      items: { select: { quantity: true, price: true } },
      courierOrderId: true,
      courierOrders: {
        orderBy: { createdAt: "desc" as const },
        take: 1,
        select: { courierTrackingId: true, status: true },
      },
    },
  },
  payments: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: { method: true, status: true, amount: true, paidAt: true },
  },
} as const;

const orderDetailInclude = {
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      isVerified: true,
      createdAt: true,
    },
  },
  address: { include: { location: true } },
  vendorOrders: {
    include: {
      vendor: {
        select: { id: true, storeName: true, avatar: true, email: true },
      },
      items: {
        include: {
          variant: {
            include: {
              product: { select: { id: true, name: true, slug: true } },
              images: { take: 1, orderBy: { sortOrder: "asc" as const } },
            },
          },
        },
      },
      courierOrders: {
        orderBy: { createdAt: "desc" as const },
        include: {
          courier_tracking_history: { orderBy: { timestamp: "desc" as const } },
          courier_providers: { select: { name: true, displayName: true } },
        },
      },
    },
  },
  payments: { orderBy: { createdAt: "desc" as const } },
  refunds: {
    orderBy: { createdAt: "desc" as const },
    include: { detail: true },
  },
  offerUsages: {
    include: {
      offer: { select: { title: true, type: true, discountType: true } },
    },
  },
} as const;

// ── Commission resolution (PHASE 2 Batch 1A-2, Part B + approved migration) ─
// First match wins per order line:
//   1. vendor + category rate  → VendorCommission { vendorId, categoryId }
//   2. vendor-wise rate        → VendorCommission { vendorId, categoryId: null }
//   3. category global rate    → CategoryCommission { categoryId }
//   4. global default          → platform_settings key "commission_default_rate"
//      (percent units). MISSING KEY THROWS — silently defaulting to 0% would
//      under-charge commission across the platform.
// Levels 1-2 reuse the SAME table the admin panel writes via
// vendor.service.ts setCommissionRate() — nothing duplicated.
// NOTE: platform_settings is read via $queryRaw because `prisma generate`
// cannot run while the dev server holds the query-engine DLL; the typed
// model lands in the client on the next successful generate/restart.
export type ResolvedCommission = {
  rate: Decimal;
  source: "VENDOR_CATEGORY" | "VENDOR" | "CATEGORY" | "GLOBAL_DEFAULT";
};


export async function resolveCommissionRateForLine(
  vendorId: string,
  categoryId: string | null,
): Promise<ResolvedCommission> {
  if (categoryId) {
    const vendorCategory = await prisma.vendorCommission.findUnique({
      where: { vendorId_categoryId: { vendorId, categoryId } },
    });
    if (vendorCategory) return { rate: new Decimal(vendorCategory.rate), source: "VENDOR_CATEGORY" };
  }

  const vendorWide = await prisma.vendorCommission.findFirst({
    where: { vendorId, categoryId: null },
  });
  if (vendorWide) return { rate: new Decimal(vendorWide.rate), source: "VENDOR" };

  if (categoryId) {
    const category = await prisma.categoryCommission.findUnique({ where: { categoryId } });
    if (category) return { rate: new Decimal(category.rate), source: "CATEGORY" };
  }

  const globalDefault = await getPlatformSetting("commission_default_rate");
  if (!globalDefault) {
    throw new Error(
      "Commission configuration error: platform_settings key 'commission_default_rate' is missing — " +
        "refusing to fall back to 0% (per spec). Seed the key and retry.",
    );
  }
  // stored in PERCENT units (e.g. "10" = 10%) → fraction
  return { rate: new Decimal(globalDefault.value).dividedBy(100), source: "GLOBAL_DEFAULT" };
}

/**
 * Phase 3 (H-5 / M-d): a refused admin status change — 422 for a transition
 * the override may not perform, 409 when the record changed concurrently.
 */
export class OrderStatusTransitionError extends Error {
  readonly code = "STATUS_TRANSITION_NOT_ALLOWED";
  // Explicit fields (no TS parameter properties): `npm run dev` / `npx ts-node`
  // run on Node's native type stripping, which rejects parameter properties.
  readonly statusCode: 409 | 422;
  constructor(statusCode: 409 | 422, message: string) {
    super(message);
    this.name = "OrderStatusTransitionError";
    this.statusCode = statusCode;
  }
}

/** The only vendor-order steps the admin override performs (the vendor's own preparation steps). */
const ADMIN_VENDOR_ORDER_TRANSITIONS: Partial<Record<string, string>> = {
  CONFIRMED: "PROCESSING",
  PROCESSING: "PACKAGING",
};

/** Phase 4 (H-2): the refund was approved / rejected by someone else meanwhile. */
export class RefundStateConflictError extends Error {
  readonly code = "REFUND_STATE_CHANGED";
  constructor(message = "This refund was already approved or rejected — refresh and try again.") {
    super(message);
    this.name = "RefundStateConflictError";
  }
}

/** One review-queue row: facts + the actions the backend will accept. No raw payment meta. */
export function toReviewItem(o: any) {
  const isCod = o.paymentmethod === "COD";
  const paid = (o.payments ?? []).find((p: any) => p.status === "PAID") ?? null;
  const latest = paid ?? (o.payments ?? [])[0] ?? null;
  const riskScore = o.riskScore == null ? null : Number(o.riskScore);
  const highRisk = (riskScore ?? 0) >= COD_REVIEW_RISK_THRESHOLD;
  const stockReserved = isReservationIntact(o);
  const reviewReason = isCod
    ? highRisk ? "HIGH_RISK_COD" : "COD_AWAITING_CONFIRMATION"
    : stockReserved ? "PAID_AWAITING_CONFIRMATION" : "PAID_STOCK_RELEASED";
  const liveVendorOrders = (o.vendorOrders ?? []).filter((vo: any) => vo.status !== "CANCELLED");
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    createdAt: o.createdAt,
    totalAmount: String(o.totalAmount),
    paymentMethod: o.paymentmethod,
    orderStatus: o.status,
    paymentStatus: o.paymentStatus,
    riskScore,
    highRisk,
    reviewReason,
    stockReserved,
    reservationReleasedAt: o.reservationReleasedAt ?? null,
    payment: latest
      ? { method: latest.method, status: latest.status, amount: String(latest.amount), paidAt: latest.paidAt ?? null, stockHold: !!(latest.meta as any)?.stockHold }
      : null,
    customer: o.user
      ? {
          id: o.user.id,
          name: o.user.name,
          email: o.user.email,
          phone: o.user.phone,
          verified: !!o.user.isVerified,
          memberSince: o.user.createdAt,
          problemOrders: (o.user.orders ?? []).length,
        }
      : null,
    shipTo: o.address ? { name: o.address.receiverFullName, city: o.address.city, address: o.address.address } : null,
    vendors: liveVendorOrders.map((vo: any) => ({
      id: vo.vendor?.id,
      storeName: vo.vendor?.storeName,
      subtotal: String(vo.subtotal),
      items: (vo.items ?? []).reduce((n: number, it: any) => n + (it.quantity ?? 0), 0),
    })),
    actions: {
      canApprove: stockReserved,
      canReject: !paid,
      canCancel: true,
    },
  };
}

export const AdminOrderService = {
  async getAll(filters: AdminOrderFilters) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;
    const where: any = {};

    if (filters.status) where.status = filters.status;
    if (filters.paymentStatus) where.paymentStatus = filters.paymentStatus;
    if (filters.userId) where.userId = filters.userId;
    if (filters.vendorId)
      where.vendorOrders = { some: { vendorId: filters.vendorId } };
    if (filters.fromDate || filters.toDate) {
      where.createdAt = {};
      if (filters.fromDate) where.createdAt.gte = new Date(filters.fromDate);
      if (filters.toDate) where.createdAt.lte = new Date(filters.toDate);
    }
    if (filters.search) {
      where.OR = [
        { orderNumber: { contains: filters.search, mode: "insensitive" } },
        { user: { name: { contains: filters.search, mode: "insensitive" } } },
        { user: { email: { contains: filters.search, mode: "insensitive" } } },
        { user: { phone: { contains: filters.search, mode: "insensitive" } } },
        {
          address: {
            receiverFullName: { contains: filters.search, mode: "insensitive" },
          },
        },
      ];
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: orderListInclude,
      }),
      prisma.order.count({ where }),
    ]);

    return {
      orders,
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

  async getById(orderId: string) {
    return prisma.order.findUnique({
      where: { id: orderId },
      include: orderDetailInclude,
    });
  },

  async getByVendorId(
    vendorId: string,
    filters: { page?: number; limit?: number; status?: OrderStatus },
  ) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;
    const where: any = { vendorId };
    if (filters.status) where.status = filters.status;

    const [vendorOrders, total] = await Promise.all([
      prisma.vendorOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          order: {
            include: {
              user: {
                select: { id: true, name: true, email: true, phone: true },
              },
              address: {
                select: {
                  receiverFullName: true,
                  phone: true,
                  city: true,
                  address: true,
                },
              },
              payments: {
                take: 1,
                orderBy: { createdAt: "desc" },
                select: { method: true, status: true, amount: true },
              },
            },
          },
          items: {
            include: {
              variant: {
                include: { product: { select: { id: true, name: true } } },
              },
            },
          },
          courierOrders: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              courierTrackingId: true,
              status: true,
              lastStatusUpdate: true,
            },
          },
        },
      }),
      prisma.vendorOrder.count({ where }),
    ]);

    return {
      vendorOrders,
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

  async getStatistics() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    weekStart.setHours(0, 0, 0, 0);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [
      total,
      pending,
      confirmed,
      processing,
      shipped,
      delivered,
      cancelled,
      refunded,
      failedDelivery,
      todayOrders,
      weekOrders,
      monthOrders,
      totalRevenue,
      todayRevenue,
      weekRevenue,
      monthRevenue,
      pendingRefunds,
      fraudQueue,
      pendingCod,
    ] = await Promise.all([
      prisma.order.count(),
      prisma.order.count({ where: { status: "PENDING" } }),
      prisma.order.count({ where: { status: "CONFIRMED" } }),
      prisma.order.count({ where: { status: "PROCESSING" } }),
      prisma.order.count({ where: { status: "SHIPPED" } }),
      prisma.order.count({ where: { status: "DELIVERED" } }),
      prisma.order.count({ where: { status: "CANCELLED" } }),
      prisma.order.count({ where: { status: "REFUNDED" } }),
      prisma.order.count({ where: { status: "FAILED_TO_DELIVER" } }),
      prisma.order.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.order.count({ where: { createdAt: { gte: weekStart } } }),
      prisma.order.count({ where: { createdAt: { gte: monthStart } } }),
      prisma.order.aggregate({
        where: { paymentStatus: "PAID" },
        _sum: { totalAmount: true },
      }),
      prisma.order.aggregate({
        where: { paymentStatus: "PAID", createdAt: { gte: todayStart } },
        _sum: { totalAmount: true },
      }),
      prisma.order.aggregate({
        where: { paymentStatus: "PAID", createdAt: { gte: weekStart } },
        _sum: { totalAmount: true },
      }),
      prisma.order.aggregate({
        where: { paymentStatus: "PAID", createdAt: { gte: monthStart } },
        _sum: { totalAmount: true },
      }),
      prisma.refund.count({ where: { status: "PENDING" } }),
      prisma.order.count({
        where: {
          status: "PENDING",
          paymentmethod: { not: "COD" },
          payments: { none: {} },
        },
      }),
      prisma.order.count({
        where: { status: "PENDING", paymentmethod: "COD" },
      }),
    ]);

    return {
      total,
      byStatus: {
        pending,
        confirmed,
        processing,
        shipped,
        delivered,
        cancelled,
        refunded,
        failedDelivery,
      },
      newOrders: { today: todayOrders, week: weekOrders, month: monthOrders },
      revenue: {
        total: totalRevenue._sum.totalAmount ?? new Decimal(0),
        today: todayRevenue._sum.totalAmount ?? new Decimal(0),
        week: weekRevenue._sum.totalAmount ?? new Decimal(0),
        month: monthRevenue._sum.totalAmount ?? new Decimal(0),
      },
      actionRequired: {
        pendingRefunds,
        fraudQueue,
        pendingCodConfirmations: pendingCod,
      },
    };
  },

  /**
   * Admin review queue: orders waiting for a FinixMart decision —
   *   COD orders still PENDING (high-risk ones are reserved for this review),
   *   prepaid orders PENDING with a PAID payment (e.g. held because their stock
   *   reservation was released before the payment arrived).
   * Each item carries server-derived facts and the actions the backend will
   * accept, so the screen never re-implements the rules:
   *   canApprove — confirmOrder accepts it only while the stock is reserved;
   *   canReject  — rejectOrder refuses a paid order (it must be cancelled so
   *                the customer is refunded);
   *   canCancel  — cancelOrder (refunds a paid order once).
   */
  /**
   * Phase 5: verified payments that could not be applied to their order
   * (payment-reconciliation.ts) and still need a decision. Read-only; a
   * refund is decided and issued separately.
   */
  async getUnappliedPayments(params: { page?: number; limit?: number }) {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
    const page = Math.max(params.page ?? 1, 1);
    const where = { meta: { path: ["reconciliation", "state"], equals: "NEEDS_REVIEW" } } as any;
    const [rows, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, method: true, status: true, amount: true, createdAt: true, meta: true,
          order: { select: { id: true, orderNumber: true, status: true, paymentStatus: true, user: { select: { id: true, name: true, email: true } } } },
        },
      }),
      prisma.payment.count({ where }),
    ]);
    return {
      payments: rows.map((p: any) => ({
        id: p.id,
        method: p.method,
        status: p.status,
        amount: String(p.amount),
        createdAt: p.createdAt,
        reconciliation: reconciliationOf(p.meta),
        order: p.order,
      })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  },

  async getFraudReview(params: { page?: number; limit?: number; queue?: "cod" | "paid"; search?: string }) {
    const page = Math.max(1, Math.trunc(params.page ?? 1));
    const limit = Math.min(Math.max(Math.trunc(params.limit ?? 20), 1), 50);
    const skip = (page - 1) * limit;

    const codWhere: any = { status: "PENDING" as OrderStatus, paymentmethod: "COD" as const };
    const paidWhere: any = { status: "PENDING" as OrderStatus, paymentmethod: { not: "COD" as const }, payments: { some: { status: "PAID" as const } } };
    const where: any = params.queue === "cod" ? { ...codWhere } : params.queue === "paid" ? { ...paidWhere } : { OR: [paidWhere, codWhere] };
    if (params.search?.trim()) where.orderNumber = { contains: params.search.trim(), mode: "insensitive" };

    const [orders, total, codCount, paidCount] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          orderNumber: true,
          createdAt: true,
          totalAmount: true,
          paymentmethod: true,
          status: true,
          paymentStatus: true,
          riskScore: true,
          reservationReleasedAt: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              isVerified: true,
              createdAt: true,
              orders: { where: { status: { in: ["CANCELLED", "RETURNED", "FAILED_TO_DELIVER"] } }, select: { id: true } },
            },
          },
          address: { select: { receiverFullName: true, city: true, address: true } },
          payments: { orderBy: { createdAt: "desc" }, select: { method: true, status: true, amount: true, paidAt: true, meta: true } },
          vendorOrders: {
            select: {
              status: true,
              subtotal: true,
              vendor: { select: { id: true, storeName: true } },
              items: { select: { quantity: true, _count: { select: { allocations: true } } } },
            },
          },
        },
      }),
      prisma.order.count({ where }),
      prisma.order.count({ where: codWhere }),
      prisma.order.count({ where: paidWhere }),
    ]);

    return {
      orders: orders.map((o: any) => toReviewItem(o)),
      counts: { cod: codCount, paid: paidCount },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    };
  },

  async confirmOrder(
    orderId: string,
    actorId: string,
    note?: string,
    actorType: "ADMIN" | "SYSTEM" = "ADMIN",
  ) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        status: true,
        orderNumber: true,
        userId: true,
        paymentmethod: true,
      },
    });
    if (!order) throw new Error("Order not found");
    if (order.status !== "PENDING")
      throw new Error(
        `Order must be PENDING to confirm. Current: ${order.status}`,
      );

    if (order.paymentmethod === "COD" && actorType === "ADMIN") {
      await prisma.auditLog.create({
        data: {
          action: "COD_ORDER_MANUAL_OVERRIDE_BY_ADMIN",
          entity: "Order",
          entityId: orderId,
          newData: { confirmedBy: actorId, note },
          userId: actorId,
        },
      });
    }

    let claimed = true;
    let stockReleased = false;
    let paymentMissing = false;
    await prisma.$transaction(async (tx) => {
      // H1: never confirm an order for fulfilment once its stock reservation
      // was released (TTL / failed payment) — the vendor could process it but
      // courier booking could never ship it. Same lock as the stock release.
      await lockOrderForReservation(tx, orderId);
      // Phase 5: an online-payment order is confirmed only once the money is
      // verified — a PAID payment row for this order (a COD delivery-fee
      // payment doesn't count). Checked under the order lock, so every caller
      // (confirm, approve, system auto-confirm) is covered. COD is unaffected.
      if (order.paymentmethod !== "COD") {
        const paid = await tx.payment.findMany({ where: { orderId, status: "PAID" }, select: { meta: true } });
        if (!paid.some((p) => (p.meta as any)?.type !== "delivery_fee")) {
          paymentMissing = true;
          return;
        }
      }
      if (!(await orderReservationIntact(tx, orderId))) {
        stockReleased = true;
        return;
      }
      // Phase 4 (M-a): guarded on PENDING — a cancellation or fraud rejection
      // that committed after the read above is never turned back into CONFIRMED.
      const claim = await tx.order.updateMany({
        where: { id: orderId, status: "PENDING" },
        data: { status: "CONFIRMED", confirmedAt: new Date() },
      });
      if (claim.count !== 1) {
        claimed = false;
        return;
      }
      await tx.vendorOrder.updateMany({
        where: { orderId, status: "PENDING" },
        data: { status: "CONFIRMED" },
      });
      await tx.auditLog.create({
        data: {
          action:
            actorType === "SYSTEM" ? "ORDER_AUTO_CONFIRMED" : "ORDER_CONFIRMED",
          entity: "Order",
          entityId: orderId,
          newData: {
            status: "CONFIRMED",
            note,
            confirmedBy: actorId,
            actorType,
          },
          userId: actorType === "ADMIN" ? actorId : null,
        },
      });
    });

    if (paymentMissing) {
      if (actorType === "SYSTEM") {
        await prisma.auditLog.create({
          data: { action: "ORDER_AUTO_CONFIRM_SKIPPED_UNPAID", entity: "Order", entityId: orderId, newData: { note } },
        });
        return { success: true, skipped: true, reason: "PAYMENT_NOT_VERIFIED" };
      }
      throw new OrderStatusTransitionError(
        409,
        "This order is paid online and no verified payment has been received, so it can't be confirmed. When the gateway verifies a payment, the order is confirmed automatically if its stock is still reserved.",
      );
    }

    if (stockReleased) {
      if (actorType === "SYSTEM") {
        await prisma.auditLog.create({
          data: { action: "ORDER_AUTO_CONFIRM_SKIPPED_STOCK_RELEASED", entity: "Order", entityId: orderId, newData: { note, reason: STOCK_HOLD_REASON } },
        });
        return { success: true, skipped: true, reason: STOCK_HOLD_REASON };
      }
      throw new OrderStatusTransitionError(
        409,
        "This order's stock reservation was released (unpaid too long or a failed payment), so it can't be confirmed for fulfilment. Cancel it instead — a paid order is refunded.",
      );
    }

    if (!claimed) {
      if (actorType === "SYSTEM") {
        // Auto-confirm (payment webhook / COD auto) lost the race: skip, as
        // confirmOrderBySystem already does for a non-PENDING order.
        await prisma.auditLog.create({
          data: {
            action: "ORDER_AUTO_CONFIRM_SKIPPED_STATE_CHANGED",
            entity: "Order",
            entityId: orderId,
            newData: { note },
          },
        });
        return { success: true, skipped: true, reason: "STATE_CHANGED" };
      }
      throw new OrderStatusTransitionError(
        409,
        "This order changed in the meantime (it may have been cancelled or rejected) — refresh and try again.",
      );
    }

    if (order.userId) {
      await prisma.notification.create({
        data: {
          type: "ORDER",
          title: "Order Confirmed",
          message: `Your order ${order.orderNumber} has been confirmed and is being processed.`,
          targetType: "USER",
          targetId: order.userId,
          orderId,
          actionUrl: `/orders/${orderId}`,
        },
      });
    }
    return { success: true };
  },

  async confirmOrderBySystem(
    orderId: string,
    source: "PAYMENT_WEBHOOK" | "COD_AUTO",
  ) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, riskScore: true },
    });
    if (!order) throw new Error("Order not found");
    if (order.status !== "PENDING") return { success: true, skipped: true };

    const riskScore = order.riskScore?.toNumber() ?? 0;
    if (riskScore >= 60) {
      await prisma.auditLog.create({
        data: {
          action: "ORDER_AUTO_CONFIRM_SKIPPED_HIGH_RISK",
          entity: "Order",
          entityId: orderId,
          newData: { riskScore, source },
        },
      });
      return { success: true, skipped: true, reason: "HIGH_RISK" };
    }

    return this.confirmOrder(
      orderId,
      "SYSTEM",
      `Auto-confirmed via ${source}`,
      "SYSTEM",
    );
  },

  async approveOrder(orderId: string, adminId: string, note?: string) {
    return AdminOrderService.confirmOrder(
      orderId,
      adminId,
      note ?? "Approved after fraud review",
      "ADMIN",
    );
  },

  async rejectOrder(orderId: string, adminId: string, reason: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        status: true,
        userId: true,
        orderNumber: true,
        vendorOrders: { select: { items: { select: { id: true } } } },
      },
    });
    if (!order) throw new Error("Order not found");
    if (order.status !== "PENDING")
      throw new Error(
        `Only PENDING orders can be rejected. Current: ${order.status}`,
      );

    // Phase 3: rejecting releases the order's stock reservation, in the same
    // Serializable stock transaction as the status change. The rules are
    // re-checked inside it: a paid order must be cancelled (so it is refunded),
    // never rejected; an order with any live courier row is never rejected.
    await runStockMutation(prisma, async (tx) => {
      const current = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          payments: { select: { status: true } },
          vendorOrders: { select: { courierOrders: { select: { status: true } } } },
        },
      });
      if (!current || current.status !== "PENDING") {
        throw new Error(`Only PENDING orders can be rejected. Current: ${current?.status ?? "not found"}`);
      }
      if (current.payments.some((p: any) => p.status === "PAID")) {
        throw new Error("This order has a successful payment — cancel it instead so the customer is refunded.");
      }
      if (current.vendorOrders.some((vo: any) => vo.courierOrders.some((co: any) => co.status !== "CANCELLED"))) {
        throw new Error("This order has a courier booking and can't be rejected.");
      }

      for (const vo of order.vendorOrders) {
        for (const item of vo.items) {
          await releaseAllocationsForOrderItem(tx, item.id);
        }
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      await tx.vendorOrder.updateMany({
        where: { orderId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          action: "ORDER_REJECTED_FRAUD",
          entity: "Order",
          entityId: orderId,
          newData: { reason, rejectedBy: adminId },
          userId: adminId,
        },
      });
    });

    if (order.userId) {
      await prisma.notification.create({
        data: {
          type: "ORDER",
          title: "Order Cancelled",
          message: `Your order ${order.orderNumber} could not be processed. Please contact support.`,
          targetType: "USER",
          targetId: order.userId,
          orderId,
        },
      });
    }
    return { success: true };
  },

  async cancelOrder(orderId: string, adminId: string, reason: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        payments: true,
        vendorOrders: {
          include: {
            items: true,
            courierOrders: {
              orderBy: { createdAt: "desc" },
              select: {
                id: true,
                status: true,
                courierTrackingId: true,
                courierProviderId: true,
              },
            },
          },
        },
      },
    });
    if (!order) throw new Error("Order not found");

    const nonCancellable: OrderStatus[] = [
      "DELIVERED",
      "CANCELLED",
      "REFUNDED",
    ];
    if (nonCancellable.includes(order.status))
      throw new Error(`Cannot cancel order in status: ${order.status}`);
    const paidPayment = order.payments.find((p) => p.status === "PAID");

    const alreadyPickedUp = order.vendorOrders.some((vo) =>
      vo.courierOrders.some(
        (co) => !["PENDING_PICKUP", "READY_FOR_PICKUP"].includes(co.status),
      ),
    );
    if (alreadyPickedUp) {
      throw new Error(
        "One or more shipments already picked up by courier. Use the RTS/return workflow instead of direct cancellation.",
      );
    }

    await runStockMutation(prisma, async (tx) => {
      // 1C-17: the guards above ran on a read OUTSIDE this transaction.
      // Re-verify the same rules against current state inside the
      // Serializable tx so a dispatch (status change + booking pickup) that
      // raced the read cannot be cancelled outright here.
      const current = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          vendorOrders: {
            select: {
              id: true,
              status: true,
              courierOrders: {
                select: { id: true, status: true, courierStatus: true, courierTrackingId: true },
                orderBy: { createdAt: "desc" },
              },
            },
          },
        },
      });
      if (!current) throw new Error("Order not found");
      if (nonCancellable.includes(current.status)) {
        throw new Error(`Cannot cancel order in status: ${current.status}`);
      }
      const pickedUpNow = current.vendorOrders.some((vo: any) =>
        vo.courierOrders.some(
          (co: any) => !["PENDING_PICKUP", "READY_FOR_PICKUP"].includes(co.status),
        ),
      );
      if (pickedUpNow) {
        throw new Error(
          "One or more shipments already picked up by courier. Use the RTS/return workflow instead of direct cancellation.",
        );
      }
      // Phase 0 (S3): a booking intent whose provider outcome is unresolved
      // (claimed / unknown / confirm-failed / legacy "Booking in progress")
      // may already exist at the courier. Cancelling it would free its booking
      // slot and allow a duplicate, so the whole cancellation is refused —
      // nothing is written — until the booking is reconciled.
      const unresolvedBooking = current.vendorOrders.some((vo: any) =>
        vo.courierOrders.some(
          (co: any) => !co.courierTrackingId && co.courierStatus !== BOOKING_PENDING,
        ),
      );
      if (unresolvedBooking) {
        const unresolved: any = new Error(
          "A courier booking for this order has an unresolved outcome and must be reconciled with the courier before the order can be cancelled.",
        );
        unresolved.code = "COURIER_BOOKING_UNRESOLVED";
        throw unresolved;
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      await tx.vendorOrder.updateMany({
        where: { orderId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });

      // Phase 0 (S3): courier rows come from THIS transaction's read and are
      // cancelled through `tx`, so they commit, roll back and retry together
      // with the order. A refusal is a returned value (never a thrown SQL
      // error, which would abort the transaction); a real database error
      // rolls back the whole cancellation.
      const currentCourierOrders = new Map(
        current.vendorOrders.map((vo: any) => [vo.id, vo.courierOrders as { id: string }[]]),
      );
      for (const vo of order.vendorOrders) {
        for (const co of currentCourierOrders.get(vo.id) ?? []) {
          const { cancelled } = await courierService.cancelCourierOrder(co.id, tx);
          if (!cancelled) {
            await tx.auditLog.create({
              data: {
                action: "COURIER_CANCEL_SKIPPED",
                entity: "CourierOrder",
                entityId: co.id,
                newData: { reason: "not cancellable by the guarded update (already cancelled or no longer pending pickup)" },
                userId: adminId,
              },
            });
          }
        }

       
       
          for (const item of vo.items) {
            await releaseAllocationsForOrderItem(tx, item.id);
          }

      }

      // Phase 3: a paid order cancelled by an admin is refunded exactly like a
      // customer's paid pre-delivery cancel — one PENDING refund for the paid
      // amount, created at most once, in this same transaction.
      if (paidPayment) {
        await createCancellationRefundOnce(tx, orderId, reason, { initiatedBy: adminId, refundType: "ADMIN_INITIATED" });
      }

      await tx.auditLog.create({
        data: {
          action: "ORDER_CANCELLED",
          entity: "Order",
          entityId: orderId,
          newData: { reason, cancelledBy: adminId },
          userId: adminId,
        },
      });
    });

    // Phase 3: same accounting as the customer path — reverse Event 0a for a
    // paid pre-delivery cancel (idempotent: no POSTED 0a voucher → no-op).
    if (paidPayment) {
      await reverseEvent0aForOrder(orderId, `Admin cancel: ${reason}`, adminId);
    }

    if (order.userId) {
      await prisma.notification.create({
        data: {
          type: "ORDER",
          title: "Order Cancelled",
          message: `Your order has been cancelled. Reason: ${reason}`,
          targetType: "USER",
          targetId: order.userId,
          orderId,
        },
      });
    }
    return { success: true };
  },

  async updateStatus(
    orderId: string,
    adminId: string,
    newStatus: OrderStatus,
    note?: string,
  ) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, userId: true, orderNumber: true },
    });
    if (!order) throw new Error("Order not found");
    const oldStatus = order.status;

    // 1C-18: same terminal-state rule cancelOrder enforces — a DELIVERED,
    // CANCELLED or REFUNDED order cannot be transitioned manually.
    const nonCancellable: OrderStatus[] = [
      "DELIVERED",
      "CANCELLED",
      "REFUNDED",
    ];
    if (nonCancellable.includes(oldStatus)) {
      throw new Error(`Cannot update status of order in status: ${oldStatus}`);
    }

    // 1C-18: cancellations must go through cancelOrder. A raw status write
    // to CANCELLED bypassed every cancel rule (vendor-order updates, stock
    // release, courier booking cancellation, refund) and was silently
    // reversed by the next recalculateMasterOrderStatus.
    if (newStatus === "CANCELLED") {
      await AdminOrderService.cancelOrder(orderId, adminId, note || "Cancelled via status update");
      return { success: true, oldStatus, newStatus };
    }

    // Phase 3 (H-5 / M-d): Order.status is derived from its vendor orders
    // (recalculateMasterOrderStatus); a raw write skipped confirmation checks,
    // dispatch, stock, vouchers and refunds and was overwritten by the next
    // recalculation. Every other target is refused — use the action that
    // performs it (confirm / approve, the vendor-order transitions, courier events).
    throw new OrderStatusTransitionError(
      422,
      `Order status can't be set to ${newStatus} directly. Use Confirm / Approve for confirmation, the vendor-order status controls for processing and packaging, and the courier workflow for shipping and delivery.`,
    );
  },

  async updateVendorOrderStatus(
    orderId: string,
    vendorOrderId: string,
    adminId: string,
    newStatus: OrderStatus,
    note?: string,
  ) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId, orderId },
      select: { id: true, status: true, vendorId: true, courierOrderId: true },
    });
    if (!vendorOrder) throw new Error("Vendor order not found");
    const oldStatus = vendorOrder.status;

    // Phase 3 (H-5): only the vendor's own preparation steps can be set here.
    // SHIPPED needs mark-for-delivery (courier booking + stock dispatch),
    // DELIVERED / RETURNED / FAILED_TO_DELIVER come from courier events
    // (delivered quantities, vouchers), and cancellation goes through the
    // guarded order cancellation (stock release, courier rows, refunds).
    if (ADMIN_VENDOR_ORDER_TRANSITIONS[oldStatus] !== newStatus) {
      throw new OrderStatusTransitionError(
        422,
        `A vendor order can't be moved from ${oldStatus} to ${newStatus} here. Allowed: CONFIRMED → PROCESSING, PROCESSING → PACKAGING. Shipping and delivery come from the courier workflow; cancel the whole order to cancel it.`,
      );
    }

    await prisma.$transaction(async (tx) => {
      // Guarded on the status read above: a concurrent change (e.g. a
      // cancellation) is never overwritten.
      const moved = await tx.vendorOrder.updateMany({
        where: { id: vendorOrderId, orderId, status: oldStatus },
        data: { status: newStatus },
      });
      if (moved.count !== 1) {
        throw new OrderStatusTransitionError(409, "This vendor order changed in the meantime — refresh and try again.");
      }
      await recalculateMasterOrderStatus(tx, orderId);
      await tx.auditLog.create({
        data: {
          action: "VENDOR_ORDER_STATUS_UPDATE_ADMIN_OVERRIDE",
          entity: "VendorOrder",
          entityId: vendorOrderId,
          oldData: { status: oldStatus },
          newData: {
            status: newStatus,
            note,
            updatedBy: adminId,
            isAdminOverride: true,
          },
          userId: adminId,
        },
      });
    });

    await prisma.notification.create({
      data: {
        type: "ORDER",
        title: "Order Status Updated by Admin",
        message: `Your order has been updated to ${newStatus} by the platform.`,
        targetType: "VENDOR",
        targetId: vendorOrder.vendorId,
        orderId,
      },
    });

    // (Phase 3: the admin DELIVERED voucher posting that used to follow here
    // is gone — DELIVERED can no longer be set through this override; delivery
    // accounting runs only from courier events.)
    return { success: true, oldStatus, newStatus };
  },

  /**
   * Phase 3: a courier event arrived for a cancelled shipment / vendor order.
   * Nothing is changed; an audit row + an error-level log flag it for manual
   * reconciliation (the parcel may have moved after the cancellation).
   */
  async recordCourierEventAfterCancel(
    courierOrderId: string,
    courierOrderStatus: string,
    vendorOrderStatus: string,
    params: { newStatus: string; courierStatus: string },
  ) {
    console.error(
      `[courier-event] ${params.newStatus} event for courier order ${courierOrderId} ignored: shipment ${courierOrderStatus}, vendor order ${vendorOrderStatus} — reconciliation required`,
    );
    await prisma.auditLog
      .create({
        data: {
          action: "COURIER_EVENT_AFTER_CANCEL",
          entity: "CourierOrder",
          entityId: courierOrderId,
          newData: {
            eventStatus: params.newStatus,
            courierStatus: params.courierStatus,
            courierOrderStatus,
            vendorOrderStatus,
          },
        },
      })
      .catch((e: any) => console.error(`[courier-event] audit write failed for ${courierOrderId}: ${e?.message ?? e}`));
    return { processed: false, skipped: "ORDER_CANCELLED", courierOrderId, status: courierOrderStatus };
  },

  async processCourierStatusUpdate(params: {
    courierOrderId: string;
    newStatus: CourierOrderStatus;
    courierStatus: string;
    shipmentKind?: CourierShipmentKind;
    messageEn?: string;
    messageBn?: string;
    location?: string;
    timestamp: Date;
    rawData?: any;
    returnConsignmentId?: string;
  }) {
    const courierOrder = await prisma.courierOrder.findUnique({
      where: { id: params.courierOrderId },
      include: {
        vendorOrder: {
          include: {
            vendor: true,
            items: {
              include: {
                variant: { select: { taxRate: true, product: { select: { categoryId: true } } } },
              },
            },
          },
        },
      },
    });
    if (!courierOrder) throw new Error("Courier order not found");
    // Phase 0 (S2): only a BOOKED shipment (courierTrackingId set — the sole
    // Phase 0 definition) can take courier status events. An unbooked intent
    // is refused BEFORE any state write and before delivery-voucher posting.
    // A tracking id, once set, is never cleared, so this check cannot go stale.
    if (!courierOrder.courierTrackingId) {
      const notBooked: any = new Error(
        `Courier order ${courierOrder.id} is not a booked shipment (no courier tracking id) — status events are refused`,
      );
      notBooked.code = "COURIER_ORDER_NOT_BOOKED";
      throw notBooked;
    }
    if (!courierOrder.vendorOrder)
      throw new Error("Courier order has no linked vendor order");

    const vo = courierOrder.vendorOrder;

    // Phase 3: a courier event for a CANCELLED shipment, or for a shipment of a
    // CANCELLED vendor order, must not revive it — no status change, no
    // delivered quantity, no delivery voucher. It is recorded for manual
    // reconciliation (the parcel may physically have moved after we cancelled)
    // and acknowledged, so the provider stops retrying.
    if (courierOrder.status === "CANCELLED" || vo.status === "CANCELLED") {
      return AdminOrderService.recordCourierEventAfterCancel(courierOrder.id, courierOrder.status, vo.status, params);
    }

    // 1C-12: per-consignment accounting scope. A multi-warehouse VendorOrder
    // ships one consignment per warehouse; each DELIVERED event must recognize
    // only the quantities actually dispatched from THAT warehouse. Scope
    // source = the VendorOrder's OrderItemAllocation rows for the
    // consignment's warehouse (shippedQty = what physically left it).
    // Orders without allocations (legacy) fall back to full-line scope.
    const allocations = await prisma.orderItemAllocation.findMany({
      where: {
        orderItemId: { in: vo.items.map((i) => i.id) },
        warehouseId: courierOrder.warehouseId ?? "___none___",
        shippedQty: { gt: 0 },
      },
      select: { orderItemId: true, quantity: true, shippedQty: true },
    });
    // Legacy guard: an order created before the allocation system has NO
    // allocations at all — its (single) consignment represents the full line
    // quantities. Only orders WITH allocations get scoped accounting.
    const voAllocationCount = await prisma.orderItemAllocation.count({
      where: { orderItemId: { in: vo.items.map((i) => i.id) } },
    });
    const hasAllocationScope = courierOrder.warehouseId != null && voAllocationCount > 0;
    const lineScope = hasAllocationScope
      ? Object.entries(
          allocations.reduce<Record<string, number>>((acc, a) => {
            // 1C-27: use shippedQty (actually dispatched) not quantity (total allocated)
        // — a partial dispatch must not over-report the delivered quantity
        acc[a.orderItemId] = (acc[a.orderItemId] ?? 0) + a.shippedQty;
            return acc;
          }, {}),
        ).map(([orderItemId, quantity]) => ({ orderItemId, quantity }))
      : undefined;

    // 1C-11 Phase 6: same-state webhook re-delivery must not re-run the state
    // transaction (duplicate history rows / rewritten timestamps). Skip the TX
    // but still attempt the DELIVERED voucher posting below — it is engine-
    // idempotent, so a provider retry can converge a previously failed posting.
    const sameState = courierOrder.status === params.newStatus;

    let cancelledMeanwhile = false;
    if (!sameState) {
    await prisma.$transaction(async (tx) => {
      // Phase 3: the vendor order may have been cancelled after the read
      // above — re-check before writing anything.
      const voNow = await tx.vendorOrder.findUnique({ where: { id: vo.id }, select: { status: true } });
      if (voNow?.status === "CANCELLED") {
        cancelledMeanwhile = true;
        return;
      }
      const updateData: any = {
        status: params.newStatus,
        courierStatus: params.courierStatus,
        lastStatusUpdate: new Date(),
        webhookReceivedAt: new Date(),
      };
      if (params.shipmentKind) updateData.shipmentKind = params.shipmentKind;
      if (params.returnConsignmentId)
        updateData.returnConsignmentId = params.returnConsignmentId;
      if (params.newStatus === "PICKED_UP") updateData.pickedUpAt = new Date();
      if (params.newStatus === "IN_TRANSIT")
        updateData.inTransitAt = new Date();
      if (params.newStatus === "DELIVERED") updateData.deliveredAt = new Date();
      if (params.newStatus === "RETURNED") updateData.returnedAt = new Date();
      if (params.newStatus === "CANCELLED") updateData.cancelledAt = new Date();

      // 1C-19: claim the transition conditionally — only the request that
      // actually moves the courier order OFF its current status wins. Two
      // concurrent provider retries both pass the outer sameState check
      // against the stale read; under READ COMMITTED the loser's UPDATE
      // re-evaluates this predicate after the winner commits (count 0) and
      // commits nothing, so deliveredQuantity can never be double-applied.
      const claim = await tx.courierOrder.updateMany({
        // Phase 0 (S2): database-level guard — never transition an unbooked row.
        // Phase 3: never move a row OFF CANCELLED either.
        where: { id: courierOrder.id, status: { notIn: [params.newStatus, "CANCELLED"] }, courierTrackingId: { not: null } },
        data: updateData,
      });
      if (claim.count === 0) {
        // Concurrent duplicate: same-state at commit time — no state
        // mutation; the idempotent voucher posting below still runs.
        // Phase 3: unless the row was cancelled meanwhile — then nothing runs.
        const rowNow = await tx.courierOrder.findUnique({ where: { id: courierOrder.id }, select: { status: true } });
        if (rowNow?.status === "CANCELLED") cancelledMeanwhile = true;
        return;
      }

      await tx.courierTrackingHistory.create({
        data: {
          courierOrderId: courierOrder.id,
          status: params.newStatus,
          courierStatus: params.courierStatus,
          messageEn: params.messageEn ?? params.courierStatus,
          messageBn: params.messageBn,
          location: params.location,

          timestamp: params.timestamp,
          rawData: params.rawData,
        },
      });

      const vendorOrderUpdate: any = {};
      if (params.newStatus === "DELIVERED") {
        // 1C-12: accumulate deliveredQuantity per consignment scope (never the
        // full VendorOrder quantity for every consignment).
        const scopeByItem = new Map(
          (lineScope ?? []).map((s) => [s.orderItemId, s.quantity]),
        );
        for (const item of vo.items) {
          const scopedQty = hasAllocationScope
            ? (scopeByItem.get(item.id) ?? 0)
            : item.quantity; // legacy orders without allocations: full line
          if (scopedQty <= 0) continue;
          // 1C-27: cap delivered increment so that a second courier order's
          // DELIVERED event does not re-count quantities already delivered by
          // an earlier courier order on the same vendor order.
          const alreadyDelivered = item.deliveredQuantity ?? 0;
          const remainingToDeliver = item.quantity - alreadyDelivered;
          const actualIncrement = Math.min(scopedQty, Math.max(0, remainingToDeliver));
          if (actualIncrement <= 0) continue;
          await tx.orderItem.update({
            where: { id: item.id },
            data: { deliveredQuantity: { increment: actualIncrement } },
          });
        }

        // Full delivery only when every line of the VendorOrder has now been
        // delivered in cumulative terms — one delivered consignment must not
        // mark a multi-consignment VendorOrder fully delivered.
        const freshItems = await tx.orderItem.findMany({
          where: { vendorOrderId: vo.id },
          select: { quantity: true, deliveredQuantity: true },
        });
        const fullyDelivered =
          freshItems.length > 0 &&
          freshItems.every((it) => it.deliveredQuantity >= it.quantity);
        if (fullyDelivered) {
          vendorOrderUpdate.status = "DELIVERED";
          vendorOrderUpdate.deliveredAt = new Date();
          vendorOrderUpdate.fulfillmentStatus = "FULFILLED";
        } else {
          vendorOrderUpdate.fulfillmentStatus = "PARTIALLY_FULFILLED";
        }
      } else if (params.newStatus === "PARTIAL_DELIVERED") {
        vendorOrderUpdate.fulfillmentStatus = "PARTIALLY_FULFILLED";
      } else if (
        params.newStatus === "FAILED_DELIVERY" ||
        params.newStatus === "RETURNED"
      ) {
        vendorOrderUpdate.status = "FAILED_TO_DELIVER";
      }
      if (Object.keys(vendorOrderUpdate).length) {
        await tx.vendorOrder.update({
          where: { id: vo.id },
          data: vendorOrderUpdate,
        });
      }

      await recalculateMasterOrderStatus(tx, vo.orderId);
    });

    }

    // Phase 3: cancelled while this event was being processed → nothing was
    // written above, and no voucher is posted either.
    if (cancelledMeanwhile) {
      return AdminOrderService.recordCourierEventAfterCancel(courierOrder.id, "CANCELLED", "CANCELLED", params);
    }

    if (
      params.newStatus === "DELIVERED" &&
      (params.shipmentKind ?? "REGULAR") === "REGULAR"
    ) {
      // 1C-11 Phase 6: intentionally runs even when sameState — the voucher
      // engine is idempotent, so a provider retry converges a previously
      // failed posting instead of leaving a DELIVERED order without a voucher.
      // PHASE 2 BATCH 1C-1: the ONE shared delivery-voucher function (per-SKU
      // VAT + per-line commission from Batch 1A-2) — every DELIVERED path
      // funnels through it. Idempotent per engine key: duplicate deliveries
      // post nothing.
      if (hasAllocationScope && lineScope && lineScope.length === 0) {
        // Data drift: the consignment's warehouse has no shipped allocations.
        // Recognize nothing rather than guessing; surface for ops follow-up.
        console.warn(
          `[courier-webhook][delivery ${courierOrder.id}] consignment delivered but its warehouse has no shipped allocations for vendor order ${vo.id} — delivery accounting skipped`,
        );
      } else {
      await postDeliveryVoucherForVendorOrder({
        orderId: vo.orderId,
        vendorId: vo.vendorId,
        deliveryId: courierOrder.id,
        paymentMethod: courierOrder.codAmount.greaterThan(0) ? "COD" : "ONLINE",
        items: vo.items,
        lineScope: hasAllocationScope ? lineScope : undefined,
        shippingCost: vo.shippingCost,
        courierCharge: courierOrder.deliveryCharge,
        deliveryDate: params.timestamp,
      });
      // Agent commission (docs/agent-system-plan.md §5.1): same consignment
      // scope, idempotent per (deliveryId, orderItemId), runs on sameState
      // retries like the voucher, and never throws into the webhook.
      await accrueAgentCommissionForDeliverySafe({
        vendorOrderId: vo.id,
        deliveryId: courierOrder.id,
        lineScope: hasAllocationScope ? lineScope : undefined,
        deliveredAt: params.timestamp,
      });
      }
    }

    // 1C-12: explicit processing result for the webhook response envelope.
    return {
      processed: true,
      sameState,
      courierOrderId: courierOrder.id,
      status: params.newStatus,
    };
  },

  /**
   * Get all refund records with filters
   */
  async getAllRefunds(params: {
    page?: number;
    limit?: number;
    status?: RefundStatus;
    orderId?: string;
    refundId?: string;
  }) {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (params.status) where.status = params.status;
    // PHASE 2 BATCH 1C-7B (G3): optional, fully backward-compatible filters.
    if (params.orderId) where.orderId = params.orderId;
    if (params.refundId) where.id = params.refundId;

    const [refunds, total] = await Promise.all([
      prisma.refund.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          order: {
            select: {
              orderNumber: true,
              totalAmount: true,
              paymentStatus: true,
              user: { select: { id: true, name: true, email: true, phone: true } },
            },
          },
        },
      }),
      prisma.refund.count({ where }),
    ]);

    return {
      refunds,
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

  // PHASE 2 BATCH 1C-7B (G3): single refund detail — RefundRecord when
  // present (never fabricated) and the associated VendorReturn(s) via the
  // Refund.returns back-relation (VendorReturn.refundId linkage).
  async getRefundById(refundId: string) {
    return prisma.refund.findUnique({
      where: { id: refundId },
      include: {
        detail: true,
        order: {
          select: { id: true, orderNumber: true, totalAmount: true, paymentStatus: true },
        },
        returns: {
          orderBy: { createdAt: "desc" as const },
          include: {
            items: { select: { id: true, orderItemId: true, variantId: true, quantity: true } },
          },
        },
      },
    });
  },

  // PHASE 2 BATCH 1C-7B (G6): READ-ONLY refundable summary. The consumed
  // definition mirrors the authoritative H1 guard (PENDING + APPROVED +
  // PROCESSING + REFUNDED; FAILED/REJECTED/CANCELLED excluded, same 0.005
  // epsilon family) — this endpoint performs NO writes and does NOT replace
  // the mutation-side H1 check, which still executes inside
  // paymentService.requestRefund's payment-row FOR UPDATE transaction.
  async getRefundSummary(orderId: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, paymentStatus: true },
    });
    if (!order) return null;
    // same refundable-basis lookup as H1; fall back to the latest payment row
    // so a fully-refunded order still reports its final state
    const payment =
      (await prisma.payment.findFirst({
        where: { orderId, status: { in: ["PAID", "PARTIALLY_REFUNDED"] as PaymentStatus[] } },
        orderBy: { createdAt: "desc" as const },
        select: { id: true, amount: true, status: true },
      })) ??
      (await prisma.payment.findFirst({
        where: { orderId },
        orderBy: { createdAt: "desc" as const },
        select: { id: true, amount: true, status: true },
      }));
    const consumedAgg = await prisma.refund.aggregate({
      where: { orderId, status: { in: ["PENDING", "APPROVED", "PROCESSING", "REFUNDED"] as RefundStatus[] } },
      _sum: { amount: true },
    });
    const paymentAmount = payment ? new Decimal(payment.amount) : new Decimal(0);
    const consumed = new Decimal(consumedAgg._sum.amount ?? 0);
    return {
      orderId,
      paymentId: payment?.id ?? null,
      paymentAmount,
      consumedRefundAmount: consumed,
      remainingRefundableAmount: paymentAmount.minus(consumed),
      paymentStatus: payment?.status ?? null,
      orderPaymentStatus: order.paymentStatus,
    };
  },

  // ==========================================================
  // REFUND — POLICY LAYER
  // This service owns the approve/reject DECISION (paid order?
  // physical return confirmed for non-goodwill? amount valid?).
  // Once approved, gateway execution is delegated to
  // paymentService.processApprovedRefund / completeGoodwillRefund
  // — this service never talks to SSLCommerz directly, and never
  // sets Refund.status = REFUNDED itself.
  // ==========================================================

  /**
   * Admin-initiated refund in one step: creates the refund request
   * AND immediately approves it (skips the separate customer-request
   * step). Still goes through the same physical-return gate + the
   * same execution delegation as approveRefund().
   */
  async processRefund(
    orderId: string,
    adminId: string,
    amount: number,
    reason: string,
    refundType: RefundType,
    isGoodwill = false,
  ) {
    const gateCheck = await this._checkPhysicalReturnGate(orderId, isGoodwill);
    const order = gateCheck.order;

    const amountDecimal = new Decimal(amount);
    if (
      amountDecimal.lessThanOrEqualTo(0) ||
      amountDecimal.greaterThan(order.totalAmount)
    ) {
      throw new Error(
        `Refund amount must be between 1 and ${order.totalAmount}`,
      );
    }
    // PHASE 2 BATCH 1C-5D: refundability is gated on the physical-return
    // state (checked above), not paymentStatus — a PARTIALLY_REFUNDED payment
    // still has refundable balance and must accept further partial refunds.
    if (
      order.paymentStatus !== "PAID" &&
      order.paymentStatus !== "PARTIALLY_REFUNDED"
    )
      throw new Error(
        "Refunds can only be issued for paid or partially refunded orders",
      );

    const { refund } = await paymentService.requestRefund({
      orderId,
      refundAmount: amount,
      refundReason: reason,
      initiatedBy: adminId,
      refundType,
    });

    return this.approveRefund(refund.id, adminId, amount, reason, isGoodwill);
  },

  /**
   * Approves a PENDING refund request (created earlier via
   * paymentService.requestRefund, e.g. by a customer). Runs the
   * physical-return gate, then delegates execution:
   *   - isGoodwill=true  -> paymentService.completeGoodwillRefund (no SSLCommerz call)
   *   - isGoodwill=false -> paymentService.processApprovedRefund (real SSLCommerz call)
   */
  async approveRefund(
    refundId: string,
    adminId: string,
    amount: number,
    note?: string,
    isGoodwill = false,
  ) {
    const refund = await prisma.refund.findUnique({
      where: { id: refundId },
      include: {
        detail: true,
        order: {
          select: {
            id: true,
            orderNumber: true,
            totalAmount: true,
            paymentStatus: true,
            status: true,
            userId: true,
            vendorOrders: {
              select: {
                courierOrders: {
                  orderBy: { createdAt: "desc" },
                  select: { returnedAt: true, vendorConfirmedReturnAt: true },
                },
              },
            },
          },
        },
      },
    });
    if (!refund || !refund.detail) throw new Error("Refund record not found");
    if (refund.status !== "PENDING")
      throw new Error(
        `Refund is not in PENDING status. Current: ${refund.status}`,
      );

    const amountDecimal = new Decimal(amount);
    if (
      amountDecimal.lessThanOrEqualTo(0) ||
      amountDecimal.greaterThan(refund.order.totalAmount)
    ) {
      throw new Error(
        `Amount must be between 1 and ${refund.order.totalAmount}`,
      );
    }
    // Phase 4 (D6): approval may only REDUCE the requested amount.
    if (amountDecimal.greaterThan(refund.amount)) {
      throw new Error(
        `The approved amount can't exceed the requested refund (${refund.amount}).`,
      );
    }

    if (!isGoodwill) {
      const anyShipped = refund.order.vendorOrders.some(
        (vo) => vo.courierOrders.length > 0,
      );
      const anyVendorConfirmed = refund.order.vendorOrders.some((vo) =>
        vo.courierOrders.some((co) => co.vendorConfirmedReturnAt),
      );
      if (anyShipped && !anyVendorConfirmed) {
        throw new Error(
          "No vendor-confirmed physical return yet. Wait for confirmation, or mark isGoodwill=true.",
        );
      }
    }

    // Mark APPROVED (policy decision) — both the summary Refund row and
    // its accounting-detail RefundRecord, but do NOT touch Payment/
    // SSLCommerzTransaction here; that's execution's job.
    // Phase 4 (H-2): one transaction under the shared payment-row lock —
    //  - D6: the approved amount must also fit the remaining refundable
    //    balance (every OTHER consuming refund excluded);
    //  - the refund is CLAIMED on PENDING, so a double approval or an
    //    approve/reject race moves it exactly once and the gateway is called
    //    at most once (the loser gets 409 before any execution).
    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({
        where: { orderId: refund.orderId, status: { in: ["PAID", "PARTIALLY_REFUNDED"] as PaymentStatus[] } },
        orderBy: { createdAt: "desc" as const },
        select: { id: true, amount: true },
      });
      if (payment) {
        const { remaining } = await lockRefundableBalance(tx, payment, refund.orderId);
        // `remaining` already counts this PENDING refund's requested amount.
        const available = remaining + Number(refund.amount);
        if (Number(amountDecimal) > available + REFUND_EPSILON) {
          throw new Error(`Amount exceeds the remaining refundable balance (${available.toFixed(2)}).`);
        }
      }
      const claim = await tx.refund.updateMany({
        where: { id: refundId, status: "PENDING" },
        data: { amount: amountDecimal, status: "APPROVED" },
      });
      if (claim.count !== 1) throw new RefundStateConflictError();
      await tx.refundRecord.update({
        where: { refundId },
        data: {
          refundAmount: amountDecimal,
          status: "APPROVED",
          approvedBy: adminId,
          approvedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          action: "APPROVE",
          entity: "Refund",
          entityId: refundId,
          newData: { amount, note, isGoodwill, approvedBy: adminId },
          userId: adminId,
        },
      });
    });

    // Delegate execution to the gateway layer.
    if (isGoodwill) {
      await paymentService.completeGoodwillRefund(refundId);
    } else {
      await paymentService.processApprovedRefund(refundId);
    }

    // PHASE 2 BATCH 1C-5D: reflect final refund state on the Order itself.
    // Full-vs-partial is CUMULATIVE across every consuming refund (H1 status
    // set — FAILED/REJECTED/CANCELLED excluded), not this refund's amount vs
    // the order total: 600 + 400 partials complete a 1000 payment. FOR UPDATE
    // on the payment row serializes concurrent finalizations so the last
    // writer always sees the full committed sum.
    await prisma.$transaction(async (tx) => {
      const paymentRow = await tx.payment.findFirst({
        where: { orderId: refund.orderId },
        select: { id: true },
      });
      if (paymentRow) {
        await tx.$executeRaw`SELECT "id" FROM "payments" WHERE "id" = ${paymentRow.id} FOR UPDATE`;
      }
      const consumedAgg = await tx.refund.aggregate({
        where: {
          orderId: refund.orderId,
          status: { in: ["PENDING", "APPROVED", "PROCESSING", "REFUNDED"] as RefundStatus[] },
        },
        _sum: { amount: true },
      });
      const isFullRefund =
        Number(consumedAgg._sum.amount ?? 0) + 0.005 >=
        Number(refund.detail.originalAmount);
      await tx.order.update({
        where: { id: refund.orderId },
        data: {
          status: isFullRefund
            ? "REFUNDED"
            : (refund.order.status as OrderStatus),
          paymentStatus: isFullRefund ? "REFUNDED" : "PARTIALLY_REFUNDED",
        },
      });
    });

    if (refund.order.userId) {
      await prisma.notification.create({
        data: {
          type: "PAYMENT",
          title: "Refund Processed",
          message: `Your refund of ৳${amount.toFixed(2)} for order ${refund.order.orderNumber} has been processed.`,
          targetType: "USER",
          targetId: refund.order.userId,
          orderId: refund.orderId,
          actionUrl: `/orders/${refund.orderId}`,
        },
      });
    }

    // PHASE 2 BATCH 1C-7B (G1): enriched terminal response carrying the
    // actual persisted state after execution. Only reachable on success
    // paths — FAILED/PROCESSING delegation errors keep their existing
    // error semantics. Read-after-commit of the fresh rows; refundRecordStatus
    // is null when no RefundRecord exists (never fabricated).
    const fresh = await prisma.refund.findUnique({
      where: { id: refundId },
      select: {
        id: true,
        orderId: true,
        status: true,
        detail: { select: { status: true } },
        order: { select: { paymentStatus: true } },
      },
    });
    return {
      success: true,
      refundId: fresh?.id ?? refundId,
      orderId: fresh?.orderId ?? refund.orderId,
      paymentStatus: fresh?.order?.paymentStatus ?? null,
      refundStatus: fresh?.status ?? null,
      refundRecordStatus: fresh?.detail?.status ?? null,
    };
  },

  async rejectRefund(refundId: string, adminId: string, reason: string) {
    const refund = await prisma.refund.findUnique({
      where: { id: refundId },
      include: {
        detail: true,
        order: { select: { orderNumber: true, userId: true } },
      },
    });
    if (!refund || !refund.detail) throw new Error("Refund record not found");
    if (refund.status !== "PENDING")
      throw new Error(
        `Refund is not in PENDING status. Current: ${refund.status}`,
      );

    // Phase 4 (H-2): claimed on PENDING — never overwrites a concurrent approval.
    await prisma.$transaction(async (tx) => {
      const claim = await tx.refund.updateMany({
        where: { id: refundId, status: "PENDING" },
        data: { status: "REJECTED" },
      });
      if (claim.count !== 1) throw new RefundStateConflictError();
      await tx.refundRecord.update({
        where: { refundId },
        data: {
          status: "REJECTED",
          rejectedBy: adminId,
          rejectionReason: reason,
          rejectedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          action: "REJECT",
          entity: "Refund",
          entityId: refundId,
          newData: { reason, rejectedBy: adminId },
          userId: adminId,
        },
      });
    });

    if (refund.order.userId) {
      await prisma.notification.create({
        data: {
          type: "ORDER",
          title: "Return Request Rejected",
          message: `Your return request for order ${refund.order.orderNumber} was not approved. Reason: ${reason}`,
          targetType: "USER",
          targetId: refund.order.userId,
          orderId: refund.orderId,
        },
      });
    }

    // PHASE 2 BATCH 1C-7B (G1): enriched terminal response (see approveRefund).
    const fresh = await prisma.refund.findUnique({
      where: { id: refundId },
      select: {
        id: true,
        orderId: true,
        status: true,
        detail: { select: { status: true } },
        order: { select: { paymentStatus: true } },
      },
    });
    return {
      success: true,
      refundId: fresh?.id ?? refundId,
      orderId: fresh?.orderId ?? refund.orderId,
      paymentStatus: fresh?.order?.paymentStatus ?? null,
      refundStatus: fresh?.status ?? null,
      refundRecordStatus: fresh?.detail?.status ?? null,
    };
  },

  /** Shared physical-return-gate check used by processRefund/approveRefund. */
  async _checkPhysicalReturnGate(orderId: string, isGoodwill: boolean) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        vendorOrders: {
          include: {
            courierOrders: {
              orderBy: { createdAt: "desc" },
              select: { returnedAt: true, vendorConfirmedReturnAt: true },
            },
          },
        },
      },
    });
    if (!order) throw new Error("Order not found");

    if (!isGoodwill) {
      const anyShipped = order.vendorOrders.some(
        (vo) => vo.courierOrders.length > 0,
      );
      const anyVendorConfirmed = order.vendorOrders.some((vo) =>
        vo.courierOrders.some((co) => co.vendorConfirmedReturnAt),
      );
      if (anyShipped && !anyVendorConfirmed) {
        throw new Error(
          "No vendor-confirmed physical return yet. Wait for vendor.confirmReturnReceipt(), or mark isGoodwill=true if platform-funded.",
        );
      }
    }

    return { order };
  },
};
