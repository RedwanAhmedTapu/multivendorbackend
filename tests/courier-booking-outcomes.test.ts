// tests/courier-booking-outcomes.test.ts
//
// PHASE 0 follow-up (audit H1 + M1):
//   H1 — a received HTTP response does NOT prove that no shipment was created.
//        Only a confirmed business-validation rejection (400/422 with
//        structured field errors, no duplicate/merchant-reference signal) is
//        REJECTED and releases the booking slot. Timeouts, resets, 401/403/404/
//        408/409/429, 5xx, gateway pages and duplicate-reference responses are
//        UNKNOWN: the intent keeps its slot and is never retried automatically.
//   M1 — a nominally successful provider response without a usable tracking /
//        consignment id is NOT confirmed and NOT reported as success:
//        CONFIRM_FAILED (never REJECTED), slot kept, no history row, and
//        markForDelivery dispatches no stock.
//
// DB-free and network-free: Prisma delegates are in-memory stubs and the
// courier service's HTTP client is replaced, so no courier API is reachable.
// This proves classification and guarded state transitions, NOT PostgreSQL
// isolation/rollback or live provider behaviour. Run with:
//   npx tsx --test tests/courier-booking-outcomes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import courierService, {
  courierServiceDb,
  classifyProviderBookingError,
  BOOKING_PENDING,
  BOOKING_UNKNOWN,
  BOOKING_CONFIRM_FAILED,
} from "../src/services/courier.service.ts";
import { prisma, prismaDirect } from "../src/config/prisma.ts";
import { VendorOrderService } from "../src/services/vendor.order.service.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

type Row = Record<string, any>;

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

const applyUpdateMany = (rows: Row[], where: Row, data: Row) => {
  const hit = rows.filter((r) => matches(r, where));
  hit.forEach((r) => Object.assign(r, data));
  return { count: hit.length };
};

/** An Axios-shaped error. `status` undefined = no response (timeout/reset). */
function httpError(status?: number, data?: unknown, code?: string) {
  const err: any = new Error(status ? `Request failed with status code ${status}` : "socket hang up");
  err.isAxiosError = true;
  if (code) err.code = code;
  err.request = {};
  if (status !== undefined) err.response = { status, data };
  return err;
}

const VALIDATION_422 = { message: "Please fix the given errors", errors: { recipient_phone: ["The recipient phone format is invalid."] } };
const DUPLICATE_INVOICE = { message: "The given data was invalid.", errors: { invoice: ["The invoice has already been taken."] } };
const DUPLICATE_MERCHANT_ORDER = { message: "Validation failed", errors: { merchant_order_id: ["Duplicate merchant order id"] } };

const PROVIDERS = {
  Steadfast: { courierProviderId: "P_SF", courierName: "Steadfast" },
  Pathao: { courierProviderId: "P_PA", courierName: "Pathao" },
  RedX: { courierProviderId: "P_RX", courierName: "RedX" },
} as const;
type ProviderName = keyof typeof PROVIDERS;
const preselected = (name: ProviderName) => ({
  ...PROVIDERS[name],
  pricing: { ...PROVIDERS[name], deliveryCharge: 60, codCharge: 12, totalCharge: 72, estimatedDeliveryDays: 2 },
});

const intentRow = (over: Row = {}): Row => ({
  id: "INT1", orderId: "O1", vendorId: "V1", vendorOrderId: "VO1", warehouseId: "WH1", courierProviderId: "P_SF",
  merchantReference: "VO1-WH1", recipientName: "Real Recipient", recipientPhone: "01700000000", recipientAddress: "Real Address",
  deliveryLocationId: "LOC_CUST", itemDescription: "Shirt x1", itemQuantity: 1, itemWeight: 0.5, specialInstruction: null,
  codAmount: 1234, deliveryType: "STANDARD", shipmentKind: "REGULAR", status: "PENDING_PICKUP", courierStatus: BOOKING_PENDING,
  courierTrackingId: null, courierOrderId: null, consignmentId: null, returnConsignmentId: null, pickupStoreId: null,
  ...over,
});

/** In-memory booking environment; `respond` plays the provider builder (return = success, throw = failure). */
function setup(rows: Row[], respond: (name: ProviderName) => any) {
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
  const calls: string[] = [];
  set(db.courierOrder, "findFirst", async ({ where }: any) => {
    const r = rows.find((x) => matches(x, where));
    return r ? { ...r } : null;
  });
  set(db.courierOrder, "updateMany", async ({ where, data }: any) => applyUpdateMany(rows, where, data));
  set(db.vendorWarehouse, "findFirst", async ({ where }: any) =>
    where.id === "WH1" && where.vendorId === "V1" ? { id: "WH1", locationId: "LOC_WH" } : null,
  );
  set(db.courierServicableAreas, "findFirst", async () => ({ id: "AREA", courierCityId: "1", courierZoneId: "2", courierAreaId: "3" }));
  set(db.auditLog, "create", async ({ data }: any) => {
    audits.push(data);
    return data;
  });
  set(prismaDirect as any, "$transaction", async (fn: any) => {
    const snap = rows.map((r) => ({ ...r }));
    const hl = history.length;
    try {
      return await fn({
        courierOrder: { updateMany: async ({ where, data }: any) => applyUpdateMany(rows, where, data) },
        courierTrackingHistory: { create: async ({ data }: any) => history.push(data) },
      });
    } catch (e) {
      rows.splice(0, rows.length, ...snap);
      history.splice(hl);
      throw e;
    }
  });
  set(courierService, "resolveWarehousePickup", async () => ({
    credentialId: "CRED1",
    mapping: { id: "M1", warehouseId: "WH1", vendorId: "V1", courierCredentialId: "CRED1", providerStoreId: "123", providerAreaId: "3" },
  }));
  const builder = (name: ProviderName) => async () => {
    calls.push(name);
    return respond(name);
  };
  set(courierService, "steadfastCreateOrder", builder("Steadfast"));
  set(courierService, "createPathaoOrder", builder("Pathao"));
  set(courierService, "createRedXOrder", builder("RedX"));
  return { audits, history, calls, restore: () => restores.reverse().forEach((r) => r()) };
}

const book = (name: ProviderName) =>
  courierService.createCourierOrderForVendor("O1", "V1", { intentId: "INT1", preselectedCourier: preselected(name) } as any);

async function outcomeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "SUCCESS";
  } catch (e: any) {
    return e.courierBookingOutcome ?? `untagged: ${e.message}`;
  }
}

// ── H1: the classifier ──────────────────────────────────────────────────────

test("H1 classifier: ambiguous outcomes are UNKNOWN", () => {
  const ambiguous: [string, any][] = [
    ["timeout (no response)", httpError(undefined, undefined, "ECONNABORTED")],
    ["connection reset (no response)", httpError(undefined, undefined, "ECONNRESET")],
    ["plain Error (e.g. response-parsing failure)", new Error("Unexpected token < in JSON")],
    ["408", httpError(408, { message: "Request Timeout" })],
    ["429", httpError(429, { message: "Too Many Requests" })],
    ["500", httpError(500, { message: "Server Error" })],
    ["502 gateway HTML", httpError(502, "<html><body>Bad Gateway</body></html>")],
    ["503", httpError(503, { message: "Service Unavailable" })],
    ["504", httpError(504, { message: "Gateway Timeout" })],
    ["401", httpError(401, { message: "Unauthenticated." })],
    ["403", httpError(403, { message: "Forbidden" })],
    ["404", httpError(404, { message: "Not Found" })],
    ["409", httpError(409, { message: "Conflict" })],
    ["422 HTML body", httpError(422, "<html>Unprocessable</html>")],
    ["422 message only (no structured field errors)", httpError(422, { message: "invalid" })],
    ["422 empty errors object", httpError(422, { message: "invalid", errors: {} })],
    ["422 duplicate invoice (Laravel 'already been taken')", httpError(422, DUPLICATE_INVOICE)],
    ["422 duplicate merchant_order_id", httpError(422, DUPLICATE_MERCHANT_ORDER)],
    ["400 'Duplicate' message with field errors", httpError(400, { message: "Duplicate order", errors: { phone: ["x"] } })],
    ["400 merchant_invoice_id field error", httpError(400, { errors: { merchant_invoice_id: ["must be unique"] } })],
  ];
  for (const [label, err] of ambiguous) assert.equal(classifyProviderBookingError(err), "UNKNOWN", label);
});

test("H1 classifier: confirmed business-validation rejections stay REJECTED", () => {
  assert.equal(classifyProviderBookingError(httpError(422, VALIDATION_422)), "REJECTED");
  assert.equal(
    classifyProviderBookingError(httpError(400, { message: "Validation failed", errors: { recipient_address: ["The address is required."] } })),
    "REJECTED",
  );
  assert.equal(classifyProviderBookingError(httpError(422, { errors: [{ field: "item_weight", message: "max 10" }] })), "REJECTED");
});

// ── H1: the provider builders (HTTP client stubbed — no network) ────────────

function stubHttp(post: (...a: any[]) => any) {
  const svc = courierService as any;
  const restores: (() => void)[] = [];
  const set = (key: string, value: any) => {
    const had = Object.prototype.hasOwnProperty.call(svc, key);
    const orig = svc[key];
    svc[key] = value;
    restores.push(() => (had ? (svc[key] = orig) : delete svc[key]));
  };
  set("axiosInstance", { post: async (...a: any[]) => post(...a) });
  set("getSteadfastHeaders", async () => ({ baseUrl: "https://steadfast.invalid", headers: {} }));
  set("getPlatformCourierCredentials", async () => ({
    id: "CRED1",
    bearerToken: "test-token",
    courier_providers: { productionBaseUrl: "https://provider.invalid", sandboxBaseUrl: "https://provider.invalid" },
  }));
  set("getValidPathaoToken", async () => "test-token");
  return () => restores.reverse().forEach((r) => r());
}

const builderInput = {
  recipientName: "R", recipientPhone: "01700000000", recipientAddress: "A", itemDescription: "d", itemQuantity: 1,
  itemWeight: 1, codAmount: 100, deliveryType: "NORMAL", merchantReference: "VO1-WH1",
  pickupArea: {}, deliveryArea: { courierCityId: "1", courierZoneId: "2", courierAreaId: "3", courierAreaName: "Area" },
  warehousePickup: { mapping: { id: "M1", providerStoreId: "123", courierCredentialId: "CRED1" } },
};

async function builderOutcome(name: ProviderName, post: (...a: any[]) => any) {
  const restore = stubHttp(post);
  try {
    const svc = courierService as any;
    if (name === "Steadfast") await svc.steadfastCreateOrder("P_SF", { invoice: "VO1-WH1", recipient_name: "R", recipient_phone: "017", recipient_address: "A", cod_amount: 1 });
    if (name === "Pathao") await svc.createPathaoOrder("P_PA", builderInput);
    if (name === "RedX") await svc.createRedXOrder("P_RX", builderInput);
    return "SUCCESS";
  } catch (e: any) {
    // RedX does not tag its HTTP failures; the booking flow classifies them.
    return e.courierBookingOutcome ?? classifyProviderBookingError(e);
  } finally {
    restore();
  }
}

for (const name of ["Steadfast", "Pathao", "RedX"] as const) {
  test(`H1 builder ${name}: 5xx / 504 / timeout / 429 / duplicate reference → UNKNOWN`, async () => {
    for (const [label, err] of [
      ["503", httpError(503, { message: "Service Unavailable" })],
      ["504", httpError(504, "<html>Gateway Timeout</html>")],
      ["timeout", httpError(undefined, undefined, "ECONNABORTED")],
      ["429", httpError(429, { message: "slow down" })],
      ["duplicate", httpError(422, name === "Steadfast" ? DUPLICATE_INVOICE : DUPLICATE_MERCHANT_ORDER)],
    ] as const) {
      assert.equal(await builderOutcome(name, () => { throw err; }), "UNKNOWN", `${name} ${label}`);
    }
  });
}

test("H1 builder: a confirmed 422 validation rejection is REJECTED for Steadfast and Pathao", async () => {
  for (const name of ["Steadfast", "Pathao"] as const) {
    assert.equal(await builderOutcome(name, () => { throw httpError(422, VALIDATION_422); }), "REJECTED", name);
  }
});

test("H1 builder: RedX stays conservative — even a 422 validation response is UNKNOWN (no RedX contract evidence)", async () => {
  assert.equal(await builderOutcome("RedX", () => { throw httpError(422, VALIDATION_422); }), "UNKNOWN");
});

test("H1 builder: Steadfast HTTP 200 with a non-200 body status is UNKNOWN, not REJECTED", async () => {
  assert.equal(await builderOutcome("Steadfast", () => ({ data: { status: 400, message: "Invalid invoice" } })), "UNKNOWN");
});

// ── H1: end to end through the guarded state machine ────────────────────────

for (const [label, err] of [
  ["503", httpError(503, { message: "Service Unavailable" })],
  ["504 gateway page", httpError(504, "<html>Gateway Timeout</html>")],
  ["duplicate invoice", httpError(422, DUPLICATE_INVOICE)],
  ["untagged 500 (fallback classification)", httpError(500, { message: "boom" })],
] as const) {
  test(`H1 booking: ${label} → UNKNOWN, intent keeps its slot, no automatic retry`, async () => {
    const rows = [intentRow()];
    const env = setup(rows, () => { throw err; });
    try {
      assert.equal(await outcomeOf(book("Steadfast")), "UNKNOWN");
      assert.equal(rows[0].status, "PENDING_PICKUP", "never CANCELLED — the shipment may exist");
      assert.equal(rows[0].courierStatus, BOOKING_UNKNOWN);
      assert.equal(env.calls.length, 1, "exactly one provider call — no automatic retry");
      // A second attempt cannot re-claim the slot and never contacts the provider.
      assert.equal(await outcomeOf(book("Steadfast")), "NOT_CLAIMED");
      assert.equal(env.calls.length, 1);
    } finally {
      env.restore();
    }
  });
}

test("H1 booking: a confirmed validation rejection is REJECTED and releases the slot (CANCELLED)", async () => {
  const rows = [intentRow()];
  const err = httpError(422, VALIDATION_422);
  err.courierBookingOutcome = classifyProviderBookingError(err); // as the builders tag it
  const env = setup(rows, () => { throw err; });
  try {
    assert.equal(await outcomeOf(book("Steadfast")), "REJECTED");
    assert.equal(rows[0].status, "CANCELLED");
  } finally {
    env.restore();
  }
});

test("H1 booking: an ambiguous outcome arriving after the claim changed cannot overwrite the newer state", async () => {
  const rows = [intentRow()];
  const env = setup(rows, () => {
    rows[0].courierStatus = "Changed by another actor";
    throw httpError(503, {});
  });
  try {
    assert.equal(await outcomeOf(book("Steadfast")), "STALE");
    assert.equal(rows[0].courierStatus, "Changed by another actor");
    assert.equal(rows[0].status, "PENDING_PICKUP");
  } finally {
    env.restore();
  }
});

// ── M1: missing / empty / valid tracking ids ────────────────────────────────

const RESPONSES: Record<ProviderName, { valid: any; missing: any[] }> = {
  Steadfast: {
    valid: { consignment: { tracking_code: "SF123", consignment_id: 555 } },
    missing: [
      { consignment: { consignment_id: 555 } },
      { consignment: { tracking_code: "", consignment_id: 555 } },
      { consignment: { tracking_code: "   ", consignment_id: 555 } },
      { consignment: { tracking_code: null } },
      {},
    ],
  },
  Pathao: {
    valid: { data: { consignment_id: "DA123", merchant_order_id: "VO1-WH1" } },
    missing: [{ data: { merchant_order_id: "VO1-WH1" } }, { data: { consignment_id: "" } }, { data: null }, {}],
  },
  RedX: {
    valid: { tracking_id: "RX123" },
    missing: [{ tracking_id: null }, { tracking_id: "" }, {}],
  },
};

for (const name of ["Steadfast", "Pathao", "RedX"] as const) {
  test(`M1 ${name}: success without a usable tracking id → CONFIRM_FAILED, not confirmed, slot kept`, async () => {
    for (const response of RESPONSES[name].missing) {
      const rows = [intentRow({ courierProviderId: PROVIDERS[name].courierProviderId })];
      const env = setup(rows, () => response);
      try {
        const outcome = await outcomeOf(book(name));
        assert.equal(outcome, "CONFIRM_FAILED", `${name} ${JSON.stringify(response)}`);
        assert.equal(rows[0].status, "PENDING_PICKUP", "never REJECTED / CANCELLED");
        assert.equal(rows[0].courierTrackingId, null, "not confirmed");
        assert.equal(rows[0].courierStatus, BOOKING_CONFIRM_FAILED);
        assert.equal(env.history.length, 0, "no tracking-history row");
        const audit = env.audits.find((a) => a.action === "COURIER_CONFIRM_FAILED");
        assert.equal(audit?.newData.providerTrackingId, "(missing)");
        assert.equal(await outcomeOf(book(name)), "NOT_CLAIMED", "the slot stays blocked");
      } finally {
        env.restore();
      }
    }
  });

  test(`M1 ${name}: a valid tracking id follows the normal confirmation path`, async () => {
    const rows = [intentRow({ courierProviderId: PROVIDERS[name].courierProviderId })];
    const env = setup(rows, () => RESPONSES[name].valid);
    try {
      assert.equal(await outcomeOf(book(name)), "SUCCESS");
      assert.ok(rows[0].courierTrackingId, "confirmed with the provider's id");
      assert.equal(rows[0].courierStatus, "Order Created");
      assert.equal(env.history.length, 1);
    } finally {
      env.restore();
    }
  });
}

test("M1: a numeric provider id is stored as its string form; a missing order id is stored as null", async () => {
  const rows = [intentRow()];
  const env = setup(rows, () => ({ consignment: { tracking_code: 98765 } }));
  try {
    assert.equal(await outcomeOf(book("Steadfast")), "SUCCESS");
    assert.equal(rows[0].courierTrackingId, "98765");
    assert.equal(rows[0].courierOrderId, null);
  } finally {
    env.restore();
  }
});

// ── M1: markForDelivery dispatches no stock after CONFIRM_FAILED ────────────

test("M1 markForDelivery: missing tracking id → error, the dispatch transaction never runs", async () => {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const had = Object.prototype.hasOwnProperty.call(obj, key);
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (had ? (obj[key] = orig) : delete obj[key]));
  };
  const rows: Row[] = [];
  const env = setup(rows, () => ({ consignment: { consignment_id: 555 } })); // accepted, but no tracking_code
  restores.push(env.restore);
  const transactions: string[] = [];
  try {
    set(prisma.vendorOrder, "findUnique", async () => ({
      id: "VO1", vendorId: "V1", orderId: "O1", status: "PACKAGING", subtotal: 100, shippingCost: 60,
      order: {
        paymentmethod: "COD",
        address: { receiverFullName: "Real Recipient", phone: "01700000000", address: "Real Address", locationId: "LOC_CUST", location: {} },
        user: { name: "U", phone: "017" },
      },
      items: [
        {
          id: "I1", variantId: "VAR1", price: 100, quantity: 1,
          variant: { product: { name: "Shirt", warranty: { packageWeightValue: 0.5, packageWeightUnit: "KG" } } },
          allocations: [{ id: "A1", warehouseId: "WH1", quantity: 1, shippedQty: 0, rackId: null, rowNumber: null, shelfNumber: null }],
        },
      ],
      courierOrders: [],
    }));
    set(prisma.vendorWarehouse, "findFirst", async () => ({ id: "WH1", vendorId: "V1", locationId: "LOC_WH", location: {} }));
    set(prisma.courierOrder, "count", async () => 0);
    set(courierService, "selectBestCourier", async () => preselected("Steadfast"));
    set(prisma, "$transaction", async (fn: any) => {
      transactions.push("$transaction");
      const tx = {
        courierOrder: {
          create: async ({ data }: any) => {
            transactions.push("create-intent");
            const row = { id: "INT1", courierTrackingId: null, courierOrderId: null, consignmentId: null, returnConsignmentId: null, shipmentKind: "REGULAR", ...data };
            rows.push(row);
            return row;
          },
        },
        // Anything the dispatch step would touch fails loudly.
        orderItemAllocation: new Proxy({}, { get: () => async () => assert.fail("stock dispatch must not run") }),
        vendorOrder: new Proxy({}, { get: () => async () => assert.fail("vendor order must not change") }),
        warehouseStock: new Proxy({}, { get: () => async () => assert.fail("stock must not move") }),
        productVariant: new Proxy({}, { get: () => async () => assert.fail("stock must not move") }),
      };
      return fn(tx);
    });

    const outcome = await outcomeOf(VendorOrderService.markForDelivery("VO1", "V1"));
    assert.equal(outcome, "CONFIRM_FAILED");
    assert.deepEqual(transactions, ["$transaction", "create-intent"], "one transaction (the booking intent) — no dispatch transaction");
    assert.equal(rows[0].status, "PENDING_PICKUP");
    assert.equal(rows[0].courierTrackingId, null);
    assert.equal(rows[0].courierStatus, BOOKING_CONFIRM_FAILED);
  } finally {
    restores.reverse().forEach((r) => r());
  }
});
