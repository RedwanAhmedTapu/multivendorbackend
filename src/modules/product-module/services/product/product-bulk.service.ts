// services/product/product-bulk.service.ts
import ExcelJS from "exceljs";
import { prisma } from "../../../../config/prisma.ts";
import { ProductCoreService } from "./product-core.service.ts";
import { invalidateProductCache } from "../../../../config/cache.ts";
import { AppError } from "../../utils/response.ts";

/**
 * NOTE ON ASSUMPTIONS
 * -------------------
 * This file mirrors the field names / shapes used in product-core.service.ts's
 * `create()` (CreateProductInput) and in bulkproductTemplate.service.ts's
 * column headers. If your `createProductSchema` (validators/product.validator.ts)
 * or Prisma models differ slightly (e.g. warranty enum casing), adjust the
 * small mapping helpers below — the row-parsing / grouping logic is the part
 * that matters and shouldn't need to change.
 */

interface RowData {
  [key: string]: any;
  __row: number;
}

interface GroupResult {
  groupKey: string;
  rowNumbers: number[];
  productName: string;
  success: boolean;
  productId?: string;
  slug?: string;
  error?: string;
}

/* ✅ NEW: Category-service-style detailed reporting */
export interface RowError {
  row: number;
  message: string;
}

export interface ProductRowDetail {
  row: number;
  status: "imported" | "failed";
  productName: string;
  groupKey: string;
  message?: string;
  productId?: string;
  slug?: string;
}

export interface BulkImportSummary {
  totalRows: number;
  totalGroups: number;
  created: number;
  failed: number;
  results: GroupResult[];
  errors: RowError[];           // ✅ flat error list for quick scanning
  warnings: string[];           // ✅ non-fatal issues
  rowDetails: ProductRowDetail[]; // ✅ per-row status like category service
}

const WARRANTY_TYPE_VALUES = new Set([
  "FINIXMART_WARRANTY",
  "LOCAL_WARRANTY",
  "AGENT_WARRANTY",
  "BRAND_WARRANTY",
  "SELLER_WARRANTY",
  "LOCAL_SELLER_WARRANTY",
  "INTERNATIONAL_WARRANTY",
  "INTERNATIONAL_MANUFACTURER_WARRANTY",
  "INTERNATIONAL_SELLER_WARRANTY",
  "NON_LOCAL_WARRANTY",
  "NO_WARRANTY",
  "NOT_APPLICABLE",
  "ORIGINAL_PRODUCT",
]);

/** ✅ NEW: Simple concurrency limiter — runs up to `limit` promises in parallel. */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

export class BulkProductService {
  /**
   * Entry point: vendor uploads a filled copy of the category's Excel
   * template. We validate + group rows into products and create each one
   * through ProductCoreService.create() so bulk-created products go through
   * PENDING approval / slug generation / audit logging exactly like a
   * manually created product does. Nothing here touches WarehouseStock —
   * stock still only ever comes from a received Purchase Order.
   *
   * PERFORMANCE NOTE:
   * -----------------
   * Groups are processed with a concurrency limit (default 5) so multiple
   * products are created in parallel instead of sequentially.  For truly
   * massive bulk imports (e.g. 5 000 products) you should either:
   *   1. Optimize ProductCoreService.create() for bulk use (createMany, batch audit logs)
   *   2. Move the import to a background job queue (BullMQ / Redis).
   */
  static async importFromExcel(
    vendorId: string,
    userId: string | undefined,
    categoryId: string,
    fileBuffer: Buffer,
  ): Promise<BulkImportSummary> {
    const category = await prisma.category.findUnique({
      where: { id: categoryId },
      include: {
        attributes: { include: { attribute: { include: { values: true } } } },
        children: true,
      },
    });
    if (!category) throw new AppError("Category not found", 404);
    if (category.children?.length)
      throw new AppError("Selected category is not a leaf category", 400);

    const productAttrs: any[] = [];
    const variantAttrs: any[] = [];

    for (const catAttr of category.attributes) {
      const attr = catAttr.attribute;

      // Brand is handled separately through Product.brandId.
      // Do not treat Brand as a normal category attribute.
      if (attr.name?.trim().toLowerCase() === "brand") {
        continue;
      }

      const isVariantAttr = attr.type === "SELECT" && attr.values.length > 1;
      (isVariantAttr ? variantAttrs : productAttrs).push(catAttr);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer as any);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new AppError("Uploaded file has no worksheet", 400);

    const headerToCol: Record<string, number> = {};
    sheet.getRow(1).eachCell((cell, colNumber) => {
      const raw = String(cell.value ?? "")
        .replace(/[\s*🔄]+$/gu, "")
        .trim();
      headerToCol[raw] = colNumber;
    });

    const getCell = (row: ExcelJS.Row, header: string) => {
      const col = headerToCol[header];
      if (!col) return undefined;
      const v = row.getCell(col).value;
      if (v && typeof v === "object" && "text" in (v as any))
        return (v as any).text; // rich text
      if (v && typeof v === "object" && "result" in (v as any))
        return (v as any).result; // formula
      return v;
    };

    const rows: RowData[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const name = getCell(row, "Product Name");
      if (name === undefined || name === null || String(name).trim() === "")
        return; // skip blank rows
      const data: RowData = { __row: rowNumber };
      Object.keys(headerToCol).forEach((h) => (data[h] = getCell(row, h)));
      rows.push(data);
    });

    if (!rows.length)
      throw new AppError("No data rows found in the uploaded file", 400);

    // ✅ NEW: Pre-validation — duplicate SKU check (fast, zero DB calls)
    const skuToRow = new Map<string, number>();
    for (const row of rows) {
      const sku = String(row["SKU"] ?? "").trim();
      if (!sku) continue;
      if (skuToRow.has(sku)) {
        throw new AppError(
          `Duplicate SKU "${sku}" found at rows ${skuToRow.get(sku)} and ${row.__row}. Every SKU must be unique.`,
          400,
        );
      }
      skuToRow.set(sku, row.__row);
    }

    // ── group rows into products by "Variant Group No"; ungrouped rows = standalone products ──
    const groups = new Map<string, RowData[]>();
    let standaloneCounter = 0;
    for (const row of rows) {
      const groupNo = row["Variant Group No"];
      const key =
        groupNo !== undefined &&
        groupNo !== null &&
        String(groupNo).trim() !== ""
          ? `G${groupNo}`
          : `S${++standaloneCounter}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    const results: GroupResult[] = [];
    const rowDetails: ProductRowDetail[] = [];
    const errors: RowError[] = [];
    const warnings: string[] = [];
    const createdProducts: { id: string; slug: string }[] = [];

    // Tunable concurrency — increase if your DB / ProductCoreService can handle it
    // without connection-pool exhaustion.
    const CONCURRENCY = 5;

    const groupEntries = Array.from(groups.entries());

    // ✅ NEW: Parallel processing with controlled concurrency
    await runWithConcurrency(
      groupEntries,
      CONCURRENCY,
      async ([groupKey, groupRows]) => {
        const rowNumbers = groupRows.map((r) => r.__row);
        const productName = String(groupRows[0]["Product Name"] ?? "");

        try {
          const { id, slug } = await this.createOneGroup(
            vendorId,
            userId,
            categoryId,
            productAttrs,
            variantAttrs,
            groupRows,
          );

          results.push({
            groupKey,
            rowNumbers,
            productName,
            success: true,
            productId: id,
            slug,
          });

          // ✅ Category-service-style per-row success record
          for (const rowNum of rowNumbers) {
            rowDetails.push({
              row: rowNum,
              status: "imported",
              productName,
              groupKey,
              productId: id,
              slug,
            });
          }

          createdProducts.push({ id, slug });
        } catch (err: any) {
          const message = err?.message ?? "Unknown error";
          results.push({
            groupKey,
            rowNumbers,
            productName,
            success: false,
            error: message,
          });

          // ✅ Category-service-style per-row failure record
          for (const rowNum of rowNumbers) {
            rowDetails.push({
              row: rowNum,
              status: "failed",
              productName,
              groupKey,
              message,
            });
            errors.push({ row: rowNum, message });
          }
        }
      },
    );

    // ✅ NEW: Batch cache invalidation at the end (instead of per-product)
    for (const { id, slug } of createdProducts) {
      try {
        await invalidateProductCache({ productId: id, slug, vendorId });
      } catch {
        warnings.push(`Cache invalidation failed for product ${slug}`);
      }
    }

    return {
      totalRows: rows.length,
      totalGroups: groups.size,
      created: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
      errors,
      warnings,
      rowDetails,
    };
  }

  private static async createOneGroup(
    vendorId: string,
    userId: string | undefined,
    categoryId: string,
    productAttrs: any[],
    variantAttrs: any[],
    rows: RowData[],
  ): Promise<{ id: string; slug: string }> {
    const first = rows[0];
    const name = String(first["Product Name"] ?? "").trim();
    if (!name) throw new AppError("Product Name is required", 400);

    const attributes = this.buildAttributePayload(productAttrs, first, false);

    const variants = rows.map((row) => {
      const sku = String(row["SKU"] ?? "").trim();
      if (!sku) throw new AppError(`Row ${row.__row}: SKU is required`, 400);

      const imageUrlsRaw = String(row["Image URLs"] ?? "").trim();
      const images = imageUrlsRaw
        ? imageUrlsRaw
            .split(",")
            .map((u) => u.trim())
            .filter(Boolean)
            .map((url, idx) => ({ url, sortOrder: idx }))
        : undefined;

      const variantAttrValues = this.buildAttributePayload(
        variantAttrs,
        row,
        true,
      );
      const variantLabel = variantAttrs
        .map((a) => row[a.attribute.name])
        .filter((v) => v !== undefined && v !== null && v !== "")
        .join(" / ");

      return {
        name: variantLabel || sku,
        sku,
        availability: this.parseBoolean(row["Availability"], true),
        attributes: variantAttrValues,
        images,
        __row: row.__row,
        // ✅ REMOVED: __price, __specialPrice, __reorderLevel
        // Price management will happen at Purchase time.
      };
    });

    const taxRate = this.parseNumber(first["Tax Rate"]) ?? 0;
    const dangerousRaw = String(
      first["Dangerous Goods"] ?? "NONE",
    ).toUpperCase();
    const warrantyTypeRaw = String(first["Warranty Type"] ?? "").toUpperCase();

    const input: any = {
      name,
      nameBn: first["Product Name (Bangla)"] || undefined,
      description: first["Description"] || undefined,
      categoryId,
      brandId: this.extractBrandId(first["Brand"]),
      taxRate,
      attributes,
      variants: variants.map(({ __row, ...v }) => v),
      shippingWarranty: {
        packageWeightValue: this.requireNumber(first, "Package Weight"),
        packageWeightUnit: String(first["Package Weight Unit"] ?? "KG"),
        packageLength: this.requireNumber(first, "Package Length (cm)"),
        packageWidth: this.requireNumber(first, "Package Width (cm)"),
        packageHeight: this.requireNumber(first, "Package Height (cm)"),
        dangerousGoods: dangerousRaw === "CONTAINS" ? "contains" : "none",
        warrantyPeriodValue: this.parseNumber(first["Warranty Duration"]) ?? 0,
        warrantyPeriodUnit: String(first["Warranty Unit"] ?? "MONTHS"),
        warrantyDetails: first["Warranty Policy"] || undefined,
        warrantyType: WARRANTY_TYPE_VALUES.has(warrantyTypeRaw)
          ? warrantyTypeRaw
          : "NOT_APPLICABLE",
      },
    };

    // product-level images: fall back to the first variant's images if no dedicated product images exist
    input.images = variants[0]?.images?.length
      ? variants[0].images
      : [
          {
            url: "https://via.placeholder.com/600",
            altText: name,
            sortOrder: 0,
          },
        ];

    const created = await ProductCoreService.create(vendorId, userId, input);
    if (!created) throw new AppError("Product creation failed", 500);

    // ✅ REMOVED: Two-step price / specialPrice / reorderLevel update block.
    // Price management will happen at Purchase time.

    // ✅ REMOVED: Per-product cache invalidation — moved to batch at the end.

    return { id: created.id, slug: (created as any).slug };
  }

  private static buildAttributePayload(
    catAttrs: any[],
    row: RowData,
    isForVariant: boolean,
  ) {
    const out: any[] = [];
    for (const catAttr of catAttrs) {
      const attr = catAttr.attribute;
      const raw = row[attr.name];
      if (raw === undefined || raw === null || raw === "") {
        if (catAttr.isRequired)
          throw new AppError(
            `Row ${row.__row}: "${attr.name}" is required`,
            400,
          );
        continue;
      }
      const payload: any = { attributeId: attr.id, isForVariant };
      if (attr.type === "SELECT") {
        const match = attr.values.find(
          (v: any) => v.value === String(raw).trim(),
        );
        if (!match)
          throw new AppError(
            `Row ${row.__row}: invalid value "${raw}" for "${attr.name}"`,
            400,
          );
        payload.attributeValueId = match.id;
      } else if (attr.type === "NUMBER") {
        payload.valueNumber = Number(raw);
      } else if (attr.type === "BOOLEAN") {
        payload.valueBoolean = this.parseBoolean(raw, false);
      } else {
        payload.valueString = String(raw);
      }
      out.push(payload);
    }
    return out;
  }

  private static extractBrandId(raw: any): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    const str = String(raw).trim();
    if (!str) return undefined;
    const match = str.match(/\(([^)]+)\)\s*$/);
    return match ? match[1].trim() : str;
  }

  private static parseNumber(v: any): number | undefined {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }

  private static requireNumber(row: RowData, header: string): number {
    const n = this.parseNumber(row[header]);
    if (n === undefined)
      throw new AppError(`Row ${row.__row}: "${header}" is required`, 400);
    return n;
  }

  private static parseBoolean(v: any, fallback: boolean): boolean {
    if (v === undefined || v === null || v === "") return fallback;
    const s = String(v).trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
}