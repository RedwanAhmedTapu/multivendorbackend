// services/vendor.order.service.ts
import { prisma } from "../config/prisma.ts";
import type { OrderStatus, FulfillmentStatus } from "@prisma/client";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface VendorOrderFilters {
  page?: number;
  limit?: number;
  status?: OrderStatus;
  fulfillmentStatus?: FulfillmentStatus;
  search?: string;        // search by orderNumber or customer name
  fromDate?: string;
  toDate?: string;
}

// ─────────────────────────────────────────────
// SHARED INCLUDE SHAPES
// ─────────────────────────────────────────────

const vendorOrderListInclude = {
  order: {
    select: {
      id: true,
      orderNumber: true,
      paymentStatus: true,
      createdAt: true,
      confirmedAt: true,
      address: {
        select: {
          receiverFullName: true,
          phone: true,
          city: true,
          address: true,
          zone: true,
        },
      },
      user: {
        select: { id: true, name: true, email: true, phone: true },
      },
    },
  },
  items: {
    include: {
      variant: {
        include: {
          product: { select: { id: true, name: true, slug: true } },
          images: {
            take: 1,
            orderBy: { sortOrder: "asc" as const },
            select: { url: true, altText: true },
          },
          attributes: {
            include: {
              attributeValue: { include: { attribute: true } },
            },
          },
        },
      },
    },
  },
  courierOrder: {
    select: {
      id: true,
      courierTrackingId: true,
      courierOrderId: true,
      status: true,
      lastStatusUpdate: true,
      courier_providers: {
        select: { name: true, displayName: true, logo: true },
      },
    },
  },
} as const;

const vendorOrderDetailInclude = {
  order: {
    include: {
      address: {
        include: { location: true },
      },
      user: { select: { id: true, name: true, email: true, phone: true } },
      payments: {
        orderBy: { createdAt: "desc" as const },
        take: 1,
        select: { method: true, status: true, amount: true, paidAt: true },
      },
    },
  },
  items: {
    include: {
      variant: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              slug: true,
              images: {
                take: 1,
                orderBy: { sortOrder: "asc" as const },
              },
            },
          },
          images: {
            take: 1,
            orderBy: { sortOrder: "asc" as const },
          },
          attributes: {
            include: {
              attributeValue: { include: { attribute: true } },
            },
          },
        },
      },
    },
  },
  courierOrder: {
    include: {
      courier_tracking_history: {
        orderBy: { timestamp: "desc" as const },
      },
      courier_providers: {
        select: { name: true, displayName: true, logo: true },
      },
    },
  },
  vendor: {
    select: { storeName: true, pickupAddress: true },
  },
} as const;

// ─────────────────────────────────────────────
// VENDOR ORDER SERVICE
// ─────────────────────────────────────────────

export const VendorOrderService = {
  // =====================================================
  // LISTING & DETAILS
  // =====================================================

  /**
   * Get all VendorOrders for this vendor with filters + pagination
   */
  async getAll(vendorId: string, filters: VendorOrderFilters) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 10;
    const skip = (page - 1) * limit;

    const where: any = { vendorId };

    if (filters.status) where.status = filters.status;
    if (filters.fulfillmentStatus) where.fulfillmentStatus = filters.fulfillmentStatus;

    if (filters.fromDate || filters.toDate) {
      where.createdAt = {};
      if (filters.fromDate) where.createdAt.gte = new Date(filters.fromDate);
      if (filters.toDate) where.createdAt.lte = new Date(filters.toDate);
    }

    if (filters.search) {
      where.OR = [
        { order: { orderNumber: { contains: filters.search, mode: "insensitive" } } },
        { order: { user: { name: { contains: filters.search, mode: "insensitive" } } } },
        { order: { address: { receiverFullName: { contains: filters.search, mode: "insensitive" } } } },
      ];
    }

    const [vendorOrders, total] = await Promise.all([
      prisma.vendorOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: vendorOrderListInclude,
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

  /**
   * Get a single VendorOrder — verifies ownership
   */
  async getById(vendorOrderId: string, vendorId: string) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      include: vendorOrderDetailInclude,
    });

    if (!vendorOrder) return null;
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");

    return vendorOrder;
  },

  /**
   * Get order items for a vendor order
   */
  async getOrderItems(vendorOrderId: string, vendorId: string) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      select: {
        vendorId: true,
        items: {
          include: {
            variant: {
              include: {
                product: {
                  select: { id: true, name: true, slug: true },
                },
                images: {
                  take: 1,
                  orderBy: { sortOrder: "asc" },
                },
                attributes: {
                  include: {
                    attributeValue: { include: { attribute: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");

    return vendorOrder.items;
  },

  // =====================================================
  // STATISTICS & REVENUE
  // =====================================================

  /**
   * Get vendor order statistics
   */
  async getStatistics(vendorId: string) {
    const [
      total,
      pending,
      confirmed,
      processing,
      packaging,
      shipped,
      delivered,
      cancelled,
      returned,
      revenueResult,
      pendingCodCount,
    ] = await Promise.all([
      prisma.vendorOrder.count({ where: { vendorId } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "PENDING" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "CONFIRMED" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "PROCESSING" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "PACKAGING" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "SHIPPED" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "DELIVERED" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "CANCELLED" } }),
      prisma.vendorOrder.count({ where: { vendorId, status: "RETURNED" } }),
      prisma.vendorOrder.aggregate({
        where: { vendorId, status: "DELIVERED" },
        _sum: { subtotal: true },
      }),
      // COD orders still in PENDING that need phone confirmation
      prisma.vendorOrder.count({
        where: {
          vendorId,
          status: "PENDING",
          order: { paymentStatus: "PENDING" },
        },
      }),
    ]);

    // Today's stats
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [todayOrders, todayRevenue] = await Promise.all([
      prisma.vendorOrder.count({
        where: { vendorId, createdAt: { gte: todayStart } },
      }),
      prisma.vendorOrder.aggregate({
        where: {
          vendorId,
          status: "DELIVERED",
          deliveredAt: { gte: todayStart },
        },
        _sum: { subtotal: true },
      }),
    ]);

    return {
      total,
      byStatus: {
        pending,
        confirmed,
        processing,
        packaging,
        shipped,
        delivered,
        cancelled,
        returned,
      },
      pendingCodConfirmations: pendingCodCount,
      totalRevenue: revenueResult._sum.subtotal ?? 0,
      today: {
        orders: todayOrders,
        revenue: todayRevenue._sum.subtotal ?? 0,
      },
    };
  },

  /**
   * Get revenue breakdown by period
   */
  async getRevenue(vendorId: string, period: "daily" | "weekly" | "monthly") {
    const now = new Date();
    let fromDate: Date;

    if (period === "daily") {
      fromDate = new Date(now);
      fromDate.setDate(now.getDate() - 30); // last 30 days
    } else if (period === "weekly") {
      fromDate = new Date(now);
      fromDate.setDate(now.getDate() - 12 * 7); // last 12 weeks
    } else {
      fromDate = new Date(now);
      fromDate.setMonth(now.getMonth() - 12); // last 12 months
    }

    const vendorOrders = await prisma.vendorOrder.findMany({
      where: {
        vendorId,
        status: "DELIVERED",
        deliveredAt: { gte: fromDate },
      },
      select: {
        subtotal: true,
        deliveredAt: true,
      },
      orderBy: { deliveredAt: "asc" },
    });

    // Group by period
    const grouped: Record<string, { revenue: number; orders: number }> = {};

    for (const vo of vendorOrders) {
      if (!vo.deliveredAt) continue;
      let key: string;

      if (period === "daily") {
        key = vo.deliveredAt.toISOString().split("T")[0]; // YYYY-MM-DD
      } else if (period === "weekly") {
        const d = new Date(vo.deliveredAt);
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        key = weekStart.toISOString().split("T")[0];
      } else {
        key = `${vo.deliveredAt.getFullYear()}-${String(vo.deliveredAt.getMonth() + 1).padStart(2, "0")}`;
      }

      if (!grouped[key]) grouped[key] = { revenue: 0, orders: 0 };
      grouped[key].revenue += vo.subtotal;
      grouped[key].orders += 1;
    }

    return Object.entries(grouped).map(([date, data]) => ({
      date,
      ...data,
    }));
  },

  // =====================================================
  // STATUS MANAGEMENT
  // =====================================================

  /**
   * Update VendorOrder status.
   * Vendor-allowed transitions only: CONFIRMED → PROCESSING → PACKAGING
   */
  async updateStatus(
    vendorOrderId: string,
    vendorId: string,
    newStatus: "PROCESSING" | "PACKAGING"
  ) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      select: { vendorId: true, status: true, orderId: true },
    });

    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");

    const allowedTransitions: Record<string, string[]> = {
      CONFIRMED: ["PROCESSING"],
      PROCESSING: ["PACKAGING"],
    };

    const allowed = allowedTransitions[vendorOrder.status] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Cannot transition from ${vendorOrder.status} to ${newStatus}. ` +
        `Allowed next statuses: ${allowed.join(", ") || "none"}`
      );
    }

    const updated = await prisma.vendorOrder.update({
      where: { id: vendorOrderId },
      data: { status: newStatus },
      include: vendorOrderListInclude,
    });

    // Notify admin
    await prisma.notification.create({
      data: {
        type: "ORDER",
        title: `Order ${newStatus}`,
        message: `Vendor order ${vendorOrderId} moved to ${newStatus}.`,
        targetType: "EMPLOYEE",
        targetId: vendorId, // will be routed to admin in a real system
        orderId: vendorOrder.orderId,
      },
    });

    return updated;
  },

  /**
   * Mark order for delivery.
   * - Validates PACKAGING status
   * - Creates CourierOrder record
   * - Generates shipping label reference
   * - Updates VendorOrder → SHIPPED + links courierOrderId
   */
  async markForDelivery(
    vendorOrderId: string,
    vendorId: string,
    warehouseId: string,
    specialInstruction?: string
  ) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      include: {
        order: {
          include: {
            address: { include: { location: true } },
            user: { select: { name: true, phone: true } },
          },
        },
        items: {
          include: {
            variant: {
              include: {
                product: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");
    if (vendorOrder.status !== "PACKAGING") {
      throw new Error(
        `Order must be in PACKAGING status before marking for delivery. Current: ${vendorOrder.status}`
      );
    }
    if (vendorOrder.courierOrderId) {
      throw new Error("A courier order has already been created for this vendor order");
    }

    // Validate warehouse belongs to vendor
    const warehouse = await prisma.vendorWarehouse.findUnique({
      where: { id: warehouseId, vendorId },
      include: { location: true },
    });
    if (!warehouse) {
      throw new Error("Warehouse not found or does not belong to this vendor");
    }

    // Get active courier credential for this vendor
    const courierCredential = await prisma.courierCredential.findFirst({
      where: { vendorId, isActive: true },
      include: { courier_providers: true },
    });
    if (!courierCredential) {
      throw new Error(
        "No active courier credential configured. Please set up a courier provider first."
      );
    }

    const orderAddress = vendorOrder.order.address;
    if (!orderAddress) throw new Error("Order has no delivery address");

    // Calculate package details from items
    const totalWeight = vendorOrder.items.reduce(
      (sum, item) => sum + 0.5 * item.quantity,
      0
    );
    const totalQty = vendorOrder.items.reduce(
      (sum, item) => sum + item.quantity,
      0
    );
    const itemDesc = vendorOrder.items
      .map((i) => `${i.variant.product.name} x${i.quantity}`)
      .join(", ");

    // COD amount only if payment is still PENDING (COD order)
    const isCod = vendorOrder.order.paymentStatus === "PENDING";
    const codAmount = isCod ? vendorOrder.subtotal + vendorOrder.shippingCost : 0;
    const codCharge = isCod ? parseFloat((codAmount * 0.01).toFixed(2)) : 0;
    const totalCharge = vendorOrder.shippingCost + codCharge;

    const result = await prisma.$transaction(async (tx) => {
      // Create the CourierOrder record
      // NOTE: Actual external courier API call (Pathao / Steadfast etc.) should be
      // triggered here or in a post-transaction job. The record is created first
      // so the system has a reference even if the external call fails.
      const courierOrder = await tx.courierOrder.create({
        data: {
          // orderId is Int in schema — store hash of cuid as numeric ref
          orderId: Math.abs(
            vendorOrder.orderId
              .split("")
              .reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
          ),
          courierProviderId: courierCredential.courierProviderId,
          vendorId,
          recipientName: orderAddress.receiverFullName,
          recipientPhone: orderAddress.phone,
          recipientAddress: orderAddress.address,
          deliveryLocationId: orderAddress.locationId,
          itemType: "parcel",
          deliveryType: "STANDARD",
          itemWeight: totalWeight,
          itemQuantity: totalQty,
          itemDescription: itemDesc,
          specialInstruction: specialInstruction ?? null,
          codAmount,
          codCharge,
          deliveryCharge: vendorOrder.shippingCost,
          totalCharge,
          status: "PENDING_PICKUP",
        },
      });

      // Link CourierOrder to VendorOrder and advance status
      const updatedVendorOrder = await tx.vendorOrder.update({
        where: { id: vendorOrderId },
        data: {
          courierOrderId: courierOrder.id,
          status: "SHIPPED",
          shippedAt: new Date(),
          fulfillmentStatus: "SHIPPED",
        },
        include: vendorOrderDetailInclude,
      });

      // First tracking history entry
      await tx.courierTrackingHistory.create({
        data: {
          courierOrderId: courierOrder.id,
          status: "PENDING_PICKUP",
          courierStatus: "PENDING_PICKUP",
          messageEn: "Order is ready for courier pickup. Shipping label generated.",
          timestamp: new Date(),
        },
      });

      return { courierOrder, vendorOrder: updatedVendorOrder };
    });

    // Notify vendor to print label
    await prisma.notification.create({
      data: {
        type: "COURIER",
        title: "Courier Pickup Requested",
        message:
          "Your shipping label is ready. Please print it and attach to the package before handing over to the courier.",
        targetType: "VENDOR",
        targetId: vendorId,
        orderId: vendorOrder.orderId,
        courierOrderId: result.courierOrder.id,
        actionUrl: `/vendor/orders/${vendorOrderId}/shipping-label`,
      },
    });

    return {
      vendorOrder: result.vendorOrder,
      courierOrder: result.courierOrder,
      shippingLabelUrl: `/api/vendor-orders/${vendorOrderId}/shipping-label`,
    };
  },

  /**
   * Confirm a COD order (vendor calls customer to verify before processing)
   * Flips VendorOrder PENDING → CONFIRMED
   * If all vendor orders for this master order are confirmed, master Order → CONFIRMED
   */
  async confirmCodOrder(
    vendorOrderId: string,
    vendorId: string,
    confirmedByName: string,
    note?: string
  ) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            paymentStatus: true,
            status: true,
            userId: true,
          },
        },
      },
    });

    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");
    if (vendorOrder.order.paymentStatus !== "PENDING") {
      throw new Error("This order is not a COD order");
    }
    if (vendorOrder.status !== "PENDING") {
      throw new Error(
        `Order is not in PENDING status. Current: ${vendorOrder.status}`
      );
    }

    await prisma.$transaction(async (tx) => {
      // Confirm this vendor order
      await tx.vendorOrder.update({
        where: { id: vendorOrderId },
        data: { status: "CONFIRMED" },
      });

      // Check if ALL vendor orders for the master order are now confirmed
      const sibling = await tx.vendorOrder.findMany({
        where: { orderId: vendorOrder.orderId },
        select: { id: true, status: true },
      });

      const allConfirmed = sibling.every(
        (vo) => vo.id === vendorOrderId || vo.status !== "PENDING"
      );

      if (allConfirmed) {
        await tx.order.update({
          where: { id: vendorOrder.orderId },
          data: { status: "CONFIRMED", confirmedAt: new Date() },
        });
      }

      // Audit trail
      await tx.activityLog.create({
        data: {
          action: "COD_ORDER_CONFIRMED_BY_VENDOR",
          entity: "VendorOrder",
          entityId: vendorOrderId,
          meta: { confirmedByName, note, vendorId },
        },
      });
    });

    // Notify customer
    if (vendorOrder.order.userId) {
      await prisma.notification.create({
        data: {
          type: "ORDER",
          title: "Order Confirmed",
          message: `Your order ${vendorOrder.order.orderNumber} has been confirmed.`,
          targetType: "USER",
          targetId: vendorOrder.order.userId,
          orderId: vendorOrder.orderId,
          actionUrl: `/orders/${vendorOrder.orderId}`,
        },
      });
    }

    return { success: true };
  },

  // =====================================================
  // SHIPPING & COURIER
  // =====================================================

  /**
   * Get shipping label data for a vendor order
   * Only available after mark-for-delivery (courierOrder must exist)
   */
  async getShippingLabel(vendorOrderId: string, vendorId: string) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      include: {
        courierOrder: {
          include: {
            courier_providers: {
              select: { name: true, displayName: true, logo: true },
            },
          },
        },
        order: {
          include: {
            address: {
              include: { location: true },
            },
            user: { select: { name: true, phone: true } },
          },
        },
        vendor: {
          select: {
            storeName: true,
            pickupAddress: true,
          },
        },
        items: {
          include: {
            variant: {
              include: {
                product: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");
    if (!vendorOrder.courierOrder) {
      throw new Error(
        "Shipping label is not yet available. Please mark the order for delivery first."
      );
    }

    return vendorOrder;
  },

  /**
   * Get courier tracking history for a vendor order
   */
  async getTracking(vendorOrderId: string, vendorId: string) {
    const vendorOrder = await prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      select: {
        vendorId: true,
        status: true,
        fulfillmentStatus: true,
        shippedAt: true,
        deliveredAt: true,
        courierOrder: {
          select: {
            id: true,
            courierTrackingId: true,
            courierOrderId: true,
            status: true,
            lastStatusUpdate: true,
            courier_providers: {
              select: { name: true, displayName: true },
            },
            courier_tracking_history: {
              orderBy: { timestamp: "desc" },
              select: {
                id: true,
                status: true,
                courierStatus: true,
                messageEn: true,
                messageBn: true,
                location: true,
                timestamp: true,
              },
            },
          },
        },
      },
    });

    if (!vendorOrder) throw new Error("Vendor order not found");
    if (vendorOrder.vendorId !== vendorId) throw new Error("Unauthorized");
    if (!vendorOrder.courierOrder) {
      throw new Error("No courier assigned yet for this order");
    }

    return vendorOrder;
  },
};