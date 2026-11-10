// src/controllers/bankAccount.controller.ts
import type { Request, Response } from "express";
import { BankAccountService } from "../services/bankAccountService.ts";

export const BankAccountController = {
  /**
   * FIXED: was calling BankAccountService.addVendorBankAccount, which
   * doesn't exist on the service (it's named addVendorPaymentAccount) —
   * every hit to this route threw "addVendorBankAccount is not a
   * function" before the fix.
   */
  async addVendorBankAccount(req: Request, res: Response) {
    try {
      const vendorId = req.params.vendorId; // or pull from req.user for the logged-in vendor
      const result = await BankAccountService.addVendorPaymentAccount(vendorId, req.body);
      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  },

  /**
   * FIXED: was calling BankAccountService.listVendorBankAccounts (doesn't
   * exist — it's listVendorPaymentAccounts). Now also benefits from that
   * method's own fix, so this returns BANK, MOBILE_BANKING, CARD and CASH
   * accounts together, not just BANK.
   */
  async listVendorBankAccounts(req: Request, res: Response) {
    try {
      const data = await BankAccountService.listVendorPaymentAccounts(req.params.vendorId);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  /**
   * FIXED: was calling BankAccountService.setDefaultVendorBankAccount
   * (doesn't exist — it's setDefaultVendorPaymentAccount).
   */
  async setDefaultVendorBankAccount(req: Request, res: Response) {
    try {
      const { vendorId, bankAccountId } = req.params;
      const result = await BankAccountService.setDefaultVendorPaymentAccount(vendorId, bankAccountId);
      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  },

  /**
   * FIXED: was calling BankAccountService.addAdminBankAccount (doesn't
   * exist — it's addAdminPaymentAccount).
   */
  async addAdminBankAccount(req: Request, res: Response) {
    try {
      const result = await BankAccountService.addAdminPaymentAccount(req.body);
      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message });
    }
  },
};