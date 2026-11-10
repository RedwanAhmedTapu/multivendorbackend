// src/services/bulkImportBankService.ts
import ExcelJS from "exceljs";
import { prisma } from "../config/prisma.ts";

interface BranchRow {
  rowNumber: number;
  bankName: string;
  branchName: string;
  routingNumber?: string;
}

interface RowError {
  row: number;
  message: string;
}

interface ImportSummary {
  imported: number;
  failed: number;
  errors: RowError[];
  banksCreated: number;
}

const ROUTING_NUMBER_REGEX = /^\d{9}$/;
const PRISMA_UNIQUE_VIOLATION = "P2002";

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "text" in (value as any)) return String((value as any).text).trim();
  if (typeof value === "object" && "result" in (value as any)) return String((value as any).result ?? "").trim();
  return String(value).trim();
}

export const BulkImportBankService = {
  async importFromBuffer(buffer: Buffer): Promise<ImportSummary> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheet = workbook.getWorksheet("Branches") || workbook.worksheets[0];
    if (!sheet) {
      throw new Error("No worksheet found in the uploaded file.");
    }

    const rows: BranchRow[] = [];
    const errors: RowError[] = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const values = row.values as ExcelJS.CellValue[]; // 1-indexed, [0] unused

      const bankName = cellText(values[1]);
      const branchName = cellText(values[2]);
      const routingNumberRaw = cellText(values[3]);

      // Skip fully blank rows
      if (!bankName && !branchName && !routingNumberRaw) {
        return;
      }

      // Skip placeholder/example rows like "<BRANCH_NAME>"
      if (bankName.startsWith("<") || branchName.startsWith("<")) {
        return;
      }

      const missing: string[] = [];
      if (!bankName) missing.push("Bank Name");
      if (!branchName) missing.push("Branch Name");

      if (missing.length > 0) {
        errors.push({ row: rowNumber, message: `Missing required field(s): ${missing.join(", ")}` });
        return;
      }

      let routingNumber: string | undefined;
      if (routingNumberRaw) {
        if (!ROUTING_NUMBER_REGEX.test(routingNumberRaw)) {
          errors.push({
            row: rowNumber,
            message: `Routing Number "${routingNumberRaw}" must be exactly 9 digits, or left blank.`,
          });
          return;
        }
        routingNumber = routingNumberRaw;
      }

      rows.push({
        rowNumber,
        bankName,
        branchName,
        routingNumber,
      });
    });

    if (rows.length === 0) {
      return { imported: 0, failed: errors.length, errors, banksCreated: 0 };
    }

    // ── Guard against duplicates WITHIN this file ──────────────────────────
    const seenBranchKey = new Set<string>();
    const seenRoutingNumber = new Map<string, number>(); // routingNumber -> first rowNumber seen
    const badRowNumbers = new Set<number>();

    for (const r of rows) {
      const branchKey = `${r.bankName.toLowerCase()}::${r.branchName.toLowerCase()}`;
      if (seenBranchKey.has(branchKey)) {
        errors.push({
          row: r.rowNumber,
          message: `Duplicate branch "${r.branchName}" for bank "${r.bankName}" elsewhere in this file.`,
        });
        badRowNumbers.add(r.rowNumber);
      }
      seenBranchKey.add(branchKey);

      if (r.routingNumber) {
        const firstRow = seenRoutingNumber.get(r.routingNumber);
        if (firstRow !== undefined) {
          errors.push({
            row: r.rowNumber,
            message: `Routing Number "${r.routingNumber}" is also used on row ${firstRow} in this file — routing numbers must be unique.`,
          });
          badRowNumbers.add(r.rowNumber);
        } else {
          seenRoutingNumber.set(r.routingNumber, r.rowNumber);
        }
      }
    }

    const cleanRows = rows.filter((r) => !badRowNumbers.has(r.rowNumber));

    let imported = 0;
    let banksCreated = 0;

    // ── Persist each clean row ──────────────────────────────────────────────
    for (const r of cleanRows) {
      try {
        await prisma.$transaction(async (tx) => {
          let bank = await tx.bank.findUnique({ where: { name: r.bankName } });
          if (!bank) {
            bank = await tx.bank.create({ data: { name: r.bankName } });
            banksCreated += 1;
          }

          await tx.bankBranch.upsert({
            where: { bankId_branchName: { bankId: bank.id, branchName: r.branchName } },
            update: {
              routingNumber: r.routingNumber,
            },
            create: {
              bankId: bank.id,
              branchName: r.branchName,
              routingNumber: r.routingNumber,
            },
          });
        });
        imported += 1;
      } catch (err: any) {
        // Routing number already belongs to a different, already-saved branch
        // (unique constraint kicks in here, not just the in-file check above).
        if (err.code === PRISMA_UNIQUE_VIOLATION && err.meta?.target?.includes?.("routingNumber")) {
          errors.push({
            row: r.rowNumber,
            message: `Routing Number "${r.routingNumber}" is already assigned to another branch in the database.`,
          });
        } else {
          errors.push({ row: r.rowNumber, message: err.message || "Failed to save this row." });
        }
      }
    }

    return { imported, failed: errors.length, errors, banksCreated };
  },
};