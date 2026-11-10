import type{ Request, Response } from "express";
import { AutoReplyService } from "../services/auto-reply.service.ts";
import { CreateAutoReplySchema, UpdateAutoReplySchema } from "../dto/auto-reply.dto.ts";

const service = new AutoReplyService();

// Phase 0: the vendor id comes only from the authenticated VENDOR (route guard);
// the body is the validated whitelist; another vendor's (or a global) rule
// answers 404.
const vendorOf = (req: Request): string | null => ((req as any).user?.vendorId as string | undefined) ?? null;

export async function create(req: Request, res: Response) {
  try {
    const vendorId = vendorOf(req);
    if (!vendorId) return res.status(403).json({ error: "Forbidden" });
    const data = CreateAutoReplySchema.parse(req.body);
    const result = await service.create(data, vendorId);
    res.status(201).json({ success: true, data: result });
  } catch (error: any) { res.status(400).json({ error: error.errors?.[0]?.message ?? error.message }); }
}

export async function update(req: Request, res: Response) {
  try {
    const vendorId = vendorOf(req);
    if (!vendorId) return res.status(403).json({ error: "Forbidden" });
    const data = UpdateAutoReplySchema.parse(req.body);
    const result = await service.update(req.params.id, data, vendorId);
    if (!result) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, data: result });
  } catch (error: any) { res.status(400).json({ error: error.errors?.[0]?.message ?? error.message }); }
}

export async function remove(req: Request, res: Response) {
  try {
    const vendorId = vendorOf(req);
    if (!vendorId) return res.status(403).json({ error: "Forbidden" });
    const result = await service.delete(req.params.id, vendorId);
    if (!result) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (error: any) { res.status(400).json({ error: error.message }); }
}

// Chat settings: the authenticated vendor's own rules, active and inactive.
export async function listMine(req: Request, res: Response) {
  try {
    const vendorId = vendorOf(req);
    if (!vendorId) return res.status(403).json({ error: "Forbidden" });
    const data = await service.listOwn(vendorId);
    res.json({ success: true, data });
  } catch (error: any) {
    console.error("[auto-reply] list failed:", error?.code ?? error?.name ?? "error");
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getList(req: Request, res: Response) {
  try {
    const data = await service.getRules(req.user?.vendorId);
    res.json({ success: true, data });
  } catch (error: any) { res.status(500).json({ error: error.message }); }
}