import { prisma } from "../src/config/prisma.ts";
const USER_ID = "cmj72c9po0000o0ucd3proe4e";
async function main() {
  const user = await prisma.user.findUnique({ where: { id: USER_ID }, select: { id: true, phone: true, email: true } });
  console.log("user:", JSON.stringify(user));
  const carts = await prisma.carts.findMany({ where: { userId: USER_ID }, select: { id: true } });
  console.log("carts:", carts.length);
  for (const c of carts) {
    const items = await prisma.cart_items.findMany({
      where: { cartId: c.id, isSelected: true },
      select: { id: true, variantId: true, quantity: true, price: true, isSelected: true, product_variants: { select: { sku: true, price: true } } },
    });
    console.log(`cart ${c.id}: ${items.length} selected items`);
    for (const it of items) {
      const v = await prisma.productVariant.findUnique({ where: { id: it.variantId }, select: { sku: true, price: true } });
      const ws = await prisma.warehouseStock.findMany({ where: { variantId: it.variantId, quantity: { gt: 0 } }, select: { quantity: true, reservedQty: true, warehouse: { select: { name: true, locationId: true } } } });
      console.log(`  sku=${v?.sku} qty=${it.quantity} cartPrice=${it.price} variantPrice=${Number(v?.price)} stock=[${ws.map(w => `${w.warehouse.name}(loc=${w.warehouse.locationId}) sellable=${w.quantity - w.reservedQty}`).join(", ")}]`);
    }
  }
  const addr = await prisma.userAddress.findFirst({ where: { userId: USER_ID }, select: { id: true, locationId: true } });
  console.log("address:", JSON.stringify(addr));
}
main().catch(console.error).finally(() => prisma.$disconnect());
