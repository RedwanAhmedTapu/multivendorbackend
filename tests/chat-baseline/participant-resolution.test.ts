// tests/chat-baseline/participant-resolution.test.ts
//
// CHARACTERIZATION (agent-chat Stage 1): pins how the EXISTING chat resolves
// participants today, quirks included, before any refactor. If a later change
// makes one of these fail, existing chat behaviour changed.
//
// Quirks pinned on purpose:
//   - an unknown role maps to CUSTOMER (participantTypeForRole, findOrCreate);
//   - participantWhere / isSender treat any non-CUSTOMER/VENDOR/DELIVERY type as
//     ADMIN/EMPLOYEE (employeeId);
//   - getParticipantFilter (unread NOT filter) defaults to { userId };
//   - MessageRepository.getParticipantId with an unknown type adds NO identity
//     column (it would match any participant) — the read-receipt hole fixed in
//     Stage 4; that one test is labelled and is the only expected change.
//
// No database / Redis: Prisma delegates are patched in memory.
//   DATABASE_URL=postgresql://x@127.0.0.1:1/x DIRECT_URL=postgresql://x@127.0.0.1:1/x \
//   ACCESS_TOKEN_SECRET=… npx tsx --test tests/chat-baseline/*.test.ts

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const { prisma } = await import("../../src/config/prisma.ts");
const access = await import("../../src/modules/chat/utils/chat-access.ts");
const { getParticipantFilter } = await import("../../src/modules/chat/utils/helpers.ts");
const { MessageRepository } = await import("../../src/modules/chat/repositories/message.repository.ts");

const restores: Array<() => void> = [];
const set = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};
afterEach(() => {
  while (restores.length) restores.pop()!();
});

const TYPES = ["CUSTOMER", "VENDOR", "ADMIN", "EMPLOYEE", "DELIVERY"] as const;

test("participantTypeForRole: each role, case-insensitive; anything else → CUSTOMER", () => {
  assert.equal(access.participantTypeForRole("VENDOR"), "VENDOR");
  assert.equal(access.participantTypeForRole("vendor"), "VENDOR");
  assert.equal(access.participantTypeForRole("ADMIN"), "ADMIN");
  assert.equal(access.participantTypeForRole("EMPLOYEE"), "EMPLOYEE");
  assert.equal(access.participantTypeForRole("DELIVERY"), "DELIVERY");
  assert.equal(access.participantTypeForRole("CUSTOMER"), "CUSTOMER");
  for (const odd of ["USER", "AGENT", "", null, undefined, "SUPERADMIN"]) assert.equal(access.participantTypeForRole(odd as any), "CUSTOMER", String(odd));
});

test("actorFrom: null without id or role; otherwise the role-specific actor", () => {
  assert.equal(access.actorFrom(null), null);
  assert.equal(access.actorFrom({ id: "x" }), null);
  assert.equal(access.actorFrom({ role: "VENDOR" }), null);
  assert.deepEqual(access.actorFrom({ id: "V1", role: "vendor", vendorId: "V1" }), { id: "V1", participantType: "VENDOR", role: "VENDOR", vendorId: "V1", employeeId: null });
  assert.deepEqual(access.actorFrom({ id: "U1", role: "AGENT" }), { id: "U1", participantType: "CUSTOMER", role: "AGENT", vendorId: null, employeeId: null }, "unknown role → CUSTOMER");
});

test("participantWhere: identity column per type; ADMIN/EMPLOYEE and anything else → employeeId", () => {
  const w = (t: string) => access.participantWhere({ id: "I", participantType: t as any, role: t, vendorId: null, employeeId: null });
  assert.deepEqual(w("CUSTOMER"), { userId: "I" });
  assert.deepEqual(w("VENDOR"), { vendorId: "I" });
  assert.deepEqual(w("DELIVERY"), { deliveryPersonId: "I" });
  assert.deepEqual(w("ADMIN"), { employeeId: "I" });
  assert.deepEqual(w("EMPLOYEE"), { employeeId: "I" });
  assert.deepEqual(w("SOMETHING_NEW"), { employeeId: "I" }, "default branch");
});

test("personalRoom: participant:<TYPE>:<id>", () => {
  for (const t of TYPES) assert.equal(access.personalRoom({ id: "I", participantType: t, role: t, vendorId: null, employeeId: null }), `participant:${t}:I`);
});

test("isSender: per type; ADMIN/EMPLOYEE share employeeId; unknown types use the staff branch", () => {
  const msg = (senderType: string, col: string) => ({ senderType, senderId: null, senderVendorId: null, senderEmployeeId: null, senderDeliveryPersonId: null, [col]: "I" }) as any;
  const actor = (t: string) => ({ id: "I", participantType: t as any, role: t, vendorId: null, employeeId: null });
  assert.equal(access.isSender(msg("CUSTOMER", "senderId"), actor("CUSTOMER")), true);
  assert.equal(access.isSender(msg("VENDOR", "senderVendorId"), actor("VENDOR")), true);
  assert.equal(access.isSender(msg("DELIVERY", "senderDeliveryPersonId"), actor("DELIVERY")), true);
  assert.equal(access.isSender(msg("ADMIN", "senderEmployeeId"), actor("EMPLOYEE")), true, "an EMPLOYEE actor matches an ADMIN-typed message with its employeeId");
  assert.equal(access.isSender(msg("EMPLOYEE", "senderEmployeeId"), actor("ADMIN")), true);
  assert.equal(access.isSender(msg("CUSTOMER", "senderId"), actor("VENDOR")), false);
  assert.equal(access.isSender(msg("EMPLOYEE", "senderEmployeeId"), actor("NEW_TYPE")), true, "default branch");
});

test("getParticipantFilter (unread NOT filter): per type; default → { userId }", () => {
  assert.deepEqual(getParticipantFilter("CUSTOMER" as any, "I"), { userId: "I" });
  assert.deepEqual(getParticipantFilter("VENDOR" as any, "I"), { vendorId: "I" });
  assert.deepEqual(getParticipantFilter("ADMIN" as any, "I"), { employeeId: "I" });
  assert.deepEqual(getParticipantFilter("EMPLOYEE" as any, "I"), { employeeId: "I" });
  assert.deepEqual(getParticipantFilter("DELIVERY" as any, "I"), { deliveryPersonId: "I" });
  assert.deepEqual(getParticipantFilter("NEW_TYPE" as any, "I"), { userId: "I" }, "default branch");
});

test("MessageRepository.getParticipantId: where per type for the five known types", async () => {
  let seen: any;
  set(prisma.conversationParticipant, "findFirst", async (args: any) => ((seen = args.where), { id: "P" }));
  const repo = new MessageRepository();
  const cases: Array<[string, Record<string, string>]> = [
    ["CUSTOMER", { userId: "I" }],
    ["VENDOR", { vendorId: "I" }],
    ["DELIVERY", { deliveryPersonId: "I" }],
    ["EMPLOYEE", { employeeId: "I" }],
    ["ADMIN", { employeeId: "I" }],
  ];
  for (const [type, col] of cases) {
    assert.equal(await repo.getParticipantId("C", "I", type), "P");
    assert.deepEqual(seen, { conversationId: "C", leftAt: null, ...col }, type);
  }
});

test("[read-receipt hole — changed on purpose in Stage 4] getParticipantId with an unknown type adds no identity column", async () => {
  let seen: any;
  set(prisma.conversationParticipant, "findFirst", async (args: any) => ((seen = args.where), { id: "ANY" }));
  const id = await new MessageRepository().getParticipantId("C", "I", "SOMETHING_ELSE");
  assert.deepEqual(seen, { conversationId: "C", leftAt: null });
  assert.equal(id, "ANY");
});

test("getConversationAccess: participant row; support staff only on USER_/VENDOR_SUPPORT; vendor staff never", async () => {
  const convs: Record<string, any> = { CS: { id: "CS", type: "USER_SUPPORT" }, CV: { id: "CV", type: "VENDOR_SUPPORT" }, CP: { id: "CP", type: "PRODUCT_INQUIRY" } };
  const parts = [{ id: "P1", conversationId: "CP", userId: "U1", leftAt: null }];
  const emps: Record<string, any> = {
    E_SUP: { isActive: true, vendorId: null, permissions: { customerSupport: true } },
    E_NO: { isActive: true, vendorId: null, permissions: {} },
    E_VEN: { isActive: true, vendorId: "V1", permissions: { customerSupport: true } },
    E_OFF: { isActive: false, vendorId: null, permissions: { customerSupport: true } },
  };
  set(prisma.conversation, "findUnique", async ({ where }: any) => convs[where.id] ?? null);
  set(prisma.conversationParticipant, "findFirst", async ({ where }: any) => {
    const p = parts.find((x) => x.conversationId === where.conversationId && Object.entries(where).every(([k, v]) => k === "leftAt" || (x as any)[k] === v));
    return p ? { id: p.id } : null; // the code selects { id } only
  });
  set(prisma.employee, "findUnique", async ({ where }: any) => emps[where.id] ?? null);
  const actor = (role: string, id: string, extra: any = {}) => access.actorFrom({ id, role, ...extra })!;

  assert.deepEqual(await access.getConversationAccess("CP", actor("CUSTOMER", "U1")), { conversation: convs.CP, participant: { id: "P1" }, viaSupport: false });
  assert.equal(await access.getConversationAccess("CP", actor("CUSTOMER", "U2")), null);
  assert.equal(await access.getConversationAccess("NOPE", actor("ADMIN", "E")), null);
  assert.equal(await access.getConversationAccess("", actor("ADMIN", "E")), null);
  assert.equal((await access.getConversationAccess("CS", actor("ADMIN", "E_X")))?.viaSupport, true, "ADMIN on a support chat");
  assert.equal((await access.getConversationAccess("CV", actor("EMPLOYEE", "E_SUP", { employeeId: "E_SUP" })))?.viaSupport, true);
  assert.equal(await access.getConversationAccess("CP", actor("ADMIN", "E_X")), null, "not on product inquiries");
  assert.equal(await access.getConversationAccess("CS", actor("EMPLOYEE", "E_NO", { employeeId: "E_NO" })), null, "no customerSupport");
  assert.equal(await access.getConversationAccess("CS", actor("EMPLOYEE", "E_VEN", { employeeId: "E_VEN", vendorId: "V1" })), null, "vendor staff");
  assert.equal(await access.getConversationAccess("CS", actor("EMPLOYEE", "E_OFF", { employeeId: "E_OFF" })), null, "inactive employee");
  assert.equal(await access.getConversationAccess("CS", actor("VENDOR", "V1")), null);
});

test("SUPPORT_CONVERSATION_TYPES is exactly USER_SUPPORT and VENDOR_SUPPORT", () => {
  assert.deepEqual([...access.SUPPORT_CONVERSATION_TYPES], ["USER_SUPPORT", "VENDOR_SUPPORT"]);
});
