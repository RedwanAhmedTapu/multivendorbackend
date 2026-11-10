// tests/email-sms.service.test.ts — service rules with a controlled Prisma double.
// No database, no provider network call.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveDraft, createDraft, dryRun, getCampaign, listCampaigns, previewAudience, setStatus, updateDraft,
  CampaignError, type CampaignDb, type CampaignRow,
} from "../src/modules/marketing/email-sms/campaign.service.ts";

function makeDb(seed: Partial<CampaignRow>[] = []) {
  const rows: CampaignRow[] = seed.map((s, i) => ({
    id: s.id ?? `c${i + 1}`, name: s.name ?? `Campaign ${i + 1}`, channel: s.channel ?? "EMAIL",
    type: s.type ?? "PROMOTIONAL", status: s.status ?? "DRAFT", subjectSnapshot: s.subjectSnapshot ?? "Hi",
    bodySnapshot: s.bodySnapshot ?? "Body", audienceKind: s.audienceKind ?? "USER",
    scheduledAt: null, deletedAt: (s.deletedAt as any) ?? null, createdById: s.createdById ?? "u1",
    createdAt: new Date(2026, 0, 1 + i), updatedAt: new Date(2026, 0, 1 + i),
  }));
  const calls: { where?: any; skip?: number; take?: number } = {};
  const db: CampaignDb = {
    emailSmsCampaign: {
      create: async ({ data }) => { const r = { ...rows[0], ...data, id: `new${rows.length + 1}`, createdAt: new Date(), updatedAt: new Date() } as CampaignRow; rows.push(r); return r; },
      findMany: async (a) => { calls.where = a.where; calls.skip = a.skip; calls.take = a.take;
        return rows.filter((r) => (a.where?.deletedAt === null ? r.deletedAt === null : true))
                   .filter((r) => (a.where?.status ? r.status === a.where.status : true))
                   .filter((r) => (a.where?.channel ? r.channel === a.where.channel : true))
                   .filter((r) => (a.where?.name?.contains ? r.name.toLowerCase().includes(String(a.where.name.contains).toLowerCase()) : true))
                   .slice(a.skip ?? 0, (a.skip ?? 0) + (a.take ?? 100)); },
      count: async (a) => rows.filter((r) => (a.where?.deletedAt === null ? r.deletedAt === null : true))
                   .filter((r) => (a.where?.status ? r.status === a.where.status : true)).length,
      findFirst: async (a) => rows.find((r) => r.id === a.where.id && (a.where.deletedAt === null ? r.deletedAt === null : true)) ?? null,
      update: async (a) => { const r = rows.find((x) => x.id === a.where.id)!; Object.assign(r, a.data); return r; },
    },
    emailSmsCampaignRecipient: {
      count: async (a) => (a.where.suppressed === true ? 2 : 10),
      findMany: async () => [],
    },
  };
  return { db, rows, calls };
}

test("service: createDraft validates and persists a DRAFT", async () => {
  const { db, rows } = makeDb();
  const row = await createDraft(db, { name: "  Spring sale ", channel: "EMAIL", subject: "Hi", body: "Body" }, "admin1");
  assert.equal(row.status, "DRAFT");
  assert.equal(row.name, "Spring sale");
  assert.equal(row.createdById, "admin1");
  assert.equal(rows.length, 1, "persisted through the client, not held in a side map");
});

test("service: validation rejects malformed input", async () => {
  const { db } = makeDb();
  const cases: [any, string][] = [
    [{ name: "", channel: "EMAIL", subject: "s", body: "b" }, "NAME_REQUIRED"],
    [{ name: "x", channel: "EMAIL", subject: "", body: "b" }, "SUBJECT_REQUIRED"],
    [{ name: "x", channel: "SMS", subject: "s", body: "b" }, "SUBJECT_NOT_ALLOWED"],
    [{ name: "x", channel: "EMAIL", subject: "s", body: "" }, "BODY_REQUIRED"],
    [{ name: "x", channel: "SMS", body: "b", audienceKind: "CUSTOM" }, "AUDIENCE_NOT_SUPPORTED"],
    [{ name: "x", channel: "PIGEON", body: "b" } as any, "CHANNEL_INVALID"],
  ];
  for (const [input, code] of cases) {
    await assert.rejects(() => createDraft(db, input, null), (e: any) => e instanceof CampaignError && e.code === code, `expected ${code}`);
  }
});

test("service: list paginates, filters by status/channel and hides archived rows", async () => {
  const { db, calls } = makeDb([
    { name: "Alpha promo" }, { name: "Beta", status: "SCHEDULED" }, { name: "Alpha archived", deletedAt: new Date() as any },
    { name: "Gamma sms", channel: "SMS" },
  ]);
  const page1 = await listCampaigns(db, { page: 1, limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.pagination.total, 3, "archived row excluded from the total");
  assert.equal(calls.skip, 0); assert.equal(calls.take, 2);
  const page2 = await listCampaigns(db, { page: 2, limit: 2 });
  assert.equal(calls.skip, 2);
  assert.ok(page2.items.every((r) => r.deletedAt === null));
  const byStatus = await listCampaigns(db, { status: "SCHEDULED" });
  assert.deepEqual(byStatus.items.map((r) => r.name), ["Beta"]);
  const bySearch = await listCampaigns(db, { search: "gamma" });
  assert.deepEqual(bySearch.items.map((r) => r.name), ["Gamma sms"]);
});

test("service: get returns 404 for missing or archived", async () => {
  const { db } = makeDb([{ id: "a" }, { id: "b", deletedAt: new Date() as any }]);
  assert.equal((await getCampaign(db, "a")).id, "a");
  await assert.rejects(() => getCampaign(db, "zzz"), (e: any) => e.status === 404 && e.code === "NOT_FOUND");
  await assert.rejects(() => getCampaign(db, "b"), (e: any) => e.code === "NOT_FOUND", "archived is not readable");
});

test("service: only drafts are editable or archivable", async () => {
  const { db } = makeDb([{ id: "d" }, { id: "s", status: "SENT" as any }, { id: "x", status: "SCHEDULED" }]);
  const updated = await updateDraft(db, "d", { name: "Renamed" });
  assert.equal(updated.name, "Renamed");
  await assert.rejects(() => updateDraft(db, "x", { name: "n" }), (e: any) => e.code === "NOT_EDITABLE");
  await assert.rejects(() => archiveDraft(db, "x"), (e: any) => e.code === "NOT_ARCHIVABLE");
  const archived = await archiveDraft(db, "d");
  assert.ok(archived.deletedAt instanceof Date, "archive is a soft delete");
  await assert.rejects(() => getCampaign(db, "d"), (e: any) => e.code === "NOT_FOUND");
});

test("service: audience preview and dry run never contact a provider", async () => {
  const { db } = makeDb([{ id: "p", status: "SCHEDULED", bodySnapshot: "hello world" }]);
  const audience = await previewAudience(db, "p");
  assert.deepEqual({ r: audience.recipients, s: audience.suppressed, e: audience.eligible }, { r: 10, s: 2, e: 8 });
  const dry = await dryRun(db, "p");
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldSendTo, 8);
  assert.equal(dry.bodyLength, "hello world".length);
  assert.match(dry.note, /No provider is contacted/);
});

test("service: illegal status transitions throw before touching the row", async () => {
  const { db, rows } = makeDb([{ id: "z", status: "DRAFT" }]);
  await assert.rejects(() => setStatus(db, "z", "SUBMITTED" as any), /Illegal campaign transition/);
  assert.equal(rows[0].status, "DRAFT", "row unchanged after refusal");
  const ok = await setStatus(db, "z", "SCHEDULED");
  assert.equal(ok.status, "SCHEDULED");
});