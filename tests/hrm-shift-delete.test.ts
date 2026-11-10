// tests/hrm-shift-delete.test.ts
//
// PHASE F item 1a: the shift-delete OUTCOME CONTRACT the UI renders.
// DELETE /hrm/attendance/shifts/:id returns either
//   { deleted: true,  deactivated: false, message: "Shift deleted." }
// or
//   { deleted: false, deactivated: true,  message: "Shift deactivated (N
//     assignment(s) exist — historical references preserved)." }
// The Shifts tab toasts per outcome and re-renders (deleted rows disappear;
// deactivated rows show an Inactive chip and an Activate action). Run with:
//   npx tsx --test tests/hrm-shift-delete.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/config/prisma.ts";
import { shiftService } from "../src/modules/hrm/services/shift.service.ts";

type Spy = { calls: any[][]; callCount(): number; restore(): void };
function spyOn(obj: any, method: string, impl?: (...args: any[]) => unknown): Spy {
  const calls: any[][] = [];
  const original = obj[method];
  obj[method] = async (...args: any[]) => { calls.push(args); return impl ? impl(...args) : undefined; };
  return { calls, callCount: () => calls.length, restore: () => { obj[method] = original; } };
}

const SCOPE_A = { vendorId: "VEN_A", actorUserId: "U_A", role: "VENDOR" };

test("unassigned shift: hard delete with deleted=true outcome", async () => {
  const find = spyOn(prisma.hrShift, "findFirst", async () => ({ id: "S1", active: true, name: "Morning" }));
  const count = spyOn(prisma.hrShiftAssignment, "count", () => 0);
  const del = spyOn(prisma.hrShift, "delete", () => ({ id: "S1" }));
  const upd = spyOn(prisma.hrShift, "update", () => ({}));
  try {
    const r = await shiftService.remove(SCOPE_A, "S1");
    assert.equal(r.deleted, true);
    assert.equal(r.deactivated, false);
    assert.match(r.message, /[Dd]eleted/);
    assert.equal(del.callCount(), 1);
    assert.equal(upd.callCount(), 0, "no deactivation write for an unassigned shift");
  } finally { [find, count, del, upd].forEach((m) => m.restore()); }
});

test("assigned shift: deactivate with the assignment count in the message", async () => {
  const find = spyOn(prisma.hrShift, "findFirst", async () => ({ id: "S2", active: true, name: "Evening" }));
  const count = spyOn(prisma.hrShiftAssignment, "count", () => 3);
  const del = spyOn(prisma.hrShift, "delete", () => ({}));
  const upd = spyOn(prisma.hrShift, "update", ({ data }: any) => ({ id: "S2", ...data }));
  try {
    const r = await shiftService.remove(SCOPE_A, "S2");
    assert.equal(r.deleted, false);
    assert.equal(r.deactivated, true);
    assert.match(r.message, /3 assignment\(s\)/, "the UI toasts this message — count must be included");
    assert.equal(upd.calls[0][0].data.active, false);
    assert.equal(del.callCount(), 0, "history is preserved — no hard delete");
  } finally { [find, count, del, upd].forEach((m) => m.restore()); }
});

test("deactivated shift can be re-activated via update({ active: true })", async () => {
  const find = spyOn(prisma.hrShift, "findFirst", async () => ({ id: "S2", active: false, name: "Evening" }));
  const upd = spyOn(prisma.hrShift, "update", ({ data }: any) => ({ id: "S2", ...data }));
  try {
    const r = await shiftService.update(SCOPE_A, "S2", { active: true });
    assert.equal(r.active, true);
  } finally { [find, upd].forEach((m) => m.restore()); }
});
