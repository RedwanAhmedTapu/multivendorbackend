import type { Request, Response } from 'express';
import { OrderService } from '../services/order.service.ts';

const orderService = new OrderService();

export class OrderController {
  /**
   * POST /orders
   * Body: { userAddressId: string }
   */
  async placeOrder(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { userAddressId } = req.body;

      if (!userAddressId) {
        return res.status(400).json({
          success: false,
          error: 'userAddressId is required',
        });
      }

      const order = await orderService.placeOrder(userId, userAddressId);

      return res.status(201).json({
        success: true,
        data: order,
      });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }
  }

  /**
   * GET /orders
   * Query: ?page=1&limit=10&status=PENDING
   */
  async getMyOrders(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const page   = Math.max(1, parseInt(req.query.page  as string) || 1);
      const limit  = Math.min(50, parseInt(req.query.limit as string) || 10);
      const status = req.query.status as string | undefined;

      const result = await orderService.getUserOrders(userId, { page, limit, status });

      return res.json({
        success: true,
        data: result.orders,
        pagination: {
          page,
          limit,
          total: result.total,
          totalPages: Math.ceil(result.total / limit),
        },
      });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * GET /orders/:orderId
   */
  async getOrderById(req: Request, res: Response) {
    try {
      const userId      = req.user!.id;
      const { orderId } = req.params;

      const order = await orderService.getUserOrderById(userId, orderId);

      if (!order) {
        return res.status(404).json({ success: false, error: 'Order not found' });
      }

      return res.json({ success: true, data: order });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * GET /orders/:orderId/tracking
   */
  async trackOrder(req: Request, res: Response) {
    try {
      const userId      = req.user!.id;
      const { orderId } = req.params;

      const tracking = await orderService.getOrderTracking(userId, orderId);

      if (!tracking) {
        return res.status(404).json({ success: false, error: 'Tracking information not available' });
      }

      return res.json({ success: true, data: tracking });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * PATCH /orders/:orderId/cancel
   * Body: { reason? }
   */
  async cancelOrder(req: Request, res: Response) {
    try {
      const userId      = req.user!.id;
      const { orderId } = req.params;
      const reason      = (req.body.reason as string) || 'Cancelled by customer';

      const order = await orderService.cancelOrderByUser(userId, orderId, reason);

      return res.json({ success: true, data: order });
    } catch (error: any) {
      const statusCode = error.message.includes('cannot be cancelled') ? 400 : 500;
      return res.status(statusCode).json({ success: false, error: error.message });
    }
  }
}