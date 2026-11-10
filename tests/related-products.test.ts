// tests/related-products.test.ts
//
// Regression: GET /api/products/:productId/related (and /similar, which calls
// related()) always failed because ProductFilterService.related() selected and
// filtered on `tags`, which the Product model does not have. A plain Prisma
// mock would accept any field, so these tests ALSO check every field the query
// uses against Prisma's own data model (Prisma.dmmf) — no database needed.
// Prisma delegates and the Redis client are stubbed: no DB or cache writes.
//   node --test tests/related-products.test.ts   (or: npx tsx --test …)

import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/config/prisma.ts";
import redisClient from "../src/config/redis.ts";
import { ProductFilterService } from "../src/modules/product-module/services/product/product-filter.service.ts";
import { PublicProductController } from "../src/modules/product-module/controllers/product.controller.public.ts";

const productModel = Prisma.dmmf.datamodel.models.find((m) => m.name === "Product")!;
const productFields = new Set(productModel.fields.map((f) => f.name));

type Calls = { findUnique: any[]; findMany: any[]; cacheSet: unknown[][] };

/** Stubs prisma.product.findUnique/findMany and redisClient.get/set for one test. */
function stubs(opts: { source?: Record<string, unknown> | null; items?: unknown[]; cached?: unknown[] } = {}) {
  const calls: Calls = { findUnique: [], findMany: [], cacheSet: [] };
  const p = prisma.product as any;
  const r = redisClient as any;
  const orig = { findUnique: p.findUnique, findMany: p.findMany, get: r.get, set: r.set };
  p.findUnique = async (args: any) => {
    calls.findUnique.push(args);
    return opts.source === undefined ? { categoryId: "cat-1", brandId: "brand-1" } : opts.source;
  };
  p.findMany = async (args: any) => {
    calls.findMany.push(args);
    return opts.items ?? [];
  };
  r.get = async () => (opts.cached ? JSON.stringify(opts.cached) : null);
  r.set = async (...args: unknown[]) => {
    calls.cacheSet.push(args);
    return "OK";
  };
  return {
    calls,
    restore: () => {
      p.findUnique = orig.findUnique;
      p.findMany = orig.findMany;
      r.get = orig.get;
      r.set = orig.set;
    },
  };
}

/** Every top-level field name used in a Prisma `where` (recursing into AND/OR/NOT). */
function whereFields(where: any): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(where ?? {})) {
    if (key === "AND" || key === "OR" || key === "NOT") {
      for (const sub of Array.isArray(value) ? value : [value]) out.push(...whereFields(sub));
    } else {
      out.push(key);
    }
  }
  return out;
}

test("the Product model really has no `tags` field (the root cause)", () => {
  assert.equal(productFields.has("tags"), false);
  for (const f of ["id", "categoryId", "brandId", "approvalStatus", "isDeleted", "createdAt"]) {
    assert.ok(productFields.has(f), `Product.${f} exists`);
  }
});

test("related(): every selected and filtered field exists on the Product model", async () => {
  const s = stubs();
  try {
    await ProductFilterService.related("prod-1", 10);
    const selected = Object.keys(s.calls.findUnique[0].select);
    for (const f of selected) assert.ok(productFields.has(f), `select.${f} must exist on Product`);
    const filtered = whereFields(s.calls.findMany[0].where);
    for (const f of filtered) assert.ok(productFields.has(f), `where.${f} must exist on Product`);
    assert.equal(selected.includes("tags") || filtered.includes("tags"), false);
  } finally { s.restore(); }
});

test("related(): same category or brand, excluding itself, only ACTIVE and non-deleted, newest first", async () => {
  const items = [{ id: "p2" }, { id: "p3" }];
  const s = stubs({ items });
  try {
    const out = await ProductFilterService.related("prod-1", 7);
    assert.deepEqual(out, items);
    const args = s.calls.findMany[0];
    assert.deepEqual(args.where, {
      id: { not: "prod-1" },
      approvalStatus: "ACTIVE",
      isDeleted: false,
      OR: [{ categoryId: "cat-1" }, { brandId: "brand-1" }],
      vendor: { status: "ACTIVE" }, // Phase 1 S3: only ACTIVE vendors' products are public
    });
    assert.equal(args.take, 7);
    assert.deepEqual(args.orderBy, { createdAt: "desc" });
    assert.ok(args.include?.variants && args.include?.images && args.include?.vendor, "card data (cardInclude) for the shared card");
    assert.equal(s.calls.cacheSet.length, 1, "result cached as before");
  } finally { s.restore(); }
});

test("related(): a product without a brand matches by category only; unknown product → []", async () => {
  let s = stubs({ source: { categoryId: "cat-9", brandId: null } });
  try {
    await ProductFilterService.related("prod-x", 10);
    assert.deepEqual(s.calls.findMany[0].where.OR, [{ categoryId: "cat-9" }]);
  } finally { s.restore(); }

  s = stubs({ source: null });
  try {
    assert.deepEqual(await ProductFilterService.related("missing", 10), []);
    assert.equal(s.calls.findMany.length, 0);
  } finally { s.restore(); }
});

test("endpoint contract: getRelated responds 200 { success, data: [...] } and similar() works again", async () => {
  const items = [
    { id: "p2", viewCount: 1, salesCount: 0 },
    { id: "p3", viewCount: 0, salesCount: 5 },
  ];
  const s = stubs({ items });
  try {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await PublicProductController.getRelated({ params: { productId: "prod-1" }, query: { limit: "10" } } as any, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.data, items, "frontend unwraps response.data");

    const similar = await ProductFilterService.similar("prod-1", 1);
    assert.deepEqual(similar.map((p: any) => p.id), ["p3"], "popularity tiebreaker still applied");
  } finally { s.restore(); }
});
