import type{ Request, Response } from "express";
import { z } from "zod";
import { QuickReplyService } from "../services/quick-reply.service.ts";
import { CreateQuickReplySchema, UpdateQuickReplySchema } from "../dto/quick-reply.dto.ts";

const service = new QuickReplyService();

// Phase 3: the vendor id comes only from the authenticated user (resolved from
// the database by authenticateUser), never from the request. Another vendor's
// row, a platform row and a missing id all answer the same 404. Validation
// errors are 400; anything else is a generic 500 (no internal detail).
const vendorOf = (req: Request): string | null => ((req as any).user?.vendorId as string | undefined) || null;
const NOT_FOUND = { error: "Quick reply not found" };

function fail(res: Response, error: unknown) {
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? "Invalid request" });
  console.error("[quick-reply] request failed:", (error as any)?.code ?? (error as any)?.name ?? "error");
  return res.status(500).json({ error: "Internal server error" });
}

export async function create(req: Request, res: Response) {
  try {
    const vendorId = vendorOf(req);
    if (!vendorId) return res.status(403).json({ error: "Forbidden" });
    const data = CreateQuickReplySchema.parse(req.body);
    const result = await service.create(data, vendorId);
    res.status(201).json({ success: true, data: result });
  } catch (error) { fail(res, error); }
}

export async function update(req: Request, res: Response) {
  try {
    const vendorId = vendorOf(req);
    if (!vendorId) return res.status(403).json({ error: "Forbidden" });
    const data = UpdateQuickReplySchema.parse(req.body);
    const result = await service.update(req.params.id, data, vendorId);
    if (!result) return res.status(404).json(NOT_FOUND);
    res.json({ success: true, data: result });
  } catch (error) { fail(res, error); }
}

export async function remove(req: Request, res: Response) {
  try {
    const vendorId = vendorOf(req);
    if (!vendorId) return res.status(403).json({ error: "Forbidden" });
    const result = await service.delete(req.params.id, vendorId);
    if (!result) return res.status(404).json(NOT_FOUND);
    res.json({ success: true });
  } catch (error) { fail(res, error); }
}

// Chat settings: the authenticated vendor's own quick replies, active and inactive.
export async function listMine(req: Request, res: Response) {
  try {
    const vendorId = vendorOf(req);
    if (!vendorId) return res.status(403).json({ error: "Forbidden" });
    const data = await service.listOwn(vendorId);
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
}

export async function getSuggestions(req: Request, res: Response) {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    // no vendor scope (customer, admin-side staff) → platform quick replies only
    const data = await service.getSuggestions(q, vendorOf(req));
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
}
