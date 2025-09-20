import { PrismaClient,OrderStatus, PaymentStatus, ShippingStatus } from '@prisma/client';
import type { OrderItem, ShippingAddress } from '../types/index.ts';



const prisma=new PrismaClient();

export class OrderService {
  async createOrder(
    userId: string,
    items: OrderItem[],
    shippingAddress: ShippingAddress,
    deliveryFee: number
  ) {
    // Group items by vendor
    const vendorItems = await this.groupItemsByVendor(items);

    const orders = [];

    for (const [vendorId, vendorItems] of Object.entries(vendorItems)) {
      const totalAmount = vendorItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

      const order = await prisma.order.create({
        data: {
          vendorId,
          totalAmount,
          status: OrderStatus.PENDING,
          items: {
            create: vendorItems.map(item => ({
              variantId: item.variantId,
              quantity: item.quantity,
              price: item.price
            }))
          },
          shipping: {
            create: {
              address: shippingAddress.address,
              city: shippingAddress.city,
              postalCode: shippingAddress.postalCode,
              country: shippingAddress.country,
              status: ShippingStatus.PENDING
            }
          },
          payments: {
            create: {
              method: 'cash_on_delivery',
              amount: deliveryFee, // Only delivery fee for COD
              status: PaymentStatus.PENDING
            }
          }
        },
        include: {
          items: true,
          shipping: true,
          payments: true,
          vendor: true
        }
      });

      orders.push(order);
    }

    return orders;
  }

  private async groupItemsByVendor(items: OrderItem[]) {
    const vendorItems: { [vendorId: string]: OrderItem[] } = {};

    for (const item of items) {
      const variant = await prisma.productVariant.findUnique({
        where: { id: item.variantId },
        include: { product: true }
      });

      if (!variant) {
        throw new Error(`Variant ${item.variantId} not found`);
      }

      const vendorId = variant.product.vendorId;
      if (!vendorItems[vendorId]) {
        vendorItems[vendorId] = [];
      }

      vendorItems[vendorId].push(item);
    }

    return vendorItems;
  }

  async updateOrderStatus(orderId: number, status: OrderStatus) {
    return prisma.order.update({
      where: { id: orderId },
      data: { status },
      include: {
        items: {
          include: {
            variant: {
              include: {
                product: true
              }
            }
          }
        },
        vendor: true,
        payments: true
      }
    });
  }

  async getOrderById(orderId: number) {
    return prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            variant: {
              include: {
                product: true
              }
            }
          }
        },
        vendor: true,
        payments: true,
        shipping: true
      }
    });
  }

  async cancelOrder(orderId: number, reason: string) {
    const order = await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED },
      include: {
        payments: true,
        items: true
      }
    });

    // Create refund record if any payment was made
    if (order.payments.some(p => p.status === PaymentStatus.PAID)) {
      const totalPaid = order.payments
        .filter(p => p.status === PaymentStatus.PAID)
        .reduce((sum, p) => sum + p.amount, 0);

      await prisma.refund.create({
        data: {
          orderId,
          amount: totalPaid,
          reason,
          status: 'PENDING'
        }
      });
    }

    return order;
  }
}