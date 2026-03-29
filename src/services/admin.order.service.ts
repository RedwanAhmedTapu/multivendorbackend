// services/admin.order.service.ts
import { prisma } from "../config/prisma.ts";
import type {
  OrderStatus,
  PaymentStatus,
  FulfillmentStatus,
  RefundType,
  RefundStatus,
} from "@prisma/client";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface AdminOrderFilters {
  page?: number;
  limit?: number;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  fulfillmentStatus?: FulfillmentStatus;
  vendorId?: string;
  userId?: string;
  search?: string;
  fromDate?: string;
  toDate?: string;
}

// ─────────────────────────────────────────────
// SHARED INCLUDE SHAPES
// ─────────────────────────────────────────────

const orderListInclude = {
  user: {
    select: { id: true, name: true, email: true, phone: true, isVerified: true },
  },
  address: {
    select: {
      receiverFullName: true,
      phone: true,
      city: true,
      address: true,
      zone: true,
    },
  },
  vendorOrders: {
    select: {
      id: true,
      status: true,
      fulfillmentStatus: true,
      subtotal: true,
      vendor: { select: { id: true, storeName: true } },
      items: { select: { quantity: true, price: true } },
      courierOrder: {
        select: { courierTrackingId: true, status: true },
      },
    },
  },
  payments: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: { method: true, status: true, amount: true, paidAt: true },
  },
} as const;

const orderDetailInclude = {
  user: {
    select: { id: true, name: true, email: true, phone: true, isVerified: true, createdAt: true },
  },
  address: {
    include: { location: true },
  },
  vendorOrders: {
    include: {
      vendor: {
        select: { id: true, storeName: true, avatar: true, email: true },
      },
      items: {
        include: {
          variant: {
            include: {
              product: { select: { id: true, name: true, slug: true } },
              images: { take: 1, orderBy: { sortOrder: "asc" as const } },
            },
          },
        },
      },
      courierOrder: {
        include: {
          courier_tracking_history: { orderBy: { timestamp: "desc" as const } },
          courier_providers: { select: { name: true, displayName: true } },
        },
      },
    },
  },
  payments: { orderBy: { createdAt: "desc" as const } },
  refunds: { orderBy: { createdAt: "desc" as const } },
  offerUsages: {
    include: {
      offer: { select: { title: true, type: true, discountType: true } },
    },
  },
} as const;

// ─────────────────────────────────────────────
// ADMIN ORDER SERVICE
// ─────────────────────────────────────────────

export const AdminOrderService = {
  // =====================================================
  // LISTING & DETAILS
  // =====================================================

  /**
   * Get all orders with full filter support + pagination
   */
  async getAll(filters: AdminOrderFilters) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (filters.status) where.status = filters.status;
    if (filters.paymentStatus) where.paymentStatus = filters.paymentStatus;
    if (filters.fulfillmentStatus) where.fulfillmentStatus = filters.fulfillmentStatus;
    if (filters.userId) where.userId = filters.userId;

    if (filters.vendorId) {
      where.vendorOrders = { some: { vendorId: filters.vendorId } };
    }

    if (filters.fromDate || filters.toDate) {
      where.createdAt = {};
      if (filters.fromDate) where.createdAt.gte = new Date(filters.fromDate);
      if (filters.toDate) where.createdAt.lte = new Date(filters.toDate);
    }

    if (filters.search) {
      where.OR = [
        { orderNumber: { contains: filters.search, mode: "insensitive" } },
        { user: { name: { contains: filters.search, mode: "insensitive" } } },
        { user: { email: { contains: filters.search, mode: "insensitive" } } },
        { user: { phone: { contains: filters.search, mode: "insensitive" } } },
        {
          address: {
            receiverFullName: { contains: filters.search, mode: "insensitive" },
          },
        },
      ];
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: orderListInclude,
      }),
      prisma.order.count({ where }),
    ]);

    return {
      orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    };
  },

  /**
   * Get a single order — full admin detail
   */
  async getById(orderId: string) {
    return prisma.order.findUnique({
      where: { id: orderId },
      include: orderDetailInclude,
    });
  },

  /**
   * Get orders for a specific vendor (admin view)
   */
  async getByVendorId(
    vendorId: string,
    filters: { page?: number; limit?: number; status?: OrderStatus }
  ) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = { vendorId };
    if (filters.status) where.status = filters.status;

    const [vendorOrders, total] = await Promise.all([
      prisma.vendorOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          order: {
            include: {
              user: { select: { id: true, name: true, email: true, phone: true } },
              address: {
                select: {
                  receiverFullName: true,
                  phone: true,
                  city: true,
                  address: true,
                },
              },
              payments: {
                take: 1,
                orderBy: { createdAt: "desc" },
                select: { method: true, status: true, amount: true },
              },
            },
          },
          items: {
            include: {
              variant: {
                include: {
                  product: { select: { id: true, name: true } },
                },
              },
            },
          },
          courierOrder: {
            select: {
              courierTrackingId: true,
              status: true,
              lastStatusUpdate: true,
            },
          },
        },
      }),
      prisma.vendorOrder.count({ where }),
    ]);

    return {
      vendorOrders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    };
  },

  // =====================================================
  // STATISTICS & ANALYTICS
  // =====================================================

  /**
   * Platform-wide order statistics
   */
  async getStatistics() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    weekStart.setHours(0, 0, 0, 0);

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [
      total,
      pending,
      confirmed,
      processing,
      shipped,
      delivered,
      cancelled,
      refunded,
      failedDelivery,
      todayOrders,
      weekOrders,
      monthOrders,
      totalRevenue,
      todayRevenue,
      weekRevenue,
      monthRevenue,
      pendingRefunds,
      fraudQueue,
      pendingCod,
    ] = await Promise.all([
      prisma.order.count(),
      prisma.order.count({ where: { status: "PENDING" } }),
      prisma.order.count({ where: { status: "CONFIRMED" } }),
      prisma.order.count({ where: { status: "PROCESSING" } }),
      prisma.order.count({ where: { status: "SHIPPED" } }),
      prisma.order.count({ where: { status: "DELIVERED" } }),
      prisma.order.count({ where: { status: "CANCELLED" } }),
      prisma.order.count({ where: { status: "REFUNDED" } }),
      prisma.order.count({ where: { status: "FAILED_TO_DELIVER" } }),
      prisma.order.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.order.count({ where: { createdAt: { gte: weekStart } } }),
      prisma.order.count({ where: { createdAt: { gte: monthStart } } }),
      prisma.order.aggregate({
        where: { paymentStatus: "PAID" },
        _sum: { totalAmount: true },
      }),
      prisma.order.aggregate({
        where: { paymentStatus: "PAID", createdAt: { gte: todayStart } },
        _sum: { totalAmount: true },
      }),
      prisma.order.aggregate({
        where: { paymentStatus: "PAID", createdAt: { gte: weekStart } },
        _sum: { totalAmount: true },
      }),
      prisma.order.aggregate({
        where: { paymentStatus: "PAID", createdAt: { gte: monthStart } },
        _sum: { totalAmount: true },
      }),
      prisma.refund.count({ where: { status: "PENDING" } }),
      // Fraud queue: PENDING orders with no payment record
      prisma.order.count({
        where: { status: "PENDING", paymentStatus: "PENDING", payments: { none: {} } },
      }),
      // COD orders waiting for vendor confirmation
      prisma.order.count({
        where: { status: "PENDING", paymentStatus: "PENDING", payments: { some: {} } },
      }),
    ]);

    return {
      total,
      byStatus: {
        pending,
        confirmed,
        processing,
        shipped,
        delivered,
        cancelled,
        refunded,
        failedDelivery,
      },
      newOrders: { today: todayOrders, week: weekOrders, month: monthOrders },
      revenue: {
        total: totalRevenue._sum.totalAmount ?? 0,
        today: todayRevenue._sum.totalAmount ?? 0,
        week: weekRevenue._sum.totalAmount ?? 0,
        month: monthRevenue._sum.totalAmount ?? 0,
      },
      actionRequired: {
        pendingRefunds,
        fraudQueue,
        pendingCodConfirmations: pendingCod,
      },
    };
  },

  /**
   * Revenue analytics broken down by period
   */
  async getAnalytics(
    period: "daily" | "weekly" | "monthly",
    vendorId?: string
  ) {
    const now = new Date();
    let fromDate: Date;

    if (period === "daily") {
      fromDate = new Date(now);
      fromDate.setDate(now.getDate() - 30);
    } else if (period === "weekly") {
      fromDate = new Date(now);
      fromDate.setDate(now.getDate() - 12 * 7);
    } else {
      fromDate = new Date(now);
      fromDate.setMonth(now.getMonth() - 12);
    }

    const where: any = {
      paymentStatus: "PAID",
      createdAt: { gte: fromDate },
    };
    if (vendorId) {
      where.vendorOrders = { some: { vendorId } };
    }

    const orders = await prisma.order.findMany({
      where,
      select: { totalAmount: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    // Group by period bucket
    const grouped: Record<string, { revenue: number; orders: number }> = {};

    for (const order of orders) {
      let key: string;

      if (period === "daily") {
        key = order.createdAt.toISOString().split("T")[0];
      } else if (period === "weekly") {
        const d = new Date(order.createdAt);
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        key = weekStart.toISOString().split("T")[0];
      } else {
        key = `${order.createdAt.getFullYear()}-${String(order.createdAt.getMonth() + 1).padStart(2, "0")}`;
      }

      if (!grouped[key]) grouped[key] = { revenue: 0, orders: 0 };
      grouped[key].revenue += order.totalAmount;
      grouped[key].orders += 1;
    }

    return Object.entries(grouped).map(([date, data]) => ({ date, ...data }));
  },

  // =====================================================
  // FRAUD QUEUE
  // =====================================================

  /**
   * Get orders held for fraud review:
   * PENDING status + PENDING payment + no payment record (not even a failed attempt)
   */
  async getFraudReview(params: { page?: number; limit?: number }) {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = {
      status: "PENDING" as OrderStatus,
      paymentStatus: "PENDING" as PaymentStatus,
      payments: { none: {} },
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "asc" }, // oldest first — most urgent
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              isVerified: true,
              createdAt: true,
              orders: {
                where: {
                  status: { in: ["CANCELLED", "RETURNED", "FAILED_TO_DELIVER"] },
                },
                select: { id: true },
              },
            },
          },
          address: true,
          vendorOrders: {
            select: {
              subtotal: true,
              shippingCost: true,
              vendor: { select: { id: true, storeName: true } },
              items: { select: { quantity: true, price: true } },
            },
          },
        },
      }),
      prisma.order.count({ where }),
    ]);

    return {
      orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    };
  },

  // =====================================================
  // STATUS ACTIONS
  // =====================================================

  /**
   * Confirm an order (for COD or fraud-cleared orders)
   */
  async confirmOrder(orderId: string, adminId: string, note?: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, orderNumber: true, userId: true },
    });
    if (!order) throw new Error("Order not found");
    if (order.status !== "PENDING") {
      throw new Error(`Order must be PENDING to confirm. Current: ${order.status}`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "CONFIRMED", confirmedAt: new Date() },
      });

      await tx.vendorOrder.updateMany({
        where: { orderId, status: "PENDING" },
        data: { status: "CONFIRMED" },
      });

      await tx.auditLog.create({
        data: {
          action: "ORDER_CONFIRMED",
          entity: "Order",
          entityId: orderId,
          newData: { status: "CONFIRMED", note, confirmedBy: adminId },
          userId: adminId,
        },
      });
    });

    if (order.userId) {
      await prisma.notification.create({
        data: {
          type: "ORDER",
          title: "Order Confirmed",
          message: `Your order ${order.orderNumber} has been confirmed and is being processed.`,
          targetType: "USER",
          targetId: order.userId,
          orderId,
          actionUrl: `/orders/${orderId}`,
        },
      });
    }

    return { success: true };
  },

  /**
   * Approve a fraud-held order (delegates to confirmOrder)
   */
  async approveOrder(orderId: string, adminId: string, note?: string) {
    return AdminOrderService.confirmOrder(orderId, adminId, note ?? "Approved after fraud review");
  },

  /**
   * Reject a fraud-held order — cancels it with reason
   */
  async rejectOrder(orderId: string, adminId: string, reason: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, userId: true, orderNumber: true },
    });
    if (!order) throw new Error("Order not found");
    if (order.status !== "PENDING") {
      throw new Error(`Only PENDING orders can be rejected. Current: ${order.status}`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });

      await tx.vendorOrder.updateMany({
        where: { orderId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          action: "ORDER_REJECTED_FRAUD",
          entity: "Order",
          entityId: orderId,
          newData: { reason, rejectedBy: adminId },
          userId: adminId,
        },
      });
    });

    if (order.userId) {
      await prisma.notification.create({
        data: {
          type: "ORDER",
          title: "Order Cancelled",
          message: `Your order ${order.orderNumber} could not be processed. Please contact support.`,
          targetType: "USER",
          targetId: order.userId,
          orderId,
        },
      });
    }

    return { success: true };
  },

  /**
   * Force cancel an order (admin can cancel any non-final status)
   */
  async cancelOrder(orderId: string, adminId: string, reason: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { vendorOrders: { include: { items: true } } },
    });
    if (!order) throw new Error("Order not found");

    const nonCancellable: OrderStatus[] = ["DELIVERED", "CANCELLED", "REFUNDED"];
    if (nonCancellable.includes(order.status)) {
      throw new Error(`Cannot cancel order in status: ${order.status}`);
    }

    const needsStockRestore = !["SHIPPED", "DELIVERED", "FAILED_TO_DELIVER"].includes(order.status);

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });

      await tx.vendorOrder.updateMany({
        where: { orderId },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });

      // Restore stock for pre-shipment cancellations
      if (needsStockRestore) {
        for (const vo of order.vendorOrders) {
          for (const item of vo.items) {
            await tx.productVariant.update({
              where: { id: item.variantId },
              data: { stock: { increment: item.quantity } },
            });
          }
        }
      }

      await tx.auditLog.create({
        data: {
          action: "ORDER_CANCELLED",
          entity: "Order",
          entityId: orderId,
          newData: { reason, cancelledBy: adminId },
          userId: adminId,
        },
      });
    });

    if (order.userId) {
      await prisma.notification.create({
        data: {
          type: "ORDER",
          title: "Order Cancelled",
          message: `Your order has been cancelled. Reason: ${reason}`,
          targetType: "USER",
          targetId: order.userId,
          orderId,
        },
      });
    }

    return { success: true };
  },

  /**
   * Admin override — update master Order to any valid status
   */
  async updateStatus(
    orderId: string,
    adminId: string,
    newStatus: OrderStatus,
    note?: string
  ) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, userId: true, orderNumber: true },
    });
    if (!order) throw new Error("Order not found");

    const oldStatus = order.status;

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: newStatus,
          ...(newStatus === "CONFIRMED" && { confirmedAt: new Date() }),
          ...(newStatus === "CANCELLED" && { cancelledAt: new Date() }),
        },
      });

      await tx.auditLog.create({
        data: {
          action: "STATUS_UPDATE",
          entity: "Order",
          entityId: orderId,
          oldData: { status: oldStatus },
          newData: { status: newStatus, note, updatedBy: adminId },
          userId: adminId,
        },
      });
    });

    return { success: true, oldStatus, newStatus };
  },

  /**
   * Admin override — update a specific VendorOrder status directly
   */
  async updateVendorOrderStatus(
    orderId: string,
    vendorOrderId: string,
    adminId: string,
    newStatus: OrderStatus,
    note?: string
  ) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId, orderId },
      select: { id: true, status: true, vendorId: true },
    });
    if (!vendorOrder) throw new Error("Vendor order not found");

    const oldStatus = vendorOrder.status;

    await prisma.$transaction(async (tx) => {
      await tx.vendorOrder.update({
        where: { id: vendorOrderId },
        data: {
          status: newStatus,
          ...(newStatus === "SHIPPED" && { shippedAt: new Date() }),
          ...(newStatus === "DELIVERED" && { deliveredAt: new Date() }),
          ...(newStatus === "CANCELLED" && { cancelledAt: new Date() }),
        },
      });

      await tx.auditLog.create({
        data: {
          action: "VENDOR_ORDER_STATUS_UPDATE",
          entity: "VendorOrder",
          entityId: vendorOrderId,
          oldData: { status: oldStatus },
          newData: { status: newStatus, note, updatedBy: adminId },
          userId: adminId,
        },
      });
    });

    // Notify vendor
    await prisma.notification.create({
      data: {
        type: "ORDER",
        title: "Order Status Updated by Admin",
        message: `Your order has been updated to ${newStatus} by the platform.`,
        targetType: "VENDOR",
        targetId: vendorOrder.vendorId,
        orderId,
      },
    });

    return { success: true, oldStatus, newStatus };
  },

  // =====================================================
  // REFUNDS
  // =====================================================

  /**
   * Get all refund records with filters
   */
  async getAllRefunds(params: {
    page?: number;
    limit?: number;
    status?: RefundStatus;
  }) {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (params.status) where.status = params.status;

    const [refunds, total] = await Promise.all([
      prisma.refund.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          order: {
            select: {
              orderNumber: true,
              totalAmount: true,
              paymentStatus: true,
              user: { select: { id: true, name: true, email: true, phone: true } },
            },
          },
        },
      }),
      prisma.refund.count({ where }),
    ]);

    return {
      refunds,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    };
  },

  /**
   * Process/initiate a refund for an order (admin-triggered)
   */
  async processRefund(
    orderId: string,
    adminId: string,
    amount: number,
    reason: string,
    refundType: RefundType
  ) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        totalAmount: true,
        paymentStatus: true,
        status: true,
        userId: true,
      },
    });

    if (!order) throw new Error("Order not found");
    if (order.paymentStatus !== "PAID") {
      throw new Error("Refunds can only be issued for paid orders");
    }
    if (amount <= 0 || amount > order.totalAmount) {
      throw new Error(
        `Refund amount must be between 1 and ${order.totalAmount}`
      );
    }

    const isFullRefund = amount >= order.totalAmount;

    const refund = await prisma.$transaction(async (tx) => {
      const r = await tx.refund.create({
        data: {
          orderId,
          amount,
          reason,
          status: "APPROVED",
          processedAt: new Date(),
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: {
          status: isFullRefund ? "REFUNDED" : (order.status as OrderStatus),
          paymentStatus: isFullRefund ? "REFUNDED" : "PAID",
        },
      });

      await tx.auditLog.create({
        data: {
          action: "REFUND_PROCESSED",
          entity: "Order",
          entityId: orderId,
          newData: { amount, reason, refundType, processedBy: adminId, isFullRefund },
          userId: adminId,
        },
      });

      return r;
    });

    if (order.userId) {
      await prisma.notification.create({
        data: {
          type: "PAYMENT",
          title: "Refund Processed",
          message: `A refund of ৳${amount.toFixed(2)} has been processed for order ${order.orderNumber}.`,
          targetType: "USER",
          targetId: order.userId,
          orderId,
          actionUrl: `/orders/${orderId}`,
        },
      });
    }

    return refund;
  },

  /**
   * Approve a pending return/refund request (submitted by customer)
   */
  async approveRefund(
    refundId: string,
    adminId: string,
    amount: number,
    note?: string
  ) {
    const refund = await prisma.refund.findUnique({
      where: { id: refundId },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            totalAmount: true,
            paymentStatus: true,
            status: true,
            userId: true,
          },
        },
      },
    });

    if (!refund) throw new Error("Refund record not found");
    if (refund.status !== "PENDING") {
      throw new Error(`Refund is not in PENDING status. Current: ${refund.status}`);
    }
    if (amount <= 0 || amount > refund.order.totalAmount) {
      throw new Error(
        `Amount must be between 1 and ${refund.order.totalAmount}`
      );
    }

    const isFullRefund = amount >= refund.order.totalAmount;

    await prisma.$transaction(async (tx) => {
      await tx.refund.update({
        where: { id: refundId },
        data: { amount, status: "APPROVED", processedAt: new Date() },
      });

      await tx.order.update({
        where: { id: refund.orderId },
        data: {
          status: isFullRefund ? "REFUNDED" : (refund.order.status as OrderStatus),
          paymentStatus: isFullRefund ? "REFUNDED" : refund.order.paymentStatus,
        },
      });

      await tx.auditLog.create({
        data: {
          action: "APPROVE",
          entity: "Refund",
          entityId: refundId,
          newData: { amount, note, approvedBy: adminId },
          userId: adminId,
        },
      });
    });

    if (refund.order.userId) {
      await prisma.notification.create({
        data: {
          type: "PAYMENT",
          title: "Return Request Approved",
          message: `Your return request for order ${refund.order.orderNumber} has been approved. Refund of ৳${amount.toFixed(2)} will be processed.`,
          targetType: "USER",
          targetId: refund.order.userId,
          orderId: refund.orderId,
        },
      });
    }

    return { success: true };
  },

  /**
   * Reject a pending return/refund request
   */
  async rejectRefund(refundId: string, adminId: string, reason: string) {
    const refund = await prisma.refund.findUnique({
      where: { id: refundId },
      include: {
        order: {
          select: { orderNumber: true, userId: true },
        },
      },
    });

    if (!refund) throw new Error("Refund record not found");
    if (refund.status !== "PENDING") {
      throw new Error(`Refund is not in PENDING status. Current: ${refund.status}`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.refund.update({
        where: { id: refundId },
        data: { status: "REJECTED" },
      });

      await tx.auditLog.create({
        data: {
          action: "REJECT",
          entity: "Refund",
          entityId: refundId,
          newData: { reason, rejectedBy: adminId },
          userId: adminId,
        },
      });
    });

    if (refund.order.userId) {
      await prisma.notification.create({
        data: {
          type: "ORDER",
          title: "Return Request Rejected",
          message: `Your return request for order ${refund.order.orderNumber} was not approved. Reason: ${reason}`,
          targetType: "USER",
          targetId: refund.order.userId,
          orderId: refund.orderId,
        },
      });
    }

    return { success: true };
  },
};