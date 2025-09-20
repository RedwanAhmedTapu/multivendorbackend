// services/delivery.service.ts
import { PrismaClient } from '@prisma/client';
import type { 
  CreateDeliveryPersonRequest,
  UpdateDeliveryPersonRequest,
  DeliveryPersonFilterQuery,
  DeliveryPayoutRequest,
  DeliveryComplaintRequest,
  DeliveryPromotionalOfferRequest,
  DeliveryRatingRequest,
  FundCollectionRequest,
  BulkDeliveryActionRequest,
  DeliveryExportOptions,
  DeliveryPerformanceMetrics,
  FundCollectionSummary,
  DeliveryAnalytics
} from '@/types/delivery.types.ts';

const prisma = new PrismaClient();

export class DeliveryService {
  
  // RATINGS AND REVIEWS
  // ================================

  async getDeliveryPersonRatings(deliveryPersonId: string) {
    return await prisma.deliveryRating.findMany({
      where: { deliveryPersonId },
      include: {
        customer: {
          select: { name: true }
        },
        order: {
          select: { id: true, totalAmount: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async addRating(data: DeliveryRatingRequest) {
    return await prisma.deliveryRating.create({
      data: {
        deliveryPersonId: data.deliveryPersonId,
        customerId: data.customerId,
        orderId: data.orderId,
        rating: data.rating,
        comment: data.comment,
        criteria: data.criteria
      },
      include: {
        customer: {
          select: { name: true }
        },
        deliveryPerson: {
          select: { name: true }
        }
      }
    });
  }

  async getRatingsSummary(deliveryPersonId: string) {
    const [ratingsData, recentRatings] = await Promise.all([
      prisma.deliveryRating.aggregate({
        where: { deliveryPersonId },
        _avg: { rating: true },
        _count: { rating: true }
      }),
      prisma.deliveryRating.groupBy({
        by: ['rating'],
        where: { deliveryPersonId },
        _count: { rating: true }
      })
    ]);

    const ratingDistribution = {
      1: 0, 2: 0, 3: 0, 4: 0, 5: 0
    };

    recentRatings.forEach(group => {
      ratingDistribution[group.rating] = group._count.rating;
    });

    return {
      deliveryPersonId,
      averageRating: ratingsData._avg.rating || 0,
      totalRatings: ratingsData._count.rating,
      ratingDistribution,
      calculatedAt: new Date()
    };
  }

  // ================================
  // ANALYTICS AND REPORTING
  // ================================

  async getFundCollectionAnalytics(): Promise<DeliveryAnalytics> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    const [totalCollection, avgCollection, topPerformers] = await Promise.all([
      prisma.deliveryCollection.aggregate({
        where: {
          createdAt: { gte: thirtyDaysAgo }
        },
        _sum: { amountCollected: true },
        _count: true
      }),
      prisma.deliveryCollection.groupBy({
        by: ['deliveryPersonId'],
        where: {
          createdAt: { gte: thirtyDaysAgo }
        },
        _avg: { amountCollected: true },
        _sum: { amountCollected: true },
        _count: true
      }),
      prisma.deliveryPerson.findMany({
        include: {
          collections: {
            where: {
              createdAt: { gte: thirtyDaysAgo }
            }
          },
          _count: {
            select: {
              collections: {
                where: {
                  createdAt: { gte: thirtyDaysAgo }
                }
              }
            }
          }
        },
        orderBy: {
          collections: {
            _count: 'desc'
          }
        },
        take: 5
      })
    ]);

    return {
      period: '30_days',
      totalCollectionAmount: totalCollection._sum.amountCollected || 0,
      totalOrders: totalCollection._count,
      averageCollectionPerOrder: totalCollection._count > 0 
        ? (totalCollection._sum.amountCollected || 0) / totalCollection._count 
        : 0,
      activeDeliveryPersons: avgCollection.length,
      topPerformers: topPerformers.map(dp => ({
        deliveryPersonId: dp.id,
        name: dp.name,
        totalCollections: dp._count.collections,
        totalAmount: dp.collections.reduce((sum, col) => sum + col.amountCollected, 0)
      })),
      calculatedAt: new Date()
    };
  }

  async getDeliveryAnalytics(): Promise<DeliveryAnalytics> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    const [deliveryStats, performanceMetrics] = await Promise.all([
      prisma.order.groupBy({
        by: ['status'],
        where: {
          shipping: {
            deliveryPersonId: { not: null }
          },
          createdAt: { gte: thirtyDaysAgo }
        },
        _count: true
      }),
      prisma.deliveryPerson.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          _count: {
            select: {
              collections: {
                where: {
                  createdAt: { gte: thirtyDaysAgo }
                }
              }
            }
          }
        }
      })
    ]);

    const statusCounts = deliveryStats.reduce((acc, stat) => {
      acc[stat.status] = stat._count;
      return acc;
    }, {} as Record<string, number>);

    return {
      period: '30_days',
      totalDeliveries: deliveryStats.reduce((sum, stat) => sum + stat._count, 0),
      deliveredOrders: statusCounts['DELIVERED'] || 0,
      pendingOrders: statusCounts['PENDING'] || 0,
      failedDeliveries: statusCounts['FAILED_TO_DELIVER'] || 0,
      activeDeliveryPersons: performanceMetrics.filter(dp => dp._count.collections > 0).length,
      averageDeliveriesPerPerson: performanceMetrics.length > 0 
        ? performanceMetrics.reduce((sum, dp) => sum + dp._count.collections, 0) / performanceMetrics.length 
        : 0,
      calculatedAt: new Date()
    };
  }

  async getDashboardStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [totalActive, todayDeliveries, pendingCollections, avgRating] = await Promise.all([
      prisma.deliveryPerson.count({
        where: { isActive: true }
      }),
      prisma.order.count({
        where: {
          shipping: {
            deliveryPersonId: { not: null }
          },
          createdAt: {
            gte: today,
            lt: tomorrow
          }
        }
      }),
      prisma.deliveryCollection.aggregate({
        where: {
          status: 'PENDING'
        },
        _sum: { amountCollected: true },
        _count: true
      }),
      prisma.deliveryRating.aggregate({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
          }
        },
        _avg: { rating: true }
      })
    ]);

    return {
      activeDeliveryPersons: totalActive,
      todayDeliveries,
      pendingCollectionAmount: pendingCollections._sum.amountCollected || 0,
      pendingCollectionCount: pendingCollections._count,
      averageRating: avgRating._avg.rating || 0,
      lastUpdated: new Date()
    };
  }

  // ================================
  // EXPORT FUNCTIONALITY
  // ================================

  async exportDeliveryPersons(options: DeliveryExportOptions) {
    const { format, fields, filters } = options;
    
    const where = {
      AND: [
        filters?.status ? { status: filters.status } : {},
        filters?.search ? {
          OR: [
            { name: { contains: filters.search, mode: 'insensitive' } },
            { phone: { contains: filters.search } }
          ]
        } : {},
        filters?.zone ? { assignedZones: { has: filters.zone } } : {}
      ]
    };

    const deliveryPersons = await prisma.deliveryPerson.findMany({
      where,
      include: {
        user: true,
        collections: {
          where: {
            createdAt: {
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
            }
          }
        },
        payouts: {
          where: {
            createdAt: {
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
            }
          }
        },
        _count: {
          select: {
            collections: true,
            payouts: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Transform data based on selected fields
    const exportData = deliveryPersons.map(dp => {
      const record: any = {};
      
      if (fields.includes('name')) record.name = dp.name;
      if (fields.includes('phone')) record.phone = dp.phone;
      if (fields.includes('email')) record.email = dp.email;
      if (fields.includes('status')) record.status = dp.status;
      if (fields.includes('vehicleType')) record.vehicleType = dp.vehicleType;
      if (fields.includes('totalCollections')) record.totalCollections = dp._count.collections;
      if (fields.includes('totalPayouts')) record.totalPayouts = dp._count.payouts;
      if (fields.includes('joiningDate')) record.joiningDate = dp.joiningDate;
      
      return record;
    });

    return exportData;
  }

  async exportPerformanceReport(deliveryPersonIds?: string[]) {
    const where = deliveryPersonIds 
      ? { id: { in: deliveryPersonIds } }
      : { isActive: true };

    const deliveryPersons = await prisma.deliveryPerson.findMany({
      where,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true
      }
    });

    const performanceData = await Promise.all(
      deliveryPersons.map(async (dp) => {
        const [performance, ratings, collections] = await Promise.all([
          this.getDeliveryPerformance(dp.id),
          this.getRatingsSummary(dp.id),
          this.getFundCollectionSummary(dp.id)
        ]);

        return {
          deliveryPerson: dp,
          performance,
          ratings,
          collections
        };
      })
    );

    return performanceData;
  }

  async exportFundCollectionReport(startDate?: Date, endDate?: Date) {
    const dateFilter = {
      AND: [
        startDate ? { createdAt: { gte: startDate } } : {},
        endDate ? { createdAt: { lte: endDate } } : {}
      ]
    };

    const collections = await prisma.deliveryCollection.findMany({
      where: dateFilter,
      include: {
        deliveryPerson: {
          select: { name: true, phone: true }
        },
        order: {
          select: {
            id: true,
            totalAmount: true,
            vendor: {
              select: { storeName: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return collections.map(collection => ({
      collectionId: collection.id,
      deliveryPersonName: collection.deliveryPerson.name,
      deliveryPersonPhone: collection.deliveryPerson.phone,
      orderId: collection.order.id,
      vendorStore: collection.order.vendor.storeName,
      orderAmount: collection.order.totalAmount,
      collectedAmount: collection.amountCollected,
      collectionMethod: collection.collectionMethod,
      status: collection.status,
      collectedAt: collection.createdAt,
      settledAt: collection.settledAt
    }));
  }

  // ================================
  // REAL-TIME FEATURES
  // ================================

  async getActiveDeliveryPersons() {
    return await prisma.deliveryPerson.findMany({
      where: {
        isActive: true,
        status: 'ACTIVE'
      },
      include: {
        currentOrders: {
          where: {
            status: {
              in: ['CONFIRMED', 'PROCESSING', 'PACKAGING', 'SHIPPED']
            }
          },
          select: {
            id: true,
            status: true,
            totalAmount: true,
            shipping: {
              select: {
                address: true,
                trackingNo: true
              }
            }
          }
        },
        _count: {
          select: {
            currentOrders: {
              where: {
                status: {
                  in: ['CONFIRMED', 'PROCESSING', 'PACKAGING', 'SHIPPED']
                }
              }
            }
          }
        }
      }
    });
  }

  async updateLocation(deliveryPersonId: string, latitude: number, longitude: number) {
    return await prisma.deliveryLocation.upsert({
      where: { deliveryPersonId },
      create: {
        deliveryPersonId,
        latitude,
        longitude,
        updatedAt: new Date()
      },
      update: {
        latitude,
        longitude,
        updatedAt: new Date()
      }
    });
  }

  async getCurrentDeliveries(deliveryPersonId: string) {
    return await prisma.order.findMany({
      where: {
        shipping: {
          deliveryPersonId
        },
        status: {
          in: ['CONFIRMED', 'PROCESSING', 'PACKAGING', 'SHIPPED']
        }
      },
      include: {
        items: {
          include: {
            variant: {
              select: {
                name: true,
                product: {
                  select: { name: true }
                }
              }
            }
          }
        },
        shipping: true,
        vendor: {
          select: { storeName: true, phone: true }
        }
      },
      orderBy: { createdAt: 'asc' }
    });
  }

  async updateDeliveryStatus(deliveryPersonId: string, orderId: number, status: string) {
    // First verify the delivery person is assigned to this order
    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        shipping: {
          deliveryPersonId
        }
      }
    });

    if (!order) {
      throw new Error('Order not found or not assigned to this delivery person');
    }

    return await prisma.order.update({
      where: { id: orderId },
      data: {
        status,
        updatedAt: new Date(),
        ...(status === 'DELIVERED' && {
          deliveredAt: new Date()
        })
      },
      include: {
        shipping: true,
        vendor: {
          select: { storeName: true }
        }
      }
    });
  }
}
  // DELIVERY PERSON CRUD OPERATIONS
  // ================================
  
  async createDeliveryPerson(data: CreateDeliveryPersonRequest) {
    return await prisma.deliveryPerson.create({
      data: {
        name: data.name,
        phone: data.phone,
        email: data.email,
        address: data.address,
        nationalId: data.nationalId,
        licenseNumber: data.licenseNumber,
        vehicleType: data.vehicleType,
        vehicleNumber: data.vehicleNumber,
        emergencyContact: data.emergencyContact,
        isActive: false, // Requires approval
        joiningDate: new Date(),
        // Create associated user if needed
        user: data.createUser ? {
          create: {
            name: data.name,
            phone: data.phone,
            email: data.email,
            password: data.password, // Should be hashed
            role: 'DELIVERY_PERSON',
            isActive: false
          }
        } : undefined
      },
      include: {
        user: true
      }
    });
  }

  async getDeliveryPersons(filters: DeliveryPersonFilterQuery) {
    const {
      page = 1,
      limit = 10,
      search,
      status,
      zone,
      vehicleType,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = filters;

    const skip = (page - 1) * limit;
    
    const where = {
      AND: [
        search ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
            { email: { contains: search, mode: 'insensitive' } }
          ]
        } : {},
        status !== undefined ? { status } : {},
        zone ? { assignedZones: { has: zone } } : {},
        vehicleType ? { vehicleType } : {}
      ]
    };

    const [deliveryPersons, total] = await Promise.all([
      prisma.deliveryPerson.findMany({
        where,
        include: {
          user: true,
          collections: {
            where: {
              createdAt: {
                gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
              }
            }
          },
          payouts: {
            where: {
              createdAt: {
                gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
              }
            }
          },
          _count: {
            select: {
              collections: true,
              payouts: true
            }
          }
        },
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: limit
      }),
      prisma.deliveryPerson.count({ where })
    ]);

    return {
      data: deliveryPersons,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  async getDeliveryPersonById(id: string) {
    return await prisma.deliveryPerson.findUnique({
      where: { id },
      include: {
        user: true,
        collections: {
          include: {
            order: {
              select: {
                id: true,
                totalAmount: true,
                status: true,
                createdAt: true
              }
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 10
        },
        payouts: {
          orderBy: { createdAt: 'desc' },
          take: 5
        },
        _count: {
          select: {
            collections: true,
            payouts: true
          }
        }
      }
    });
  }

  async updateDeliveryPersonProfile(id: string, data: UpdateDeliveryPersonRequest) {
    return await prisma.deliveryPerson.update({
      where: { id },
      data: {
        name: data.name,
        phone: data.phone,
        email: data.email,
        address: data.address,
        emergencyContact: data.emergencyContact,
        vehicleType: data.vehicleType,
        vehicleNumber: data.vehicleNumber,
        licenseNumber: data.licenseNumber,
        assignedZones: data.assignedZones,
        updatedAt: new Date()
      },
      include: {
        user: true
      }
    });
  }

  async updateDeliveryPersonStatus(id: string, status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE') {
    const deliveryPerson = await prisma.deliveryPerson.update({
      where: { id },
      data: {
        status,
        isActive: status === 'ACTIVE',
        updatedAt: new Date()
      }
    });

    // Also update associated user status if exists
    if (deliveryPerson.userId) {
      await prisma.user.update({
        where: { id: deliveryPerson.userId },
        data: {
          isActive: status === 'ACTIVE'
        }
      });
    }

    return deliveryPerson;
  }

  async deleteDeliveryPerson(id: string) {
    // Check if delivery person has pending collections
    const pendingCollections = await prisma.deliveryCollection.count({
      where: {
        deliveryPersonId: id,
        status: 'PENDING'
      }
    });

    if (pendingCollections > 0) {
      throw new Error('Cannot delete delivery person with pending collections');
    }

    return await prisma.deliveryPerson.delete({
      where: { id }
    });
  }

  async bulkActions(data: BulkDeliveryActionRequest) {
    const { action, deliveryPersonIds, payload } = data;

    switch (action) {
      case 'APPROVE':
        return await prisma.deliveryPerson.updateMany({
          where: { id: { in: deliveryPersonIds } },
          data: { 
            status: 'ACTIVE',
            isActive: true,
            approvedAt: new Date()
          }
        });

      case 'SUSPEND':
        return await prisma.deliveryPerson.updateMany({
          where: { id: { in: deliveryPersonIds } },
          data: { 
            status: 'SUSPENDED',
            isActive: false,
            suspendedAt: new Date()
          }
        });

      case 'ASSIGN_ZONE':
        return await prisma.deliveryPerson.updateMany({
          where: { id: { in: deliveryPersonIds } },
          data: {
            assignedZones: payload.zones
          }
        });

      default:
        throw new Error('Invalid bulk action');
    }
  }

  // ================================
  // FUND COLLECTION MANAGEMENT
  // ================================

  async getFundCollectionSummary(deliveryPersonId: string): Promise<FundCollectionSummary> {
    const [totalCollections, pendingCollections, settledCollections] = await Promise.all([
      prisma.deliveryCollection.aggregate({
        where: { deliveryPersonId },
        _sum: { amountCollected: true },
        _count: true
      }),
      prisma.deliveryCollection.aggregate({
        where: { 
          deliveryPersonId,
          status: 'PENDING'
        },
        _sum: { amountCollected: true },
        _count: true
      }),
      prisma.deliveryCollection.aggregate({
        where: { 
          deliveryPersonId,
          status: 'SETTLED'
        },
        _sum: { amountCollected: true },
        _count: true
      })
    ]);

    return {
      deliveryPersonId,
      totalAmount: totalCollections._sum.amountCollected || 0,
      totalOrders: totalCollections._count,
      pendingAmount: pendingCollections._sum.amountCollected || 0,
      pendingOrders: pendingCollections._count,
      settledAmount: settledCollections._sum.amountCollected || 0,
      settledOrders: settledCollections._count,
      collectionRate: totalCollections._count > 0 
        ? (settledCollections._count / totalCollections._count) * 100 
        : 0
    };
  }

  async getFundCollectionHistory(deliveryPersonId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    
    const [collections, total] = await Promise.all([
      prisma.deliveryCollection.findMany({
        where: { deliveryPersonId },
        include: {
          order: {
            select: {
              id: true,
              totalAmount: true,
              status: true,
              vendor: {
                select: { storeName: true }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.deliveryCollection.count({
        where: { deliveryPersonId }
      })
    ]);

    return {
      data: collections,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  async recordFundCollection(data: FundCollectionRequest) {
    return await prisma.deliveryCollection.create({
      data: {
        deliveryPersonId: data.deliveryPersonId,
        orderId: data.orderId,
        amountCollected: data.amountCollected,
        collectionMethod: data.collectionMethod,
        notes: data.notes,
        status: 'PENDING'
      },
      include: {
        order: true,
        deliveryPerson: {
          select: { name: true, phone: true }
        }
      }
    });
  }

  async settleCollection(collectionId: string) {
    return await prisma.deliveryCollection.update({
      where: { id: collectionId },
      data: {
        status: 'SETTLED',
        settledAt: new Date()
      }
    });
  }

  // ================================
  // PERFORMANCE TRACKING
  // ================================

  async getDeliveryPerformance(deliveryPersonId: string): Promise<DeliveryPerformanceMetrics> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    // Get delivery statistics
    const [totalDeliveries, completedDeliveries, onTimeDeliveries, customerRatings] = await Promise.all([
      prisma.order.count({
        where: {
          shipping: {
            deliveryPersonId
          },
          createdAt: { gte: thirtyDaysAgo }
        }
      }),
      prisma.order.count({
        where: {
          shipping: {
            deliveryPersonId
          },
          status: 'DELIVERED',
          createdAt: { gte: thirtyDaysAgo }
        }
      }),
      prisma.order.count({
        where: {
          shipping: {
            deliveryPersonId,
            status: 'DELIVERED',
            deliveredAt: {
              lte: prisma.raw('shipping.expected_delivery_at') // Delivered on or before expected time
            }
          },
          createdAt: { gte: thirtyDaysAgo }
        }
      }),
      prisma.deliveryRating.aggregate({
        where: {
          deliveryPersonId,
          createdAt: { gte: thirtyDaysAgo }
        },
        _avg: { rating: true },
        _count: true
      })
    ]);

    const completionRate = totalDeliveries > 0 ? (completedDeliveries / totalDeliveries) * 100 : 0;
    const onTimeRate = completedDeliveries > 0 ? (onTimeDeliveries / completedDeliveries) * 100 : 0;

    return {
      deliveryPersonId,
      period: '30_days',
      totalDeliveries,
      completedDeliveries,
      onTimeDeliveries,
      completionRate,
      onTimeRate,
      averageRating: customerRatings._avg.rating || 0,
      totalRatings: customerRatings._count,
      calculatedAt: new Date()
    };
  }

  async getPerformanceLeaderboard(limit = 10) {
    // This would require a more complex query or pre-calculated performance metrics
    const deliveryPersons = await prisma.deliveryPerson.findMany({
      where: { isActive: true },
      include: {
        _count: {
          select: {
            collections: {
              where: {
                status: 'SETTLED',
                createdAt: {
                  gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
                }
              }
            }
          }
        }
      },
      take: limit
    });

    // Calculate performance metrics for each delivery person
    const leaderboard = await Promise.all(
      deliveryPersons.map(async (dp) => {
        const performance = await this.getDeliveryPerformance(dp.id);
        return {
          deliveryPerson: dp,
          performance
        };
      })
    );

    // Sort by completion rate and on-time rate
    return leaderboard.sort((a, b) => {
      const scoreA = (a.performance.completionRate * 0.6) + (a.performance.onTimeRate * 0.4);
      const scoreB = (b.performance.completionRate * 0.6) + (b.performance.onTimeRate * 0.4);
      return scoreB - scoreA;
    });
  }

  // ================================
  // PAYOUT MANAGEMENT
  // ================================

  async createPayout(deliveryPersonId: string, data: DeliveryPayoutRequest) {
    return await prisma.deliveryPayout.create({
      data: {
        deliveryPersonId,
        amount: data.amount,
        payoutType: data.payoutType,
        period: data.period,
        method: data.method,
        notes: data.notes,
        status: 'PENDING'
      },
      include: {
        deliveryPerson: {
          select: { name: true, phone: true }
        }
      }
    });
  }

  async updatePayoutStatus(payoutId: string, status: 'PENDING' | 'PAID' | 'FAILED', paidAt?: Date) {
    return await prisma.deliveryPayout.update({
      where: { id: payoutId },
      data: {
        status,
        paidAt: status === 'PAID' ? (paidAt || new Date()) : null,
        updatedAt: new Date()
      }
    });
  }

  async getDeliveryPersonPayouts(deliveryPersonId: string) {
    return await prisma.deliveryPayout.findMany({
      where: { deliveryPersonId },
      orderBy: { createdAt: 'desc' },
      include: {
        deliveryPerson: {
          select: { name: true }
        }
      }
    });
  }

  async calculateIncentives(deliveryPersonId: string) {
    const performance = await this.getDeliveryPerformance(deliveryPersonId);
    const fundCollection = await this.getFundCollectionSummary(deliveryPersonId);
    
    let incentiveAmount = 0;
    const incentiveBreakdown = [];

    // Performance-based incentives
    if (performance.completionRate >= 95) {
      incentiveAmount += 500;
      incentiveBreakdown.push({ type: 'HIGH_COMPLETION_RATE', amount: 500 });
    }

    if (performance.onTimeRate >= 90) {
      incentiveAmount += 300;
      incentiveBreakdown.push({ type: 'ON_TIME_DELIVERY', amount: 300 });
    }

    if (performance.averageRating >= 4.5) {
      incentiveAmount += 200;
      incentiveBreakdown.push({ type: 'HIGH_RATING', amount: 200 });
    }

    // Collection-based incentives
    if (fundCollection.collectionRate >= 98) {
      incentiveAmount += 400;
      incentiveBreakdown.push({ type: 'HIGH_COLLECTION_RATE', amount: 400 });
    }

    return {
      deliveryPersonId,
      totalIncentive: incentiveAmount,
      breakdown: incentiveBreakdown,
      calculatedAt: new Date()
    };
  }

  // ================================
  // CUSTOMER COMPLAINTS
  // ================================

  async getComplaints(deliveryPersonId: string) {
    return await prisma.deliveryComplaint.findMany({
      where: { deliveryPersonId },
      include: {
        customer: {
          select: { name: true, phone: true }
        },
        order: {
          select: { id: true, totalAmount: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async createComplaint(data: DeliveryComplaintRequest) {
    return await prisma.deliveryComplaint.create({
      data: {
        deliveryPersonId: data.deliveryPersonId,
        customerId: data.customerId,
        orderId: data.orderId,
        complaintType: data.complaintType,
        description: data.description,
        severity: data.severity,
        status: 'OPEN'
      },
      include: {
        customer: {
          select: { name: true, phone: true }
        },
        deliveryPerson: {
          select: { name: true, phone: true }
        }
      }
    });
  }

  async updateComplaintStatus(complaintId: string, status: string, resolution?: string) {
    return await prisma.deliveryComplaint.update({
      where: { id: complaintId },
      data: {
        status,
        resolution,
        resolvedAt: status === 'RESOLVED' ? new Date() : null,
        updatedAt: new Date()
      }
    });
  }

  // ================================
  // PROMOTIONAL OFFERS
  // ================================

  async createPromotionalOffer(data: DeliveryPromotionalOfferRequest) {
    return await prisma.deliveryPromotionalOffer.create({
      data: {
        title: data.title,
        description: data.description,
        offerType: data.offerType,
        value: data.value,
        conditions: data.conditions,
        validFrom: new Date(data.validFrom),
        validTo: data.validTo ? new Date(data.validTo) : null,
        maxClaims: data.maxClaims,
        isActive: true
      }
    });
  }

  async getPromotionalOffers(isActive?: boolean) {
    return await prisma.deliveryPromotionalOffer.findMany({
      where: isActive !== undefined ? { isActive } : {},
      include: {
        _count: {
          select: {
            claims: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getEligibleOffers(deliveryPersonId: string) {
    const now = new Date();
    
    return await prisma.deliveryPromotionalOffer.findMany({
      where: {
        isActive: true,
        validFrom: { lte: now },
        OR: [
          { validTo: null },
          { validTo: { gte: now } }
        ],
        NOT: {
          claims: {
            some: {
              deliveryPersonId
            }
          }
        }
      },
      include: {
        _count: {
          select: { claims: true }
        }
      }
    });
  }

  async claimPromotionalOffer(deliveryPersonId: string, offerId: string) {
    // Check if offer is still valid and claimable
    const offer = await prisma.deliveryPromotionalOffer.findUnique({
      where: { id: offerId },
      include: {
        _count: { select: { claims: true } }
      }
    });

    if (!offer?.isActive) {
      throw new Error('Offer is not active');
    }

    if (offer.maxClaims && offer._count.claims >= offer.maxClaims) {
      throw new Error('Offer has reached maximum claims');
    }

    return await prisma.deliveryOfferClaim.create({
      data: {
        deliveryPersonId,
        offerId,
        claimedAt: new Date(),
        status: 'PENDING'
      },
      include: {
        offer: true,
        deliveryPerson: {
          select: { name: true }
        }
      }
    });
  }

  // ================================