import {
  PrismaClient,
  OrderStatus,
  PaymentStatus,
  FulfillmentStatus,
} from "@prisma/client";

const prisma = new PrismaClient();

// ─── Shared select shapes ─────────────────────────────────────────────────────

const variantSelect = {
  id: true,
  sku: true,
  name: true,
  price: true,
  specialPrice: true,
  images: { select: { url: true, altText: true }, take: 1 },
  product: {
    select: { id: true, name: true, slug: true },
  },
};

const orderListSelect = {
  id: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  totalAmount: true,
  subtotal: true,
  shippingCost: true,
  discountAmount: true,
  createdAt: true,
  confirmedAt: true,
  vendorOrders: {
    select: {
      id: true,
      status: true,
      subtotal: true,
      vendor: { select: { id: true, storeName: true, avatar: true } },
      items: {
        select: {
          id: true,
          quantity: true,
          price: true,
          variant: { select: variantSelect },
        },
      },
    },
  },
  address: {
    select: {
      receiverFullName: true,
      phone: true,
      city: true,
      address: true,
    },
  },
};

const orderDetailSelect = {
  ...orderListSelect,
  paidAt: true,
  cancelledAt: true,
  payments: {
    select: {
      id: true,
      method: true,
      amount: true,
      status: true,
      createdAt: true,
      paidAt: true,
    },
  },
  refunds: {
    select: {
      id: true,
      amount: true,
      reason: true,
      status: true,
      createdAt: true,
    },
  },
  vendorOrders: {
    select: {
      id: true,
      status: true,
      subtotal: true,
      shippingCost: true,
      shippedAt: true,
      deliveredAt: true,
      vendor: { select: { id: true, storeName: true, avatar: true } },
      items: {
        select: {
          id: true,
          quantity: true,
          price: true,
          variant: { select: variantSelect },
        },
      },
      courierOrder: {
        select: {
          id: true,
          courierTrackingId: true,
          status: true,
          recipientName: true,
          recipientAddress: true,
          deliveryCharge: true,
          codAmount: true,
          createdAt: true,
          pickedUpAt: true,
          inTransitAt: true,
          deliveredAt: true,
          courier_providers: {
            select: { id: true, displayName: true, logo: true },
          },
        },
      },
    },
  },
};

// ─── Service ──────────────────────────────────────────────────────────────────

export class OrderService {
  /**
   * Place an order directly from the user's cart selected items.
   * No checkout session needed — COD flow.
   */
  async placeOrder(userId: string, userAddressId: string) {
    // 1. Load cart with selected items
    const cart = await prisma.carts.findFirst({
      where: { userId },
      include: {
        cart_items: {
          where: { isSelected: true },
          include: {
            product_variants: {
              include: {
                product: { select: { vendorId: true } },
              },
            },
          },
        },
      },
    });

    if (!cart) {
      throw new Error("Cart not found");
    }
    if (!cart.cart_items.length) {
      throw new Error("No selected items in cart");
    }

    // 2. Load and verify shipping address belongs to this user
    const address = await prisma.userAddress.findFirst({
      where: { id: userAddressId, userId },
      include: {
        locations: { select: { name: true } },
      },
    });

    if (!address) {
      throw new Error("Shipping address not found");
    }

    const cartItems = cart.cart_items;

    // 3. Calculate subtotal from actual cart item prices
    const subtotal = cartItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    // 4. Group items by vendor
    const byVendor = new Map<string, typeof cartItems>();
    for (const item of cartItems) {
      const vendorId = item.product_variants.product.vendorId;
      if (!byVendor.has(vendorId)) byVendor.set(vendorId, []);
      byVendor.get(vendorId)!.push(item);
    }

    // 5. Create everything in one transaction
    const order = await prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          userId,
          orderNumber: `ORD-${Date.now()}`,
          status: OrderStatus.PENDING,
          paymentStatus: PaymentStatus.PENDING,
          fulfillmentStatus: FulfillmentStatus.UNFULFILLED,
          totalAmount: subtotal,
          subtotal,
          shippingCost: 0,
          tax: 0,
          discountAmount: 0,
          confirmedAt: new Date(),

          // Snapshot shipping address
          address: {
            create: {
              locationId: address.locationId,
              country: "Bangladesh",
              state: "",
              city: address.locations?.name ?? "",
              address:
                address.addressLine1 +
                (address.addressLine2 ? `, ${address.addressLine2}` : ""),
              landmark: address.landmark ?? undefined,
              receiverFullName: address.fullName,
              phone: address.phone,
            },
          },

          // One VendorOrder per vendor with their items
          vendorOrders: {
            create: Array.from(byVendor.entries()).map(([vendorId, items]) => ({
              vendorId,
              status: OrderStatus.PENDING,
              fulfillmentStatus: FulfillmentStatus.UNFULFILLED,
              subtotal: items.reduce((s, i) => s + i.price * i.quantity, 0),
              shippingCost: 0,
              items: {
                create: items.map((i) => ({
                  variantId: i.variantId,
                  quantity: i.quantity,
                  price: i.price,
                })),
              },
            })),
          },
        },
        select: orderDetailSelect,
      });

      // Decrement stock
      for (const item of cartItems) {
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { stock: { decrement: item.quantity } },
        });
      }

      // Delete placed items from cart after successful order
      await tx.cart_items.deleteMany({
        where: { cartId: cart.id, isSelected: true },
      });
      return newOrder;
    });

    return order;
  }

  /**
   * Paginated order list for logged-in user.
   */
  async getUserOrders(
    userId: string,
    opts: { page: number; limit: number; status?: string },
  ) {
    const { page, limit, status } = opts;
    const skip = (page - 1) * limit;
    const where = {
      userId,
      ...(status ? { status: status as OrderStatus } : {}),
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        select: orderListSelect,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    return { orders, total };
  }

  /**
   * Single order detail — verifies ownership.
   */
  async getUserOrderById(userId: string, orderId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      select: orderDetailSelect,
    });
    return order ?? null;
  }

  /**
   * Courier tracking for all vendor sub-orders in an order.
   */
  async getOrderTracking(userId: string, orderId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { id: true, orderNumber: true, status: true },
    });
    if (!order) return null;

    const vendorOrders = await prisma.vendorOrder.findMany({
      where: { orderId },
      select: {
        id: true,
        status: true,
        shippedAt: true,
        deliveredAt: true,
        vendor: { select: { id: true, storeName: true, avatar: true } },
        courierOrder: {
          select: {
            id: true,
            courierTrackingId: true,
            courierOrderId: true,
            status: true,
            courierStatus: true,
            recipientName: true,
            recipientAddress: true,
            deliveryCharge: true,
            codAmount: true,
            createdAt: true,
            pickedUpAt: true,
            inTransitAt: true,
            deliveredAt: true,
            returnedAt: true,
            cancelledAt: true,
            courier_providers: {
              select: { id: true, displayName: true, logo: true },
            },
            courier_tracking_history: {
              select: {
                id: true,
                status: true,
                courierStatus: true,
                messageEn: true,
                messageBn: true,
                location: true,
                timestamp: true,
              },
              orderBy: { timestamp: "desc" },
            },
          },
        },
      },
    });

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      vendorOrders,
    };
  }

  /**
   * Cancel a PENDING order — restores stock, creates refund record if paid.
   */
  async cancelOrderByUser(userId: string, orderId: string, reason: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      include: {
        payments: true,
        vendorOrders: { include: { items: true } },
      },
    });

    if (!order) throw new Error("Order not found");
    if (order.status !== OrderStatus.PENDING) {
      throw new Error(
        `Order cannot be cancelled. Current status: ${order.status}. Only PENDING orders can be cancelled.`,
      );
    }

    const updatedOrder = await prisma.$transaction(async (tx) => {
      const cancelled = await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
        select: orderDetailSelect,
      });

      await tx.vendorOrder.updateMany({
        where: { orderId },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
      });

      // Restore stock
      for (const vo of order.vendorOrders) {
        for (const item of vo.items) {
          await tx.productVariant.update({
            where: { id: item.variantId },
            data: { stock: { increment: item.quantity } },
          });
        }
      }

      // Create refund record if a payment was already made
      const paidPayment = order.payments.find(
        (p) => p.status === PaymentStatus.PAID,
      );
      if (paidPayment) {
        await tx.refund.create({
          data: {
            orderId,
            amount: paidPayment.amount,
            reason,
            status: "PENDING",
          },
        });
      }

      return cancelled;
    });

    return updatedOrder;
  }
}
