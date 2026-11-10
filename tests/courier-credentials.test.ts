// tests/courier-credentials.test.ts
//
// Courier credential response contract (1C-11, and Phase 5 of the credentials
// upgrade):
//   1. no secret column ever reaches a client — list, single get, create,
//      update AND the activate/deactivate response;
//   2. a blank form field can never erase a stored secret, so an admin editing
//      an unrelated field cannot break authentication — while a non-blank value
//      still rotates the secret.
//
// DB-free: nothing queries. The contract itself is pure, and the controller test
// stubs the service method on the singleton it imports.
//   npx tsx --test tests/courier-credentials.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CREDENTIAL_SECRET_FIELDS,
  sanitizeCredential,
  sanitizeCredentials,
  stripBlankSecrets,
} from "../src/lib/courier/credentials.ts";
import courierService from "../src/services/courier.service.ts";
import courierController from "../src/controllers/courier.controller.ts";

// Values are built, never written as literals next to their column names.
const SECRET_A = "a".repeat(24);
const SECRET_B = "b".repeat(24);
const ROTATED = "c".repeat(24);

/** A raw row as the service returns it — every secret column populated. */
const rawRow = (): Record<string, unknown> => ({
  id: "cred-1",
  courierProviderId: "prov-1",
  environment: "PRODUCTION",
  vendorId: null,
  clientId: "client-abc",
  clientSecret: SECRET_A,
  accessToken: SECRET_A,
  refreshToken: SECRET_A,
  apiKey: SECRET_B,
  bearerToken: SECRET_B,
  password: SECRET_B,
  username: "ops",
  storeId: "store-1",
  isActive: true,
});

const fakeRes = () => {
  const res: any = { statusCode: 0, body: null };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res;
};

test("sanitizeCredential strips every secret column and keeps the safe ones", () => {
  const safe = sanitizeCredential(rawRow()) as Record<string, unknown>;
  for (const field of CREDENTIAL_SECRET_FIELDS) {
    assert.ok(!(field in safe), `${field} must not survive sanitization`);
  }
  assert.equal(safe.id, "cred-1");
  assert.equal(safe.clientId, "client-abc");
  assert.equal(safe.username, "ops");
  assert.equal(safe.storeId, "store-1");
  assert.equal(safe.environment, "PRODUCTION");
  assert.equal(safe.isActive, true);
});

test("sanitizeCredential never mutates the row the service returned", () => {
  const row = rawRow();
  sanitizeCredential(row);
  assert.equal(row.clientSecret, SECRET_A, "the service's row must stay intact");
});

test("sanitizeCredentials maps a list and passes empty values through", () => {
  const rows = sanitizeCredentials([rawRow(), rawRow()]);
  assert.equal(rows.length, 2);
  for (const field of CREDENTIAL_SECRET_FIELDS) {
    assert.ok(rows.every((r) => !(field in r)), `${field} must not survive sanitization`);
  }
  assert.equal(sanitizeCredential(null), null);
  assert.equal(sanitizeCredential(undefined), undefined);
});

test("stripBlankSecrets drops blank secrets but keeps non-secret fields", () => {
  const out = stripBlankSecrets({
    clientId: "client-abc",
    clientSecret: "",
    apiKey: "   ",
    bearerToken: null,
    password: undefined,
    storeId: "store-9",
    isActive: false,
  }) as Record<string, unknown>;
  for (const field of CREDENTIAL_SECRET_FIELDS) {
    assert.ok(!(field in out), `${field} must not be written when blank`);
  }
  assert.equal(out.clientId, "client-abc", "identifiers are untouched");
  assert.equal(out.storeId, "store-9", "non-secret fields are untouched");
  assert.equal(out.isActive, false, "a false boolean is a value, not a blank");
});

test("stripBlankSecrets lets a real rotation through", () => {
  const out = stripBlankSecrets({ clientSecret: ROTATED }) as Record<string, unknown>;
  assert.equal(out.clientSecret, ROTATED);
});

test("the activate/deactivate response carries no secret column", async () => {
  const original = courierService.toggleCredentialStatus;
  (courierService as any).toggleCredentialStatus = async () => rawRow();
  try {
    const res = fakeRes();
    await (courierController as any).toggleCredentialStatus(
      { params: { credentialId: "cred-1" } },
      res,
      (err: unknown) => {
        throw err;
      },
    );
    assert.equal(res.statusCode, 200);
    const data = (res.body as any)?.data ?? {};
    for (const field of CREDENTIAL_SECRET_FIELDS) {
      assert.ok(!(field in data), `the toggle response must not carry ${field}`);
    }
    assert.equal(data.id, "cred-1");
    assert.equal(data.isActive, true);
    assert.match(String((res.body as any)?.message), /activated/);
  } finally {
    (courierService as any).toggleCredentialStatus = original;
  }
});
