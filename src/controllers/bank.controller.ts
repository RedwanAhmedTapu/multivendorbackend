// src/controllers/bank.controller.ts
import type { Request, Response } from "express";
import { prisma } from "../config/prisma.ts";

export const createBank = async (req: Request, res: Response) => {
  try {
    const { name, code, swiftCode } = req.body as {
      name?: string;
      code?: string;
      swiftCode?: string;
    };

    const trimmedName = name?.trim();
    const trimmedCode = code?.trim() || null;
    const trimmedSwift = swiftCode?.trim() || null;

    /* ── Basic required-field validation ─────────────────────────── */
    if (!trimmedName) {
      return res.status(400).json({ success: false, message: "Bank name is required" });
    }
    if (trimmedName.length < 2) {
      return res.status(400).json({ success: false, message: "Bank name must be at least 2 characters" });
    }

    /* ── Pre-check uniqueness for both unique fields, so we can tell
       the user exactly which field is duplicated (name vs code) ──── */
    const [nameClash, codeClash] = await Promise.all([
      prisma.bank.findUnique({ where: { name: trimmedName }, select: { id: true } }),
      trimmedCode
        ? prisma.bank.findUnique({ where: { code: trimmedCode }, select: { id: true } })
        : Promise.resolve(null),
    ]);

    if (nameClash) {
      return res.status(409).json({
        success: false,
        message: `A bank named "${trimmedName}" already exists`,
        field: "name",
      });
    }
    if (codeClash) {
      return res.status(409).json({
        success: false,
        message: `Bank code "${trimmedCode}" is already in use`,
        field: "code",
      });
    }

    const bank = await prisma.bank.create({
      data: {
        name: trimmedName,
        code: trimmedCode,
        swiftCode: trimmedSwift,
      },
    });

    res.status(201).json({ success: true, data: bank });
  } catch (error: any) {
    // Fallback safety net for race conditions (two requests hitting
    // the pre-check at the same time) — Prisma's unique constraint
    // error still tells us which field(s) via error.meta.target
    if (error.code === "P2002") {
      const target: string[] = error.meta?.target ?? [];
      const field = target.includes("name") ? "name" : target.includes("code") ? "code" : "record";
      return res.status(409).json({
        success: false,
        message: `A bank with this ${field} already exists`,
        field,
      });
    }
    res.status(500).json({ success: false, message: "Failed to create bank", error: error.message });
  }
};

/**
 * PATCH /banks/:bankId
 * Partial update — any subset of { name, code, swiftCode, isActive }.
 * Only re-checks uniqueness for fields that are actually changing, so
 * saving the form without touching name/code doesn't false-positive
 * against the bank's own existing row.
 */
export const updateBank = async (req: Request, res: Response) => {
  try {
    const { bankId } = req.params;
    const { name, code, swiftCode, isActive } = req.body as {
      name?: string;
      code?: string;
      swiftCode?: string;
      isActive?: boolean;
    };

    const existing = await prisma.bank.findUnique({ where: { id: bankId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Bank not found" });
    }

    const trimmedName = name !== undefined ? name.trim() : undefined;
    const trimmedCode = code !== undefined ? code.trim() || null : undefined;
    const trimmedSwift = swiftCode !== undefined ? swiftCode.trim() || null : undefined;

    if (name !== undefined && !trimmedName) {
      return res.status(400).json({ success: false, message: "Bank name cannot be empty" });
    }
    if (trimmedName && trimmedName.length < 2) {
      return res.status(400).json({ success: false, message: "Bank name must be at least 2 characters" });
    }

    if (trimmedName && trimmedName !== existing.name) {
      const nameClash = await prisma.bank.findUnique({ where: { name: trimmedName }, select: { id: true } });
      if (nameClash) {
        return res.status(409).json({
          success: false,
          message: `A bank named "${trimmedName}" already exists`,
          field: "name",
        });
      }
    }
    if (trimmedCode && trimmedCode !== existing.code) {
      const codeClash = await prisma.bank.findUnique({ where: { code: trimmedCode }, select: { id: true } });
      if (codeClash) {
        return res.status(409).json({
          success: false,
          message: `Bank code "${trimmedCode}" is already in use`,
          field: "code",
        });
      }
    }

    const bank = await prisma.bank.update({
      where: { id: bankId },
      data: {
        name: trimmedName ?? existing.name,
        code: trimmedCode !== undefined ? trimmedCode : existing.code,
        swiftCode: trimmedSwift !== undefined ? trimmedSwift : existing.swiftCode,
        isActive: isActive ?? existing.isActive,
      },
    });

    res.json({ success: true, data: bank });
  } catch (error: any) {
    if (error.code === "P2002") {
      const target: string[] = error.meta?.target ?? [];
      const field = target.includes("name") ? "name" : target.includes("code") ? "code" : "record";
      return res.status(409).json({
        success: false,
        message: `A bank with this ${field} already exists`,
        field,
      });
    }
    res.status(500).json({ success: false, message: "Failed to update bank", error: error.message });
  }
};

/**
 * DELETE /banks/:bankId
 * Soft delete: sets isActive = false instead of removing the row, and
 * cascades the same deactivation to every branch under this bank so
 * they disappear together from "select a bank/branch" dropdowns.
 *
 * A hard delete is deliberately avoided here: BankBranch cascade-deletes
 * with its Bank in the schema, but branches already referenced by
 * VendorPaymentAccount / AdminPaymentAccount rows have no cascade —
 * hard-deleting a bank that's actually in use would throw a foreign-key
 * error (or silently orphan historical payment records). Deactivating
 * keeps history intact while removing the bank from future use.
 */
export const deleteBank = async (req: Request, res: Response) => {
  try {
    const { bankId } = req.params;
    const existing = await prisma.bank.findUnique({ where: { id: bankId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Bank not found" });
    }

    await prisma.$transaction([
      prisma.bank.update({ where: { id: bankId }, data: { isActive: false } }),
      prisma.bankBranch.updateMany({ where: { bankId }, data: { isActive: false } }),
    ]);

    res.json({ success: true, message: "Bank deactivated" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: "Failed to deactivate bank", error: error.message });
  }
};

export const createBankBranch = async (req: Request, res: Response) => {
  try {
    const { bankId } = req.params;
    const { branchName, routingNumber } = req.body as {
      branchName?: string;
      routingNumber?: string;
    };

    /* ── Required-field validation ───────────────────────────────── */
    const trimmed = {
      branchName: branchName?.trim(),
      routingNumber: routingNumber?.trim() || null,
    };

    if (!trimmed.branchName) {
      return res.status(400).json({
        success: false,
        message: "Missing required field(s): branchName",
      });
    }

    /* ── Bank must exist ─────────────────────────────────────────── */
    const bank = await prisma.bank.findUnique({ where: { id: bankId }, select: { id: true } });
    if (!bank) {
      return res.status(404).json({ success: false, message: "Bank not found" });
    }

    /* ── Pre-check both unique constraints so we can name the
       exact conflicting field(s) ────────────────────────────────── */
    const [branchNameClash, routingClash] = await Promise.all([
      prisma.bankBranch.findUnique({
        where: { bankId_branchName: { bankId, branchName: trimmed.branchName! } },
        select: { id: true },
      }),
      trimmed.routingNumber
        ? prisma.bankBranch.findUnique({
            where: { routingNumber: trimmed.routingNumber },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    if (branchNameClash) {
      return res.status(409).json({
        success: false,
        message: `Branch "${trimmed.branchName}" already exists for this bank`,
        field: "branchName",
      });
    }
    if (routingClash) {
      return res.status(409).json({
        success: false,
        message: `Routing number "${trimmed.routingNumber}" is already in use`,
        field: "routingNumber",
      });
    }

    const branch = await prisma.bankBranch.create({
      data: {
        bankId,
        branchName: trimmed.branchName!,
        routingNumber: trimmed.routingNumber,
      },
    });

    res.status(201).json({ success: true, data: branch });
  } catch (error: any) {
    // Fallback for race conditions — Prisma's P2002 tells us which
    // constraint fired via error.meta.target
    if (error.code === "P2002") {
      const target: string[] = error.meta?.target ?? [];
      let field = "record";
      let message = "This branch conflicts with an existing one";

      if (target.includes("routingNumber")) {
        field = "routingNumber";
        message = "Routing number is already in use";
      } else if (target.includes("branchName") || target.some((t) => t.includes("bankId_branchName"))) {
        field = "branchName";
        message = "Branch already exists for this bank";
      }

      return res.status(409).json({ success: false, message, field });
    }
    res.status(500).json({ success: false, message: "Failed to create branch", error: error.message });
  }
};

/**
 * PATCH /banks/branches/:branchId
 * Partial update — any subset of { branchName, routingNumber, isActive }.
 */
export const updateBankBranch = async (req: Request, res: Response) => {
  try {
    const { branchId } = req.params;
    const { branchName, routingNumber, isActive } = req.body as {
      branchName?: string;
      routingNumber?: string;
      isActive?: boolean;
    };

    const existing = await prisma.bankBranch.findUnique({ where: { id: branchId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Branch not found" });
    }

    const trimmedName = branchName !== undefined ? branchName.trim() : undefined;
    const trimmedRouting = routingNumber !== undefined ? routingNumber.trim() || null : undefined;

    if (branchName !== undefined && !trimmedName) {
      return res.status(400).json({ success: false, message: "Branch name cannot be empty" });
    }

    if (trimmedName && trimmedName !== existing.branchName) {
      const nameClash = await prisma.bankBranch.findUnique({
        where: { bankId_branchName: { bankId: existing.bankId, branchName: trimmedName } },
        select: { id: true },
      });
      if (nameClash) {
        return res.status(409).json({
          success: false,
          message: `Branch "${trimmedName}" already exists for this bank`,
          field: "branchName",
        });
      }
    }
    if (trimmedRouting && trimmedRouting !== existing.routingNumber) {
      const routingClash = await prisma.bankBranch.findUnique({
        where: { routingNumber: trimmedRouting },
        select: { id: true },
      });
      if (routingClash) {
        return res.status(409).json({
          success: false,
          message: `Routing number "${trimmedRouting}" is already in use`,
          field: "routingNumber",
        });
      }
    }

    const branch = await prisma.bankBranch.update({
      where: { id: branchId },
      data: {
        branchName: trimmedName ?? existing.branchName,
        routingNumber: trimmedRouting !== undefined ? trimmedRouting : existing.routingNumber,
        isActive: isActive ?? existing.isActive,
      },
    });

    res.json({ success: true, data: branch });
  } catch (error: any) {
    if (error.code === "P2002") {
      const target: string[] = error.meta?.target ?? [];
      let field = "record";
      let message = "This branch conflicts with an existing one";
      if (target.includes("routingNumber")) {
        field = "routingNumber";
        message = "Routing number is already in use";
      } else if (target.some((t) => t.includes("branchName"))) {
        field = "branchName";
        message = "Branch already exists for this bank";
      }
      return res.status(409).json({ success: false, message, field });
    }
    res.status(500).json({ success: false, message: "Failed to update branch", error: error.message });
  }
};

/**
 * DELETE /banks/branches/:branchId
 * Soft delete: sets isActive = false. A branch already attached to a
 * VendorPaymentAccount / AdminPaymentAccount is left in place (those
 * rows keep pointing at it for history/audit) but it drops out of
 * every "select a branch" dropdown going forward.
 */
export const deleteBankBranch = async (req: Request, res: Response) => {
  try {
    const { branchId } = req.params;
    const existing = await prisma.bankBranch.findUnique({ where: { id: branchId } });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Branch not found" });
    }

    await prisma.bankBranch.update({ where: { id: branchId }, data: { isActive: false } });
    res.json({ success: true, message: "Branch deactivated" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: "Failed to deactivate branch", error: error.message });
  }
};