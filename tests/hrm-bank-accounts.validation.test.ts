// tests/hrm-bank-accounts.validation.test.ts
//
// PHASE F item 2 regression: POST /hrm/employees/:id/bank-accounts used to
// 500 {"message":"Internal server error during validation"} — the bank
// schemas passed a PLAIN object of Zod fields as `body:` (missing the
// z.object() wrapper), so Zod v4 threw a generic Error inside parseAsync,
// which the validate middleware did not recognise as a ZodError.
//
// These tests run the REAL form payload the Bank & MFS dialog sends
// (SimpleFormDialog → BankSection) through the real schema AND the real
// validate middleware. Run with:
//   npx tsx --test tests/hrm-bank-accounts.validation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";
import {
  createBankAccountSchema,
  updateBankAccountSchema,
} from "../src/modules/hrm/validators/employeeSections.validator.ts";
import { validate } from "../src/middlewares/vendor.schema.validation.middleware.ts";

// ── The exact payloads the frontend form builds ──────────────────────────
// SimpleFormDialog.submit(): visible fields only; empty strings become
// undefined; checkbox → boolean. BankSection (PHASE F) sends the same keys.
const BANK_PAYLOAD = {
  paymentMethod: "BANK",
  holderName: "Rahim Uddin",
  bank: "Dutch-Bangla Bank",
  branch: "Gulshan Branch",
  accountNumber: "1234567890123",
  routingNumber: "090261726",
  accountType: "SAVINGS",
  isPrimary: true,
};
// MFS variant: bank-only fields are omitted entirely (never "").
const MFS_PAYLOAD = {
  paymentMethod: "MFS",
  mfsProvider: "BKASH",
  mfsNumber: "01712345678",
  isPrimary: false,
};

function mockRes(): any {
  return {
    statusCode: 0,
    body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
  };
}

// ── Schema-level regression ──────────────────────────────────────────────

test("regression: bank schema accepts the real BANK form payload (was: generic Error → 500)", async () => {
  const parsed = await createBankAccountSchema.parseAsync({
    params: { id: "EMP1" },
    body: BANK_PAYLOAD,
  });
  assert.equal(parsed.body.paymentMethod, "BANK");
  assert.equal(parsed.body.accountType, "SAVINGS");
  assert.equal(parsed.body.isPrimary, true);
});

test("regression: bank schema accepts the real MFS form payload with bank fields omitted", async () => {
  const parsed = await createBankAccountSchema.parseAsync({
    params: { id: "EMP1" },
    body: MFS_PAYLOAD,
  });
  assert.equal(parsed.body.paymentMethod, "MFS");
  assert.equal(parsed.body.mfsProvider, "BKASH");
});

test("bank update schema accepts a partial diff (routing number only)", async () => {
  const parsed = await updateBankAccountSchema.parseAsync({
    params: { id: "EMP1", sectionId: "ACC1" },
    body: { routingNumber: "090261999" },
  });
  assert.equal(parsed.body.routingNumber, "090261999");
});

test("invalid paymentMethod raises a REAL ZodError with a field path (→ 400, not 500)", async () => {
  await assert.rejects(
    () => createBankAccountSchema.parseAsync({
      params: { id: "EMP1" },
      body: { ...BANK_PAYLOAD, paymentMethod: "BANK_TRANSFER" },
    }),
    (err: unknown) => {
      assert.ok(err instanceof ZodError, "expected a ZodError instance");
      const issue = (err as ZodError).issues.find((i) => i.path.includes("paymentMethod"));
      assert.ok(issue, "expected an issue on body.paymentMethod");
      return true;
    }
  );
});

test("invalid accountType raises a ZodError on body.accountType", async () => {
  await assert.rejects(
    () => createBankAccountSchema.parseAsync({
      params: { id: "EMP1" },
      body: { ...BANK_PAYLOAD, accountType: "FIXED_DEPOSIT" },
    }),
    (err: unknown) => err instanceof ZodError
  );
});

// ── Middleware-level regression (the exact 500 path that used to fire) ───

test("validate middleware: invalid enum returns 400 with field-level errors (never the generic 500)", async () => {
  const middleware = validate(createBankAccountSchema);
  const res = mockRes();
  let nextCalled = false;
  await middleware(
    { body: { ...BANK_PAYLOAD, paymentMethod: "WIRE" }, query: {}, params: { id: "EMP1" } } as any,
    res,
    () => { nextCalled = true; }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(nextCalled, false);
  assert.equal(res.body.success, false);
  assert.ok(Array.isArray(res.body.errors), "errors[] with field-level messages expected");
  const routing = res.body.errors.find((e: any) => String(e.path).includes("paymentMethod"));
  assert.ok(routing, "expected a field-level error for body.paymentMethod");
});

test("validate middleware: the real BANK payload passes through to the controller", async () => {
  const middleware = validate(createBankAccountSchema);
  const res = mockRes();
  let nextCalled = false;
  await middleware(
    { body: BANK_PAYLOAD, query: {}, params: { id: "EMP1" } } as any,
    res,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 0, "no error response written");
});
