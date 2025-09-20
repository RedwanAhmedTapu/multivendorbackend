// services/vendor.service.ts
import {
  PrismaClient,
  Prisma,
  VendorStatus,
  PayoutStatus,
  OrderStatus,
} from "@prisma/client";
import bcrypt from "bcryptjs";
import type {
  CreateVendorRequest,
  UpdateVendorProfileRequest,
  VendorCommissionRequest,
  VendorPayoutRequest,
  VendorMonthlyChargeRequest,
  VendorOfferRequest,
  VendorFlagRequest,
  VendorFilterQuery,
  VendorWithDetails,
  VendorPerformanceMetrics,
  PayoutSummary,
  FraudDetectionResult,
  BulkCommissionUpdateRequest,
  BulkMonthlyChargeRequest,
  VendorExportOptions,
} from "@/types/vendor.types.ts";

const prisma = new PrismaClient();

export class VendorService {
  // Vendor CRUD Operations
  async createVendor(data: CreateVendorRequest) {
    const hashedPassword = await bcrypt.hash(data.password, 10);

    return await prisma.$transaction(async (tx) => {
      // Create user first
      const user = await tx.user.create({
        data: {
          email: data.email,
          phone: data.phone,
          password: hashedPassword,
          role: "VENDOR",
        },
      });

      // Create vendor
      const vendor = await tx.vendor.create({
        data: {
          storeName: data.storeName,
          avatar: data.avatar,
          user: {
            connect: { id: user.id },
          },
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              isActive: true,
              isVerified: true,
            },
          },
        },
      });

      // Initialize performance record
      await tx.vendorPerformance.create({
        data: {
          vendorId: vendor.id,
        },
      });

      return vendor;
    });
  }

  async getVendorById(id: string): Promise<VendorWithDetails | null> {
    return await prisma.vendor.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            isActive: true,
            isVerified: true,
          },
        },
        performance: true,
        _count: {
          select: {
            products: true,
            orders: true,
            flags: true,
          },
        },
      },
    });
  }

  async getVendors(filters: VendorFilterQuery) {
    const {
      status,
      search,
      commissionMin,
      commissionMax,
      createdFrom,
      createdTo,
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = filters;

    const skip = (page - 1) * limit;

    const where: Prisma.VendorWhereInput = {
      ...(status && { status }),
      ...(search && {
        OR: [
          { storeName: { contains: search, mode: "insensitive" } },
          { user: { email: { contains: search, mode: "insensitive" } } },
        ],
      }),
      ...(commissionMin !== undefined && {
        currentCommissionRate: { gte: commissionMin },
      }),
      ...(commissionMax !== undefined && {
        currentCommissionRate: { lte: commissionMax },
      }),
      ...(createdFrom && { createdAt: { gte: createdFrom } }),
      ...(createdTo && { createdAt: { lte: createdTo } }),
    };

    const [vendors, total] = await Promise.all([
      prisma.vendor.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              isActive: true,
              isVerified: true,
            },
          },
          performance: true,
          _count: {
            select: {
              products: true,
              orders: true,
              flags: true,
            },
          },
        },
      }),
      prisma.vendor.count({ where }),
    ]);

    return {
      data: vendors,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async updateVendorProfile(id: string, data: UpdateVendorProfileRequest) {
    return await prisma.vendor.update({
      where: { id },
      data,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            isActive: true,
            isVerified: true,
          },
        },
      },
    });
  }

  async updateVendorStatus(id: string, status: VendorStatus) {
    return await prisma.vendor.update({
      where: { id },
      data: { status },
    });
  }

  async deleteVendor(id: string) {
    return await prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.findUnique({
        where: { id },
        include: { user: true },
      });

      if (!vendor) {
        throw new Error("Vendor not found");
      }

      await tx.vendor.delete({
        where: { id },
      });

      if (vendor.user) {
        await tx.user.delete({
          where: { id: vendor.user.id },
        });
      }

      return { message: "Vendor deleted successfully" };
    });
  }

  // Commission Management
  async setCommissionRate(vendorId: string, data: VendorCommissionRequest) {
    return await prisma.$transaction(async (tx) => {
      // Create commission record
      await tx.vendorCommission.create({
        data: {
          vendorId,
          rate: data.rate,
          note: data.note,
          effectiveFrom: data.effectiveFrom || new Date(),
          effectiveTo: data.effectiveTo,
        },
      });

      // Update current rate in vendor table
      return await tx.vendor.update({
        where: { id: vendorId },
        data: { currentCommissionRate: data.rate },
      });
    });
  }

  async getCommissionHistory(vendorId: string) {
    return await prisma.vendorCommission.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
    });
  }

  async bulkUpdateCommissions(data: BulkCommissionUpdateRequest) {
    return await prisma.$transaction(async (tx) => {
      // Create commission records for all vendors
      const commissionPromises = data.vendorIds.map((vendorId) =>
        tx.vendorCommission.create({
          data: {
            vendorId,
            rate: data.rate,
            note: data.note,
            effectiveFrom: data.effectiveFrom || new Date(),
          },
        })
      );

      await Promise.all(commissionPromises);

      // Update current rates
      await tx.vendor.updateMany({
        where: { id: { in: data.vendorIds } },
        data: { currentCommissionRate: data.rate },
      });

      return { updated: data.vendorIds.length };
    });
  }

  // Payout Management
  async createPayout(vendorId: string, data: VendorPayoutRequest) {
    return await prisma.vendorPayout.create({
      data: {
        vendorId,
        amount: data.amount,
        method: data.method,
        period: data.period,
        note: data.note,
      },
      include: {
        vendor: {
          select: {
            storeName: true,
          },
        },
      },
    });
  }

  async updatePayoutStatus(id: string, status: PayoutStatus, paidAt?: Date) {
    return await prisma.vendorPayout.update({
      where: { id },
      data: {
        status,
        ...(status === "PAID" && { paidAt: paidAt || new Date() }),
      },
    });
  }

  async getVendorPayouts(vendorId: string) {
    return await prisma.vendorPayout.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
    });
  }

  async getPayoutSummary(vendorId: string): Promise<PayoutSummary> {
    const payouts = await prisma.vendorPayout.groupBy({
      by: ["status"],
      where: { vendorId },
      _sum: { amount: true },
    });

    const lastPayout = await prisma.vendorPayout.findFirst({
      where: { vendorId, status: "PAID" },
      orderBy: { paidAt: "desc" },
    });

    // Calculate current balance from orders
    const orderSummary = await prisma.order.aggregate({
      where: { vendorId, status: "DELIVERED" },
      _sum: { totalAmount: true },
    });

    const totalRevenue = orderSummary._sum.totalAmount || 0;
    const totalPaid =
      payouts.find((p) => p.status === "PAID")?._sum.amount || 0;

    return {
      vendorId,
      totalPending:
        payouts.find((p) => p.status === "PENDING")?._sum.amount || 0,
      totalPaid,
      totalFailed: payouts.find((p) => p.status === "FAILED")?._sum.amount || 0,
      lastPayoutDate: lastPayout?.paidAt ?? undefined,
      currentBalance: totalRevenue - totalPaid,
    };
  }

  // Monthly Charges
  async setMonthlyCharge(vendorId: string, data: VendorMonthlyChargeRequest) {
    return await prisma.vendorMonthlyCharge.create({
      data: {
        vendorId,
        amount: data.amount,
        description: data.description,
        effectiveFrom: data.effectiveFrom || new Date(),
        effectiveTo: data.effectiveTo,
      },
    });
  }

  async bulkSetMonthlyCharges(data: BulkMonthlyChargeRequest) {
    const charges = data.vendorIds.map((vendorId) => ({
      vendorId,
      amount: data.amount,
      description: data.description,
      effectiveFrom: data.effectiveFrom || new Date(),
    }));

    return await prisma.vendorMonthlyCharge.createMany({
      data: charges,
    });
  }

  async getVendorCharges(vendorId: string) {
    return await prisma.vendorMonthlyCharge.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
    });
  }

  // Promotional Offers
  async createOffer(vendorId: string, data: VendorOfferRequest) {
    return await prisma.vendorOffer.create({
      data: {
        vendorId,
        title: data.title,
        details: data.details,
        validFrom: data.validFrom,
        validTo: data.validTo,
      },
    });
  }

  async getVendorOffers(vendorId: string) {
    return await prisma.vendorOffer.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
    });
  }

  async toggleOfferStatus(id: string, isActive: boolean) {
    return await prisma.vendorOffer.update({
      where: { id },
      data: { isActive },
    });
  }

  // Performance Monitoring
  async getVendorPerformance(
    vendorId: string
  ): Promise<VendorPerformanceMetrics | null> {
    const performance = await prisma.vendorPerformance.findUnique({
      where: { vendorId },
    });

    if (!performance) return null;

    // Get additional metrics
    const orders = await prisma.order.groupBy({
      by: ["status"],
      where: { vendorId },
      _count: true,
    });

    const completedOrders =
      orders.find((o) => o.status === "DELIVERED")?._count || 0;
    const cancelledOrders =
      orders.find((o) => o.status === "CANCELLED")?._count || 0;
    const returnedOrders =
      orders.find((o) => o.status === "RETURNED")?._count || 0;

    return {
      vendorId,
      totalSales: performance.totalSales,
      totalOrders: performance.totalOrders,
      fulfillmentRatePct: performance.fulfillmentRatePct,
      avgRating: performance.avgRating,
      monthlyGrowth: 0, // Calculate based on requirements
      completedOrders,
      cancelledOrders,
      returnedOrders,
    };
  }

  async updateVendorPerformance(vendorId: string) {
    const [orderStats, avgRating] = await Promise.all([
      prisma.order.aggregate({
        where: { vendorId },
        _sum: { totalAmount: true },
        _count: true,
      }),
      prisma.review.aggregate({
        where: { product: { vendorId } },
        _avg: { rating: true },
      }),
    ]);

    const deliveredOrders = await prisma.order.count({
      where: { vendorId, status: "DELIVERED" },
    });

    const fulfillmentRate =
      orderStats._count > 0 ? (deliveredOrders / orderStats._count) * 100 : 100;

    return await prisma.vendorPerformance.upsert({
      where: { vendorId },
      update: {
        totalSales: orderStats._sum.totalAmount || 0,
        totalOrders: orderStats._count,
        fulfillmentRatePct: fulfillmentRate,
        avgRating: avgRating._avg.rating || 0,
        lastCalculatedAt: new Date(),
      },
      create: {
        vendorId,
        totalSales: orderStats._sum.totalAmount || 0,
        totalOrders: orderStats._count,
        fulfillmentRatePct: fulfillmentRate,
        avgRating: avgRating._avg.rating || 0,
        lastCalculatedAt: new Date(),
      },
    });
  }

  // Fraud Detection
  async detectFraud(vendorId: string): Promise<FraudDetectionResult> {
    const [orders, vendor] = await Promise.all([
      prisma.order.findMany({
        where: { vendorId },
        include: { items: { include: { variant: true } } },
      }),
      this.getVendorPerformance(vendorId),
    ]);

    const totalOrders = orders.length;
    const cancelledOrders = orders.filter(
      (o) => o.status === "CANCELLED"
    ).length;
    const declineRate =
      totalOrders > 0 ? (cancelledOrders / totalOrders) * 100 : 0;

    // Analyze pricing patterns
    const prices = orders.flatMap((o) => o.items.map((i) => i.price));
    const avgPrice =
      prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
    const maxPrice = Math.max(...prices, 0);
    const priceVariation =
      avgPrice > 0 ? ((maxPrice - avgPrice) / avgPrice) * 100 : 0;

    const flags = {
      excessiveOrderDeclines: declineRate > 20,
      suspiciousPricing: priceVariation > 200,
      unusualOrderPatterns: false, // Implement based on requirements
      lowFulfillmentRate: (vendor?.fulfillmentRatePct || 100) < 80,
    };

    let riskScore = 0;
    const recommendations: string[] = [];

    if (flags.excessiveOrderDeclines) {
      riskScore += 25;
      recommendations.push("High order decline rate detected");
    }
    if (flags.suspiciousPricing) {
      riskScore += 30;
      recommendations.push("Suspicious pricing patterns detected");
    }
    if (flags.lowFulfillmentRate) {
      riskScore += 20;
      recommendations.push("Low order fulfillment rate");
    }

    return {
      vendorId,
      riskScore,
      flags,
      recommendations,
    };
  }

  // Flag Management
  async flagVendor(vendorId: string, data: VendorFlagRequest) {
    return await prisma.vendorFlag.create({
      data: {
        vendorId,
        reason: data.reason,
        severity: data.severity,
        meta: data.meta,
      },
    });
  }

  async getVendorFlags(vendorId: string) {
    return await prisma.vendorFlag.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
    });
  }

  // Chat/Conversation Management
  async getVendorConversations(vendorId?: string, userId?: string) {
    return await prisma.vendorConversation.findMany({
      where: {
        ...(vendorId && { vendorId }),
        ...(userId && { userId }),
      },
      include: {
        vendor: {
          select: {
            storeName: true,
            avatar: true,
          },
        },
        user: {
          select: {
            name: true,
            email: true,
          },
        },
        _count: {
          select: {
            messages: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  async getConversationMessages(conversationId: string) {
    return await prisma.vendorConversationMessage.findMany({
      where: { conversationId },
      include: {
        sender: {
          select: {
            name: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async sendMessage(
    conversationId: string,
    senderId: string,
    content: string,
    metadata?: any
  ) {
    return await prisma.$transaction(async (tx) => {
      const message = await tx.vendorConversationMessage.create({
        data: {
          conversationId,
          senderId,
          content,
          metadata,
        },
        include: {
          sender: {
            select: {
              name: true,
              role: true,
            },
          },
        },
      });

      // Update conversation timestamp
      await tx.vendorConversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });

      return message;
    });
  }

  // Export functionality
  async exportVendors(options: VendorExportOptions) {
    const vendors = await this.getVendors(options.filters || {});

    // Transform data based on selected fields
    const exportData = vendors.data.map((vendor) => {
      const row: any = {};

      if (options.fields.includes("storeName"))
        row.storeName = vendor.storeName;
      if (options.fields.includes("email")) row.email = vendor.user?.email;
      if (options.fields.includes("phone")) row.phone = vendor.user?.phone;
      if (options.fields.includes("status")) row.status = vendor.status;
      if (options.fields.includes("commissionRate"))
        row.commissionRate = vendor.currentCommissionRate;
      if (options.fields.includes("totalSales"))
        row.totalSales = vendor.performance?.totalSales;
      if (options.fields.includes("totalOrders"))
        row.totalOrders = vendor.performance?.totalOrders;
      if (options.fields.includes("createdAt"))
        row.createdAt = vendor.createdAt;

      return row;
    });

    return exportData;
  }
}
