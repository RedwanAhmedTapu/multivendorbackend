import express from 'express';
import { PayoutController } from '../controllers/payout.controller.ts';

const router = express.Router();
const payoutController = new PayoutController();

router.post('/payouts/process', payoutController.processVendorPayouts);
router.post('/orders/:orderId/cancel', payoutController.handleOrderCancellation);
router.get('/payouts/vendor/:vendorId', payoutController.getPayoutHistory);

export default router;