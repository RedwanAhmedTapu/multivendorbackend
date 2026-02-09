import type { Request, Response } from 'express';
import { AccountingService } from '../services/accounting.services.ts';
import { Decimal } from '@prisma/client/runtime/library';

const accountingService = new AccountingService();

export class AccountingController {
  // ============================================
  // 1. CHART OF ACCOUNTS
  // ============================================

  async createChartOfAccount(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id || (req as any).user?.userId;
      
      const data = {
        ...req.body,
        userId,
      };

      const coa = await accountingService.createChartOfAccount(data);

      res.status(201).json({
        success: true,
        message: 'Chart of Account created successfully',
        data: coa,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async updateChartOfAccount(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id || (req as any).user?.userId;

      const updated = await accountingService.updateChartOfAccount(id, req.body, userId);

      res.json({
        success: true,
        message: 'Chart of Account updated successfully',
        data: updated,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async deleteChartOfAccount(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id || (req as any).user?.userId;

      const result = await accountingService.deleteChartOfAccount(id, userId);

      res.json({
        success: true,
        message: result.message,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async getChartOfAccounts(req: Request, res: Response) {
    try {
      const { entityType, entityId } = req.query;

      if (!entityType) {
        return res.status(400).json({
          success: false,
          message: 'entityType is required',
        });
      }

      const accounts = await accountingService.getChartOfAccounts(
        entityType as string,
        entityId as string
      );

      res.json({
        success: true,
        data: accounts,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async getChartOfAccountById(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const account = await accountingService.getChartOfAccountById(id);

      if (!account) {
        return res.status(404).json({
          success: false,
          message: 'Chart of Account not found',
        });
      }

      res.json({
        success: true,
        data: account,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  // ============================================
  // 2. VOUCHERS
  // ============================================

  async createVoucher(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id || (req as any).user?.userId;

      const data = {
        ...req.body,
        createdBy: userId,
      };

      const voucher = await accountingService.createVoucher(data);

      res.status(201).json({
        success: true,
        message: 'Voucher created successfully',
        data: voucher,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async getVoucher(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const voucher = await accountingService.getVoucherById(id);

      if (!voucher) {
        return res.status(404).json({
          success: false,
          message: 'Voucher not found',
        });
      }

      res.json({
        success: true,
        data: voucher,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async getVouchers(req: Request, res: Response) {
    try {
      const {
        entityType,
        entityId,
        voucherType,
        status,
        startDate,
        endDate,
        referenceType,
        referenceId,
        page,
        limit,
      } = req.query;

      if (!entityType) {
        return res.status(400).json({
          success: false,
          message: 'entityType is required',
        });
      }

      const filters = {
        entityType: entityType as string,
        entityId: entityId as string,
        voucherType: voucherType as string,
        status: status as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        referenceType: referenceType as string,
        referenceId: referenceId as string,
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      };

      const result = await accountingService.getVouchers(filters);

      res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async postVoucher(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id || (req as any).user?.userId;

      const voucher = await accountingService.postVoucher(id, userId);

      res.json({
        success: true,
        message: 'Voucher posted successfully',
        data: voucher,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async lockVoucher(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id || (req as any).user?.userId;

      const voucher = await accountingService.lockVoucher(id, userId);

      res.json({
        success: true,
        message: 'Voucher locked successfully',
        data: voucher,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async reverseVoucher(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const userId = (req as any).user?.id || (req as any).user?.userId;

      if (!reason) {
        return res.status(400).json({
          success: false,
          message: 'Reversal reason is required',
        });
      }

      const result = await accountingService.reverseVoucher(id, reason, userId);

      res.json({
        success: true,
        message: 'Voucher reversed successfully',
        data: result,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
async cancelVoucher(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const userId = (req as any).user?.id || (req as any).user?.userId;

    if (!reason || reason.trim() === '') {
      throw new Error('Cancel reason is required');
    }

    const voucher = await accountingService.cancelVoucher(
      id,
      reason,
      userId
    );

    res.json({
      success: true,
      message: 'Voucher cancelled successfully',
      data: voucher,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
}

  // ============================================
  // 3. AUTO VOUCHER TRIGGERS
  // ============================================

  async triggerAutoVoucher(req: Request, res: Response) {
    try {
      const { eventType } = req.params;
      const data = req.body;

      const result = await accountingService.createAutoVoucher(eventType, data);

      res.json({
        success: true,
        message: `Auto voucher created for event: ${eventType}`,
        data: result,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  // ============================================
  // 4. REPORTS
  // ============================================

  async getTrialBalance(req: Request, res: Response) {
    try {
      const { entityType, entityId, asOf } = req.query;

      if (!entityType) {
        return res.status(400).json({
          success: false,
          message: 'entityType is required',
        });
      }

      const result = await accountingService.getTrialBalance(
        entityType as string,
        entityId as string,
        asOf ? new Date(asOf as string) : undefined
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async getProfitAndLoss(req: Request, res: Response) {
    try {
      const { entityType, entityId, startDate, endDate } = req.query;

      if (!entityType) {
        return res.status(400).json({
          success: false,
          message: 'entityType is required',
        });
      }

      const result = await accountingService.getProfitAndLoss(
        entityType as string,
        entityId as string,
        startDate ? new Date(startDate as string) : undefined,
        endDate ? new Date(endDate as string) : undefined
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async getBalanceSheet(req: Request, res: Response) {
    try {
      const { entityType, entityId, asOf } = req.query;

      if (!entityType) {
        return res.status(400).json({
          success: false,
          message: 'entityType is required',
        });
      }

      const result = await accountingService.getBalanceSheet(
        entityType as string,
        entityId as string,
        asOf ? new Date(asOf as string) : undefined
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async getLedger(req: Request, res: Response) {
    try {
      const {
        accountId,
        entityType,
        entityId,
        startDate,
        endDate,
        page,
        limit,
      } = req.query;

      if (!entityType) {
        return res.status(400).json({
          success: false,
          message: 'entityType is required',
        });
      }

      const filters = {
        accountId: accountId as string,
        entityType: entityType as string,
        entityId: entityId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      };

      const result = await accountingService.getLedger(filters);

      res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async getVendorPayableReport(req: Request, res: Response) {
    try {
      const { vendorId } = req.query;

      const result = await accountingService.getVendorPayableReport(
        vendorId as string
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  // ============================================
  // 5. ACCOUNTING PERIODS
  // ============================================

  async createAccountingPeriod(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id || (req as any).user?.userId;

      const data = {
        ...req.body,
        startDate: new Date(req.body.startDate),
        endDate: new Date(req.body.endDate),
        userId,
      };

      const period = await accountingService.createAccountingPeriod(data);

      res.status(201).json({
        success: true,
        message: 'Accounting period created successfully',
        data: period,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async closeAccountingPeriod(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id || (req as any).user?.userId;

      const period = await accountingService.closeAccountingPeriod(id, userId);

      res.json({
        success: true,
        message: 'Accounting period closed successfully',
        data: period,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  // ============================================
  // 6. AUDIT LOGS
  // ============================================

  async getAuditLogs(req: Request, res: Response) {
    try {
      const {
        entityName,
        entityId,
        action,
        userId,
        startDate,
        endDate,
        page,
        limit,
      } = req.query;

      const filters = {
        entityName: entityName as string,
        entityId: entityId as string,
        action: action as string,
        userId: userId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      };

      const result = await accountingService.getAuditLogs(filters);

      res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
}