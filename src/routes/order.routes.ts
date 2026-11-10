import express from 'express';
import { OrderController } from '../controllers/order.controller.ts';
import { authenticateUser } from '../middlewares/auth.middleware.ts';

const router = express.Router();
const orderController = new OrderController();

router.use(authenticateUser);


router.post('/', orderController.placeOrder);

router.get('/', orderController.getMyOrders);
router.get('/:orderId', orderController.getOrderById);
router.get('/:orderId/tracking', orderController.trackOrder);
router.patch('/:orderId/cancel', orderController.cancelOrder);
// PHASE 2 BATCH 1B-1 — Pay Now (PAYMENT_PENDING online orders only)
router.post('/:orderId/pay-now', orderController.payNow);

export default router;