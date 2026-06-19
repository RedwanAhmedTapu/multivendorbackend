import type { Request, Response } from 'express';
import { OrderChargeService } from '../services/orderCharge.service.ts';
import type { CreateChargeInput, UpdateChargeInput } from '../services/orderCharge.service.ts';

const svc = new OrderChargeService();

const ok = (res: Response, data: unknown, status = 200) =>
  res.status(status).json({ success: true, data });

const fail = (res: Response, error: unknown, status = 400) =>
  res.status(status).json({
    success: false,
    message: error instanceof Error ? error.message : 'Unknown error',
  });

export class OrderChargeController {

  /** POST /order-charges  (admin) */
  async createCharge(req: Request, res: Response) {
    try {
      const input: CreateChargeInput = req.body;
      const data = await svc.createCharge(input);
      ok(res, data, 201);
    } catch (e) { fail(res, e); }
  }

  /** GET /order-charges  (admin) */
  async listCharges(req: Request, res: Response) {
    try {
      const data = await svc.listCharges();
      ok(res, data);
    } catch (e) { fail(res, e, 500); }
  }

  /** GET /order-charges/:id  (admin) */
  async getCharge(req: Request, res: Response) {
    try {
      const data = await svc.getChargeById(req.params.id);
      if (!data) return fail(res, new Error('Charge not found'), 404);
      ok(res, data);
    } catch (e) { fail(res, e, 500); }
  }

  /** PATCH /order-charges/:id  (admin) */
  async updateCharge(req: Request, res: Response) {
    try {
      const input: UpdateChargeInput = req.body;
      const data = await svc.updateCharge(req.params.id, input);
      ok(res, data);
    } catch (e) { fail(res, e); }
  }

  /** DELETE /order-charges/:id  (admin) */
  async deleteCharge(req: Request, res: Response) {
    try {
      await svc.deleteCharge(req.params.id);
      ok(res, { message: 'Charge deleted' });
    } catch (e) { fail(res, e); }
  }

  /** PATCH /order-charges/:id/toggle  (admin) body: { isActive: boolean } */
  async toggleCharge(req: Request, res: Response) {
    try {
      const { isActive } = req.body as { isActive: boolean };
      const data = await svc.toggleCharge(req.params.id, isActive);
      ok(res, data);
    } catch (e) { fail(res, e); }
  }

  /** GET /order-charges/summary?subtotal=786&paymentMethod=COD  (public/checkout) */
  async getOrderSummary(req: Request, res: Response) {
    try {
      const subtotal = Number(req.query.subtotal);
      const paymentMethod = (req.query.paymentMethod as string) === 'PREPAID' ? 'PREPAID' : 'COD';
      if (isNaN(subtotal)) return fail(res, new Error('subtotal must be a number'));
      const data = await svc.computeOrderSummary(subtotal, paymentMethod);
      ok(res, data);
    } catch (e) { fail(res, e); }
  }
}