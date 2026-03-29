import express from 'express';
import { OrderController } from '../controllers/order.controller.ts';

const router = express.Router();
const orderController = new OrderController();

// All routes require authenticated user

// Place a new order from checkout session
router.post('/', orderController.placeOrder);

// Get all orders for the logged-in user (paginated)
router.get('/', orderController.getMyOrders);

// Get a single order by ID
router.get('/:orderId', orderController.getOrderById);

// Track courier status for an order
router.get('/:orderId/tracking', orderController.trackOrder);

// Cancel a pending order
router.patch('/:orderId/cancel', orderController.cancelOrder);

export default router;