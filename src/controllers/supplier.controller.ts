import type { Request, Response } from 'express';
import * as supplierService from '../services/supplier.service.ts';
import type { SupplierListQuery } from '../types/erp.types.ts';

export class SupplierController {
  // ─── POST /api/suppliers ───────────────────────────────────────────────────
  async create(req: Request, res: Response) {
    try {
      const supplier = await supplierService.createSupplier(req.body);
      res.status(201).json({ success: true, message: 'Supplier created successfully', data: supplier });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── PUT /api/suppliers/:id ────────────────────────────────────────────────
  async update(req: Request, res: Response) {
    try {
      const supplier = await supplierService.updateSupplier(req.params.id, req.body);
      res.json({ success: true, message: 'Supplier updated', data: supplier });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── PATCH /api/suppliers/:id/status ──────────────────────────────────────
  async toggleStatus(req: Request, res: Response) {
    try {
      const result = await supplierService.toggleSupplierStatus(req.params.id);
      res.json({ success: true, message: `Supplier is now ${result.status}`, data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── GET /api/suppliers/:id ────────────────────────────────────────────────
  async getById(req: Request, res: Response) {
    try {
      const supplier = await supplierService.getSupplierById(req.params.id);
      res.json({ success: true, data: supplier });
    } catch (e: any) {
      res.status(404).json({ success: false, message: e.message });
    }
  }

  // ─── GET /api/suppliers ────────────────────────────────────────────────────
  async list(req: Request, res: Response) {
    try {
      const query: SupplierListQuery = {
        search: req.query.search as string,
        status: req.query.status as any,
        supplierType: req.query.supplierType as any,
        entityType: (req.query.entityType as any) ?? 'ADMIN',
        entityId: req.query.entityId as string,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
      };
      const result = await supplierService.listSuppliers(query);
      res.json({ success: true, ...result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ─── GET /api/suppliers/:id/dues ──────────────────────────────────────────
  async getDues(req: Request, res: Response) {
    try {
      const result = await supplierService.getSupplierDues(req.params.id);
      res.json({ success: true, data: result });
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message });
    }
  }
}