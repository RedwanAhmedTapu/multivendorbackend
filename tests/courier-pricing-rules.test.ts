// tests/courier-pricing-rules.test.ts
//
// Tests for Platform Courier Pricing Rules management:
//   - Validation: vendorId rejection, deliveryType restriction, weight bands, dates, non-negative amounts.
//   - CRUD: listing with filters/pagination, creation, updating, toggle active/inactive, deletion.
//   - Checkout engine parity: newly created/active rules are matched by getLowestDeliveryQuote.
//
// DB-free: Prisma delegates are in-memory stubs.
// Run with:
//   npx tsx --test tests/courier-pricing-rules.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import courierService, { courierServiceDb } from "../src/services/courier.service.ts";
import courierController from "../src/controllers/courier.controller.ts";

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

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res;
}

const NOW = new Date("2026-10-14T00:00:00Z");

function installPricingWorld() {
  const s = stubber();
  const providers: Row[] = [
    { id: "P_STEADFAST", name: "Steadfast", slug: "steadfast", isActive: true, isPreferred: false, priority: 100 },
    { id: "P_PATHAO", name: "Pathao", slug: "pathao", isActive: true, isPreferred: false, priority: 100 },
  ];
  const locations: Row[] = [
    { id: "LOC_DHK", name: "Dhaka", level: "DISTRICT" },
    { id: "LOC_CTG", name: "Chattogram", level: "DISTRICT" },
  ];
  const rules: Row[] = [];

  const db = courierServiceDb as any;

  s.set(db.courierProviders, "findUnique", async ({ where }: any) => {
    return clone(providers.find((p) => p.id === where.id) ?? null);
  });
  s.set(db.courierProviders, "findMany", async () => clone(providers));

  s.set(db.locations, "findUnique", async ({ where }: any) => {
    return clone(locations.find((l) => l.id === where.id) ?? null);
  });

  s.set(db.courierPricingRules, "findMany", async ({ where, skip = 0, take = 50, orderBy }: any) => {
    let list = rules.filter((r) => {
      if (where.vendorId === null && r.vendorId !== null) return false;
      if (where.courierProviderId && r.courierProviderId !== where.courierProviderId) return false;
      if (where.isActive !== undefined && r.isActive !== where.isActive) return false;
      if (where.deliveryType && r.deliveryType !== where.deliveryType) return false;
      if (where.fromLocationId !== undefined && r.fromLocationId !== where.fromLocationId) return false;
      if (where.toLocationId !== undefined && r.toLocationId !== where.toLocationId) return false;
      return true;
    });
    return clone(list.slice(skip, skip + take));
  });

  s.set(db.courierPricingRules, "findFirst", async ({ where }: any) => {
    const list = rules.filter((r) => {
      if (where.vendorId === null && r.vendorId !== null) return false;
      if (where.courierProviderId && r.courierProviderId !== where.courierProviderId) return false;
      if (where.isActive !== undefined && r.isActive !== where.isActive) return false;
      if (where.deliveryType && r.deliveryType !== where.deliveryType) return false;
      if (where.fromLocationId !== undefined && r.fromLocationId !== where.fromLocationId) return false;
      if (where.toLocationId !== undefined && r.toLocationId !== where.toLocationId) return false;
      if (where.AND) {
        for (const cond of where.AND) {
          if (cond.isActive !== undefined && r.isActive !== cond.isActive) return false;
          if (cond.deliveryType && r.deliveryType !== cond.deliveryType) return false;
          if (cond.vendorId === null && r.vendorId !== null) return false;
          if (cond.minWeight?.lte !== undefined && r.minWeight > cond.minWeight.lte) return false;
        }
      }
      return true;
    });
    return clone(list[0] ?? null);
  });

  s.set(db.courierPricingRules, "findUnique", async ({ where }: any) => {
    return clone(rules.find((r) => r.id === where.id) ?? null);
  });

  s.set(db.courierPricingRules, "count", async ({ where }: any) => {
    return rules.filter((r) => {
      if (where.vendorId === null && r.vendorId !== null) return false;
      if (where.courierProviderId && r.courierProviderId !== where.courierProviderId) return false;
      if (where.isActive !== undefined && r.isActive !== where.isActive) return false;
      return true;
    }).length;
  });

  s.set(db.courierPricingRules, "create", async ({ data }: any) => {
    const row = {
      id: `RULE_${rules.length + 1}`,
      createdAt: new Date(),
      ...clone(data),
      courier_providers: providers.find((p) => p.id === data.courierProviderId),
    };
    rules.push(row);
    return clone(row);
  });

  s.set(db.courierPricingRules, "update", async ({ where, data }: any) => {
    const idx = rules.findIndex((r) => r.id === where.id);
    if (idx === -1) throw new Error("not found");
    Object.assign(rules[idx], clone(data));
    return clone(rules[idx]);
  });

  s.set(db.courierPricingRules, "delete", async ({ where }: any) => {
    const idx = rules.findIndex((r) => r.id === where.id);
    if (idx === -1) throw new Error("not found");
    rules.splice(idx, 1);
    return { id: where.id };
  });

  return { rules, restore: s.restore };
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("createPricingRule: rejects vendorId (vendor-scoped pricing not supported)", async () => {
  const world = installPricingWorld();
  try {
    await assert.rejects(
      courierService.createPricingRule({
        courierProviderId: "P_STEADFAST",
        vendorId: "VEND_1",
        basePrice: 60,
      }),
      /Vendor-scoped pricing rules are not supported yet/
    );
  } finally {
    world.restore();
  }
});

test("createPricingRule: rejects unsupported deliveryType", async () => {
  const world = installPricingWorld();
  try {
    await assert.rejects(
      courierService.createPricingRule({
        courierProviderId: "P_STEADFAST",
        deliveryType: "EXPRESS",
        basePrice: 60,
      }),
      /Unsupported deliveryType 'EXPRESS'/
    );
  } finally {
    world.restore();
  }
});

test("createPricingRule: rejects negative basePrice, perKgCharge, fuelSurcharge, or minWeight", async () => {
  const world = installPricingWorld();
  try {
    await assert.rejects(
      courierService.createPricingRule({
        courierProviderId: "P_STEADFAST",
        basePrice: -10,
      }),
      /basePrice must be a finite non-negative number/
    );
    await assert.rejects(
      courierService.createPricingRule({
        courierProviderId: "P_STEADFAST",
        basePrice: 50,
        perKgCharge: -5,
      }),
      /perKgCharge must be a finite non-negative number/
    );
    await assert.rejects(
      courierService.createPricingRule({
        courierProviderId: "P_STEADFAST",
        basePrice: 50,
        fuelSurcharge: -1,
      }),
      /fuelSurcharge must be a finite non-negative number/
    );
    await assert.rejects(
      courierService.createPricingRule({
        courierProviderId: "P_STEADFAST",
        basePrice: 50,
        minWeight: -0.5,
      }),
      /minWeight must be a finite non-negative number/
    );
  } finally {
    world.restore();
  }
});

test("createPricingRule: rejects contradictory weights (maxWeight <= minWeight)", async () => {
  const world = installPricingWorld();
  try {
    await assert.rejects(
      courierService.createPricingRule({
        courierProviderId: "P_STEADFAST",
        basePrice: 50,
        minWeight: 5,
        maxWeight: 2,
      }),
      /maxWeight \(2\) must be greater than minWeight \(5\)/
    );
  } finally {
    world.restore();
  }
});

test("createPricingRule: rejects contradictory dates (validTo <= validFrom)", async () => {
  const world = installPricingWorld();
  try {
    await assert.rejects(
      courierService.createPricingRule({
        courierProviderId: "P_STEADFAST",
        basePrice: 50,
        validFrom: new Date("2026-10-15T00:00:00Z"),
        validTo: new Date("2026-10-14T00:00:00Z"),
      }),
      /validTo must be strictly after validFrom/
    );
  } finally {
    world.restore();
  }
});

test("createPricingRule: rejects unknown provider and locations", async () => {
  const world = installPricingWorld();
  try {
    await assert.rejects(
      courierService.createPricingRule({
        courierProviderId: "P_UNKNOWN",
        basePrice: 50,
      }),
      /Courier provider P_UNKNOWN not found/
    );
    await assert.rejects(
      courierService.createPricingRule({
        courierProviderId: "P_STEADFAST",
        fromLocationId: "LOC_UNKNOWN",
        basePrice: 50,
      }),
      /From location LOC_UNKNOWN not found/
    );
    await assert.rejects(
      courierService.createPricingRule({
        courierProviderId: "P_STEADFAST",
        toLocationId: "LOC_UNKNOWN",
        basePrice: 50,
      }),
      /To location LOC_UNKNOWN not found/
    );
  } finally {
    world.restore();
  }
});

test("CRUD lifecycle: create, list with pagination/filter, update, toggle, delete", async () => {
  const world = installPricingWorld();
  try {
    // 1. Create rule
    const created = await courierService.createPricingRule({
      courierProviderId: "P_STEADFAST",
      basePrice: 120,
      perKgCharge: 15,
      fromLocationId: "LOC_DHK",
      toLocationId: "LOC_CTG",
      minWeight: 0,
      maxWeight: 10,
    });
    assert.ok(created.id);
    assert.equal(created.basePrice, 120);
    assert.equal(created.vendorId, null);
    assert.equal(created.deliveryType, "NORMAL");
    assert.equal(created.isActive, true);

    // 2. List rules
    const list = await courierService.listPricingRules({ courierProviderId: "P_STEADFAST" });
    assert.equal(list.rules.length, 1);
    assert.equal(list.pagination.total, 1);

    // 3. Update rule
    const updated = await courierService.updatePricingRule(created.id, {
      basePrice: 140,
    });
    assert.equal(updated.basePrice, 140);

    // 4. Toggle active status
    const toggled = await courierService.togglePricingRuleStatus(created.id);
    assert.equal(toggled.isActive, false);

    // 5. Delete rule
    const deleted = await courierService.deletePricingRule(created.id);
    assert.equal(deleted.deleted, true);
    assert.equal(world.rules.length, 0);
  } finally {
    world.restore();
  }
});

test("controller endpoints: success and error mapping", async () => {
  const world = installPricingWorld();
  try {
    // Controller create
    const reqCreate: any = {
      body: { courierProviderId: "P_STEADFAST", basePrice: 80 },
    };
    const resCreate = fakeRes();
    await courierController.createPricingRule(reqCreate, resCreate, () => {});
    assert.equal(resCreate.statusCode, 201);
    assert.equal(resCreate.body.success, true);
    const ruleId = resCreate.body.data.id;

    // Controller list
    const reqList: any = { query: {} };
    const resList = fakeRes();
    await courierController.listPricingRules(reqList, resList, () => {});
    assert.equal(resList.statusCode, 200);
    assert.equal(resList.body.data.length, 1);

    // Controller toggle
    const reqToggle: any = { params: { id: ruleId } };
    const resToggle = fakeRes();
    await courierController.togglePricingRule(reqToggle, resToggle, () => {});
    assert.equal(resToggle.statusCode, 200);
    assert.equal(resToggle.body.data.isActive, false);

    // Controller update error on unknown
    const reqUpdateBad: any = { params: { id: "UNKNOWN_ID" }, body: { basePrice: 90 } };
    const resUpdateBad = fakeRes();
    await courierController.updatePricingRule(reqUpdateBad, resUpdateBad, () => {});
    assert.equal(resUpdateBad.statusCode, 404);
  } finally {
    world.restore();
  }
});

test("checkout engine compatibility: created rule is picked up by getLowestDeliveryQuote", async () => {
  const world = installPricingWorld();
  try {
    // Add nationwide Steadfast rule
    await courierService.createPricingRule({
      courierProviderId: "P_STEADFAST",
      basePrice: 85,
      perKgCharge: 10,
      minWeight: 0,
      maxWeight: null,
      isActive: true,
    });

    const quote = await courierService.getLowestDeliveryQuote(
      [{ warehouseId: "WH1", locationId: "LOC_DHK" }],
      "LOC_CTG",
      1
    );

    assert.equal(quote.courierName, "Steadfast");
    assert.equal(quote.charge, 85);
  } finally {
    world.restore();
  }
});
