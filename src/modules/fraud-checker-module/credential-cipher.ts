import crypto from "node:crypto";

// ============================================================
// CREDENTIAL CIPHER
// Encrypts/decrypts fraud-checker provider credentials (API keys,
// secrets, usernames) before they touch the database, using
// AES-256-GCM (authenticated encryption — tampering with the stored
// ciphertext is detected, not just blocked from decrypting cleanly).
//
// Master key comes from ENV, never from the database or code:
//   FRAUD_CRED_ENCRYPTION_KEY=<64 hex chars = 32 bytes>
// Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Rotate this key by re-encrypting all rows (see rotateKey() below) —
// never by editing ciphertext directly.
// ============================================================

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM
const FORMAT_VERSION = "v1";

function loadMasterKey(): Buffer {
  const hex = process.env.FRAUD_CRED_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "FRAUD_CRED_ENCRYPTION_KEY is not set. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
        "and set it in your environment (never commit it).",
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("FRAUD_CRED_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars).");
  }
  return key;
}

/**
 * Encrypts an arbitrary JSON-serializable credentials object
 * (e.g. { apiKey: "...", apiSecret: "..." }) into a single string
 * safe to store in FraudCheckerProvider.credentialsEncrypted.
 */
export function encryptCredentials(credentials: Record<string, unknown>): string {
  const key = loadMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [FORMAT_VERSION, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/**
 * Reverses encryptCredentials(). Throws if the ciphertext was tampered
 * with, truncated, or encrypted under a different key.
 */
export function decryptCredentials<T extends Record<string, unknown> = Record<string, unknown>>(
  stored: string,
): T {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Unrecognized credential ciphertext format.");
  }
  const [, ivB64, authTagB64, ciphertextB64] = parts;

  const key = loadMasterKey();
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/**
 * For the admin UI: never send decrypted secrets back to the browser.
 * Shows only enough to let an admin confirm "yes, this is the right
 * key" (e.g. "ak_live_••••••••3f2a").
 */
export function maskCredentials(credentials: Record<string, unknown>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [field, value] of Object.entries(credentials)) {
    const str = String(value ?? "");
    masked[field] = str.length <= 4 ? "••••" : `${"•".repeat(Math.max(str.length - 4, 4))}${str.slice(-4)}`;
  }
  return masked;
}

/**
 * Re-encrypts a stored ciphertext under the CURRENT master key.
 * Use this in a one-off migration script when rotating
 * FRAUD_CRED_ENCRYPTION_KEY: decrypt with the OLD key (temporarily set
 * as FRAUD_CRED_ENCRYPTION_KEY), capture the plaintext, set the NEW
 * key, then call encryptCredentials() again per row.
 */
export function rotateKeyReencrypt(storedUnderOldKey: string): Record<string, unknown> {
  return decryptCredentials(storedUnderOldKey);
}
