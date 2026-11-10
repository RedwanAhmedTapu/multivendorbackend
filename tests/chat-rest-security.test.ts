// tests/chat-rest-security.test.ts
//
// Phase 0 chat hardening — REST, through the REAL chat router
// (setupChatModule) mounted in an Express app on 127.0.0.1 (ephemeral port),
// so the real authenticateUser / authorizeRoles / blockVendorEmployees /
// requirePermission chain runs. Prisma, Redis, media processing and the
// auto-reply trigger are replaced in memory — no database, no Redis, no R2.
// Tokens are signed with the throwaway test secret.
//   - message history / send / react / delete / media / read receipt need
//     access to the conversation (participant, or admin-side support staff on
//     a support chat); 404 otherwise — existence isn't revealed;
//   - sender identity comes from the token; SYSTEM / QUICK_REPLY are refused;
//   - conversation administration and the support queue are admin-side
//     support work (ADMIN, or EMPLOYEE without vendorId + customerSupport);
//   - find-or-create enforces the conversation rules; vendor name from the DB;
//   - pagination across a full page no longer crashes.
// Run with ACCESS_TOKEN_SECRET set (scratchpad run.sh "yes"):
//   npx tsx --test tests/chat-rest-security.test.ts

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";

const { prisma } = await import("../src/config/prisma.ts");
const redisClient = (await import("../src/config/redis.ts")).default as any;
const { setupChatModule } = await import("../src/modules/chat/chat.module.ts");
const { mediaService } = await import("../src/modules/chat/services/media.service.ts");
const { AutoReplyService } = await import("../src/modules/chat/services/auto-reply.service.ts");

type Row = Record<string, any>;
const SECRET = process.env.ACCESS_TOKEN_SECRET ?? "";
// cuid-shaped ids (the DTOs validate .cuid())
const C_MINE = "cconvmine00000000000000001";
const C_OTHER = "cconvother0000000000000001";
const C_SUP = "cconvsupport00000000000001";
const V1 = "cvendor100000000000000001";
const V2 = "cvendor200000000000000001";
const P_V1 = "cproductv1000000000000001";
const P_V2 = "cproductv2000000000000001";

const USERS: Record<string, Row> = {
  U_CUST: { id: "U_CUST", role: "CUSTOMER", isActive: true, vendorId: null, name: "Cust", email: null },
  U_CUST2: { id: "U_CUST2", role: "CUSTOMER", isActive: true, vendorId: null, name: "Cust2", email: null },
  U_VEND: { id: "U_VEND", role: "VENDOR", isActive: true, vendorId: V1, name: "Vend", email: null },
  U_ADMIN: { id: "U_ADMIN", role: "ADMIN", isActive: true, vendorId: null, name: "Admin", email: null },
  U_AGENT: { id: "U_AGENT", role: "EMPLOYEE", isActive: true, vendorId: null, name: "Agent", email: null },
  U_NOPERM: { id: "U_NOPERM", role: "EMPLOYEE", isActive: true, vendorId: null, name: "NoPerm", email: null },
  U_VSTAFF: { id: "U_VSTAFF", role: "EMPLOYEE", isActive: true, vendorId: null, name: "VStaff", email: null },
};
const EMPLOYEES: Record<string, Row> = {
  cemployeeadmin0000000000001: { id: "cemployeeadmin0000000000001", userId: "U_ADMIN", vendorId: null, isActive: true, permissions: {} },
  cemployeeagent0000000000001: { id: "cemployeeagent0000000000001", userId: "U_AGENT", vendorId: null, isActive: true, permissions: { customerSupport: true } },
  cemployeenoperm000000000001: { id: "cemployeenoperm000000000001", userId: "U_NOPERM", vendorId: null, isActive: true, permissions: {} },
  cemployeevstaff000000000001: { id: "cemployeevstaff000000000001", userId: "U_VSTAFF", vendorId: V1, isActive: true, permissions: { customerSupport: true } },
};
const E_AGENT = "cemployeeagent0000000000001";
const E_VSTAFF = "cemployeevstaff000000000001";

let db: Row;
function freshDb() {
  return {
    conversations: { [C_MINE]: { id: C_MINE, type: "PRODUCT_INQUIRY", status: "OPEN" }, [C_OTHER]: { id: C_OTHER, type: "PRODUCT_INQUIRY", status: "OPEN" }, [C_SUP]: { id: C_SUP, type: "USER_SUPPORT", status: "OPEN" } } as Record<string, Row>,
    participants: [
      { id: "P_CUST_MINE", conversationId: C_MINE, userId: "U_CUST", leftAt: null },
      { id: "P_VEND_MINE", conversationId: C_MINE, vendorId: V1, leftAt: null },
      { id: "P_CUST2_OTHER", conversationId: C_OTHER, userId: "U_CUST2", leftAt: null },
      { id: "P_CUST2_SUP", conversationId: C_SUP, userId: "U_CUST2", leftAt: null },
    ] as Row[],
    messages: {
      M_MINE: { id: "M_MINE", conversationId: C_MINE, senderType: "CUSTOMER", senderId: "U_CUST", senderVendorId: null, senderEmployeeId: null, senderDeliveryPersonId: null, deletedFor: [], createdAt: new Date(2) },
      M_MINE_VENDOR: { id: "M_MINE_VENDOR", conversationId: C_MINE, senderType: "VENDOR", senderId: null, senderVendorId: V1, senderEmployeeId: null, senderDeliveryPersonId: null, deletedFor: [], createdAt: new Date(1) },
      M_OTHER: { id: "M_OTHER", conversationId: C_OTHER, senderType: "CUSTOMER", senderId: "U_CUST2", senderVendorId: null, senderEmployeeId: null, senderDeliveryPersonId: null, deletedFor: [], createdAt: new Date(3) },
    } as Record<string, Row>,
    created: [] as Row[],
    reactions: [] as Row[],
    writes: [] as string[],
    readReceipts: [] as Row[],
  };
}

const restores: (() => void)[] = [];
const set = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};
const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([k, v]) => (k === "NOT" || k === "leftAt" ? true : row[k] === v));
let server: http.Server;
let base = "";

before(async () => {
  set(prisma.user, "findUnique", async ({ where }: Row) => (USERS[where.id] ? { ...USERS[where.id] } : null));
  set(prisma.vendor, "findUnique", async ({ where }: Row) => (where.id === V1 ? { id: V1, storeName: "Store One", email: null, avatar: "https://cdn/v1.png" } : where.id === V2 ? { id: V2, storeName: "Store Two", email: null, avatar: null } : null));
  set(prisma.employee, "findFirst", async ({ where }: Row) => Object.values(EMPLOYEES).find((e) => e.userId === where.userId && e.isActive) ?? null);
  set(prisma.employee, "findUnique", async ({ where }: Row) => EMPLOYEES[where.id] ?? null);
  set(prisma.employee, "create", async () => assert.fail("no employee provisioning"));
  set(prisma.product, "findUnique", async ({ where }: Row) => (where.id === P_V1 ? { vendorId: V1, deletedAt: null } : where.id === P_V2 ? { vendorId: V2, deletedAt: null } : null));
  set(prisma.conversation, "findUnique", async ({ where }: Row) => (where.id ? db.conversations[where.id] ?? null : null));
  set(prisma.conversation, "findFirst", async () => null);
  set(prisma.conversation, "findMany", async () => (db.writes.push("supportQueue"), []));
  set(prisma.conversation, "update", async ({ where, data }: Row) => (db.writes.push(`conversation.update:${where.id}`), { ...db.conversations[where.id], ...data }));
  set(prisma.conversationParticipant, "findFirst", async ({ where }: Row) => db.participants.find((p: Row) => p.conversationId === where.conversationId && matches(p, Object.fromEntries(Object.entries(where).filter(([k]) => k !== "conversationId")))) ?? null);
  set(prisma.conversationParticipant, "findMany", async () => []);
  set(prisma.conversationParticipant, "updateMany", async () => ({ count: 1 }));
  set(prisma.conversationParticipant, "update", async () => ({}));
  set(prisma.conversationActivity, "create", async () => ({}));
  set(prisma.conversationAssignment, "updateMany", async () => ({ count: 0 }));
  set(prisma.conversationAssignment, "create", async ({ data }: Row) => (db.writes.push(`assign:${data.assigneeId}`), data));
  set(prisma.conversationLabel, "create", async ({ data }: Row) => (db.writes.push("label"), data));
  set(prisma.conversationNote, "create", async ({ data }: Row) => (db.writes.push("note"), data));
  set(prisma.message, "findUnique", async ({ where }: Row) => db.messages[where.id] ?? null);
  set(prisma.message, "findUniqueOrThrow", async ({ where }: Row) => db.messages[where.id]);
  set(prisma.message, "update", async ({ where }: Row) => (db.writes.push(`message.update:${where.id}`), db.messages[where.id]));
  set(prisma.message, "create", async ({ data }: Row) => {
    const m = { id: `M_NEW_${db.created.length}`, createdAt: new Date(), media: [], ...data };
    db.created.push(m);
    return m;
  });
  set(prisma.message, "findMany", async ({ where, take }: Row) => Object.values(db.messages).filter((m: Row) => m.conversationId === where.conversationId).slice(0, take));
  set(prisma.messageReaction, "findUnique", async () => null);
  set(prisma.messageReaction, "create", async ({ data }: Row) => (db.reactions.push(data), data));
  set(prisma.messageReceipt, "upsert", async ({ create }: Row) => (db.readReceipts.push(create), create));
  set(prisma, "$transaction", async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma)));
  set(prisma.conversation, "create", async ({ data }: Row) => {
    const conv = { id: "cconvnew000000000000000001", type: data.type, participants: data.participants.create };
    db.created.push(conv);
    return conv;
  });
  for (const m of ["set", "incr", "expire", "del"]) set(redisClient, m, async () => (m === "incr" ? 1 : "OK"));
  set(redisClient, "get", async () => null);
  set(AutoReplyService.prototype, "processTrigger", async () => undefined);
  set(mediaService, "processImage", async () => (db.writes.push("media.processImage"), { url: "u", thumbnailUrl: "t", originalUrl: "o", width: 1, height: 1, aspectRatio: 1, blurhash: "b", fileSize: 1 }));
  set(mediaService, "deleteMedia", async (id: string) => (db.writes.push(`media.delete:${id}`), undefined));
  set(mediaService, "getMedia", async (id: string) => ({ messageId: id, url: "u" }));
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
  db = freshDb();
});

const tok = (id: string) => jwt.sign({ id, role: USERS[id].role }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(who ? { authorization: `Bearer ${tok(who)}` } : {}), ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const send = (who: string, conversationId: string, extra: Row = {}) =>
  call(who, "POST", "/messages", { conversationId, content: "hi", clientId: `cid-${Math.random()}`, ...extra });

// ── messages ────────────────────────────────────────────────────────────────

test("message history: a stranger gets 404 (same as a missing conversation); the participant and support staff on a support chat get it", async () => {
  assert.equal((await call(null, "GET", `/messages/conversation/${C_OTHER}`)).status, 401);
  const stranger = await call("U_CUST", "GET", `/messages/conversation/${C_OTHER}`);
  const missing = await call("U_CUST", "GET", "/messages/conversation/cconvmissing00000000000001");
  assert.deepEqual([stranger.status, missing.status], [404, 404]);
  assert.deepEqual(stranger.body, missing.body, "existence isn't revealed");
  assert.equal((await call("U_CUST2", "GET", `/messages/conversation/${C_OTHER}`)).status, 200);
  assert.equal((await call("U_VEND", "GET", `/messages/conversation/${C_MINE}`)).status, 200, "the vendor participant");
  assert.equal((await call("U_AGENT", "GET", `/messages/conversation/${C_SUP}`)).status, 200, "support staff on a support chat");
  assert.equal((await call("U_ADMIN", "GET", `/messages/conversation/${C_SUP}`)).status, 200);
  for (const who of ["U_VSTAFF", "U_NOPERM", "U_VEND"]) assert.equal((await call(who, "GET", `/messages/conversation/${C_SUP}`)).status, 404, who);
  assert.equal((await call("U_AGENT", "GET", `/messages/conversation/${C_OTHER}`)).status, 404, "support access doesn't cover product chats");
});

test("pagination: a full page builds the next cursor instead of crashing (require in an ES module)", async () => {
  const r = await call("U_CUST", "GET", `/messages/conversation/${C_MINE}?limit=2`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.length, 2);
  assert.equal(r.body.hasMore, true);
  assert.equal(typeof r.body.nextCursor, "string");
});

test("send: a non-participant can't post; the sender identity is the token's, whatever the body says", async () => {
  assert.equal((await send("U_CUST", C_OTHER)).status, 404);
  assert.equal(db.created.length, 0, "nothing written");
  const ok = await send("U_CUST", C_MINE, { senderType: "ADMIN", senderId: "U_ADMIN", senderVendorId: V1, senderEmployeeId: E_AGENT });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const m = db.created[0];
  assert.deepEqual([m.senderType, m.senderId, m.senderVendorId, m.senderEmployeeId], ["CUSTOMER", "U_CUST", null, null]);
  const vendor = await send("U_VEND", C_MINE);
  assert.equal(vendor.status, 201);
  assert.deepEqual([db.created[1].senderType, db.created[1].senderVendorId], ["VENDOR", V1]);
  const agent = await send("U_AGENT", C_SUP);
  assert.equal(agent.status, 201, "support staff may answer a support chat");
  assert.deepEqual([db.created[2].senderType, db.created[2].senderEmployeeId], ["EMPLOYEE", E_AGENT]);
});

test("send: client-supplied SYSTEM and QUICK_REPLY messages are refused; TEXT / IMAGE / AUDIO are allowed", async () => {
  for (const messageType of ["SYSTEM", "QUICK_REPLY"]) {
    const r = await send("U_CUST", C_MINE, { messageType });
    assert.equal(r.status, 400, messageType);
  }
  assert.equal(db.created.length, 0);
  for (const messageType of ["TEXT", "IMAGE", "AUDIO"]) assert.equal((await send("U_CUST", C_MINE, { messageType })).status, 201, messageType);
});

test("reactions: only within an accessible conversation, always as the actor's own participant row", async () => {
  assert.equal((await call("U_CUST", "POST", "/messages/M_OTHER/react", { reaction: "👍", participantId: "P_CUST2_OTHER" })).status, 404);
  assert.equal(db.reactions.length, 0);
  const r = await call("U_CUST", "POST", "/messages/M_MINE_VENDOR/react", { reaction: "👍", participantId: "P_VEND_MINE" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(db.reactions, [{ messageId: "M_MINE_VENDOR", participantId: "P_CUST_MINE", reaction: "👍" }]);
});

test("delete: a message of another conversation is 404 and untouched; the participant's own works", async () => {
  assert.equal((await call("U_CUST", "DELETE", "/messages/M_OTHER")).status, 404);
  assert.ok(!db.writes.some((w: string) => w.startsWith("message.update")));
  assert.equal((await call("U_CUST", "DELETE", "/messages/M_MINE")).status, 200);
});

test("media: get needs conversation access; upload and delete are the sender's own", async () => {
  assert.equal((await call("U_CUST", "GET", "/media/M_OTHER")).status, 404);
  assert.equal((await call("U_CUST", "GET", "/media/M_MINE_VENDOR")).status, 200);
  assert.equal((await call("U_CUST", "DELETE", "/media/M_MINE_VENDOR")).status, 404, "a participant can't delete the other side's media");
  assert.equal((await call("U_CUST", "DELETE", "/media/M_OTHER")).status, 404);
  assert.ok(!db.writes.some((w: string) => w.startsWith("media.delete")));
  assert.equal((await call("U_CUST", "DELETE", "/media/M_MINE")).status, 200);
  const upload = (messageId: string) => {
    const fd = new FormData();
    fd.append("messageId", messageId);
    fd.append("file", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" }), "a.jpg");
    return call("U_CUST", "POST", "/media/image", fd);
  };
  assert.equal((await upload("M_OTHER")).status, 404);
  assert.equal((await upload("M_MINE_VENDOR")).status, 404, "can't attach to someone else's message");
  assert.ok(!db.writes.includes("media.processImage"));
});

test("read receipt: the pointer moves only to a message of the same conversation", async () => {
  assert.equal((await call("U_CUST", "POST", "/read-receipts", { conversationId: C_MINE, messageId: "M_OTHER" })).status, 404);
  assert.equal(db.readReceipts.length, 0);
  assert.equal((await call("U_CUST", "POST", "/read-receipts", { conversationId: C_MINE, messageId: "M_MINE_VENDOR" })).status, 200);
  assert.deepEqual(db.readReceipts.map((r: Row) => r.participantId), ["P_CUST_MINE"]);
});

// ── conversation administration ────────────────────────────────────────────

test("status / assign / labels / notes / support queue / create: admin-side support staff only", async () => {
  const actions: [string, string, Row?][] = [
    ["PATCH", `/conversations/${C_SUP}/status`, { status: "RESOLVED" }],
    ["POST", `/conversations/${C_SUP}/assign`, { assigneeId: E_AGENT, assigneeType: "EMPLOYEE" }],
    ["POST", `/conversations/${C_SUP}/labels`, { label: "vip", color: "#f00" }],
    ["POST", `/conversations/${C_SUP}/notes`, { content: "internal" }],
    ["GET", "/conversations/support-queue"],
    ["POST", "/conversations", { type: "USER_SUPPORT", participantIds: [{ id: "U_CUST2", type: "CUSTOMER" }] }],
  ];
  for (const [method, path, body] of actions) {
    for (const who of ["U_CUST", "U_CUST2", "U_VEND", "U_VSTAFF", "U_NOPERM"]) {
      db = freshDb();
      const r = await call(who, method, path, body);
      assert.equal(r.status, 403, `${who} ${method} ${path}`);
      assert.deepEqual(db.writes.filter((w: string) => w !== "supportQueue" || method !== "GET"), [], `${who} ${method} ${path}: nothing written`);
      assert.ok(!db.writes.includes("supportQueue"), `${who}: queue not read`);
    }
    for (const who of ["U_AGENT", "U_ADMIN"]) {
      db = freshDb();
      const r = await call(who, method, path, body);
      assert.ok(r.status === 200 || r.status === 201, `${who} ${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
});

test("assign: only to an active admin-side employee (never to a vendor's staff)", async () => {
  assert.equal((await call("U_AGENT", "POST", `/conversations/${C_SUP}/assign`, { assigneeId: E_VSTAFF, assigneeType: "EMPLOYEE" })).status, 400);
  assert.equal((await call("U_AGENT", "POST", `/conversations/${C_SUP}/assign`, { assigneeId: "cnobody000000000000000001", assigneeType: "EMPLOYEE" })).status, 400);
  assert.equal((await call("U_AGENT", "POST", `/conversations/${C_SUP}/assign`, { assigneeId: E_AGENT, assigneeType: "CUSTOMER" })).status, 400);
  assert.ok(!db.writes.some((w: string) => w.startsWith("assign:")));
});

test("create (admin): the creating staff member is always a participant", async () => {
  const r = await call("U_AGENT", "POST", "/conversations", { type: "USER_SUPPORT", participantIds: [{ id: "U_CUST2", type: "CUSTOMER" }] });
  assert.equal(r.status, 201);
  const created = db.created.find((c: Row) => c.participants)!;
  assert.ok(created.participants.some((p: Row) => p.employeeId === E_AGENT && p.participantType === "EMPLOYEE"));
});

// ── find-or-create ─────────────────────────────────────────────────────────

test("find-or-create: product inquiries only customer → existing vendor, product must be that vendor's; vendor name from the DB", async () => {
  const fc = (who: string, body: Row) => call(who, "POST", "/conversations/find-or-create", body);
  const vendor = (id: string, extra: Row = {}) => ({ id, type: "VENDOR", displayName: "FinixMart Official Support", ...extra });
  const ok = await fc("U_CUST", { type: "PRODUCT_INQUIRY", productId: P_V1, otherParticipant: vendor(V1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const conv = db.created.find((c: Row) => c.participants)!;
  const v = conv.participants.find((p: Row) => p.participantType === "VENDOR");
  assert.deepEqual([v.vendorId, v.displayName, v.displayImage], [V1, "Store One", "https://cdn/v1.png"], "spoofed display name ignored");
  assert.equal((await fc("U_CUST", { type: "PRODUCT_INQUIRY", productId: P_V2, otherParticipant: vendor(V1) })).status, 404, "product of another vendor");
  assert.equal((await fc("U_CUST", { type: "PRODUCT_INQUIRY", productId: P_V1, otherParticipant: vendor("cnovendor0000000000000001") })).status, 404);
  assert.equal((await fc("U_CUST", { type: "PRODUCT_INQUIRY", productId: P_V1, otherParticipant: { id: E_AGENT, type: "ADMIN", displayName: "x" } })).status, 403);
  assert.equal((await fc("U_VEND", { type: "PRODUCT_INQUIRY", productId: P_V1, otherParticipant: vendor(V2) })).status, 403, "a vendor can't open a buyer chat with another vendor");
  for (const type of ["GENERAL_CHAT", "DELIVERY_CHAT"]) {
    assert.equal((await fc("U_CUST", { type, orderId: "corder000000000000000001", otherParticipant: { id: "cothercust000000000000001", type: "CUSTOMER", displayName: "x" } })).status, 403, type);
  }
});

test("find-or-create: support chats only with an active admin-side employee, by the matching requester role", async () => {
  const fc = (who: string, body: Row) => call(who, "POST", "/conversations/find-or-create", body);
  const staff = (id: string) => ({ id, type: "EMPLOYEE", displayName: "FinixMart Support" });
  assert.equal((await fc("U_CUST", { type: "USER_SUPPORT", otherParticipant: staff(E_AGENT) })).status, 200);
  assert.equal((await fc("U_VEND", { type: "VENDOR_SUPPORT", otherParticipant: staff(E_AGENT) })).status, 200);
  assert.equal((await fc("U_CUST", { type: "USER_SUPPORT", otherParticipant: staff(E_VSTAFF) })).status, 404, "a vendor's staff is not support");
  assert.equal((await fc("U_CUST", { type: "VENDOR_SUPPORT", otherParticipant: staff(E_AGENT) })).status, 403, "customers open USER_SUPPORT");
  assert.equal((await fc("U_VEND", { type: "USER_SUPPORT", otherParticipant: staff(E_AGENT) })).status, 403);
  assert.equal((await fc("U_CUST", { type: "USER_SUPPORT", otherParticipant: { id: V1, type: "VENDOR", displayName: "x" } })).status, 403);
});
