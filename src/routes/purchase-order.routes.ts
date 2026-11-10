import { Router } from 'express';
import { PurchaseOrderController } from '../controllers/purchase-order.controller.ts';
import { authenticateUser, authorizeRoles } from '../middlewares/auth.middleware.ts';

const router = Router();
const ctrl = new PurchaseOrderController();
router.use(authenticateUser);
router.use(authorizeRoles('ADMIN', 'EMPLOYEE', 'VENDOR'));

/**
 * GET    /api/purchase-orders/next-number
 */
router.get('/next-number', (req, res) => ctrl.nextNumber(req, res));

/**
 * GET    /api/purchase-orders/stock-intake-template
 */
router.get('/stock-intake-template', (req, res) => ctrl.stockIntakeTemplate(req, res));

/**
 * POST   /api/purchase-orders
 */
router.post('/', (req, res) => ctrl.create(req, res));

/**
 * GET    /api/purchase-orders
 */
router.get('/', (req, res) => ctrl.list(req, res));

/**
 * GET    /api/purchase-orders/:id
 */
router.get('/:id', (req, res) => ctrl.getById(req, res));

/**
 * POST   /api/purchase-orders/:id/receive
 */
router.post('/:id/receive', (req, res) => ctrl.receive(req, res));

/**
 * POST   /api/purchase-orders/:id/payments
 */
router.post('/:id/payments', (req, res) => ctrl.payDue(req, res));

/**
 * POST   /api/purchase-orders/:id/short-close
 * Permanently writes off the requested remaining (un-received) quantity on
 * each item (Group A1/A2). Recomputes subtotal/vatAmount/totalAmount
 * downward, posts a reversal voucher, and resolves payment status —
 * including flipping to OVERPAID + crediting PurchaseOrder.creditBalance if
 * the PO was already paid past the new (lower) total.
 *
 * Body: ShortClosePurchaseOrderDTO { reason, items: [{ purchaseOrderItemId, cancelQuantity }], entityType?, entityId? }
 * Response: { success, message, data: PurchaseOrder & { voucher } }
 */
router.post('/:id/short-close', (req, res) => ctrl.shortClose(req, res));

/**
 * POST   /api/purchase-orders/:id/cancel
 * Cancels everything still outstanding on the PO. If something has already
 * been received, that portion is left in stock (use /returns separately);
 * the outstanding remainder is reversed the same way short-close does.
 * Not allowed once the PO is FULLY_RECEIVED (use /returns instead).
 *
 * Body: CancelPurchaseOrderDTO { reason, entityType?, entityId? }
 * Response: { success, message, data: PurchaseOrder & { voucher } }
 */
router.post('/:id/cancel', (req, res) => ctrl.cancel(req, res));

/**
 * POST   /api/purchase-orders/:id/returns
 * Sends already-received stock back to the supplier (Group C1). Decrements
 * WarehouseStock, logs a PURCHASE_RETURN StockMovement, reduces the payable
 * at the ORIGINAL PO unit cost, and posts a voucher.
 *
 * Body: ReturnPurchaseOrderDTO { reason, items: [{ purchaseOrderItemId, quantity, warehouseId, rackId? }], returnedBy?, entityType?, entityId? }
 * Response: { success, message, data: PurchaseReturn & { purchaseOrder, voucher } }
 */
router.post('/:id/returns', (req, res) => ctrl.returnItems(req, res));

/**
 * POST   /api/purchase-orders/:id/refund-credit
 * Cashes out (partially or fully) PurchaseOrder.creditBalance created by an
 * overpayment discovered during short-close/cancel/return (Group D1).
 *
 * Body: RefundPurchaseOrderCreditDTO { amount, method, coaAccountId, reference?, entityType?, entityId? }
 * Response: { success, message, data: PurchaseRefund & { purchaseOrder, voucher } }
 */
router.post('/:id/refund-credit', (req, res) => ctrl.refundCredit(req, res));

export default router;