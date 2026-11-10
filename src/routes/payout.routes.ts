import express from 'express';
import { PayoutController } from '../controllers/payout.controller.ts';
import { authenticateUser, authorizeRoles } from '../middlewares/auth.middleware.ts';

const router = express.Router();
const payoutController = new PayoutController();

// Phase 3 (security): every payout route requires a platform ADMIN. This
// router was previously mounted at /api/payout with no authentication at all.
router.use(authenticateUser, authorizeRoles('ADMIN'));

// Phase 4 (D2): retired (410) — payout processing marked DELIVERED orders
// REFUNDED, queried fields the Order model does not have and sent the gateway
// password to a placeholder payout endpoint. It stays disabled until rewritten
// (payout.service.ts also refuses to run).
const retired = (_req: express.Request, res: express.Response) => {
  res.status(410).json({
    success: false,
    code: 'ENDPOINT_RETIRED',
    message: 'This endpoint has been retired.',
  });
};
router.post('/payouts/process', retired);
// Retired (410): this endpoint cancelled an order and created a refund with no
// order/stock/courier/refund safeguards (and could not resolve a string order
// id). Orders are cancelled through PATCH /api/user-orders/:orderId/cancel or
// PATCH /api/admin-orders/:id/cancel.
router.post('/orders/:orderId/cancel', (_req, res) => {
  res.status(410).json({
    success: false,
    code: 'ENDPOINT_RETIRED',
    message: 'This endpoint has been retired. Use the order cancellation endpoints instead.',
  });
});
router.get('/payouts/vendor/:vendorId', payoutController.getPayoutHistory);

export default router;