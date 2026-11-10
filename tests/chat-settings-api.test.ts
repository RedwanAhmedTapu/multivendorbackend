// tests/chat-settings-api.test.ts
//
// Chat settings (vendor) — the management lists behind the settings screens,
// through the REAL chat router (authenticateUser + VENDOR guard) on 127.0.0.1.
// prisma.autoReply / prisma.quickReply are in-memory tables whose `where`
// matching drops undefined keys like Prisma 6.16.1 does. No database.
//   GET /chat/auto-replies/mine  — the vendor's own VENDOR rules, active AND
//     inactive (so a disabled rule can be re-enabled); never another vendor's,
//     never GLOBAL rows (platform or the historical vendor-owned GLOBAL kind);
//   GET /chat/quick-replies      — every row the vendor owns, active and
//     inactive; never another vendor's or a platform row;
//   both: the vendor id comes from the token (a ?vendorId= is ignored);
//   customers and admins are refused.
//   npx tsx --test tests/chat-settings-api.test.ts   (ACCESS_TOKEN_SECRET set)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";

const { prisma } = await import("../src/config/prisma.ts");
const { setupChatModule } = await import("../src/modules/chat/chat.module.ts");

type Row = Record<string, any>;
const SECRET = process.env.ACCESS_TOKEN_SECRET ?? "";
const USERS: Record<string, Row> = {
  U_VA: { id: "U_VA", role: "VENDOR", isActive: true, vendorId: "VA", name: "A", email: null },
  U_VB: { id: "U_VB", role: "VENDOR", isActive: true, vendorId: "VB", name: "B", email: null },
  U_CUST: { id: "U_CUST", role: "CUSTOMER", isActive: true, vendorId: null, name: "C", email: null },
  U_ADMIN: { id: "U_ADMIN", role: "ADMIN", isActive: true, vendorId: null, name: "Admin", email: null },
};
const AUTO: Row[] = [
  { id: "AR_A_ON", scope: "VENDOR", vendorId: "VA", isActive: true, createdAt: 1 },
  { id: "AR_A_OFF", scope: "VENDOR", vendorId: "VA", isActive: false, createdAt: 2 },
  { id: "AR_B", scope: "VENDOR", vendorId: "VB", isActive: true, createdAt: 3 },
  { id: "AR_PLATFORM", scope: "GLOBAL", vendorId: null, isActive: true, createdAt: 4 },
  { id: "AR_B_LEGACY_GLOBAL", scope: "GLOBAL", vendorId: "VB", isActive: true, createdAt: 5 },
];
const QUICK: Row[] = [
  { id: "QR_A_ON", scope: "VENDOR", vendorId: "VA", isActive: true, sortOrder: 0 },
  { id: "QR_A_OFF", scope: "VENDOR", vendorId: "VA", isActive: false, sortOrder: 1 },
  { id: "QR_B", scope: "VENDOR", vendorId: "VB", isActive: true, sortOrder: 0 },
  { id: "QR_B_LEGACY", scope: "GLOBAL", vendorId: "VB", isActive: true, sortOrder: 0 },
  { id: "QR_PLATFORM", scope: "GLOBAL", vendorId: null, isActive: true, sortOrder: 0 },
];
function matches(r: Row, where: Row): boolean {
  return Object.entries(where ?? {}).every(([k, v]) =>
    v === undefined ? true : k === "OR" ? (v as Row[]).some((c) => matches(r, c)) : (r[k] ?? null) === v
  );
}
const wheres: Row[] = [];
const restores: (() => void)[] = [];
const set = (o: any, k: string, v: any) => {
  const orig = o[k];
  o[k] = v;
  restores.push(() => (o[k] = orig));
};
let server: http.Server;
let base = "";
before(async () => {
  set(prisma.user, "findUnique", async ({ where }: Row) => (USERS[where.id] ? { ...USERS[where.id] } : null));
  set(prisma.vendor, "findUnique", async ({ where }: Row) => (["VA", "VB"].includes(where.id) ? { id: where.id, storeName: where.id, email: null } : null));
  set(prisma.employee, "findFirst", async () => ({ id: "E_ADMIN", vendorId: null }));
  set(prisma.autoReply, "findMany", async ({ where }: Row) => (wheres.push(where), AUTO.filter((r) => matches(r, where))));
  set(prisma.quickReply, "findMany", async ({ where }: Row) => (wheres.push(where), QUICK.filter((r) => matches(r, where))));
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
const tok = (id: string) => jwt.sign({ id, role: USERS[id].role }, SECRET, { algorithm: "HS256", expiresIn: "5m" });
async function get(who: string, path: string) {
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${tok(who)}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const ids = (r: { body: any }) => r.body.data.map((x: Row) => x.id).sort();

test("auto-replies/mine: own rules incl. inactive; never another vendor's or any GLOBAL row", async () => {
  assert.deepEqual(ids(await get("U_VA", "/auto-replies/mine")), ["AR_A_OFF", "AR_A_ON"]);
  assert.deepEqual(ids(await get("U_VB", "/auto-replies/mine")), ["AR_B"], "B's historical GLOBAL row is not listed as manageable");
  assert.deepEqual(ids(await get("U_VA", "/auto-replies/mine?vendorId=VB")), ["AR_A_OFF", "AR_A_ON"], "a client-supplied vendorId is ignored");
  assert.deepEqual(wheres.at(-1), { scope: "VENDOR", vendorId: "VA" });
});

test("quick-replies (list): own rows incl. inactive and the vendor's legacy row; never another vendor's or a platform row", async () => {
  assert.deepEqual(ids(await get("U_VA", "/quick-replies")), ["QR_A_OFF", "QR_A_ON"]);
  assert.deepEqual(ids(await get("U_VB", "/quick-replies")), ["QR_B", "QR_B_LEGACY"]);
  assert.deepEqual(ids(await get("U_VA", "/quick-replies?vendorId=VB")), ["QR_A_OFF", "QR_A_ON"]);
  assert.deepEqual(wheres.at(-1), { vendorId: "VA" });
});

test("customers and admins can't read the management lists", async () => {
  for (const who of ["U_CUST", "U_ADMIN"]) {
    assert.equal((await get(who, "/auto-replies/mine")).status, 403, who);
    assert.equal((await get(who, "/quick-replies")).status, 403, who);
  }
});
