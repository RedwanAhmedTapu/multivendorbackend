// tests/courier-pricing-rules-validation.test.ts
//
// Focused validation tests for the Courier Pricing Rules admin write paths
// (courier.service.ts createPricingRule / updatePricingRule). Each case below
// is a value the pricing path would otherwise misread silently:
//
//   codChargeValue -- getSteadfastPricing reads
//       codChargeType === 'PERCENT' ? codChargeValue / 100 * codAmount : codChargeValue
//     and then clamps anything not finite/negative to 0. So a typo'd type
//     ('PERSENT') quietly becomes a flat fee, a PERCENT above 100 charges more
//     than the COD amount itself, and NaN becomes no COD fee at all.
//   itemType -- the price-cache lookups only ever use 'PARCEL'.
//   priority -- a non-finite value used to reach Prisma and surface as a raw
//     ORM error instead of a 400 the controller can hand back cleanly.
//
// DB-free: Prisma delegates are in-memory stubs.
//   npx tsx --test tests/courier-pricing-rules-validation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import courierService, { courierServiceDb } from "../src/services/courier.service.ts";

type Row = Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function stubber() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  return { set, restore: () => restores.reverse().forEach((r) => r()) };
}

/** A stored rule, so the update paths have something to load and re-validate against. */
const storedRule = (over: Row = {}): Row => ({
  id: "RULE_1",
  courierProviderId: "P_PROVIDER",
  vendorId: null,
  deliveryType: "NORMAL",
  deliveryTypeCode: null,
  itemType: "PARCEL",
  itemTypeCode: null,
  fromLocationId: null,
  toLocationId: null,
  minWeight: 0,
  maxWeight: null,
  basePrice: 100,
  perKgCharge: 0,
  codChargeType: "PERCENT",
  codChargeValue: 2,
  fuelSurcharge: 0,
  validFrom: new Date("2026-01-01T00:00:00Z"),
  validTo: null,
  isActive: true,
  priority: 100,
  ...over,
});

function installWorld(seed: Row[] = []) {
  const s = stubber();
  const rules: Row[] = seed.map(clone);
  const db = courierServiceDb as any;

  s.set(db.courierProviders, "findUnique", async ({ where }: any) =>
    where.id === "P_PROVIDER" ? { id: "P_PROVIDER", name: "Steadfast" } : null
  );
  s.set(db.locations, "findUnique", async ({ where }: any) => ({ id: where.id }));
  s.set(db.courierPricingRules, "findUnique", async ({ where }: any) =>
    clone(rules.find((r) => r.id === where.id) ?? null)
  );
  s.set(db.courierPricingRules, "create", async ({ data }: any) => {
    const row = { id: `RULE_${rules.length + 1}`, ...clone(data) };
    rules.push(row);
    return clone(row);
  });
  s.set(db.courierPricingRules, "update", async ({ where, data }: any) => {
    const row = rules.find((r) => r.id === where.id);
    if (!row) throw new Error("not found");
    Object.assign(row, clone(data));
    return clone(row);
  });

  return { rules, restore: s.restore };
}

const create = (over: Row = {}) => ({
  courierProviderId: "P_PROVIDER",
  basePrice: 50,
  ...over,
});

// ── codChargeValue on create ────────────────────────────────────────────────

test("create rejects a codChargeValue with no codChargeType", async () => {
  const world = installWorld();
  try {
    await assert.rejects(
      courierService.createPricingRule(create({ codChargeValue: 5 }) as any),
      /codChargeValue requires codChargeType/
    );
  } finally {
    world.restore();
  }
});

test("create rejects an unsupported codChargeType instead of treating it as flat", async () => {
  const world = installWorld();
  try {
    // 'PERSENT' is the dangerous case: getSteadfastPricing's else-branch would
    // read the 2 as an absolute amount rather than 2% of the COD amount.
    await assert.rejects(
      courierService.createPricingRule(
        create({ codChargeType: "PERSENT", codChargeValue: 2 }) as any
      ),
      /Unsupported codChargeType 'PERSENT'/
    );
  } finally {
    world.restore();
  }
});

test("create rejects a PERCENT codChargeValue above 100", async () => {
  const world = installWorld();
  try {
    await assert.rejects(
      courierService.createPricingRule(
        create({ codChargeType: "PERCENT", codChargeValue: 101 }) as any
      ),
      /must not exceed 100 when codChargeType is 'PERCENT'/
    );
  } finally {
    world.restore();
  }
});

test("create rejects negative and non-finite codChargeValue", async () => {
  const world = installWorld();
  try {
    for (const value of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        courierService.createPricingRule(
          create({ codChargeType: "FLAT", codChargeValue: value }) as any
        ),
        /codChargeValue must be a finite non-negative number/,
        `codChargeValue ${value}`
      );
    }
  } finally {
    world.restore();
  }
});

test("create accepts the PERCENT boundary (100) and normalizes the type case", async () => {
  const world = installWorld();
  try {
    const atBoundary = await courierService.createPricingRule(
      create({ codChargeType: "percent", codChargeValue: 100 }) as any
    );
    assert.equal(atBoundary.codChargeType, "PERCENT");
    assert.equal(atBoundary.codChargeValue, 100);

    const flat = await courierService.createPricingRule(
      create({ codChargeType: "flat", codChargeValue: 150 }) as any
    );
    assert.equal(flat.codChargeType, "FLAT");
    // An absolute COD fee is not bounded by 100 - only PERCENT is.
    assert.equal(flat.codChargeValue, 150);

    const none = await courierService.createPricingRule(create() as any);
    assert.equal(none.codChargeType, null);
    assert.equal(none.codChargeValue, null);
  } finally {
    world.restore();
  }
});

// ── itemType on create ─────────────────────────────────────────────────────

test("create normalizes itemType and rejects one the pricing path never matches", async () => {
  const world = installWorld();
  try {
    const lowercased = await courierService.createPricingRule(
      create({ itemType: "parcel" }) as any
    );
    assert.equal(lowercased.itemType, "PARCEL");

    // Omitted still defaults, exactly as before.
    const defaulted = await courierService.createPricingRule(create() as any);
    assert.equal(defaulted.itemType, "PARCEL");

    await assert.rejects(
      courierService.createPricingRule(create({ itemType: "DOCUMENT" }) as any),
      /Unsupported itemType 'DOCUMENT'/
    );
  } finally {
    world.restore();
  }
});

// ── priority on update ─────────────────────────────────────────────────────

test("update rejects a non-finite or non-integer priority with a clean message", async () => {
  const world = installWorld([storedRule()]);
  try {
    for (const value of ["abc", 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        courierService.updatePricingRule("RULE_1", { priority: value } as any),
        /priority must be a finite integer/,
        `priority ${value}`
      );
    }
    // The stored row is untouched by a rejected update.
    assert.equal(world.rules[0].priority, 100);
  } finally {
    world.restore();
  }
});

test("update still accepts a valid integer priority", async () => {
  const world = installWorld([storedRule()]);
  try {
    const updated = await courierService.updatePricingRule("RULE_1", { priority: 25 } as any);
    assert.equal(updated.priority, 25);
  } finally {
    world.restore();
  }
});

// ── codChargeValue on update ───────────────────────────────────────────────

test("update bounds a PERCENT value against the stored type when only the value is sent", async () => {
  const world = installWorld([storedRule({ codChargeType: "PERCENT", codChargeValue: 2 })]);
  try {
    await assert.rejects(
      courierService.updatePricingRule("RULE_1", { codChargeValue: 150 } as any),
      /must not exceed 100 when codChargeType is 'PERCENT'/
    );
    await assert.rejects(
      courierService.updatePricingRule("RULE_1", { codChargeValue: -1 } as any),
      /codChargeValue must be a finite non-negative number/
    );

    const flatRule = installWorld([storedRule({ id: "RULE_FLAT", codChargeType: "FLAT" })]);
    try {
      const updated = await courierService.updatePricingRule("RULE_FLAT", {
        codChargeValue: 150,
      } as any);
      assert.equal(updated.codChargeValue, 150);
    } finally {
      flatRule.restore();
    }
  } finally {
    world.restore();
  }
});

test("update rejects a value when the rule has no type, and clears both when the type is cleared", async () => {
  const world = installWorld([storedRule({ id: "RULE_NONE", codChargeType: null, codChargeValue: null })]);
  try {
    await assert.rejects(
      courierService.updatePricingRule("RULE_NONE", { codChargeValue: 5 } as any),
      /codChargeValue requires codChargeType/
    );
  } finally {
    world.restore();
  }

  const clearing = installWorld([storedRule()]);
  try {
    const updated = await courierService.updatePricingRule("RULE_1", {
      codChargeType: null,
    } as any);
    // A value without a type is meaningless, so it goes with it.
    assert.equal(updated.codChargeType, null);
    assert.equal(updated.codChargeValue, null);
  } finally {
    clearing.restore();
  }
});

// ── itemType on update ─────────────────────────────────────────────────────

test("update normalizes itemType the same way create does", async () => {
  const world = installWorld([storedRule()]);
  try {
    const updated = await courierService.updatePricingRule("RULE_1", {
      itemType: "parcel",
    } as any);
    assert.equal(updated.itemType, "PARCEL");

    await assert.rejects(
      courierService.updatePricingRule("RULE_1", { itemType: "DOCUMENT" } as any),
      /Unsupported itemType 'DOCUMENT'/
    );
  } finally {
    world.restore();
  }
});

// ── checkout parity: the accepted values are the ones pricing can read ──────

test("an accepted PERCENT rule prices as a percentage of the COD amount", async () => {
  const world = installWorld();
  try {
    const created = await courierService.createPricingRule(
      create({ basePrice: 80, codChargeType: "PERCENT", codChargeValue: 1.5 }) as any
    );
    // Mirrors getSteadfastPricing's arithmetic for a 1000 COD amount.
    const codAmount = 1000;
    const expected =
      created.codChargeType === "PERCENT"
        ? (Number(created.codChargeValue) / 100) * codAmount
        : Number(created.codChargeValue);
    assert.equal(expected, 15);
  } finally {
    world.restore();
  }
});
