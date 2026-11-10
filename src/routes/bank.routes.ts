// src/routes/bank.routes.ts
import { Router } from "express";
import multer from "multer";
import { prisma } from "../config/prisma.ts";
import { BankTemplateController } from "../controllers/bank.template.controller.ts";
import { bulkImportBank } from "../controllers/bulkImportBank.controller.ts";
import {
  createBank,
  createBankBranch,
  updateBank,
  deleteBank,
  updateBankBranch,
  deleteBankBranch,
} from "../controllers/bank.controller.ts";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware.ts";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isXlsx =
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.originalname.toLowerCase().endsWith(".xlsx");
    cb(isXlsx ? null : new Error("Only .xlsx files are accepted."), isXlsx);
  },
});

const router = Router();
router.post("/", authenticateUser, authorizeRoles("ADMIN"), createBank);
router.patch("/:bankId", authenticateUser, authorizeRoles("ADMIN"), updateBank);
router.delete("/:bankId", authenticateUser, authorizeRoles("ADMIN"), deleteBank);

router.post("/:bankId/branches", authenticateUser, authorizeRoles("ADMIN"), createBankBranch);

// Public/authenticated read — powers the vendor/admin "select a bank" dropdown
router.get("/", authenticateUser, async (_req, res) => {
  const banks = await prisma.bank.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  res.json({ success: true, data: banks });
});

// GET /banks/:bankId/branches — flat, no pagination, for cascading dropdowns
router.get("/:bankId/branches", authenticateUser, async (req, res) => {
  try {
    const { bankId } = req.params;

    const bank = await prisma.bank.findUnique({ where: { id: bankId } });
    if (!bank) {
      return res.status(404).json({ success: false, message: "Bank not found" });
    }

    const branches = await prisma.bankBranch.findMany({
      where: { bankId, isActive: true },
      orderBy: [{ branchName: "asc" }],
    });

    res.json({ success: true, data: branches });
  } catch (error: any) {
    res.status(500).json({ success: false, message: "Failed to fetch branches", error: error.message });
  }
});

// GET /banks/branches — filterable, paginated list for the table
router.get("/branches", authenticateUser, async (req, res) => {
  const {
    bankName,
    branchName,
    routingNumber,
    page = "1",
    limit = "10",
  } = req.query as Record<string, string>;

  const pageNum = Math.max(parseInt(page) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit) || 10, 1), 100);
  const skip = (pageNum - 1) * limitNum;

  const where = {
    isActive: true,
    ...(bankName ? { bank: { name: { contains: bankName, mode: "insensitive" as const } } } : {}),
    ...(branchName ? { branchName: { contains: branchName, mode: "insensitive" as const } } : {}),
    ...(routingNumber ? { routingNumber: { contains: routingNumber } } : {}),
  };

  const [branches, total] = await Promise.all([
    prisma.bankBranch.findMany({
      where,
      include: { bank: { select: { name: true } } },
      orderBy: [{ bank: { name: "asc" } }, { branchName: "asc" }],
      skip,
      take: limitNum,
    }),
    prisma.bankBranch.count({ where }),
  ]);

  res.json({
    success: true,
    data: branches.map((b) => ({
      id: b.id,
      bankId: b.bankId,
      bankName: b.bank.name,
      branchName: b.branchName,
      routingNumber: b.routingNumber,
      isActive: b.isActive,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    })),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum),
    },
  });
});

// GET /banks/branches/:branchId — single branch (and its bank) detail
router.get("/branches/:branchId", authenticateUser, async (req, res) => {
  const branch = await prisma.bankBranch.findUnique({
    where: { id: req.params.branchId },
    include: { bank: true },
  });
  if (!branch) {
    return res.status(404).json({ success: false, message: "Branch not found" });
  }
  res.json({
    success: true,
    data: {
      id: branch.id,
      bankId: branch.bankId,
      bankName: branch.bank.name,
      branchName: branch.branchName,
      routingNumber: branch.routingNumber,
      isActive: branch.isActive,
      createdAt: branch.createdAt,
      updatedAt: branch.updatedAt,
    },
  });
});

router.patch("/branches/:branchId", authenticateUser, authorizeRoles("ADMIN"), updateBankBranch);
router.delete("/branches/:branchId", authenticateUser, authorizeRoles("ADMIN"), deleteBankBranch);

// Admin-only management
router.get("/template/download", authenticateUser, authorizeRoles("ADMIN"), BankTemplateController.downloadTemplate);
router.post("/bulk-import", authenticateUser, authorizeRoles("ADMIN"), upload.single("file"), bulkImportBank);

export default router;