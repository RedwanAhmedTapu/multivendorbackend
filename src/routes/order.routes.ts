import express from 'express';
import { OrderController } from '../controllers/order.controller.ts';

const router = express.Router();
const orderController = new OrderController();

router.post('/orders', orderController.createOrder);
router.post('/orders/payment/confirm', orderController.confirmDeliveryPayment);
router.post('/orders/courier/assign', orderController.assignCourier);
router.put('/orders/:orderId/deliver', orderController.deliverOrder);
router.put('/orders/:orderId/cancel', orderController.cancelOrder);

export default router;