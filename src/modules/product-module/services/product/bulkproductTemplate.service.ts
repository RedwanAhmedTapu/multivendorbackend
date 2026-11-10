import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, promises as fs } from "fs";

export interface ColumnConfig {
  header: string;
  key: string;
  width: number;
  type: "TEXT" | "NUMBER" | "BOOLEAN" | "SELECT";
  isRequired: boolean;
  isVariantAttribute?: boolean;
  values?: string[];
  description?: string;
}

export interface TemplateResponse {
  filePath: string;
  templateRecord: {
    id: string;
    categoryId: string;
    filePath: string;
    createdAt: Date;
    updatedAt: Date;
  };
}

const prisma = new PrismaClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class TemplateService {
  async getCategoryTemplateData(categoryId: string) {
    try {
      const category = await prisma.category.findUnique({
        where: { id: categoryId },
        include: {
          attributes: {
            include: {
              attribute: {
                include: {
                  values: true,
                },
              },
            },
            orderBy: { sortOrder: "asc" },
          },
          children: true,
        },
      });

      if (!category)
        throw new Error(`Category with ID ${categoryId} not found`);
      if (category.children && category.children.length > 0)
        throw new Error("Selected category is not a leaf category");

      return category;
    } catch (error) {
      console.error("Error fetching category data:", error);
      throw error;
    }
  }

  async generateExcelTemplate(
    categoryId: string,
    vendorId: string, // 👈 নতুন প্যারামিটার — active brand fetch করতে লাগবে
  ): Promise<TemplateResponse> {
    const WARRANTY_TYPE_VALUES = [
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
    ];

    try {
      const category = await this.getCategoryTemplateData(categoryId);

      // Regenerating a template for a category that already had one would
      // otherwise leave the old file orphaned on disk forever (each file
      // name is timestamped, so upserting the DB record alone doesn't
      // remove the previous physical file). Clean it up first.
      const existingRecord = await prisma.categoryTemplate.findUnique({
        where: { categoryId },
      });
      if (existingRecord?.filePath) {
        await fs.unlink(existingRecord.filePath).catch(() => {
          // File may already be gone (e.g. cleaned up after a previous download) — safe to ignore.
        });
      }

      // ─── Fetch this vendor's active/approved brands for the dropdown ────
      // Works for VENDOR role AND EMPLOYEE role — the controller resolves
      // req.user.vendorId for both cases (see authenticateUser middleware),
      // so this query is agnostic to which one called it.
      const activeBrands = await prisma.brand.findMany({
        where: { vendorId, status: "APPROVED" }, // ⚠️ confirm "APPROVED" matches your BrandStatus enum
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });

      // Dropdown shows "Name (id)" so the vendor can pick by recognizable
      // name, while the actual id needed by ProductCoreService.create() is
      // still recoverable from the cell value (extract via regex on import).
      const brandDropdownValues = activeBrands.map(
        (b) => `${b.name} (${b.id})`,
      );
      const hasBrands = activeBrands.length > 0;

      const workbook = new ExcelJS.Workbook();
      workbook.creator = "System";
      workbook.created = new Date();

      const worksheet = workbook.addWorksheet(`${category.name} Products`);

      // ─── SECTION 1: Basic product info ───────────────────────────────────
      // NOTE: Stock quantities are NOT included here. Inventory (WarehouseStock)
      // is managed through the Purchase Order flow, not bulk product upload.
      // reorderLevel IS included as it's a static threshold, not a live count.
      //
      // "Brand ID" is now a required SELECT populated from this vendor's
      // approved brands — vendors can no longer type an arbitrary/invalid
      // brand id, and every product must be tied to an approved brand.
      const basicInfoColumns: ColumnConfig[] = [
        {
          header: "Variant Group No",
          key: "variantGroupNo",
          width: 20,
          type: "NUMBER",
          isRequired: false,
          description:
            "Same number for rows that belong to the same product with variants. " +
            "Example: Red T-Shirt (Group 1), Blue T-Shirt (Group 1). " +
            "Leave empty for standalone products with no variants.",
        },
        {
          header: "Product Name",
          key: "name",
          width: 35,
          type: "TEXT",
          isRequired: true,
          description:
            "Display name of the product. Must be the same for all variant rows in the same group.",
        },
        {
          header: "Product Name (Bangla)",
          key: "nameBn",
          width: 35,
          type: "TEXT",
          isRequired: false,
          description: "Optional Bangla translation of the product name.",
        },
        {
          header: "Description",
          key: "description",
          width: 55,
          type: "TEXT",
          isRequired: false,
          description:
            "Detailed product description. Same for all variants in a group.",
        },
        {
          header: "Brand",
          key: "brandId",
          width: 32,
          type: hasBrands ? "SELECT" : "TEXT",
          values: brandDropdownValues,
          isRequired: true,
          description: hasBrands
            ? "Select one of your approved brands from the dropdown (format: 'Name (id)'). " +
              "Same brand for all variant rows in the same group. " +
              "Every product must have a brand — get a brand approved first if the dropdown is empty."
            : "You have no approved brands yet. Register a brand and get it approved before uploading products.",
        },
      ];

      // ─── SECTION 2: Variant-level fields ─────────────────────────────────
      // price / specialPrice / availability / reorderLevel live on ProductVariant.
      // Stock (WarehouseStock.quantity) is intentionally excluded — it is
      // populated when a PurchaseOrder is received, not during product creation.
      //
      // "Tax Rate" was added here — ProductCoreService.create() reads
      // input.taxRate and applies it to every variant, but the original
      // template had no column feeding that field (it silently defaulted
      // to undefined/0 with no way for the vendor to set it).
      const variantCoreColumns: ColumnConfig[] = [
        {
          header: "SKU",
          key: "sku",
          width: 22,
          type: "TEXT",
          isRequired: true,
          description:
            "Unique Stock Keeping Unit for this specific variant. " +
            "Must be globally unique. Suggested format: BRAND-PRODUCT-COLOR-SIZE",
        },
        {
          header: "Availability",
          key: "availability",
          width: 18,
          type: "BOOLEAN",
          isRequired: true,
          description:
            "Whether this variant is visible and purchasable on the storefront (true / false).",
        },
        {
          header: "Price",
          key: "price",
          width: 16,
          type: "NUMBER",
          isRequired: true,
          description:
            "Regular selling price of this variant. Must be > 0 and greater than Special Price if provided. " +
            "NOTE: products are created first with price 0 (same as manual creation), then this price is " +
            "applied to the variant as a second step by the bulk importer — matching the vendor's " +
            "PATCH .../variants/:id/price flow.",
        },
        {
          header: "Special Price",
          key: "specialPrice",
          width: 16,
          type: "NUMBER",
          isRequired: false,
          description:
            "Discounted price. Must be between 20 % and 100 % of Price (max 80 % discount). " +
            "Leave blank if no discount applies.",
        },
        {
          header: "Tax Rate",
          key: "taxRate",
          width: 16,
          type: "NUMBER",
          isRequired: false,
          description:
            "Tax rate percentage applied to this product's variants (e.g. 5 for 5%). Defaults to 0 if left blank. " +
            "Same value is used for every variant row in a group.",
        },
        {
          header: "Reorder Level",
          key: "reorderLevel",
          width: 18,
          type: "NUMBER",
          isRequired: false,
          description:
            "Minimum stock threshold that triggers a low-stock alert. Default is 10 if left blank. " +
            "NOTE: Actual stock quantities are managed via Purchase Orders, not this template.",
        },
      ];

      // ─── SECTION 3: Package & Warranty ───────────────────────────────────
      const packageWarrantyColumns: ColumnConfig[] = [
        {
          header: "Image URLs",
          key: "imageUrls",
          width: 55,
          type: "TEXT",
          isRequired: false,
          description:
            "Comma-separated list of publicly accessible image URLs for this variant.",
        },
        {
          header: "Package Weight",
          key: "packageWeight",
          width: 20,
          type: "NUMBER",
          isRequired: true,
          description: "Weight of the packaged product.",
        },
        {
          header: "Package Weight Unit",
          key: "packageWeightUnit",
          width: 22,
          type: "SELECT",
          values: ["KG", "G"],
          isRequired: true,
          description: "Unit for package weight: KG or G.",
        },
        {
          header: "Package Length (cm)",
          key: "packageLength",
          width: 22,
          type: "NUMBER",
          isRequired: true,
          description: "Package length in centimetres.",
        },
        {
          header: "Package Width (cm)",
          key: "packageWidth",
          width: 22,
          type: "NUMBER",
          isRequired: true,
          description: "Package width in centimetres.",
        },
        {
          header: "Package Height (cm)",
          key: "packageHeight",
          width: 22,
          type: "NUMBER",
          isRequired: true,
          description: "Package height in centimetres.",
        },
        {
          header: "Dangerous Goods",
          key: "dangerousGoods",
          width: 20,
          type: "SELECT",
          values: ["NONE", "CONTAINS"],
          isRequired: true,
          description:
            "Whether the package contains dangerous / hazardous goods.",
        },
        {
          header: "Warranty Duration",
          key: "warrantyDuration",
          width: 20,
          type: "NUMBER",
          isRequired: false,
          description:
            "Numeric duration of the warranty (e.g. 12). Leave blank for no warranty.",
        },
        {
          header: "Warranty Unit",
          key: "warrantyUnit",
          width: 18,
          type: "SELECT",
          values: ["DAYS", "MONTHS", "YEARS"],
          isRequired: false,
          description: "Time unit for the warranty duration.",
        },
        {
          header: "Warranty Type",
          key: "warrantyType",
          width: 28,
          type: "SELECT",
          values: WARRANTY_TYPE_VALUES,
          isRequired: false,
          description: "Category of warranty offered.",
        },
        {
          header: "Warranty Policy",
          key: "warrantyPolicy",
          width: 55,
          type: "TEXT",
          isRequired: false,
          description: "Free-text description of the warranty terms.",
        },
      ];

      // ─── Separate category attributes into product-level vs variant-level ─
      const productAttributes: ColumnConfig[] = [];
      const variantAttributes: ColumnConfig[] = [];

      category.attributes.forEach((attr) => {
         if (
    attr.isRequired &&
    attr.attribute.type === "SELECT" &&
    attr.attribute.values.length === 0
  ) {
    throw new Error(
      `Category attribute "${attr.attribute.name}" is required + SELECT type but has no values. Add AttributeValue rows first.`
    );
  }
        const isVariantAttr =
          attr.attribute.type === "SELECT" && attr.attribute.values.length > 1;

        const columnConfig: ColumnConfig = {
          header: attr.attribute.name,
          key: attr.attribute.slug,
          width: 22,
          type: attr.attribute.type,
          values:
            attr.attribute.type === "SELECT"
              ? attr.attribute.values.map((v) => v.value)
              : [],
          isRequired: attr.isRequired,
          isVariantAttribute: isVariantAttr,
          description:
            `${attr.attribute.name}` +
            (attr.attribute.unit ? ` (${attr.attribute.unit})` : "") +
            `. ${attr.isRequired ? "Required" : "Optional"}.` +
            (isVariantAttr
              ? " 🔄 VARIANT ATTRIBUTE — different values create different variants."
              : " 📦 PRODUCT ATTRIBUTE — same value for all variants in a group."),
        };

        if (isVariantAttr) {
          variantAttributes.push(columnConfig);
        } else {
          productAttributes.push(columnConfig);
        }
      });

      // ─── Assemble final column order ──────────────────────────────────────
      // Basic info → product attrs → variant attrs → variant core → pkg/warranty
      const columns: ColumnConfig[] = [
        ...basicInfoColumns,
        ...productAttributes,
        ...variantAttributes,
        ...variantCoreColumns,
        ...packageWarrantyColumns,
      ];

      // ─── Set worksheet columns ────────────────────────────────────────────
      worksheet.columns = columns.map((col) => {
        let header = col.header;
        if (col.isRequired) header += " *";
        if (col.isVariantAttribute) header += " 🔄";
        return { header, key: col.key, width: col.width };
      });

      // ─── Style header row ─────────────────────────────────────────────────
      const headerRow = worksheet.getRow(1);
      headerRow.height = 42;
      headerRow.alignment = {
        vertical: "middle",
        horizontal: "center",
        wrapText: true,
      };

      columns.forEach((col, index) => {
        const cell = headerRow.getCell(index + 1);

        if (col.isVariantAttribute) {
          // Purple — variant attribute
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF7B2D8B" },
          };
        } else if (col.isRequired) {
          // Red — required field
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFC0392B" },
          };
        } else {
          // Steel blue — optional field
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF2E75B6" },
          };
        }

        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        cell.border = {
          top: { style: "thin", color: { argb: "FF000000" } },
          left: { style: "thin", color: { argb: "FF000000" } },
          bottom: { style: "thin", color: { argb: "FF000000" } },
          right: { style: "thin", color: { argb: "FF000000" } },
        };

        // ── Tooltip note ──
        // NOTE: exceljs has no public API to size the note box — the
        // official PR that added it (github.com/exceljs/exceljs/pull/2782)
        // was closed unmerged. Excel always renders notes at a small
        // fixed default size, so long text gets visually clipped. Fix:
        // keep the note itself to one short line and push full detail to
        // the "📋 Instructions" sheet instead of trying to fit everything here.
        let noteHeader = col.isVariantAttribute
          ? "🔄 VARIANT"
          : col.isRequired
            ? "⚠️ REQUIRED"
            : "Optional";

        const shortHint =
          col.type === "SELECT" && col.values?.length
            ? `Choose from dropdown (${col.values.length} options).`
            : `Type: ${col.type}.`;

        cell.note = {
          texts: [
            {
              text: `${noteHeader} — ${shortHint} See "📋 Instructions" sheet for full details.`,
            },
          ],
          margins: { insetmode: "custom", inset: [0.1, 0.1, 0.1, 0.1] },
        };
      });

      // ─── Data validation (rows 2–1001) ────────────────────────────────────
      columns.forEach((col, index) => {
        const colLetter = this.columnIndexToLetter(index);

        if (col.key === "price") {
          for (let r = 2; r <= 1001; r++) {
            const spIdx = columns.findIndex((c) => c.key === "specialPrice");
            const spLetter = this.columnIndexToLetter(spIdx);
            worksheet.getCell(r, index + 1).dataValidation = {
              type: "custom",
              allowBlank: false,
              formulae: [
                `AND(${colLetter}${r}>0,OR(${spLetter}${r}="",${spLetter}${r}=0,${colLetter}${r}>${spLetter}${r}))`,
              ],
              showErrorMessage: true,
              errorStyle: "error",
              errorTitle: "Invalid Price",
              error:
                "Price must be > 0 and greater than Special Price (if provided).",
            };
          }
        } else if (col.key === "specialPrice") {
          for (let r = 2; r <= 1001; r++) {
            const priceIdx = columns.findIndex((c) => c.key === "price");
            const priceLetter = this.columnIndexToLetter(priceIdx);
            worksheet.getCell(r, index + 1).dataValidation = {
              type: "custom",
              allowBlank: true,
              formulae: [
                `OR(${colLetter}${r}="",${colLetter}${r}=0,AND(${colLetter}${r}>=${priceLetter}${r}*0.2,${colLetter}${r}<=${priceLetter}${r}))`,
              ],
              showErrorMessage: true,
              errorStyle: "error",
              errorTitle: "Invalid Special Price",
              error:
                "Special Price must be 20%–100% of Price (max 80% discount).",
            };
          }
        } else if (col.type === "SELECT" && col.values?.length) {
          for (let r = 2; r <= 1001; r++) {
            worksheet.getCell(r, index + 1).dataValidation = {
              type: "list",
              allowBlank: !col.isRequired,
              formulae: [`"${col.values!.join(",")}"`],
              showErrorMessage: true,
              errorStyle: "error",
              errorTitle: "Invalid Selection",
              error: `Choose from: ${col.values!.join(", ")}`,
            };
          }
        } else if (col.type === "BOOLEAN") {
          for (let r = 2; r <= 1001; r++) {
            worksheet.getCell(r, index + 1).dataValidation = {
              type: "list",
              allowBlank: !col.isRequired,
              formulae: ['"true,false"'],
              showErrorMessage: true,
              errorStyle: "error",
              errorTitle: "Invalid Value",
              error: "Enter true or false.",
            };
          }
        } else if (col.type === "NUMBER") {
          for (let r = 2; r <= 1001; r++) {
            worksheet.getCell(r, index + 1).dataValidation = {
              type: "decimal",
              allowBlank: !col.isRequired,
              operator: "greaterThanOrEqual",
              formulae: [0],
              showErrorMessage: true,
              errorStyle: "error",
              errorTitle: "Invalid Number",
              error: "Value must be 0 or greater.",
            };
          }
        }
      });

      // ─── Sample rows ──────────────────────────────────────────────────────
      const makeBaseRow = () => {
        const row: Record<string, any> = {};
        productAttributes.forEach((col) => {
          row[col.key] =
            col.type === "SELECT"
              ? (col.values?.[0] ?? "")
              : col.type === "NUMBER"
                ? 100
                : col.type === "BOOLEAN"
                  ? "true"
                  : `Sample ${col.header}`;
        });
        return row;
      };

      // Use the vendor's first approved brand as the sample value, if any —
      // makes the example row realistic and immediately valid to re-upload.
      const sampleBrand = hasBrands ? brandDropdownValues[0] : "";

      const standalone: Record<string, any> = {
        ...makeBaseRow(),
        variantGroupNo: "",
        name: "Example Standalone Product",
        nameBn: "উদাহরণ পণ্য",
        description:
          "A product with no variants. Leave Variant Group No blank.",
        brandId: sampleBrand,
        sku: "SKU-STANDALONE-001",
        availability: "true",
        price: 1200,
        specialPrice: 960, // 20% off
        taxRate: 5,
        reorderLevel: 10,
        imageUrls: "https://example.com/product.jpg",
        packageWeight: 1.5,
        packageWeightUnit: "KG",
        packageLength: 30,
        packageWidth: 20,
        packageHeight: 10,
        dangerousGoods: "NONE",
        warrantyDuration: 12,
        warrantyUnit: "MONTHS",
        warrantyType: "BRAND_WARRANTY",
        warrantyPolicy:
          "Standard manufacturer warranty covering manufacturing defects.",
      };

      const variant1: Record<string, any> = {
        ...makeBaseRow(),
        variantGroupNo: 1,
        name: "Example Product With Variants",
        nameBn: "ভেরিয়েন্ট পণ্য",
        description:
          "Rows 3–4 share Variant Group No 1 — they become variants of one product.",
        brandId: sampleBrand,
        sku: "SKU-EXAMPLE-RED-M",
        availability: "true",
        price: 850,
        specialPrice: "",
        taxRate: 5,
        reorderLevel: 5,
        imageUrls: "https://example.com/red-m.jpg",
        packageWeight: 0.8,
        packageWeightUnit: "KG",
        packageLength: 25,
        packageWidth: 15,
        packageHeight: 5,
        dangerousGoods: "NONE",
        warrantyDuration: 6,
        warrantyUnit: "MONTHS",
        warrantyType: "SELLER_WARRANTY",
        warrantyPolicy: "Seller warranty — contact seller for claims.",
      };

      const variant2: Record<string, any> = {
        ...makeBaseRow(),
        variantGroupNo: 1,
        name: "Example Product With Variants",
        nameBn: "ভেরিয়েন্ট পণ্য",
        description:
          "Rows 3–4 share Variant Group No 1 — they become variants of one product.",
        brandId: sampleBrand,
        sku: "SKU-EXAMPLE-BLUE-L",
        availability: "true",
        price: 900,
        specialPrice: 720, // 20% off
        taxRate: 5,
        reorderLevel: 5,
        imageUrls: "https://example.com/blue-l.jpg",
        packageWeight: 0.9,
        packageWeightUnit: "KG",
        packageLength: 27,
        packageWidth: 16,
        packageHeight: 6,
        dangerousGoods: "NONE",
        warrantyDuration: 6,
        warrantyUnit: "MONTHS",
        warrantyType: "SELLER_WARRANTY",
        warrantyPolicy: "Seller warranty — contact seller for claims.",
      };

      // Assign variant attribute sample values
      variantAttributes.forEach((col) => {
        standalone[col.key] =
          col.values?.[0] ?? (col.type === "NUMBER" ? 100 : "");
        variant1[col.key] =
          col.values?.[0] ?? (col.type === "NUMBER" ? 50 : "Value A");
        variant2[col.key] =
          col.values && col.values.length > 1
            ? col.values[1]
            : col.type === "NUMBER"
              ? 75
              : "Value B";
      });

      const row2 = worksheet.getRow(2);
      row2.values = standalone;

      const row3 = worksheet.getRow(3);
      row3.values = variant1;

      const row4 = worksheet.getRow(4);
      row4.values = variant2;

      [row2, row3, row4].forEach((row) => {
        row.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF5F5F5" },
        };
        row.font = { color: { argb: "FF888888" }, italic: true };
        row.eachCell((cell) => {
          cell.border = {
            top: { style: "hair", color: { argb: "FFCCCCCC" } },
            left: { style: "hair", color: { argb: "FFCCCCCC" } },
            bottom: { style: "hair", color: { argb: "FFCCCCCC" } },
            right: { style: "hair", color: { argb: "FFCCCCCC" } },
          };
        });
      });

      // Freeze top row
      worksheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

      // ─── Instructions sheet ───────────────────────────────────────────────
      const inst = workbook.addWorksheet("📋 Instructions");
      inst.columns = [
        { header: "Column", key: "col", width: 30 },
        { header: "Type", key: "type", width: 14 },
        { header: "Required?", key: "req", width: 13 },
        { header: "Section", key: "section", width: 20 },
        { header: "Description", key: "desc", width: 65 },
      ];

      const iHeader = inst.getRow(1);
      iHeader.font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
      iHeader.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1A5276" },
      };
      iHeader.alignment = { vertical: "middle", horizontal: "center" };
      iHeader.height = 28;

      columns.forEach((col) => {
        const section = col.isVariantAttribute
          ? "🔄 Variant Attribute"
          : productAttributes.some((a) => a.key === col.key)
            ? "📦 Product Attribute"
            : variantCoreColumns.some((a) => a.key === col.key)
              ? "🏷️ Variant Core"
              : basicInfoColumns.some((a) => a.key === col.key)
                ? "ℹ️ Basic Info"
                : "📦 Package / Warranty";

        const row = inst.addRow({
          col: `${col.header}${col.isRequired ? " *" : ""}${col.isVariantAttribute ? " 🔄" : ""}`,
          type: col.type,
          req: col.isRequired ? "✓ YES" : "○ No",
          section,
          desc: col.description ?? "",
        });

        if (col.isVariantAttribute) {
          row.getCell(1).font = { bold: true, color: { argb: "FF7B2D8B" } };
        } else if (col.isRequired) {
          row.getCell(1).font = { bold: true, color: { argb: "FFC0392B" } };
          row.getCell(3).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFFF0E0" },
          };
        }

        row.alignment = { wrapText: true, vertical: "top" };
        row.height = 40;
      });

      // Important notes block
      inst.addRow([]);
      const noteTitle = inst.addRow(["⚠️  KEY RULES", "", "", "", ""]);
      noteTitle.font = { bold: true, size: 13 };
      noteTitle.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFF3CD" },
      };

      const importantNotes = [
        [
          "No Stock Quantity Column",
          "Stock is NOT set here. After uploading products, receive stock via the Purchase Order module → Receive Items. " +
            "WarehouseStock is created automatically when a PO is received.",
        ],
        [
          "Price Is Applied As A Second Step",
          "Behind the scenes, each product is first created with variant price 0 (same as manual product creation), " +
            "then the Price / Special Price / Reorder Level from this sheet are applied to each variant automatically " +
            "by the bulk import — you don't need to do anything extra, but if a product import fails partway, the " +
            "product itself may exist while price application failed; check the import result per row.",
        ],
        [
          "Reorder Level",
          "This is a static threshold (default 10). When warehouse stock drops below this level, a low-stock alert fires. " +
            "It does NOT set initial stock.",
        ],
        [
          "Variant Group No",
          "Rows sharing the same Variant Group No become variants of one product. " +
            "Leave blank for standalone products. Example: rows with Group 1 → one product with multiple variants.",
        ],
        [
          "Variant Attributes (🔄 Purple)",
          "These SELECT-type attributes differentiate variants (e.g. Color, Size). " +
            "Each variant row must have a DIFFERENT combination of variant attribute values within the same group.",
        ],
        [
          "Product Attributes (📦)",
          "Non-variant attributes describe the overall product. Use the SAME value for all rows in the same group.",
        ],
        [
          "Brand (required)",
          "Every product must be linked to one of your approved brands — pick it from the 'Brand' column dropdown " +
            "(format 'Name (id)'). If the dropdown is empty, you have no approved brands yet — register one and wait " +
            "for approval before bulk uploading. Same brand for every variant row in a group.",
        ],
        [
          "Tax Rate",
          "Optional percentage applied to every variant in the group (e.g. 5 = 5%). Defaults to 0 if left blank.",
        ],
        [
          "Pricing Rules",
          "Price > 0 always. Special Price must be 20%–100% of Price (≤ 80% discount). Leave Special Price blank for no discount.",
        ],
        [
          "SKU Uniqueness",
          "Every SKU must be globally unique across all products and all variants. Duplicates will cause import failure.",
        ],
      ];

      importantNotes.forEach(([title, desc]) => {
        const r = inst.addRow([title, "", "", "", desc]);
        r.getCell(1).font = { bold: true };
        r.getCell(1).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFE8F4FD" },
        };
        r.getCell(5).alignment = { wrapText: true, vertical: "top" };
        r.height = 55;
      });

      // ─── Save file ────────────────────────────────────────────────────────
      const templatesDir = join(__dirname, "..", "templates");
      if (!existsSync(templatesDir)) {
        mkdirSync(templatesDir, { recursive: true });
      }

      const safeCategory = category.name.replace(/[^a-zA-Z0-9]/g, "_");
      const fileName = `${safeCategory}_BulkTemplate_${Date.now()}.xlsx`;
      const filePath = join(templatesDir, fileName);
      await workbook.xlsx.writeFile(filePath);

      const templateRecord = await prisma.categoryTemplate.upsert({
        where: { categoryId },
        update: { filePath, updatedAt: new Date() },
        create: {
          categoryId,
          filePath,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      return { filePath, templateRecord };
    } catch (error) {
      console.error("Error generating Excel template:", error);
      throw error;
    } finally {
      await prisma.$disconnect();
    }
  }

  /**
   * Deletes the generated template's physical file (and its DB record) for
   * a category. Intended to be called right after the file has been served
   * to the vendor for download — templates are meant to be downloaded once
   * and regenerated on demand, not kept around indefinitely on disk.
   * Safe to call even if the file/record is already gone.
   */
  async deleteTemplateFile(categoryId: string): Promise<void> {
    try {
      const template = await prisma.categoryTemplate.findUnique({
        where: { categoryId },
      });
      if (!template) return;

      await fs.unlink(template.filePath).catch(() => {
        // Already removed from disk — fine, we still clean up the DB record below.
      });

      await prisma.categoryTemplate
        .delete({ where: { categoryId } })
        .catch(() => {
          // Already removed (e.g. a concurrent request cleaned it up first) — fine.
        });
    } catch (error) {
      // Cleanup is best-effort and must never fail the download response that triggered it.
      console.error(
        `Failed to clean up template file for category ${categoryId}:`,
        error,
      );
    }
  }

  /**
   * UNIFIED one-click flow: generates the template, reads it into memory,
   * and deletes the physical file + DB record immediately — all before
   * returning. The caller (controller) just streams the returned buffer.
   * No separate "generate" step, no leftover file waiting to be downloaded,
   * nothing to clean up afterwards. This is what the vendor-facing
   * "download template" button should call.
   */
  async generateTemplateBuffer(
    categoryId: string,
    vendorId: string, // 👈 নতুন প্যারামিটার
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const { filePath } = await this.generateExcelTemplate(categoryId, vendorId);
    const fileName = filePath.split(/[\\/]/).pop()!;

    const buffer = await fs.readFile(filePath);

    // Clean up right away — we already have the bytes we need in memory,
    // so there's no reason for the file to sit on disk even momentarily
    // longer than it takes to read it.
    await this.deleteTemplateFile(categoryId);

    return { buffer, fileName };
  }

  /** Convert 0-based column index to Excel letter(s): 0→A, 25→Z, 26→AA */
  private columnIndexToLetter(index: number): string {
    let letter = "";
    let n = index + 1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      letter = String.fromCharCode(65 + rem) + letter;
      n = Math.floor((n - 1) / 26);
    }
    return letter;
  }
}
