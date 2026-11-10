// tests/cart-price-snapshot.test.ts
//
// PHASE 1 (C1): cart line price snapshots and checkout price authority.
//   • addToCart snapshots the server-computed selling price (approved rule);
//     compareAtPrice = regular price only while a valid discount is active;
//     a client-supplied price is ignored.
//   • getCart never reports negative savings for lines snapshotted before the fix.
//   • (Phase 2) placement-side price checks live in tests/checkout-quote.test.ts.
//
// DB-free: the cart service's own Prisma client (cartWishDb) is stubbed.
// Run with:
//   npx tsx --test tests/cart-price-snapshot.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import cartWishService, { cartWishDb } from "../src/services/cartWish.service.ts";

function stubber() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const had = Object.prototype.hasOwnProperty.call(obj, key);
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (had ? (obj[key] = orig) : delete obj[key]));
  };
  return { set, restore: () => restores.reverse().forEach((r) => r()) };
}

const fail = (label: string) => async () => assert.fail(`${label} must not run`);

// ── addToCart snapshot ──────────────────────────────────────────────────────

async function addWith(variant: { price: unknown; specialPrice: unknown }, extra: Record<string, unknown> = {}) {
  const s = stubber();
  const db = cartWishDb as any;
  let created: any = null;
  s.set(db.carts, "findUnique", async () => ({ id: "CART1", isGuest: false }));
  s.set(db.carts, "update", async () => ({ id: "CART1" }));
  s.set(db.productVariant, "findUnique", async () => ({
    id: "VAR1",
    productId: "P1",
    availability: true,
    product: { id: "P1", name: "Shirt", slug: "shirt", vendorId: "V1" },
    ...variant,
  }));
  s.set(db.warehouseStock, "aggregate", async () => ({ _sum: { quantity: 10, reservedQty: 0, damagedQty: 0 } }));
  s.set(db.cart_items, "findUnique", async ({ where }: any) => (where.id ? { id: where.id, ...created } : null));
  s.set(db.cart_items, "create", async ({ data }: any) => {
    created = data;
    return data;
  });
  try {
    await cartWishService.addToCart({ userId: "U1", productId: "P1", variantId: "VAR1", quantity: 1, ...extra } as any);
    return created;
  } finally {
    s.restore();
  }
}

test("addToCart snapshots the selling price: valid discount → special price, compareAtPrice = regular", async () => {
  const line = await addWith({ price: "1200.0000", specialPrice: "960.0000" });
  assert.equal(line.price, 960);
  assert.equal(line.compareAtPrice, 1200);
});

test("addToCart: null / zero / negative / equal / greater special → regular price, no compareAtPrice", async () => {
  for (const specialPrice of [null, "0", "-5", "1200.0000", "1500.0000"]) {
    const line = await addWith({ price: "1200.0000", specialPrice });
    assert.equal(line.price, 1200, `special=${specialPrice}`);
    assert.equal(line.compareAtPrice, null, `special=${specialPrice}`);
  }
});

test("addToCart ignores a client-supplied price", async () => {
  const line = await addWith({ price: "1200.0000", specialPrice: "960.0000" }, { price: 1, compareAtPrice: 99999 });
  assert.equal(line.price, 960);
  assert.equal(line.compareAtPrice, 1200);
});

test("getCart: a line snapshotted before the fix (compareAtPrice below price) reports no negative savings", async () => {
  const s = stubber();
  const db = cartWishDb as any;
  s.set(db.carts, "findFirst", async () => ({
    id: "CART1",
    cart_items: [
      { id: "L1", variantId: "VAR1", quantity: 2, price: 1200, compareAtPrice: 960, isSelected: true, product_variants: { availability: true } },
      { id: "L2", variantId: "VAR2", quantity: 1, price: 960, compareAtPrice: 1200, isSelected: true, product_variants: { availability: true } },
    ],
  }));
  s.set(db.warehouseStock, "groupBy", async () => []);
  try {
    const cart: any = await cartWishService.getCart("U1");
    const byId = new Map(cart.items.map((i: any) => [i.id, i]));
    assert.equal((byId.get("L1") as any).savings, 0, "legacy inverted snapshot → no savings");
    assert.equal((byId.get("L2") as any).savings, 240, "real discount → (1200 − 960) × 1");
  } finally {
    s.restore();
  }
});

// Placement-side price authority (reviewed quote vs current prices, the
// acknowledgment of prices changed since the items were added, and the
// controller contract) moved with Phase 2 (H-3) to tests/checkout-quote.test.ts.
