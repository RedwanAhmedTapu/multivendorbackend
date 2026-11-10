import type { Request, Response } from "express";
import { participantTypeForRole } from "../utils/participant-resolver.ts";
import { NotificationService } from "../services/notification.service.ts";
import { UpdateNotificationSettingsSchema } from "../dto/notification-settings.dto.ts";
import { ParticipantType } from "@prisma/client";

const service = new NotificationService();

// Same mapping used in conversation.controller.ts — kept local here rather
// than centralizing in the middleware, per your call.
function getParticipantType(role?: string): ParticipantType {
  return participantTypeForRole(role); // unknown → CUSTOMER (historical)
}

export async function getSettings(req: Request, res: Response) {
  try {
    // FIX: req.user!.type never existed (middleware only sets .role), so
    // this was always calling getSettings(id, undefined) — which is what
    // produced the "Argument ownerType is missing" Prisma error. Map the
    // existing role string the same way conversation.controller.ts does.
    const ownerType = getParticipantType(req.user?.role);
    const data = await service.getSettings(req.user!.id, ownerType);
    res.json({ success: true, data });
  } catch (error: any) { res.status(500).json({ error: error.message }); }
}

export async function updateSettings(req: Request, res: Response) {
  try {
    const data = UpdateNotificationSettingsSchema.parse(req.body);
    const ownerType = getParticipantType(req.user?.role);
    const result = await service.updateSettings(req.user!.id, ownerType, data);
    res.json({ success: true, data: result });
  } catch (error: any) { res.status(400).json({ error: error.errors?.[0]?.message || error.message }); }
}