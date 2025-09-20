// services/customerService.ts
// services/customerService.ts
import type {  CustomerFilter, ExportOptions, ComplaintStatus, ComplaintPriority,WalletTransactionType,LoyaltyTransactionType } from '@/types/customer.types.ts';
import pkg from '@prisma/client';
import type { CustomerProfile } from '@/types/customer.types.ts';

const { PrismaClient, UserRole} = pkg;

const prisma = new PrismaClient();



export class CustomerService {
  // Get all customers with filtering and pagination
 async getCustomers(filters: CustomerFilter) {
  const {
    status = 'all',
    search,
    minWallet,
    maxWallet,
    minLoyalty,
    maxLoyalty,
    startDate,
    endDate,
    page = 1,
    limit = 10,
    sortBy = 'createdAt',
    sortOrder = 'desc'
  } = filters;

  const skip = (page - 1) * limit;

  const customerProfileFilter: any = {};
  if (minWallet !== undefined || maxWallet !== undefined) {
    customerProfileFilter.wallet = {
      ...(minWallet !== undefined && { gte: minWallet }),
      ...(maxWallet !== undefined && { lte: maxWallet })
    };
  }
  if (minLoyalty !== undefined || maxLoyalty !== undefined) {
    customerProfileFilter.loyaltyPoints = {
      ...(minLoyalty !== undefined && { gte: minLoyalty }),
      ...(maxLoyalty !== undefined && { lte: maxLoyalty })
    };
  }

  const where: any = {
    role: UserRole.CUSTOMER,
    ...(status !== 'all' && {
      isActive: status === 'active' ? true : false,
      isBlocked: status === 'blocked' ? true : false
    }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } }
      ]
    }),
    ...(Object.keys(customerProfileFilter).length > 0 && { customerProfile: customerProfileFilter }),
    ...((startDate || endDate) && {
      createdAt: {
        ...(startDate && { gte: startDate }),
        ...(endDate && { lte: endDate })
      }
    })
  };

  const [customers, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: {
        customerProfile: true,
        _count: {
          select: {
            reviews: true,
            supportTickets: true
          }
        }
      },
      orderBy: { [sortBy]: sortOrder },
      skip,
      take: limit
    }),
    prisma.user.count({ where })
  ]);

  return {
    data: customers,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    }
  };
}


  // Get customer by ID
  async getCustomerById(id: string) {
    return prisma.user.findUnique({
      where: { id, role: UserRole.CUSTOMER },
      include: {
        customerProfile: true,
        reviews: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                slug: true
              }
            }
          }
        },
        supportTickets: {
          include: {
            messages: true
          }
        },
        walletTransactions: true,
        loyaltyTransactions: true
      }
    });
  }

  // Block/unblock customer
async toggleCustomerBlock(id: string, block: boolean, reason?: string) {
  console.log(block)
  return prisma.user.update({
    where: { id, role: UserRole.CUSTOMER },
    data: {
      isActive: block, // block=true → inactive, block=false → active
      activityLogs: {
        create: {
          action: block ? "ACCOUNT_BLOCKED" : "ACCOUNT_UNBLOCKED",
          entity: "USER",
          entityId: id,
          meta: { reason },
        },
      },
      updatedAt: new Date(),
    },
  });
}


  // Update customer profile
  async updateCustomerProfile(id: string, data: Partial<CustomerProfile>) {
    return prisma.customerProfile.update({
      where: { userId: id },
      data: {
        ...data,
        updatedAt: new Date()
      }
    });
  }

  // Get customer reviews
  async getCustomerReviews(userId: string, filters: {
    status?: 'approved' | 'flagged' | 'pending';
    page?: number;
    limit?: number;
  }) {
    const { status = 'all', page = 1, limit = 10 } = filters;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (status !== 'all') {
      if (status === 'approved') where.isApproved = true;
      if (status === 'flagged') where.isFlagged = true;
      if (status === 'pending') where.isApproved = false;
    }

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        include: {
          product: {
            select: {
              id: true,
              name: true,
              slug: true
            }
          },
          user: {
            select: {
              id: true,
              name: true,
              email: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.review.count({ where })
    ]);

    return {
      data: reviews,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    };
  }

  // Moderate review
  async moderateReview(reviewId: string, action: 'approve' | 'reject' | 'flag', reason?: string) {
    const data: any = {};
    if (action === 'approve') {
      data.isApproved = true;
      data.isFlagged = false;
    } else if (action === 'reject') {
      data.isApproved = false;
      data.isFlagged = false;
    } else if (action === 'flag') {
      data.isFlagged = true;
      data.flaggedReason = reason;
    }

    return prisma.review.update({
      where: { id: reviewId },
      data: {
        ...data,
        updatedAt: new Date()
      }
    });
  }

  // Get complaints
  async getComplaints(filters: {
    status?: ComplaintStatus;
    priority?: ComplaintPriority;
    userId?: string;
    page?: number;
    limit?: number;
  }) {
    const { status, priority, userId, page = 1, limit = 10 } = filters;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (userId) where.userId = userId;

    const [complaints, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true
            }
          },
          messages: {
            orderBy: { createdAt: 'asc' }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.supportTicket.count({ where })
    ]);

    return {
      data: complaints,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    };
  }

  // Update complaint status
  async updateComplaintStatus(complaintId: string, status: ComplaintStatus, assignedTo?: string) {
    return prisma.supportTicket.update({
      where: { id: complaintId },
      data: {
        status,
        ...(assignedTo && { assignedTo }),
        updatedAt: new Date()
      }
    });
  }

  // Add message to complaint
  async addComplaintMessage(complaintId: string, senderId: string, content: string, isInternal: boolean = false) {
    return prisma.ticketMessage.create({
      data: {
        ticketId: complaintId,
        senderId,
        content,
        isInternal
      }
    });
  }

  // Get wallet transactions
  async getWalletTransactions(userId: string, filters: {
    type?: WalletTransactionType;
    page?: number;
    limit?: number;
  }) {
    const { type, page = 1, limit = 10 } = filters;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (type) where.type = type;

    const [transactions, total] = await Promise.all([
      prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.walletTransaction.count({ where })
    ]);

    return {
      data: transactions,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    };
  }

  // Get loyalty transactions
  async getLoyaltyTransactions(userId: string, filters: {
    type?: LoyaltyTransactionType;
    page?: number;
    limit?: number;
  }) {
    const { type, page = 1, limit = 10 } = filters;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (type) where.type = type;

    const [transactions, total] = await Promise.all([
      prisma.loyaltyTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.loyaltyTransaction.count({ where })
    ]);

    return {
      data: transactions,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    };
  }

  // Adjust wallet balance
  async adjustWalletBalance(userId: string, amount: number, description: string, type: WalletTransactionType) {
    return prisma.$transaction(async (tx) => {
      // Update customer profile
      const profile = await tx.customerProfile.update({
        where: { userId },
        data: {
          wallet: {
            increment: type === 'CREDIT' || type === 'REFUND' ? amount : -amount
          }
        }
      });

      // Create transaction record
      const transaction = await tx.walletTransaction.create({
        data: {
          userId,
          amount,
          type,
          description
        }
      });

      return { profile, transaction };
    });
  }

  // Adjust loyalty points
  async adjustLoyaltyPoints(userId: string, points: number, description: string, type: LoyaltyTransactionType) {
    return prisma.$transaction(async (tx) => {
      // Update customer profile
      const profile = await tx.customerProfile.update({
        where: { userId },
        data: {
          loyaltyPoints: {
            increment: type === 'EARNED' ? points : -points
          }
        }
      });

      // Create transaction record
      const transaction = await tx.loyaltyTransaction.create({
        data: {
          userId,
          points,
          type,
          description
        }
      });

      return { profile, transaction };
    });
  }

  // Export customers
  async exportCustomers(options: ExportOptions) {
    const { format, fields, filters } = options;
    const customers = await this.getCustomers({ ...filters, limit: 10000 });

    // Transform data based on selected fields
    const data = customers.data.map(customer => {
      const result: any = {};
      fields.forEach(field => {
        if (field.includes('.')) {
          // Handle nested fields like 'profile.wallet'
          const [parent, child] = field.split('.');
          result[field] = customer[parent]?.[child];
        } else {
          result[field] = customer[field];
        }
      });
      return result;
    });

    return { data, format };
  }
}