// tests/payment-callback-verification.test.ts
//
// Phase 5 / Step 3: the public /payment/fail and /payment/cancel callbacks
// carry only a CLAIM. Before anything changes, the gateway's own API is asked:
//   - confirmed failure / cancellation → applied as before (FAILED, stock released);
//   - the gateway says the payment succeeded → the normal verified success path
//     (val_id validated) — never marked failed;
//   - anything unconfirmed (forged, API error, other tran_id, PENDING,
//     unexpected shape) → no status change, no stock release; only a
//     gatewayReport note (idempotent) so the customer can retry;
//   - PAID or recorded money is never touched; unknown ids change nothing.
// DB-free; gateway HTTP calls are stubbed (axios / epsService):
//   npx tsx --test tests/payment-callback-verification.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

const { paymentServiceDb, paymentService } = await import("../src/services/payment.service.ts");
const { paymentGatewayService, paymentGatewayDb } = await import("../src/services/payment-gateway.service.ts");
const { OrderService } = await import("../src/services/order.service.ts");
const { AccountingService } = await import("../src/services/accounting.services.ts");
const { epsService } = await import("../src/services/eps.service.ts");
const { prisma: sharedDb } = await import("../src/config/prisma.ts");
const { PaymentController } = await import("../src/controllers/payment.controller.ts");
const { isOrderGatewaySession } = await import("../src/services/pay-now.service.ts");

type Row = Record<string, any>;
const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => row[k] === v);

function world(over: { payment?: Row; order?: Row; ssl?: boolean } = {}) {
  return {
    order: { id: "O1", userId: "U1", status: "PENDING", paymentStatus: "PENDING", paymentmethod: "SSLCOMMERZ", reservationReleasedAt: null, ...over.order } as Row,
    vendorOrders: [{ id: "VO1", orderId: "O1", status: "PENDING", items: [{ id: "OI1", allocations: [{ id: "AL1" }] }] }] as Row[],
    payment: { id: "PAY1", orderId: "O1", status: "PENDING", amount: 1500, method: "SSLCOMMERZ", meta: { type: "order_payment" }, paymentProviderId: null, ...over.payment } as Row,
    txn: over.ssl === false ? null : ({ tranId: "T1", paymentId: "PAY1", status: "PENDING" } as Row | null),
    released: [] as string[],
    queries: [] as string[],
    events: [] as string[],
  };
}
type World = ReturnType<typeof world>;

/** `gateway(url, params)` answers the stubbed SSLCommerz HTTP API. */
function install(w: World, gateway: (url: string, params: Row) => any) {
  const restores: (() => void)[] = [];
  const set = (o: any, k: string, v: any) => {
    const orig = o[k];
    o[k] = v;
    restores.push(() => (o[k] = orig));
  };
  set(axios, "get", async (url: string, cfg: Row) => {
    w.queries.push(url.split("/").pop()!);
    const out = gateway(url, cfg?.params ?? {});
    if (out instanceof Error) throw out;
    return { data: out };
  });
  set(axios, "post", async () => assert.fail("no POST to a gateway"));
  for (const db of [paymentServiceDb, paymentGatewayDb, sharedDb] as any[]) {
    for (const model of ["warehouseStock", "productVariant", "stockMovement", "orderItemAllocation"]) {
      for (const m of ["update", "updateMany", "create", "upsert", "delete", "deleteMany"]) set(db[model], m, async () => assert.fail(`unexpected ${model}.${m}`));
    }
    set(db.sSLCommerzTransaction, "findUnique", async ({ where }: Row) =>
      w.txn && where.tranId === w.txn.tranId ? { ...w.txn, payment: { ...w.payment, order: { ...w.order, vendorOrders: [] } } } : null,
    );
    set(db.sSLCommerzTransaction, "update", async ({ data }: Row) => (Object.assign(w.txn!, data), { ...w.txn }));
    set(db.payment, "findUnique", async ({ where }: Row) => (where.id === w.payment.id ? { ...w.payment } : null));
    set(db.payment, "findUniqueOrThrow", async () => ({ ...w.payment }));
    set(db.payment, "findFirst", async ({ where }: Row) => {
      if (where?.meta) return w.payment.meta?.[where.meta.path[0]] === where.meta.equals ? { ...w.payment, paymentProvider: { id: "GW1", payment_credentials: [{ environment: "SANDBOX" }, { environment: "PRODUCTION" }] } } : null;
      return w.txn ? { id: w.payment.id, status: w.payment.status, orderId: w.payment.orderId, meta: w.payment.meta } : null;
    });
    set(db.payment, "findMany", async () => [{ ...w.payment }]);
    set(db.payment, "update", async ({ data }: Row) => (Object.assign(w.payment, data), { ...w.payment }));
    set(db.order, "findUnique", async () => ({ ...w.order, vendorOrders: w.vendorOrders.map((v) => ({ items: v.items })) }));
    set(db.order, "update", async ({ data }: Row) => (Object.assign(w.order, data), { ...w.order }));
    set(db.order, "updateMany", async ({ where, data }: Row) => (matches(w.order, where) ? (Object.assign(w.order, data), { count: 1 }) : { count: 0 }));
    set(db.vendorOrder, "updateMany", async ({ where, data }: Row) => {
      const rows = w.vendorOrders.filter((v) => matches(v, where));
      rows.forEach((v) => Object.assign(v, data));
      return { count: rows.length };
    });
    set(db, "$executeRaw", async () => 1);
    set(db.auditLog, "create", async ({ data }: Row) => data);
    set(db, "$transaction", async (fn: any) => fn(db));
  }
  set(OrderService.prototype, "releaseStockForOrder", async (orderId: string) => (w.released.push(orderId), { released: 1, skipped: false }));
  set(AccountingService.prototype, "createEvent0aOnlinePayment", async (d: Row) => (w.events.push(`0a:${d.orderId}`), { id: "V" }));
  set(sharedDb.user, "findFirst", async () => ({ id: "U_SYSTEM" }));
  return { set, restore: () => restores.reverse().forEach((r) => r()) };
}
const QUERY = /merchantTransIDvalidationAPI/;
const query = (elements: Row[] | null, connect = "DONE") => (url: string) => (QUERY.test(url) ? (elements === null ? new Error("ECONNRESET") : { APIConnect: connect, no_of_trans_found: elements.length, element: elements }) : assert.fail(`unexpected ${url}`));
const unchanged = (w: World, label: string) => {
  assert.equal(w.payment.status, "PENDING", label);
  assert.deepEqual(w.released, [], `${label}: no stock release`);
  assert.equal(w.txn?.status ?? "PENDING", "PENDING", label);
  assert.equal(w.order.status, "PENDING", label);
};

test("forged / unconfirmable SSLCommerz fail and cancel: no FAILED, no stock release — only a gateway report, recorded once", async () => {
  const cases: [string, (url: string) => any][] = [
    ["query API unreachable", query(null)],
    ["API not connected", query([], "INVALID_REQUEST")],
    ["no element for this tran_id", query([{ tran_id: "OTHER", status: "FAILED" }])],
    ["still PENDING at the gateway", query([{ tran_id: "T1", status: "PENDING" }])],
    ["UNATTEMPTED", query([{ tran_id: "T1", status: "UNATTEMPTED" }])],
    ["VALID without val_id", query([{ tran_id: "T1", status: "VALID" }])],
    ["unexpected shape", () => ({ hello: "world" })],
  ];
  for (const [label, gw] of cases) {
    for (const claim of ["FAILED", "CANCELLED"] as const) {
      const w = world();
      const s = install(w, gw);
      try {
        await paymentGatewayService.markFailedOrCancelled("T1", claim);
        unchanged(w, `${label}/${claim}`);
        assert.equal(w.payment.meta.gatewayReport?.outcome, claim, label);
        assert.equal(w.payment.meta.gatewayReport?.verified, false);
        const first = w.payment.meta.gatewayReport.at;
        await paymentGatewayService.markFailedOrCancelled("T1", claim === "FAILED" ? "CANCELLED" : "FAILED");
        assert.equal(w.payment.meta.gatewayReport.at, first, "the first report is kept");
        unchanged(w, `${label}/${claim} repeated`);
      } finally {
        s.restore();
      }
    }
  }
});

test("confirmed SSLCommerz failure / cancellation: applied as before (FAILED, stock released) — regardless of which URL was hit", async () => {
  for (const [gwStatus, claim] of [["FAILED", "CANCELLED"], ["EXPIRED", "FAILED"], ["CANCELLED", "FAILED"]] as const) {
    const w = world();
    const s = install(w, query([{ tran_id: "T1", status: gwStatus }]));
    try {
      await paymentGatewayService.markFailedOrCancelled("T1", claim);
      assert.equal(w.payment.status, "FAILED", gwStatus);
      assert.deepEqual(w.released, ["O1"], gwStatus);
      assert.equal(w.txn!.status, gwStatus === "CANCELLED" ? "CANCELLED" : "FAILED", gwStatus);
      // a duplicate valid callback is harmless (no stock write beyond the guarded release)
      await paymentGatewayService.markFailedOrCancelled("T1", claim);
      assert.equal(w.payment.status, "FAILED");
    } finally {
      s.restore();
    }
  }
});

test("the gateway says the 'failed' payment actually SUCCEEDED: it goes through the verified success path — confirmed, never marked failed", async () => {
  const w = world();
  const s = install(w, (url: string, p: Row) =>
    QUERY.test(url)
      ? { APIConnect: "DONE", element: [{ tran_id: "T1", status: "VALID", val_id: "VAL1" }] }
      : { status: "VALID", tran_id: "T1", val_id: p.val_id, amount: "1500.00", currency: "BDT", currency_type: "BDT", currency_amount: "1500.00", bank_tran_id: "B1" },
  );
  try {
    await paymentGatewayService.markFailedOrCancelled("T1", "FAILED");
    assert.deepEqual([w.order.status, w.order.paymentStatus, w.payment.status], ["CONFIRMED", "PAID", "PAID"]);
    assert.deepEqual(w.released, []);
    assert.deepEqual(w.queries, ["merchantTransIDvalidationAPI.php", "validationserverAPI.php"], "query, then val_id validation");
  } finally {
    s.restore();
  }
});

test("PAID or recorded money: the callback changes nothing and the gateway is not even asked", async () => {
  for (const payment of [{ status: "PAID" }, { meta: { type: "order_payment", reconciliation: { state: "NEEDS_REVIEW", reason: "ORDER_CANCELLED" } } }]) {
    const w = world({ payment });
    const s = install(w, () => assert.fail("no gateway query"));
    try {
      await paymentGatewayService.markFailedOrCancelled("T1", "FAILED");
      assert.deepEqual(w.released, []);
      assert.notEqual(w.payment.status, "FAILED");
    } finally {
      s.restore();
    }
  }
});

test("EPS: Failed/Cancelled at the gateway → FAILED; Success → applied; Pending / API error → report only", async () => {
  const eps = (over: Row = {}) => world({ ssl: false, payment: { method: "EPS", meta: { type: "order_payment", merchantTransactionId: "E1" }, ...over } });
  for (const [gw, expect] of [["Failed", "FAILED"], ["Cancelled", "FAILED"], ["Pending", "PENDING"], [new Error("timeout"), "PENDING"]] as const) {
    const w = eps();
    const s = install(w, () => assert.fail("no SSLCommerz call"));
    s.set(epsService, "checkTransactionStatus", async () => {
      if (gw instanceof Error) throw gw;
      return { status: gw, raw: {} };
    });
    try {
      await paymentGatewayService.markFailedOrCancelled("E1", "CANCELLED");
      assert.equal(w.payment.status, expect, String(gw));
      if (expect === "PENDING") assert.equal(w.payment.meta.gatewayReport.outcome, "CANCELLED");
      else assert.equal(w.payment.meta.epsOutcome, gw === "Cancelled" ? "CANCELLED" : "FAILED");
      assert.equal(w.order.status, "PENDING");
    } finally {
      s.restore();
    }
  }
  const w = eps();
  const s = install(w, () => assert.fail("no SSLCommerz call"));
  s.set(epsService, "checkTransactionStatus", async () => ({ status: "Success", raw: {} }));
  try {
    await paymentGatewayService.markFailedOrCancelled("E1", "FAILED");
    assert.deepEqual([w.order.status, w.payment.status], ["CONFIRMED", "PAID"]);
  } finally {
    s.restore();
  }
});

test("public routes: forged unknown or missing tran_id → redirect, nothing written", async () => {
  const w = world();
  const s = install(w, () => assert.fail("no gateway query for an unknown id"));
  try {
    for (const handler of [PaymentController.fail, PaymentController.cancel]) {
      for (const body of [{ tran_id: "NOPE" }, {}]) {
        const res: any = { redirect: (u: string) => (res.to = u) };
        await (handler as any)({ body, query: {} }, res);
        assert.match(res.to, /\/payment\/(failed|cancelled)/);
      }
    }
    unchanged(w, "unknown ids");
    assert.equal(w.payment.meta.gatewayReport, undefined);
  } finally {
    s.restore();
  }
});

test("a session with an unverified failure report doesn't block a retry (Pay Now / init window)", () => {
  assert.equal(isOrderGatewaySession({ status: "PENDING", meta: { type: "order_payment" } }), true);
  assert.equal(isOrderGatewaySession({ status: "PENDING", meta: { type: "order_payment", gatewayReport: { outcome: "FAILED" } } }), false);
  void paymentService;
});
