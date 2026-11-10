// modules/marketing/email-sms/campaign.crypto.ts
//
// Recipient address protection: AES-256-GCM for storage, keyed HMAC-SHA256 for
// suppression lookup. Two SEPARATE keys by design — the hash key must never be
// derivable from the encryption key, otherwise anyone able to decrypt could also
// enumerate the suppression index.
//
// Stored format (single column): v1:<b64 iv>:<b64 tag>:<b64 ciphertext>
// The version prefix is what makes rotation possible at all.
//
// Fail-closed: missing or malformed keys throw a ConfigError; callers must treat
// that as "do not send". Nothing here logs an address, a key or a ciphertext.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CIPHER_VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class CampaignCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignCryptoConfigError";
  }
}

/** Raised when a stored address cannot be decrypted (wrong key, tampering, bad format). */
export class AddressUnreadableError extends Error {
  constructor(message = "Recipient address could not be read") {
    super(message);
    this.name = "AddressUnreadableError";
  }
}

export type CampaignKeys = { encryptionKey: Buffer; hashKey: Buffer };

function decodeKey(raw: string | undefined, name: string): Buffer {
  const value = (raw ?? "").trim();
  if (!value) throw new CampaignCryptoConfigError(`${name} is not configured`);
  let buf: Buffer;
  try {
    buf = Buffer.from(value, "base64");
  } catch {
    throw new CampaignCryptoConfigError(`${name} is not valid base64`);
  }
  if (buf.length !== KEY_BYTES) throw new CampaignCryptoConfigError(`${name} must decode to 32 bytes`);
  return buf;
}

/**
 * Resolves both keys from the environment. Callers must not catch this to
 * "continue anyway": without keys there is no safe way to send.
 */
export function resolveCampaignKeys(env: NodeJS.ProcessEnv = process.env): CampaignKeys {
  return {
    encryptionKey: decodeKey(env.CAMPAIGN_ADDRESS_KEY, "CAMPAIGN_ADDRESS_KEY"),
    hashKey: decodeKey(env.CAMPAIGN_ADDRESS_HASH_KEY, "CAMPAIGN_ADDRESS_HASH_KEY"),
  };
}

/** True when both keys are present and valid — used by boot checks. */
export function campaignKeysUsable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    resolveCampaignKeys(env);
    return true;
  } catch {
    return false;
  }
}

export function encryptAddress(plain: string, encryptionKey: Buffer): string {
  if (encryptionKey.length !== KEY_BYTES) throw new CampaignCryptoConfigError("encryption key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CIPHER_VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptAddress(stored: string, encryptionKey: Buffer): string {
  if (encryptionKey.length !== KEY_BYTES) throw new CampaignCryptoConfigError("encryption key must be 32 bytes");
  const parts = String(stored ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) throw new AddressUnreadableError("Unsupported address format");
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new AddressUnreadableError();
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (err) {
    if (err instanceof AddressUnreadableError) throw err;
    throw new AddressUnreadableError();
  }
}

/** Email: trim + lowercase. Deliberately conservative — no dot-stripping, no plus-mangling. */
export function normalizeEmail(raw: string): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** Phone: keep a leading + and digits only (E.164 shape). */
export function normalizePhone(raw: string): string {
  const s = String(raw ?? "").trim();
  const plus = s.startsWith("+");
  const digits = s.replace(/\D+/g, "");
  return (plus ? "+" : "") + digits;
}

export function normalizeAddress(channel: "EMAIL" | "SMS", raw: string): string {
  return channel === "EMAIL" ? normalizeEmail(raw) : normalizePhone(raw);
}

/** Keyed HMAC of the normalised address; hex, fixed length, never reversible. */
export function addressHash(normalized: string, hashKey: Buffer): string {
  if (hashKey.length !== KEY_BYTES) throw new CampaignCryptoConfigError("hash key must be 32 bytes");
  return createHmac("sha256", hashKey).update(normalized, "utf8").digest("hex");
}

/** Constant-time comparison for hashes read from the database. */
export function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(String(a ?? ""), "hex");
  const bb = Buffer.from(String(b ?? ""), "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}
