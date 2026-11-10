// tests/offer-approval-transitions.test.ts
//
// Phase 1 S4: PATCH /api/offers/admin/:offerId/approve
//   - only PENDING → APPROVED / REJECTED, via a conditional claim
//     (updateMany WHERE id AND status = PENDING); anything else → 409
//   - double approval, approve-after-reject, reject-after-approve → 409
//   - two concurrent decisions: exactly one wins, the other gets 409
//   - rejecting needs a non-empty reason (400), stored in the audit record
//   - the audit is an AuditLog row written in the same transaction as the
//     claim; its actor is the admin's User id (req.user.rawId): AuditLog.user
//     references User, while req.user.id is the provisioned Employee id.
//     (The old logOfferActivity sink, ActivityLog, is not in the generated
//     client, so it never recorded anything.)
//   - `approved` must be a boolean (400)
// DB-free: this module's Prisma delegates are stubbed in place (offerServiceDb).
// The stub claim mirrors the SQL guard (it only updates a PENDING row); true
// database-level concurrency needs a real test database (not run here).
//   npx tsx --test tests/offer-approval-transitions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { offerServiceDb, AdminOfferService, OfferTransitionError } from "../src/services/offer.service.ts";
import { AdminOfferController } from "../src/controllers/offers.controller.ts";
import { fakeRes } from "./support/phase1-auth.ts";

/** One in-memory offer row; the stubbed updateMany honours the WHERE status. */
function stubDb(initial: string | null) {
  const db = offerServiceDb as any;
  const state = { status: initial, isActive: false, claims: [] as any[], logs: [] as any[] };
  const orig = {
    updateMany: db.offer.updateMany,
    findUnique: db.offer.findUnique,
    findUniqueOrThrow: db.offer.findUniqueOrThrow,
    update: db.offer.update,
    log: db.auditLog.create,
    tx: db.$transaction,
  };
  db.offer.updateMany = async (args: any) => {
    state.claims.push(args);
    await new Promise((r) => setImmediate(r)); // let concurrent callers interleave
    if (state.status === null || args.where.status !== state.status) return { count: 0 };
    state.status = args.data.status;
    state.isActive = args.data.isActive;
    return { count: 1 };
  };
  db.offer.findUnique = async () => (state.status === null ? null : { status: state.status });
  db.offer.findUniqueOrThrow = async ({ where }: any) => ({ id: where.id, status: state.status, isActive: state.isActive });
  db.offer.update = async () => {
    throw new Error("unconditional offer.update must not be used for approval");
  };
  db.auditLog.create = async (args: any) => (state.logs.push(args), {});
  // Interactive transaction: run the callback against the same stubbed delegates.
  db.$transaction = async (fn: any) => fn(db);
  return {
    state,
    restore: () => {
      db.offer.updateMany = orig.updateMany;
      db.offer.findUnique = orig.findUnique;
      db.offer.findUniqueOrThrow = orig.findUniqueOrThrow;
      db.offer.update = orig.update;
      db.auditLog.create = orig.log;
      db.$transaction = orig.tx;
    },
  };
}

const svc = new AdminOfferService();

async function expectTransitionError(p: Promise<unknown>, status: number) {
  await assert.rejects(p, (e: any) => e instanceof OfferTransitionError && e.statusCode === status);
}

test("PENDING → APPROVED: conditional claim on status PENDING, AuditLog row by the admin User id", async () => {
  const s = stubDb("PENDING");
  try {
    const offer: any = await svc.approveVendorOffer("U_ADMIN", "O1", true);
    assert.equal(offer.status, "APPROVED");
    assert.deepEqual(s.state.claims[0].where, { id: "O1", status: "PENDING" });
    assert.deepEqual(s.state.claims[0].data, { status: "APPROVED", isActive: true });
    assert.equal(s.state.logs.length, 1);
    assert.deepEqual(s.state.logs[0].data, {
      userId: "U_ADMIN",
      action: "OFFER_APPROVED",
      entity: "Offer",
      entityId: "O1",
      oldData: { status: "PENDING" },
      newData: { status: "APPROVED" },
    });
  } finally {
    s.restore();
  }
});

test("PENDING → REJECTED with a reason: reason (trimmed) kept in the audit record", async () => {
  const s = stubDb("PENDING");
  try {
    const offer: any = await svc.approveVendorOffer("U_ADMIN", "O1", false, "  Discount above policy  ");
    assert.equal(offer.status, "REJECTED");
    assert.equal(s.state.logs[0].data.action, "OFFER_REJECTED");
    assert.deepEqual(s.state.logs[0].data.newData, { status: "REJECTED", reason: "Discount above policy" });
  } finally {
    s.restore();
  }
});

test("rejecting without a reason (missing, empty, whitespace) → 400 and nothing changes", async () => {
  for (const reason of [undefined, "", "   "]) {
    const s = stubDb("PENDING");
    try {
      await expectTransitionError(svc.approveVendorOffer("U_ADMIN", "O1", false, reason), 400);
      assert.deepEqual([s.state.status, s.state.claims.length, s.state.logs.length], ["PENDING", 0, 0], String(reason));
    } finally {
      s.restore();
    }
  }
});

test("double approval, approve-after-reject, reject-after-approve → 409, no audit", async () => {
  for (const [from, approved] of [["APPROVED", true], ["REJECTED", true], ["APPROVED", false], ["ACTIVE", true], ["EXPIRED", false]] as const) {
    const s = stubDb(from);
    try {
      await expectTransitionError(svc.approveVendorOffer("U_ADMIN", "O1", approved, "reason"), 409);
      assert.deepEqual([s.state.status, s.state.logs.length], [from, 0], `${from} → ${approved}`);
    } finally {
      s.restore();
    }
  }
});

test("a missing offer → 404", async () => {
  const s = stubDb(null);
  try {
    await expectTransitionError(svc.approveVendorOffer("U_ADMIN", "nope", true), 404);
  } finally {
    s.restore();
  }
});

test("concurrent approve + reject: exactly one wins, the other is 409", async () => {
  const s = stubDb("PENDING");
  try {
    const results = await Promise.allSettled([
      svc.approveVendorOffer("U_ADMIN", "O1", true),
      svc.approveVendorOffer("U_ADMIN2", "O1", false, "late"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const conflicts = results.filter((r) => r.status === "rejected" && (r.reason as any).statusCode === 409);
    assert.deepEqual([ok.length, conflicts.length, s.state.logs.length], [1, 1, 1]);
  } finally {
    s.restore();
  }
});

test("AuditLog exists in the generated client and its user relation is User; ActivityLog does not exist", () => {
  const models = Prisma.dmmf.datamodel.models;
  const audit = models.find((m) => m.name === "AuditLog")!;
  assert.ok(audit, "AuditLog model");
  assert.equal(audit.fields.find((f) => f.name === "user")!.type, "User");
  for (const f of ["userId", "action", "entity", "entityId", "oldData", "newData"]) assert.ok(audit.fields.some((x) => x.name === f), f);
  assert.equal(models.some((m) => m.name === "ActivityLog"), false);
});

// ── controller ──────────────────────────────────────────────────────────────

const ctrl = new AdminOfferController();
const adminUser = { id: "EMP_ADMIN", rawId: "U_ADMIN", role: "ADMIN", vendorId: null, employeeId: "EMP_ADMIN" };

async function approveReq(body: any, user: any = adminUser) {
  const res = fakeRes();
  let forwarded: unknown;
  await ctrl.approveVendorOffer({ user, params: { offerId: "O1" }, body } as any, res, (e: unknown) => (forwarded = e));
  return { status: res.statusCode, body: res.body, forwarded };
}

test("controller: audit actor is req.user.rawId (User id), not the Employee id", async () => {
  const s = stubDb("PENDING");
  try {
    const r = await approveReq({ approved: true });
    assert.equal(r.status, 200);
    assert.equal(s.state.logs[0].data.userId, "U_ADMIN");
  } finally {
    s.restore();
  }
});

test("controller: 400 for a non-boolean `approved`, a non-string or missing reject reason; 409 on a second decision", async () => {
  const s = stubDb("PENDING");
  try {
    for (const body of [{}, { approved: "true" }, { approved: 1 }, { approved: false }, { approved: false, reason: "  " }, { approved: false, reason: 42 }]) {
      const r = await approveReq(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.success, false);
    }
    assert.equal(s.state.status, "PENDING", "nothing changed by the refused requests");
    assert.equal((await approveReq({ approved: false, reason: "Not allowed" })).status, 200);
    const again = await approveReq({ approved: true });
    assert.equal(again.status, 409);
    assert.match(again.body.message, /REJECTED/);
  } finally {
    s.restore();
  }
});

test("controller: no authenticated user → 401", async () => {
  assert.equal((await approveReq({ approved: true }, null)).status, 401);
});
