// tests/pricing-effective.test.ts
//
// PHASE 1 (C1): the approved selling-price rule in modules/shared/pricing.ts.
// effectivePrice = specialPrice ONLY when 0 < specialPrice < regularPrice,
// otherwise the regular price. The storefront helper
// (multivendorsite src/lib/pricing/effective-price.ts) is tested with the SAME
// cases in multivendorsite tests/pricing.test.mjs. Pure — no database. Run with:
//   npx tsx --test tests/pricing-effective.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@prisma/client/runtime/library";
import { effectivePrice, discountPercent, samePrice } from "../src/modules/shared/pricing.ts";

// [label, regular, special, expected price, discounted] — keep identical to the frontend list.
const CASES: [string, unknown, unknown, number, boolean][] = [
  ["valid discount", 1200, 960, 960, true],
  ["null special", 1200, null, 1200, false],
  ["undefined special", 1200, undefined, 1200, false],
  ["zero special", 1200, 0, 1200, false],
  ["negative special", 1200, -5, 1200, false],
  ["equal special", 1200, 1200, 1200, false],
  ["greater special", 1200, 1500, 1200, false],
  ["non-numeric special", 1200, "abc", 1200, false],
  ["empty-string special", 1200, "", 1200, false],
  ["string amounts (Decimal-as-string)", "2500.0000", "2000.5000", 2000.5, true],
];

test("effectivePrice follows the approved rule for every case", () => {
  for (const [label, regular, special, expected, discounted] of CASES) {
    const r = effectivePrice(regular as any, special as any);
    assert.equal(r.price.toNumber(), expected, `${label}: price`);
    assert.equal(r.discounted, discounted, `${label}: discounted`);
    assert.equal(r.compareAtPrice?.toNumber() ?? null, discounted ? Number(regular) : null, `${label}: compareAtPrice`);
  }
});

test("effectivePrice accepts Prisma Decimal inputs", () => {
  const r = effectivePrice(new Decimal("1000"), new Decimal("750"));
  assert.equal(r.price.toNumber(), 750);
  assert.equal(r.compareAtPrice?.toNumber(), 1000);
});

test("discountPercent: (regular − special) / regular, only for a valid discount, never negative", () => {
  assert.equal(discountPercent(1200, 960), 20);
  assert.equal(discountPercent(1000, 750), 25);
  for (const special of [null, 0, -5, 1200, 1500, "abc"]) {
    assert.equal(discountPercent(1200, special as any), 0, `special=${String(special)}`);
  }
});

test("discountPercent fixes the inverted formula: special 960 on price 1200 is 20%, not the old (960−1200)/960 → 0", () => {
  const old = Math.max(0, Math.round(((960 - 1200) / 960) * 100));
  assert.equal(old, 0, "the previous updatePrice formula produced 0% for a real 20% discount");
  assert.equal(discountPercent(1200, 960), 20);
});

test("samePrice compares at the database's 4-decimal scale", () => {
  assert.equal(samePrice(960, new Decimal("960.0000")), true);
  assert.equal(samePrice(960.5, "960.50"), true);
  assert.equal(samePrice(960, 960.01), false);
  assert.equal(samePrice(null, 960), false);
});
