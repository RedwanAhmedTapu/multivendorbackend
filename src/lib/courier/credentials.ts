// src/lib/courier/credentials.ts
//
// The single home for the courier-credential response contract.
//
// 1C-11 (B1): a CourierCredential row carries provider secrets (client secret,
// access/refresh tokens, api key, bearer token, password). Every response that
// carries a credential row must pass through sanitizeCredential() /
// sanitizeCredentials() so those columns never reach a client — the list, the
// single get, create, update and the activate/deactivate response alike.
//
// Extracted from courier.controller.ts, where the helper existed but only some
// handlers called it, so the contract can be unit-tested and reused everywhere
// without re-declaring the field list.

/** Columns of CourierCredential that must never leave the server. */
export const CREDENTIAL_SECRET_FIELDS = [
  "clientSecret",
  "accessToken",
  "refreshToken",
  "apiKey",
  "bearerToken",
  "password",
] as const;

/** A copy of the row without any secret column. Never mutates the input. */
export function sanitizeCredential<T extends Record<string, any> | null | undefined>(row: T): T {
  if (!row || typeof row !== "object") return row;
  const clone: any = { ...row };
  for (const f of CREDENTIAL_SECRET_FIELDS) delete clone[f];
  return clone;
}

export const sanitizeCredentials = <T extends Record<string, any>>(rows: T[]): T[] =>
  rows.map(sanitizeCredential);

/**
 * Update payload with absent or blank secret values removed.
 *
 * A credential form submits every field, so an untouched secret arrives as ""
 * (or undefined/null). Writing that would erase a working secret: an admin
 * edits an unrelated field — a store id, a username — and the provider stops
 * authenticating. Rotation still works, because a non-blank value is written
 * through unchanged. Non-secret fields are deliberately untouched here, since
 * clearing one of those may be intentional.
 */
export function stripBlankSecrets<T extends Record<string, any>>(data: T): T {
  const out: any = { ...data };
  for (const f of CREDENTIAL_SECRET_FIELDS) {
    const v = out[f];
    const blank = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    if (blank) delete out[f];
  }
  return out;
}
