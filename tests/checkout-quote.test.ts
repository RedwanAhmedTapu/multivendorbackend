// tests/checkout-quote.test.ts
//
// PHASE 2 (H-3): the checkout preview IS the order-placement computation.
//   • planAllocation is the unchanged reservation rule (default warehouse
//     first, then most stock, split as needed); allocateStockForOrderItem —
//     used by Pay Now and the vendor reallocation — writes exactly that plan.
//   • The preview (cartWish calculateDeliveryFees → buildCheckoutQuote) and
//     placement (placeOrder) produce the same allocation, the same
//     per-warehouse delivery charges and the same totals.
//   • quoteHash is stable for unchanged state and changes with price,
//     allocation, delivery charge, address and quantity — not payment method.
//   • placeOrder writes NOTHING unless the recomputed quote matches the
//     reviewed quoteHash, and prices changed since the items were added are
//     acknowledged: missing hash → QUOTE_REQUIRED; mismatch → 409
//     CHECKOUT_CHANGED (QUOTE_CHANGED / PRICE_ACK_REQUIRED) with the fresh
//     quote; no order, reservation, stock change, payment row or cart change.
//   • Client amounts are never used; a repeated submission never places a
//     second order.
//
// DB-free: an in-memory store (stock rows, warehouses, variants, cart) backs
// the services' Prisma delegates and a $transaction stub that snapshots and
// restores it on failure; courierService.getLowestDeliveryQuote is stubbed
// (no courier API). Proves the shared computation and the guards, NOT
// PostgreSQL serialization/rollback (S4). Run with:
//   npx tsx --test tests/checkout-quote.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OrderService,
  orderServiceDb,
  planAllocation,
  buildCheckoutQuote,
  allocateStockForOrderItem,
  CheckoutChangedError,
  QuoteRequiredError,
} from "../src/services/order.service.ts";
import cartWishService, { cartWishDb, AddressNotFoundError } from "../src/services/cartWish.service.ts";
import courierService from "../src/services/courier.service.ts";
import { OrderController } from "../src/controllers/order.controller.ts";
import { CartWishController } from "../src/controllers/cartWish.controller.ts";
import { fraudCheckerService } from "../src/modules/fraud-checker-module/index.ts";

// ── in-memory world ─────────────────────────────────────────────────────────

type Row = Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

interface World {
  warehouses: Row[];
  stock: Row[];
  variants: Row[];
  cartItems: Row[];
  /** Delivery charge per pickup location (+ 10 per started kg). */
  rates: Record<string, number>;
  orders: Row[];
  allocations: Row[];
  payments: Row[];
  writes: string[];
}

function world(): World {
  return {
    warehouses: [
      { id: "WH-A", vendorId: "V1", isActive: true, isDefault: true, name: "Dhaka Hub", locationId: "LOC-DHK", location: { name: "Dhaka" } },
      { id: "WH-B", vendorId: "V1", isActive: true, isDefault: false, name: "Ctg Store", locationId: "LOC-CTG", location: { name: "Chattogram" } },
      { id: "WH-C", vendorId: "V2", isActive: true, isDefault: true, name: "Sylhet Depot", locationId: "LOC-SYL", location: { name: "Sylhet" } },
    ],
    stock: [
      { id: "S1", variantId: "VAR1", warehouseId: "WH-A", rackId: null, rowNumber: null, shelfNumber: null, quantity: 5, reservedQty: 0, damagedQty: 0 },
      { id: "S2", variantId: "VAR1", warehouseId: "WH-B", rackId: null, rowNumber: null, shelfNumber: null, quantity: 50, reservedQty: 0, damagedQty: 0 },
      { id: "S3", variantId: "VAR2", warehouseId: "WH-C", rackId: null, rowNumber: null, shelfNumber: null, quantity: 9, reservedQty: 0, damagedQty: 0 },
    ],
    variants: [
      { id: "VAR1", price: "1200.0000", specialPrice: "960.0000", taxRate: null, avgCost: null, product: { vendorId: "V1", warranty: { packageWeightValue: 0.5, packageWeightUnit: "KG" }, vendor: { storeName: "Bright Home" } } },
      { id: "VAR2", price: "500.0000", specialPrice: null, taxRate: null, avgCost: null, product: { vendorId: "V2", warranty: { packageWeightValue: 1, packageWeightUnit: "KG" }, vendor: { storeName: "Clay Co" } } },
    ],
    cartItems: [{ id: "L1", cartId: "CART1", variantId: "VAR1", quantity: 3, price: 960, isSelected: true }],
    rates: { "LOC-DHK": 60, "LOC-CTG": 120, "LOC-SYL": 90 },
    orders: [],
    allocations: [],
    payments: [],
    writes: [],
  };
}

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([k, v]) => (v === null ? (row[k] ?? null) === null : v && typeof v === "object" ? true : row[k] === v));

/** The Prisma delegates the quote, allocation and placement code use. */
function delegates(w: World) {
  const whById = (id: string) => w.warehouses.find((x) => x.id === id)!;
  return {
    productVariant: {
      findMany: async ({ where }: any) => clone(w.variants.filter((v) => where.id.in.includes(v.id))),
      update: async () => (w.writes.push("productVariant.update"), {}),
    },
    warehouseStock: {
      // findAllocatableStockRows: vendor + active warehouse, ordered default-first, then most quantity
      findMany: async ({ where, orderBy }: any) => {
        assert.deepEqual(orderBy, [{ warehouse: { isDefault: "desc" } }, { quantity: "desc" }], "allocation order unchanged");
        const notIn: string[] = where.warehouse?.id?.notIn ?? [];
        return clone(
          w.stock
            .filter((s) => s.variantId === where.variantId)
            .filter((s) => {
              const wh = whById(s.warehouseId);
              return wh.vendorId === where.warehouse.vendorId && wh.isActive === true && !notIn.includes(wh.id);
            })
            .map((s) => ({ ...s, warehouse: { id: s.warehouseId, isDefault: whById(s.warehouseId).isDefault } }))
            .sort((a, b) => Number(b.warehouse.isDefault) - Number(a.warehouse.isDefault) || b.quantity - a.quantity),
        );
      },
      findFirst: async ({ where }: any) => clone(w.stock.find((s) => matches(s, where)) ?? null),
      update: async ({ where, data }: any) => {
        w.writes.push("warehouseStock.update");
        const s = w.stock.find((x) => x.id === where.id)!;
        for (const k of ["quantity", "reservedQty", "damagedQty"]) s[k] += data[k]?.increment ?? 0;
        return clone(s);
      },
      create: async () => assert.fail("no new stock rows expected"),
    },
    vendorWarehouse: {
      findMany: async ({ where }: any) =>
        clone(w.warehouses.filter((x) => where.id.in.includes(x.id) && x.vendorId === where.vendorId)),
    },
  };
}

/** Wires the world into both services' clients + the courier quote stub. */
function install(w: World, opts: { addressUserId?: string } = {}) {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const had = Object.prototype.hasOwnProperty.call(obj, key);
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (had ? (obj[key] = orig) : delete obj[key]));
  };
  const d = delegates(w);
  const address = { id: "A1", userId: opts.addressUserId ?? "U1", locationId: "LOC-CUST", phone: "017", fullName: "R", addressLine1: "A", locations: { name: "Customer" } };

  for (const db of [cartWishDb as any, orderServiceDb as any]) {
    set(db.productVariant, "findMany", d.productVariant.findMany);
    set(db.warehouseStock, "findMany", d.warehouseStock.findMany);
    set(db.vendorWarehouse, "findMany", d.vendorWarehouse.findMany);
    set(db.userAddress, "findFirst", async ({ where }: any) => (where.id === address.id && where.userId === address.userId ? { ...address } : null));
    set(db.carts, "findFirst", async () => {
      const lines = w.cartItems.filter((l) => l.isSelected);
      return {
        id: "CART1",
        cart_items: lines.map((l) => {
          const v = w.variants.find((x) => x.id === l.variantId)!;
          return { ...l, product_variants: { ...clone(v), product: { vendorId: v.product.vendorId } } };
        }),
      };
    });
  }
  set(orderServiceDb.user as any, "findUnique", async () => ({ isVerified: true, createdAt: new Date(0) }));
  set(fraudCheckerService as any, "checkPhone", async () => null);
  set(orderServiceDb.notification as any, "create", async () => ({}));
  set(courierService as any, "getLowestDeliveryQuote", async (pickups: any[], _to: string, weight: number) => ({
    charge: w.rates[pickups[0].locationId] + 10 * Math.ceil(weight),
    courierProviderId: "P1",
    courierName: "TestCourier",
  }));

  // placeOrder's transaction: the same world, snapshot/restore on failure.
  set(orderServiceDb as any, "$transaction", async (fn: any) => {
    const snap = clone({ stock: w.stock, cartItems: w.cartItems, orders: w.orders, allocations: w.allocations, payments: w.payments, writes: w.writes });
    const tx = {
      ...d,
      cart_items: {
        findMany: async () =>
          w.cartItems
            .filter((l) => l.isSelected)
            .map((l) => {
              const v = w.variants.find((x) => x.id === l.variantId)!;
              return { id: l.id, product_variants: { availability: true, price: v.price, specialPrice: v.specialPrice, product: { isDeleted: false, approvalStatus: "ACTIVE" } } };
            }),
        deleteMany: async () => {
          w.writes.push("cart_items.deleteMany");
          w.cartItems = w.cartItems.filter((l) => !l.isSelected);
          return {};
        },
      },
      order: {
        create: async ({ data }: any) => {
          w.writes.push("order.create");
          const id = `O${w.orders.length + 1}`;
          const order = {
            id,
            ...data,
            vendorOrders: data.vendorOrders.create.map((vo: any, i: number) => ({
              id: `${id}-VO${i + 1}`,
              ...vo,
              vendor: { id: vo.vendorId },
              items: vo.items.create.map((it: any, j: number) => ({ id: `${id}-VO${i + 1}-I${j + 1}`, ...it, variant: { id: it.variantId } })),
            })),
          };
          w.orders.push(order);
          return clone(order);
        },
        findUnique: async ({ where }: any) => clone(w.orders.find((o) => o.id === where.id) ?? null),
      },
      orderItemAllocation: {
        create: async ({ data }: any) => {
          w.writes.push("orderItemAllocation.create");
          w.allocations.push(clone(data));
          return data;
        },
      },
      payment: { create: async ({ data }: any) => (w.writes.push("payment.create"), w.payments.push(clone(data)), data) },
      auditLog: { create: async () => (w.writes.push("auditLog.create"), {}) },
    };
    try {
      return await fn(tx);
    } catch (e) {
      Object.assign(w, clone(snap));
      throw e;
    }
  });
  return () => restores.reverse().forEach((r) => r());
}

const preview = () => cartWishService.calculateDeliveryFees("U1", "", "A1") as Promise<any>;
const place = (review: Row, method = "COD") => new OrderService().placeOrder("U1", "A1", method as any, review);

async function outcome(p: Promise<unknown>) {
  try {
    await p;
    return "PLACED";
  } catch (e: any) {
    if (e instanceof CheckoutChangedError) return `409:${e.reason}`;
    if (e instanceof QuoteRequiredError) return "400:QUOTE_REQUIRED";
    return `ERROR:${e.message}`;
  }
}

/** Shipments (warehouse → cart item → qty) as the preview showed them. */
const previewAllocation = (q: any) =>
  q.vendors.flatMap((v: any) => v.shipments.flatMap((s: any) => s.items.map((i: any) => `${s.warehouseId}:${i.cartItemId}:${i.quantity}`))).sort();

// ── planAllocation / allocateStockForOrderItem (unchanged behavior) ─────────

test("planAllocation: takes rows in the given order (default first), splits, reports shortfall", () => {
  const rows = [
    { warehouseId: "WH-A", rackId: null, rowNumber: null, shelfNumber: null, sellable: 5 },
    { warehouseId: "WH-B", rackId: "R1", rowNumber: 2, shelfNumber: 3, sellable: 50 },
  ];
  assert.deepEqual(planAllocation(rows, 3).takes.map((t) => [t.warehouseId, t.take]), [["WH-A", 3]]);
  assert.deepEqual(planAllocation(rows, 8).takes.map((t) => [t.warehouseId, t.take, t.rackId]), [["WH-A", 5, null], ["WH-B", 3, "R1"]]);
  const short = planAllocation(rows, 56);
  assert.equal(short.sufficient, false);
  assert.equal(short.totalSellable, 55);
  assert.deepEqual(short.takes, []);
});

test("allocateStockForOrderItem (Pay Now / vendor reallocation) writes exactly the plan, default warehouse first", async () => {
  const w = world();
  const d = delegates(w);
  const tx: any = { ...d, orderItemAllocation: { create: async ({ data }: any) => (w.allocations.push(data), data) } };
  await allocateStockForOrderItem(tx, "ITEM1", "VAR1", "V1", 8);
  assert.deepEqual(w.allocations.map((a) => [a.warehouseId, a.quantity, a.reservedQty]), [["WH-A", 5, 5], ["WH-B", 3, 3]]);
  assert.deepEqual(w.stock.filter((s) => s.variantId === "VAR1").map((s) => [s.id, s.reservedQty]), [["S1", 5], ["S2", 3]]);
  // excludeWarehouseIds (vendor reallocation) still honoured
  const w2 = world();
  const tx2: any = { ...delegates(w2), orderItemAllocation: { create: async ({ data }: any) => (w2.allocations.push(data), data) } };
  await allocateStockForOrderItem(tx2, "ITEM1", "VAR1", "V1", 2, ["WH-A"]);
  assert.deepEqual(w2.allocations.map((a) => [a.warehouseId, a.quantity]), [["WH-B", 2]]);
  // shortfall keeps its message and writes nothing
  const w3 = world();
  const tx3: any = { ...delegates(w3), orderItemAllocation: { create: async () => assert.fail("no write") } };
  await assert.rejects(allocateStockForOrderItem(tx3, "ITEM1", "VAR1", "V1", 99), /Insufficient sellable stock for variant VAR1: have 55, need 99/);
});

// ── preview = placement ─────────────────────────────────────────────────────

async function parity(w: World) {
  const restore = install(w);
  try {
    const q = await preview();
    assert.equal(await outcome(place({ quoteHash: q.quoteHash, acknowledgePriceChanges: true })), "PLACED");
    const order = w.orders[0];
    return { q, order };
  } finally {
    restore();
  }
}

test("parity — default warehouse preferred: preview and placement both ship from WH-A at WH-A's charge", async () => {
  const w = world(); // VAR1 × 3: WH-A (default, 5) beats WH-B (50)
  const { q, order } = await parity(w);
  assert.deepEqual(previewAllocation(q), ["WH-A:L1:3"]);
  assert.deepEqual(w.allocations.map((a) => [a.warehouseId, a.quantity]), [["WH-A", 3]]);
  assert.equal(q.vendors[0].shipments[0].charge, 60 + 10 * Math.ceil(1.5));
  assert.equal(Number(order.vendorOrders[0].shippingCost), q.vendors[0].shippingCost);
  assert.equal(Number(order.totalAmount), q.grandTotal);
  assert.equal(q.grandTotal, 960 * 3 + 80);
});

test("parity — split allocation: 8 units → WH-A 5 + WH-B 3, two shipments charged in preview AND order", async () => {
  const w = world();
  w.cartItems[0].quantity = 8;
  const { q, order } = await parity(w);
  assert.deepEqual(previewAllocation(q), ["WH-A:L1:5", "WH-B:L1:3"]);
  assert.deepEqual(w.allocations.map((a) => [a.warehouseId, a.quantity]), [["WH-A", 5], ["WH-B", 3]]);
  const charges = q.vendors[0].shipments.map((s: any) => [s.warehouseId, s.charge]);
  assert.deepEqual(charges, [["WH-A", 60 + 10 * Math.ceil(2.5)], ["WH-B", 120 + 10 * Math.ceil(1.5)]]);
  assert.equal(q.vendors[0].shippingCost, 90 + 140);
  assert.equal(Number(order.vendorOrders[0].shippingCost), 230);
  assert.equal(Number(order.shippingCost), 230);
  assert.equal(Number(order.totalAmount), 960 * 8 + 230);
});

test("parity — two vendors: one vendor order each, each with its own warehouse charge", async () => {
  const w = world();
  w.cartItems.push({ id: "L2", cartId: "CART1", variantId: "VAR2", quantity: 2, price: 500, isSelected: true });
  const { q, order } = await parity(w);
  assert.deepEqual(q.vendors.map((v: any) => [v.vendorId, v.shippingCost]), [["V1", 80], ["V2", 90 + 20]]);
  assert.deepEqual(order.vendorOrders.map((vo: any) => [vo.vendorId, Number(vo.shippingCost), Number(vo.subtotal)]), [["V1", 80, 2880], ["V2", 110, 1000]]);
  assert.equal(Number(order.totalAmount), 2880 + 1000 + 80 + 110);
  assert.equal(w.payments.length, 0, "COD: no payment row");
});

test("online payment: the payment row carries the quote's grand total", async () => {
  const w = world();
  const restore = install(w);
  try {
    const q = await preview();
    assert.equal(await outcome(place({ quoteHash: q.quoteHash }, "SSLCOMMERZ")), "PLACED");
    assert.equal(Number(w.payments[0].amount), q.grandTotal);
  } finally {
    restore();
  }
});

// ── quoteHash ───────────────────────────────────────────────────────────────

test("quoteHash: stable for unchanged state; changes with price, allocation, delivery charge, address and quantity", async () => {
  const hashOf = async (mutate: (w: World) => void, addressId = "A1") => {
    const w = world();
    mutate(w);
    const restore = install(w);
    try {
      const { quote } = await buildCheckoutQuote(cartWishDb, {
        userAddressId: addressId,
        userLocationId: "LOC-CUST",
        lines: w.cartItems.map((l) => ({ cartItemId: l.id, variantId: l.variantId, quantity: l.quantity, cartPrice: l.price })),
      });
      return quote.quoteHash;
    } finally {
      restore();
    }
  };
  const base = await hashOf(() => {});
  assert.equal(await hashOf(() => {}), base, "stable");
  assert.notEqual(await hashOf((w) => (w.variants[0].specialPrice = "900.0000")), base, "price");
  assert.notEqual(await hashOf((w) => (w.stock[0].quantity = 0)), base, "allocation (default warehouse emptied)");
  assert.notEqual(await hashOf((w) => (w.rates["LOC-DHK"] = 70)), base, "delivery charge");
  assert.notEqual(await hashOf(() => {}, "A2"), base, "address");
  assert.notEqual(await hashOf((w) => (w.cartItems[0].quantity = 4)), base, "quantity");
});

test("quoteHash ignores the payment method (it changes no amount)", async () => {
  const w = world();
  const restore = install(w);
  try {
    const q = await preview();
    assert.equal(await outcome(place({ quoteHash: q.quoteHash }, "SSLCOMMERZ")), "PLACED", "a COD-reviewed quote places as online too");
  } finally {
    restore();
  }
});

// ── placement guards: nothing written unless the reviewed quote matches ─────

function unchanged(w: World, before: World) {
  assert.deepEqual(w.orders, [], "no order");
  assert.deepEqual(w.allocations, [], "no reservation");
  assert.deepEqual(w.payments, [], "no payment row");
  assert.deepEqual(w.stock, before.stock, "stock untouched");
  assert.deepEqual(w.cartItems, before.cartItems, "cart untouched");
  assert.deepEqual(w.writes, [], "no write at all");
}

test("missing quoteHash → QUOTE_REQUIRED before any read or write", async () => {
  const w = world();
  const before = clone(w);
  const restore = install(w);
  try {
    assert.equal(await outcome(place({})), "400:QUOTE_REQUIRED");
    assert.equal(await outcome(place({ quoteHash: "" })), "400:QUOTE_REQUIRED");
    unchanged(w, before);
  } finally {
    restore();
  }
});

for (const [label, mutate] of [
  ["price rose after review", (w: World) => (w.variants[0].specialPrice = "1000.0000")],
  ["stock moved (default warehouse emptied) → allocation changed", (w: World) => (w.stock[0].quantity = 0)],
  ["courier charge changed", (w: World) => (w.rates["LOC-DHK"] = 75)],
] as const) {
  test(`stale preview: ${label} → 409 QUOTE_CHANGED with the fresh quote, nothing written`, async () => {
    const w = world();
    const restore = install(w);
    try {
      const reviewed = await preview();
      mutate(w);
      const before = clone(w);
      let err: any;
      try {
        await place({ quoteHash: reviewed.quoteHash, acknowledgePriceChanges: true });
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof CheckoutChangedError, `got ${err?.message}`);
      assert.equal(err.reason, "QUOTE_CHANGED");
      assert.notEqual(err.quote.quoteHash, reviewed.quoteHash, "fresh quote returned");
      unchanged(w, before);
      // the customer confirms the fresh quote → placed at the fresh amounts
      assert.equal(await outcome(place({ quoteHash: err.quote.quoteHash, acknowledgePriceChanges: true })), "PLACED");
      assert.equal(Number(w.orders[0].totalAmount), err.quote.grandTotal);
    } finally {
      restore();
    }
  });
}

test("price changed since the item was added (legacy regular-price snapshot): ack required, then charged at the current price", async () => {
  const w = world();
  w.cartItems[0].price = 1200; // saved before the selling-price fix; special 960 now applies
  const restore = install(w);
  try {
    const q = await preview();
    assert.deepEqual(q.priceChanges.map((l: any) => [l.cartItemId, l.cartPrice, l.price]), [["L1", 1200, 960]]);
    const before = clone(w);
    assert.equal(await outcome(place({ quoteHash: q.quoteHash })), "409:PRICE_ACK_REQUIRED");
    assert.equal(await outcome(place({ quoteHash: q.quoteHash, acknowledgePriceChanges: false })), "409:PRICE_ACK_REQUIRED");
    unchanged(w, before);
    assert.equal(w.cartItems[0].price, 1200, "the cart snapshot is never silently updated");
    assert.equal(await outcome(place({ quoteHash: q.quoteHash, acknowledgePriceChanges: true })), "PLACED");
    assert.equal(Number(w.orders[0].vendorOrders[0].items[0].price), 960, "order item = the confirmed current price");
  } finally {
    restore();
  }
});

test("an invalid special price never applies: regular-price lines need no acknowledgment", async () => {
  for (const specialPrice of [null, "0", "1200.0000", "1500.0000"]) {
    const w = world();
    w.variants[0].specialPrice = specialPrice;
    w.cartItems[0].price = 1200;
    const restore = install(w);
    try {
      const q = await preview();
      assert.equal(q.priceChanges.length, 0, `special=${specialPrice}`);
      assert.equal(await outcome(place({ quoteHash: q.quoteHash })), "PLACED", `special=${specialPrice}`);
      assert.equal(Number(w.orders[0].vendorOrders[0].items[0].price), 1200);
    } finally {
      restore();
    }
  }
});

test("repeated submission: the second identical request never places a second order", async () => {
  const w = world();
  const restore = install(w);
  try {
    const q = await preview();
    assert.equal(await outcome(place({ quoteHash: q.quoteHash })), "PLACED");
    const second = await outcome(place({ quoteHash: q.quoteHash }));
    assert.match(second, /No selected items in cart|Checkout already processed/);
    assert.equal(w.orders.length, 1);
  } finally {
    restore();
  }
});

test("unsuppliable quote (stock short) is reported in the preview and never placed", async () => {
  const w = world();
  w.cartItems[0].quantity = 99;
  const restore = install(w);
  try {
    const q = await preview();
    assert.equal(q.complete, false);
    assert.match(q.vendors[0].error, /Insufficient sellable stock for variant VAR1: have 55, need 99/);
    assert.match(await outcome(place({ quoteHash: q.quoteHash })), /ERROR:Insufficient sellable stock/);
    assert.equal(w.orders.length, 0);
  } finally {
    restore();
  }
});

// ── preview ownership + controllers ─────────────────────────────────────────

test("preview: an address that is not the customer's own → AddressNotFoundError (404), nothing quoted", async () => {
  const w = world();
  const restore = install(w, { addressUserId: "SOMEONE-ELSE" });
  try {
    await assert.rejects(preview(), (e: any) => e instanceof AddressNotFoundError);
  } finally {
    restore();
  }
});

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

test("cart controller: non-owned address → 404", async () => {
  const orig = (cartWishService as any).calculateDeliveryFees;
  (cartWishService as any).calculateDeliveryFees = async () => {
    throw new AddressNotFoundError();
  };
  try {
    const res = fakeRes();
    await new CartWishController().calculateDeliveryFees({ user: { id: "U1" }, headers: {}, body: { userAddressId: "A9" } } as any, res, () => assert.fail("not forwarded"));
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, "ADDRESS_NOT_FOUND");
  } finally {
    (cartWishService as any).calculateDeliveryFees = orig;
  }
});

test("cart controller: incomplete quote → success: false with courier error message (not mistaken for free delivery)", async () => {
  const orig = (cartWishService as any).calculateDeliveryFees;
  const incompleteQuote = {
    quoteHash: "hash-incomplete",
    userAddressId: "A1",
    lines: [],
    vendors: [
      {
        vendorId: "V1",
        vendorName: "Store 1",
        subtotal: 138210,
        shippingCost: 0,
        shipments: [],
        error: "No courier available for this delivery route",
      },
    ],
    subtotal: 138210,
    shippingTotal: 0,
    grandTotal: 138210,
    complete: false,
    priceChanges: [],
  };
  (cartWishService as any).calculateDeliveryFees = async () => incompleteQuote;
  try {
    const res = fakeRes();
    await new CartWishController().calculateDeliveryFees(
      { user: { id: "U1" }, headers: {}, body: { userAddressId: "A1" } } as any,
      res,
      () => assert.fail("not forwarded"),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, false, "success must be false for incomplete quote");
    assert.equal(res.body.message, "No courier available for this delivery route");
    assert.equal(res.body.data.complete, false);
    assert.equal(res.body.data.shippingTotal, 0);
  } finally {
    (cartWishService as any).calculateDeliveryFees = orig;
  }
});

test("cart controller: calculateDeliveryFees reads parameters from query string for GET requests", async () => {
  const orig = (cartWishService as any).calculateDeliveryFees;
  let receivedArgs: any[] = [];
  const completeQuote = {
    quoteHash: "hash-complete",
    userAddressId: "A1",
    lines: [],
    vendors: [{ vendorId: "V1", vendorName: "Store 1", subtotal: 100, shippingCost: 60, shipments: [] }],
    subtotal: 100,
    shippingTotal: 60,
    grandTotal: 160,
    complete: true,
    priceChanges: [],
  };
  (cartWishService as any).calculateDeliveryFees = async (...args: any[]) => {
    receivedArgs = args;
    return completeQuote;
  };
  try {
    const res = fakeRes();
    await new CartWishController().calculateDeliveryFees(
      {
        user: { id: "U1" },
        headers: {},
        body: {},
        query: { userAddressId: "A1", codEnabled: "true", selectedItemIds: "item1,item2" },
      } as any,
      res,
      () => assert.fail("not forwarded"),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, "Delivery fees calculated successfully");
    assert.equal(receivedArgs[0], "U1");
    assert.equal(receivedArgs[2], "A1");
    assert.equal(receivedArgs[3], true);
    assert.deepEqual(receivedArgs[4], ["item1", "item2"]);
  } finally {
    (cartWishService as any).calculateDeliveryFees = orig;
  }
});

test("order controller: only quoteHash + acknowledgment are forwarded — never client amounts; errors map to 400 / 409", async () => {
  const proto = OrderService.prototype as any;
  const orig = proto.placeOrder;
  const calls: unknown[][] = [];
  try {
    proto.placeOrder = async (...args: unknown[]) => (calls.push(args), { id: "O1" });
    let res = fakeRes();
    await new OrderController().placeOrder(
      { user: { id: "U1", rawId: "U1" }, body: { userAddressId: "A1", paymentMethod: "COD", quoteHash: "h1", totalAmount: 1, shippingCost: 0, items: [{ price: 1 }] } } as any,
      res,
    );
    assert.equal(res.statusCode, 201);
    assert.deepEqual(calls, [["U1", "A1", "COD", { quoteHash: "h1", acknowledgePriceChanges: false }]]);

    proto.placeOrder = async () => {
      throw new QuoteRequiredError();
    };
    res = fakeRes();
    await new OrderController().placeOrder({ user: { id: "U1" }, body: { userAddressId: "A1", paymentMethod: "COD" } } as any, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "QUOTE_REQUIRED");

    const quote: any = { quoteHash: "new", lines: [], vendors: [], subtotal: 0, shippingTotal: 0, grandTotal: 0, complete: true, priceChanges: [], userAddressId: "A1" };
    proto.placeOrder = async () => {
      throw new CheckoutChangedError("QUOTE_CHANGED", quote);
    };
    res = fakeRes();
    await new OrderController().placeOrder({ user: { id: "U1" }, body: { userAddressId: "A1", paymentMethod: "COD", quoteHash: "old" } } as any, res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual([res.body.code, res.body.reason, res.body.data.quote.quoteHash], ["CHECKOUT_CHANGED", "QUOTE_CHANGED", "new"]);
  } finally {
    proto.placeOrder = orig;
  }
});

test("quoteWarehouseShipments: invalid or negative courier delivery charge causes quote error and blocks checkout", async () => {
  const w = world();
  const restore = install(w);
  const orig = courierService.getLowestDeliveryQuote;
  try {
    for (const badCharge of [-10, NaN, null, undefined, Infinity] as any[]) {
      (courierService as any).getLowestDeliveryQuote = async () => ({
        charge: badCharge,
        courierProviderId: "P1",
        courierName: "TestCourier",
      });
      const q = await preview();
      assert.equal(q.complete, false, `quote should be incomplete for bad charge: ${badCharge}`);
      assert.equal(q.vendors[0].error, "No courier available for this delivery route");
      assert.equal(await outcome(place({ quoteHash: q.quoteHash })), "ERROR:No courier available for this delivery route");
    }
  } finally {
    (courierService as any).getLowestDeliveryQuote = orig;
    restore();
  }
});

test("quoteWarehouseShipments: explicitly authorized 0 delivery charge (free shipping) is accepted in quote and placement", async () => {
  const w = world();
  const restore = install(w);
  const orig = courierService.getLowestDeliveryQuote;
  try {
    (courierService as any).getLowestDeliveryQuote = async () => ({
      charge: 0,
      courierProviderId: "P1",
      courierName: "FreeCourier",
    });
    const q = await preview();
    assert.equal(q.complete, true, "quote complete with free shipping");
    assert.equal(q.shippingTotal, 0, "shippingTotal is 0");
    assert.equal(q.grandTotal, q.subtotal, "grandTotal equals subtotal");
    assert.equal(await outcome(place({ quoteHash: q.quoteHash })), "PLACED");
    assert.equal(Number(w.orders[0].shippingCost), 0, "order shippingCost is 0");
    assert.equal(Number(w.orders[0].totalAmount), q.subtotal, "order total equals subtotal");
  } finally {
    (courierService as any).getLowestDeliveryQuote = orig;
    restore();
  }
});

