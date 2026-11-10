/** 1C-29 regression — compact: verify fix works with multi-warehouse + single WH + no-rate */
import { prisma } from "../src/config/prisma.ts";
import cartWishService from "../src/services/cartWish.service.ts";
import { OrderService } from "../src/services/order.service.ts";
import { PaymentMethod } from "@prisma/client";
import {
  createPurchaseOrder,
  receivePurchaseOrder,
} from "../src/services/purchase-order.service.ts";

const TAG = `1c29r${Date.now().toString(36)}`;
const SUPPLIER_ID = "cmtsxb76r0002o0uo74isdttp";
const CREATED_BY = "cmiu7ije70003h9ea46q23qsy";
const VENDOR_ID = "cmiu7fdrq0000h9eafdh98xru";
const V1_WH = "cmtu12l7k0001o0b81xd2dqu6";
const V1_LOC = "cmtlwsnz80004o0x8lowde33y";

let pass = 0, fail = 0;
const keep: Record<string, string[]> = {
  ruleIds: [], orderIds: [], users: [], locations: [], products: [],
  variants: [], cats: [], warehouses: [], pos: [], carts: [],
};
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}
const svc = new OrderService();
async function mkWh(suffix: string) {
  const loc = await prisma.locations.create({ data: { name: `${TAG}-wh${suffix}`, level: "DISTRICT" } });
  keep.locations.push(loc.id);
  const wh = await prisma.vendorWarehouse.create({ data: { vendorId: VENDOR_ID, locationId: loc.id, name: `${TAG}-wh${suffix}`, isDefault: false } });
  keep.warehouses.push(wh.id);
  return { warehouseId: wh.id, locationId: loc.id };
}
async function mkProdRecv(suffix: string, whId: string, qty: number, cost: number, mrp: number, sell: number) {
  const cat = await prisma.category.create({ data: { name: `${TAG}-c${suffix}`, slug: `${TAG}-c${suffix}` } });
  keep.cats.push(cat.id);
  const product = await prisma.product.create({ data: { name: `${TAG}-p${suffix}`, slug: `${TAG}-p${suffix}`, vendorId: VENDOR_ID, categoryId: cat.id, approvalStatus: "ACTIVE" } });
  keep.products.push(product.id);
  const variant = await prisma.productVariant.create({ data: { productId: product.id, sku: `${TAG}-sku${suffix}`, price: 0, stock: 0, availability: true, avgCost: 0 } });
  keep.variants.push(variant.id);
  const po: any = await createPurchaseOrder({
    purchaseDate: new Date().toISOString(), supplierId: SUPPLIER_ID,
    items: [{ variantId: variant.id, productName: product.name, variantName: "std", sku: variant.sku, quantity: qty, unitCost: cost, sellPrice: sell, mrpPrice: mrp }],
    entityType: "VENDOR", entityId: VENDOR_ID, paidAmount: 0, notes: `${TAG} PO ${suffix}`,
  }, CREATED_BY);
  keep.pos.push(po.id);
  const item = po.items.find((i: any) => i.variantId === variant.id);
  await receivePurchaseOrder(po.id, { items: [{ purchaseOrderItemId: item.id, quantity: qty, warehouseId: whId, damagedQuantity: 0 }], receivedBy: CREATED_BY } as any, CREATED_BY);
  return { productId: product.id, variantId: variant.id };
}
async function mkBuyer(suffix: string, locId?: string) {
  const user = await prisma.user.create({ data: { email: `${TAG}-u${suffix}@t.local`, password: "x", role: "CUSTOMER", isVerified: true } });
  keep.users.push(user.id);
  const loc = locId ?? await prisma.locations.create({ data: { name: `${TAG}-bl${suffix}`, level: "DISTRICT" } });
  if (!locId) keep.locations.push(loc.id);
  const addr = await prisma.userAddress.create({ data: { userId: user.id, locationId: loc.id, fullName: "T", phone: "01712345678", addressLine1: "r1" } });
  const cart = await prisma.carts.create({ data: { userId: user.id, sessionId: `${TAG}-ct${suffix}`, isGuest: false } });
  keep.carts.push(cart.id);
  return { userId: user.id, addressId: addr.id, cartId: cart.id, userLocId: loc.id };
}
async function mkRule(from: string, to: string, base: number) {
  const rule = await prisma.courierPricingRules.create({ data: { courierProviderId: "pathao", fromLocationId: from, toLocationId: to, deliveryType: "NORMAL", itemType: "PARCEL", basePrice: base, perKgCharge: 0, isActive: true, updatedAt: new Date() } });
  keep.ruleIds.push(rule.id);
  return rule;
}

async function main() {
  const whA = { warehouseId: V1_WH, locationId: V1_LOC };
  const whB = await mkWh("B");

  // 1C-16: same vendor, same WH, multi-product → one charge
  console.log("\n== 1C-16: same WH multi-product → one charge");
  const pA = await mkProdRecv("r16a", whA.warehouseId, 10, 500, 900, 700);
  const pB = await mkProdRecv("r16b", whA.warehouseId, 10, 500, 900, 700);
  const buyer1 = await mkBuyer("r16");
  await mkRule(whA.locationId, buyer1.userLocId, 60);
  await cartWishService.addToCart({ productId: pA.productId, variantId: pA.variantId, quantity: 1, userId: buyer1.userId } as any);
  await cartWishService.addToCart({ productId: pB.productId, variantId: pB.variantId, quantity: 1, userId: buyer1.userId } as any);
  const o1 = await svc.placeOrder(buyer1.userId, buyer1.addressId, "BKASH");
  keep.orderIds.push(o1.id);
  ok("1C-16: one WH entry, one charge 60", Number(o1.shippingCost) === 60, String(o1.shippingCost));

  // 1C-16/1C-26A: same vendor, DIFFERENT WHs → summed per-warehouse
  console.log("\n== 1C-16/26A: different WHs → summed");
  const pC = await mkProdRecv("r16c", whA.warehouseId, 10, 500, 900, 700);
  const pD = await mkProdRecv("r16d", whB.warehouseId, 10, 500, 900, 700);
  const buyer2 = await mkBuyer("r26");
  await mkRule(whA.locationId, buyer2.userLocId, 60);
  await mkRule(whB.locationId, buyer2.userLocId, 120);
  await cartWishService.addToCart({ productId: pC.productId, variantId: pC.variantId, quantity: 1, userId: buyer2.userId } as any);
  await cartWishService.addToCart({ productId: pD.productId, variantId: pD.variantId, quantity: 1, userId: buyer2.userId } as any);
  const o2 = await svc.placeOrder(buyer2.userId, buyer2.addressId, "BKASH");
  keep.orderIds.push(o2.id);
  ok("1C-16/26A: shipping = 180 (60+120 summed)", Number(o2.shippingCost) === 180, String(o2.shippingCost));

  // 1C-23R: preview == checkout (single WH)
  const fees = await cartWishService.calculateDeliveryFees(buyer1.userId, undefined, buyer1.addressId, false, undefined);
  ok("1C-23R: preview == checkout (single WH)", fees[0]?.shippingCost === Number(o1.shippingCost), `${fees[0]?.shippingCost} vs ${o1.shippingCost}`);

  // 1C-15: duplicate checkout
  let err = "";
  try { await svc.placeOrder(buyer1.userId, buyer1.addressId, "BKASH"); } catch (e) { err = (e as Error).message; }
  ok("1C-15: duplicate rejected (cart consumed)", err.length > 0, "NO ERROR");
}
main().catch(console.error).finally(() => prisma.$disconnect());
