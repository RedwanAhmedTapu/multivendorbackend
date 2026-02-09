import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export interface ColumnConfig {
  header: string;
  key: string;
  width: number;
  type: "TEXT" | "NUMBER" | "BOOLEAN" | "SELECT";
  isRequired: boolean;
  isVariantAttribute?: boolean; // New flag for variant attributes
  values?: string[];
  validation?: {
    type: string;
    formula: string;
    error: string;
  };
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

// Derive __dirname equivalent for ESM
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
            orderBy: {
              sortOrder: "asc",
            },
          },
          children: true,
        },
      });

      if (!category)
        throw new Error(`Category with ID ${categoryId} not found`);
      if (category.children && category.children.length > 0) {
        throw new Error("Selected category is not a leaf category");
      }
      return category;
    } catch (error) {
      console.error("Error fetching category data:", error);
      throw error;
    }
  }

  async generateExcelTemplate(categoryId: string): Promise<TemplateResponse> {
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
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "System";
      workbook.created = new Date();
      const worksheet = workbook.addWorksheet(`${category.name} Products`);

      // First section: Basic product info
      const basicInfoColumns: ColumnConfig[] = [
        {
          header: "Variant Group No",
          key: "variantGroupNo",
          width: 20,
          type: "NUMBER",
          isRequired: false,
          description:
            "Same number for products that are variants of each other. Products with the same number will be grouped as variants. Leave empty for standalone products.",
        },
        {
          header: "Availability",
          key: "availability",
          width: 20,
          type: "BOOLEAN",
          isRequired: true,
          description:
            "Indicates if the product is available for purchase (true/false)",
        },
        {
          header: "Product Name",
          key: "name",
          width: 30,
          type: "TEXT",
          isRequired: true,
          description: "Name of the product. Same for all variants in a group.",
        },
        {
          header: "Description",
          key: "description",
          width: 50,
          type: "TEXT",
          isRequired: false,
          description: "Product description. Same for all variants in a group.",
        },
      ];

      // Third section: Pricing and inventory (after attributes)
      const pricingInventoryColumns: ColumnConfig[] = [
        {
          header: "SKU",
          key: "sku",
          width: 20,
          type: "TEXT",
          isRequired: true,
          description:
            "Unique stock keeping unit. Must be unique for each variant.",
        },
        {
          header: "Price",
          key: "price",
          width: 15,
          type: "NUMBER",
          isRequired: true,
          description:
            "Product price in local currency. Must be greater than special price if special price is provided.",
        },
        {
          header: "Special Price",
          key: "specialPrice",
          width: 15,
          type: "NUMBER",
          isRequired: false,
          description:
            "Product special price in local currency. Must be between 20% and 100% of the original price (i.e., discount cannot exceed 80%).",
        },
        {
          header: "Stock",
          key: "stock",
          width: 10,
          type: "NUMBER",
          isRequired: true,
          description: "Available quantity in stock",
        },
      ];

      // Fourth section: Package and warranty info
      const packageWarrantyColumns: ColumnConfig[] = [
        {
          header: "Image URLs",
          key: "imageUrls",
          width: 50,
          type: "TEXT",
          isRequired: false,
          description: "Comma-separated list of image URLs for the product",
        },
        {
          header: "Video URL",
          key: "videoUrl",
          width: 50,
          type: "TEXT",
          isRequired: false,
          description: "Video URL for the product",
        },
        {
          header: "Package Weight",
          key: "packageWeight",
          width: 18,
          type: "NUMBER",
          isRequired: true,
          description: "Weight of the product package",
        },
        {
          header: "Package Weight Unit",
          key: "packageWeightUnit",
          width: 20,
          type: "SELECT",
          values: ["KG", "G"],
          isRequired: true,
          description: "Unit of measurement for package weight",
        },
        {
          header: "Package Length",
          key: "packageLength",
          width: 18,
          type: "NUMBER",
          isRequired: true,
          description: "Length of the package (cm)",
        },
        {
          header: "Package Width",
          key: "packageWidth",
          width: 18,
          type: "NUMBER",
          isRequired: true,
          description: "Width of the package (cm)",
        },
        {
          header: "Package Height",
          key: "packageHeight",
          width: 18,
          type: "NUMBER",
          isRequired: true,
          description: "Height of the package (cm)",
        },
        {
          header: "Dangerous Goods",
          key: "dangerousGoods",
          width: 20,
          type: "SELECT",
          values: ["NONE", "CONTAINS"],
          isRequired: true,
          description: "Indicates if product contains dangerous goods",
        },
        {
          header: "Warranty Duration",
          key: "warrantyDuration",
          width: 18,
          type: "NUMBER",
          isRequired: false,
          description: "Duration of warranty",
        },
        {
          header: "Warranty Unit",
          key: "warrantyUnit",
          width: 20,
          type: "SELECT",
          values: ["DAYS", "MONTHS", "YEARS"],
          isRequired: false,
          description: "Unit of time for warranty duration",
        },
        {
          header: "Warranty Type",
          key: "warrantyType",
          width: 20,
          type: "SELECT",
          values: WARRANTY_TYPE_VALUES,
          isRequired: false,
          description: "Type of warranty offered (e.g., Manufacturer, Seller)",
        },
        {
          header: "Warranty Policy",
          key: "warrantyPolicy",
          width: 50,
          type: "TEXT",
          isRequired: false,
          description: "Detailed warranty policy information",
        },
        
      ];
      const productAttributes: ColumnConfig[] = [];
      const variantAttributes: ColumnConfig[] = [];

      category.attributes.forEach((attr) => {
        const isVariantAttr =
          attr.attribute.type === "SELECT" && attr.attribute.values.length > 1;

        const columnConfig: ColumnConfig = {
          header: attr.attribute.name,
          key: attr.attribute.slug,
          width: 20,
          type: attr.attribute.type,
          values:
            attr.attribute.type === "SELECT"
              ? attr.attribute.values.map((v) => v.value)
              : [],
          isRequired: attr.isRequired,
          isVariantAttribute: isVariantAttr,
          description: `${attr.attribute.name}${
            attr.attribute.unit ? ` (${attr.attribute.unit})` : ""
          }. ${attr.isRequired ? "Required" : "Optional"} field.${
            isVariantAttr
              ? " 🔄 VARIANT ATTRIBUTE: Different values create different variants."
              : " 📦 PRODUCT ATTRIBUTE: Same value for all variants in a group."
          }`,
        };

        if (isVariantAttr) {
          variantAttributes.push(columnConfig);
        } else {
          productAttributes.push(columnConfig);
        }
      });
     // Option 2: Basic info with description last, then attributes, then rest
const basicInfoWithoutDescription = basicInfoColumns.filter(col => col.key !== "description");
const descriptionOnly = basicInfoColumns.find(col => col.key === "description");

const columns = [
  ...basicInfoWithoutDescription, // Variant Group No, Availability, Product Name
  descriptionOnly!, // Description
  ...productAttributes, // Product attributes immediately after description
  ...variantAttributes, // Variant attributes
  ...pricingInventoryColumns,
  ...packageWarrantyColumns,
];

      // Set worksheet columns with * for required fields and 🔄 for variant attributes
      worksheet.columns = columns.map((col) => {
        let header = col.header;
        if (col.isRequired) header += " *";
        if (col.isVariantAttribute) header += " 🔄";
        return {
          header,
          key: col.key,
          width: col.width,
        };
      });

      // Style header row
      const headerRow = worksheet.getRow(1);
      headerRow.height = 40;
      headerRow.alignment = {
        vertical: "middle",
        horizontal: "center",
        wrapText: true,
      };

      // Apply different colors for required vs optional, and variant attributes
      columns.forEach((col, index) => {
        const cell = headerRow.getCell(index + 1);

        // Variant attributes: Purple background
        if (col.isVariantAttribute) {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF9B59B6" }, // Purple for variant attributes
          };
          cell.font = {
            bold: true,
            color: { argb: "FFFFFFFF" },
            size: 11,
          };
        }
        // Required fields: Red background
        else if (col.isRequired) {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFDC3545" }, // Red for required
          };
          cell.font = {
            bold: true,
            color: { argb: "FFFFFFFF" },
            size: 11,
          };
        }
        // Optional fields: Blue background
        else {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF4472C4" }, // Blue for optional
          };
          cell.font = {
            bold: true,
            color: { argb: "FFFFFFFF" },
            size: 11,
          };
        }

        cell.border = {
          top: { style: "thin", color: { argb: "FF000000" } },
          left: { style: "thin", color: { argb: "FF000000" } },
          bottom: { style: "thin", color: { argb: "FF000000" } },
          right: { style: "thin", color: { argb: "FF000000" } },
        };
      });

      // Add data validation and notes
      columns.forEach((col, index) => {
        const column = worksheet.getColumn(index + 1);
        const columnLetter = String.fromCharCode(65 + index); // A, B, C, etc.

        // Special validation for Price column
        if (col.key === "price") {
          for (let rowNum = 2; rowNum <= 1001; rowNum++) {
            const cell = worksheet.getCell(rowNum, index + 1);
            const specialPriceCol = columns.findIndex(
              (c) => c.key === "specialPrice"
            );
            const specialPriceColLetter = String.fromCharCode(
              65 + specialPriceCol
            );

            // Price must be greater than 0 and if special price exists, must be greater than special price
            cell.dataValidation = {
              type: "custom",
              allowBlank: false,
              formulae: [
                `AND(${columnLetter}${rowNum}>0, OR(${specialPriceColLetter}${rowNum}="", ${specialPriceColLetter}${rowNum}=0, ${columnLetter}${rowNum}>${specialPriceColLetter}${rowNum}))`,
              ],
              showErrorMessage: true,
              errorStyle: "error",
              errorTitle: "Invalid Price",
              error:
                "Price must be greater than 0 and greater than Special Price (if provided)",
            };
          }
        }
        // Special validation for Special Price column
        else if (col.key === "specialPrice") {
          for (let rowNum = 2; rowNum <= 1001; rowNum++) {
            const cell = worksheet.getCell(rowNum, index + 1);
            const priceCol = columns.findIndex((c) => c.key === "price");
            const priceColLetter = String.fromCharCode(65 + priceCol);

            // Special price must be between 20% and 100% of price (discount max 80%)
            cell.dataValidation = {
              type: "custom",
              allowBlank: true,
              formulae: [
                `OR(${columnLetter}${rowNum}="", ${columnLetter}${rowNum}=0, AND(${columnLetter}${rowNum}>=${priceColLetter}${rowNum}*0.2, ${columnLetter}${rowNum}<=${priceColLetter}${rowNum}))`,
              ],
              showErrorMessage: true,
              errorStyle: "error",
              errorTitle: "Invalid Special Price",
              error:
                "Special Price must be between 20% and 100% of the Price (max 80% discount). Leave empty if no special price.",
            };
          }
        }
        // Add data validation for all other rows after header
        else if (col.type === "SELECT" && col.values && col.values.length > 0) {
          // Apply validation to first 1000 rows
          for (let rowNum = 2; rowNum <= 1001; rowNum++) {
            const cell = worksheet.getCell(rowNum, index + 1);
            cell.dataValidation = {
              type: "list",
              allowBlank: !col.isRequired,
              formulae: [`"${col.values!.join(",")}"`],
              showErrorMessage: true,
              errorStyle: "error",
              errorTitle: "Invalid Input",
              error: `Please select from: ${col.values!.join(", ")}`,
            };
          }
        } else if (
          col.type === "NUMBER" &&
          col.key !== "price" &&
          col.key !== "specialPrice"
        ) {
          for (let rowNum = 2; rowNum <= 1001; rowNum++) {
            const cell = worksheet.getCell(rowNum, index + 1);
            cell.dataValidation = {
              type: "decimal",
              allowBlank: !col.isRequired,
              operator: "greaterThanOrEqual",
              formulae: [0],
              showErrorMessage: true,
              errorStyle: "error",
              errorTitle: "Invalid Number",
              error: "Value must be 0 or greater",
            };
          }
        } else if (col.type === "BOOLEAN") {
          for (let rowNum = 2; rowNum <= 1001; rowNum++) {
            const cell = worksheet.getCell(rowNum, index + 1);
            cell.dataValidation = {
              type: "list",
              allowBlank: !col.isRequired,
              formulae: ['"true,false"'],
              showErrorMessage: true,
              errorStyle: "error",
              errorTitle: "Invalid Input",
              error: "Please select true or false",
            };
          }
        }

        // Add header note/comment with required and variant indicators
        const headerCell = worksheet.getCell(1, index + 1);
        let noteHeader = "";
        if (col.isVariantAttribute) {
          noteHeader = "🔄 VARIANT ATTRIBUTE";
        } else if (col.isRequired) {
          noteHeader = "⚠️ REQUIRED FIELD";
        } else {
          noteHeader = "Optional Field";
        }

        headerCell.note = {
          texts: [
            {
              text: `${noteHeader}\n\n${col.description}\n\nType: ${col.type}${
                col.values ? `\nOptions: ${col.values.join(", ")}` : ""
              }`,
            },
          ],
          margins: {
            insetmode: "custom",
            inset: [0.1, 0.1, 0.1, 0.1],
          },
        };
      });

      // Add sample data rows demonstrating variant attributes
      const sampleStandaloneRow: { [key: string]: any } = {
        variantGroupNo: "",
        availability: true,
        name: "Example Standalone Product",
        description: "This is a standalone product without variants",
        sku: "SKU-STANDALONE-001",
        price: 99.99,
        specialPrice: 79.99, // 20% discount
        stock: 50,
        packageWeight: 1.5,
        packageWeightUnit: "KG",
        packageLength: 30,
        packageWidth: 20,
        packageHeight: 10,
        dangerousGoods: "NONE",
        warrantyDuration: 12,
        warrantyUnit: "MONTHS",
        warrantyType: "BRAND_WARRANTY",
        warrantyPolicy: "Standard manufacturer warranty covering defects",
        imageUrls:
          "https://example.com/product1.jpg,https://example.com/product1-alt.jpg",
        videoUrl: "https://example.com/product1-video.mp4",
      };

      // Variant example with different variant attribute values
      const sampleVariant1Row: { [key: string]: any } = {
        variantGroupNo: 1,
        availability: true,
        name: "Example Product with Variants",
        description: "This product has multiple variants (color/size)",
        sku: "SKU-VAR1-RED-SMALL",
        price: 79.99,
        specialPrice: 63.99, // 20% discount
        stock: 25,
        packageWeight: 1.2,
        packageWeightUnit: "KG",
        packageLength: 28,
        packageWidth: 18,
        packageHeight: 8,
        dangerousGoods: "NONE",
        warrantyDuration: 6,
        warrantyUnit: "MONTHS",
        warrantyType: "SELLER_WARRANTY",
        warrantyPolicy: "Standard warranty",
        imageUrls: "https://example.com/variant-red-small.jpg",
        videoUrl: "",
      };

      const sampleVariant2Row: { [key: string]: any } = {
        variantGroupNo: 1,
        availability: true,
        name: "Example Product with Variants",
        description: "This product has multiple variants (color/size)",
        sku: "SKU-VAR1-BLUE-LARGE",
        price: 89.99,
        specialPrice: 71.99, // 20% discount
        stock: 30,
        packageWeight: 1.5,
        packageWeightUnit: "KG",
        packageLength: 32,
        packageWidth: 22,
        packageHeight: 10,
        dangerousGoods: "NONE",
        warrantyDuration: 6,
        warrantyUnit: "MONTHS",
        warrantyType: "SELLER_WARRANTY",
        warrantyPolicy: "Standard warranty",
        imageUrls: "https://example.com/variant-blue-large.jpg",
        videoUrl: "",
      };

      // Fill product attribute values (same for all variants)
      productAttributes.forEach((col) => {
        if (col.type === "SELECT" && col.values && col.values.length > 0) {
          const value = col.values[0];
          sampleStandaloneRow[col.key] = value;
          sampleVariant1Row[col.key] = value; // Same value
          sampleVariant2Row[col.key] = value; // Same value
        } else if (col.type === "NUMBER") {
          sampleStandaloneRow[col.key] = 100;
          sampleVariant1Row[col.key] = 100; // Same value
          sampleVariant2Row[col.key] = 100; // Same value
        } else if (col.type === "BOOLEAN") {
          sampleStandaloneRow[col.key] = "true";
          sampleVariant1Row[col.key] = "true"; // Same value
          sampleVariant2Row[col.key] = "true"; // Same value
        } else if (col.type === "TEXT") {
          sampleStandaloneRow[col.key] = `Sample ${col.header}`;
          sampleVariant1Row[col.key] = `Sample ${col.header}`;
          sampleVariant2Row[col.key] = `Sample ${col.header}`;
        }
      });

      // Fill variant attribute values (different for each variant)
      variantAttributes.forEach((col, idx) => {
        if (col.type === "SELECT" && col.values && col.values.length > 0) {
          sampleStandaloneRow[col.key] = col.values[0];
          sampleVariant1Row[col.key] = col.values[0]; // First option
          sampleVariant2Row[col.key] =
            col.values.length > 1 ? col.values[1] : col.values[0]; // Second option
        } else if (col.type === "NUMBER") {
          sampleStandaloneRow[col.key] = 100;
          sampleVariant1Row[col.key] = 50; // Different value
          sampleVariant2Row[col.key] = 75; // Different value
        } else if (col.type === "BOOLEAN") {
          sampleStandaloneRow[col.key] = "true";
          sampleVariant1Row[col.key] = "true";
          sampleVariant2Row[col.key] = "false"; // Different value
        } else if (col.type === "TEXT") {
          sampleStandaloneRow[col.key] = `Sample ${col.header}`;
          sampleVariant1Row[col.key] = `${col.header} Variant 1`;
          sampleVariant2Row[col.key] = `${col.header} Variant 2`;
        }
      });

      // Fill variant attribute values (different for each variant)
      variantAttributes.forEach((col, idx) => {
        if (col.type === "SELECT" && col.values && col.values.length > 0) {
          sampleStandaloneRow[col.key] = col.values[0];
          sampleVariant1Row[col.key] = col.values[0]; // First option
          sampleVariant2Row[col.key] =
            col.values.length > 1 ? col.values[1] : col.values[0]; // Second option
        } else if (col.type === "NUMBER") {
          sampleStandaloneRow[col.key] = 100;
          sampleVariant1Row[col.key] = 50; // Different value
          sampleVariant2Row[col.key] = 75; // Different value
        } else if (col.type === "BOOLEAN") {
          sampleStandaloneRow[col.key] = "true";
          sampleVariant1Row[col.key] = "true";
          sampleVariant2Row[col.key] = "false"; // Different value
        } else if (col.type === "TEXT") {
          sampleStandaloneRow[col.key] = `Sample ${col.header}`;
          sampleVariant1Row[col.key] = `${col.header} Variant 1`;
          sampleVariant2Row[col.key] = `${col.header} Variant 2`;
        }
      });

      // Add sample rows with styling
      const row2 = worksheet.addRow(sampleStandaloneRow);
      const row3 = worksheet.addRow(sampleVariant1Row);
      const row4 = worksheet.addRow(sampleVariant2Row);

      // Style sample rows
      [row2, row3, row4].forEach((row) => {
        row.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF8F9FA" },
        };
        row.font = { color: { argb: "FF6C757D" }, italic: true };
      });

      // Create instructions sheet
      const instructionsSheet = workbook.addWorksheet("📋 Instructions");
      instructionsSheet.columns = [
        { header: "Field Name", key: "field", width: 35 },
        { header: "Type", key: "type", width: 15 },
        { header: "Required", key: "required", width: 12 },
        { header: "Attribute Type", key: "attrType", width: 18 },
        { header: "Description", key: "description", width: 60 },
        { header: "Example", key: "example", width: 35 },
      ];

      // Style instructions header
      const instHeaderRow = instructionsSheet.getRow(1);
      instHeaderRow.font = {
        bold: true,
        size: 12,
        color: { argb: "FFFFFFFF" },
      };
      instHeaderRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF28A745" },
      };
      instHeaderRow.alignment = { vertical: "middle", horizontal: "center" };
      instHeaderRow.height = 25;

      // Add field descriptions
      columns.forEach((col) => {
        const exampleValue =
          col.values?.[0] ||
          (col.type === "NUMBER"
            ? col.key.includes("price")
              ? "99.99"
              : "10"
            : col.type === "BOOLEAN"
            ? "true"
            : col.key === "sku"
            ? "SKU-ABC-123"
            : col.key === "variantGroupNo"
            ? "1 (or leave empty)"
            : `Example ${col.header}`);

        let fieldHeader = col.header;
        if (col.isRequired) fieldHeader += " *";
        if (col.isVariantAttribute) fieldHeader += " 🔄";

        const row = instructionsSheet.addRow({
          field: fieldHeader,
          type: col.type,
          required: col.isRequired ? "✓ YES" : "○ No",
          attrType: col.isVariantAttribute
            ? "🔄 Variant"
            : col.key === "variantGroupNo" ||
              col.key === "availability" ||
              col.key === "name"
            ? "System"
            : productAttributes.some((a) => a.key === col.key)
            ? "📦 Product"
            : "System",
          description:
            col.description ||
            `Enter the ${col.header.toLowerCase()} for the product`,
          example: exampleValue,
        });

        // Color code based on type
        if (col.isVariantAttribute) {
          row.getCell(1).font = { bold: true, color: { argb: "FF9B59B6" } };
          row.getCell(4).font = { bold: true, color: { argb: "FF9B59B6" } };
          row.getCell(4).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFF3E5F5" },
          };
        } else if (col.isRequired) {
          row.getCell(1).font = { bold: true, color: { argb: "FFDC3545" } };
          row.getCell(3).font = { bold: true, color: { argb: "FFDC3545" } };
          row.getCell(3).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFFF3CD" },
          };
        }
      });

      // Add spacing and legend
      instructionsSheet.addRow([]);
      instructionsSheet.addRow([]);

      const legendRow = instructionsSheet.addRow([
        "📌 LEGEND & FIELD TYPES",
        "",
        "",
        "",
        "",
        "",
      ]);
      legendRow.font = {
        bold: true,
        size: 14,
        color: { argb: "FF000000" },
      };
      legendRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFE7F3FF" },
      };

      const redHeaderRow = instructionsSheet.addRow([
        "🔴 Red Headers with *",
        "= REQUIRED",
        "",
        "",
        "These fields MUST be filled for all products",
        "",
      ]);
      redHeaderRow.getCell(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFDC3545" },
      };
      redHeaderRow.getCell(1).font = {
        bold: true,
        color: { argb: "FFFFFFFF" },
      };

      const blueHeaderRow = instructionsSheet.addRow([
        "🔵 Blue Headers",
        "= OPTIONAL",
        "",
        "",
        "These fields can be left empty",
        "",
      ]);
      blueHeaderRow.getCell(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF4472C4" },
      };
      blueHeaderRow.getCell(1).font = {
        bold: true,
        color: { argb: "FFFFFFFF" },
      };

      const purpleHeaderRow = instructionsSheet.addRow([
        "🟣 Purple Headers with 🔄",
        "= VARIANT ATTR",
        "",
        "",
        "Different values create different variants (e.g., Color: Red, Blue)",
        "",
      ]);
      purpleHeaderRow.getCell(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF9B59B6" },
      };
      purpleHeaderRow.getCell(1).font = {
        bold: true,
        color: { argb: "FFFFFFFF" },
      };

      instructionsSheet.addRow([]);

      const importantNotesRow = instructionsSheet.addRow([
        "⚠️ IMPORTANT NOTES",
        "",
        "",
        "",
        "",
        "",
      ]);
      importantNotesRow.font = {
        bold: true,
        size: 14,
        color: { argb: "FFDC3545" },
      };
      importantNotesRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFF3CD" },
      };

      const notes = [
        {
          title: "1️⃣ Variant Attributes (🔄)",
          desc: 'Fields marked with 🔄 (purple headers) are VARIANT ATTRIBUTES. Different values in these fields create different variants. Example: If "Color" is a variant attribute, Red creates one variant, Blue creates another variant. These must have DIFFERENT values for each variant in the same group.',
        },
        {
          title: "2️⃣ Product Attributes (📦)",
          desc: "Product-level attributes should have the SAME value for all variants in a group. These describe the overall product, not individual variants. Example: Brand, Material, Country of Origin.",
        },
        {
          title: "3️⃣ Variant Groups",
          desc: "Use the same Variant Group No for all variants of one product. Example: Red T-Shirt (Group 1), Blue T-Shirt (Group 1), Green T-Shirt (Group 1). Leave empty for standalone products without variants.",
        },
        {
          title: "4️⃣ SKU Requirements",
          desc: "Each SKU must be UNIQUE across all products and variants. Format: SKU-[PRODUCT]-[VARIANT_ATTRS] (e.g., SKU-TSHIRT-RED-M, SKU-TSHIRT-BLUE-L)",
        },
        {
          title: "5️⃣ Pricing Rules",
          desc: "Price must be greater than Special Price. Special Price must be between 20% and 100% of Price (maximum 80% discount allowed). Example: If Price = 100, Special Price can be 20-100. Leave Special Price empty if no discount.",
        },
        {
          title: "6️⃣ Required Fields (*)",
          desc: 'All fields with red headers and asterisks (*) are REQUIRED. Empty required fields will cause import errors. Look for "✓ YES" in the Required column.',
        },
        {
          title: "7️⃣ Price & Stock",
          desc: "Price and Stock are per variant. Each variant can have different pricing and inventory levels.",
        },
        {
          title: "8️⃣ Images",
          desc: "You can add variant-specific images. Separate multiple URLs with commas. Product-level images show when no variant is selected.",
        },
        {
          title: "9️⃣ Sample Data",
          desc: "Rows 2-4 demonstrate: Row 2 = Standalone product. Rows 3-4 = Two variants of the same product (notice same Variant Group No, same product attributes, but different variant attributes).",
        },
      ];

      notes.forEach((note) => {
        const noteRow = instructionsSheet.addRow([
          note.title,
          "",
          "",
          "",
          note.desc,
          "",
        ]);
        noteRow.font = { bold: true };
        noteRow.getCell(1).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFE7F3FF" },
        };
        noteRow.getCell(1).alignment = { vertical: "top", wrapText: true };
        noteRow.getCell(5).alignment = { vertical: "top", wrapText: true };
        noteRow.height = 60;
      });

      // Ensure templates directory exists
      const fs = await import("fs");
      const templatesDir = join(__dirname, "..", "templates");
      if (!fs.existsSync(templatesDir)) {
        fs.mkdirSync(templatesDir, { recursive: true });
      }

      // Save file
      const fileName = `${category.name.replace(
        /[^a-zA-Z0-9]/g,
        "_"
      )}_Product_Template_${Date.now()}.xlsx`;
      const filePath = join(templatesDir, fileName);
      await workbook.xlsx.writeFile(filePath);

      // Save template record
      const templateRecord = await prisma.categoryTemplate.upsert({
        where: { categoryId },
        update: {
          filePath,
          updatedAt: new Date(),
        },
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
}
