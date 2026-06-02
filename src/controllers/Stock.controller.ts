import type { Request, Response } from 'express';
import * as stockService from '../services/stock.service.ts';
import type {
  StockListQuery,
  StockAdjustDTO,
  StockDamageDTO,
  StockTransferDTO,
  StockSellDamageDTO,
} from '../types/erp.types.ts';

export class StockController {
  // ─── GET /api/stock ────────────────────────────────────────────────────────
  async list(req: Request, res: Response) {
    try {
      const query: StockListQuery = {
        warehouseId: req.query.warehouseId as string | undefined,
        categoryId: req.query.categoryId as string | undefined,
        status: req.query.status as StockListQuery['status'],
        q: req.query.q as string | undefined,
        page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 10,
      };
      const result = await stockService.listStockInventory(query);
      res.json({ success: true, ...result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── GET /api/stock/stats ──────────────────────────────────────────────────
  async stats(_req: Request, res: Response) {
    try {
      const result = await stockService.getStockStats();
      res.json({ success: true, data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── GET /api/stock/:variantId ─────────────────────────────────────────────
  async getVariant(req: Request, res: Response) {
    try {
      const result = await stockService.getVariantStockDetail(req.params.variantId);
      res.json({ success: true, data: result });
    } catch (e: any) {
      res.status(404).json({ success: false, message: e.message });
    }
  }

  // ─── POST /api/stock/adjust ────────────────────────────────────────────────
  async adjust(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.id;
      const dto: StockAdjustDTO = req.body;
      const result = await stockService.stockAdjust(dto, createdBy);
      res.status(201).json({ success: true, message: 'Stock adjusted', data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── POST /api/stock/damage ────────────────────────────────────────────────
  async damage(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.id;
      const dto: StockDamageDTO = req.body;
      const result = await stockService.stockDamage(dto, createdBy);
      res.status(201).json({ success: true, message: 'Stock marked as damaged', data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── POST /api/stock/transfer ──────────────────────────────────────────────
  async transfer(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.id;
      const dto: StockTransferDTO = req.body;
      const result = await stockService.stockTransfer(dto, createdBy);
      res.status(201).json({ success: true, message: 'Stock transferred', data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── POST /api/stock/sell-damage ───────────────────────────────────────────
  async sellDamage(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.id;
      const dto: StockSellDamageDTO = req.body;
      const result = await stockService.sellDamageStock(dto, createdBy);
      res.status(201).json({ success: true, message: 'Damaged stock sold', data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }
}