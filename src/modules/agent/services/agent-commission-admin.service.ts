// src/modules/agent/services/agent-commission-admin.service.ts
//
// Phase 7 — admin "re-run accrual" for one delivered consignment. An accrual
// that failed or was skipped (e.g. settings were missing) is otherwise only
// retried by the next courier event for that consignment. The re-run uses the
// same consignment scope as the courier webhook (AdminOrderService.
// processCourierStatusUpdate, 1C-12) and the same idempotent engine, so it can
// never create a second row for a (deliveryId, orderItemId).

import { agentDb } from "../agent-db.ts";
import { AgentError, notFound } from "../agent-http.ts";
import { writeConfigAudit, type AdminActor } from "./agent-audit.service.ts";
import { accrueAgentCommissionForDelivery, type AccrualResult, type CommissionDeps, type LineScope } from "./agent-commission.service.ts";

/**
 * The consignment's line scope, computed exactly like the courier webhook:
 * shipped allocations of the consignment's warehouse; orders without any
 * allocation (legacy) use the full lines (undefined).
 */
export async function deliveryLineScope(
  db: any,
  courierOrder: { warehouseId: string | null },
  itemIds: string[],
): Promise<{ hasAllocationScope: boolean; lineScope: LineScope | undefined }> {
  const allocations = await db.orderItemAllocation.findMany({
    where: { orderItemId: { in: itemIds }, warehouseId: courierOrder.warehouseId ?? "___none___", shippedQty: { gt: 0 } },
    select: { orderItemId: true, shippedQty: true },
  });
  const voAllocationCount = await db.orderItemAllocation.count({ where: { orderItemId: { in: itemIds } } });
  const hasAllocationScope = courierOrder.warehouseId != null && voAllocationCount > 0;
  if (!hasAllocationScope) return { hasAllocationScope, lineScope: undefined };
  const byItem = new Map<string, number>();
  for (const a of allocations) byItem.set(a.orderItemId, (byItem.get(a.orderItemId) ?? 0) + a.shippedQty);
  return { hasAllocationScope, lineScope: [...byItem].map(([orderItemId, quantity]) => ({ orderItemId, quantity })) };
}

export async function rerunAccrualForDelivery(
  deliveryId: string,
  actor: AdminActor,
  deps?: Partial<CommissionDeps>,
): Promise<AccrualResult & { deliveryId: string }> {
  const db = agentDb.prisma as any;
  const co = await db.courierOrder.findUnique({
    where: { id: deliveryId },
    select: {
      id: true,
      status: true,
      shipmentKind: true,
      warehouseId: true,
      deliveredAt: true,
      lastStatusUpdate: true,
      vendorOrder: { select: { id: true, status: true, items: { select: { id: true } } } },
    },
  });
  if (!co) throw notFound("Delivery");
  if (co.status !== "DELIVERED") throw new AgentError(`This delivery is ${String(co.status).toLowerCase()}, not delivered`, 409, "NOT_DELIVERED");
  if ((co.shipmentKind ?? "REGULAR") !== "REGULAR") throw new AgentError("Only regular deliveries earn commission", 409, "NOT_A_REGULAR_DELIVERY");
  if (!co.vendorOrder) throw new AgentError("This delivery has no vendor order", 409, "NO_VENDOR_ORDER");
  if (co.vendorOrder.status === "CANCELLED") throw new AgentError("The vendor order was cancelled", 409, "VENDOR_ORDER_CANCELLED");

  const { hasAllocationScope, lineScope } = await deliveryLineScope(db, co, co.vendorOrder.items.map((i: any) => i.id));
  if (hasAllocationScope && lineScope && lineScope.length === 0) {
    throw new AgentError("The consignment's warehouse has no shipped allocations, so nothing can be accrued", 409, "NO_SHIPPED_ALLOCATIONS");
  }

  let result: AccrualResult | { status: "FAILED"; error: string };
  try {
    result = await accrueAgentCommissionForDelivery(
      { vendorOrderId: co.vendorOrder.id, deliveryId: co.id, lineScope, deliveredAt: co.deliveredAt ?? co.lastStatusUpdate },
      deps,
    );
  } catch (err: any) {
    result = { status: "FAILED", error: String(err?.message ?? err).slice(0, 500) };
  }
  // The accrual is not one transaction, so the audit row follows it.
  await writeConfigAudit(db, { entity: "COMMISSION", entityId: co.id, action: "RERUN", newValue: { deliveryId: co.id, vendorOrderId: co.vendorOrder.id, result }, actor });
  if (result.status === "FAILED") throw new AgentError(`The accrual failed: ${result.error}`, 500, "ACCRUAL_FAILED");
  return { ...result, deliveryId: co.id };
}
