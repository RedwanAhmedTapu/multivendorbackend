// tests/agent-admin.test.ts
//
// Admin agent management: status transitions (guarded, audited, sessions
// revoked on suspend/deactivate), vendor links (one open link per vendor,
// explicit transfer, history kept, audited), admin-created agents.
//
//   npx tsx --test tests/agent-admin.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.AGENT_ACCESS_TOKEN_SECRET = "test-only-agent-access-secret-0123456789abcdef";

const admin = await import("../src/modules/agent/services/agent-admin.service.ts");
const { agentMailer } = await import("../src/modules/agent/services/agent-mailer.ts");
const { resetAgentAuthConfig } = await import("../src/modules/agent/agent.config.ts");
const { installAgentFakeDb } = await import("./support/agent-fake-db.ts");

const actor = { userId: "U_ADMIN", name: "Admin", ip: "10.0.0.1", userAgent: "ua" };
let fake: ReturnType<typeof installAgentFakeDb>;
let mails: string[] = [];

beforeEach(async () => {
  resetAgentAuthConfig();
  fake = installAgentFakeDb();
  mails = [];
  agentMailer.send = async (to, data) => {
    mails.push(`${to}:${data.title}`);
  };
  for (const [id, status] of [["A1", "PENDING"], ["A2", "ACTIVE"]] as const) {
    await fake.db.agent.create({ data: { id, agentCode: `AG-${id}`, referralCode: `R-${id}`, name: `Agent ${id}`, email: `${id.toLowerCase()}@x.com`, passwordHash: "x", status, statusReason: null } });
  }
  await fake.db.agentSession.create({ data: { id: "S2", agentId: "A2", refreshTokenHash: "h", expiresAt: new Date(Date.now() + 3600_000) } });
  await fake.db.vendor.create({ data: { id: "V1", storeName: "Shop One" } });
  // getAgentForAdmin reads relations the fake doesn't model; keep it simple
  fake.db.agentVendorLink.findMany = async () => [];
});
afterEach(() => fake.restore());

test("approve: PENDING → ACTIVE, audited with the admin, approval email sent", async () => {
  await admin.changeAgentStatus("A1", "approve", undefined, actor);
  const a1 = fake.db.agent.rows.find((a: any) => a.id === "A1");
  assert.equal(a1.status, "ACTIVE");
  assert.equal(a1.approvedById, "U_ADMIN");
  const audit = fake.db.agentConfigAudit.rows.at(-1);
  assert.deepEqual([audit.entity, audit.entityId, audit.action, audit.actorUserId], ["AGENT", "A1", "STATUS", "U_ADMIN"]);
  assert.deepEqual(audit.oldValue, { status: "PENDING", statusReason: null });
  assert.equal(audit.newValue.status, "ACTIVE");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(mails.some((m) => m.startsWith("a1@x.com")));
});

test("invalid transitions are refused with 409 and write nothing", async () => {
  await assert.rejects(admin.changeAgentStatus("A2", "approve", undefined, actor), (e: any) => e.code === "STATUS_TRANSITION_NOT_ALLOWED");
  await assert.rejects(admin.changeAgentStatus("A1", "suspend", "x".repeat(5), actor), (e: any) => e.code === "STATUS_TRANSITION_NOT_ALLOWED");
  await assert.rejects(admin.changeAgentStatus("A2", "reactivate", undefined, actor), (e: any) => e.statusCode === 409);
  assert.equal(fake.db.agentConfigAudit.rows.length, 0);
});

test("suspend revokes every session and bumps tokenVersion; reactivate clears the reason", async () => {
  await admin.changeAgentStatus("A2", "suspend", "Fraud review", actor);
  const a2 = fake.db.agent.rows.find((a: any) => a.id === "A2");
  assert.equal(a2.status, "SUSPENDED");
  assert.equal(a2.statusReason, "Fraud review");
  assert.equal(a2.tokenVersion, 1);
  assert.ok(fake.db.agentSession.rows.every((s: any) => s.revokedAt));
  await admin.changeAgentStatus("A2", "reactivate", undefined, actor);
  assert.equal(a2.status, "ACTIVE");
  assert.equal(a2.statusReason, null);
});

test("a concurrent status change loses the guarded write (409)", async () => {
  const realUpdateMany = fake.db.agent.updateMany;
  fake.db.agent.updateMany = async (args: any) => {
    // someone else changed the status between our read and our write
    fake.db.agent.rows.find((a: any) => a.id === "A1").status = "DEACTIVATED";
    return realUpdateMany(args);
  };
  await assert.rejects(admin.changeAgentStatus("A1", "approve", undefined, actor), (e: any) => e.code === "STATUS_CHANGED");
});

test("vendor links: only to active agents; one open link per vendor; transfer must be explicit; all audited", async () => {
  await assert.rejects(admin.assignVendorToAgent("A1", { vendorId: "V1", transfer: false }, actor), (e: any) => e.code === "AGENT_NOT_ACTIVE");
  await assert.rejects(admin.assignVendorToAgent("A2", { vendorId: "NOPE", transfer: false }, actor), (e: any) => e.statusCode === 404);
  const first = await admin.assignVendorToAgent("A2", { vendorId: "V1", note: "signed up at fair", transfer: false }, actor);
  assert.equal(first.source, "ADMIN_ASSIGNED");
  await assert.rejects(admin.assignVendorToAgent("A2", { vendorId: "V1", transfer: false }, actor), (e: any) => e.code === "ALREADY_LINKED");

  await admin.changeAgentStatus("A1", "approve", undefined, actor);
  fake.db.agentVendorLink.findFirst = async ({ where }: any) => {
    const row = fake.db.agentVendorLink.rows.find((l: any) => l.vendorId === where.vendorId && l.endedAt === null);
    return row ? { ...row, agent: { name: "Agent A2" } } : null;
  };
  await assert.rejects(
    admin.assignVendorToAgent("A1", { vendorId: "V1", transfer: false }, actor),
    (e: any) => e.code === "VENDOR_LINKED_ELSEWHERE" && e.details.currentAgentId === "A2",
  );
  await admin.assignVendorToAgent("A1", { vendorId: "V1", transfer: true }, actor);
  const links = fake.db.agentVendorLink.rows;
  assert.equal(links.length, 2, "history kept");
  assert.equal(links.filter((l: any) => l.endedAt === null).length, 1, "exactly one open link");
  assert.equal(links.find((l: any) => l.endedAt === null).agentId, "A1");
  const linkAudits = fake.db.agentConfigAudit.rows.filter((a: any) => a.entity === "VENDOR_LINK").map((a: any) => a.action);
  assert.deepEqual(linkAudits, ["CREATE", "DEACTIVATE", "CREATE"]);
});

test("ending a link is audited and can't be repeated", async () => {
  const link = await admin.assignVendorToAgent("A2", { vendorId: "V1", transfer: false }, actor);
  await admin.endVendorLink(link.id, "vendor left", actor);
  await assert.rejects(admin.endVendorLink(link.id, undefined, actor), (e: any) => e.code === "LINK_ENDED");
});

test("admin-created agent: ACTIVE, audited in the same transaction, invite email sent", async () => {
  fake.db.agent.findUnique = (orig => async (args: any) => {
    if (args.select?.statusReason) return { ...(await orig(args)), level: null };
    return orig(args);
  })(fake.db.agent.findUnique);
  const { agent, inviteEmailSent } = await admin.createAgent({ name: "Karim", email: "karim@x.com", phone: "01712345678" }, actor);
  assert.equal(agent.status, "ACTIVE");
  assert.equal(inviteEmailSent, true);
  assert.ok(mails.some((m) => m.startsWith("karim@x.com")));
  const audit = fake.db.agentConfigAudit.rows.find((a: any) => a.entity === "AGENT" && a.action === "CREATE");
  assert.equal(audit.entityId, agent.id);
  assert.equal(audit.actorUserId, "U_ADMIN");
});

test("invite email failure does not lose the agent", async () => {
  agentMailer.send = async () => {
    throw new Error("smtp down");
  };
  const { agent, inviteEmailSent } = await admin.createAgent({ name: "Rina", email: "rina@x.com" }, actor);
  assert.equal(inviteEmailSent, false);
  assert.ok(fake.db.agent.rows.find((a: any) => a.id === agent.id));
});

test("rate preview needs an agent or a vendor", async () => {
  await assert.rejects(admin.previewRate({}), (e: any) => e.statusCode === 400);
});
