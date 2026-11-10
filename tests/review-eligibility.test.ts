// tests/review-eligibility.test.ts
//
// Phase 1 of the review system: server-enforced purchase eligibility.
//
//   • only a DELIVERED, KEPT order line of the product for the AUTHENTICATED
//     user may be reviewed (deliveredQuantity − returnedQuantity > 0);
//   • the user id / order status never come from the request body;
//   • each refusal carries a stable reason and a customer-facing message;
//   • the create path actually calls the rule, and the storefront's review
//     endpoints exist.
//
// DB-free: `prisma.orderItem.findFirst` is stubbed per test, so no query runs.
//   npx tsx --test tests/review-eligibility.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "../src/config/prisma.ts";
import {
  ReviewEligibilityService,
  REVIEW_INELIGIBILITY_COPY,
  type ReviewEligibility,
} from "../src/modules/product-module/services/product/review-eligibility.service.ts";
import { AppError } from "../src/modules/product-module/utils/response.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const USER = "user-1";
const PRODUCT = "prod-1";

/** Runs `fn` with orderItem.findFirst replaced; always restores. */
async function withFindFirst<T>(
  impl: (args: any) => Promise<any>,
  fn: () => Promise<T>,
): Promise<T & { calls?: any[] }> {
  const delegate = prisma.orderItem as any;
  const original = delegate.findFirst;
  const calls: any[] = [];
  delegate.findFirst = async (args: any) => {
    calls.push(args);
    return impl(args);
  };
  try {
    const result = (await fn()) as T & { calls?: any[] };
    // Non-enumerable so deepEqual comparisons only see the real result.
    Object.defineProperty(result, "calls", { value: calls, enumerable: false });
    return result;
  } finally {
    delegate.findFirst = original;
  }
}

/** First call = "delivered line" lookup, second = "did they buy it at all". */
const sequence = (delivered: any, purchased: any) => {
  let n = 0;
  return async () => (n++ === 0 ? delivered : purchased);
};

/* ── the rule ───────────────────────────────────────────────────────────────── */

test("a delivered, kept line makes the customer eligible", async () => {
  const deliveredAt = new Date("2026-10-01T10:00:00Z");
  const out = await withFindFirst(
    sequence(
      { id: "oi-1", vendorOrderId: "vo-1", deliveredQuantity: 2, returnedQuantity: 0, vendorOrder: { deliveredAt } },
      null,
    ),
    () => ReviewEligibilityService.check(USER, PRODUCT),
  );
  const result = out as ReviewEligibility;
  assert.equal(result.eligible, true);
  if (result.eligible) {
    assert.deepEqual([result.orderItemId, result.vendorOrderId, result.deliveredAt], ["oi-1", "vo-1", deliveredAt]);
  }
});

test("the lookup is scoped to the authenticated user, DELIVERED, and this product", async () => {
  const out = await withFindFirst(sequence(null, null), () => ReviewEligibilityService.check(USER, PRODUCT));
  const first = (out as any).calls[0];
  assert.deepEqual(first.where.variant, { productId: PRODUCT }, "product comes from the path");
  assert.equal(first.where.vendorOrder.status, "DELIVERED", "only delivered vendor orders count");
  assert.deepEqual(first.where.vendorOrder.order, { userId: USER }, "user comes from the session, not the body");
  assert.deepEqual(first.where.deliveredQuantity, { gt: 0 }, "only lines that actually delivered a unit");
});

test("a delivered line whose units were all returned is not eligible", async () => {
  const result = (await withFindFirst(
    sequence(
      { id: "oi-1", vendorOrderId: "vo-1", deliveredQuantity: 2, returnedQuantity: 2, vendorOrder: { deliveredAt: null } },
      null,
    ),
    () => ReviewEligibilityService.check(USER, PRODUCT),
  )) as ReviewEligibility;
  assert.deepEqual(result, { eligible: false, reason: "RETURNED" });
});

test("partially returned (one unit kept) is still eligible", async () => {
  const result = (await withFindFirst(
    sequence(
      { id: "oi-1", vendorOrderId: "vo-1", deliveredQuantity: 2, returnedQuantity: 1, vendorOrder: { deliveredAt: null } },
      null,
    ),
    () => ReviewEligibilityService.check(USER, PRODUCT),
  )) as ReviewEligibility;
  assert.equal(result.eligible, true);
});

test("purchased but not delivered → NOT_DELIVERED; never purchased → NOT_PURCHASED", async () => {
  const notDelivered = (await withFindFirst(
    sequence(null, { id: "oi-9" }),
    () => ReviewEligibilityService.check(USER, PRODUCT),
  )) as ReviewEligibility;
  assert.deepEqual(notDelivered, { eligible: false, reason: "NOT_DELIVERED" });

  const never = (await withFindFirst(sequence(null, null), () =>
    ReviewEligibilityService.check(USER, PRODUCT),
  )) as ReviewEligibility;
  assert.deepEqual(never, { eligible: false, reason: "NOT_PURCHASED" });
});

test("assert throws a 403 with the customer-facing message for each reason", async () => {
  const cases: [any, any, keyof typeof REVIEW_INELIGIBILITY_COPY][] = [
    [null, null, "NOT_PURCHASED"],
    [null, { id: "oi-9" }, "NOT_DELIVERED"],
    [{ id: "oi-1", vendorOrderId: "vo-1", deliveredQuantity: 1, returnedQuantity: 1, vendorOrder: { deliveredAt: null } }, null, "RETURNED"],
  ];
  for (const [delivered, purchased, reason] of cases) {
    await assert.rejects(
      () => withFindFirst(sequence(delivered, purchased), () => ReviewEligibilityService.assert(USER, PRODUCT)),
      (err: any) => {
        assert.ok(err instanceof AppError, "an AppError, so handleError renders it");
        assert.equal(err.statusCode, 403);
        assert.equal(err.message, REVIEW_INELIGIBILITY_COPY[reason]);
        return true;
      },
      reason,
    );
  }
});

test("no authenticated user is a 401, not a purchase lookup", async () => {
  await assert.rejects(
    () => ReviewEligibilityService.check("", PRODUCT),
    (err: any) => err instanceof AppError && err.statusCode === 401,
  );
});

/* ── wiring (source-level, like tests/vendor-order-ui.test.mjs) ─────────────── */

test("create() enforces the rule before writing anything", () => {
  const src = read("src/modules/product-module/services/product/review.service.ts");
  const create = src.slice(src.indexOf("async create("), src.indexOf("async update("));
  assert.match(create, /ReviewEligibilityService\.assert\(userId, input\.productId\)/, "eligibility is checked in create");
  assert.ok(
    create.indexOf("ReviewEligibilityService.assert") < create.indexOf("prisma.review.create"),
    "the check runs before the insert",
  );
});

test("the storefront's review endpoints are routed (list, mine, eligibility)", () => {
  const routes = read("src/modules/product-module/routes/product.routes.ts");
  assert.match(routes, /router\.get\("\/:productId\/reviews", ReviewController\.listByProduct\)/);
  assert.match(routes, /router\.get\("\/:productId\/reviews\/me", authenticateUser, ReviewController\.getMine\)/);
  assert.match(routes, /router\.get\("\/:productId\/reviews\/eligibility", authenticateUser, ReviewController\.getEligibility\)/);
  // The catch-all slug route must stay last.
  const slugAt = routes.indexOf('router.get("/:slug"');
  assert.ok(slugAt > routes.indexOf("/:productId/reviews"), "review routes are before the catch-all");
  assert.ok(
    routes.slice(slugAt).indexOf("router.get(") === 0 || routes.slice(slugAt + 1).indexOf("router.get(") === -1,
    "nothing is registered after the catch-all",
  );
});

test("update/delete keep their ownership checks", () => {
  const src = read("src/modules/product-module/services/product/review.service.ts");
  assert.match(src, /if \(existing\.userId !== userId\) throw new AppError\("You can only edit your own review", 403\)/);
  assert.match(src, /if \(existing\.userId !== userId\) throw new AppError\("You can only delete your own review", 403\)/);
});
