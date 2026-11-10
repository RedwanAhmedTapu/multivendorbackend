import {
  PrismaClient,
  OrderStatus,
  PaymentStatus,
  FulfillmentStatus,
  PaymentMethod,
  StockMovementType,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { createHash } from "crypto";
import { AccountingService } from "./accounting.services.ts";
import { applyStockDelta, runStockMutation } from "../modules/shared/stock-mutations.ts";
import { getPlatformSetting } from "../modules/shared/platform-settings.ts";
import { reverseEvent0aForOrder } from "./order-accounting.service.ts";
import { fraudCheckerService, type NormalizedFraudCheckResult } from "../modules/fraud-checker-module/index.ts";
import courierService, { BOOKING_PENDING } from "./courier.service.ts";
import { packageWeightKg, shipmentWeightKg, PACKAGE_WEIGHT_SELECT } from "../modules/shared/package-weight.ts";
import { effectivePrice, samePrice } from "../modules/shared/pricing.ts";
import { lockRefundableBalance, newRefundNumber, refundIdempotencyKeysEnabled, REFUND_EPSILON } from "./refund-balance.ts";
import { lockOrderForReservation } from "./order-reservation.ts";
const prisma = new PrismaClient();
const accountingService = new AccountingService();

/** This module's own Prisma client — exported only so tests can stub its delegates. */
export const orderServiceDb = prisma;

/**
 * Phase 2 (H-3, supersedes Phase 1's PRICE_CHANGED): thrown by placeOrder
 * BEFORE any write when the recomputed checkout quote is not the one the
 * customer reviewed (QUOTE_CHANGED: prices, stock allocation, delivery
 * charges or totals moved) or when prices changed since the items were added
 * and the customer has not acknowledged that (PRICE_ACK_REQUIRED). Carries the
 * fresh authoritative quote; the controller answers 409 CHECKOUT_CHANGED.
 */
export class CheckoutChangedError extends Error {
  readonly code = "CHECKOUT_CHANGED";
  // Explicit fields (no TS parameter properties): `npm run dev` / `npx ts-node`
  // run on Node's native type stripping, which rejects parameter properties.
  readonly reason: "QUOTE_CHANGED" | "PRICE_ACK_REQUIRED";
  readonly quote: CheckoutQuote;
  constructor(
    reason: "QUOTE_CHANGED" | "PRICE_ACK_REQUIRED",
    quote: CheckoutQuote,
  ) {
    super(
      reason === "PRICE_ACK_REQUIRED"
        ? "Some prices changed since these items were added to your cart. Please review and accept the updated prices before placing your order."
        : "Your order total, prices or delivery have changed since you reviewed them. Please review the updated order before placing it.",
    );
    this.name = "CheckoutChangedError";
    this.reason = reason;
    this.quote = quote;
  }
}

/**
 * Phase 3 (H-1): a customer cannot cancel while a courier booking is active or
 * unresolved for the order (409 COURIER_BOOKING_ACTIVE); nothing is written.
 */
export class CourierBookingActiveError extends Error {
  readonly code = "COURIER_BOOKING_ACTIVE";
  constructor() {
    super(
      "This order has a courier booking that is already in progress, so it can't be cancelled here. Please contact support to cancel it.",
    );
    this.name = "CourierBookingActiveError";
  }
}

// ── Customer actions on an order (derived; mirrors the enforcing code) ──────

const CUSTOMER_UNCANCELLABLE = ["SHIPPED", "DELIVERED", "RETURNED", "REFUNDED"];

export type CancelBlockedReason = "ALREADY_CANCELLED" | "DISPATCHED" | "COURIER_BOOKING_ACTIVE";

/** Pay Now: a PENDING order whose payment is PENDING, paid online (startPayNow re-checks under a lock). */
export function payNowEligible(o: { status: string; paymentStatus: string; paymentmethod: string }): boolean {
  return o.status === "PENDING" && o.paymentStatus === "PENDING" && o.paymentmethod !== "COD";
}

/**
 * What the customer may do with their order right now — the same rules
 * cancelOrderByUser / startPayNow enforce (they re-check; this only drives
 * which buttons the storefront shows and why one is missing).
 */
export function customerOrderActions(order: {
  status: string;
  paymentStatus: string;
  paymentmethod: string;
  vendorOrders: { status: string; courierOrders?: { status: string; courierStatus?: string | null; courierTrackingId?: string | null }[] }[];
}): { canPayNow: boolean; canCancel: boolean; cancelBlockedReason: CancelBlockedReason | null } {
  let cancelBlockedReason: CancelBlockedReason | null = null;
  if (order.status === "CANCELLED") cancelBlockedReason = "ALREADY_CANCELLED";
  else if (CUSTOMER_UNCANCELLABLE.includes(order.status) || order.vendorOrders.some((vo) => CUSTOMER_UNCANCELLABLE.includes(vo.status))) {
    cancelBlockedReason = "DISPATCHED";
  } else if (
    order.vendorOrders.some((vo) =>
      (vo.courierOrders ?? []).some((co) => co.status !== "CANCELLED" && (co.courierTrackingId || co.courierStatus !== BOOKING_PENDING)),
    )
  ) {
    cancelBlockedReason = "COURIER_BOOKING_ACTIVE";
  }
  return { canPayNow: payNowEligible(order), canCancel: cancelBlockedReason === null, cancelBlockedReason };
}

/**
 * Phase 3 (H-2) / Phase 4: the cancellation refund. Runs on the caller's
 * transaction client:
 *  - takes the payment-row lock every refund writer uses, then refunds only
 *    the REMAINING refundable balance (paid − PENDING/APPROVED/PROCESSING/
 *    REFUNDED refunds) — never more than was paid, and nothing when an
 *    earlier refund already covers it (so it is created at most once);
 *  - creates the Refund AND its RefundRecord together, so the refund can be
 *    approved / rejected (approveRefund and rejectRefund require the record).
 */
export async function createCancellationRefundOnce(
  tx: any,
  orderId: string,
  reason: string,
  opts: { initiatedBy: string; refundType: "CUSTOMER_INITIATED" | "ADMIN_INITIATED" },
) {
  const payment = await tx.payment.findFirst({
    where: { orderId, status: { in: ["PAID", "PARTIALLY_REFUNDED"] } },
    orderBy: { createdAt: "desc" },
    include: { sslCommerzDetail: true },
  });
  if (!payment) return { created: false as const, reason: "NO_PAID_PAYMENT" as const };

  const { remaining } = await lockRefundableBalance(tx, payment, orderId);
  if (remaining <= REFUND_EPSILON) return { created: false as const, reason: "ALREADY_REFUNDED" as const };

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { userId: true, vendorOrders: { select: { vendorId: true }, take: 1 } },
  });
  const amount = new Decimal(remaining.toFixed(4));
  const data: any = { orderId, amount, reason, status: "PENDING" };
  if (refundIdempotencyKeysEnabled()) data.idempotencyKey = `order-cancel:${orderId}`;
  const refund = await tx.refund.create({ data });
  await tx.refundRecord.create({
    data: {
      refundId: refund.id,
      refundNumber: newRefundNumber(),
      sslTranId: payment.sslCommerzDetail?.tranId ?? null,
      vendorId: payment.sslCommerzDetail?.vendorId ?? order?.vendorOrders?.[0]?.vendorId ?? "UNKNOWN",
      customerId: payment.sslCommerzDetail?.customerId ?? order?.userId ?? "",
      refundType: opts.refundType,
      originalAmount: payment.amount,
      refundAmount: amount,
      refundReason: reason,
      status: "PENDING",
      initiatedBy: opts.initiatedBy,
    },
  });
  return { created: true as const, refundId: refund.id as string };
}

/** Placement without the reviewed quote's hash is refused (400 QUOTE_REQUIRED). */
export class QuoteRequiredError extends Error {
  readonly code = "QUOTE_REQUIRED";
  constructor() {
    super("Please review your order (delivery and total) before placing it.");
    this.name = "QuoteRequiredError";
  }
}

function money(v: number | Decimal | null | undefined): Decimal {
  return new Decimal(v ?? 0);
}

// ─── Shared select shapes ──────────────────────────────────────────────

const variantSelect = {
  id: true,
  sku: true,
  name: true,
  price: true,
  specialPrice: true,
  taxRate: true,
  // Phase 4 (H-4): avgCost (vendor cost) is never sent to customers.
  images: { select: { url: true, altText: true }, take: 1 },
  product: { select: { id: true, name: true, slug: true, vendorId: true } },
};

const allocationSelect = {
  id: true,
  warehouseId: true,
  rackId: true,
  rowNumber: true,
  shelfNumber: true,
  quantity: true,
  reservedQty: true,
  pickedQty: true,
  packedQty: true,
  shippedQty: true,
  warehouse: { select: { id: true, name: true, code: true } },
  rack: { select: { id: true, code: true, label: true } },
};

const orderListSelect = {
  id: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  paymentmethod: true,
  fulfillmentStatus: true,
  totalAmount: true,
  subtotal: true,
  shippingCost: true,
  discountAmount: true,
  createdAt: true,
  confirmedAt: true,
  vendorOrders: {
    select: {
      id: true,
      status: true,
      fulfillmentStatus: true,
      subtotal: true,
      vendor: { select: { id: true, storeName: true, avatar: true } },
      items: {
        select: {
          id: true,
          quantity: true,
          price: true,
          deliveredQuantity: true,
          returnedQuantity: true,
          variant: { select: variantSelect },
        },
      },
    },
  },
  address: {
    select: { receiverFullName: true, phone: true, city: true, address: true },
  },
};

const orderDetailSelect = {
  ...orderListSelect,
  paidAt: true,
  cancelledAt: true,
  payments: {
    select: { id: true, method: true, amount: true, status: true, createdAt: true, paidAt: true },
  },
  refunds: {
    select: { id: true, amount: true, reason: true, status: true, createdAt: true },
  },
  vendorOrders: {
    select: {
      id: true,
      status: true,
      fulfillmentStatus: true,
      subtotal: true,
      shippingCost: true,
      shippedAt: true,
      deliveredAt: true,
      cancelledAt: true,
      vendor: { select: { id: true, storeName: true, avatar: true } },
      items: {
        select: {
          id: true,
          quantity: true,
          price: true,
          deliveredQuantity: true,
          returnedQuantity: true,
          variant: { select: variantSelect },
          // Per-item breakdown of which warehouse(s)/rack(s) this line
          // was allocated from — a single item can span more than one
          // row here when stock was split across warehouses.
          allocations: { select: allocationSelect },
        },
      },
      // A VendorOrder can now fan out into multiple CourierOrder rows
      // (one per warehouse shipment, when allocation was split).
      courierOrders: {
        select: {
          id: true,
          courierTrackingId: true,
          status: true,
          recipientName: true,
          recipientAddress: true,
          deliveryCharge: true,
          codAmount: true,
          createdAt: true,
          pickedUpAt: true,
          inTransitAt: true,
          deliveredAt: true,
          warehouseId: true,
          courier_providers: { select: { id: true, displayName: true, logo: true } },
        },
      },
    },
  },
};

// ============================================================
// STOCK ALLOCATION HELPERS
// A variant can sit in several WarehouseStock rows for the same
// vendor (different warehouse, or different rack/row/shelf inside
// one warehouse). Reservation therefore has to walk every candidate
// row for that vendor, split the requested qty across as many rows
// as needed, and write one OrderItemAllocation per row so the exact
// pick location is traceable later (pick/pack/ship/return).
//
// Physical `quantity` is only decremented at dispatch time (vendor
// order service, markForDelivery) — this reserves via reservedQty so
// "sellable = quantity - reservedQty - damagedQty" stays accurate for
// the storefront without touching the accounting ledger.
// ============================================================

/**
 * Candidate ordering for which warehouse gets picked first when a
 * variant has stock in more than one of a vendor's warehouses.
 *
 * Current strategy: vendor's `isDefault` warehouse first, then the
 * row with the most available stock (fewest partial-allocations /
 * fewest separate shipments). This is a placeholder — the real-world
 * upgrade is to sort by distance from the delivery address instead
 * (see notes below the class), once `locations` lat/lng is passed in.
 */
async function findAllocatableStockRows(
  tx: any,
  variantId: string,
  vendorId: string,
  excludeWarehouseIds: string[] = [],
) {
  const rows = await tx.warehouseStock.findMany({
    where: {
      variantId,
      warehouse: {
        vendorId,
        isActive: true, // deactivated warehouses never receive new allocations
        ...(excludeWarehouseIds.length ? { id: { notIn: excludeWarehouseIds } } : {}),
      },
    },
    include: { warehouse: { select: { id: true, isDefault: true } } },
    orderBy: [{ warehouse: { isDefault: "desc" } }, { quantity: "desc" }],
  });

  return rows
    .map((r: any) => ({ ...r, sellable: r.quantity - r.reservedQty - r.damagedQty }))
    .filter((r: any) => r.sellable > 0);
}

/**
 * Reserves `qty` units of `variantId` for `orderItemId`, splitting
 * across as many WarehouseStock rows (warehouse/rack/row/shelf) of
 * `vendorId` as necessary, and writes one OrderItemAllocation per row.
 * Throws if the vendor's total sellable stock for the variant is short.
 */

/** One reservation take: `take` units from one WarehouseStock row. */
export interface AllocationTake {
  warehouseId: string;
  rackId: any;
  rowNumber: any;
  shelfNumber: any;
  take: number;
}

/**
 * Phase 2 (H-3): the reservation PLAN, extracted unchanged from
 * allocateStockForOrderItem so the checkout quote and placement share it —
 * the candidate rows (default warehouse first, then most stock; see
 * findAllocatableStockRows) are taken in order until `qty` is covered.
 * Pure: reads nothing, writes nothing.
 */
export function planAllocation(candidateRows: any[], qty: number) {
  const totalSellable = candidateRows.reduce((sum: number, r: any) => sum + r.sellable, 0);
  const takes: AllocationTake[] = [];
  if (totalSellable < qty) return { takes, totalSellable, sufficient: false as const };
  let remaining = qty;
  for (const row of candidateRows) {
    if (remaining <= 0) break;
    const take = Math.min(row.sellable, remaining);
    takes.push({ warehouseId: row.warehouseId, rackId: row.rackId, rowNumber: row.rowNumber, shelfNumber: row.shelfNumber, take });
    remaining -= take;
  }
  return { takes, totalSellable, sufficient: true as const };
}

/** Writes a reservation plan for one OrderItem (the writes allocateStockForOrderItem always made). */
async function applyAllocationPlan(tx: any, orderItemId: string, variantId: string, takes: AllocationTake[]) {
  for (const t of takes) {
    // আগে: সরাসরি tx.warehouseStock.update({reservedQty: increment})
    // এখন: applyStockDelta — এতেই ProductVariant.reservedQty sync হয়ে যায়
    await applyStockDelta(tx, {
      variantId, warehouseId: t.warehouseId, rackId: t.rackId,
      rowNumber: t.rowNumber, shelfNumber: t.shelfNumber,
      reservedDelta: t.take,
      reason: `Order reservation (item ${orderItemId})`,
    });

    await tx.orderItemAllocation.create({
      data: {
        orderItemId, warehouseId: t.warehouseId, rackId: t.rackId,
        rowNumber: t.rowNumber, shelfNumber: t.shelfNumber,
        quantity: t.take, reservedQty: t.take,
      },
    });
  }
}

const insufficientStockMessage = (variantId: string, have: number, need: number) =>
  `Insufficient sellable stock for variant ${variantId}: have ${have}, need ${need}`;

async function allocateStockForOrderItem(
  tx: any,
  orderItemId: string,
  variantId: string,
  vendorId: string,
  qty: number,
  excludeWarehouseIds: string[] = [],
) {
  const candidateRows = await findAllocatableStockRows(tx, variantId, vendorId, excludeWarehouseIds);
  const plan = planAllocation(candidateRows, qty);
  if (!plan.sufficient) {
    throw new Error(insufficientStockMessage(variantId, plan.totalSellable, qty));
  }
  await applyAllocationPlan(tx, orderItemId, variantId, plan.takes);
}

/**
 * Reverses every allocation made for one OrderItem (used on user
 * cancel): decrements reservedQty back on each WarehouseStock row the
 * item was split across, then removes the allocation rows.
 */
async function releaseAllocationsForOrderItem(tx: any, orderItemId: string) {
  const orderItem = await tx.orderItem.findUnique({ where: { id: orderItemId }, select: { variantId: true } });
  if (!orderItem) return;

  const allocations = await tx.orderItemAllocation.findMany({ where: { orderItemId } });

  for (const alloc of allocations) {
    // 1C-17: only the still-pending part (quantity - shippedQty — the same
    // pending concept markForDelivery uses to group allocations) still
    // holds a reservation; the shipped part already left the warehouse at
    // dispatch. Releasing the full quantity drove reservedQty negative and
    // aborted every cancel of a dispatched order.
    const pending = alloc.quantity - alloc.shippedQty;
    if (pending <= 0) continue;

    await applyStockDelta(tx, {
      variantId: orderItem.variantId,
      warehouseId: alloc.warehouseId,
      rackId: alloc.rackId,
      rowNumber: alloc.rowNumber,
      shelfNumber: alloc.shelfNumber,
      reservedDelta: -pending,
      reason: `Release allocation (item ${orderItemId})`,
    });

    if (alloc.shippedQty > 0) {
      // Keep the allocation row as the record of what was shipped (the
      // returns flow reads shipped allocations); shrink it to its shipped
      // part so pending computations see nothing left to release/dispatch.
      await tx.orderItemAllocation.update({
        where: { id: alloc.id },
        data: { quantity: alloc.shippedQty },
      });
    } else {
      await tx.orderItemAllocation.delete({ where: { id: alloc.id } });
    }
  }
}

/**
 * Like releaseAllocationsForOrderItem, but scoped to ONE warehouse.
 * Used when a warehouse turns out to have no courier pickup coverage
 * for an already-allocated shipment (see vendor.order.service.ts's
 * markForDelivery fallback) — releases only that warehouse's rows for
 * this item, leaving any allocation the same item has in OTHER
 * warehouses untouched (an item's quantity can already be split across
 * warehouses before this ever runs). Returns the quantity released, so
 * the caller knows how much to re-allocate elsewhere.
 */
async function releaseAllocationsForOrderItemInWarehouse(
  tx: any,
  orderItemId: string,
  warehouseId: string,
): Promise<number> {
  const orderItem = await tx.orderItem.findUnique({ where: { id: orderItemId }, select: { variantId: true } });
  if (!orderItem) return 0;

  const allocations = await tx.orderItemAllocation.findMany({ where: { orderItemId, warehouseId } });
  let released = 0;

  for (const alloc of allocations) {
    await applyStockDelta(tx, {
      variantId: orderItem.variantId,
      warehouseId: alloc.warehouseId,
      rackId: alloc.rackId,
      rowNumber: alloc.rowNumber,
      shelfNumber: alloc.shelfNumber,
      reservedDelta: -alloc.quantity,
      reason: `Release allocation for warehouse fallback (item ${orderItemId}, warehouse ${warehouseId})`,
    });
    released += alloc.quantity;
  }

  await tx.orderItemAllocation.deleteMany({ where: { orderItemId, warehouseId } });
  return released;
}
// ============================================================
// SHIPPING COST (placeholder)
// Real delivery-fee calculation needs a rate service: total weight
// of the allocated items, distance/zone between the *chosen*
// warehouse's location and the OrderAddress, and COD vs prepaid
// surcharge (see courier providers' rate cards). That's a separate
// service (courier.rate.service.ts) that should be called per
// VendorOrder once its allocations are known — wiring a 0-cost stub
// here so placeOrder has a single place to plug it in.
// ============================================================
async function calculateVendorShippingCost(
  tx: any,
  vendorId: string,
  warehouseIds: string[],
  _paymentMethod: PaymentMethod,
  pricing: { userLocationId: string; totalQty: number; vendorOrderId?: string },
): Promise<Decimal> {
  // B11 (1C-16): per-vendor delivery charge. `warehouseIds` are the
  // warehouses stock allocation actually chose for this VendorOrder, so
  // pricing can never contradict the allocation decision. Route =
  // supplying warehouse location -> user address location; weight =
  // Σ(Warranty.packageWeightValue × allocated qty) per warehouse, via the
  // shared modules/shared/package-weight.ts formula (same as the cart
  // preview and courier booking). The charge is the lowest applicable stored
  // courier rate across active providers; with no applicable rate, checkout
  // fails with the established "No courier available" error instead of
  // silently charging zero.
  if (!warehouseIds.length || pricing.totalQty <= 0 || !pricing.userLocationId) {
    throw new Error("No courier available for this delivery route");
  }

  // 1C-26A: per-warehouse shipping — each supplying warehouse's allocated
  // quantity ships from that physical location to the customer, so each
  // route's delivery charge applies independently. Quoting all warehouses
  // together (picking the single lowest route) would undercharge when a
  // vendor's items are split across warehouses with different delivery costs.
  // Package weights come from each allocated item's product Warranty, so the
  // weight is only knowable from this VendorOrder's allocations.
  if (!pricing.vendorOrderId) {
    throw new Error("calculateVendorShippingCost: vendorOrderId is required to compute shipment weight");
  }
  const perWhLines = new Map<string, { unitWeightKg: number; quantity: number }[]>();
  const allocs = await tx.orderItemAllocation.findMany({
    where: { orderItem: { vendorOrderId: pricing.vendorOrderId } },
    select: {
      warehouseId: true,
      quantity: true,
      shippedQty: true,
      orderItem: {
        select: {
          variantId: true,
          variant: { select: { product: { select: { warranty: { select: PACKAGE_WEIGHT_SELECT } } } } },
        },
      },
    },
  });
  for (const a of allocs) {
    const pending = a.quantity - a.shippedQty;
    if (pending <= 0 || !warehouseIds.includes(a.warehouseId)) continue;
    const lines = perWhLines.get(a.warehouseId) ?? [];
    lines.push({
      unitWeightKg: packageWeightKg(a.orderItem.variant?.product?.warranty, `checkout variant ${a.orderItem.variantId}`),
      quantity: pending,
    });
    perWhLines.set(a.warehouseId, lines);
  }

  return (await quoteWarehouseShipments(tx, vendorId, perWhLines, pricing.userLocationId)).total;
}

/** One supplying warehouse's delivery quote within a vendor's shipment. */
export interface WarehouseShipmentQuote {
  warehouseId: string;
  warehouseName: string | null;
  locationName: string | null;
  weightKg: number;
  charge: Decimal;
  courierProviderId: string;
  courierName: string;
}

/**
 * Phase 2 (H-3): the per-warehouse delivery pricing, extracted unchanged from
 * calculateVendorShippingCost so the checkout quote and placement share it.
 * Each supplying warehouse ships its own lines from its own location
 * (1C-26A): weight = Σ(package weight × qty) via the shared formula, charge =
 * courierService.getLowestDeliveryQuote. No priced warehouse at all → the
 * established "No courier available" error.
 */
async function quoteWarehouseShipments(
  db: any,
  vendorId: string,
  perWhLines: Map<string, { unitWeightKg: number; quantity: number }[]>,
  userLocationId: string,
): Promise<{ total: Decimal; shipments: WarehouseShipmentQuote[] }> {
  const warehouses = await db.vendorWarehouse.findMany({
    where: { id: { in: [...perWhLines.keys()] }, vendorId },
    select: { id: true, locationId: true, name: true, location: { select: { name: true } } },
  });
  let total = new Decimal(0);
  const shipments: WarehouseShipmentQuote[] = [];
  for (const wh of warehouses) {
    if (!wh.locationId) continue;
    const lines = perWhLines.get(wh.id) ?? [];
    const whQty = lines.reduce((s, l) => s + l.quantity, 0);
    if (whQty <= 0) continue;
    // This warehouse's own shipment weight (never a global order weight).
    const whWeight = shipmentWeightKg(lines);
    const best = await courierService.getLowestDeliveryQuote(
      [{ warehouseId: wh.id, locationId: wh.locationId }],
      userLocationId,
      whWeight,
    );
    if (typeof best?.charge !== 'number' || !Number.isFinite(best.charge) || best.charge < 0) {
      throw new Error("No courier available for this delivery route");
    }
    total = total.plus(best.charge);
    shipments.push({
      warehouseId: wh.id,
      warehouseName: wh.name ?? null,
      locationName: wh.location?.name ?? null,
      weightKg: whWeight,
      charge: money(best.charge),
      courierProviderId: best.courierProviderId,
      courierName: best.courierName,
    });
  }
  if (shipments.length === 0) {
    throw new Error("No courier available for this delivery route");
  }
  return { total, shipments };
}

// ─── Phase 2 (H-3): checkout quote ──────────────────────────────────────
// ONE computation for the checkout preview (POST /cart/delivery-fees) and for
// placement (placeOrder, inside its Serializable transaction): current
// selling prices (approved rule), the reservation plan (planAllocation) and
// the per-warehouse delivery charges (quoteWarehouseShipments). Its
// quoteHash identifies exactly what the customer reviewed; placement
// recomputes the quote and refuses to write anything unless the hash matches.

export interface CheckoutQuoteLine {
  cartItemId: string;
  variantId: string;
  vendorId: string;
  quantity: number;
  /** Price saved on the cart line when it was added. */
  cartPrice: number;
  /** Current authoritative selling price — what is charged. */
  price: number;
  lineTotal: number;
  changedSinceAdded: boolean;
}

export interface CheckoutQuoteShipment {
  warehouseId: string;
  warehouseName: string | null;
  locationName: string | null;
  weightKg: number;
  charge: number;
  courierProviderId: string;
  courierProvider: string;
  items: { cartItemId: string; quantity: number }[];
}

export interface CheckoutQuoteVendor {
  vendorId: string;
  vendorName: string;
  subtotal: number;
  shippingCost: number;
  shipments: CheckoutQuoteShipment[];
  error?: string;
}

export interface CheckoutQuote {
  quoteHash: string;
  userAddressId: string;
  lines: CheckoutQuoteLine[];
  vendors: CheckoutQuoteVendor[];
  subtotal: number;
  shippingTotal: number;
  grandTotal: number;
  /** False while any vendor cannot be supplied or priced (vendors[].error). */
  complete: boolean;
  /** Lines whose current price differs from the price saved when added. */
  priceChanges: CheckoutQuoteLine[];
}

const fx = (d: Decimal) => d.toFixed(4);

export async function buildCheckoutQuote(
  db: any,
  input: {
    userAddressId: string;
    userLocationId: string;
    lines: { cartItemId: string; variantId: string; quantity: number; cartPrice: number }[];
  },
): Promise<{ quote: CheckoutQuote; plans: Map<string, AllocationTake[]> }> {
  const variantIds = [...new Set(input.lines.map((l) => l.variantId))];
  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: {
      id: true,
      price: true,
      specialPrice: true,
      product: {
        select: { vendorId: true, warranty: { select: PACKAGE_WEIGHT_SELECT }, vendor: { select: { storeName: true } } },
      },
    },
  });
  const variantById = new Map<string, any>(variants.map((v: any) => [v.id, v]));

  const lines = [...input.lines].sort((a, b) => a.cartItemId.localeCompare(b.cartItemId));
  const quoteLines: { line: CheckoutQuoteLine; total: Decimal; variant: any }[] = lines.map((l) => {
    const v = variantById.get(l.variantId);
    if (!v) throw new Error("One or more items in your cart are no longer available; please review your cart");
    const price = effectivePrice(v.price, v.specialPrice).price;
    const total = price.times(l.quantity);
    return {
      variant: v,
      total,
      line: {
        cartItemId: l.cartItemId,
        variantId: l.variantId,
        vendorId: v.product.vendorId,
        quantity: l.quantity,
        cartPrice: Number(l.cartPrice),
        price: price.toNumber(),
        lineTotal: total.toNumber(),
        changedSinceAdded: !samePrice(l.cartPrice, price),
      },
    };
  });

  const plans = new Map<string, AllocationTake[]>();
  const vendors: CheckoutQuoteVendor[] = [];
  let subtotal = new Decimal(0);
  let shippingTotal = new Decimal(0);
  const vendorIds = [...new Set(quoteLines.map((q) => q.line.vendorId))].sort();
  for (const vendorId of vendorIds) {
    const mine = quoteLines.filter((q) => q.line.vendorId === vendorId);
    const vendorSubtotal = mine.reduce((s, q) => s.plus(q.total), new Decimal(0));
    subtotal = subtotal.plus(vendorSubtotal);
    const vendorName = mine[0].variant.product.vendor?.storeName?.trim() || "Seller";
    const perWhLines = new Map<string, { unitWeightKg: number; quantity: number }[]>();
    const perWhItems = new Map<string, Map<string, number>>();
    let error: string | undefined;
    for (const q of mine) {
      const rows = await findAllocatableStockRows(db, q.line.variantId, vendorId);
      const plan = planAllocation(rows, q.line.quantity);
      if (!plan.sufficient) {
        error = insufficientStockMessage(q.line.variantId, plan.totalSellable, q.line.quantity);
        break;
      }
      plans.set(q.line.cartItemId, plan.takes);
      const unitWeightKg = packageWeightKg(q.variant.product.warranty, `checkout variant ${q.line.variantId}`);
      for (const t of plan.takes) {
        perWhLines.set(t.warehouseId, [...(perWhLines.get(t.warehouseId) ?? []), { unitWeightKg, quantity: t.take }]);
        const items = perWhItems.get(t.warehouseId) ?? new Map<string, number>();
        items.set(q.line.cartItemId, (items.get(q.line.cartItemId) ?? 0) + t.take);
        perWhItems.set(t.warehouseId, items);
      }
    }
    let shipping = new Decimal(0);
    let shipments: CheckoutQuoteShipment[] = [];
    if (!error) {
      try {
        const quoted = await quoteWarehouseShipments(db, vendorId, perWhLines, input.userLocationId);
        shipping = quoted.total;
        shipments = quoted.shipments
          .map((s) => ({
            warehouseId: s.warehouseId,
            warehouseName: s.warehouseName,
            locationName: s.locationName,
            weightKg: s.weightKg,
            charge: s.charge.toNumber(),
            courierProviderId: s.courierProviderId,
            courierProvider: s.courierName,
            items: [...(perWhItems.get(s.warehouseId) ?? new Map()).entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([cartItemId, quantity]) => ({ cartItemId, quantity })),
          }))
          .sort((a, b) => a.warehouseId.localeCompare(b.warehouseId));
      } catch (err: any) {
        error = err?.message ?? "No courier available for this delivery route";
      }
    }
    shippingTotal = shippingTotal.plus(shipping);
    vendors.push({
      vendorId,
      vendorName,
      subtotal: vendorSubtotal.toNumber(),
      shippingCost: shipping.toNumber(),
      shipments,
      ...(error ? { error } : {}),
    });
  }

  const grandTotal = subtotal.plus(shippingTotal);
  const canonical = JSON.stringify({
    a: input.userAddressId,
    l: quoteLines.map(({ line, total }) => [line.cartItemId, line.variantId, line.quantity, fx(money(line.price)), fx(total)]),
    v: vendors.map((v) => [
      v.vendorId,
      v.error ?? null,
      fx(money(v.shippingCost)),
      v.shipments.map((s) => [s.warehouseId, fx(money(s.charge)), s.items.map((i) => [i.cartItemId, i.quantity])]),
    ]),
    t: [fx(subtotal), fx(shippingTotal), fx(grandTotal)],
  });
  const linesOut = quoteLines.map((q) => q.line);
  const quote: CheckoutQuote = {
    quoteHash: createHash("sha256").update(canonical).digest("hex"),
    userAddressId: input.userAddressId,
    lines: linesOut,
    vendors,
    subtotal: subtotal.toNumber(),
    shippingTotal: shippingTotal.toNumber(),
    grandTotal: grandTotal.toNumber(),
    complete: vendors.every((v) => !v.error),
    priceChanges: linesOut.filter((l) => l.changedSinceAdded),
  };
  return { quote, plans };
}

export class OrderService {
  /**
   * Place an order from the user's cart selected items.
   * paymentMethod is now mandatory (schema: Order.paymentmethod).
   * For COD: no accounting voucher yet — revenue recognized at delivery
   * (Event 1-COD). For SSLCOMMERZ/other online methods: a Payment row is
   * created in PENDING status; the actual Event 0a voucher fires once the
   * payment gateway webhook confirms capture (out of scope for this file).
   *  * COD: risk-scored at placement — low risk orders auto-CONFIRMED,
   * high risk stays PENDING for admin/IVR review. For SSLCOMMERZ/other
   * online methods: a Payment row is created in PENDING status; the
   * actual auto-confirm fires from the payment webhook (see
   * admin.order.service.ts -> confirmOrderBySystem).
   */
 /** Risk engine: higher = riskier. Tune thresholds as needed. */
 private static calculateRiskScore(
  user: { isVerified: boolean; createdAt: Date },
  amount: Decimal,
  _address: any,
  fraudResult?: NormalizedFraudCheckResult | null, // NEW
): number {
  let score = 0;
  const accountAgeDays = (Date.now() - new Date(user.createdAt).getTime()) / 86400000;
  if (accountAgeDays < 7) score += 25;
  if (!user.isVerified) score += 20;
  if (amount.greaterThan(5000)) score += 10;
  if (amount.greaterThan(10000)) score += 20;

  // NEW: courier fraud-check signal (only if a provider actually answered)
  if (fraudResult) {
    if (fraudResult.riskLevel === "very_high") score += 40;
    else if (fraudResult.riskLevel === "high") score += 25;
    else if (fraudResult.riskLevel === "medium") score += 10;
    else if (fraudResult.riskLevel === "low" && fraudResult.totalParcels >= 3) score -= 10;
  }
  return score;
}

  /** Placeholder: wire to your SMS/IVR provider (Twilio, SSL, mNotify, etc.) */
  private static async queueCodVerification(orderId: string, phone: string) {
    console.log(`[COD-VERIFY] Queued IVR/SMS for order ${orderId} → ${phone}`);
    // await smsQueue.add({ orderId, phone, type: "COD_VERIFICATION" });
  }
 
  async placeOrder(
    userId: string,
    userAddressId: string,
    paymentMethod: PaymentMethod,
    review: { quoteHash?: string; acknowledgePriceChanges?: boolean } = {},
  ) {
    // Phase 2 (H-3): an order is only ever placed for the quote the customer
    // reviewed (POST /cart/delivery-fees → quoteHash).
    if (typeof review.quoteHash !== "string" || review.quoteHash.length === 0) {
      throw new QuoteRequiredError();
    }
    const cart = await prisma.carts.findFirst({
      where: { userId },
      include: {
        cart_items: {
          where: { isSelected: true },
          include: {
            product_variants: { include: { product: { select: { vendorId: true } } } },
          },
        },
      },
    });

    if (!cart) throw new Error("Cart not found");
    if (!cart.cart_items.length) throw new Error("No selected items in cart");

    const address = await prisma.userAddress.findFirst({
      where: { id: userAddressId, userId },
      include: { locations: { select: { name: true } } },
    });
    if (!address) throw new Error("Shipping address not found");

    const cartItems = cart.cart_items;
    // Risk scoring only (runs before the transaction): the amount at current
    // selling prices — what the quote will charge.
    const riskSubtotal = cartItems.reduce(
      (sum, item) =>
        sum.plus(effectivePrice(item.product_variants.price, item.product_variants.specialPrice).price.times(item.quantity)),
      new Decimal(0),
    );

    // === Risk scoring — MUST run before the transaction starts. ===
const user = await prisma.user.findUnique({
  where: { id: userId },
  select: { isVerified: true, createdAt: true },
});
if (!user) throw new Error("User not found");

// NEW: fraud-checker phone lookup (never blocks placeOrder if it fails/unavailable)
const fraudResult = await fraudCheckerService.checkPhone(address.phone).catch(() => null);

const riskScore = OrderService.calculateRiskScore(user, riskSubtotal, address, fraudResult);
const autoConfirmCod = paymentMethod === PaymentMethod.COD && riskScore < 60;
    // ======================================================================

    const order = await runStockMutation(prisma, async (tx) => {
      // B10/B14: the cart snapshot above is read OUTSIDE this transaction,
      // so between that read and here a concurrent checkout of the same cart
      // can consume the selected items (duplicate order), or products /
      // variants can be soft-deleted or unpublished. Re-verify the cart
      // against CURRENT persisted state inside the Serializable tx — this
      // also makes P2034 retries safe, since each retry re-validates.
      const freshCartItems = await tx.cart_items.findMany({
        where: { cartId: cart.id, isSelected: true },
        select: {
          id: true,
          product_variants: {
            select: {
              availability: true,
              price: true,
              specialPrice: true,
              product: { select: { isDeleted: true, approvalStatus: true } },
            },
          },
        },
      });
      if (freshCartItems.length === 0) {
        throw new Error(
          "Checkout already processed: the selected cart items no longer exist (duplicate submission)",
        );
      }
      const freshIds = new Set(freshCartItems.map((ci) => ci.id));
      if (
        freshCartItems.length !== cartItems.length ||
        cartItems.some((ci) => !freshIds.has(ci.id))
      ) {
        throw new Error("Cart changed during checkout; please review your cart and try again");
      }
      for (const fresh of freshCartItems) {
        const product = fresh.product_variants.product;
        if (
          product.isDeleted ||
          product.approvalStatus !== "ACTIVE" ||
          fresh.product_variants.availability === false
        ) {
          throw new Error(
            "One or more items in your cart are no longer available; please review your cart",
          );
        }
      }

      // 1C-23: server-side price validation — every selected cart line must
      // carry a valid positive snapshot price. The snapshot (B15) is the
      // authoritative price: client-submitted prices are never accepted, and
      // an invalid/zero/negative line blocks checkout before any order,
      // reservation, payment intent, or cart mutation happens.
      for (const line of cartItems) {
        if (!(Number.isFinite(line.price) && Number(line.price) > 0)) {
          throw new Error(
            `Checkout blocked: cart item ${line.id} has an invalid price (${line.price}). Remove the item and add it again, or contact support.`,
          );
        }
      }

      // Phase 2 (H-3): recompute the checkout quote from CURRENT state inside
      // this transaction — selling prices (approved rule), the reservation
      // plan and the per-warehouse delivery charges — exactly as the preview
      // computed it. Nothing has been written yet: if it is not the quote the
      // customer reviewed, or prices changed since the items were added and
      // the customer has not acknowledged that, the transaction ends here with
      // no order, no reservation, no payment row and no cart change. The fresh
      // quote goes back to the customer to review and explicitly confirm.
      const { quote, plans } = await buildCheckoutQuote(tx, {
        userAddressId,
        userLocationId: address.locationId,
        lines: cartItems.map((l) => ({ cartItemId: l.id, variantId: l.variantId, quantity: l.quantity, cartPrice: l.price })),
      });
      if (quote.quoteHash !== review.quoteHash) {
        throw new CheckoutChangedError("QUOTE_CHANGED", quote);
      }
      if (quote.priceChanges.length > 0 && review.acknowledgePriceChanges !== true) {
        throw new CheckoutChangedError("PRICE_ACK_REQUIRED", quote);
      }
      // The reviewed quote itself could not be supplied or priced: the same
      // errors placement has always raised (stock / no courier).
      const unpriced = quote.vendors.find((v) => v.error);
      if (!quote.complete || unpriced) {
        throw new Error(unpriced?.error ?? "No courier available for this delivery route");
      }
      const lineByCartItem = new Map(quote.lines.map((l) => [l.cartItemId, l]));
      const cartItemsByVendor = new Map<string, typeof cartItems>();
      for (const item of cartItems) {
        const vendorId = lineByCartItem.get(item.id)!.vendorId;
        cartItemsByVendor.set(vendorId, [...(cartItemsByVendor.get(vendorId) ?? []), item]);
      }

      const newOrder = await tx.order.create({
        data: {
          userId,
          orderNumber: `ORD-${Date.now()}`,
          status: autoConfirmCod ? OrderStatus.CONFIRMED : OrderStatus.PENDING,
          paymentStatus: PaymentStatus.PENDING,
          paymentmethod: paymentMethod,
          fulfillmentStatus: FulfillmentStatus.UNFULFILLED,
          // Phase 2 (H-3): the confirmed quote's amounts.
          totalAmount: money(quote.grandTotal),
          subtotal: money(quote.subtotal),
          shippingCost: money(quote.shippingTotal),
          tax: new Decimal(0),
          discountAmount: new Decimal(0),
          confirmedAt: autoConfirmCod ? new Date() : null,
          riskScore: new Decimal(riskScore),
          codVerificationStatus: autoConfirmCod ? "PENDING" : null,

          address: {
            create: {
              locationId: address.locationId,
              country: "Bangladesh",
              state: "",
              city: address.locations?.name ?? "",
              address:
                address.addressLine1 + (address.addressLine2 ? `, ${address.addressLine2}` : ""),
              landmark: address.landmark ?? undefined,
              receiverFullName: address.fullName,
              phone: address.phone,
            },
          },

          vendorOrders: {
            create: quote.vendors.map((qv) => ({
              vendorId: qv.vendorId,
              status: autoConfirmCod ? OrderStatus.CONFIRMED : OrderStatus.PENDING,
              fulfillmentStatus: FulfillmentStatus.UNFULFILLED,
              subtotal: money(qv.subtotal),
              shippingCost: money(qv.shippingCost),
              items: {
                create: (cartItemsByVendor.get(qv.vendorId) ?? []).map((i) => {
                  // The confirmed quote's selling price (Phase 2, H-3).
                  const unitPrice = money(lineByCartItem.get(i.id)!.price);
                  // PHASE 2 BATCH 1C-2c: immutable sale-time tax snapshot
                  // (ProductVariant.taxRate is PERCENT units: 5 = 5%).
                  const rate = i.product_variants.taxRate ?? new Decimal(0);
                  const lineBase = unitPrice.times(i.quantity);
                  const taxAmount = lineBase.times(rate).dividedBy(100);
                  return {
                    variantId: i.variantId,
                    quantity: i.quantity,
                    price: unitPrice,
                    // PHASE 2 BATCH 1C-3A: immutable sale-time COGS basis
                    unitCost: i.product_variants.avgCost,
                    taxRate: rate,
                    taxAmount,
                    taxTreatment: rate.greaterThan(0) ? "STANDARD" : "ZERO",
                  };
                }),
              },
            })),
          },
        },
        select: orderDetailSelect,
      });

      // Reserve (not deduct) stock exactly as the confirmed quote planned it
      // (same planAllocation rule, computed in this same transaction), so the
      // delivery charges already on the order match the warehouses reserved.
      const cartItemByVendorVariant = new Map(
        cartItems.map((l) => [`${lineByCartItem.get(l.id)!.vendorId}:${l.variantId}`, l.id]),
      );
      for (const vo of newOrder.vendorOrders) {
        for (const item of vo.items) {
          const cartItemId = cartItemByVendorVariant.get(`${vo.vendor.id}:${item.variant.id}`);
          const takes = cartItemId ? plans.get(cartItemId) : undefined;
          if (!takes) throw new Error("Checkout quote has no reservation plan for an order item");
          await applyAllocationPlan(tx, item.id, item.variant.id, takes);
        }
      }

      // The order as created, now with its allocations.
      const finalOrder = await tx.order.findUnique({
        where: { id: newOrder.id },
        select: orderDetailSelect,
      });
      if (!finalOrder) throw new Error("Order not found after creation");

      // Non-COD: create a PENDING Payment placeholder for the gateway flow.
      if (paymentMethod !== PaymentMethod.COD) {
        await tx.payment.create({
          data: {
            orderId: newOrder.id,
            method: paymentMethod,
            amount: money(quote.grandTotal),
            status: PaymentStatus.PENDING,
          },
        });
      }

      await tx.cart_items.deleteMany({ where: { cartId: cart.id, isSelected: true } });

      // Audit trail for the auto-confirm decision itself.
      await tx.auditLog.create({
        data: {
          action: autoConfirmCod ? "COD_ORDER_AUTO_CONFIRMED" : "ORDER_PLACED_PENDING",
          entity: "Order",
          entityId: newOrder.id,
          newData: { riskScore, autoConfirmCod, paymentMethod },
        },
      });

      return finalOrder;
    });

    // === After transaction commits ===
    if (autoConfirmCod) {
      // Notify the customer their order is confirmed.
      await prisma.notification.create({
        data: {
          type: "ORDER",
          title: "Order Confirmed",
          message: `Your order ${order.orderNumber} has been confirmed.`,
          targetType: "USER",
          targetId: userId,
          orderId: order.id,
          actionUrl: `/orders/${order.id}`,
        },
      });

      // Notify each vendor that a new CONFIRMED order needs processing.
      for (const vo of order.vendorOrders) {
        await prisma.notification.create({
          data: {
            type: "ORDER",
            title: "New Order Confirmed",
            message: `A new order has been confirmed and is ready for processing.`,
            targetType: "EMPLOYEE",
            targetId: vo.vendor.id,
            orderId: order.id,
          },
        });
      }

      // Fire-and-forget: IVR/SMS verification (non-blocking).
      // If customer responds "NO" or times out, a separate cron job
      // reads codVerificationStatus and auto-cancels via
      // AdminOrderService.cancelOrder().
      await OrderService.queueCodVerification(order.id, address.phone);
    }
    // ====================================

    return order;
  }

  

  

  async getUserOrders(userId: string, opts: { page: number; limit: number; status?: string }) {
    const { page, limit, status } = opts;
    const skip = (page - 1) * limit;
    const where = { userId, ...(status ? { status: status as OrderStatus } : {}) };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({ where, select: orderListSelect, orderBy: { createdAt: "desc" }, skip, take: limit }),
      prisma.order.count({ where }),
    ]);

    return { orders, total };
  }

  async getUserOrderById(userId: string, orderId: string) {
    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, select: orderDetailSelect });
    if (!order) return null;
    // Booking state is not part of the customer payload; read it only to derive the actions.
    const courierRows = await prisma.courierOrder.findMany({
      where: { vendorOrder: { orderId } },
      select: { vendorOrderId: true, status: true, courierStatus: true, courierTrackingId: true },
    });
    const customerActions = customerOrderActions({
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentmethod: order.paymentmethod,
      vendorOrders: order.vendorOrders.map((vo: any) => ({
        status: vo.status,
        courierOrders: courierRows.filter((c: any) => c.vendorOrderId === vo.id),
      })),
    });
    return { ...order, customerActions };
  }

  async getOrderTracking(userId: string, orderId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { id: true, orderNumber: true, status: true },
    });
    if (!order) return null;

    const vendorOrders = await prisma.vendorOrder.findMany({
      where: { orderId },
      select: {
        id: true,
        status: true,
        shippedAt: true,
        deliveredAt: true,
        vendor: { select: { id: true, storeName: true, avatar: true } },
        // A VendorOrder can produce more than one CourierOrder when its
        // items were allocated from more than one warehouse.
        courierOrders: {
          select: {
            id: true,
            courierTrackingId: true,
            courierOrderId: true,
            status: true,
            courierStatus: true,
            shipmentKind: true,
            recipientName: true,
            recipientAddress: true,
            deliveryCharge: true,
            codAmount: true,
            warehouseId: true,
            createdAt: true,
            pickedUpAt: true,
            inTransitAt: true,
            deliveredAt: true,
            returnedAt: true,
            cancelledAt: true,
            courier_providers: { select: { id: true, displayName: true, logo: true } },
            courier_tracking_history: {
              select: {
                id: true, status: true, courierStatus: true, messageEn: true,
                messageBn: true, location: true, timestamp: true,
              },
              orderBy: { timestamp: "desc" },
            },
          },
        },
      },
    });

    return { orderId: order.id, orderNumber: order.orderNumber, orderStatus: order.status, vendorOrders };
  }

  /**
   * Cancel a PENDING order — only before any vendor confirms/ships.
   * Post-confirm cancel goes through admin.cancelOrder() (courier-aware).
   */
  /**
   * PHASE 2 BATCH 1B-1 — releases every stock allocation held by an order's
   * items (reservedQty deltas reversed, OrderItemAllocation rows deleted).
   * Used by: payment failure/cancel hooks and the reservation TTL job.
   * Idempotent: orders with no remaining allocations are no-ops.
   */
  async releaseStockForOrder(orderId: string): Promise<{ released: number; skipped?: boolean }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { vendorOrders: { include: { items: true } } },
    });
    if (!order) return { released: 0 };
    return runStockMutation(prisma, async (tx) => {
      // H1: same row lock every confirmation takes — a release and a payment
      // confirmation of the same order never interleave.
      await lockOrderForReservation(tx, orderId);
      // 1C-20: re-verify the order is still an unpaid PENDING order INSIDE
      // the transaction. The TTL job and the payment-failure hooks select
      // their target outside, and a gateway confirmation can land between
      // that read and here (or a delayed failed-IPN can arrive for an older
      // intent after a later payment succeeded) — releasing a CONFIRMED
      // order's stock would strand a paid order without inventory.
      const current = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true, paymentStatus: true },
      });
      if (!current || current.status !== OrderStatus.PENDING || current.paymentStatus !== PaymentStatus.PENDING) {
        return { released: 0, skipped: true };
      }
      let released = 0;
      for (const vo of order.vendorOrders) {
        for (const item of vo.items) {
          const before = await tx.orderItemAllocation.count({ where: { orderItemId: item.id } });
          await releaseAllocationsForOrderItem(tx, item.id);
          released += before;
        }
      }
      return { released, skipped: false };
    });
  }

  /**
   * Pay Now, step 1 — eligibility + stock. For a PAYMENT_PENDING online order
   * owned by `userId`, re-reserves the stock if a failure / TTL release emptied
   * it, inside ONE Serializable transaction (concurrent calls re-read the
   * winner's allocations — one reservation). COD orders are rejected.
   *
   * It does NOT create a payment intent: the gateway session is opened by
   * pay-now.service.ts (startPayNow) through the active gateway, under an
   * order lock with a duplicate-session check. (The former in-transaction
   * "pay_now_retry" intent never got a gateway session and was skipped
   * whenever the checkout placeholder payment existed.)
   */
  async payNowOrder(userId: string, orderId: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        payments: true,
        vendorOrders: { include: { items: { include: { allocations: true } } } },
      },
    });
    if (!order || order.userId !== userId) throw new Error("Order not found");
    if (order.status !== OrderStatus.PENDING || order.paymentStatus !== PaymentStatus.PENDING) {
      throw new Error(`Order is not PAYMENT_PENDING (status=${order.status}, payment=${order.paymentStatus})`);
    }
    if (order.paymentmethod === PaymentMethod.COD) {
      throw new Error("COD orders cannot use Pay Now — pay the courier on delivery");
    }

    // 1C-20: the whole recovery runs inside ONE Serializable transaction.
    // The old check-then-act flow ("double-click safe" comment notwithstanding)
    // let concurrent Pay Now calls all pass the active-intent and empty-
    // allocation checks, creating duplicate payment intents AND double
    // reservations. Here the loser of a concurrent race aborts (P2034),
    // retries, and re-reads the winner's allocations — one reservation.
    // (Duplicate gateway sessions are prevented in pay-now.service.ts.)
    try {
      return await runStockMutation(prisma, async (tx) => {
        const current = await tx.order.findUnique({
          where: { id: orderId },
          include: {
            payments: true,
            vendorOrders: { include: { items: { include: { allocations: true } } } },
          },
        });
        if (!current || current.userId !== userId) throw new Error("Order not found");
        if (current.status !== OrderStatus.PENDING || current.paymentStatus !== PaymentStatus.PENDING) {
          throw new Error(
            `Order is not PAYMENT_PENDING (status=${current.status}, payment=${current.paymentStatus})`,
          );
        }

        // Re-reserve stock if a prior failure/TTL release emptied it (marker set
        // or allocations missing). Insufficient stock → clear error; the order
        // stays PENDING/PENDING untouched. 1C-20: this runs BEFORE any gateway
        // session is opened — the checkout placeholder of an abandoned order
        // stays PENDING across a TTL release, and paying for an order whose
        // stock was already gone must not be possible.
        const needsReservation = current.reservationReleasedAt !== null ||
          current.vendorOrders.some((vo) => vo.items.some((it) => it.allocations.length === 0));
        if (needsReservation) {
          for (const vo of current.vendorOrders) {
            for (const item of vo.items) {
              if (item.allocations.length === 0) {
                await allocateStockForOrderItem(tx, item.id, item.variantId, vo.vendorId, item.quantity);
              }
            }
          }
          await tx.order.update({ where: { id: current.id }, data: { reservationReleasedAt: null } });
        }

        return { reReserved: needsReservation };
      });
    } catch (err: any) {
      if (/Insufficient sellable stock/.test(err?.message ?? "")) {
        throw new Error(
          `Pay Now cannot complete: stock for this order is no longer available (${err.message}). ` +
            `The order remains PAYMENT_PENDING — contact support to adjust it.`,
        );
      }
      throw err;
    }
  }

  /**
   * PHASE 2 BATCH 1B-1 — Reservation TTL job. Releases stock held by
   * abandoned PAYMENT_PENDING orders older than N minutes
   * (platform_settings key "reservation_ttl_minutes"; missing key THROWS),
   * marks those orders CANCELLED (the idempotency guard — a second run
   * finds nothing), and logs every release. No vouchers are posted.
   */
  async releaseStalePaymentPendingReservations() {
    const ttlSetting = await getPlatformSetting("reservation_ttl_minutes");
    if (!ttlSetting) {
      throw new Error(
        "Reservation TTL error: platform_settings key 'reservation_ttl_minutes' is missing — refusing to guess (per spec).",
      );
    }
    const ttlMinutes = Number(ttlSetting.value);
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
      throw new Error(`reservation_ttl_minutes has an invalid value: ${ttlSetting.value}`);
    }
    const cutoff = new Date(Date.now() - ttlMinutes * 60 * 1000);
    // DECISION (Batch 1B-1 review): TTL release must NOT cancel the order —
    // it stays PENDING/PENDING so Pay Now can recover it. Idempotency marker:
    // reservationReleasedAt (set on release, cleared on successful re-reserve).
    const stale = await prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING, paymentStatus: PaymentStatus.PENDING,
        createdAt: { lt: cutoff }, reservationReleasedAt: null,
      },
      include: { vendorOrders: { include: { items: true } } },
      take: 100,
      orderBy: { createdAt: "asc" },
    });
    const released: string[] = [];
    for (const order of stale) {
      const result = await this.releaseStockForOrder(order.id);
      // 1C-20: the order stopped being PENDING/PENDING between the query and
      // the release (e.g. the gateway confirmed the payment) — do not touch
      // it and do not set the release marker.
      if (result.skipped) continue;
      await prisma.order.update({
        where: { id: order.id },
        data: { reservationReleasedAt: new Date() },
      });
      released.push(order.id);
      console.log(`[reservation-ttl] released stock for abandoned order ${order.id} (created ${order.createdAt.toISOString()}, ttl ${ttlMinutes}m) — order stays PENDING for Pay Now`);
    }
    return { checked: stale.length, released, ttlMinutes };
  }

  async cancelOrderByUser(userId: string, orderId: string, reason: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { payments: true, vendorOrders: { include: { items: true } } },
    });

    if (!order) throw new Error("Order not found");
    // Phase 3 (H-2): cancelling an already-cancelled order is a no-op — no
    // second refund, no second stock release, no second voucher reversal.
    if (order.status === OrderStatus.CANCELLED) {
      return prisma.order.findFirst({ where: { id: orderId, userId }, select: orderDetailSelect });
    }
    // PHASE 2 BATCH 1C-2: pre-payment, paid-pre-delivery and COD pre-dispatch
    // cancels are allowed — voucher rules differ (pre-payment/COD -> none; paid
    // pre-delivery -> reverse Event 0a). Post-dispatch -> refund flow only.
    if ([OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.RETURNED, OrderStatus.REFUNDED].includes(order.status)) {
      throw new Error(
        `Order cannot be cancelled by user after dispatch (status ${order.status}) - use the returns/refund flow.`,
      );
    }

   const result = await runStockMutation(prisma, async (tx) => {
      // 1C-17: the dispatch guard above ran on a read OUTSIDE this
      // transaction, and Order.status lags the vendor orders by design
      // (recalculateMasterOrderStatus reports the lagging status), so an
      // already-dispatched sibling vendor order — or one dispatched between
      // that read and here — would otherwise be cancelled below. Re-verify
      // against current state inside the Serializable tx.
      const current = await tx.order.findFirst({
        where: { id: orderId },
        select: {
          status: true,
          vendorOrders: {
            select: {
              status: true,
              courierOrders: { select: { id: true, status: true, courierStatus: true, courierTrackingId: true } },
            },
          },
        },
      });
      if (!current) throw new Error("Order not found");
      // Phase 3 (H-2): a concurrent cancel already committed (this is the
      // P2034 retry, or a double click) → no-op.
      if (current.status === OrderStatus.CANCELLED) {
        return { order: await tx.order.findFirst({ where: { id: orderId }, select: orderDetailSelect }), cancelledNow: false };
      }
      if ([OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.RETURNED, OrderStatus.REFUNDED].includes(current.status)) {
        throw new Error(
          `Order cannot be cancelled by user after dispatch (status ${current.status}) - use the returns/refund flow.`,
        );
      }
      const dispatchedVo = current.vendorOrders.find((vo: any) =>
        [OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.RETURNED, OrderStatus.REFUNDED].includes(vo.status),
      );
      if (dispatchedVo) {
        throw new Error(
          `Order cannot be cancelled by user after dispatch (vendor order status ${dispatchedVo.status}) - use the returns/refund flow.`,
        );
      }

      // Phase 3 (H-1): a booked shipment, or a booking whose outcome is
      // unresolved (claimed / unknown / confirm-failed / legacy "Booking in
      // progress"), may exist at the courier — and no courier cancellation
      // call exists. The customer cannot cancel; nothing is written (support
      // or an admin resolves it). Only an UNCLAIMED intent (nothing sent to a
      // courier) is cancelled, through the guarded helper on THIS transaction.
      const courierRows = current.vendorOrders.flatMap((vo: any) => vo.courierOrders as any[]);
      const activeBooking = courierRows.some(
        (co) => co.status !== "CANCELLED" && (co.courierTrackingId || co.courierStatus !== BOOKING_PENDING),
      );
      if (activeBooking) throw new CourierBookingActiveError();
      for (const co of courierRows) {
        if (co.status === "CANCELLED") continue;
        const { cancelled: intentCancelled } = await courierService.cancelCourierOrder(co.id, tx);
        // The intent changed under us (e.g. it was just claimed) → refuse; the
        // whole transaction rolls back.
        if (!intentCancelled) throw new CourierBookingActiveError();
      }

      const cancelled = await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
        select: orderDetailSelect,
      });

      await tx.vendorOrder.updateMany({
        where: { orderId },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
      });

      for (const vo of order.vendorOrders) {
        for (const item of vo.items) {
          await releaseAllocationsForOrderItem(tx, item.id);
        }
      }

      const paidPayment = order.payments.find((p) => p.status === PaymentStatus.PAID);
      if (paidPayment) {
        await createCancellationRefundOnce(tx, orderId, reason, { initiatedBy: userId, refundType: "CUSTOMER_INITIATED" });
      }

      return { order: cancelled, cancelledNow: true };
    });

    // PHASE 2 BATCH 1C-2: paid pre-delivery cancel reverses Event 0a (outside
    // the stock transaction; idempotent — no POSTED 0a voucher → no-op).
    // Phase 3 (H-2): only when THIS call actually cancelled the order.
    if (result.cancelledNow && order.payments.some((p) => p.status === PaymentStatus.PAID)) {
      await reverseEvent0aForOrder(orderId, `Paid pre-delivery cancel: ${reason}`, userId);
    }

    return result.order;
  }
}

export {
  allocateStockForOrderItem,
  releaseAllocationsForOrderItem,
  releaseAllocationsForOrderItemInWarehouse,
  calculateVendorShippingCost,
  money,
};