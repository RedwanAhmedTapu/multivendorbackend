import type { Request, Response } from 'express';
import { OrderService } from '../services/order.service.ts';
import { paymentService } from '../services/payment.service.ts';
import { CourierService } from '../services/courier.service.ts';

const orderService = new OrderService();
const courierService = new CourierService();

export class OrderController {
  async createOrder(req: Request, res: Response) {
    try {
      const { userId, items, shippingAddress, deliveryFee } = req.body;

      const orders = await orderService.createOrder(
        userId,
        items,
        shippingAddress,
        deliveryFee
      );

     

      res.json({
        success: true,
        orders,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async confirmDeliveryPayment(req: Request, res: Response) {
    try {
      const { transactionId, valId } = req.body;

      const payment = await paymentService.confirmDeliveryFeePayment(
        transactionId,
        valId
      );

      res.json({
        success: true,
        payment
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async assignCourier(req: Request, res: Response) {
    try {
      const { orderId, courierService, recipient, packages } = req.body;

      const courierResponse = await courierService.createDelivery({
        orderId,
        courierService,
        recipient,
        packages
      });

      // Update order with tracking information
      await orderService.updateOrderStatus(orderId, 'PROCESSING');

      res.json({
        success: true,
        courierResponse
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async deliverOrder(req: Request, res: Response) {
    try {
      const { orderId } = req.params;

      // Mark order as delivered
      const order = await orderService.updateOrderStatus(Number(orderId), 'DELIVERED');

      // Process product payment
      await paymentService.processProductPayment(Number(orderId));
      await paymentService.completeProductPayment(Number(orderId));

      res.json({
        success: true,
        order
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async cancelOrder(req: Request, res: Response) {
    try {
      const { orderId } = req.params;
      const { reason } = req.body;

      const order = await orderService.cancelOrder(Number(orderId), reason);

      res.json({
        success: true,
        order
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}