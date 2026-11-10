import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import fs from "fs";

/**
 * Generates the "stock intake" workbook — the bridge artifact between
 * bulk product upload (catalog only, no stock) and the Purchase Order
 * accounting flow (where WarehouseStock + ProductVariant.stock actually
 * get updated, in createPurchaseOrder()).
 *
 * Column layout is a 1:1 match with CreatePurchaseOrderDTO['items'] so the
 * re-upload on the PO form can map rows straight into `items[]` with zero
 * field translation.
 */

const prisma = new PrismaClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface GenerateStockIntakeOptions {
  lowStockThreshold?: number; // variants with stock <= this are "pending"
}

export interface StockIntakeTemplateResult {
  filePath: string;
  pendingVariantCount: number;
}

export async function generateStockIntakeTemplate(
  vendorId: string,
  opts: GenerateStockIntakeOptions = {},
): Promise<StockIntakeTemplateResult> {
  const lowStockThreshold = opts.lowStockThreshold ?? 0;

  const variants = await prisma.productVariant.findMany({
    where: {
      product: { vendorId },
      stock: { lte: lowStockThreshold },
    },
    select: {
      id: true,
      sku: true,
      name: true,
      stock: true,
      price: true,
      product: { select: { name: true } },
    },
    orderBy: { product: { name: "asc" } },
  });

  if (variants.length === 0) {
    throw new Error("No products are currently awaiting stock for this vendor.");
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "System";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Stock Intake");

  // ─── Columns ────────────────────────────────────────────────────────────
  // Read-only (gray) columns first so the vendor can find the right row by
  // eye. Variant ID is hidden but present so re-import matches rows without
  // a SKU lookup round-trip on the frontend.
  const columns: Array<{ header: string; key: string; width: number; editable?: boolean }> = [
    { header: "Variant ID", key: "variantId", width: 4 },
    { header: "Product Name", key: "productName", width: 34 },
    { header: "Variant Name", key: "variantName", width: 24 },
    { header: "SKU", key: "sku", width: 20 },
    { header: "Current Stock", key: "currentStock", width: 14 },
    { header: "Quantity Received *", key: "quantityReceived", width: 18, editable: true },
    { header: "Unit Cost *", key: "unitCost", width: 14, editable: true },
    { header: "Sell Price", key: "sellPrice", width: 14, editable: true },
    { header: "Expiry Date", key: "expiryDate", width: 16, editable: true },
  ];

  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getColumn("variantId").hidden = true;

  // ─── Header styling ───────────────────────────────────────────────────────
  const header = sheet.getRow(1);
  header.height = 32;
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  columns.forEach((col, i) => {
    const cell = header.getCell(i + 1);
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: col.editable ? "FFC0392B" : "FF888888" },
    };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  });

  // ─── Data rows ──────────────────────────────────────────────────────────
  variants.forEach((v) => {
    const row = sheet.addRow({
      variantId: v.id,
      productName: v.product.name,
      variantName: v.name ?? "",
      sku: v.sku,
      currentStock: v.stock,
      quantityReceived: "",
      unitCost: "",
      sellPrice: v.price ?? "",
      expiryDate: "",
    });
    ["productName", "variantName", "sku", "currentStock"].forEach((key) => {
      const colIndex = columns.findIndex((c) => c.key === key) + 1;
      row.getCell(colIndex).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF5F5F5" },
      };
    });
  });

  // ─── Validation on the required numeric columns ──────────────────────────
  const lastRow = variants.length + 1;
  ["quantityReceived", "unitCost"].forEach((key) => {
    const colIndex = columns.findIndex((c) => c.key === key) + 1;
    for (let r = 2; r <= lastRow; r++) {
      sheet.getCell(r, colIndex).dataValidation = {
        type: "decimal",
        allowBlank: true, // blank = "not part of this shipment"
        operator: "greaterThan",
        formulae: [0],
        showErrorMessage: true,
        errorTitle: "Invalid value",
        error: "Must be a number greater than 0, or left blank.",
      };
    }
  });

  sheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

  // ─── Instructions sheet ───────────────────────────────────────────────────
  const inst = workbook.addWorksheet("Instructions");
  inst.addRows([
    ["How this sheet works"],
    ["1. Every row is a product variant you uploaded that currently has 0 (or low) stock and isn't visible to buyers yet."],
    ["2. Fill in 'Quantity Received' and 'Unit Cost' for whatever arrived in this shipment. Leave a row blank if it isn't part of this delivery."],
    ["3. Re-upload this exact file on the 'Create Purchase Order' screen. Supplier, warehouse, VAT rate, and payment details are entered once for the whole order — not per row."],
    ["4. Do not edit Product Name, Variant Name, SKU, or Current Stock — these identify the row."],
  ]);
  inst.getColumn(1).width = 100;

  // ─── Save ─────────────────────────────────────────────────────────────────
  const templatesDir = join(__dirname, "..", "templates");
  if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });

  const fileName = `StockIntake_${vendorId}_${Date.now()}.xlsx`;
  const filePath = join(templatesDir, fileName);
  await workbook.xlsx.writeFile(filePath);

  return { filePath, pendingVariantCount: variants.length };
}