// src/modules/agent/services/agent-training.service.ts
//
// Phase 9 — Training Center. Admins create, edit, publish and delete
// resources (audited as TRAINING); agents read published ones only.

import { z } from "zod";
import { agentDb, agentTransaction } from "../agent-db.ts";
import { AgentError, notFound } from "../agent-http.ts";
import { writeConfigAudit, type AdminActor } from "./agent-audit.service.ts";
import { pageQuery } from "../validators/agent-primitives.ts";

const httpUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), { error: "Enter a full http(s) link" });
const optionalUrl = z.union([httpUrl, z.literal("").transform(() => null), z.null()]).optional();

export const trainingCreateSchema = z
  .object({
    category: z.string().trim().min(2, { error: "Category is required" }).max(60),
    title: z.string().trim().min(3, { error: "Title is required" }).max(160),
    summary: z.string().trim().max(500).nullable().optional(),
    body: z.string().max(20000).nullable().optional(),
    url: optionalUrl,
    coverImage: optionalUrl,
    isFeatured: z.boolean().optional(),
    isPublished: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !!(v.body && v.body.trim()) || !!v.url, { error: "Add either content or a link", path: ["body"] });

export const trainingUpdateSchema = z
  .object({
    category: z.string().trim().min(2).max(60).optional(),
    title: z.string().trim().min(3).max(160).optional(),
    summary: z.string().trim().max(500).nullable().optional(),
    body: z.string().max(20000).nullable().optional(),
    url: optionalUrl,
    coverImage: optionalUrl,
    isFeatured: z.boolean().optional(),
    isPublished: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: "Nothing to update" });

export const trainingListQuery = z.object({
  ...pageQuery,
  category: z.string().trim().max(60).optional(),
  q: z.string().trim().max(100).optional(),
});

const SELECT = { id: true, category: true, title: true, summary: true, body: true, url: true, coverImage: true, isFeatured: true, isPublished: true, createdAt: true, updatedAt: true } as const;

function listWhere(q: { category?: string; q?: string }, publishedOnly: boolean) {
  const where: any = {};
  if (publishedOnly) where.isPublished = true;
  if (q.category) where.category = q.category;
  if (q.q) where.OR = [{ title: { contains: q.q, mode: "insensitive" } }, { summary: { contains: q.q, mode: "insensitive" } }];
  return where;
}

async function list(q: z.infer<typeof trainingListQuery>, publishedOnly: boolean) {
  const db = agentDb.prisma as any;
  const where = listWhere(q, publishedOnly);
  const [items, total, cats] = await Promise.all([
    db.agentTrainingResource.findMany({
      where,
      orderBy: [{ isFeatured: "desc" }, { createdAt: "desc" }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      select: publishedOnly ? { ...SELECT, body: false } : SELECT,
    }),
    db.agentTrainingResource.count({ where }),
    db.agentTrainingResource.groupBy({ by: ["category"], where: publishedOnly ? { isPublished: true } : {}, _count: { _all: true } }),
  ]);
  return { items, total, page: q.page, limit: q.limit, categories: cats.map((c: any) => ({ category: c.category, count: c._count._all })) };
}

export const listPublishedTraining = (q: z.infer<typeof trainingListQuery>) => list(q, true);
export const adminListTraining = (q: z.infer<typeof trainingListQuery>) => list(q, false);

export async function getPublishedTraining(id: string) {
  const row = await (agentDb.prisma as any).agentTrainingResource.findFirst({ where: { id, isPublished: true }, select: SELECT });
  if (!row) throw notFound("Training resource");
  return row;
}

export async function createTraining(input: unknown, actor: AdminActor) {
  const data = trainingCreateSchema.parse(input);
  return agentTransaction(async (tx: any) => {
    const row = await tx.agentTrainingResource.create({
      data: { ...data, summary: data.summary ?? null, body: data.body ?? null, url: data.url ?? null, coverImage: data.coverImage ?? null, createdById: actor.userId },
      select: SELECT,
    });
    await writeConfigAudit(tx, { entity: "TRAINING", entityId: row.id, action: "CREATE", newValue: { ...row, body: row.body ? `${row.body.length} chars` : null }, actor });
    return row;
  });
}

export async function updateTraining(id: string, input: unknown, actor: AdminActor) {
  const data = trainingUpdateSchema.parse(input);
  return agentTransaction(async (tx: any) => {
    const before = await tx.agentTrainingResource.findUnique({ where: { id }, select: SELECT });
    if (!before) throw notFound("Training resource");
    const nextBody = data.body !== undefined ? data.body : before.body;
    const nextUrl = data.url !== undefined ? data.url : before.url;
    if (!(nextBody && nextBody.trim()) && !nextUrl) {
      throw new AgentError("Validation failed", 400, "VALIDATION_ERROR", { errors: { body: "Add either content or a link" } });
    }
    const row = await tx.agentTrainingResource.update({ where: { id }, data, select: SELECT });
    const brief = (r: any) => ({ ...r, body: r.body ? `${r.body.length} chars` : null });
    await writeConfigAudit(tx, { entity: "TRAINING", entityId: id, action: "UPDATE", oldValue: brief(before), newValue: brief(row), actor });
    return row;
  });
}

export async function deleteTraining(id: string, actor: AdminActor) {
  return agentTransaction(async (tx: any) => {
    const before = await tx.agentTrainingResource.findUnique({ where: { id }, select: SELECT });
    if (!before) throw notFound("Training resource");
    await tx.agentTrainingResource.delete({ where: { id } });
    await writeConfigAudit(tx, { entity: "TRAINING", entityId: id, action: "DELETE", oldValue: { ...before, body: before.body ? `${before.body.length} chars` : null }, actor });
    return { id, deleted: true };
  });
}
