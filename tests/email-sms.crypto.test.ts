// tests/email-sms.crypto.test.ts  —  npx tsx --test tests/email-sms.crypto.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  AddressUnreadableError, CampaignCryptoConfigError, addressHash, campaignKeysUsable,
  decryptAddress, encryptAddress, hashEquals, normalizeAddress, normalizeEmail, normalizePhone,
  resolveCampaignKeys,
} from "../src/modules/marketing/email-sms/campaign.crypto.ts";

const key = randomBytes(32);
const hashKey = randomBytes(32);

test("crypto: round-trip preserves the address and never stores it plainly", () => {
  const plain = "Buyer@Example.COM";
  const stored = encryptAddress(plain, key);
  assert.match(stored, /^v1:/);
  assert.equal(stored.includes(plain), false, "plaintext must not appear in the ciphertext");
  assert.equal(decryptAddress(stored, key), plain);
});

test("crypto: a fresh IV is used per encryption", () => {
  const a = encryptAddress("same@example.com", key);
  const b = encryptAddress("same@example.com", key);
  assert.notEqual(a, b, "identical input must not produce identical ciphertext");
  assert.equal(decryptAddress(a, key), decryptAddress(b, key));
});

test("crypto: tampering is rejected", () => {
  const stored = encryptAddress("x@example.com", key);
  const parts = stored.split(":");
  const ct = Buffer.from(parts[3], "base64"); ct[0] ^= 0xff; parts[3] = ct.toString("base64");
  assert.throws(() => decryptAddress(parts.join(":"), key), AddressUnreadableError);
});

test("crypto: a different key cannot decrypt", () => {
  const stored = encryptAddress("x@example.com", key);
  assert.throws(() => decryptAddress(stored, randomBytes(32)), AddressUnreadableError);
});

test("crypto: malformed or unknown-version payloads are rejected", () => {
  for (const bad of ["", "v9:a:b:c", "v1:only-three-parts".split(":")[0] + ":aa:bb", "nonsense"]) {
    assert.throws(() => decryptAddress(bad, key), AddressUnreadableError, `should reject ${bad}`);
  }
});

test("crypto: key validation fails closed", () => {
  assert.throws(() => encryptAddress("a", Buffer.alloc(16)), CampaignCryptoConfigError);
  assert.throws(() => addressHash("a", Buffer.alloc(8)), CampaignCryptoConfigError);
  assert.throws(() => resolveCampaignKeys({} as any), CampaignCryptoConfigError);
  assert.throws(() => resolveCampaignKeys({ CAMPAIGN_ADDRESS_KEY: "short" } as any), CampaignCryptoConfigError);
  assert.equal(campaignKeysUsable({} as any), false);
  assert.equal(campaignKeysUsable({ CAMPAIGN_ADDRESS_KEY: key.toString("base64"), CAMPAIGN_ADDRESS_HASH_KEY: hashKey.toString("base64") } as any), true);
  const k = resolveCampaignKeys({ CAMPAIGN_ADDRESS_KEY: key.toString("base64"), CAMPAIGN_ADDRESS_HASH_KEY: hashKey.toString("base64") } as any);
  assert.equal(k.encryptionKey.length, 32);
});

test("crypto: normalisation is conservative and channel-specific", () => {
  assert.equal(normalizeEmail("  Buyer@Example.COM "), "buyer@example.com");
  assert.equal(normalizePhone("+880 (171) 234-5678"), "+8801712345678");
  assert.equal(normalizePhone("01712-345678"), "01712345678");
  assert.equal(normalizeAddress("EMAIL", " A@B.CO "), "a@b.co");
  assert.equal(normalizeAddress("SMS", "+880 1712 345678"), "+8801712345678");
});

test("crypto: hashing is stable, keyed and non-reversible", () => {
  const h1 = addressHash("buyer@example.com", hashKey);
  const h2 = addressHash("buyer@example.com", hashKey);
  assert.equal(h1, h2, "same address + same key must match, or suppression breaks");
  assert.equal(h1.length, 64);
  assert.notEqual(h1, addressHash("buyer@example.com", randomBytes(32)), "a different key must not produce the same hash");
  assert.notEqual(h1, addressHash("buyer2@example.com", hashKey));
  assert.equal(hashEquals(h1, h2), true);
  assert.equal(hashEquals(h1, h1.replace(/^./, (c) => (c === "a" ? "b" : "a"))), false);
});