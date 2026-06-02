import type { Request, Response } from 'express';
import * as poService from '../services/purchase-order.service.ts';
import type { PurchaseOrderListQuery } from '../types/erp.types.ts';

export class PurchaseOrderController {
  // ─── GET /api/purchase-orders/next-number ─────────────────────────────────
  async nextNumber(_req: Request, res: Response) {
    try {
      const num = await poService.getNextPurchaseNumber();
      res.json({ success: true, data: { purchaseNo: num } });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── POST /api/purchase-orders ────────────────────────────────────────────
async create(req: Request, res: Response) {
  try {
    const user      = (req as any).user;
    const createdBy = user?.id;

    const body = {
      ...req.body,
      entityId:
        req.body.entityId ??
        (req.body.entityType === 'VENDOR' ? user?.vendorId : undefined),
    };

    const po = await poService.createPurchaseOrder(body, createdBy);
    res.status(201).json({ success: true, message: 'Purchase order saved', data: po });
  } catch (e: any) {
    res.status(400).json({ success: false, message: e.message });
  }
}

  // ─── GET /api/purchase-orders ─────────────────────────────────────────────
  async list(req: Request, res: Response) {
    try {
      const query: PurchaseOrderListQuery = {
        supplierId: req.query.supplierId as string,
        warehouseId: req.query.warehouseId as string,
        status: req.query.status as any,
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        search: req.query.search as string,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
      };
      const result = await poService.listPurchaseOrders(query);
      res.json({ success: true, ...result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── GET /api/purchase-orders/:id ─────────────────────────────────────────
  async getById(req: Request, res: Response) {
    try {
      const po = await poService.getPurchaseOrderById(req.params.id);
      res.json({ success: true, data: po });
    } catch (e: any) {
      res.status(404).json({ success: false, message: e.message });
    }
  }

  // ─── POST /api/purchase-orders/:id/payments ───────────────────────────────
  async payDue(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.id;
      const result = await poService.payPurchaseDue(req.params.id, req.body, createdBy);
      res.status(201).json({ success: true, message: 'Payment recorded', data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }
}