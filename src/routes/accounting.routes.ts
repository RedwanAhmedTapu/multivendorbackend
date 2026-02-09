import { Router } from 'express';
import { AccountingController } from '../controllers/accounting.controller.ts';
import { prisma } from '../config/prisma.ts';
import { authenticateUser, authorizeRoles } from '../middlewares/auth.middleware.ts';
import { Decimal } from '@prisma/client/runtime/library';

const router = Router();
const controller = new AccountingController();

// ============================================
// MIDDLEWARE
// ============================================

// Admin-only middleware
const adminOnly = authorizeRoles('ADMIN', 'EMPLOYEE');

// Vendor-only middleware
const vendorOnly = (req: any, res: any, next: any) => {
  if (req.user?.role === 'VENDOR') {
    // Ensure vendor can only access their own data
    if (req.query.entityId && req.query.entityId !== req.user.vendorId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied: You can only access your own data' 
      });
    }
    if (req.params.entityId && req.params.entityId !== req.user.vendorId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied: You can only access your own data' 
      });
    }
    if (req.body.entityId && req.body.entityId !== req.user.vendorId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied: You can only access your own data' 
      });
    }
    next();
  } else {
    res.status(403).json({ 
      success: false, 
      message: 'Access denied: Vendor access required' 
    });
  }
};

// Entity-specific access middleware
const entityAccess = (req: any, res: any, next: any) => {
  const user = req.user;

  if (user.role === 'ADMIN' || user.role === 'EMPLOYEE') {
    // Admin/Employee can access all entities
    next();
  } else if (user.role === 'VENDOR') {
    // Vendor can only access their own entity
    const entityId = req.params.entityId || req.query.entityId || req.body.entityId;
    
    if (entityId && entityId !== user.vendorId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied: You can only access your own data' 
      });
    }
    
    // Auto-inject vendorId for vendors
    if (req.query.entityType === 'VENDOR' && !req.query.entityId) {
      req.query.entityId = user.vendorId;
    }
    if (req.body.entityType === 'VENDOR' && !req.body.entityId) {
      req.body.entityId = user.vendorId;
    }
    
    next();
  } else {
    res.status(403).json({ 
      success: false, 
      message: 'Access denied: Insufficient permissions' 
    });
  }
};

// ============================================
// CHART OF ACCOUNTS ROUTES
// ============================================

// Create new account (Admin only)
router.post(
  '/chart-of-accounts',
  
  controller.createChartOfAccount
);

// Update account (Admin only)
router.put(
  '/chart-of-accounts/:id',
 
  controller.updateChartOfAccount
);

// Delete account (Admin only)
router.delete(
  '/chart-of-accounts/:id',
 
  controller.deleteChartOfAccount
);

// Get chart of accounts (with entity access control)
router.get(
  '/chart-of-accounts',
 
  controller.getChartOfAccounts
);

// Get single account details
router.get(
  '/chart-of-accounts/:id',
 
  controller.getChartOfAccountById
);

// ============================================
// VOUCHER ROUTES
// ============================================

// Create manual voucher (Admin)
router.post(
  '/vouchers/manual',
 
  controller.createVoucher
);

// Create manual voucher for vendors
router.post(
  '/vouchers/manual/vendor',
  
  controller.createVoucher
);

// Get single voucher
router.get(
  '/vouchers/:id',
 
  controller.getVoucher
);

// List vouchers with filters
router.get(
  '/vouchers',
 
  controller.getVouchers
);

// Post voucher (make it permanent)
router.post(
  '/vouchers/:id/post',
 
  controller.postVoucher
);

// Lock voucher (Admin only)
router.post(
  '/vouchers/:id/lock',
 
  controller.lockVoucher
);

// Reverse voucher (Admin only)
router.post(
  '/vouchers/:id/reverse',
 
  controller.reverseVoucher
);
// Cancel voucher (Admin only)
router.post(
  '/vouchers/:id/cancel',
 
  controller.cancelVoucher
);

// ============================================
// AUTO VOUCHER TRIGGERS (System/Admin only)
// ============================================

// Trigger auto voucher creation
router.post(
  '/auto-voucher/:eventType',
  
  controller.triggerAutoVoucher
);

// Webhook endpoint for order confirmation
router.post(
  '/webhooks/order-confirmed',
 
  async (req, res) => {
    try {
      const { orderId, vendorId, customerId, amount, commissionRate } = req.body;
      
      const commissionAmount = new Decimal(amount).times(commissionRate).div(100);
      const netAmount = new Decimal(amount).minus(commissionAmount);

      const result = await controller.triggerAutoVoucher(
        { params: { eventType: 'ORDER_CONFIRMED' }, body: {
          orderId,
          vendorId,
          customerId,
          amount: new Decimal(amount),
          commissionRate: new Decimal(commissionRate),
          commissionAmount,
          netAmount,
        }} as any,
        res
      );
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }
);

// Webhook endpoint for payment received
router.post(
  '/webhooks/payment-received',
 
  async (req, res) => {
    try {
      const result = await controller.triggerAutoVoucher(
        { params: { eventType: 'PAYMENT_RECEIVED' }, body: req.body } as any,
        res
      );
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }
);

// ============================================
// REPORTING ROUTES
// ============================================

// Trial Balance
router.get(
  '/reports/trial-balance',
 
  controller.getTrialBalance
);

// Profit & Loss Statement
router.get(
  '/reports/profit-loss',
 
  controller.getProfitAndLoss
);

// Balance Sheet
router.get(
  '/reports/balance-sheet',
 
  controller.getBalanceSheet
);

// General Ledger
router.get(
  '/reports/ledger',
 
  controller.getLedger
);

// Vendor Payable Report (Admin only)
router.get(
  '/reports/vendor-payables',
 
  controller.getVendorPayableReport
);

// Account-specific ledger report
router.get(
  '/reports/account-ledger/:accountId',
 
  async (req, res) => {
    const { accountId } = req.params;
    const { startDate, endDate, page, limit } = req.query;
    
    req.query.accountId = accountId;
    
    await controller.getLedger(req, res);
  }
);

// ============================================
// ACCOUNTING PERIOD ROUTES (Admin only)
// ============================================

// Create accounting period
router.post(
  '/accounting-periods',
 
  controller.createAccountingPeriod
);

// Close accounting period
router.post(
  '/accounting-periods/:id/close',
 
  controller.closeAccountingPeriod
);

// Get accounting periods
router.get(
  '/accounting-periods',
 
  async (req, res) => {
    try {
      const { entityType, entityId } = req.query;
      
      const periods = await prisma.accountingPeriod.findMany({
        where: {
          entityType: entityType as string,
          entityId: (entityId as string) || null,
        },
        orderBy: [{ startDate: 'desc' }],
      });

      res.json({
        success: true,
        data: periods,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// ============================================
// AUDIT LOGS (Admin only)
// ============================================

router.get(
  '/audit-logs',
 
  controller.getAuditLogs
);

// ============================================
// VENDOR-SPECIFIC ROUTES
// ============================================

// Vendor dashboard summary
router.get(
  '/vendor/dashboard',
  authenticateUser,
  vendorOnly,
  async (req: any, res: any) => {
    try {
      const vendorId = req.user.vendorId;

      // Get trial balance for vendor
      const trialBalanceReq = { 
        query: { 
          entityType: 'VENDOR', 
          entityId: vendorId 
        } 
      };
      
      // Get profit & loss for current month
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const plReq = {
        query: {
          entityType: 'VENDOR',
          entityId: vendorId,
          startDate: startOfMonth.toISOString(),
          endDate: new Date().toISOString(),
        },
      };

      // Get balance sheet
      const bsReq = {
        query: {
          entityType: 'VENDOR',
          entityId: vendorId,
        },
      };

      // Execute reports in parallel
      const [trialBalance, profitLoss, balanceSheet] = await Promise.all([
        new Promise((resolve) => {
          const mockRes = {
            json: (data: any) => resolve(data.data),
            status: () => mockRes,
          };
          controller.getTrialBalance(trialBalanceReq as any, mockRes as any);
        }),
        new Promise((resolve) => {
          const mockRes = {
            json: (data: any) => resolve(data.data),
            status: () => mockRes,
          };
          controller.getProfitAndLoss(plReq as any, mockRes as any);
        }),
        new Promise((resolve) => {
          const mockRes = {
            json: (data: any) => resolve(data.data),
            status: () => mockRes,
          };
          controller.getBalanceSheet(bsReq as any, mockRes as any);
        }),
      ]);

      res.json({
        success: true,
        data: {
          trialBalance,
          profitLoss,
          balanceSheet,
        },
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// Vendor sales summary
router.get(
  '/vendor/sales-summary',
  authenticateUser,
  vendorOnly,
  async (req: any, res: any) => {
    try {
      const vendorId = req.user.vendorId;
      const { startDate, endDate } = req.query;

      // Get sales vouchers
      const vouchers = await prisma.voucher.findMany({
        where: {
          entityType: 'VENDOR',
          entityId: vendorId,
          voucherType: 'SALES',
          status: 'POSTED',
          voucherDate: {
            gte: startDate ? new Date(startDate as string) : undefined,
            lte: endDate ? new Date(endDate as string) : undefined,
          },
        },
        include: {
          ledgerEntries: {
            include: {
              account: true,
            },
          },
        },
        orderBy: [{ voucherDate: 'desc' }],
      });

      const totalSales = vouchers.reduce((sum, v) => {
        return sum.plus(v.totalDebit);
      }, new Decimal(0));

      res.json({
        success: true,
        data: {
          totalSales: totalSales.toString(),
          voucherCount: vouchers.length,
          vouchers,
        },
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// Vendor payable details
router.get(
  '/vendor/payables',
  authenticateUser,
  vendorOnly,
  async (req: any, res: any) => {
    try {
      const vendorId = req.user.vendorId;

      const payable = await prisma.vendorPayable.findUnique({
        where: { vendorId },
      });

      // Get recent payouts
      const payouts = await prisma.voucher.findMany({
        where: {
          entityType: 'VENDOR',
          entityId: vendorId,
          voucherType: 'RECEIPT',
          status: 'POSTED',
        },
        orderBy: [{ voucherDate: 'desc' }],
        take: 10,
        include: {
          ledgerEntries: {
            include: {
              account: true,
            },
          },
        },
      });

      res.json({
        success: true,
        data: {
          summary: payable,
          recentPayouts: payouts,
        },
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// Vendor commission summary
router.get(
  '/vendor/commissions',
  authenticateUser,
  vendorOnly,
  async (req: any, res: any) => {
    try {
      const vendorId = req.user.vendorId;
      const { status, startDate, endDate } = req.query;

      const where: any = { vendorId };
      
      if (status) where.status = status;
      
      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) where.createdAt.gte = new Date(startDate as string);
        if (endDate) where.createdAt.lte = new Date(endDate as string);
      }

      const commissions = await prisma.commissionRecord.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        take: 50,
      });

      const totalCommission = commissions.reduce((sum, c) => {
        return sum.plus(c.commissionAmount);
      }, new Decimal(0));

      res.json({
        success: true,
        data: {
          totalCommission: totalCommission.toString(),
          commissionCount: commissions.length,
          commissions,
        },
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// ============================================
// ADMIN DASHBOARD ROUTES
// ============================================

router.get(
  '/admin/dashboard',
 
  async (req: any, res: any) => {
    try {
      // Platform balance sheet
      const bsReq = {
        query: { entityType: 'ADMIN' },
      };

      const balanceSheet = await new Promise((resolve) => {
        const mockRes = {
          json: (data: any) => resolve(data.data),
          status: () => mockRes,
        };
        controller.getBalanceSheet(bsReq as any, mockRes as any);
      });

      // Vendor payables summary
      const vendorPayables = await prisma.vendorPayable.findMany({
        orderBy: [{ balance: 'desc' }],
        take: 10,
      });

      const totalVendorPayables = vendorPayables.reduce((sum, vp) => {
        return sum.plus(vp.balance);
      }, new Decimal(0));

      // Recent transactions
      const recentVouchers = await prisma.voucher.findMany({
        where: {
          entityType: 'ADMIN',
          status: 'POSTED',
        },
        orderBy: [{ createdAt: 'desc' }],
        take: 20,
        include: {
          ledgerEntries: {
            include: {
              account: true,
            },
          },
        },
      });

      // Settlement status
      const pendingSettlements = await prisma.settlementBatch.findMany({
        where: {
          status: 'PENDING',
        },
        orderBy: [{ settlementDate: 'asc' }],
      });

      // Commission summary
      const totalCommissions = await prisma.commissionRecord.aggregate({
        _sum: {
          commissionAmount: true,
        },
        where: {
          status: 'RECOGNIZED',
        },
      });

      res.json({
        success: true,
        data: {
          platformSummary: balanceSheet,
          vendorPayables: {
            totalBalance: totalVendorPayables.toString(),
            vendorCount: vendorPayables.length,
            topVendors: vendorPayables,
          },
          recentTransactions: recentVouchers,
          pendingSettlements,
          commissionSummary: {
            totalCommissions: totalCommissions._sum.commissionAmount?.toString() || '0',
          },
        },
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// Admin - All vendor payables detailed
router.get(
  '/admin/vendor-payables/detailed',
 
  async (req, res) => {
    try {
      const vendorPayables = await prisma.vendorPayable.findMany({
        orderBy: [{ balance: 'desc' }],
      });

      // Get detailed transactions for each vendor
      const detailed = await Promise.all(
        vendorPayables.map(async (vp) => {
          const recentVouchers = await prisma.voucher.findMany({
            where: {
              OR: [
                { entityType: 'VENDOR', entityId: vp.vendorId },
                {
                  AND: [
                    { entityType: 'ADMIN' },
                    {
                      ledgerEntries: {
                        some: {
                          account: {
                            name: { contains: `Vendor Payable - ${vp.vendorId}` },
                          },
                        },
                      },
                    },
                  ],
                },
              ],
              status: 'POSTED',
            },
            orderBy: [{ voucherDate: 'desc' }],
            take: 5,
          });

          return {
            ...vp,
            recentVouchers,
          };
        })
      );

      res.json({
        success: true,
        data: detailed,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// Admin - Settlement reconciliation
router.get(
  '/admin/settlements',
 
  async (req, res) => {
    try {
      const { status } = req.query;
      
      const where: any = {};
      if (status) where.status = status;

      const settlements = await prisma.settlementBatch.findMany({
        where,
        orderBy: [{ settlementDate: 'desc' }],
        take: 50,
      });

      res.json({
        success: true,
        data: settlements,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// ============================================
// UTILITY ROUTES
// ============================================

// Health check
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Accounting service is running',
    timestamp: new Date().toISOString(),
  });
});

// Get accounting statistics
router.get(
  '/statistics',
 
  async (req, res) => {
    try {
      const { entityType, entityId } = req.query;

      const voucherCount = await prisma.voucher.count({
        where: {
          entityType: entityType as string,
          entityId: (entityId as string) || null,
        },
      });

      const accountCount = await prisma.chartOfAccount.count({
        where: {
          entityType: entityType as string,
          entityId: (entityId as string) || null,
          isActive: true,
        },
      });

      const ledgerEntryCount = await prisma.ledgerEntry.count({
        where: {
          entityType: entityType as string,
          entityId: (entityId as string) || null,
        },
      });

      res.json({
        success: true,
        data: {
          voucherCount,
          accountCount,
          ledgerEntryCount,
        },
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
);

export default router;