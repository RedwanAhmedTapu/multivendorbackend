// tests/chat-baseline/conversations-messages.test.ts
//
// CHARACTERIZATION (agent-chat Stage 1): today's conversation / message /
// read-receipt / support-queue behaviour of the EXISTING chat services, for
// every participant type. Prisma, Redis, the auto-reply trigger and the socket
// emitter are replaced in memory; the real service code runs.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { prisma } = await import("../../src/config/prisma.ts");
const redisClient = (await import("../../src/config/redis.ts")).default as any;
const { ConversationService } = await import("../../src/modules/chat/services/conversation.service.ts");
const { ConversationRepository, buildDedupeKey } = await import("../../src/modules/chat/repositories/conversation.repository.ts");
const { MessageService } = await import("../../src/modules/chat/services/message.service.ts");
const { ReadReceiptService } = await import("../../src/modules/chat/services/read-receipt.service.ts");
const { AutoReplyService } = await import("../../src/modules/chat/services/auto-reply.service.ts");
const { SocketEmitter } = await import("../../src/modules/chat/socket/chat.handler.ts");

type Row = Record<string, any>;
const restores: Array<() => void> = [];
const set = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};

let calls: Array<{ op: string; args: any }>;
let emitted: Array<{ event: string; data: any; room?: string }>;
let kv: Map<string, string>;
const savedEmitter = SocketEmitter._emit;

beforeEach(() => {
  calls = [];
  emitted = [];
  kv = new Map();
  SocketEmitter.setEmitter((event, data, room) => emitted.push({ event, data, room }));
  set(redisClient, "set", async (k: string, v: string, o?: Row) => (o?.NX && kv.has(k) ? null : (kv.set(k, v), "OK")));
  set(redisClient, "incr", async (k: string) => {
    const n = Number(kv.get(k) ?? 0) + 1;
    kv.set(k, String(n));
    return n;
  });
  set(redisClient, "expire", async () => 1);
  set(redisClient, "del", async (k: string) => ((calls.push({ op: "redis.del", args: k }), kv.delete(k)) ? 1 : 0));
  set(redisClient, "eval", async () => 0);
  set(AutoReplyService.prototype, "processTrigger", async () => undefined);
  set(prisma, "$transaction", async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma)));
});
afterEach(() => {
  while (restores.length) restores.pop()!();
  SocketEmitter._emit = savedEmitter;
});

const record = (op: string, result: any = {}) => async (args: any) => {
  calls.push({ op, args });
  return typeof result === "function" ? result(args) : result;
};
const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// ── conversation creation ─────────────────────────────────────────────────

test("findOrCreate: identity column per participant type; display data stored as given", async () => {
  set(ConversationRepository.prototype, "findByDedupeKey", async () => null);
  set(ConversationRepository.prototype, "findByParticipants", async () => null);
  set(prisma.conversation, "create", record("conversation.create", (a: any) => ({ id: "NEW", ...a.data })));
  set(prisma.conversationActivity, "create", record("activity.create"));
  const svc = new ConversationService();
  const people = [
    { id: "U1", type: "CUSTOMER", displayName: "Cust" },
    { id: "V1", type: "VENDOR", displayName: "Shop", displayImage: "v.png" },
    { id: "E1", type: "EMPLOYEE", displayName: "Emp" },
    { id: "E2", type: "ADMIN", displayName: "Adm" },
    { id: "D1", type: "DELIVERY", displayName: "Rider" },
  ] as any[];
  await svc.findOrCreate("GENERAL_CHAT" as any, { productId: "PR", orderId: "OR" }, people);
  const create = calls.find((c) => c.op === "conversation.create")!.args.data;
  assert.equal(create.type, "GENERAL_CHAT");
  assert.equal(create.productId, "PR", "non-inquiry keeps product/order");
  assert.equal(create.orderId, "OR");
  assert.equal(create.dedupeKey, buildDedupeKey("GENERAL_CHAT" as any, { productId: "PR", orderId: "OR" }, ["U1", "V1", "E1", "E2", "D1"]));
  assert.deepEqual(create.participants.create, [
    { participantType: "CUSTOMER", userId: "U1", vendorId: null, employeeId: null, deliveryPersonId: null, displayName: "Cust", displayImage: undefined },
    { participantType: "VENDOR", userId: null, vendorId: "V1", employeeId: null, deliveryPersonId: null, displayName: "Shop", displayImage: "v.png" },
    { participantType: "EMPLOYEE", userId: null, vendorId: null, employeeId: "E1", deliveryPersonId: null, displayName: "Emp", displayImage: undefined },
    { participantType: "ADMIN", userId: null, vendorId: null, employeeId: "E2", deliveryPersonId: null, displayName: "Adm", displayImage: undefined },
    { participantType: "DELIVERY", userId: null, vendorId: null, employeeId: null, deliveryPersonId: "D1", displayName: "Rider", displayImage: undefined },
  ]);
  assert.deepEqual(calls.find((c) => c.op === "activity.create")!.args.data, { conversationId: "NEW", activityType: "CREATED", metadata: { count: 5 } });
});

test("findOrCreate: PRODUCT_INQUIRY drops product/order; reuses by dedupeKey, then by customer+vendor; <2 participants throws", async () => {
  const svc = new ConversationService();
  set(ConversationRepository.prototype, "findByDedupeKey", async (k: string) => (k === "HIT" ? { id: "BY_KEY" } : null));
  set(ConversationRepository.prototype, "findByParticipants", async (type: string, c: string, v: string) => (c === "U1" && v === "V1" ? { id: "BY_PAIR", type } : null));
  set(prisma.conversation, "create", record("conversation.create", (a: any) => ({ id: "NEW", ...a.data })));
  set(prisma.conversationActivity, "create", record("activity.create"));
  const pair = [
    { id: "U1", type: "CUSTOMER", displayName: "C" },
    { id: "V1", type: "VENDOR", displayName: "V" },
  ] as any[];
  assert.deepEqual(await svc.findOrCreate("PRODUCT_INQUIRY" as any, { productId: "P9" }, pair), { id: "BY_PAIR", type: "PRODUCT_INQUIRY" });
  const fresh = [
    { id: "U2", type: "CUSTOMER", displayName: "C" },
    { id: "V2", type: "VENDOR", displayName: "V" },
  ] as any[];
  const created: any = await svc.findOrCreate("PRODUCT_INQUIRY" as any, { productId: "P9", orderId: "O9" }, fresh);
  assert.equal(created.productId, null);
  assert.equal(created.orderId, null);
  await assert.rejects(svc.findOrCreate("USER_SUPPORT" as any, {}, [pair[0]]), /At least 2 participants/);
});

test("dedupeKey: sha256 of type + context + SORTED bare ids (order-independent, untyped ids)", () => {
  const a = buildDedupeKey("USER_SUPPORT" as any, {}, ["b", "a"]);
  const b = buildDedupeKey("USER_SUPPORT" as any, {}, ["a", "b"]);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(buildDedupeKey("VENDOR_SUPPORT" as any, {}, ["a", "b"]), a);
});

test("create (support staff): same column mapping", async () => {
  set(prisma.conversation, "create", record("conversation.create", (a: any) => ({ id: "NEW", ...a.data })));
  set(prisma.conversationActivity, "create", record("activity.create"));
  await new ConversationService().create({ type: "USER_SUPPORT", participantIds: [{ id: "U1", type: "CUSTOMER", displayName: "C" }, { id: "E1", type: "ADMIN", displayName: "A" }] } as any);
  const rows = calls.find((c) => c.op === "conversation.create")!.args.data.participants.create;
  assert.deepEqual(rows.map((r: any) => [r.participantType, r.userId, r.employeeId]), [["CUSTOMER", "U1", null], ["ADMIN", null, "E1"]]);
});

// ── list shaping ──────────────────────────────────────────────────────────

const participantRow = (over: Row) => ({ id: "P", participantType: "CUSTOMER", userId: null, vendorId: null, employeeId: null, deliveryPersonId: null, displayName: null, displayImage: null, unreadCount: 0, isPinned: false, lastReadMessageId: null, ...over });

test("getUserList: response keys; otherParticipant = first other row's owner id (?? chain); null when it has no id", async () => {
  const conv = (id: string, others: Row[]) => ({ id, type: "PRODUCT_INQUIRY", status: "OPEN", title: null, lastMessageAt: new Date(5), lastMessageText: "hi", lastMessageType: "TEXT", lastSenderId: "V1", lastSenderType: "VENDOR", priority: 0, participants: [participantRow({ id: "ME" }), ...others] });
  set(ConversationRepository.prototype, "getUserConversations", async () => [
    { ...participantRow({ id: "ME", userId: "U1", unreadCount: 3 }), conversation: conv("C1", [participantRow({ id: "O1", participantType: "VENDOR", vendorId: "V1", displayName: "Shop" })]) },
    { ...participantRow({ id: "ME", userId: "U1" }), conversation: conv("C2", [participantRow({ id: "O2", participantType: "VENDOR" })]) },
  ]);
  const out = await new ConversationService().getUserList("U1", "CUSTOMER" as any, {});
  assert.deepEqual(Object.keys(out).sort(), ["data", "hasMore", "nextCursor"]);
  assert.deepEqual(Object.keys(out.data[0]).sort(), ["conversation", "deliveryPersonId", "employeeId", "id", "isPinned", "lastReadMessageId", "otherParticipant", "unreadCount", "userId", "vendorId"]);
  assert.deepEqual(Object.keys(out.data[0].conversation).sort(), ["id", "lastMessageAt", "lastMessageText", "lastMessageType", "lastSenderId", "lastSenderType", "priority", "status", "title", "type"]);
  assert.deepEqual(out.data[0].otherParticipant, { id: "V1", participantType: "VENDOR", displayName: "Shop", displayImage: null });
  assert.equal(out.data[0].unreadCount, 3);
  assert.equal(out.data[1].otherParticipant, null, "an other row with no identity column → null (the UI drops it)");
  assert.equal(out.nextCursor, null);
  assert.equal(out.hasMore, false);
});

test("getSupportQueue: requester = first VENDOR/CUSTOMER row; supportParticipant = first ADMIN/EMPLOYEE row", async () => {
  set(ConversationRepository.prototype, "getSupportQueue", async () => [
    {
      id: "S1", type: "VENDOR_SUPPORT", status: "OPEN", priority: 0, lastMessageAt: null, lastMessageText: null, assignments: [],
      participants: [participantRow({ id: "PV", participantType: "VENDOR", vendorId: "V1", displayName: "Shop" }), participantRow({ id: "PE", participantType: "EMPLOYEE", employeeId: "E1", unreadCount: 2 })],
    },
    { id: "S2", type: "USER_SUPPORT", status: "OPEN", priority: 0, lastMessageAt: null, lastMessageText: null, assignments: [{ id: "A" }], participants: [participantRow({ id: "PD", participantType: "DELIVERY", deliveryPersonId: "D1" })] },
  ]);
  const q = await new ConversationService().getSupportQueue("ALL", "ALL", "E1", {});
  assert.deepEqual(Object.keys(q[0]).sort(), ["assignedTo", "id", "lastMessageAt", "lastMessageText", "priority", "requester", "status", "supportParticipant", "type"]);
  assert.deepEqual(q[0].requester, { id: "V1", participantType: "VENDOR", displayName: "Shop", displayImage: null });
  assert.deepEqual(q[0].supportParticipant, { id: "PE", unreadCount: 2, isPinned: false, lastReadMessageId: null, userId: null, vendorId: null, employeeId: "E1", deliveryPersonId: null });
  assert.equal(q[1].requester, null, "a DELIVERY-only conversation has no requester");
  assert.equal(q[1].supportParticipant, null);
  assert.deepEqual(q[1].assignedTo, { id: "A" });
});

// ── send ──────────────────────────────────────────────────────────────────

function wireSend(participants: Row[]) {
  set(prisma.conversation, "findUnique", async () => ({ id: "C" }));
  set(prisma.message, "create", record("message.create", (a: any) => ({ id: "M1", createdAt: new Date(10), media: null, ...a.data })));
  set(prisma.conversation, "update", record("conversation.update"));
  set(prisma.conversationParticipant, "updateMany", record("participant.updateMany", { count: 1 }));
  set(prisma.conversationParticipant, "findMany", async () => participants);
  set(prisma.conversationParticipant, "findFirst", async () => participants.find((p) => p.participantType === "VENDOR") ?? null);
}

const SENDERS: Array<[string, string, Record<string, string | null>, Record<string, string>]> = [
  ["CUSTOMER", "U1", { senderId: "U1", senderVendorId: null, senderEmployeeId: null, senderDeliveryPersonId: null }, { userId: "U1" }],
  ["VENDOR", "V1", { senderId: null, senderVendorId: "V1", senderEmployeeId: null, senderDeliveryPersonId: null }, { vendorId: "V1" }],
  ["EMPLOYEE", "E1", { senderId: null, senderVendorId: null, senderEmployeeId: "E1", senderDeliveryPersonId: null }, { employeeId: "E1" }],
  ["ADMIN", "E2", { senderId: null, senderVendorId: null, senderEmployeeId: "E2", senderDeliveryPersonId: null }, { employeeId: "E2" }],
  ["DELIVERY", "D1", { senderId: null, senderVendorId: null, senderEmployeeId: null, senderDeliveryPersonId: "D1" }, { deliveryPersonId: "D1" }],
];
const ALL_PARTICIPANTS = [
  { participantType: "CUSTOMER", userId: "U1", vendorId: null, employeeId: null, deliveryPersonId: null },
  { participantType: "VENDOR", userId: null, vendorId: "V1", employeeId: null, deliveryPersonId: null },
  { participantType: "EMPLOYEE", userId: null, vendorId: null, employeeId: "E1", deliveryPersonId: null },
  { participantType: "ADMIN", userId: null, vendorId: null, employeeId: "E2", deliveryPersonId: null },
  { participantType: "DELIVERY", userId: null, vendorId: null, employeeId: null, deliveryPersonId: "D1" },
];

for (const [type, id, senderCols, notFilter] of SENDERS) {
  test(`send as ${type}: sender column, conversation summary, unread NOT filter, socket fan-out`, async () => {
    wireSend(ALL_PARTICIPANTS);
    const msg: any = await new MessageService().send({ conversationId: "C", messageType: "TEXT", content: "Hello There", clientId: `c-${type}` } as any, type as any, id);
    const created = calls.find((c) => c.op === "message.create")!.args;
    assert.deepEqual(
      { senderType: created.data.senderType, senderId: created.data.senderId, senderVendorId: created.data.senderVendorId, senderEmployeeId: created.data.senderEmployeeId, senderDeliveryPersonId: created.data.senderDeliveryPersonId },
      { senderType: type, ...senderCols },
    );
    assert.equal(created.data.contentSearch, "hello there");
    assert.equal(created.data.status, "SENT");
    assert.deepEqual(created.include, { media: true });
    const upd = calls.find((c) => c.op === "conversation.update")!.args;
    assert.deepEqual(upd.data, { lastMessageAt: new Date(10), lastMessageText: "Hello There", lastMessageType: "TEXT", lastSenderId: id, lastSenderType: type, lastMessageStatus: "SENT", messageCount: { increment: 1 } });
    const unread = calls.find((c) => c.op === "participant.updateMany")!.args;
    assert.deepEqual(unread, { where: { conversationId: "C", leftAt: null, NOT: notFilter }, data: { unreadCount: { increment: 1 } } });
    assert.equal(msg.id, "M1");

    await flush();
    const rooms = emitted.map((e) => `${e.event}@${e.room}`);
    assert.ok(rooms.includes("newMessage@conversation:C"), "conversation room");
    const personal = ALL_PARTICIPANTS.filter((p) => p.participantType !== type || (p.userId ?? p.vendorId ?? p.employeeId ?? p.deliveryPersonId) !== id);
    for (const p of personal) {
      const pid = p.userId ?? p.vendorId ?? p.employeeId ?? p.deliveryPersonId;
      assert.ok(rooms.includes(`newMessage@participant:${p.participantType}:${pid}`), `newMessage to ${p.participantType}`);
      assert.ok(rooms.includes(`conversationUpdated@participant:${p.participantType}:${pid}`));
    }
    assert.ok(!rooms.includes(`newMessage@participant:${type}:${id}`), "never the sender's own room");
    const summary = emitted.find((e) => e.event === "conversationUpdated")!.data;
    assert.deepEqual(Object.keys(summary).sort(), ["conversationId", "lastMessageAt", "lastMessageText", "lastMessageType", "lastSenderId", "lastSenderType"]);
  });
}

test("send: a participant row with no identity column is skipped in the fan-out; IMAGE/AUDIO summaries", async () => {
  wireSend([{ participantType: "CUSTOMER", userId: null, vendorId: null, employeeId: null, deliveryPersonId: null }, ALL_PARTICIPANTS[1]]);
  await new MessageService().send({ conversationId: "C", messageType: "IMAGE", clientId: "img-1" } as any, "CUSTOMER" as any, "U1");
  await flush();
  assert.deepEqual(emitted.filter((e) => e.room?.startsWith("participant:")).map((e) => e.room), ["participant:VENDOR:V1", "participant:VENDOR:V1"]);
  assert.equal(calls.find((c) => c.op === "conversation.update")!.args.data.lastMessageText, "📷 Photo");
});

test("send: duplicate clientId refused; 31st message in a minute refused; missing conversation", async () => {
  wireSend(ALL_PARTICIPANTS);
  const svc = new MessageService();
  await svc.send({ conversationId: "C", messageType: "TEXT", content: "a", clientId: "same" } as any, "CUSTOMER" as any, "U1");
  await assert.rejects(svc.send({ conversationId: "C", messageType: "TEXT", content: "a", clientId: "same" } as any, "CUSTOMER" as any, "U1"), /Duplicate message/);
  kv.set("chat:rate:U1", "30");
  await assert.rejects(svc.send({ conversationId: "C", messageType: "TEXT", content: "a", clientId: "x31" } as any, "CUSTOMER" as any, "U1"), /Rate limit exceeded/);
  kv.delete("chat:rate:U1");
  set(prisma.conversation, "findUnique", async () => null);
  await assert.rejects(svc.send({ conversationId: "C", messageType: "TEXT", content: "a", clientId: "x2" } as any, "CUSTOMER" as any, "U1"), /CONVERSATION_NOT_FOUND/);
  assert.equal(kv.has("chat:rate:U1"), true, "rate key is the bare sender id");
});

// ── read receipts ─────────────────────────────────────────────────────────

test("markAsRead: resets the participant's unread, upserts the receipt, clears redis keys, emits messageRead", async () => {
  set(prisma.conversationParticipant, "update", record("participant.update"));
  set(prisma.messageReceipt, "upsert", record("receipt.upsert"));
  await new ReadReceiptService().markAsRead("C", "P1", "M9", "U1");
  const upd = calls.find((c) => c.op === "participant.update")!.args;
  assert.equal(upd.where.id, "P1");
  assert.equal(upd.data.lastReadMessageId, "M9");
  assert.equal(upd.data.unreadCount, 0);
  assert.ok(upd.data.lastReadAt instanceof Date);
  const up = calls.find((c) => c.op === "receipt.upsert")!.args;
  assert.deepEqual(up.where, { messageId_participantId: { messageId: "M9", participantId: "P1" } });
  assert.deepEqual(calls.filter((c) => c.op === "redis.del").map((c) => c.args), ["chat:unread:total:U1", "chat:unread:P1"]);
  assert.deepEqual(emitted, [{ event: "messageRead", data: { conversationId: "C", participantId: "P1", messageId: "M9" }, room: "conversation:C" }]);
});
