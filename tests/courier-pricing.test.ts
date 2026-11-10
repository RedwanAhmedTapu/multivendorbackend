// tests/courier-pricing.test.ts
//
// Checkout delivery pricing (courier.service.ts):
//   Issue 4 — a cached Pathao/RedX quote is delivery-only, exactly like a live
//             quote (the provider's COD fee is not charged at checkout).
//   Issue 5 — both pricing-rule lookups (Steadfast rules, stored-rate
//             fallback) apply only rules that are active, inside their
//             validity window (validTo), standard ("NORMAL") delivery and
//             platform-wide (vendorId null).
//   Switch A — COURIER_LIVE_QUOTES: OFF by default outside production, ON in
//             production, overridable. While OFF, no Pathao/RedX price-API call
//             and no price-cache read/claim/refresh happens on any path
//             (checkout engine, selectBestCourier, the pricing functions), and
//             database-backed pricing still works.
//
// DB-free and network-free: Prisma delegates are in-memory stubs and every
// outbound HTTP request fails the test.
//   npx tsx --test tests/courier-pricing.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import courierService, {
  courierServiceDb,
  courierLiveQuotesEnabled,
  applicablePricingRuleWhere,
  LiveCourierQuotesDisabledError,
  isValidCourierDeliveryCharge,
} from "../src/services/courier.service.ts";

type Row = Record<string, any>;

// ── outbound HTTP guard (whole file) ────────────────────────────────────────
const outbound: string[] = [];
for (const mod of [http, https] as any[]) {
  for (const fn of ["request", "get"]) {
    const orig = mod[fn];
    mod[fn] = (...args: any[]) => {
      const a = args[0];
      const target = typeof a === "string" ? a : a instanceof URL ? a.href : `${a?.hostname ?? a?.host ?? "?"}${a?.path ?? ""}`;
      outbound.push(String(target));
      if (/^(https?:\/\/)?(localhost|127\.0\.0\.1)/.test(String(target))) return orig.apply(mod, args);
      throw new Error(`BLOCKED outbound HTTP in test: ${String(target).split("?")[0]}`);
    };
  }
}

// ── tiny Prisma `where` evaluator (AND / OR / equals / null / lte / gte / gt) ──
function matches(row: Row, where: Row): boolean {
  for (const [k, cond] of Object.entries(where ?? {})) {
    if (k === "AND") { if (!(cond as Row[]).every((w) => matches(row, w))) return false; continue; }
    if (k === "OR") { if (!(cond as Row[]).some((w) => matches(row, w))) return false; continue; }
    const v = row[k] ?? null;
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("lte" in cond && !(v !== null && v <= cond.lte)) return false;
      if ("gte" in cond && !(v !== null && v >= cond.gte)) return false;
      if ("gt" in cond && !(v !== null && v > cond.gt)) return false;
      continue;
    }
    if (cond === null ? v !== null : v !== cond) return false;
  }
  return true;
}

function stubber() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  return { set, restore: () => restores.reverse().forEach((r) => r()) };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const NOW = new Date();
const PAST = new Date(NOW.getTime() - 86_400_000);
const FUTURE = new Date(NOW.getTime() + 86_400_000);
const WH = { warehouseId: "WH1", locationId: "LOC-PICKUP" };
const DEST = "LOC-DEST";

const rule = (over: Row = {}): Row => ({
  id: "R", courierProviderId: "steadfast", vendorId: null, deliveryType: "NORMAL", itemType: "PARCEL",
  fromLocationId: null, toLocationId: null, minWeight: 0, maxWeight: null, basePrice: 100, perKgCharge: 0,
  codChargeType: null, codChargeValue: null, fuelSurcharge: 0, validFrom: PAST, validTo: null, isActive: true, priority: 100,
  ...over,
});

/**
 * Installs the in-memory world. `rules` are evaluated with the real `where`
 * the service builds; `cache` rows likewise. Returns call logs.
 */
function install(opts: {
  providers?: string[];
  rules?: Row[];
  cache?: Row[];
  pathaoQuote?: any;
  redxQuote?: any;
  pickupResolves?: boolean;
}) {
  const s = stubber();
  const log = { ruleWheres: [] as Row[], cacheCalls: [] as string[], resolve: [] as string[], quoteApi: [] as string[], area: [] as string[] };
  const providers = (opts.providers ?? ["pathao", "redx", "steadfast"]).map((id) => ({
    id, name: id === "pathao" ? "Pathao" : id === "redx" ? "RedX" : "Steadfast",
    isActive: true, isPreferred: false, priority: 100, courier_credentials: [],
  }));
  const rules = opts.rules ?? [];
  const cache: Row[] = (opts.cache ?? []).map((r) => ({ ...r }));

  s.set(courierServiceDb.courierProviders, "findMany", async () => providers.map((p) => ({ ...p })));
  s.set(courierServiceDb.courierPricingRules, "findFirst", async ({ where, orderBy }: any) => {
    log.ruleWheres.push(where);
    const hit = rules.filter((r) => matches(r, where)).sort((a, b) => (orderBy?.priority === "asc" ? a.priority - b.priority : 0));
    return hit[0] ?? null;
  });
  for (const m of ["findFirst", "findMany", "create", "update", "updateMany", "upsert"]) {
    s.set(courierServiceDb.courierPriceCache, m, async (args: any) => {
      log.cacheCalls.push(m);
      if (m === "findFirst") return cache.find((r) => matches(r, args.where)) ?? null;
      if (m === "create") { cache.push({ id: `C${cache.length + 1}`, ...args.data }); return args.data; }
      if (m === "update") { Object.assign(cache.find((r) => r.id === args.where.id)!, args.data); return args.data; }
      if (m === "updateMany") return { count: 1 };
      return null;
    });
  }
  s.set(courierService, "resolveWarehousePickup", async (providerId: string, name: string, warehouseId: string) => {
    log.resolve.push(`${name}:${warehouseId}`);
    if (opts.pickupResolves === false) throw new Error(`${name} pickup store not configured for warehouse ${warehouseId}`);
    return { credentialId: `CRED-${providerId}`, mapping: { id: `MAP-${providerId}`, providerStoreId: "777", providerAreaId: "55" } };
  });
  s.set(courierService, "getCourierServiceableArea", async (providerId: string, locationId: string, kind: string) => {
    log.area.push(`${providerId}:${kind}`);
    return { courierCityId: "1", courierZoneId: "2", courierAreaId: "3" };
  });
  s.set(courierService, "pathaoCalculatePrice", async () => {
    log.quoteApi.push("pathao");
    const q = opts.pathaoQuote !== undefined ? opts.pathaoQuote : { delivery_fee: 90, cod_fee: 0 };
    return { data: q };
  });
  s.set(courierService, "redxCalculateCharge", async () => {
    log.quoteApi.push("redx");
    return opts.redxQuote !== undefined ? opts.redxQuote : { deliveryCharge: 95, codCharge: 0 };
  });
  const quiet = stubber();
  quiet.set(console, "error", () => {});
  quiet.set(console, "warn", () => {});
  return { log, cache, restore: () => { quiet.restore(); s.restore(); } };
}

// ── Switch A: defaults and overrides ────────────────────────────────────────

test("COURIER_LIVE_QUOTES: OFF outside production, ON in production, explicit overrides win", () => {
  const cases: [Record<string, string | undefined>, boolean][] = [
    [{}, false],
    [{ NODE_ENV: "development" }, false],
    [{ NODE_ENV: "test" }, false],
    [{ NODE_ENV: "production" }, true],
    [{ NODE_ENV: "production", COURIER_LIVE_QUOTES: "off" }, false],
    [{ NODE_ENV: "production", COURIER_LIVE_QUOTES: "false" }, false],
    [{ NODE_ENV: "production", COURIER_LIVE_QUOTES: "0" }, false],
    [{ NODE_ENV: "development", COURIER_LIVE_QUOTES: "on" }, true],
    [{ NODE_ENV: "development", COURIER_LIVE_QUOTES: " TRUE " }, true],
    [{ NODE_ENV: "development", COURIER_LIVE_QUOTES: "1" }, true],
    [{ NODE_ENV: "development", COURIER_LIVE_QUOTES: "maybe" }, false],
    [{ NODE_ENV: "production", COURIER_LIVE_QUOTES: "maybe" }, true],
  ];
  for (const [env, want] of cases) assert.equal(courierLiveQuotesEnabled(env as NodeJS.ProcessEnv), want, JSON.stringify(env));
});

// ── Switch A: OFF → no courier HTTP, no cache traffic, DB pricing works ─────

test("OFF: checkout engine never calls Pathao/RedX APIs or touches the price cache; a Steadfast rule still prices", async () => {
  await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: undefined }, async () => {
    const env = install({ rules: [rule({ courierProviderId: "steadfast", basePrice: 110 })] });
    const before = outbound.length;
    try {
      const out = await courierService.getLowestDeliveryQuote([WH], DEST, 1);
      assert.equal(out.charge, 110);
      assert.equal(out.courierName, "Steadfast");
      assert.deepEqual(env.log.quoteApi, [], "no Pathao/RedX price API call");
      assert.deepEqual(env.log.cacheCalls, [], "no cache read, claim or refresh");
      assert.deepEqual(env.log.resolve, [], "Pathao/RedX skipped before even resolving a pickup");
      assert.equal(outbound.length, before, "no outbound HTTP at all");
    } finally {
      env.restore();
    }
  });
});

test("OFF: a valid stored Pathao rule still prices through the database fallback (no API, no cache)", async () => {
  await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: undefined }, async () => {
    const env = install({ rules: [rule({ id: "P1", courierProviderId: "pathao", toLocationId: DEST, basePrice: 120 })] });
    const before = outbound.length;
    try {
      const out = await courierService.getLowestDeliveryQuote([WH], DEST, 1);
      assert.equal(out.charge, 120);
      assert.equal(out.courierName, "Pathao");
      assert.deepEqual(env.log.quoteApi, []);
      assert.deepEqual(env.log.cacheCalls, []);
      assert.ok(env.log.resolve.includes("Pathao:WH1"), "stored Pathao rates still need the warehouse's pickup store (database lookup)");
      assert.equal(outbound.length, before);
    } finally {
      env.restore();
    }
  });
});

test("OFF: selectBestCourier (admin quote / booking selection) skips Pathao/RedX without any API call", async () => {
  await withEnv({ NODE_ENV: "production", COURIER_LIVE_QUOTES: "off" }, async () => {
    const env = install({ rules: [rule({ courierProviderId: "steadfast", basePrice: 130 })] });
    const before = outbound.length;
    try {
      const out = await courierService.selectBestCourier({
        vendorWarehouseLocationId: WH.locationId, customerDeliveryLocationId: DEST, orderWeight: 1, codAmount: 500, warehouseId: WH.warehouseId,
      } as any);
      assert.equal(out.courierName, "Steadfast");
      assert.deepEqual(env.log.quoteApi, []);
      assert.deepEqual(env.log.area, [], "not even a serviceable-area lookup");
      assert.equal(outbound.length, before);
    } finally {
      env.restore();
    }
  });
});

test("OFF: the Pathao/RedX pricing functions refuse before any lookup or API call", async () => {
  await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: undefined }, async () => {
    const env = install({});
    try {
      for (const fn of ["getPathaoPricing", "getRedXPricing"]) {
        await assert.rejects((courierService as any)[fn]("p", "LOC-PICKUP", DEST, 1, 0, "WH1"), LiveCourierQuotesDisabledError);
      }
      assert.deepEqual(env.log.quoteApi, []);
      assert.deepEqual(env.log.area, []);
      assert.deepEqual(env.log.resolve, []);
    } finally {
      env.restore();
    }
  });
});

test("OFF with no applicable rule → the established 'No courier available' error (no API call)", async () => {
  await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: undefined }, async () => {
    const env = install({ rules: [] });
    try {
      await assert.rejects(courierService.getLowestDeliveryQuote([WH], DEST, 1), /No courier available for this delivery route/);
      assert.deepEqual(env.log.quoteApi, []);
    } finally {
      env.restore();
    }
  });
});

// ── Switch ON + issue 4: cached quotes are delivery-only like live ones ─────

test("ON: a live Pathao quote charges delivery only, caches it, and the cached hit charges the same", async () => {
  await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: "on" }, async () => {
    const env = install({ providers: ["pathao"], pathaoQuote: { delivery_fee: 100, cod_fee: 25 } });
    try {
      const live = await courierService.getLowestLiveDeliveryCharge([WH], DEST, 1);
      assert.equal(live.source, "LIVE");
      assert.equal(live.charge, 100, "live quote = delivery only");
      assert.deepEqual(env.log.quoteApi, ["pathao"], "the (stubbed) quote API ran once");
      assert.equal(env.cache.length, 1);
      assert.equal(env.cache[0].basePrice, 100);
      assert.equal(env.cache[0].totalPrice, 125, "the cache row still records the provider's full total");

      const cached = await courierService.getLowestLiveDeliveryCharge([WH], DEST, 1);
      assert.equal(cached.source, "CACHE");
      assert.equal(cached.charge, live.charge, "cached charge equals the live delivery-only charge");
      assert.deepEqual(env.log.quoteApi, ["pathao"], "no second API call on a fresh cache hit");
    } finally {
      env.restore();
    }
  });
});

test("ON: an existing fresh cache row with a COD fee is served delivery-only (basePrice, not totalPrice)", async () => {
  await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: "on" }, async () => {
    const env = install({
      providers: ["pathao"],
      cache: [{
        id: "C1", courierProviderId: "pathao", vendorId: null, fromLocationId: WH.locationId, toLocationId: DEST, weight: 1,
        deliveryType: "NORMAL", itemType: "PARCEL", codAmount: 0, pickupRef: "MAP-pathao",
        basePrice: 80, codCharge: 15, totalPrice: 95, calculatedAt: NOW, expiresAt: FUTURE,
      }],
    });
    try {
      const out = await courierService.getLowestLiveDeliveryCharge([WH], DEST, 1);
      assert.equal(out.source, "CACHE");
      assert.equal(out.charge, 80);
      assert.deepEqual(env.log.quoteApi, []);
    } finally {
      env.restore();
    }
  });
});

// ── Issue 5: rule applicability, in both lookup paths ───────────────────────

const IGNORED: [string, Row][] = [
  ["expired (validTo in the past)", { validTo: PAST }],
  ["not yet valid (validFrom in the future)", { validFrom: FUTURE }],
  ["EXPRESS delivery type", { deliveryType: "EXPRESS" }],
  ["vendor-specific", { vendorId: "V1" }],
  ["inactive", { isActive: false }],
  ["outside the weight band", { minWeight: 5 }],
];

for (const [label, over] of IGNORED) {
  test(`issue 5: a ${label} rule is never applied — Steadfast path and stored-rate path`, async () => {
    await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: undefined }, async () => {
      // Steadfast path (live engine → getSteadfastPricing)
      let env = install({ providers: ["steadfast"], rules: [rule({ courierProviderId: "steadfast", ...over })] });
      try {
        await assert.rejects(courierService.getLowestDeliveryQuote([WH], DEST, 1), /No courier available/);
      } finally {
        env.restore();
      }
      // Stored-rate path (getLowestStoredDeliveryCharge), Pathao route rule
      env = install({ providers: ["pathao"], rules: [rule({ courierProviderId: "pathao", toLocationId: DEST, ...over })] });
      try {
        await assert.rejects(courierService.getLowestStoredDeliveryCharge([WH], DEST, 1), /No courier available/);
      } finally {
        env.restore();
      }
    });
  });
}

test("issue 5: a valid platform rule still applies (future validTo, NORMAL, vendorId null) in both paths", async () => {
  await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: undefined }, async () => {
    let env = install({ providers: ["steadfast"], rules: [rule({ courierProviderId: "steadfast", validTo: FUTURE, basePrice: 140 })] });
    try {
      assert.equal((await courierService.getLowestDeliveryQuote([WH], DEST, 1)).charge, 140);
    } finally {
      env.restore();
    }
    env = install({ providers: ["pathao"], rules: [rule({ courierProviderId: "pathao", toLocationId: DEST, validTo: FUTURE, basePrice: 150 })] });
    try {
      assert.equal((await courierService.getLowestStoredDeliveryCharge([WH], DEST, 1)).charge, 150);
    } finally {
      env.restore();
    }
  });
});

test("issue 5: an applicable rule wins over an ignored cheaper one (EXPRESS / vendor / expired)", async () => {
  await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: undefined }, async () => {
    const env = install({
      providers: ["steadfast"],
      rules: [
        rule({ id: "cheap-express", deliveryType: "EXPRESS", basePrice: 10, priority: 1 }),
        rule({ id: "cheap-vendor", vendorId: "V1", basePrice: 20, priority: 2 }),
        rule({ id: "cheap-expired", validTo: PAST, basePrice: 30, priority: 3 }),
        rule({ id: "valid", basePrice: 160, priority: 50 }),
      ],
    });
    try {
      assert.equal((await courierService.getLowestDeliveryQuote([WH], DEST, 1)).charge, 160);
    } finally {
      env.restore();
    }
  });
});

test("issue 5: every rule query uses the shared applicability filter", async () => {
  await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: undefined }, async () => {
    const env = install({ providers: ["pathao", "steadfast"], rules: [] });
    try {
      await assert.rejects(courierService.getLowestDeliveryQuote([WH], DEST, 1));
      assert.ok(env.log.ruleWheres.length >= 4, "Steadfast (2) + stored Pathao (3) lookups ran");
      const expected = applicablePricingRuleWhere(NOW, 1).AND;
      for (const w of env.log.ruleWheres) {
        assert.equal(w.AND?.[0]?.deliveryType, "NORMAL");
        assert.equal(w.AND?.[0]?.vendorId, null);
        assert.equal(w.AND?.[0]?.isActive, true);
        assert.deepEqual(w.AND?.[1], expected[1], "weight band");
        assert.equal(w.AND?.[2]?.OR?.[0]?.validTo, null);
        assert.ok(w.AND?.[2]?.OR?.[1]?.validTo?.gt instanceof Date, "validTo > now");
      }
    } finally {
      env.restore();
    }
  });
});

// ── Defensive Courier Pricing Validation & Zero-Cost Prevention ─────────────

test("isValidCourierDeliveryCharge accepts positive finite numbers and rejects non-positive/non-numbers", () => {
  assert.equal(isValidCourierDeliveryCharge(100), true);
  assert.equal(isValidCourierDeliveryCharge(0.5), true);
  assert.equal(isValidCourierDeliveryCharge(1), true);
  // Rejections:
  assert.equal(isValidCourierDeliveryCharge(0), false, "zero is not a valid commercial courier charge");
  assert.equal(isValidCourierDeliveryCharge(-1), false, "negative is invalid");
  assert.equal(isValidCourierDeliveryCharge(NaN), false, "NaN is invalid");
  assert.equal(isValidCourierDeliveryCharge(Infinity), false, "Infinity is invalid");
  assert.equal(isValidCourierDeliveryCharge(-Infinity), false, "-Infinity is invalid");
  assert.equal(isValidCourierDeliveryCharge(null), false, "null is invalid");
  assert.equal(isValidCourierDeliveryCharge(undefined), false, "undefined is invalid");
  assert.equal(isValidCourierDeliveryCharge("100"), false, "string is invalid");
  assert.equal(isValidCourierDeliveryCharge({}), false, "object is invalid");
});

const INVALID_PATHAO_QUOTES: [string, any][] = [
  ["zero delivery_fee", { delivery_fee: 0, cod_fee: 0 }],
  ["missing delivery_fee", { cod_fee: 0 }],
  ["negative delivery_fee", { delivery_fee: -20, cod_fee: 0 }],
  ["NaN delivery_fee", { delivery_fee: NaN, cod_fee: 0 }],
  ["string delivery_fee", { delivery_fee: "0", cod_fee: 0 }],
  ["null delivery_fee", { delivery_fee: null, cod_fee: 0 }],
  ["undocumented response shape (price instead of delivery_fee)", { price: 100, cod_fee: 0 }],
];

for (const [label, quote] of INVALID_PATHAO_QUOTES) {
  test(`Pathao with ${label} must NOT silently become a valid zero-cost quote`, async () => {
    await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: "on" }, async () => {
      // 1. With a valid Steadfast alternative, Steadfast must win instead of zero
      let env = install({
        providers: ["pathao", "steadfast"],
        pathaoQuote: quote,
        rules: [rule({ courierProviderId: "steadfast", basePrice: 110 })],
      });
      try {
        const out = await courierService.getLowestDeliveryQuote([WH], DEST, 1);
        assert.equal(out.charge, 110, "Steadfast wins over invalid Pathao quote");
        assert.equal(out.courierName, "Steadfast");
      } finally {
        env.restore();
      }

      // 2. With no other provider, it must throw rather than returning charge: 0
      env = install({
        providers: ["pathao"],
        pathaoQuote: quote,
        rules: [],
      });
      try {
        await assert.rejects(
          courierService.getLowestDeliveryQuote([WH], DEST, 1),
          /No courier available for this delivery route/,
          "never silently quote zero delivery for invalid provider response",
        );
      } finally {
        env.restore();
      }
    });
  });
}

const INVALID_REDX_QUOTES: [string, any][] = [
  ["zero deliveryCharge", { deliveryCharge: 0, codCharge: 0 }],
  ["missing deliveryCharge", { codCharge: 0 }],
  ["negative deliveryCharge", { deliveryCharge: -50, codCharge: 0 }],
  ["NaN deliveryCharge", { deliveryCharge: NaN, codCharge: 0 }],
  ["snake_case delivery_charge (undocumented field)", { delivery_charge: 95, cod_charge: 0 }],
];

for (const [label, quote] of INVALID_REDX_QUOTES) {
  test(`RedX with ${label} must NOT silently become a valid zero-cost quote`, async () => {
    await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: "on" }, async () => {
      // 1. With a valid Steadfast alternative, Steadfast must win
      let env = install({
        providers: ["redx", "steadfast"],
        redxQuote: quote,
        rules: [rule({ courierProviderId: "steadfast", basePrice: 115 })],
      });
      try {
        const out = await courierService.getLowestDeliveryQuote([WH], DEST, 1);
        assert.equal(out.charge, 115, "Steadfast wins over invalid RedX quote");
        assert.equal(out.courierName, "Steadfast");
      } finally {
        env.restore();
      }

      // 2. With no other provider, it must throw rather than returning charge: 0
      env = install({
        providers: ["redx"],
        redxQuote: quote,
        rules: [],
      });
      try {
        await assert.rejects(
          courierService.getLowestDeliveryQuote([WH], DEST, 1),
          /No courier available for this delivery route/,
        );
      } finally {
        env.restore();
      }
    });
  });
}

test("selectBestCourier: invalid or zero live quote does not beat a valid rule-based courier", async () => {
  await withEnv({ NODE_ENV: "production" }, async () => {
    const env = install({
      providers: ["pathao", "redx", "steadfast"],
      pathaoQuote: { delivery_fee: 0, cod_fee: 0 },
      redxQuote: { deliveryCharge: 0, codCharge: 0 },
      rules: [rule({ courierProviderId: "steadfast", basePrice: 120 })],
    });
    try {
      const best = await courierService.selectBestCourier({
        vendorWarehouseLocationId: WH.locationId,
        customerDeliveryLocationId: DEST,
        orderWeight: 1,
        codAmount: 0,
        warehouseId: WH.warehouseId,
      } as any);
      assert.equal(best.courierName, "Steadfast");
      assert.equal(best.pricing.deliveryCharge, 120);
    } finally {
      env.restore();
    }
  });
});

test("selectBestCourier: throws if all providers return invalid or zero quotes", async () => {
  await withEnv({ NODE_ENV: "production" }, async () => {
    const env = install({
      providers: ["pathao", "redx"],
      pathaoQuote: { delivery_fee: 0, cod_fee: 0 },
      redxQuote: { deliveryCharge: 0, codCharge: 0 },
      rules: [],
    });
    try {
      await assert.rejects(
        courierService.selectBestCourier({
          vendorWarehouseLocationId: WH.locationId,
          customerDeliveryLocationId: DEST,
          orderWeight: 1,
          codAmount: 0,
          warehouseId: WH.warehouseId,
        } as any),
        /No courier available for this delivery route/,
      );
    } finally {
      env.restore();
    }
  });
});

test("preserves explicitly authorized free shipping via stored database rule (charge === 0)", async () => {
  await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: undefined }, async () => {
    const freeRule = rule({ courierProviderId: "steadfast", basePrice: 0, perKgCharge: 0, fuelSurcharge: 0 });
    const env = install({ providers: ["steadfast"], rules: [freeRule] });
    try {
      const stored = await courierService.getLowestStoredDeliveryCharge([WH], DEST, 1);
      assert.equal(stored.charge, 0, "explicit stored free shipping rule is accepted");
      assert.equal(stored.courierName, "Steadfast");

      const lowest = await courierService.getLowestDeliveryQuote([WH], DEST, 1);
      assert.equal(lowest.charge, 0, "lowest delivery quote serves authorized free shipping");
    } finally {
      env.restore();
    }
  });
});

test("preserves explicitly authorized free shipping via Steadfast rule in live quote engine", async () => {
  await withEnv({ NODE_ENV: "production" }, async () => {
    const freeRule = rule({ courierProviderId: "steadfast", basePrice: 0, perKgCharge: 0, fuelSurcharge: 0 });
    const env = install({
      providers: ["steadfast"],
      rules: [freeRule],
    });
    try {
      const out = await courierService.getLowestDeliveryQuote([WH], DEST, 1);
      assert.equal(out.charge, 0, "Steadfast authorized free shipping accepted");
      assert.equal(out.courierName, "Steadfast");
    } finally {
      env.restore();
    }
  });
});

test("keeps delivery fees separate from COD fees for live RedX quotes", async () => {
  await withEnv({ NODE_ENV: "development", COURIER_LIVE_QUOTES: "on" }, async () => {
    const env = install({
      providers: ["redx"],
      redxQuote: { deliveryCharge: 95, codCharge: 20 },
    });
    try {
      const out = await courierService.getLowestLiveDeliveryCharge([WH], DEST, 1);
      assert.equal(out.charge, 95, "delivery charge does not include COD fee");
      assert.equal(out.source, "LIVE");
    } finally {
      env.restore();
    }
  });
});

