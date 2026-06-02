import { Router } from 'express';
import { PurchaseOrderController } from '../controllers/purchase-order.controller.ts';

const router = Router();
const ctrl = new PurchaseOrderController();

/**
 * GET    /api/purchase-orders/next-number
 * Returns the next PO number like PUR-2025-0004.
 * Must be registered BEFORE /:id routes to prevent "next-number" being
 * treated as an :id param.
 *
 * Response: { success, data: { purchaseNo: "PUR-2025-0004" } }
 */
router.get('/next-number', (req, res) => ctrl.nextNumber(req, res));

/**
 * POST   /api/purchase-orders
 * Save a complete purchase entry atomically:
 *   - PurchaseOrder + PurchaseOrderItems
 *   - WarehouseStock upsert per item
 *   - ProductVariant.avgCost (weighted average) + price + stock total
 *   - PURCHASE voucher  (DR Inventory, DR VAT → CR Accounts Payable)
 *   - PAYMENT voucher   (DR Accounts Payable → CR Bank/Cash) — if paidAmount > 0
 *   - PurchasePayment record
 *
 * Body: CreatePurchaseOrderDTO
 * Response: { success, message, data: PurchaseOrder & { vouchers[] } }
 */
router.post('/', (req, res) => ctrl.create(req, res));

/**
 * GET    /api/purchase-orders
 * Paginated list with optional filters.
 *
 * Query: supplierId, warehouseId, status, startDate, endDate, search, page, limit
 * Response: { success, data: PurchaseOrder[], pagination, stats }
 */
router.get('/', (req, res) => ctrl.list(req, res));

/**
 * GET    /api/purchase-orders/:id
 * Full PO detail: items, payments, supplier, warehouse, vouchers with ledger entries.
 *
 * Response: { success, data: PurchaseOrder & { items, payments, vouchers } }
 */
router.get('/:id', (req, res) => ctrl.getById(req, res));

/**
 * POST   /api/purchase-orders/:id/payments
 * Pay against an existing PO (partial or full — mirrors savePayDue() in the ERP).
 * Creates a PurchasePayment record, reduces dueAmount on the PO,
 * updates status to CONFIRMED when fully paid, and posts a PAYMENT voucher.
 *
 * Body: PayPurchaseDueDTO { amount, method, coaAccountId, reference?, entityType, entityId? }
 * Response: { success, message, data: { purchaseOrderId, purchaseNo, amountPaid, newDue, newStatus, voucherNumber } }
 */
router.post('/:id/payments', (req, res) => ctrl.payDue(req, res));

export default router;