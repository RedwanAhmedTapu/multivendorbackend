// tests/courier-redaction.test.ts
//
// PHASE 0: courier credentials never reach logs or the global error handler.
// A fake Axios error carries Api-Key / Secret-Key / Authorization /
// API-ACCESS-TOKEN headers plus tokens in its response body; none of those
// values may appear in captured console output or in the error passed to
// `next()`. Covers the helpers, the two previously raw log sites
// (selectBestCourier pricing loop, vendorMarkReadyForPickup notify block), the
// booking provider-failure log, and controller error forwarding.
//
// DB-free (Prisma delegates stubbed; no courier API contacted). Run with:
//   npx tsx --test tests/courier-redaction.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { redactSecrets, describeCourierError, sanitizeCourierError } from "../src/lib/courier/redact.ts";
import courierService, { courierServiceDb, BOOKING_PENDING } from "../src/services/courier.service.ts";
import courierController from "../src/controllers/courier.controller.ts";
import { prismaDirect } from "../src/config/prisma.ts";

const SECRETS = [
  "SF-API-KEY-1111",
  "SF-SECRET-KEY-2222",
  "PATHAO-BEARER-3333",
  "REDX-ACCESS-4444",
  "BODY-ACCESS-TOKEN-5555",
  "BODY-REFRESH-6666",
  "ECHOED-BEARER-7777",
  "CLIENT-SECRET-8888",
  "PASSWORD-9999",
];

function fakeAxiosError(message = "Request failed with status code 401") {
  const err: any = new Error(message);
  err.isAxiosError = true;
  err.config = {
    url: "https://portal.example/api/v1/create_order",
    headers: {
      "Api-Key": SECRETS[0],
      "Secret-Key": SECRETS[1],
      Authorization: `Bearer ${SECRETS[2]}`,
      "API-ACCESS-TOKEN": `Bearer ${SECRETS[3]}`,
    },
    data: JSON.stringify({ client_secret: SECRETS[7], password: SECRETS[8] }),
  };
  err.request = { _header: `POST /x HTTP/1.1\r\nApi-Key: ${SECRETS[0]}\r\nSecret-Key: ${SECRETS[1]}` };
  err.response = {
    status: 401,
    headers: { authorization: `Bearer ${SECRETS[2]}` },
    config: err.config,
    data: {
      message: "Unauthorized",
      access_token: SECRETS[4],
      refresh_token: SECRETS[5],
      echo: `Bearer ${SECRETS[6]}`,
      nested: { client_secret: SECRETS[7], password: SECRETS[8] },
    },
  };
  return err;
}

function assertNoSecrets(text: string, where: string) {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${where} leaked ${s}`);
}

/** Captures console.error/warn/log output (deeply inspected) during fn. */
async function captureConsole(fn: () => Promise<unknown>) {
  const out: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const sink = (...args: unknown[]) => out.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 20 }))).join(" "));
  console.error = sink;
  console.warn = sink;
  console.log = sink;
  try {
    await fn();
  } catch {
    /* outcome asserted by the caller */
  } finally {
    Object.assign(console, orig);
  }
  return out.join("\n");
}

// ── helpers ─────────────────────────────────────────────────────────────────

test("redactSecrets masks secret keys case/format-insensitively and never mutates its input", () => {
  const input = { "Api-Key": SECRETS[0], secret_key: SECRETS[1], AUTHORIZATION: "x", nested: [{ accessToken: SECRETS[4] }], keep: "ok" };
  const out: any = redactSecrets(input);
  assertNoSecrets(inspect(out, { depth: 20 }), "redactSecrets");
  assert.equal(out.keep, "ok");
  assert.equal(input["Api-Key"], SECRETS[0], "input untouched");
});

test("describeCourierError keeps message/status/redacted body only", () => {
  const d = describeCourierError(fakeAxiosError());
  assertNoSecrets(inspect(d, { depth: 20 }), "describeCourierError");
  assert.equal(d.status, 401);
  assert.equal((d.providerData as any).message, "Unauthorized");
});

test("sanitizeCourierError drops config/request/response and keeps the booking outcome", () => {
  const raw = fakeAxiosError();
  raw.courierBookingOutcome = "UNKNOWN";
  const safe = sanitizeCourierError(raw);
  assertNoSecrets(inspect(safe, { depth: 20, showHidden: true }), "sanitizeCourierError");
  assert.equal(safe.config, undefined);
  assert.equal(safe.request, undefined);
  assert.equal(safe.response, undefined);
  assert.equal(safe.courierBookingOutcome, "UNKNOWN");
});

test("sanitizeCourierError passes non-HTTP errors through unchanged (existing error handling preserved)", () => {
  const appErr = Object.assign(new Error("plain"), { statusCode: 404 });
  assert.equal(sanitizeCourierError(appErr), appErr);
});

// ── log call sites ──────────────────────────────────────────────────────────

test("selectBestCourier pricing failure log (former raw `error` at the pricing loop) contains no secret", async () => {
  const db = courierServiceDb as any;
  const origFind = db.courierProviders.findMany;
  db.courierProviders.findMany = async () => [{ id: "P_SF", name: "Steadfast", courier_credentials: [] }];
  (courierService as any).getSteadfastPricing = async () => {
    throw fakeAxiosError();
  };
  try {
    const logs = await captureConsole(() =>
      courierService.selectBestCourier({
        vendorWarehouseLocationId: "L1",
        customerDeliveryLocationId: "L2",
        orderWeight: 1,
        codAmount: 100,
        deliveryType: "NORMAL",
      }),
    );
    assert.match(logs, /Failed to get pricing from Steadfast/);
    assertNoSecrets(logs, "pricing log");
  } finally {
    db.courierProviders.findMany = origFind;
    delete (courierService as any).getSteadfastPricing; // own-property stub → prototype method again
  }
});

test("vendorMarkReadyForPickup notify-block log (former raw `error`) contains no secret", async () => {
  const db = courierServiceDb as any;
  const origFind = db.courierOrder.findFirst;
  const origTx = (prismaDirect as any).$transaction;
  db.courierOrder.findFirst = async () => ({
    id: "CO1",
    status: "PENDING_PICKUP",
    get courier_providers() {
      throw fakeAxiosError("notify failed");
    },
  });
  (prismaDirect as any).$transaction = async (fn: any) =>
    fn({
      courierOrder: {
        updateMany: async () => ({ count: 1 }),
        findUnique: async () => ({ id: "CO1", courierTrackingId: "TRK1", status: "READY_FOR_PICKUP", courierStatus: "x", lastStatusUpdate: new Date() }),
      },
      courierTrackingHistory: { create: async () => ({}) },
    });
  try {
    const logs = await captureConsole(() => courierService.vendorMarkReadyForPickup("V1", "O1"));
    assert.match(logs, /Failed to notify courier provider/);
    assertNoSecrets(logs, "notify log");
  } finally {
    db.courierOrder.findFirst = origFind;
    (prismaDirect as any).$transaction = origTx;
  }
});

test("booking provider-failure log and the resulting error contain no secret", async () => {
  const db = courierServiceDb as any;
  const saved = {
    findFirst: db.courierOrder.findFirst,
    updateMany: db.courierOrder.updateMany,
    wh: db.vendorWarehouse.findFirst,
  };
  const row: any = {
    id: "INT1", orderId: "O1", vendorId: "V1", vendorOrderId: "VO1", warehouseId: "WH1", courierProviderId: "P_SF",
    merchantReference: "VO1-WH1", recipientName: "R", recipientPhone: "017", recipientAddress: "A", deliveryLocationId: "L2",
    itemDescription: "d", itemQuantity: 1, itemWeight: 1, specialInstruction: null, codAmount: 10, deliveryType: "STANDARD",
    status: "PENDING_PICKUP", courierStatus: BOOKING_PENDING, courierTrackingId: null,
  };
  db.courierOrder.findFirst = async () => ({ ...row });
  db.courierOrder.updateMany = async ({ data }: any) => {
    Object.assign(row, data);
    return { count: 1 };
  };
  db.vendorWarehouse.findFirst = async () => ({ id: "WH1", locationId: "L1" });
  (courierService as any).steadfastCreateOrder = async () => {
    throw fakeAxiosError();
  };
  let thrown: any;
  try {
    const logs = await captureConsole(async () => {
      try {
        await courierService.createCourierOrderForVendor("O1", "V1", {
          intentId: "INT1",
          preselectedCourier: { courierProviderId: "P_SF", courierName: "Steadfast", pricing: { courierProviderId: "P_SF", courierName: "Steadfast", deliveryCharge: 1, codCharge: 0, totalCharge: 1, estimatedDeliveryDays: 1 } },
        });
      } catch (e) {
        thrown = e;
      }
    });
    assert.match(logs, /Courier provider order creation failed/);
    assertNoSecrets(logs, "booking failure log");
    assert.ok(thrown, "the booking failed");
    assertNoSecrets(inspect(thrown, { depth: 20, showHidden: true }), "booking error");
    assertNoSecrets(String(row.courierStatus), "persisted rejection reason");
  } finally {
    db.courierOrder.findFirst = saved.findFirst;
    db.courierOrder.updateMany = saved.updateMany;
    db.vendorWarehouse.findFirst = saved.wh;
    delete (courierService as any).steadfastCreateOrder;
  }
});

// ── controller error forwarding ─────────────────────────────────────────────

test("controller errors forwarded to next() are sanitized (global error handler never sees headers)", async () => {
  (courierService as any).steadfastGetBalance = async () => {
    throw fakeAxiosError();
  };
  try {
    let forwarded: any;
    const res: any = { status: () => res, json: () => res };
    await courierController.steadfastGetBalance({ query: { courierProviderId: "P_SF" }, body: {}, params: {} } as any, res, (e: any) => (forwarded = e));
    assert.ok(forwarded instanceof Error, "error forwarded");
    assertNoSecrets(inspect(forwarded, { depth: 20, showHidden: true }), "forwarded error");
    assert.equal(forwarded.config, undefined);
  } finally {
    delete (courierService as any).steadfastGetBalance;
  }
});
