// modules/shared/pricing.ts
//
// Authoritative customer-facing selling price of a variant (approved business
// rule): `specialPrice` is the discounted selling price and applies ONLY when
// 0 < specialPrice < price. Null, zero, negative, equal, higher or non-numeric
// special prices fall back to the regular price.
//
// Single backend source for: the cart line price snapshot (cartWish.service
// addToCart), the checkout price check (order.service placeOrder) and the
// vendor discount-% calculation. The storefront mirrors the same rule for
// display only (multivendorsite src/lib/pricing/effective-price.ts, tested with
// the same cases); the server never accepts a client-supplied price.

import { Decimal } from "@prisma/client/runtime/library";

type Money = Decimal | number | string | null | undefined;

const toDecimal = (v: Money): Decimal | null => {
  if (v === null || v === undefined || v === "") return null;
  try {
    const d = new Decimal(v as any);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
};

export interface EffectivePrice {
  /** The price the customer is charged. */
  price: Decimal;
  /** The regular price — set only while a valid discount is active. */
  compareAtPrice: Decimal | null;
  /** True only when 0 < specialPrice < regularPrice. */
  discounted: boolean;
}

export function effectivePrice(regularPrice: Money, specialPrice: Money): EffectivePrice {
  const regular = toDecimal(regularPrice) ?? new Decimal(0);
  const special = toDecimal(specialPrice);
  const discounted = special !== null && special.greaterThan(0) && special.lessThan(regular);
  return discounted
    ? { price: special!, compareAtPrice: regular, discounted: true }
    : { price: regular, compareAtPrice: null, discounted: false };
}

/** Whole-number discount % of a valid discount, else 0 (never negative). */
export function discountPercent(regularPrice: Money, specialPrice: Money): number {
  const p = effectivePrice(regularPrice, specialPrice);
  if (!p.discounted) return 0;
  return Math.round(p.compareAtPrice!.minus(p.price).dividedBy(p.compareAtPrice!).times(100).toNumber());
}

/** Two money values are the same price (compared at the DB's 4-decimal scale). */
export function samePrice(a: Money, b: Money): boolean {
  const x = toDecimal(a);
  const y = toDecimal(b);
  if (x === null || y === null) return false;
  return x.toDecimalPlaces(4).equals(y.toDecimalPlaces(4));
}
