// modules/marketing/email-sms/campaign.service.ts
//
// Database-backed campaign service. Persistence is real Prisma (the 8 generated
// emailSms* delegates); the provider is NOT touched anywhere in this file — the
// only execution path here is a dry run, which cannot send.
//
// The db handle is injected so the same code runs against the real client in the
// app and against a controlled double in tests. No in-memory persistence is used
// as a substitute for CRUD.

import type { CampaignStatus } from "./campaign.state.ts";
import { assertCampaignTransition } from "./campaign.state.ts";

export type CampaignRow = {
  id: string;
  name: string;
  channel: "EMAIL" | "SMS";
  type: string;
  status: CampaignStatus;
  subjectSnapshot: string | null;
  bodySnapshot: string;
  audienceKind: "USER" | "SEGMENT" | "CUSTOM";
  scheduledAt: Date | null;
  deletedAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CampaignDb = {
  emailSmsCampaign: {
    create: (args: any) => Promise<CampaignRow>;
    findMany: (args: any) => Promise<CampaignRow[]>;
    count: (args: any) => Promise<number>;
    findFirst: (args: any) => Promise<CampaignRow | null>;
    update: (args: any) => Promise<CampaignRow>;
  };
  emailSmsCampaignRecipient: {
    count: (args: any) => Promise<number>;
    findMany: (args: any) => Promise<{ addressHash: string; suppressed: boolean }[]>;
  };
};

export class CampaignError extends Error {
  // Explicit fields, not parameter properties: the backend runs as ESM
  // ("type": "module") and Node 24 loads .ts through its native strip-only
  // loader, which rejects parameter properties at parse time.
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "CampaignError";
    this.code = code;
    this.status = status;
  }
}

const MAX_NAME = 120;
const MAX_BODY = 100_000;

export type CreateDraftInput = {
  name: string;
  channel: "EMAIL" | "SMS";
  type?: "WELCOME" | "PROMOTIONAL" | "TRANSACTIONAL" | "REMINDER";
  subject?: string | null;
  body: string;
  audienceKind?: "USER" | "SEGMENT" | "CUSTOM";
  idempotencyKey?: string;
};

function validateDraft(input: CreateDraftInput): CreateDraftInput {
  const name = String(input.name ?? "").trim();
  if (!name) throw new CampaignError("NAME_REQUIRED", "Campaign name is required");
  if (name.length > MAX_NAME) throw new CampaignError("NAME_TOO_LONG", `Name must be at most ${MAX_NAME} characters`);
  const body = String(input.body ?? "").trim();
  if (!body) throw new CampaignError("BODY_REQUIRED", "Message body is required");
  if (body.length > MAX_BODY) throw new CampaignError("BODY_TOO_LONG", "Message body is too long");
  if (input.channel !== "EMAIL" && input.channel !== "SMS") throw new CampaignError("CHANNEL_INVALID", "Channel must be EMAIL or SMS");
  const subject = input.subject == null ? null : String(input.subject).trim() || null;
  if (input.channel === "EMAIL" && !subject) throw new CampaignError("SUBJECT_REQUIRED", "Email campaigns require a subject");
  if (input.channel === "SMS" && subject) throw new CampaignError("SUBJECT_NOT_ALLOWED", "SMS campaigns do not use a subject");
  // Custom uploads stay disabled in v1.
  if (input.audienceKind === "CUSTOM") throw new CampaignError("AUDIENCE_NOT_SUPPORTED", "Custom recipient uploads are not enabled");
  return { ...input, name, body, subject };
}

export async function createDraft(db: CampaignDb, input: CreateDraftInput, actorId: string | null): Promise<CampaignRow> {
  const v = validateDraft(input);
  return db.emailSmsCampaign.create({
    data: {
      name: v.name,
      channel: v.channel,
      type: v.type ?? "PROMOTIONAL",
      status: "DRAFT",
      subjectSnapshot: v.subject,
      bodySnapshot: v.body,
      audienceKind: v.audienceKind ?? "USER",
      idempotencyKey: v.idempotencyKey ?? `draft:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      createdById: actorId ?? null,
    },
  });
}

export type ListQuery = { page?: number; limit?: number; status?: CampaignStatus | "ALL"; search?: string; channel?: "EMAIL" | "SMS" | "ALL" };

export async function listCampaigns(db: CampaignDb, q: ListQuery = {}) {
  const page = Math.max(1, Math.floor(Number(q.page ?? 1)) || 1);
  const limit = Math.min(100, Math.max(1, Math.floor(Number(q.limit ?? 20)) || 20));
  const where: Record<string, unknown> = { deletedAt: null };
  if (q.status && q.status !== "ALL") where.status = q.status;
  if (q.channel && q.channel !== "ALL") where.channel = q.channel;
  const search = (q.search ?? "").trim();
  if (search) where.name = { contains: search, mode: "insensitive" };
  const [items, total] = await Promise.all([
    db.emailSmsCampaign.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    db.emailSmsCampaign.count({ where }),
  ]);
  return { items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

export async function getCampaign(db: CampaignDb, id: string): Promise<CampaignRow> {
  const row = await db.emailSmsCampaign.findFirst({ where: { id: String(id ?? ""), deletedAt: null } });
  if (!row) throw new CampaignError("NOT_FOUND", "Campaign not found", 404);
  return row;
}

export async function updateDraft(db: CampaignDb, id: string, patch: Partial<CreateDraftInput>): Promise<CampaignRow> {
  const row = await getCampaign(db, id);
  if (row.status !== "DRAFT") throw new CampaignError("NOT_EDITABLE", "Only drafts can be edited", 409);
  const next = validateDraft({
    name: patch.name ?? row.name,
    channel: patch.channel ?? row.channel,
    subject: patch.subject !== undefined ? patch.subject : row.subjectSnapshot,
    body: patch.body ?? row.bodySnapshot,
    type: (patch.type as any) ?? (row.type as any),
    audienceKind: patch.audienceKind ?? row.audienceKind,
  });
  return db.emailSmsCampaign.update({
    where: { id: row.id },
    data: { name: next.name, channel: next.channel, subjectSnapshot: next.subject, bodySnapshot: next.body },
  });
}

/** Soft delete only: recipients/sends must never be cascaded away by an archive. */
export async function archiveDraft(db: CampaignDb, id: string): Promise<CampaignRow> {
  const row = await getCampaign(db, id);
  if (row.status !== "DRAFT") throw new CampaignError("NOT_ARCHIVABLE", "Only drafts can be archived", 409);
  return db.emailSmsCampaign.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
}

/** Audience preview: counts real rows, sends nothing. */
export async function previewAudience(db: CampaignDb, id: string) {
  const row = await getCampaign(db, id);
  const campaignId = row.id;
  const [recipients, suppressed] = await Promise.all([
    db.emailSmsCampaignRecipient.count({ where: { campaignId } }),
    db.emailSmsCampaignRecipient.count({ where: { campaignId, suppressed: true } }),
  ]);
  return { campaignId, channel: row.channel, recipients, suppressed, eligible: recipients - suppressed };
}

/**
 * Dry run: returns what WOULD be sent and to how many eligible recipients.
 * No provider import, no network call — the only execution path wired up today.
 */
export async function dryRun(db: CampaignDb, id: string) {
  const row = await getCampaign(db, id);
  const audience = await previewAudience(db, id);
  return {
    dryRun: true,
    campaignId: row.id,
    channel: row.channel,
    subject: row.subjectSnapshot,
    bodyLength: row.bodySnapshot.length,
    wouldSendTo: audience.eligible,
    skippedSuppressed: audience.suppressed,
    note: "No provider is contacted in dry-run mode.",
  };
}

/** Guarded status change used by schedule/cancel/launch (kept tiny on purpose). */
export async function setStatus(db: CampaignDb, id: string, to: CampaignStatus): Promise<CampaignRow> {
  const row = await getCampaign(db, id);
  assertCampaignTransition(row.status, to);
  return db.emailSmsCampaign.update({ where: { id: row.id }, data: { status: to } });
}
