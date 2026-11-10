// modules/shared/package-weight.ts
//
// SINGLE source of the courier/delivery weight formula, used by the cart
// delivery preview, checkout (placeOrder → calculateVendorShippingCost) and
// courier booking (markForDelivery). Keeping one implementation guarantees
// preview, checkout and booking send the courier the same weight.
//
// Authoritative per-unit weight = Warranty.packageWeightValue, stored with
// its own unit (Warranty.packageWeightUnit: KG | G). Everything returned
// here is in KILOGRAMS — the unit the existing courier pricing/booking
// interface already uses. Provider-specific unit handling (if any) belongs
// at the provider boundary in courier.service.ts, not here.

export type PackageWeightSource =
  | { packageWeightValue: number; packageWeightUnit: "KG" | "G" | string }
  | null
  | undefined;

/** Prisma select for the fields this helper needs (Product.warranty). */
export const PACKAGE_WEIGHT_SELECT = {
  packageWeightValue: true,
  packageWeightUnit: true,
} as const;

/**
 * Fallback for a product WITHOUT a usable package weight (no Warranty row,
 * or a non-positive / non-numeric value — product create/update validation
 * requires a positive weight, so this only affects legacy/imported rows).
 * This preserves the application's pre-existing explicit default
 * (cartWish.getWeightFromWarranty: "fallback default in KG" = 0.5) instead of
 * silently treating the item as weightless. It is logged every time it is
 * used. See report: BUSINESS DECISION REQUIRED on whether such products
 * should instead be blocked at checkout.
 */
export const MISSING_PACKAGE_WEIGHT_FALLBACK_KG = 0.5;

/** Round to whole grams so equal carts always produce an identical numeric
 *  weight (weight is part of the courier quote-cache / pricing-rule match). */
export function roundKg(kg: number): number {
  return Math.round(kg * 1000) / 1000;
}

/** Per-unit package weight in kg. */
export function packageWeightKg(warranty: PackageWeightSource, context = "item"): number {
  const value = Number(warranty?.packageWeightValue);
  if (!warranty || !Number.isFinite(value) || value <= 0) {
    console.warn(
      `[package-weight] ${context}: no valid Warranty.packageWeightValue — using fallback ${MISSING_PACKAGE_WEIGHT_FALLBACK_KG} kg`,
    );
    return MISSING_PACKAGE_WEIGHT_FALLBACK_KG;
  }
  return String(warranty.packageWeightUnit).toUpperCase() === "G" ? value / 1000 : value;
}

/** Shipment weight in kg: Σ(unit weight × quantity) for ONE shipment
 *  (one warehouse's lines). Callers must group by warehouse first. */
export function shipmentWeightKg(lines: { unitWeightKg: number; quantity: number }[]): number {
  return roundKg(lines.reduce((sum, l) => sum + l.unitWeightKg * l.quantity, 0));
}
