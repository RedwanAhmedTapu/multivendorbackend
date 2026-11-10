// tests/sslcommerz-query-contract.test.ts
//
// Phase 6 / Priority 2: paymentService.verifiedSslcommerzOutcome — how a reply
// from SSLCommerz's transaction-query API (merchantTransIDvalidationAPI.php,
// already called by paymentService.queryTransactionStatus) is read before a
// public fail / cancel callback may change anything.
//
// CONTRACT STATUS — read this before changing the fixtures:
//   The project has no official SSLCommerz documentation, SDK or recorded live
//   response. The only shapes it documents are its own types:
//     - src/types/index.ts (SSLCommerzValidationResponse): `APIConnect`, and
//       per-transaction `status` VALID | VALIDATED | FAILED | CANCELLED | …,
//       `tran_id`, `val_id`;
//     - multivendorsite TransactionDetailsResponse (the /payment/details
//       pass-through of this same query): `no_of_trans_found`, `element[]`.
//   The fixtures below combine those: { APIConnect, no_of_trans_found,
//   element: [{ tran_id, status, val_id, … }] }. That the query API's elements
//   carry exactly these per-element fields is an ASSUMPTION not verified
//   against the live gateway. The reader is therefore fail-closed: anything
//   it can't positively read as "this tran_id failed / was cancelled" or "this
//   tran_id was paid (with a val_id)" is UNVERIFIED and changes no state; a
//   "paid" reading is never trusted by itself — the caller re-verifies the
//   val_id through the validation API, which binds tran_id / amount / BDT.
// DB-free; axios is stubbed — no gateway is called:
//   npx tsx --test tests/sslcommerz-query-contract.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

const { paymentService, paymentServiceDb } = await import("../src/services/payment.service.ts");
const { paymentGatewayService, paymentGatewayDb } = await import("../src/services/payment-gateway.service.ts");

type Row = Record<string, any>;
const T = "TXN_1729245600000_O1";
const el = (over: Row = {}) => ({ tran_id: T, status: "VALID", val_id: "VAL_1", amount: "1500.00", currency: "BDT", bank_tran_id: "B1", ...over });
const ok = (elements: unknown, extra: Row = {}) => ({ APIConnect: "DONE", no_of_trans_found: Array.isArray(elements) ? elements.length : 0, element: elements, ...extra });

async function outcome(reply: unknown) {
  const orig = axios.get;
  const urls: string[] = [];
  (axios as any).get = async (url: string, cfg: Row) => {
    urls.push(url);
    assert.equal(cfg?.params?.tran_id, T, "the query names the transaction");
    if (reply instanceof Error) throw reply;
    return { data: reply };
  };
  try {
    const out = await paymentService.verifiedSslcommerzOutcome(T);
    assert.ok(urls.every((u) => /\/validator\/api\/merchantTransIDvalidationAPI\.php$/.test(u)), "only the query API");
    return out;
  } finally {
    (axios as any).get = orig;
  }
}

test("success: a VALID / VALIDATED element for THIS tran_id with a val_id → PAID (re-verified by the caller)", async () => {
  assert.deepEqual(await outcome(ok([el()])), { kind: "PAID", valId: "VAL_1" });
  assert.deepEqual(await outcome(ok([el({ status: "VALIDATED", val_id: "VAL_2" })])), { kind: "PAID", valId: "VAL_2" });
  assert.deepEqual(await outcome(ok([el({ status: "valid" })])), { kind: "PAID", valId: "VAL_1" }, "status case-insensitive");
  // money wins over a failed retry attempt of the same transaction
  assert.deepEqual(await outcome(ok([el({ status: "FAILED", val_id: "" }), el()])), { kind: "PAID", valId: "VAL_1" });
});

test("failure: every element for this tran_id FAILED / EXPIRED → FAILED; any CANCELLED among only-final ones → CANCELLED", async () => {
  assert.deepEqual(await outcome(ok([el({ status: "FAILED", val_id: "" })])), { kind: "FAILED" });
  assert.deepEqual(await outcome(ok([el({ status: "EXPIRED", val_id: "" })])), { kind: "FAILED" });
  assert.deepEqual(await outcome(ok([el({ status: "FAILED" }), el({ status: "EXPIRED" })])), { kind: "FAILED" });
  assert.deepEqual(await outcome(ok([el({ status: "CANCELLED", val_id: "" })])), { kind: "CANCELLED" });
  assert.deepEqual(await outcome(ok([el({ status: "FAILED" }), el({ status: "CANCELLED" })])), { kind: "CANCELLED" });
});

test("pending / not final: PENDING, UNATTEMPTED, unknown status, or a mix with one → UNVERIFIED", async () => {
  for (const status of ["PENDING", "UNATTEMPTED", "PROCESSING", "", undefined]) {
    assert.deepEqual(await outcome(ok([el({ status, val_id: "" })])), { kind: "UNVERIFIED" }, String(status));
  }
  assert.deepEqual(await outcome(ok([el({ status: "FAILED" }), el({ status: "PENDING" })])), { kind: "UNVERIFIED" });
});

test("mismatched transaction id: elements for another tran_id never count", async () => {
  assert.deepEqual(await outcome(ok([el({ tran_id: "TXN_OTHER", status: "FAILED" })])), { kind: "UNVERIFIED" });
  assert.deepEqual(await outcome(ok([el({ tran_id: "TXN_OTHER", status: "VALID" })])), { kind: "UNVERIFIED" }, "another transaction's success is not ours");
  assert.deepEqual(await outcome(ok([el({ tran_id: undefined, status: "FAILED" })])), { kind: "UNVERIFIED" });
  assert.deepEqual(await outcome(ok([el({ tran_id: T.toLowerCase(), status: "FAILED" })])), { kind: "UNVERIFIED" }, "exact match only");
});

test("malformed replies and API refusals → UNVERIFIED", async () => {
  const replies: unknown[] = [
    null,
    "",
    "<html>Bad Gateway</html>",
    [],
    {},
    { element: [el({ status: "FAILED" })] }, // no APIConnect
    ok([el({ status: "FAILED" })], { APIConnect: "INVALID_REQUEST" }),
    ok([el({ status: "FAILED" })], { APIConnect: "FAILED" }),
    ok([el({ status: "FAILED" })], { APIConnect: "INACTIVE" }),
    ok({ 0: el({ status: "FAILED" }) }), // element not an array
    ok([]),
    ok([null, 3, "x"]),
    ok([el({ status: "VALID", val_id: undefined })]), // paid but no val_id to verify with
    ok([el({ status: "VALID", val_id: 42 })]),
  ];
  for (const r of replies) assert.deepEqual(await outcome(r), { kind: "UNVERIFIED" }, JSON.stringify(r));
});

test("API errors (network / timeout / HTTP error) → UNVERIFIED", async () => {
  for (const e of [new Error("ECONNRESET"), Object.assign(new Error("timeout of 0ms exceeded"), { code: "ECONNABORTED" }), Object.assign(new Error("Request failed with status code 500"), { response: { status: 500, data: "oops" } })]) {
    assert.deepEqual(await outcome(e), { kind: "UNVERIFIED" }, e.message);
  }
});

test("a PAID reading is never trusted alone: a val_id whose validation names another transaction applies nothing and fails nothing", async () => {
  const restores: (() => void)[] = [];
  const set = (o: any, k: string, v: any) => {
    const orig = o[k];
    o[k] = v;
    restores.push(() => (o[k] = orig));
  };
  const payment: Row = { id: "PAY1", orderId: "O1", status: "PENDING", amount: 1500, meta: { type: "order_payment" }, paymentProviderId: null };
  const writes: string[] = [];
  for (const db of [paymentServiceDb, paymentGatewayDb] as any[]) {
    set(db.sSLCommerzTransaction, "findUnique", async () => ({ tranId: T, paymentId: "PAY1", status: "PENDING", payment: { ...payment, order: { id: "O1", status: "PENDING", vendorOrders: [] } } }));
    set(db.sSLCommerzTransaction, "update", async () => (writes.push("txn"), {}));
    set(db.payment, "findUnique", async () => ({ ...payment }));
    set(db.payment, "update", async () => (writes.push("payment"), {}));
    set(db, "$transaction", async () => (writes.push("tx"), assert.fail("nothing may be settled")));
  }
  set(axios, "get", async (url: string) =>
    /merchantTransIDvalidationAPI/.test(url)
      ? { data: ok([el()]) }
      : { data: { status: "VALID", tran_id: "TXN_SOMEONE_ELSE", val_id: "VAL_1", amount: "1500.00", currency: "BDT", currency_type: "BDT", currency_amount: "1500.00" } },
  );
  try {
    await assert.rejects(paymentGatewayService.markFailedOrCancelled(T, "FAILED"), /validation rejected/);
    assert.deepEqual(writes, [], "no state change either way");
  } finally {
    restores.reverse().forEach((r) => r());
  }
});
