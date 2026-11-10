// tests/public-vendor-visibility.test.ts
//
// Phase 1 S3 (+P2/P3): products of a vendor that is not ACTIVE (SUSPENDED,
// DEACTIVATED, PENDING) are not public.
//   - every public list/search query carries the vendor condition
//     (Prisma `vendor: { status: "ACTIVE" }`, raw SQL `EXISTS … vendors …`)
//   - product detail is null (→ 404) for a non-ACTIVE vendor, on a database
//     read AND on a cache hit (the cached record carries vendor.status)
//   - category facets/counts, the vendor storefront and campaign product
//     blocks apply the same condition
//   - a vendor status change clears the product slug/id keys of that vendor
//     and every list/search cache (node-redis v5 batch shapes handled)
// DB-free: Prisma delegates and the Redis client are stubbed in place.
//   npx tsx --test tests/public-vendor-visibility.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/config/prisma.ts";
import redisClient from "../src/config/redis.ts";
import { invalidateVendorProductCaches, PUBLIC_PRODUCT_LIST_PREFIXES } from "../src/config/cache.ts";
import { ProductFilterService } from "../src/modules/product-module/services/product/product-filter.service.ts";
import { ProductSearchService } from "../src/modules/product-module/services/product/product-search.service.ts";
import { ProductCoreService } from "../src/modules/product-module/services/product/product-core.service.ts";
import {
  applyPublicVisibility,
  publicProductWhere,
  isPublicProduct,
  PUBLIC_VENDOR_SQL,
} from "../src/modules/product-module/utils/filter-builder.util.ts";
import { categoryFilterService, categoryFilterDb } from "../src/services/categoryFilterService.ts";
import { StoreDecorationService, storeLayoutDb } from "../src/services/storeLayout.service.ts";
import { CampaignPageService, campaignPageDb } from "../src/services/campaignPage.service.ts";

const ACTIVE = { status: "ACTIVE" };

/** Replace obj[key] for one test; returns a restore function. */
function stubber() {
  const restores: (() => void)[] = [];
  const set = (obj: any, key: string, value: any) => {
    const orig = obj[key];
    obj[key] = value;
    restores.push(() => (obj[key] = orig));
  };
  return { set, restore: () => restores.reverse().forEach((r) => r()) };
}

/** Product-level vendor condition anywhere in a where (top level or AND). */
function vendorCondition(where: any): any {
  if (!where) return undefined;
  if (where.vendor) return where.vendor;
  for (const sub of where.AND ?? []) {
    const v = vendorCondition(sub);
    if (v) return v;
  }
  return undefined;
}

// ── helpers ─────────────────────────────────────────────────────────────────

test("helpers: public where = approved + not deleted + ACTIVE vendor; merges an existing vendor filter", () => {
  assert.deepEqual(publicProductWhere({ isFeatured: true }), { isFeatured: true, approvalStatus: "ACTIVE", isDeleted: false, vendor: ACTIVE });
  const w: any = { vendor: { storeName: { contains: "abc", mode: "insensitive" } } };
  applyPublicVisibility(w);
  assert.deepEqual(w.vendor, { storeName: { contains: "abc", mode: "insensitive" }, status: "ACTIVE" });
  assert.equal(isPublicProduct({ approvalStatus: "ACTIVE", isDeleted: false, vendor: { status: "ACTIVE" } }), true);
  for (const status of ["SUSPENDED", "DEACTIVATED", "PENDING", undefined]) {
    assert.equal(isPublicProduct({ approvalStatus: "ACTIVE", isDeleted: false, vendor: { status } }), false, String(status));
  }
});

test("schema: Product.vendor → Vendor, Vendor.status is a VendorStatus with ACTIVE/SUSPENDED/DEACTIVATED", () => {
  const models = Prisma.dmmf.datamodel.models;
  const product = models.find((m) => m.name === "Product")!;
  assert.equal(product.fields.find((f) => f.name === "vendor")!.type, "Vendor");
  const vendor = models.find((m) => m.name === "Vendor")!;
  assert.equal(vendor.dbName, "vendors");
  assert.equal(vendor.fields.find((f) => f.name === "status")!.type, "VendorStatus");
  const values = Prisma.dmmf.datamodel.enums.find((e) => e.name === "VendorStatus")!.values.map((v) => v.name);
  for (const v of ["ACTIVE", "SUSPENDED", "DEACTIVATED"]) assert.ok(values.includes(v), v);
  assert.equal(models.find((m) => m.name === "StoreDecoration")!.fields.find((f) => f.name === "vendor")!.type, "Vendor");
});

// ── public listings ─────────────────────────────────────────────────────────

test("every public list query carries vendor.status = ACTIVE", async () => {
  const s = stubber();
  const wheres: Record<string, any[]> = {};
  const record = (name: string) => async (args: any) => ((wheres[name] ??= []).push(args.where), []);
  try {
    s.set(redisClient, "get", async () => null);
    s.set(redisClient, "set", async () => "OK");
    s.set(prisma.product, "findUnique", async () => ({ categoryId: "c1", brandId: "b1" }));
    let current = "";
    s.set(prisma.product, "findMany", async (args: any) => record(current)(args));
    s.set(prisma.recentlyViewedProduct, "findMany", async (args: any) => record("recentlyViewed")(args));

    const calls: [string, () => Promise<unknown>][] = [
      ["filterForPublic", () => ProductFilterService.filterForPublic({ limit: 10 } as any)],
      ["featured", () => ProductFilterService.featured(5)],
      ["newArrivals", () => ProductFilterService.newArrivals(5)],
      ["trending", () => ProductFilterService.trending(5)],
      ["bestSelling", () => ProductFilterService.bestSelling(5)],
      ["flashSale", () => ProductFilterService.flashSale(5)],
      ["discounted", () => ProductFilterService.discounted(5)],
      ["related", () => ProductFilterService.related("p1", 5)],
      ["similar", () => ProductFilterService.similar("p2", 5)],
    ];
    for (const [name, fn] of calls) {
      current = name;
      await fn();
    }
    await ProductFilterService.recentlyViewed("u1", 5);

    for (const [name] of calls) {
      assert.ok(wheres[name]?.length, `${name} queried products`);
      for (const w of wheres[name]) {
        assert.equal(vendorCondition(w)?.status, "ACTIVE", `${name}: vendor.status`);
        assert.equal(w.approvalStatus, "ACTIVE", `${name}: approvalStatus kept`);
        assert.equal(w.isDeleted, false, `${name}: isDeleted kept`);
      }
    }
    const rv = wheres.recentlyViewed[0];
    assert.equal(rv.userId, "u1");
    assert.deepEqual(rv.product, { approvalStatus: "ACTIVE", isDeleted: false, vendor: ACTIVE }, "recently viewed filtered in the query");
  } finally {
    s.restore();
  }
});

// ── search ──────────────────────────────────────────────────────────────────

test("public full-text and fuzzy search SQL require an ACTIVE vendor; admin (onlyActive=false) search does not", async () => {
  const s = stubber();
  const sqls: { sql: string; params: unknown[] }[] = [];
  try {
    s.set(redisClient, "get", async () => null);
    s.set(redisClient, "set", async () => "OK");
    s.set(prisma, "$queryRawUnsafe", async (sql: string, ...params: unknown[]) => (sqls.push({ sql, params }), []));
    await ProductSearchService.search("phone", { onlyActive: true });
    assert.equal(sqls.length, 2, "full-text then fuzzy (no full-text hits)");
    for (const { sql, params } of sqls) {
      assert.ok(sql.includes(PUBLIC_VENDOR_SQL), "vendor EXISTS clause present");
      assert.match(sql, /EXISTS \(SELECT 1 FROM vendors v WHERE v\.id = p\."vendorId" AND v\.status = 'ACTIVE'\)/);
      assert.ok(!sql.includes("phone"), "the query text stays a bound parameter");
      assert.equal(params[0], "phone");
    }
    sqls.length = 0;
    await ProductSearchService.search("phone", { onlyActive: false });
    for (const { sql } of sqls) assert.ok(!sql.includes("FROM vendors"), "admin search unchanged");
  } finally {
    s.restore();
  }
});

test("search fallback (Prisma) requires an ACTIVE vendor", async () => {
  const s = stubber();
  let where: any;
  try {
    s.set(redisClient, "get", async () => null);
    s.set(redisClient, "set", async () => "OK");
    s.set(prisma, "$queryRawUnsafe", async () => {
      throw new Error("no search_vector");
    });
    s.set(prisma.product, "findMany", async (args: any) => ((where = args.where), []));
    const warn = console.warn;
    console.warn = () => {};
    try {
      await ProductSearchService.search("phone", { onlyActive: true });
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(where.vendor, ACTIVE);
    assert.equal(where.approvalStatus, "ACTIVE");
  } finally {
    s.restore();
  }
});

// ── detail ──────────────────────────────────────────────────────────────────

const detail = (status: string | undefined) => ({
  id: "p1",
  slug: "phone",
  approvalStatus: "ACTIVE",
  isDeleted: false,
  vendor: status === undefined ? { id: "V1", storeName: "S" } : { id: "V1", storeName: "S", status },
});

test("detail: a cache hit for a SUSPENDED / DEACTIVATED vendor is null (404); ACTIVE is served", async () => {
  for (const [status, served] of [["SUSPENDED", false], ["DEACTIVATED", false], ["PENDING", false], ["ACTIVE", true]] as const) {
    const s = stubber();
    let dbReads = 0;
    try {
      s.set(redisClient, "get", async () => JSON.stringify(detail(status)));
      s.set(prisma.product, "findFirst", async () => (dbReads++, null));
      const got = await ProductCoreService.getDetailBySlug("phone");
      assert.equal(got !== null, served, status);
      assert.equal(dbReads, 0, `${status}: answered from cache`);
    } finally {
      s.restore();
    }
  }
});

test("detail: a database read for a non-ACTIVE vendor is null (404) and is not cached", async () => {
  for (const status of ["SUSPENDED", "DEACTIVATED"]) {
    const s = stubber();
    const sets: unknown[] = [];
    try {
      s.set(redisClient, "get", async () => null);
      s.set(redisClient, "set", async (...a: unknown[]) => (sets.push(a), "OK"));
      s.set(prisma.product, "findFirst", async (args: any) => (args.select ? { id: "p1", slug: "phone" } : detail(status)));
      assert.equal(await ProductCoreService.getDetailBySlug("phone"), null, status);
      assert.equal(sets.length, 0, `${status}: nothing cached`);
    } finally {
      s.restore();
    }
  }
});

test("detail: a cached record without vendor.status is not trusted — re-read from the database", async () => {
  const s = stubber();
  let dbReads = 0;
  try {
    s.set(redisClient, "get", async () => JSON.stringify(detail(undefined)));
    s.set(prisma.product, "findFirst", async (args: any) => (dbReads++, args.select ? { id: "p1", slug: "phone" } : detail("SUSPENDED")));
    assert.equal(await ProductCoreService.getDetailBySlug("phone"), null);
    assert.equal(dbReads, 2, "slug resolve + detail read");
  } finally {
    s.restore();
  }
});

// ── category facets, storefront, campaign blocks (P2) ────────────────────────

test("category filter facets, price range and counts only include ACTIVE vendors", async () => {
  const s = stubber();
  const seen: Record<string, any> = {};
  try {
    s.set(categoryFilterDb.categoryAttribute, "findMany", async () => [{ attributeId: "a1", attribute: { id: "a1", name: "Color", values: [] } }]);
    s.set(categoryFilterDb.productAttribute, "findMany", async (args: any) => ((seen.facets = args.where.product), []));
    s.set(categoryFilterDb.productVariant, "aggregate", async (args: any) => ((seen.price = args.where.product), { _min: { price: 1 }, _max: { price: 2 } }));
    s.set(categoryFilterDb.product, "count", async (args: any) => ((seen.count = args.where), 0));
    const svc = categoryFilterService as any;
    await svc.getFilterableAttributes(["c1"], true);
    await svc.getPriceRange(["c1"]);
    await svc.getProductCount(["c1"]);
    for (const k of ["facets", "price", "count"]) {
      assert.ok(seen[k], `${k} queried`);
      assert.deepEqual(seen[k].vendor, ACTIVE, k);
      assert.equal(seen[k].approvalStatus, "ACTIVE", k);
    }
  } finally {
    s.restore();
  }
});

test("storefront: a non-ACTIVE vendor has no published storefront (null → 404)", async () => {
  const s = stubber();
  let where: any;
  try {
    s.set(storeLayoutDb.storeDecoration, "findFirst", async (args: any) => ((where = args.where), null));
    assert.equal(await new StoreDecorationService().getPublishedDecoration("V1"), null);
    assert.deepEqual(where, { vendorId: "V1", isDefault: true, status: "PUBLISHED", vendor: ACTIVE });
  } finally {
    s.restore();
  }
});

test("campaign page: product blocks list only products of ACTIVE vendors (admin view unchanged)", async () => {
  const s = stubber();
  let publicInclude: any;
  let adminInclude: any;
  try {
    s.set(campaignPageDb.campaignPage, "findFirst", async (args: any) => ((publicInclude = args.include), null));
    s.set(campaignPageDb.campaignPage, "findUnique", async (args: any) => ((adminInclude = args.include), null));
    const svc = new CampaignPageService();
    await svc.getPublishedBySlug("mega");
    await svc.getById("C1");
    assert.deepEqual(publicInclude.components.include.products.where, { product: { vendor: ACTIVE } });
    assert.equal(adminInclude.components.include.products.where, undefined, "the admin builder still sees every product");
  } finally {
    s.restore();
  }
});

// ── cache invalidation (P3) ─────────────────────────────────────────────────

test("invalidateVendorProductCaches: deletes slug/id keys of the vendor's products and every list/search cache", async () => {
  const s = stubber();
  const deleted: string[] = [];
  const delCalls: unknown[][] = [];
  const scanned: string[] = [];
  try {
    s.set(redisClient, "del", async (...args: unknown[]) => {
      delCalls.push(args);
      const keys = args[0];
      deleted.push(...(Array.isArray(keys) ? keys : [keys as string]));
      return 1;
    });
    // node-redis v5 yields BATCHES (arrays) of keys.
    s.set(redisClient, "scanIterator", async function* ({ MATCH }: any) {
      scanned.push(MATCH);
      const prefix = MATCH.slice(0, -1);
      yield [`${prefix}a`, `${prefix}b`];
      yield [];
    });
    await invalidateVendorProductCaches("V1", [{ id: "p1", slug: "phone" }, { id: "p2", slug: null }]);
    for (const k of ["product:id:p1", "product:slug:phone", "product:id:p2", "stats:vendor:V1"]) assert.ok(deleted.includes(k), k);
    for (const prefix of ["product:listing:", "product:search:", "product:featured:", "product:new-arrivals:", "product:trending:", "product:best-selling:", "product:related:"]) {
      assert.ok(scanned.includes(`${prefix}*`), `${prefix} scanned`);
      assert.ok(deleted.includes(`${prefix}a`) && deleted.includes(`${prefix}b`), `${prefix} batch deleted`);
    }
    assert.deepEqual([...PUBLIC_PRODUCT_LIST_PREFIXES].sort(), scanned.map((m) => m.slice(0, -1)).sort());
    assert.ok(delCalls.every((c) => c.length === 1), "DEL always gets a single key-or-array argument (v5 signature)");
  } finally {
    s.restore();
  }
});

test("vendor status writers clear that vendor's public caches after the write; a cache failure never fails the write", async () => {
  const { VendorService, vendorServiceDb } = await import("../src/services/vendor.service.ts");
  const svc = new VendorService();
  const s = stubber();
  const deleted: string[] = [];
  const order: string[] = [];
  try {
    const tx = {
      vendor: { update: async ({ data }: any) => (order.push(`write:${data.status}`), { id: "V1", status: data.status }) },
    };
    s.set(vendorServiceDb, "$transaction", async (fn: any) => fn(tx));
    s.set(vendorServiceDb.vendor, "update", async ({ data }: any) => (order.push(`write:${data.status}`), { id: "V1", status: data.status }));
    s.set(vendorServiceDb.product, "findMany", async (args: any) => {
      assert.deepEqual(args.where, { vendorId: "V1" });
      return [{ id: "p1", slug: "phone" }];
    });
    s.set(redisClient, "del", async (keys: any) => {
      order.push("invalidate");
      deleted.push(...(Array.isArray(keys) ? keys : [keys]));
      return 1;
    });
    s.set(redisClient, "scanIterator", async function* () {});

    for (const status of ["SUSPENDED", "DEACTIVATED"]) {
      deleted.length = 0;
      order.length = 0;
      const v: any = await svc.updateVendorStatus("V1", status as any);
      assert.equal(v.status, status);
      assert.ok(deleted.includes("product:slug:phone") && deleted.includes("product:id:p1"), status);
      assert.equal(order[0], `write:${status}`, "invalidation runs after the status write");
    }

    deleted.length = 0;
    await svc.suspendVendorVerification("V1", "docs expired");
    assert.ok(deleted.includes("product:slug:phone"), "verification suspension clears caches too");

    // Redis down: the status change still succeeds.
    s.set(redisClient, "del", async () => {
      throw new Error("redis down");
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      const v: any = await svc.updateVendorStatus("V1", "SUSPENDED" as any);
      assert.equal(v.status, "SUSPENDED");
    } finally {
      console.warn = warn;
    }
  } finally {
    s.restore();
  }
});
