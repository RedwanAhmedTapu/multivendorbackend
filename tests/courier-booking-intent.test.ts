// tests/courier-booking-intent.test.ts
//
// PHASE 0 (courier booking safety): the booking-intent state machine in
// courierService.createCourierOrderForVendor — atomic claim, guarded
// confirm / reject / unknown, stale responses, CONFIRM_FAILED (never
// REJECTED), shipment fields read from the intent row, claim/cancel ordering,
// and the guarded vendorMarkReadyForPickup (T8).
//
// DB-free: the courier service's Prisma delegates and prismaDirect.$transaction
// are replaced by an in-memory courier_orders table whose updateMany applies
// the same WHERE predicate the service sends. Courier provider calls are
// stubbed — no courier API is ever contacted. NOTE: this proves the guard
// predicates, call order and transaction usage, NOT PostgreSQL isolation or
// rollback behaviour (that needs the separately-approved real-Postgres S4 run).
// Run with:
//   npx tsx --test tests/courier-booking-intent.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import courierService, {
  courierServiceDb,
  BOOKING_PENDING,
  BOOKING_UNKNOWN,
  BOOKING_CONFIRM_FAILED,
} from "../src/services/courier.service.ts";
import { prismaDirect } from "../src/config/prisma.ts";

// ── in-memory courier_orders ────────────────────────────────────────────────

type Row = Record<string, any>;

/** Evaluates the subset of Prisma WHERE syntax the courier code uses. */
function matches(row: Row, where: Record<string, any> = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as any[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const value = row[key] ?? null;
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("not" in cond && (cond.not === null ? value === null : value === cond.not)) return false;
      if ("in" in cond && !cond.in.includes(value)) return false;
      continue;
    }
    if (cond === null ? value !== null : value !== cond) return false;
  }
  return true;
}

function applyUpdateMany(rows: Row[], where: Row, data: Row) {
  const hit = rows.filter((r) => matches(r, where));
  for (const r of hit) Object.assign(r, data);
  return { count: hit.length };
}

const STEADFAST = {
  courierProviderId: "P_SF",
  courierName: "Steadfast",
  pricing: { courierProviderId: "P_SF", courierName: "Steadfast", deliveryCharge: 60, codCharge: 12, totalCharge: 72, estimatedDeliveryDays: 2 },
};

const intentRow = (over: Row = {}): Row => ({
  id: "INT1",
  orderId: "O1",
  vendorId: "V1",
  vendorOrderId: "VO1",
  warehouseId: "WH1",
  courierProviderId: "P_SF",
  merchantReference: "VO1-WH1",
  recipientName: "Real Recipient",
  recipientPhone: "01700000000",
  recipientAddress: "Real Address",
  deliveryLocationId: "LOC_CUST",
  itemDescription: "Shirt x1",
  itemQuantity: 1,
  itemWeight: 0.5,
  specialInstruction: null,
  codAmount: 1234,
  deliveryType: "STANDARD",
  shipmentKind: "REGULAR",
  status: "PENDING_PICKUP",
  courierStatus: BOOKING_PENDING,
  courierTrackingId: null,
  consignmentId: null,
  returnConsignmentId: null,
  pickupStoreId: null,
  ...over,
});

interface Options {
  /** Runs inside the stubbed provider call (may mutate rows to simulate a racing actor). */
  provider?: (args: any[]) => Promise<any> | any;
  /** Make the confirm transaction fail: "P2002" or a generic error. */
  confirmFails?: "P2002" | "generic";
  /** Make the CONFIRM_FAILED marker write fail too. */
  confirmFailedWriteFails?: boolean;
  areas?: boolean;
}

function setup(rows: Row[], opts: Options = {}) {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const had = Object.prototype.hasOwnProperty.call(obj, key);
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (had ? (obj[key] = orig) : delete obj[key]));
  };
  const db = courierServiceDb as any;
  const audits: Row[] = [];
  const history: Row[] = [];
  const providerCalls: any[][] = [];
  const pathaoCalls: any[][] = [];
  const log: string[] = [];

  set(db.courierOrder, "findFirst", async ({ where }: any) => {
    const r = rows.find((x) => matches(x, where));
    return r ? { ...r, courier_providers: { name: "Steadfast" } } : null;
  });
  set(db.courierOrder, "updateMany", async ({ where, data }: any) => {
    if (opts.confirmFailedWriteFails && data.courierStatus === BOOKING_CONFIRM_FAILED) throw new Error("simulated DB failure");
    log.push(`updateMany:${data.courierStatus ?? data.status}`);
    return applyUpdateMany(rows, where, data);
  });
  set(db.vendorWarehouse, "findFirst", async ({ where }: any) =>
    where.id === "WH1" && where.vendorId === "V1" ? { id: "WH1", locationId: "LOC_WH" } : null,
  );
  set(db.courierServicableAreas, "findFirst", async () => (opts.areas ? { id: "AREA" } : null));
  set(db.auditLog, "create", async ({ data }: any) => {
    audits.push(data);
    return data;
  });

  const tx = {
    courierOrder: {
      updateMany: async ({ where, data }: any) => {
        if (opts.confirmFails === "P2002") throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        if (opts.confirmFails === "generic") throw new Error("simulated connection loss");
        log.push(`tx.updateMany:${data.courierStatus ?? data.status}`);
        return applyUpdateMany(rows, where, data);
      },
      findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
    },
    courierTrackingHistory: {
      create: async ({ data }: any) => {
        history.push(data);
        return data;
      },
    },
  };
  set(prismaDirect as any, "$transaction", async (fn: any) => {
    const rowSnap = rows.map((r) => ({ ...r }));
    const histLen = history.length;
    log.push("tx:begin");
    try {
      const out = await fn(tx);
      log.push("tx:commit");
      return out;
    } catch (e) {
      rows.splice(0, rows.length, ...rowSnap);
      history.splice(histLen);
      log.push("tx:rollback");
      throw e;
    }
  });
  // The module's pooled client must never run the confirm/ready transactions.
  set(db, "$transaction", async () => assert.fail("booking writes must use prismaDirect.$transaction"));

  set(courierService, "steadfastCreateOrder", async (...args: any[]) => {
    providerCalls.push(args);
    if (opts.provider) return opts.provider(args);
    return { consignment: { tracking_code: "TRK1", consignment_id: 555 } };
  });
  set(courierService, "createPathaoOrder", async (...args: any[]) => {
    pathaoCalls.push(args);
    return { data: { consignment_id: "PA1" } };
  });
  set(courierService, "selectBestCourier", async () => STEADFAST);

  return {
    audits,
    history,
    providerCalls,
    pathaoCalls,
    log,
    restore: () => restores.reverse().forEach((r) => r()),
  };
}

const book = (input: Row = {}, vendorId = "V1") =>
  courierService.createCourierOrderForVendor("O1", vendorId, { intentId: "INT1", ...input } as any);

async function rejectsWith(p: Promise<unknown>, outcome: string) {
  try {
    await p;
  } catch (e: any) {
    assert.equal(e.courierBookingOutcome, outcome, `expected ${outcome}, got ${e.courierBookingOutcome}: ${e.message}`);
    return e;
  }
  assert.fail(`expected rejection with ${outcome}`);
}

// ── success path + database-sourced shipment ────────────────────────────────

test("success: claim → provider → guarded confirm + history in ONE prismaDirect transaction", async () => {
  const rows = [intentRow()];
  const env = setup(rows);
  try {
    const out = await book({ preselectedCourier: STEADFAST });
    assert.equal(out.courierOrder.id, "INT1");
    assert.equal(env.providerCalls.length, 1);
    assert.equal(rows[0].courierTrackingId, "TRK1");
    assert.equal(rows[0].courierStatus, "Order Created");
    assert.equal(rows[0].status, "PENDING_PICKUP");
    assert.equal(env.history.length, 1);
    const confirmIdx = env.log.indexOf("tx.updateMany:Order Created");
    assert.ok(env.log[confirmIdx - 1] === "tx:begin" && env.log[confirmIdx + 1] === "tx:commit", "confirm runs inside the transaction");
  } finally {
    env.restore();
  }
});

test("shipment fields come from the intent row — client-supplied values are ignored", async () => {
  const rows = [intentRow()];
  const env = setup(rows);
  try {
    await book({
      recipientName: "Attacker",
      recipientAddress: "Elsewhere",
      recipientPhone: "01999999999",
      codAmount: 1,
      merchantReference: "FORGED-REF",
      preselectedCourier: undefined,
    });
    const [, payload] = env.providerCalls[0];
    assert.equal(payload.invoice, "VO1-WH1");
    assert.equal(payload.recipient_name, "Real Recipient");
    assert.equal(payload.recipient_address, "Real Address");
    assert.equal(payload.recipient_phone, "01700000000");
    assert.equal(payload.cod_amount, 1234);
  } finally {
    env.restore();
  }
});

test("a preselected courier different from the intent's courier is refused before any write", async () => {
  const rows = [intentRow()];
  const env = setup(rows);
  try {
    await rejectsWith(book({ preselectedCourier: { ...STEADFAST, courierProviderId: "P_OTHER" } }), "NOT_CLAIMED");
    assert.equal(env.providerCalls.length, 0);
    assert.equal(rows[0].courierStatus, BOOKING_PENDING, "row untouched");
  } finally {
    env.restore();
  }
});

test("cross-vendor: another vendor's intent cannot be claimed (no write, no provider call)", async () => {
  const rows = [intentRow()];
  const env = setup(rows);
  try {
    await rejectsWith(book({}, "V2"), "NOT_CLAIMED");
    assert.equal(env.providerCalls.length, 0);
    assert.equal(rows[0].courierStatus, BOOKING_PENDING);
  } finally {
    env.restore();
  }
});

// ── claimability ────────────────────────────────────────────────────────────

for (const [label, over] of [
  ["claimed (in flight)", { courierStatus: "Booking submitting [claim:other]" }],
  ["UNKNOWN", { courierStatus: BOOKING_UNKNOWN }],
  ["CONFIRM_FAILED", { courierStatus: BOOKING_CONFIRM_FAILED }],
  ["legacy 'Booking in progress'", { courierStatus: "Booking in progress" }],
  ["already booked", { courierTrackingId: "TRK_OLD", courierStatus: "Order Created" }],
  ["cancelled", { status: "CANCELLED", courierStatus: "Booking rejected: x" }],
] as const) {
  test(`not claimable: ${label} → NOT_CLAIMED, zero provider calls, row unchanged`, async () => {
    const rows = [intentRow(over as Row)];
    const before = { ...rows[0] };
    const env = setup(rows);
    try {
      await rejectsWith(book({ preselectedCourier: STEADFAST }), "NOT_CLAIMED");
      assert.equal(env.providerCalls.length, 0);
      assert.deepEqual(rows[0], before);
    } finally {
      env.restore();
    }
  });
}

// ── concurrent claims ───────────────────────────────────────────────────────

test("concurrent claims (markForDelivery + admin /orders/create): exactly ONE provider call", async () => {
  const rows = [intentRow()];
  const env = setup(rows, {
    provider: async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { consignment: { tracking_code: "TRK1", consignment_id: 555 } };
    },
  });
  try {
    const results = await Promise.allSettled([
      book({ preselectedCourier: STEADFAST }), // markForDelivery (server preselection)
      book({}), // admin /orders/create (intent id only)
      book({}),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(env.providerCalls.length, 1, "only the claim winner contacts the provider");
    assert.equal(ok.length, 1);
    assert.equal(refused.length, 2);
    for (const r of refused) assert.equal(r.reason.courierBookingOutcome, "NOT_CLAIMED");
    assert.equal(rows[0].courierTrackingId, "TRK1");
  } finally {
    env.restore();
  }
});

// ── provider outcomes (T4 / T5) ─────────────────────────────────────────────

test("REJECTED (confirmed validation rejection): intent cancelled — the only outcome that frees the slot", async () => {
  const rows = [intentRow()];
  const env = setup(rows, {
    provider: () => {
      throw Object.assign(new Error("Request failed with status code 422"), {
        isAxiosError: true,
        response: { status: 422, data: { message: "invalid", errors: { recipient_phone: ["The recipient phone format is invalid."] } } },
      });
    },
  });
  try {
    await rejectsWith(book({ preselectedCourier: STEADFAST }), "REJECTED");
    assert.equal(rows[0].status, "CANCELLED");
    assert.equal(env.history.length, 0);
  } finally {
    env.restore();
  }
});

test("UNKNOWN (no provider response): intent marked unknown and stays PENDING_PICKUP (slot occupied)", async () => {
  const rows = [intentRow()];
  const env = setup(rows, {
    provider: () => {
      throw Object.assign(new Error("socket hang up"), { isAxiosError: true, request: {} });
    },
  });
  try {
    await rejectsWith(book({ preselectedCourier: STEADFAST }), "UNKNOWN");
    assert.equal(rows[0].status, "PENDING_PICKUP");
    assert.equal(rows[0].courierStatus, BOOKING_UNKNOWN);
  } finally {
    env.restore();
  }
});

test("local pre-provider failure (no coverage) → REJECTED with the original message, provider never called", async () => {
  const rows = [intentRow({ courierProviderId: "P_PA" })];
  const env = setup(rows, { areas: false });
  try {
    const pathao = { courierProviderId: "P_PA", courierName: "Pathao", pricing: { ...STEADFAST.pricing, courierProviderId: "P_PA", courierName: "Pathao" } };
    const err = await rejectsWith(book({ preselectedCourier: pathao }), "REJECTED");
    assert.match(err.message, /Service area mapping not found for selected courier/, "markForDelivery's reallocation keys on this text");
    assert.equal(env.pathaoCalls.length, 0);
    assert.equal(rows[0].status, "CANCELLED");
  } finally {
    env.restore();
  }
});

test("stale outcome: REJECTED arrives after the claim marker changed → STALE, row untouched, audited", async () => {
  const rows = [intentRow()];
  const env = setup(rows, {
    provider: () => {
      rows[0].courierStatus = "Changed by another actor";
      throw Object.assign(new Error("bad request"), { response: { status: 400, data: {} } });
    },
  });
  try {
    await rejectsWith(book({ preselectedCourier: STEADFAST }), "STALE");
    assert.equal(rows[0].status, "PENDING_PICKUP");
    assert.equal(rows[0].courierStatus, "Changed by another actor");
    assert.ok(env.audits.some((a) => a.action === "COURIER_STALE_OUTCOME"));
  } finally {
    env.restore();
  }
});

// ── stale / failed confirmation (T3) ────────────────────────────────────────

test("stale confirmation: claim changed during the provider call → STALE, no row write, no history, audited", async () => {
  const rows = [intentRow()];
  const env = setup(rows, {
    provider: () => {
      rows[0].courierStatus = "Changed by another actor";
      return { consignment: { tracking_code: "TRK_LATE", consignment_id: 9 } };
    },
  });
  try {
    await rejectsWith(book({ preselectedCourier: STEADFAST }), "STALE");
    assert.equal(rows[0].courierTrackingId, null, "a stale response never overwrites the newer state");
    assert.equal(rows[0].courierStatus, "Changed by another actor");
    assert.equal(env.history.length, 0);
    const audit = env.audits.find((a) => a.action === "COURIER_STALE_CONFIRMATION");
    assert.ok(audit);
    assert.equal(audit!.newData.providerTrackingId, "TRK_LATE");
  } finally {
    env.restore();
  }
});

test("P2002 on the tracking id during confirm → STALE (audited), never REJECTED", async () => {
  const rows = [intentRow()];
  const env = setup(rows, { confirmFails: "P2002" });
  try {
    await rejectsWith(book({ preselectedCourier: STEADFAST }), "STALE");
    assert.notEqual(rows[0].status, "CANCELLED");
    assert.ok(env.audits.some((a) => a.action === "COURIER_STALE_CONFIRMATION"));
  } finally {
    env.restore();
  }
});

test("provider success + confirm write failure → CONFIRM_FAILED, never REJECTED; slot stays occupied", async () => {
  const rows = [intentRow()];
  const env = setup(rows, { confirmFails: "generic" });
  try {
    const err = await rejectsWith(book({ preselectedCourier: STEADFAST }), "CONFIRM_FAILED");
    assert.notEqual(err.courierBookingOutcome, "REJECTED");
    assert.equal(rows[0].status, "PENDING_PICKUP", "never cancelled — the shipment exists at the provider");
    assert.equal(rows[0].courierStatus, BOOKING_CONFIRM_FAILED);
    assert.equal(env.history.length, 0);
    const audit = env.audits.find((a) => a.action === "COURIER_CONFIRM_FAILED");
    assert.equal(audit?.newData.providerTrackingId, "TRK1");
  } finally {
    env.restore();
  }
});

test("confirm failure AND the CONFIRM_FAILED write failing → still CONFIRM_FAILED; the claim marker keeps the row blocked", async () => {
  const rows = [intentRow()];
  const env = setup(rows, { confirmFails: "generic", confirmFailedWriteFails: true });
  try {
    await rejectsWith(book({ preselectedCourier: STEADFAST }), "CONFIRM_FAILED");
    assert.equal(rows[0].status, "PENDING_PICKUP");
    assert.match(rows[0].courierStatus, /^Booking submitting \[claim:/);
    // ...and that row can never be claimed again.
    await rejectsWith(book({ preselectedCourier: STEADFAST }), "NOT_CLAIMED");
    assert.equal(env.providerCalls.length, 1);
  } finally {
    env.restore();
  }
});

// ── claim / cancel ordering ─────────────────────────────────────────────────

test("cancel BEFORE claim: the claim finds a cancelled row → NOT_CLAIMED, no provider call", async () => {
  const rows = [intentRow()];
  const env = setup(rows);
  try {
    const fakeTx = {
      courierOrder: { updateMany: async ({ where, data }: any) => applyUpdateMany(rows, where, data) },
      courierTrackingHistory: { create: async ({ data }: any) => data },
    };
    const res = await courierService.cancelCourierOrder("INT1", fakeTx as any);
    assert.equal(res.cancelled, true);
    await rejectsWith(book({ preselectedCourier: STEADFAST }), "NOT_CLAIMED");
    assert.equal(env.providerCalls.length, 0);
  } finally {
    env.restore();
  }
});

test("claim BEFORE cancel: a cancel during the provider call is refused; the confirm then succeeds", async () => {
  const rows = [intentRow()];
  const fakeTx = {
    courierOrder: { updateMany: async ({ where, data }: any) => applyUpdateMany(rows, where, data) },
    courierTrackingHistory: { create: async ({ data }: any) => data },
  };
  let cancelResult: { cancelled: boolean } | undefined;
  const env = setup(rows, {
    provider: async () => {
      cancelResult = await courierService.cancelCourierOrder("INT1", fakeTx as any);
      return { consignment: { tracking_code: "TRK1", consignment_id: 555 } };
    },
  });
  try {
    await book({ preselectedCourier: STEADFAST });
    assert.equal(cancelResult?.cancelled, false, "a claimed intent is never cancelled");
    assert.equal(rows[0].courierTrackingId, "TRK1");
    assert.equal(rows[0].status, "PENDING_PICKUP");
  } finally {
    env.restore();
  }
});

// ── T8: vendorMarkReadyForPickup (route stays unreachable; service hardened) ──

test("T8: an unbooked intent cannot be marked ready — 0 rows updated, NO history row", async () => {
  const rows = [intentRow()];
  const env = setup(rows);
  try {
    await assert.rejects(courierService.vendorMarkReadyForPickup("V1", "O1"), /only a booked/);
    assert.equal(rows[0].status, "PENDING_PICKUP");
    assert.equal(env.history.length, 0);
  } finally {
    env.restore();
  }
});

test("T8: a booked REGULAR shipment moves to READY_FOR_PICKUP with its history row in the same transaction", async () => {
  const rows = [intentRow({ courierTrackingId: "TRK1", courierStatus: "Order Created" })];
  const env = setup(rows);
  try {
    const out = await courierService.vendorMarkReadyForPickup("V1", "O1");
    assert.equal(out.order.status, "READY_FOR_PICKUP");
    assert.equal(env.history.length, 1);
    assert.equal(env.history[0].status, "READY_FOR_PICKUP");
    const i = env.log.indexOf("tx.updateMany:Package ready for pickup");
    assert.ok(env.log[i - 1] === "tx:begin" && env.log[i + 1] === "tx:commit");
  } finally {
    env.restore();
  }
});

test("T8: another vendor's shipment is never found (vendor-scoped lookup)", async () => {
  const rows = [intentRow({ courierTrackingId: "TRK1", courierStatus: "Order Created" })];
  const env = setup(rows);
  try {
    await assert.rejects(courierService.vendorMarkReadyForPickup("V2", "O1"), /Courier order not found/);
    assert.equal(rows[0].status, "PENDING_PICKUP");
    assert.equal(env.history.length, 0);
  } finally {
    env.restore();
  }
});
