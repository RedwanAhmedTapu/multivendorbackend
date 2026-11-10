import type { Request, Response } from 'express';
import * as poService from '../services/purchase-order.service.ts';
import type {
  CreatePurchaseOrderDTO,
  PayPurchaseDueDTO,
  PurchaseOrderListQuery,
  ReceivePurchaseOrderDTO,
  ShortClosePurchaseOrderDTO,
  CancelPurchaseOrderDTO,
  ReturnPurchaseOrderDTO,
  RefundPurchaseOrderCreditDTO,
} from '../types/purchase.types.ts';
import type { AuthRequest } from '../middlewares/auth.middleware.ts';
import * as stockIntakeService from '../services/Stockintaketemplateservice.ts';
import fs from 'fs';

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

  // ─── GET /api/purchase-orders/stock-intake-template ───────────────────────
  async stockIntakeTemplate(req: AuthRequest, res: Response) {
    let filePath: string | undefined;
    try {
      const user = (req as any).user;

      const vendorId =
        user?.role === 'VENDOR' ? user?.vendorId : (req.query.vendorId as string | undefined);

      if (!vendorId) {
        res.status(400).json({
          success: false,
          message: 'vendorId is required (pass ?vendorId= when calling as ADMIN).',
        });
        return;
      }

      const lowStockThreshold = req.query.lowStockThreshold
        ? parseInt(req.query.lowStockThreshold as string, 10)
        : 0;

      const result = await stockIntakeService.generateStockIntakeTemplate(vendorId, {
        lowStockThreshold,
      });
      filePath = result.filePath;

      res.download(filePath, `stock-intake-${vendorId}.xlsx`, (err) => {
        if (filePath) fs.unlink(filePath, () => {});
        if (err) console.error('Error sending stock intake template:', err);
      });
    } catch (e: any) {
      if (filePath) fs.unlink(filePath, () => {});
      const status = e.message?.includes('No products') ? 404 : 400;
      res.status(status).json({ success: false, message: e.message });
    }
  }

  // ─── POST /api/purchase-orders ────────────────────────────────────────────
  async create(req: AuthRequest, res: Response) {
    try {
      const user = (req as any).user;
      const createdBy = user?.rawId ?? user?.id;

      // Vendor isolation: a vendor-scoped actor can only create POs for its
      // own vendor (and therefore only into its own warehouses).
      if (user?.role !== 'ADMIN' && req.body.entityType === 'VENDOR') {
        if (!user?.vendorId || (req.body.entityId && req.body.entityId !== user.vendorId)) {
          res.status(403).json({ success: false, message: 'Not allowed to create purchase orders for another vendor' });
          return;
        }
      }
      const body: CreatePurchaseOrderDTO = {
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
  async list(req: AuthRequest, res: Response) {
    try {
      const query: PurchaseOrderListQuery = {
        supplierId: req.query.supplierId as string,
        warehouseId: req.query.warehouseId as string,
        receivingStatus: req.query.receivingStatus as any,
        paymentStatus: req.query.paymentStatus as any,
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
  async getById(req: AuthRequest, res: Response) {
    try {
      const po = await poService.getPurchaseOrderById(req.params.id);
      res.json({ success: true, data: po });
    } catch (e: any) {
      res.status(404).json({ success: false, message: e.message });
    }
  }

  // ─── POST /api/purchase-orders/:id/receive ─────────────────────────────────
  async receive(req: AuthRequest, res: Response) {
    try {
      const createdBy = (req as any).user?.rawId ?? (req as any).user?.id;
      const dto: ReceivePurchaseOrderDTO = req.body;
      const user = (req as any).user;
      const result = await poService.receivePurchaseOrder(req.params.id, dto, createdBy, {
        role: user?.role ?? null,
        vendorId: user?.vendorId ?? null,
      });
      res.status(201).json({ success: true, message: 'Stock received', data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── POST /api/purchase-orders/:id/payments ───────────────────────────────
 async payDue(req: AuthRequest, res: Response) {
  try {
    if (!req.body.vendorPaymentAccountId) {
      res.status(400).json({ success: false, message: 'vendorPaymentAccountId is required.' });
      return;
    }
    const createdBy = (req as any).user?.rawId ?? (req as any).user?.id;
    const dto: PayPurchaseDueDTO = req.body;
    const result = await poService.payPurchaseDue(req.params.id, dto, createdBy);
    res.status(201).json({ success: true, message: 'Payment recorded', data: result });
  } catch (e: any) {
    res.status(400).json({ success: false, message: e.message });
  }
}

  // ─── POST /api/purchase-orders/:id/short-close ─────────────────────────────
  // NEW (Group A1/A2) — permanently write off remaining un-received quantity
  // on the specified line items (e.g. supplier can't fulfil the rest).
  async shortClose(req: AuthRequest, res: Response) {
    try {
      const user = (req as any).user;
      const createdBy = user?.rawId ?? user?.id;

      const dto: ShortClosePurchaseOrderDTO = {
        ...req.body,
        entityType: req.body.entityType ?? 'VENDOR',
        entityId:
          req.body.entityId ??
          (user?.role === 'VENDOR' ? user?.vendorId : undefined),
      };

      const result = await poService.shortClosePurchaseOrder(req.params.id, dto, createdBy);
      res.status(200).json({ success: true, message: 'Purchase order short-closed', data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── POST /api/purchase-orders/:id/cancel ──────────────────────────────────
  // NEW (Group B1/B2) — cancels everything still outstanding on the PO.
  async cancel(req: AuthRequest, res: Response) {
    try {
      const user = (req as any).user;
      const createdBy = user?.rawId ?? user?.id;

      const dto: CancelPurchaseOrderDTO = {
        ...req.body,
        entityType: req.body.entityType ?? 'VENDOR',
        entityId:
          req.body.entityId ??
          (user?.role === 'VENDOR' ? user?.vendorId : undefined),
      };

      const result = await poService.cancelPurchaseOrder(req.params.id, dto, createdBy);
      res.status(200).json({ success: true, message: 'Purchase order cancelled', data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── POST /api/purchase-orders/:id/returns ─────────────────────────────────
  // NEW (Group C1) — sends already-received stock back to the supplier.
  async returnItems(req: AuthRequest, res: Response) {
    try {
      const user = (req as any).user;
      const createdBy = user?.rawId ?? user?.id;

      const dto: ReturnPurchaseOrderDTO = {
        ...req.body,
        entityType: req.body.entityType ?? 'VENDOR',
        entityId:
          req.body.entityId ??
          (user?.role === 'VENDOR' ? user?.vendorId : undefined),
      };

      const result = await poService.returnPurchaseOrderItems(req.params.id, dto, createdBy);
      res.status(201).json({ success: true, message: 'Return recorded', data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── POST /api/purchase-orders/:id/refund-credit ───────────────────────────
  // NEW (Group D1) — cashes out PurchaseOrder.creditBalance (overpayment
  // discovered during short-close/cancel/return) back from the supplier.
  async refundCredit(req: AuthRequest, res: Response) {
    try {
      const user = (req as any).user;
      const createdBy = user?.rawId ?? user?.id;

      const dto: RefundPurchaseOrderCreditDTO = {
        ...req.body,
        entityType: req.body.entityType ?? 'VENDOR',
        entityId:
          req.body.entityId ??
          (user?.role === 'VENDOR' ? user?.vendorId : undefined),
      };

      const result = await poService.refundPurchaseOrderCredit(req.params.id, dto, createdBy);
      res.status(201).json({ success: true, message: 'Credit refund recorded', data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }
}