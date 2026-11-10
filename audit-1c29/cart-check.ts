import { prisma } from "../src/config/prisma.ts";
async function main() {
  const user = await prisma.user.findFirst({ where: { phone: "1995912718" }, select: { id: true } });
  if (!user) { console.log("NO USER"); return; }
  console.log("userId:", user.id);
  const carts = await prisma.carts.findMany({ where: { userId: user.id }, select: { id: true } });
  for (const c of carts) {
    const items = await prisma.cart_items.findMany({ where: { cartId: c.id }, select: { id: true, variantId: true, quantity: true, price: true, isSelected: true } });
    console.log("cart:", c.id, "items:", items.length);
    for (const it of items) {
      const v = await prisma.productVariant.findUnique({ where: { id: it.variantId }, select: { sku: true, price: true } });
      const ws = await prisma.warehouseStock.findMany({ where: { variantId: it.variantId, quantity: { gt: 0 } }, select: { warehouseId: true, quantity: true, reservedQty: true, warehouse: { select: { name: true, locationId: true } } } });
      console.log(`  sku=${v?.sku} qty=${it.quantity} cartPrice=${it.price} selected=${it.isSelected} variantPrice=${Number(v?.price)} stock=${JSON.stringify(ws.map(w => ({ wh: w.warehouse.name, loc: w.warehouse.locationId, sellable: w.quantity - w.reservedQty })))}`);
    }
  }
  const addr = await prisma.userAddress.findFirst({ where: { userId: user.id }, select: { id: true, locationId: true } });
  console.log("address:", JSON.stringify(addr));
}
main().catch(console.error).finally(() => prisma.$disconnect());
