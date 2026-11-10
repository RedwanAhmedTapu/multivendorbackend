import { prisma } from "../src/config/prisma.ts";
async function main() {
  const rules = await prisma.courierPricingRules.findMany({
    where: { isActive: true },
    select: { id: true, courierProviderId: true, fromLocationId: true, toLocationId: true, basePrice: true, perKgCharge: true, maxWeight: true },
  });
  for (const r of rules) console.log(`RULE: provider=${r.courierProviderId} from=${r.fromLocationId ?? "null"} to=${r.toLocationId ?? "null"} base=${r.basePrice} perKg=${r.perKgCharge} maxW=${r.maxWeight}`);
  const cart = await prisma.carts.findFirst({ where: { users: { phone: "1995912718" } }, select: { id: true } });
  if (!cart) { console.log("NO CART"); return; }
  const items = await prisma.cart_items.findMany({
    where: { cartId: cart.id, isSelected: true },
    select: { variantId: true, quantity: true, price: true, product_variants: { select: { sku: true, price: true } } },
  });
  for (const it of items) {
    const ws = await prisma.warehouseStock.findMany({
      where: { variantId: it.variantId, quantity: { gt: 0 } },
      select: { warehouseId: true, quantity: true, reservedQty: true, damagedQty: true, warehouse: { select: { name: true, locationId: true } } },
    });
    console.log(`ITEM: sku=${it.product_variants.sku} qty=${it.quantity} cartPrice=${it.price} variantPrice=${Number(it.product_variants.price)}`);
    for (const w of ws) console.log(`  STOCK: wh=${w.warehouse.name} loc=${w.warehouse.locationId} sellable=${w.quantity - w.reservedQty - w.damagedQty}`);
  }
  const totalQty = items.reduce((s, i) => s + i.quantity, 0);
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  console.log(`TOTALS: qty=${totalQty} weight=${totalQty * 0.5} subtotal=${subtotal}`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
