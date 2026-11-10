// src/services/order-accounting.service.ts
//
// PHASE 2 BATCH 1C-1 — the ONE shared voucher-posting integration layer.
// Every code path that marks a payment PAID or an order DELIVERED funnels
// through here (no copy-paste per path):
//   • postEvent0aForConfirmedPayment — Event 0a (order placement escrow),
//     called by payment.service.confirmPayment / payment-gateway confirm
//     variants BEFORE the order is marked CONFIRMED/PAID (voucher failure
//     blocks confirmation; idempotency key per engine spec, so duplicate
//     webhooks post nothing).
//   • postDeliveryVoucherForVendorOrder — Events 1 / 1-COD / 2 / 13 via
//     accountingService.createDeliveryVoucher, per vendorOrder, with the
//     per-SKU VAT + per-line commission resolution from Batch 1A-2.
// Event 0b (split-funded) and Events 12 (store-credit delivery) post via the
// same engine when store-credit payments exist (no producer today — see
// Batch 1C-1 report assumptions).
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../config/prisma.ts";
import { AccountingService } from "./accounting.services.ts";
import { reverseAgentCommissionForReturnSafe } from "../modules/agent/services/agent-commission.service.ts";

const accountingService = new AccountingService();

/** The engine validates `createdBy` against a real user — resolve a platform
 *  admin once per call instead of the engine's rejected "system" sentinel. */
async function systemActorId(): Promise<string> {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
  return admin?.id ?? "system";
}

/** Event 0a — escrow held on successful online payment. Idempotent per
 *  ORDER_PLACED:gateway:orderId key; duplicate webhooks return the existing
 *  voucher (engine-level) and post nothing new. */
export async function postEvent0aForConfirmedPayment(args: {
  orderId: string;
  paymentId: string;
  customerId?: string | null;
  amount: Decimal | number;
  paymentGatewayId: string;
  createdBy?: string;
}) {
  return accountingService.createEvent0aOnlinePayment({
    orderId: args.orderId,
    customerId: args.customerId ?? undefined,
    amount: args.amount,
    paymentGatewayId: args.paymentGatewayId,
    createdBy: !args.createdBy || args.createdBy === "system" ? await systemActorId() : args.createdBy,
  });
}

export interface DeliveryVoucherItem {
  id: string;
  variantId: string;
  quantity: number;
  price: Decimal | number;
  // immutable sale-time snapshot (OrderItem columns; null = legacy line)
  taxRate?: Decimal | number | null;
  taxAmount?: Decimal | number | null;
  taxTreatment?: "STANDARD" | "ZERO" | "EXEMPT" | "LEGACY" | null;
  // PHASE 2 BATCH 1C-3A: sale-time COGS basis (null = legacy line)
  unitCost?: Decimal | number | null;
  variant?: { taxRate: Decimal | number | null; avgCost?: Decimal | number | null; product?: { categoryId: string | null } | null } | null;
}

/** Events 1 / 1-COD / 2 / 13 — delivery recognition, ONE shared function for
 *  every DELIVERED path (admin updateVendorOrderStatus, vendor updateStatus,
 *  courier-webhook cascades). Idempotent per DELIVERED:deliveryId:method:
 *  variant:orderId (engine key) — duplicate deliveries post nothing. */
export async function postDeliveryVoucherForVendorOrder(args: {
  orderId: string;
  vendorId: string;
  deliveryId: string;
  paymentMethod: "ONLINE" | "COD" | "STORE_CREDIT";
  items: DeliveryVoucherItem[];
  /** 1C-12: per-orderItem quantity scope for ONE courier consignment
   *  (multi-warehouse orders ship several consignments; each DELIVERED event
   *  must recognize only its own share). Absent = full VendorOrder scope
   *  (legacy/single-consignment behavior). */
  lineScope?: Array<{ orderItemId: string; quantity: number }>;
  shippingCost?: Decimal | number | null;
  courierCharge?: Decimal | number | null;
  discountAmount?: Decimal | number;
  platformFundedDiscount?: Decimal | number;
  deliveryDate?: Date;
  createdBy?: string;
}) {
  // resolve variant taxRate + product category for lines that arrived without it
  const items = await Promise.all(
    args.items.map(async (item) => {
      if (item.variant && (item.variant as any).avgCost !== undefined) return item;
      const v = await prisma.productVariant.findUnique({
        where: { id: item.variantId },
        select: { taxRate: true, avgCost: true, product: { select: { categoryId: true } } },
      });
      return { ...item, variant: v ?? null };
    }),
  );

  // 1C-12: apply the consignment quantity scope. The scope REPLACES each
  // line's quantity; the sale-time taxAmount snapshot covers the FULL line,
  // so a scoped line carries its proportional share (snapshot itself stays
  // immutable on OrderItem — this is per-voucher derivation only).
  const scopeByItem = new Map(
    (args.lineScope ?? []).map((s) => [s.orderItemId, s.quantity]),
  );
  const scopedItems = items.map((item) => {
    if (!args.lineScope) return item;
    const scopedQty = scopeByItem.get(item.id);
    if (scopedQty === undefined || scopedQty >= item.quantity) return item;
    const ratio = item.quantity > 0 ? new Decimal(scopedQty).dividedBy(item.quantity) : new Decimal(1);
    const scaledTax =
      item.taxAmount !== null && item.taxAmount !== undefined
        ? new Decimal(item.taxAmount).times(ratio)
        : null;
    return { ...item, quantity: scopedQty, taxAmount: scaledTax };
  });

  let itemsTotal = new Decimal(0);
  let productVat = new Decimal(0);
  let commissionBase = new Decimal(0);
  let commissionVat = new Decimal(0);
  let cogsAmount = new Decimal(0);
  const missingAvgCost: string[] = [];
  // PHASE 2 BATCH 1C-2c: per-SKU voucher metadata (spec line_item_details)
  const lineDetails: Array<Record<string, unknown>> = [];
  for (const item of scopedItems) {
    const lineTotal = new Decimal(item.price).times(item.quantity);
    // The sale-time snapshot (OrderItem.taxRate/taxAmount/taxTreatment) is
    // authoritative; ProductVariant.taxRate is NOT consulted for lines that
    // carry a snapshot. Legacy lines (snapshot null) fall back to the current
    // variant rate and are marked LEGACY in the voucher details.
    const hasSnapshot = item.taxRate !== null && item.taxRate !== undefined;
    const lineTaxRate = hasSnapshot
      ? new Decimal(item.taxRate).dividedBy(100)
      : new Decimal(item.variant?.taxRate ?? 0).dividedBy(100);
    const categoryId = item.variant?.product?.categoryId ?? null;
    const resolved = await resolveRate(args.vendorId, categoryId);
    const lineCommission = lineTotal.times(resolved.rate);
    itemsTotal = itemsTotal.plus(lineTotal);
    // line VAT: prefer the snapshotted tax amount; legacy lines compute from
    // the current variant rate (marked LEGACY — sale-time tax not provable).
    const lineVat = hasSnapshot && item.taxAmount != null
      ? new Decimal(item.taxAmount)
      : lineTotal.times(lineTaxRate);
    productVat = productVat.plus(lineVat);
    commissionBase = commissionBase.plus(lineCommission);
    const vatSetting = await getSetting("commission_vat_rate");
    const override = vatSetting && vatSetting.value !== "same_as_line_tax"
      ? new Decimal(vatSetting.value).dividedBy(100)
      : null;
    commissionVat = commissionVat.plus(
      override ? lineCommission.times(override) : lineCommission.times(lineTaxRate),
    );
    // COGS per line: the immutable sale-time unitCost snapshot when present
    // (Batch 1C-3A); legacy lines (no snapshot) fall back to the current
    // ProductVariant.avgCost with a loud warning — the original basis cannot
    // be proven for them.
    const hasUnitCost = item.unitCost !== null && item.unitCost !== undefined;
    const avgCost = hasUnitCost ? item.unitCost : (item.variant as any)?.avgCost;
    if (avgCost === null || avgCost === undefined || Number(avgCost) === 0) {
      missingAvgCost.push(item.variantId);
    } else {
      cogsAmount = cogsAmount.plus(new Decimal(avgCost).times(item.quantity));
    }
    lineDetails.push({
      sku_id: item.variantId,
      qty: item.quantity,
      unit_price: new Decimal(item.price).toString(),
      tax: hasSnapshot ? lineVat.toString() : null,
      discount: 0, // no order-line discount column exists (order-level only)
      tax_treatment: hasSnapshot
        ? (item.taxTreatment ?? (lineTaxRate.greaterThan(0) ? "STANDARD" : "ZERO"))
        : "LEGACY",
    });
  }
  if (missingAvgCost.length > 0) {
    console.warn(
      `[order-accounting] COGS WARNING: variant(s) with null/0 avgCost on order ${args.orderId} — ` +
        `COGS posted without them: ${missingAvgCost.join(", ")}. Fix ProductVariant.avgCost on the SKU master.`,
    );
  }

  return accountingService.createDeliveryVoucher({
    orderId: args.orderId,
    vendorId: args.vendorId,
    deliveryId: args.deliveryId,
    lineItemDetails: lineDetails,
    paymentMethod: args.paymentMethod,
    productBase: itemsTotal,
    productVat,
    shippingBase: new Decimal(args.shippingCost ?? 0),
    shippingVat: new Decimal(0),
    commissionBase,
    commissionVat,
    courierCostBase: new Decimal(args.courierCharge ?? 0),
    courierCostVat: new Decimal(0),
    cogsAmount,
    discountAmount: args.discountAmount,
    platformFundedDiscount: args.platformFundedDiscount,
    deliveryDate: args.deliveryDate,
    createdBy: !args.createdBy || args.createdBy === "system" ? await systemActorId() : args.createdBy,
  });
}

// commission resolution reused from Batch 1A-2 (single source)
import { resolveCommissionRateForLine as resolveRate } from "./admin.order.service.ts";
import { getPlatformSetting as getSetting } from "../modules/shared/platform-settings.ts";

// ── PHASE 2 BATCH 1C-2: returns / goodwill / 0a reversal ──────────────────

/** Events 3 (full) / 4 (partial via refunded lines) — per-line VAT +
 *  commission + COGS restock, resolved with the shared per-line logic. */
export async function postReturnVoucherForOrder(args: {
  orderId: string; vendorId: string; returnId: string;
  items: { id: string; variantId: string; quantity: number; price: Decimal | number; returnedQty?: number; unitCost?: Decimal | number | null;
    variant?: { taxRate: Decimal | number | null; avgCost?: Decimal | number | null; product?: { categoryId: string | null } | null } | null }[];
  paymentMethod: "ONLINE" | "COD" | "STORE_CREDIT";
  refundAmount?: Decimal | number; // partial when < itemsTotal
  vendorReturnId?: string; // PHASE 2 BATCH 1C-5B: quantity-based accounting from a linked VendorReturn
  createdBy?: string;
}) {
  // per-vendor COA is lazily seeded (idempotent per name) before any posting
  await accountingService.seedVendorCOA(args.vendorId, await systemActorId());
  let items: Array<{ id: string; variantId: string; quantity: number; price: Decimal | number; returnedQty?: number; unitCost?: Decimal | number | null; variant?: { taxRate: Decimal | number | null; avgCost?: Decimal | number | null; product?: { categoryId: string | null } | null } | null }> = [];
  if (args.vendorReturnId) {
    // PHASE 2 BATCH 1C-5B: quantity-based return accounting from the persistent
    // VendorReturnItem rows (E1 follow-up). Legacy `args.items` is ignored —
    // returned quantities come from the confirmed physical return.
    const vr = await prisma.vendorReturn.findUnique({
      where: { id: args.vendorReturnId },
      include: {
        items: {
          include: {
            orderItem: { select: { price: true, unitCost: true, taxRate: true, taxTreatment: true } },
            variant: { select: { taxRate: true, product: { select: { categoryId: true } } } },
          },
        },
      },
    });
    if (!vr || vr.items.length === 0) throw new Error("Linked VendorReturn has no items");
    items = vr.items.map((ri: any) => ({
      id: ri.orderItemId,
      variantId: ri.variantId,
      quantity: ri.orderItem.quantity, // shipped/sold quantity (for the shipped-qty guard)
      price: ri.orderItem.price,
      returnedQty: ri.quantity, // actual returned quantity from the VendorReturnItem
      unitCost: ri.orderItem.unitCost,
      // PHASE 2 BATCH 1C-6A: the return voucher needs the SALE-TIME tax
      // snapshot and the variant's categoryId — without them the VAT reversal
      // leg is dropped entirely (rate resolved as 0) and the commission
      // resolver cannot reach VENDOR_CATEGORY / CATEGORY levels. The
      // OrderItem snapshot is authoritative; snapshot-less legacy lines fall
      // back to the current variant rate.
      variant: {
        taxRate: ri.orderItem.taxRate ?? ri.variant?.taxRate ?? null,
        product: { categoryId: ri.variant?.product?.categoryId ?? null },
      },
    }));
  } else {
    items = await Promise.all(args.items.map(async (item) => {
      if (item.variant) return item;
      const v = await prisma.productVariant.findUnique({
        where: { id: item.variantId },
        select: { taxRate: true, avgCost: true, product: { select: { categoryId: true } } },
      });
      return { ...item, variant: v ?? null };
    }));
  }
  let productBase = new Decimal(0); let productVat = new Decimal(0);
  let commissionBase = new Decimal(0); let commissionVat = new Decimal(0);
  let cogsToRestore = new Decimal(0);
  // PHASE 2 BATCH 1C-5B: transaction-safe quantity validation — total returned
  // per OrderItem across ALL CONFIRMED returns (including this one) must never
  // exceed the shipped/sold quantity. FOR UPDATE on the vendor_orders row
  // serializes concurrent returns for the same vendor order.
  if (args.vendorReturnId) {
    await prisma.$transaction(async (tx) => {
      const voId = (await prisma.vendorReturn.findUnique({ where: { id: args.vendorReturnId! }, select: { vendorOrderId: true } }))!.vendorOrderId;
      await tx.$executeRaw`SELECT "id" FROM "vendor_orders" WHERE "id" = ${voId} FOR UPDATE`;
      for (const item of items) {
        if (item.returnedQty === undefined || item.returnedQty <= 0) {
          throw new Error(`Invalid returned quantity for item ${item.id}: ${item.returnedQty}`);
        }
        const prior = await tx.vendorReturnItem.aggregate({
          where: { orderItemId: item.id, return: { vendorOrderId: voId, status: "CONFIRMED", id: { not: args.vendorReturnId } } },
          _sum: { quantity: true },
        });
        const alreadyReturned = prior._sum.quantity ?? 0;
        if (alreadyReturned + item.returnedQty > item.quantity) {
          throw new Error(
            `Return quantity exceeds shipped quantity for item ${item.id}: shipped ${item.quantity}, already returned ${alreadyReturned}, requested ${item.returnedQty}`,
          );
        }
      }
    });
  }
  for (const item of items) {
    const returnedQty = item.returnedQty ?? item.quantity;
    const lineTotal = new Decimal(item.price).times(returnedQty);
    const lineTaxRate = new Decimal(item.variant?.taxRate ?? 0).dividedBy(100);
    const resolved = await resolveRate(args.vendorId, item.variant?.product?.categoryId ?? null);
    const lineCommission = lineTotal.times(resolved.rate);
    productBase = productBase.plus(lineTotal);
    productVat = productVat.plus(lineTotal.times(lineTaxRate));
    commissionBase = commissionBase.plus(lineCommission);
    commissionVat = commissionVat.plus(lineCommission.times(lineTaxRate));
    // PHASE 2 BATCH 1C-3A (F1): refund COGS reverses the SALE-TIME basis —
    // OrderItem.unitCost snapshot. Legacy lines (no snapshot) fall back to the
    // current variant avgCost with a loud warning (basis unprovable).
    const hasUnitCost = item.unitCost !== null && item.unitCost !== undefined;
    const avgCost = hasUnitCost ? item.unitCost : (item.variant as any)?.avgCost;
    if (hasUnitCost || (avgCost !== null && avgCost !== undefined && Number(avgCost) > 0)) {
      if (!hasUnitCost) console.warn(`[order-accounting] refund COGS WARNING: item ${item.id} has no unitCost snapshot — using CURRENT avgCost ${avgCost} (legacy; basis unprovable).`);
      cogsToRestore = cogsToRestore.plus(new Decimal(avgCost).times(returnedQty));
    } else {
      console.warn(`[order-accounting] COGS WARNING: variant ${item.variantId} has null/0 avgCost — return COGS not restored for it.`);
    }
  }
  const isPartial = args.refundAmount !== undefined && new Decimal(args.refundAmount).lessThan(productBase);
  // PHASE 2 BATCH 1C-3A + 1C-5B: COGS reversal uses the sale-time unitCost
  // snapshot × actual returned quantity. The financial refund amount is a
  // SEPARATE concept (recorded on the Refund row) and does NOT scale COGS.
  return accountingService.createReturnVoucher({
    orderId: args.orderId, returnId: args.returnId, vendorId: args.vendorId,
    lineItemId: isPartial ? `partial:${args.returnId}` : undefined,
    productBase, productVat, commissionBase, commissionVat, cogsToRestore,
    refundMethod: args.paymentMethod === "COD" ? "PG" : "PG",
    createdBy: args.createdBy ?? (await systemActorId()),
  });
}

// PHASE 2 BATCH 1C-5D — VendorReturn consumption for refunds.
// A refund CONSUMES the order's unconsumed CONFIRMED VendorReturns and posts
// ONE Event 3/4 voucher PER consumed return, keyed `vret:{vendorReturnId}` so
// the engine's unique idempotencyKey makes double consumption structurally
// impossible: any later refund that links an already-posted return produces
// the SAME key and is an engine-level no-op. Consumption rules:
//   - claim = SELECT … FOR UPDATE on vendor_returns rows where refundId IS
//     NULL (or already this refund — crash-safe retry), then refundId set;
//     rows claimed by ANOTHER refund drop out on re-evaluation, so two
//     concurrent refunds can never consume the same return;
//   - only SUCCESS paths call this — FAILED/PROCESSING refunds never claim,
//     so the physical return stays available for a later valid refund;
//   - a refund may consume MULTIPLE returns (one voucher each) and a vendor
//     order with no confirmed return gets NO voucher (no goods came back).
export async function consumeVendorReturnsForRefund(args: {
  orderId: string;
  refundId: string;
  paymentMethod: "COD" | "ONLINE" | "STORE_CREDIT";
  refundAmount: Decimal | number;
  createdBy?: string;
}) {
  const order = await prisma.order.findUnique({
    where: { id: args.orderId },
    include: { vendorOrders: { select: { id: true, vendorId: true, items: true } } },
  });
  if (!order) throw new Error("Order not found for return consumption");

  const consumed: Array<{ vendorReturnId: string; vendorId: string }> = [];
  for (const vo of order.vendorOrders) {
    const claimed = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "vendor_returns"
        WHERE "vendorOrderId" = ${vo.id}
          AND "status" = 'CONFIRMED'
          AND ("refundId" IS NULL OR "refundId" = ${args.refundId})
        FOR UPDATE`;
      if (rows.length === 0) return [];
      await tx.vendorReturn.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { refundId: args.refundId },
      });
      return rows;
    });
    for (const vr of claimed) {
      await postReturnVoucherForOrder({
        orderId: args.orderId,
        vendorId: vo.vendorId,
        returnId: `vret:${vr.id}`,
        items: vo.items,
        paymentMethod: args.paymentMethod,
        refundAmount: args.refundAmount,
        vendorReturnId: vr.id,
        createdBy: args.createdBy,
      });
      // Agent commission reversal (docs/agent-system-plan.md §5.2): idempotent
      // per (commission, return); never throws into the refund flow.
      await reverseAgentCommissionForReturnSafe(vr.id);
      consumed.push({ vendorReturnId: vr.id, vendorId: vo.vendorId });
    }
  }
  return consumed;
}

/** Event 5 — platform goodwill refund (platform expense, no vendor entry). */
export async function postGoodwillRefundVoucher(args: {
  orderId: string; refundId: string; amount: Decimal | number; refundMethod?: "PG" | "WALLET"; createdBy?: string;
}) {
  return accountingService.createGoodwillRefundVoucher({
    orderId: args.orderId, refundId: args.refundId, amount: args.amount,
    refundMethod: args.refundMethod, createdBy: args.createdBy ?? (await systemActorId()),
  });
}

/** Reverse the Event 0a escrow voucher for a paid order (paid pre-delivery
 *  cancel). Idempotent: no POSTED 0a voucher → no-op. */
export async function reverseEvent0aForOrder(orderId: string, reason: string, userId?: string) {
  const v0a = await prisma.voucher.findFirst({
    where: { eventTrigger: "ORDER_PLACED", orderId, status: "POSTED" },
    select: { id: true },
  });
  if (!v0a) return { reversed: false, reason: "no posted Event 0a voucher" };
  // reversal writes audit rows against a real platform user — the customer
  // session id is not FK-valid for audit_logs_userId.
  await accountingService.reverseVoucher(v0a.id, reason, await systemActorId());
  return { reversed: true, voucherId: v0a.id };
}
