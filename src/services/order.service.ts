import {
  PrismaClient,
  OrderStatus,
  PaymentStatus,
  FulfillmentStatus,
  CheckoutStatus,
} from '@prisma/client';

const prisma = new PrismaClient();

// ─── Shared select shapes ────────────────────────────────────────────────────

/** Lightweight variant info returned inside order items */
const variantSelect = {
  id: true,
  sku: true,
  name: true,
  price: true,
  specialPrice: true,
  images: { select: { url: true, altText: true }, take: 1 },
  product: {
    select: {
      id: true,
      name: true,
      slug: true,
    },
  },
};

/** What we expose for an order list item */
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

/** Full order detail — adds payments, refunds, courier info */
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

// ─── Service ─────────────────────────────────────────────────────────────────

export class OrderService {
  /**
   * Converts a completed checkout session into a real Order.
   *
   * The checkout session must:
   *  - belong to this user
   *  - be in REVIEW status (i.e., shipping + payment info confirmed)
   *  - not already be linked to an order
   */
  async placeOrder(userId: string, checkoutSessionId: string) {
    // 1. Load & validate the checkout session
    const session = await prisma.checkoutSession.findUnique({
      where: { id: checkoutSessionId },
      include: {
        carts: {
          include: {
            cart_items: {
              where: { isSelected: true },
              include: {
                product_variants: {
                  include: { product: { select: { vendorId: true } } },
                },
              },
            },
          },
        },
        shippingAddress: true,
      },
    });

    if (!session) {
      throw new Error('Checkout session not found');
    }
    if (session.carts.userId !== userId) {
      throw new Error('This checkout session does not belong to you');
    }
    if (session.status !== CheckoutStatus.REVIEW) {
      throw new Error(
        `Checkout session is in ${session.status} status. Only REVIEW sessions can be placed as orders.`
      );
    }
    if (session.orderId) {
      throw new Error('This checkout session already has an order');
    }
    if (new Date() > session.expiresAt) {
      throw new Error('Checkout session has expired. Please start a new checkout.');
    }

    const cartItems = session.carts.cart_items;
    if (!cartItems.length) {
      throw new Error('No items in checkout session');
    }

    // 2. Group selected cart items by vendor
    const byVendor = new Map<
      string,
      typeof cartItems
    >();

    for (const item of cartItems) {
      const vendorId = item.product_variants.product.vendorId;
      if (!byVendor.has(vendorId)) byVendor.set(vendorId, []);
      byVendor.get(vendorId)!.push(item);
    }

    // 3. Build shipping address snapshot
    if (!session.shippingAddress) {
      throw new Error('Shipping address is missing from checkout session');
    }
    const addr = session.shippingAddress;

    // 4. Create everything in a single transaction
    const order = await prisma.$transaction(async (tx) => {
      // 4a. Create the parent Order
      const newOrder = await tx.order.create({
        data: {
          userId,
          orderNumber: `ORD-${Date.now()}`,
          status: OrderStatus.PENDING,
          paymentStatus: PaymentStatus.PENDING,
          fulfillmentStatus: FulfillmentStatus.UNFULFILLED,
          totalAmount: session.total,
          subtotal: session.subtotal,
          shippingCost: session.shippingCost,
          tax: session.tax,
          discountAmount: session.discount,
          confirmedAt: new Date(),

          // Shipping address snapshot
          address: {
            create: {
              locationId: addr.locationId,
              country: 'Bangladesh', // adapt as needed
              state: '',
              city: '',
              address: addr.addressLine1 + (addr.addressLine2 ? `, ${addr.addressLine2}` : ''),
              landmark: addr.landmark ?? undefined,
              receiverFullName: addr.fullName,
              phone: addr.phone,
            },
          },

          // Per-vendor sub-orders
          vendorOrders: {
            create: Array.from(byVendor.entries()).map(([vendorId, items]) => ({
              vendorId,
              status: OrderStatus.PENDING,
              fulfillmentStatus: FulfillmentStatus.UNFULFILLED,
              subtotal: items.reduce((s, i) => s + i.price * i.quantity, 0),
              shippingCost: 0, // refined per courier assignment later
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

      // 4b. Mark checkout session as COMPLETED and link the order
      await tx.checkoutSession.update({
        where: { id: checkoutSessionId },
        data: {
          status: CheckoutStatus.COMPLETED,
          orderId: newOrder.id,
          completedAt: new Date(),
        },
      });

      // 4c. Decrement stock for each variant
      for (const item of cartItems) {
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { stock: { decrement: item.quantity } },
        });
      }

      return newOrder;
    });

    return order;
  }

  /**
   * Return paginated orders for a user with optional status filter.
   */
  async getUserOrders(
    userId: string,
    opts: { page: number; limit: number; status?: string }
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
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    return { orders, total };
  }

  /**
   * Return a single order — verifies it belongs to this user.
   */
  async getUserOrderById(userId: string, orderId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      select: orderDetailSelect,
    });

    return order ?? null;
  }

  /**
   * Return courier tracking for every vendor sub-order in this order.
   * Verifies the order belongs to this user.
   */
  async getOrderTracking(userId: string, orderId: string) {
    // Confirm ownership
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { id: true, orderNumber: true, status: true },
    });

    if (!order) return null;

    // Fetch vendor orders with their courier details
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
              orderBy: { timestamp: 'desc' },
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
   * Cancel an order — only allowed when status is PENDING.
   * Restores variant stock and creates a Refund record if a payment exists.
   */
  async cancelOrderByUser(userId: string, orderId: string, reason: string) {
    // Load the order and verify ownership
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      include: {
        payments: true,
        vendorOrders: { include: { items: true } },
      },
    });

    if (!order) {
      throw new Error('Order not found');
    }
    if (order.status !== OrderStatus.PENDING) {
      throw new Error(
        `Order cannot be cancelled. Current status: ${order.status}. Only PENDING orders can be cancelled.`
      );
    }

    const updatedOrder = await prisma.$transaction(async (tx) => {
      // 1. Cancel parent order
      const cancelled = await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
        },
        select: orderDetailSelect,
      });

      // 2. Cancel each vendor sub-order
      await tx.vendorOrder.updateMany({
        where: { orderId },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });

      // 3. Restore stock for each item
      for (const vo of order.vendorOrders) {
        for (const item of vo.items) {
          await tx.productVariant.update({
            where: { id: item.variantId },
            data: { stock: { increment: item.quantity } },
          });
        }
      }

      // 4. Create a refund record if any payment was completed
      const paidPayment = order.payments.find(
        (p) => p.status === PaymentStatus.PAID
      );
      if (paidPayment) {
        await tx.refund.create({
          data: {
            orderId,
            amount: paidPayment.amount,
            reason,
            status: 'PENDING',
          },
        });
      }

      return cancelled;
    });

    return updatedOrder;
  }
}