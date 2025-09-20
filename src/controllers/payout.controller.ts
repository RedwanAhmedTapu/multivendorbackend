import type { Request, Response } from 'express';
import { PayoutService } from '../services/payout.service.ts';

const payoutService = new PayoutService();

export class PayoutController {
  async processVendorPayouts(req: Request, res: Response) {
    try {
      const { vendorId, period } = req.body;

      const payout = await payoutService.processVendorPayouts(vendorId, period);

      res.json({
        success: true,
        payout
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async handleOrderCancellation(req: Request, res: Response) {
    try {
      const { orderId } = req.params;
      const { reason } = req.body;

      await payoutService.handleOrderCancellation(Number(orderId), reason);

      res.json({
        success: true,
        message: 'Order cancellation processed successfully'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async getPayoutHistory(req: Request, res: Response) {
    try {
      const { vendorId } = req.params;
      const { page = 1, limit = 10 } = req.query;

      // Implementation for getting payout history
      // This would query the vendorPayouts table

      res.json({
        success: true,
        payouts: [],
        pagination: { page, limit, total: 0 }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}