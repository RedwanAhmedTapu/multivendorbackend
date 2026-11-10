// tests/chat-admin-inbox.test.ts
//
// Admin Live Chat: ADMIN without an Employee row at login, employee flows
// unchanged, and the staff "New chat" search/start (never duplicates).
// Real chat router + authenticateUser; Prisma and Redis are in memory.
//
// NOTE: authenticateUser's existing getOrCreateAdminEmployee provisions the
// admin's chat row on the first authenticated request; nothing new creates
// one. These tests pin that a row is made at most once and only there.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";

const { prisma } = await import("../src/config/prisma.ts");
const redisClient = (await import("../src/config/redis.ts")).default as any;
const { setupChatModule } = await import("../src/modules/chat/chat.module.ts");
const { AutoReplyService } = await import("../src/modules/chat/services/auto-reply.service.ts");
const { maskContact } = await import("../src/modules/chat/controllers/staff-chat.controller.ts");

type Row = Record<string, any>;
const SECRET = process.env.ACCESS_TOKEN_SECRET ?? "";
const V1 = "cvendor100000000000000001";
const C_SUP = "cconvsupport00000000000001";

const USERS: Record<string, Row> = {
  U_ADMIN: { id: "U_ADMIN", role: "ADMIN", isActive: true, vendorId: null, name: "Admin", email: null },
  U_STAFF: { id: "U_STAFF", role: "EMPLOYEE", isActive: true, vendorId: null, name: "Staff", email: null },
  U_NOPERM: { id: "U_NOPERM", role: "EMPLOYEE", isActive: true, vendorId: null, name: "NoPerm", email: null },
  U_NOROW: { id: "U_NOROW", role: "EMPLOYEE", isActive: true, vendorId: null, name: "NoRow", email: null },
  U_VSTAFF: { id: "U_VSTAFF", role: "EMPLOYEE", isActive: true, vendorId: null, name: "VStaff", email: null },
  U_VEND: { id: "U_VEND", role: "VENDOR", isActive: true, vendorId: V1, name: "Vend", email: null },
  U_CUST: { id: "U_CUST", role: "CUSTOMER", isActive: true, vendorId: null, name: "Rina", email: "rina@example.com", phone: "01711000001" },
  U_OFF: { id: "U_OFF", role: "CUSTOMER", isActive: false, vendorId: null, name: "Off", email: null },
};

let employees: Row[];
let conversations: Row[];
let participants: Row[];
let messages: Row[];
let assignments: Row[];
let creates: number;
let raceOnce: boolean;
let seq = 0;

const restores: (() => void)[] = [];
const set = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};
let server: http.Server;
let base = "";
const withRel = (c: Row) => ({ ...c, participants: participants.filter((p) => p.conversationId === c.id), assignments: assignments.filter((a) => a.conversationId === c.id && a.isActive) });

before(async () => {
  set(prisma.user, "findUnique", async ({ where }: Row) => (USERS[where.id] ? { ...USERS[where.id] } : null));
  set(prisma.user, "findMany", async ({ where }: Row) => Object.values(USERS).filter((u) => u.role === where.role && u.isActive));
  set(prisma.vendor, "findUnique", async ({ where }: Row) => (where.id === V1 ? { id: V1, storeName: "Store One", avatar: null, email: null } : null));
  set(prisma.vendor, "findMany", async () => [{ id: V1, storeName: "Store One", avatar: null }]);
  set(prisma.employee, "findFirst", async ({ where }: Row) => employees.find((e) => e.userId === where.userId && e.isActive) ?? null);
  set(prisma.employee, "findUnique", async ({ where }: Row) => employees.find((e) => e.id === where.id) ?? null);
  set(prisma.employee, "create", async ({ data }: Row) => {
    creates += 1;
    const e = { id: `cemployeeprovisioned00000${creates}`, vendorId: null, ...data };
    employees.push(e);
    return e;
  });
  set(prisma.conversation, "findUnique", async ({ where, include }: Row) => {
    const c = conversations.find((x) => (where.id ? x.id === where.id : x.dedupeKey === where.dedupeKey));
    return c ? (include ? withRel(c) : c) : null;
  });
  set(prisma.conversation, "findMany", async () => conversations.map(withRel));
  set(prisma.conversation, "update", async ({ where, data }: Row) => Object.assign(conversations.find((c) => c.id === where.id)!, Object.fromEntries(Object.entries(data).filter(([k]) => k !== "messageCount"))));
  set(prisma.conversation, "create", async ({ data, select }: Row) => {
    if (raceOnce) {
      // the other staff member's row lands first
      raceOnce = false;
      conversations.push({ id: "cconvwinner000000000000001", type: data.type, status: "OPEN", priority: 0, dedupeKey: data.dedupeKey });
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }
    const id = `cconvnew0000000000000000${++seq}`;
    conversations.push({ id, type: data.type, status: "OPEN", priority: 0, dedupeKey: data.dedupeKey, lastMessageAt: null, lastMessageText: null });
    for (const p of data.participants.create) participants.push({ id: `P${++seq}`, conversationId: id, leftAt: null, unreadCount: 0, isPinned: false, lastReadMessageId: null, ...p });
    return select ? { id } : { id, ...data };
  });
  set(prisma.conversationActivity, "create", async () => ({}));
  set(prisma.conversationParticipant, "findFirst", async ({ where }: Row) => {
    const hit = participants.find(
      (p) =>
        p.conversationId === (where.conversationId ?? p.conversationId) &&
        Object.entries(where).every(([k, v]) => ["conversationId", "leftAt", "conversation"].includes(k) || p[k] === v) &&
        (!where.conversation || conversations.find((c) => c.id === p.conversationId)?.type === where.conversation.type),
    );
    return hit ? { id: hit.id, conversationId: hit.conversationId } : null;
  });
  set(prisma.conversationParticipant, "findMany", async () => []);
  set(prisma.conversationParticipant, "updateMany", async () => ({ count: 1 }));
  set(prisma.conversationAssignment, "updateMany", async () => ({ count: 0 }));
  set(prisma.conversationAssignment, "create", async ({ data }: Row) => (assignments.push({ ...data, isActive: true }), data));
  set(prisma.message, "create", async ({ data }: Row) => {
    const m = { id: `M${++seq}`, createdAt: new Date(), media: null, ...data };
    messages.push(m);
    return m;
  });
  set(prisma.message, "findMany", async () => messages);
  set(prisma, "$transaction", async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma)));
  for (const m of ["set", "incr", "expire", "del"]) set(redisClient, m, async () => (m === "incr" ? 1 : "OK"));
  set(AutoReplyService.prototype, "processTrigger", async () => undefined);
  const app = express();
  app.use(express.json());
  app.use("/api/chat", setupChatModule(new Server()));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}/api/chat`;
});
after(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  restores.reverse().forEach((r) => r());
});
beforeEach(() => {
  employees = [
    { id: "cemployeestaff000000000001", userId: "U_STAFF", vendorId: null, isActive: true, permissions: { customerSupport: true } },
    { id: "cemployeenoperm00000000001", userId: "U_NOPERM", vendorId: null, isActive: true, permissions: {} },
    { id: "cemployeevstaff00000000001", userId: "U_VSTAFF", vendorId: V1, isActive: true, permissions: { customerSupport: true } },
  ];
  conversations = [{ id: C_SUP, type: "USER_SUPPORT", status: "OPEN", priority: 0, lastMessageAt: null, lastMessageText: null }];
  participants = [{ id: "P_C", conversationId: C_SUP, participantType: "CUSTOMER", userId: "U_CUST", leftAt: null, unreadCount: 0 }];
  messages = [];
  assignments = [];
  creates = 0;
  raceOnce = false;
});

const tok = (id: string) => jwt.sign({ id, role: USERS[id].role }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(who ? { authorization: `Bearer ${tok(who)}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── ADMIN with no Employee row at login ───────────────────────────────────

test("ADMIN with no Employee row can open the inbox, read, reply and assign; the row is made once, only by the existing auth step", async () => {
  assert.equal(employees.some((e) => e.userId === "U_ADMIN"), false);
  const queue = await call("U_ADMIN", "GET", "/conversations/support-queue?category=ALL&view=ALL");
  assert.equal(queue.status, 200);
  assert.equal(queue.body.data[0].id, C_SUP);
  assert.equal((await call("U_ADMIN", "GET", `/messages/conversation/${C_SUP}`)).status, 200);
  const sent = await call("U_ADMIN", "POST", "/messages", { conversationId: C_SUP, messageType: "TEXT", content: "Hello", clientId: "admin-1" });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.data.senderType, "ADMIN");
  const adminEmployee = employees.find((e) => e.userId === "U_ADMIN")!;
  assert.equal(sent.body.data.senderEmployeeId, adminEmployee.id, "the resolver's ADMIN column");
  const assigned = await call("U_ADMIN", "POST", `/conversations/${C_SUP}/assign`, { assigneeId: adminEmployee.id, assigneeType: "ADMIN" });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(assignments[0].assigneeId, adminEmployee.id);
  assert.equal(creates, 1, "provisioned once across every request");
});

test("employees are unchanged: no Employee row, no customerSupport or vendor staff are refused; the row is never created for them", async () => {
  assert.equal((await call("U_STAFF", "GET", "/conversations/support-queue?category=ALL&view=ALL")).status, 200);
  for (const who of ["U_NOPERM", "U_VSTAFF"]) assert.equal((await call(who, "GET", "/conversations/support-queue?category=ALL&view=ALL")).status, 403, who);
  const noRow = await call("U_NOROW", "GET", "/conversations/support-queue?category=ALL&view=ALL");
  assert.ok([401, 403].includes(noRow.status), `no profile: ${noRow.status}`);
  assert.equal(creates, 0, "never provisions an Employee for an EMPLOYEE");
});

// ── New chat ──────────────────────────────────────────────────────────────

test("staff start: a vendor conversation is created once, then reused by any staff member; the shape is a queue row", async () => {
  const a = await call("U_ADMIN", "POST", "/conversations/staff-start", { kind: "VENDOR", id: V1 });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.data.type, "VENDOR_SUPPORT");
  assert.deepEqual(a.body.data.requester, { id: V1, participantType: "VENDOR", displayName: "Store One", displayImage: null });
  assert.deepEqual(Object.keys(a.body.data).sort(), ["assignedTo", "id", "lastMessageAt", "lastMessageText", "priority", "requester", "status", "supportParticipant", "type"]);
  const staffRow = participants.find((p) => p.conversationId === a.body.data.id && p.participantType === "ADMIN")!;
  assert.equal(staffRow.displayName, "FinixMart Support");
  const again = await call("U_STAFF", "POST", "/conversations/staff-start", { kind: "VENDOR", id: V1 });
  assert.equal(again.body.data.id, a.body.data.id, "another staff member reuses it");
  assert.equal(conversations.filter((c) => c.type === "VENDOR_SUPPORT").length, 1);
});

test("staff start: reuses an existing customer support chat; concurrent starts resolve to one; bad targets are refused", async () => {
  const r = await call("U_ADMIN", "POST", "/conversations/staff-start", { kind: "CUSTOMER", id: "U_CUST" });
  assert.equal(r.body.data.id, C_SUP, "the existing support conversation");
  assert.equal(conversations.length, 1);

  raceOnce = true;
  const race = await call("U_ADMIN", "POST", "/conversations/staff-start", { kind: "VENDOR", id: V1 });
  assert.equal(race.status, 200, JSON.stringify(race.body));
  assert.equal(race.body.data.id, "cconvwinner000000000000001");

  assert.equal((await call("U_ADMIN", "POST", "/conversations/staff-start", { kind: "VENDOR", id: "cvendormissing" })).status, 404);
  assert.equal((await call("U_ADMIN", "POST", "/conversations/staff-start", { kind: "CUSTOMER", id: "U_OFF" })).status, 404, "inactive");
  assert.equal((await call("U_ADMIN", "POST", "/conversations/staff-start", { kind: "CUSTOMER", id: "U_VEND" })).status, 404, "not a customer");
  assert.equal((await call("U_ADMIN", "POST", "/conversations/staff-start", { kind: "AGENT", id: "A1" })).status, 400, "agents have their own route");
});

test("staff routes keep the support gate: vendors, customers, staff without customerSupport and vendor staff are refused", async () => {
  for (const who of ["U_VEND", "U_CUST", "U_NOPERM", "U_VSTAFF"]) {
    assert.equal((await call(who, "POST", "/conversations/staff-start", { kind: "VENDOR", id: V1 })).status, 403, who);
    assert.equal((await call(who, "GET", "/conversations/staff-lookup?kind=VENDOR")).status, 403, who);
  }
  assert.equal((await call(null, "GET", "/conversations/staff-lookup?kind=VENDOR")).status, 401);
});

test("staff lookup: vendors by name; customers only when searched, with masked contact details", async () => {
  const v = await call("U_ADMIN", "GET", "/conversations/staff-lookup?kind=VENDOR&q=store");
  assert.deepEqual(v.body.data, [{ id: V1, name: "Store One", image: null, detail: null }]);
  assert.deepEqual((await call("U_ADMIN", "GET", "/conversations/staff-lookup?kind=CUSTOMER&q=r")).body.data, [], "needs 2+ characters");
  const c = await call("U_ADMIN", "GET", "/conversations/staff-lookup?kind=CUSTOMER&q=rina");
  assert.deepEqual(c.body.data, [{ id: "U_CUST", name: "Rina", image: null, detail: "r***@example.com" }]);
  assert.ok(!JSON.stringify(c.body).includes("rina@example.com") && !JSON.stringify(c.body).includes("01711000001"));
  assert.equal(maskContact(null, "01711000001"), "•••• 0001");
  assert.equal(maskContact(null, null), null);
});
