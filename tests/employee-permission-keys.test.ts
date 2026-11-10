// tests/employee-permission-keys.test.ts
//
// Phase 1 S6: every employee permission write validates the incoming map.
//   - unknown key → 400; non-boolean value → 400; non-object → 400
//   - VENDOR actors cannot grant hrSalaryView / hrSalaryEdit / hrBankView (403)
//     on ANY path (create, update, permission patch) — previously only the
//     patch path checked this
//   - adManagement is a known, vendor-only key: a vendor owner may grant it to
//     its own staff; the admin paths (admin-side staff) refuse it (403)
//   - absent permissions, and the legacy empty-array shape, pass untouched
// The five writers are exercised through EmployeeController with
// employeeService stubbed — refused requests never reach the service.
//   npx tsx --test tests/employee-permission-keys.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validatePermissionPatch,
  KNOWN_PERMISSION_KEYS,
  BASE_PERMISSION_KEYS,
  VENDOR_ONLY_PERMISSION_KEYS,
} from "../src/middlewares/permission.middleware.ts";
import { EmployeeController } from "../src/controllers/employee.controller.ts";
import { employeeService } from "../src/services/employee.service.ts";
import { employeeProfileService } from "../src/modules/hrm/services/employeeProfile.service.ts";
import { fakeRes } from "./support/phase1-auth.ts";

const HR_KEYS = [
  "hrEmployeeView", "hrEmployeeCreate", "hrEmployeeEdit", "hrEmployeeDelete",
  "hrSalaryView", "hrSalaryEdit", "hrDocsUpload", "hrDocsVerify", "hrDocsDownload",
  "hrDocsDelete", "hrBankView", "hrOrgEdit", "hrLeaveTypesEdit",
];

// ── validator ───────────────────────────────────────────────────────────────

test("known keys = the module keys + 13 HR keys + adManagement and posAccess (vendor-only)", () => {
  assert.deepEqual([...KNOWN_PERMISSION_KEYS].sort(), [...BASE_PERMISSION_KEYS, ...HR_KEYS, "adManagement", "posAccess", "posDiscount", "posCredit", "posRefund", "posReports"].sort());
  assert.deepEqual([...VENDOR_ONLY_PERMISSION_KEYS], ["adManagement", "posAccess", "posDiscount", "posCredit", "posRefund", "posReports"]);
});

test("posAccess: grantable by a VENDOR owner only; posSubscriptionManagement: ADMIN only", () => {
  assert.deepEqual(validatePermissionPatch({ posAccess: true }, "VENDOR"), { ok: true });
  assert.equal((validatePermissionPatch({ posAccess: true }, "ADMIN") as any).status, 403, "admin-side staff never get vendor POS");
  assert.equal((validatePermissionPatch({ posAccess: true }, undefined) as any).status, 403);
  assert.deepEqual(validatePermissionPatch({ posSubscriptionManagement: true }, "ADMIN"), { ok: true });
  assert.equal((validatePermissionPatch({ posSubscriptionManagement: true }, "VENDOR") as any).status, 403);
  assert.equal((validatePermissionPatch({ posAccess: "yes" }, "VENDOR") as any).status, 400);
  for (const k of ["posDiscount", "posCredit", "posRefund", "posReports"]) {
    assert.deepEqual(validatePermissionPatch({ [k]: true }, "VENDOR"), { ok: true }, k);
    assert.equal((validatePermissionPatch({ [k]: true }, "ADMIN") as any).status, 403, k);
  }
});

test("every existing key with a boolean value is accepted for both actors", () => {
  const all = Object.fromEntries([...BASE_PERMISSION_KEYS, ...HR_KEYS].map((k) => [k, false]));
  assert.deepEqual(validatePermissionPatch(all, "ADMIN"), { ok: true });
  assert.deepEqual(validatePermissionPatch({ ...all, productManagement: true, hrDocsUpload: true }, "VENDOR"), { ok: true });
  assert.deepEqual(validatePermissionPatch({ hrSalaryView: true, hrBankView: true }, "ADMIN"), { ok: true }, "ADMIN holds everything non-vendor");
});

test("absent permissions and the legacy empty array are accepted", () => {
  for (const p of [undefined, null, []]) assert.deepEqual(validatePermissionPatch(p, "VENDOR"), { ok: true });
});

test("unknown keys → 400, naming them", () => {
  const r = validatePermissionPatch({ productManagement: true, superAdmin: true, __proto_x: false }, "ADMIN");
  assert.equal(r.ok, false);
  assert.equal((r as any).status, 400);
  assert.match((r as any).message, /superAdmin/);
});

test("non-boolean values → 400; non-object shapes → 400", () => {
  for (const v of ["true", 1, null, {}, []]) {
    const r = validatePermissionPatch({ productManagement: v }, "ADMIN");
    assert.equal((r as any).status, 400, JSON.stringify(v));
  }
  for (const p of ["productManagement", 1, true, ["productManagement"]]) {
    assert.equal((validatePermissionPatch(p, "ADMIN") as any).status, 400, JSON.stringify(p));
  }
});

test("VENDOR cannot grant sensitive HR keys (403); setting them false is fine", () => {
  for (const k of ["hrSalaryView", "hrSalaryEdit", "hrBankView"]) {
    assert.equal((validatePermissionPatch({ [k]: true }, "VENDOR") as any).status, 403, k);
    assert.deepEqual(validatePermissionPatch({ [k]: false }, "VENDOR"), { ok: true }, k);
  }
});

test("adManagement: grantable by VENDOR only; ADMIN paths refuse granting it (403)", () => {
  assert.deepEqual(validatePermissionPatch({ adManagement: true }, "VENDOR"), { ok: true });
  assert.equal((validatePermissionPatch({ adManagement: true }, "ADMIN") as any).status, 403);
  assert.equal((validatePermissionPatch({ adManagement: true }, undefined) as any).status, 403);
  assert.deepEqual(validatePermissionPatch({ adManagement: false }, "ADMIN"), { ok: true });
  assert.equal((validatePermissionPatch({ adManagement: "yes" }, "VENDOR") as any).status, 400);
});

// ── the five writers ────────────────────────────────────────────────────────

const ctrl = new EmployeeController();
const admin = { id: "E_ADMIN", rawId: "U_ADMIN", role: "ADMIN", vendorId: null, employeeId: "E_ADMIN" };
const vendor = { id: "V1", rawId: "U_VENDOR", role: "VENDOR", vendorId: "V1", employeeId: null };

type Writer = { name: string; method: (req: any, res: any) => Promise<unknown>; service: keyof typeof employeeService; user: any; body: any; params?: any };
const base = { name: "Staff", email: "s@example.test", password: "pw-123456", designation: "Ops", department: "Ops" };
const WRITERS: Writer[] = [
  { name: "admin create", method: ctrl.createAdminEmployee, service: "createAdminEmployee", user: admin, body: base },
  { name: "admin update", method: ctrl.updateAdminEmployee, service: "updateAdminEmployee", user: admin, body: {}, params: { employeeId: "E9" } },
  { name: "vendor create", method: ctrl.createVendorEmployee, service: "createVendorEmployee", user: vendor, body: base },
  { name: "vendor update", method: ctrl.updateVendorEmployee, service: "updateVendorEmployee", user: vendor, body: {}, params: { employeeId: "E9" } },
  { name: "permission patch (admin)", method: ctrl.updateEmployeePermissions, service: "updateEmployeePermissions", user: admin, body: {}, params: { employeeId: "E9" } },
  { name: "permission patch (vendor)", method: ctrl.updateEmployeePermissions, service: "updateEmployeePermissions", user: vendor, body: {}, params: { employeeId: "E9" } },
];

async function call(w: Writer, permissions: unknown) {
  const svc = employeeService as any;
  const prof = employeeProfileService as any;
  const orig = { s: svc[w.service], p: prof.ensureProfile };
  const calls: any[] = [];
  svc[w.service] = async (...args: any[]) => (calls.push(args), { id: "E9", userId: "U9", permissions });
  prof.ensureProfile = async () => ({ id: "HP9" });
  try {
    const res = fakeRes();
    await w.method.call(ctrl, { user: w.user, params: w.params ?? {}, body: { ...w.body, permissions }, query: {} }, res);
    return { status: res.statusCode, body: res.body, serviceCalls: calls.length };
  } finally {
    svc[w.service] = orig.s;
    prof.ensureProfile = orig.p;
  }
}

test("all five writers reject unknown keys and non-boolean values with 400, before the service", async () => {
  for (const w of WRITERS) {
    for (const bad of [{ productManagement: true, rootAccess: true }, { orderManagement: "yes" }]) {
      const r = await call(w, bad);
      assert.deepEqual([r.status, r.serviceCalls], [400, 0], `${w.name}: ${JSON.stringify(bad)}`);
    }
  }
});

test("vendor create, update and patch all refuse sensitive HR grants (403), before the service", async () => {
  for (const w of WRITERS.filter((x) => x.user === vendor)) {
    const r = await call(w, { hrSalaryView: true });
    assert.deepEqual([r.status, r.serviceCalls], [403, 0], w.name);
  }
});

test("admin create, update and patch refuse granting the vendor-only adManagement (403)", async () => {
  for (const w of WRITERS.filter((x) => x.user === admin)) {
    const r = await call(w, { adManagement: true });
    assert.deepEqual([r.status, r.serviceCalls], [403, 0], w.name);
  }
});

test("valid maps reach the service unchanged on every writer (vendor may grant adManagement)", async () => {
  for (const w of WRITERS) {
    const perms = w.user === vendor ? { productManagement: true, adManagement: true } : { productManagement: true, hrSalaryView: true };
    const r = await call(w, perms);
    assert.equal(r.serviceCalls, 1, `${w.name}: service called`);
    assert.ok(r.status === 200 || r.status === 201, `${w.name}: status ${r.status}`);
  }
});
