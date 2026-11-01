// tests/chat-participant-resolver.test.ts
//
// agent-chat Stage 2: the central participant resolver reproduces every
// mapping the chat module used to copy inline, including each caller's
// historical fallback for an unknown type. Pure functions, no DB.
//   npx tsx --test tests/chat-participant-resolver.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const r = await import("../src/modules/chat/utils/participant-resolver.ts");

const KNOWN: Array<[string, string, string]> = [
  ["CUSTOMER", "userId", "senderId"],
  ["VENDOR", "vendorId", "senderVendorId"],
  ["ADMIN", "employeeId", "senderEmployeeId"],
  ["EMPLOYEE", "employeeId", "senderEmployeeId"],
  ["DELIVERY", "deliveryPersonId", "senderDeliveryPersonId"],
];

test("identity and sender columns for every known type", () => {
  for (const [type, col, sender] of KNOWN) {
    assert.equal(r.identityColumnOf(type), col);
    assert.deepEqual(r.identityWhere(type, "I", "none"), { [col]: "I" });
    const ids = r.identityColumns(type, "I");
    assert.deepEqual(Object.entries(ids).filter(([, v]) => v !== null), [[col, "I"]], type);
    const s = r.senderColumns(type, "I");
    assert.deepEqual(Object.entries(s).filter(([, v]) => v !== null), [[sender, "I"]], type);
  }
});

test("unknown types: each caller's explicit historical fallback", () => {
  assert.equal(r.identityColumnOf("NEW"), null);
  assert.deepEqual(r.identityWhere("NEW", "I", "employeeId"), { employeeId: "I" });
  assert.deepEqual(r.identityWhere("NEW", "I", "userId"), { userId: "I" });
  assert.deepEqual(r.identityWhere("NEW", "I", "none"), {});
  assert.ok(Object.values(r.identityColumns("NEW", "I")).every((v) => v === null), "create: all null (as the old ternaries)");
  assert.ok(Object.values(r.senderColumns("NEW", "I")).every((v) => v === null));
  assert.equal(r.isOwnRow({ userId: "I" }, "NEW", "I"), false, "fan-out: unknown sender never matches");
  assert.equal(r.participantTypeForRole("NEW"), "CUSTOMER");
  assert.equal(r.participantTypeForRole(undefined), "CUSTOMER");
  assert.equal(r.participantTypeForRole("user"), "CUSTOMER");
});

test("ownerIdOf keeps the ?? order; isMessageSender keeps the staff branch", () => {
  assert.equal(r.ownerIdOf({ userId: null, vendorId: "V", employeeId: "E" }), "V");
  assert.equal(r.ownerIdOf({}), null);
  const m = (senderType: string, col: string) => ({ senderType, [col]: "I" }) as any;
  assert.equal(r.isMessageSender(m("CUSTOMER", "senderId"), "CUSTOMER", "I"), true);
  assert.equal(r.isMessageSender(m("VENDOR", "senderId"), "VENDOR", "I"), false);
  assert.equal(r.isMessageSender(m("ADMIN", "senderEmployeeId"), "EMPLOYEE", "I"), true);
  assert.equal(r.isMessageSender(m("EMPLOYEE", "senderEmployeeId"), "NEW", "I"), true, "unknown actor → staff branch");
});

test("no inline copies of the mapping are left in the chat module", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith("participant-resolver.ts")) files.push(p);
    }
  };
  walk(new URL("../src/modules/chat", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    assert.ok(!/\.userId \?\? \w+\.vendorId/.test(s), `${f}: inline owner-id chain`);
    assert.ok(!/=== "CUSTOMER" \? \w+(\.id)? : null/.test(s), `${f}: inline identity ternary`);
    assert.ok(!/case "CUSTOMER": return \{ userId/.test(s), `${f}: inline identity switch`);
  }
});
