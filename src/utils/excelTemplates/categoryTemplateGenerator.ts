// src/utils/excelTemplates/categoryTemplateGenerator.ts
import ExcelJS from "exceljs";

export interface TemplateOptions {
  maxLevels?: number;
  includeAttributes?: number;
  templateType?: "standard" | "custom";
}

interface ColumnConfig {
  header: string;
  key: string;
  width: number;
  type: "TEXT" | "NUMBER" | "BOOLEAN" | "SELECT" | "FIXED_TYPE" | "FIXED_BOOL";
  isRequired: boolean;
  isControlled?: boolean; // dropdown-locked field (AttributeType / true-false)
  values?: string[];
  description: string;
}

// Must match Prisma's AttributeType enum exactly — this is what gets cast
// with `type: attributeData.type as any` in CategoryService.assignAttribute,
// so a typo here silently breaks the import at the DB layer.
const ATTRIBUTE_TYPE_VALUES = ["TEXT", "NUMBER", "BOOLEAN", "SELECT"];
const BOOL_VALUES = ["true", "false"];

export class CategoryTemplateGenerator {
  /**
   * Build the workbook: "Categories" sheet (data entry) + "📋 Instructions" sheet.
   */
  static async generateWorkbook(options: TemplateOptions = {}): Promise<ExcelJS.Workbook> {
    const maxLevels = options.maxLevels || 5;
    const attrCount = options.includeAttributes || 3;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "System";
    workbook.created = new Date();

    const columns = this.buildColumns(maxLevels, attrCount);

    const sheet = workbook.addWorksheet("Categories");
    sheet.columns = columns.map((c) => ({
      header: c.isRequired ? `${c.header} *` : c.header,
      key: c.key,
      width: c.width,
    }));

    this.styleHeader(sheet, columns);
    this.applyValidation(sheet, columns);
    this.writeSampleRows(sheet, columns, maxLevels, attrCount, options.templateType);

    sheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

    this.buildInstructionsSheet(workbook, columns);

    return workbook;
  }

  /**
   * Column layout: Level 1..N → Image → Keywords → Tags → repeated
   * attribute slots (Name / Type / Unit / Required / Filterable / Values).
   */
  private static buildColumns(maxLevels: number, attrCount: number): ColumnConfig[] {
    const columns: ColumnConfig[] = [];

    for (let i = 1; i <= maxLevels; i++) {
      columns.push({
        header: `Level ${i}`,
        key: `level${i}`,
        width: 22,
        type: "TEXT",
        isRequired: i === 1,
        description:
          i === 1
            ? "Root category name. Required on every row — this is where the category tree starts."
            : `Sub-category name at depth ${i}. Leave blank once the path ends (a row doesn't have to use every level).`,
      });
    }

    columns.push({
      header: "Image",
      key: "image",
      width: 45,
      type: "TEXT",
      isRequired: false,
      description:
        "Publicly accessible image URL. Applies to the ROOT (Level 1) category only — " +
        "put it on the first row where that root category appears; leave blank on other rows sharing the same root.",
    });

    columns.push({
      header: "Keywords",
      key: "keywords",
      width: 40,
      type: "TEXT",
      isRequired: false,
      description:
        "Comma-separated search keywords. Applies to the LEAF (deepest filled) category of this row only.",
    });

    columns.push({
      header: "Tags",
      key: "tags",
      width: 30,
      type: "TEXT",
      isRequired: false,
      description:
        "Comma-separated tags (e.g. featured, bestseller). Applies to the LEAF category of this row only.",
    });

    for (let i = 1; i <= attrCount; i++) {
      columns.push({
        header: `Attribute ${i} Name`,
        key: `attr${i}_name`,
        width: 24,
        type: "TEXT",
        isRequired: false,
        description:
          `Actual attribute name (e.g. "Color", "Weight"). Linked to the LEAF category of this row. ` +
          `Leave the whole Attribute ${i} block blank if this row's leaf needs fewer than ${attrCount} attributes.`,
      });
      columns.push({
        header: `Attribute ${i} Type`,
        key: `attr${i}_type`,
        width: 18,
        type: "FIXED_TYPE",
        isRequired: false,
        isControlled: true,
        values: ATTRIBUTE_TYPE_VALUES,
        description:
          "Must be exactly one of: TEXT, NUMBER, BOOLEAN, SELECT — pick from the dropdown, this maps " +
          "directly to a fixed system enum and a typo will fail the import.",
      });
      columns.push({
        header: `Attribute ${i} Unit`,
        key: `attr${i}_unit`,
        width: 16,
        type: "TEXT",
        isRequired: false,
        description:
          "Optional measurement unit (e.g. kg, cm, GB, inch). Only meaningful when Type is NUMBER, or " +
          "SELECT with numeric values (e.g. Storage: 64,128,256 + unit GB). Leave blank for TEXT, BOOLEAN, " +
          "and categorical SELECT values (e.g. Color: Black,White).",
      });
      columns.push({
        header: `Attribute ${i} Required`,
        key: `attr${i}_required`,
        width: 16,
        type: "FIXED_BOOL",
        isRequired: false,
        isControlled: true,
        values: BOOL_VALUES,
        description: "true or false — whether a vendor must fill this attribute when creating a product.",
      });
      columns.push({
        header: `Attribute ${i} Filterable`,
        key: `attr${i}_filterable`,
        width: 18,
        type: "FIXED_BOOL",
        isRequired: false,
        isControlled: true,
        values: BOOL_VALUES,
        description: "true or false — whether this attribute appears as a storefront filter.",
      });
      columns.push({
        header: `Attribute ${i} Values`,
        key: `attr${i}_values`,
        width: 30,
        type: "TEXT",
        isRequired: false,
        description:
          "Comma-separated option list. REQUIRED when Type = SELECT (e.g. Black,White,Blue). " +
          "Leave blank for TEXT, NUMBER, BOOLEAN.",
      });
    }

    return columns;
  }

  /** Red = required, Purple = controlled dropdown (fixed enum/bool), Blue = free optional field. */
  private static styleHeader(sheet: ExcelJS.Worksheet, columns: ColumnConfig[]) {
    const headerRow = sheet.getRow(1);
    headerRow.height = 40;
    headerRow.alignment = { vertical: "middle", horizontal: "center", wrapText: true };

    columns.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);

      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
          argb: col.isRequired ? "FFC0392B" : col.isControlled ? "FF7B2D8B" : "FF2E75B6",
        },
      };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.border = {
        top: { style: "thin", color: { argb: "FF000000" } },
        left: { style: "thin", color: { argb: "FF000000" } },
        bottom: { style: "thin", color: { argb: "FF000000" } },
        right: { style: "thin", color: { argb: "FF000000" } },
      };

      const hint = col.isControlled
        ? `Fixed dropdown (${col.values?.join(" / ")}).`
        : `Type: ${col.type}.`;
      cell.note = {
        texts: [{ text: `${col.isRequired ? "⚠️ REQUIRED" : "Optional"} — ${hint} See "📋 Instructions" sheet.` }],
        margins: { insetmode: "custom", inset: [0.1, 0.1, 0.1, 0.1] },
      };
    });
  }

  private static applyValidation(sheet: ExcelJS.Worksheet, columns: ColumnConfig[]) {
    const lastRow = 500;
    columns.forEach((col, i) => {
      const colNum = i + 1;
      if (col.type === "FIXED_TYPE" || col.type === "FIXED_BOOL") {
        for (let r = 2; r <= lastRow; r++) {
          sheet.getCell(r, colNum).dataValidation = {
            type: "list",
            allowBlank: true,
            formulae: [`"${col.values!.join(",")}"`],
            showErrorMessage: true,
            errorStyle: "error",
            errorTitle: "Invalid Selection",
            error: `Choose one of: ${col.values!.join(", ")}`,
          };
        }
      }
    });
  }

  private static writeSampleRows(
    sheet: ExcelJS.Worksheet,
    columns: ColumnConfig[],
    maxLevels: number,
    attrCount: number,
    templateType: TemplateOptions["templateType"] = "standard",
  ) {
    const blankLevel = (n: number) => Array.from({ length: maxLevels }, (_, i) => (i < n ? "" : ""));

    const rows: Record<string, any>[] = [];

    const makeRow = (
      levels: string[],
      image: string,
      keywords: string,
      tags: string,
      attrs: [string, string, string, string, string, string][],
    ) => {
      const row: Record<string, any> = {};
      levels.forEach((v, i) => (row[`level${i + 1}`] = v));
      for (let i = levels.length; i < maxLevels; i++) row[`level${i + 1}`] = "";
      row.image = image;
      row.keywords = keywords;
      row.tags = tags;
      attrs.forEach(([name, type, unit, required, filterable, values], idx) => {
        const n = idx + 1;
        if (n > attrCount) return;
        row[`attr${n}_name`] = name;
        row[`attr${n}_type`] = type;
        row[`attr${n}_unit`] = unit;
        row[`attr${n}_required`] = required;
        row[`attr${n}_filterable`] = filterable;
        row[`attr${n}_values`] = values;
      });
      return row;
    };

    if (templateType === "custom") {
      rows.push(
        makeRow(
          ["Category Level 1", "Category Level 2", "Category Level 3"],
          "https://example.com/image.jpg",
          "keyword1,keyword2,keyword3",
          "tag1,tag2",
          [
            ["Attribute1", "SELECT", "", "true", "true", "Value1,Value2,Value3"],
            ["Attribute2", "NUMBER", "unit", "true", "true", ""],
            ["Attribute3", "TEXT", "", "false", "true", ""],
          ],
        ),
      );
    } else {
      rows.push(
        makeRow(
          ["Electronics", "Smartphones", "Android Phones"],
          "https://example.com/electronics.jpg",
          "smartphone,android,mobile",
          "featured,bestseller",
          [
            ["Brand", "SELECT", "", "true", "true", "Samsung,OnePlus,Xiaomi"],
            ["Color", "SELECT", "", "true", "true", "Black,White,Blue"],
            ["Storage", "SELECT", "GB", "true", "true", "64,128,256"],
          ],
        ),
      );
      rows.push(
        makeRow(
          ["Fashion", "Men's Clothing", "Shirts"],
          "https://example.com/fashion.jpg",
          "shirt,casual,cotton",
          "summer,new-arrival",
          [
            ["Size", "SELECT", "", "true", "true", "S,M,L,XL"],
            ["Fit", "SELECT", "", "true", "true", "Slim,Regular"],
            ["Material", "TEXT", "", "false", "true", ""],
          ],
        ),
      );
      rows.push(
        makeRow(
          ["Books", "Fiction", ""],
          "https://example.com/books.jpg",
          "books,fiction,reading",
          "bestseller,classic",
          [
            ["Author", "TEXT", "", "true", "true", ""],
            ["Genre", "SELECT", "", "true", "true", "Mystery,Romance,Sci-Fi"],
            ["Format", "SELECT", "", "false", "true", "Paperback,Hardcover"],
          ],
        ),
      );
      // Extra row purely to demonstrate correct "unit" usage on a NUMBER attribute.
      rows.push(
        makeRow(
          ["Electronics", "Laptops", ""],
          "",
          "laptop,notebook,computer",
          "new-arrival",
          [
            ["Screen Size", "NUMBER", "inch", "true", "true", ""],
            ["Weight", "NUMBER", "kg", "false", "false", ""],
            ["Is Waterproof", "BOOLEAN", "", "false", "false", ""],
          ],
        ),
      );
    }

    rows.forEach((r, idx) => {
      const row = sheet.getRow(idx + 2);
      row.values = r;
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
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
  }

  private static buildInstructionsSheet(workbook: ExcelJS.Workbook, columns: ColumnConfig[]) {
    const inst = workbook.addWorksheet("📋 Instructions");
    inst.columns = [
      { header: "Column", key: "col", width: 26 },
      { header: "Type", key: "type", width: 14 },
      { header: "Required?", key: "req", width: 12 },
      { header: "Description", key: "desc", width: 70 },
    ];

    const header = inst.getRow(1);
    header.font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A5276" } };
    header.alignment = { vertical: "middle", horizontal: "center" };
    header.height = 26;

    columns.forEach((col) => {
      const row = inst.addRow({
        col: col.isRequired ? `${col.header} *` : col.header,
        type: col.isControlled ? `${col.type} (dropdown)` : col.type,
        req: col.isRequired ? "✓ YES" : "○ No",
        desc: col.description,
      });
      if (col.isControlled) {
        row.getCell(1).font = { bold: true, color: { argb: "FF7B2D8B" } };
      } else if (col.isRequired) {
        row.getCell(1).font = { bold: true, color: { argb: "FFC0392B" } };
      }
      row.alignment = { wrapText: true, vertical: "top" };
      row.height = 36;
    });

    inst.addRow([]);
    const noteTitle = inst.addRow(["⚠️ KEY RULES", "", "", ""]);
    noteTitle.font = { bold: true, size: 13 };
    noteTitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3CD" } };

    const notes: [string, string][] = [
      [
        "Category Hierarchy",
        "Fill Level 1, 2, 3... in order — leave later levels blank once the path ends. " +
          "Each row is one full path from root to leaf; the LAST non-blank level in a row is that row's leaf category.",
      ],
      [
        "Image — Root only",
        "Put the image URL only on the row where a root (Level 1) category first appears. If the same root " +
          "repeats on later rows (different sub-paths), leave Image blank there — it's already set.",
      ],
      [
        "Keywords / Tags — Leaf only",
        "These describe the LEAF category of that specific row, not the whole path. Comma-separated.",
      ],
      [
        "Attributes — Leaf only",
        "Each Attribute block (Name/Type/Unit/Required/Filterable/Values) attaches to the row's LEAF category. " +
          "Unused attribute slots must be left completely blank.",
      ],
      [
        "Attribute Type (fixed dropdown)",
        "Must be exactly TEXT, NUMBER, BOOLEAN, or SELECT — this is a locked system enum, choose from the " +
          "dropdown only. Anything else fails validation on import.",
      ],
      [
        "Unit — when to use it",
        "Only fill Unit when the attribute is a measurable quantity: Type = NUMBER (e.g. Weight → kg, " +
          "Screen Size → inch), or Type = SELECT where every value is numeric (e.g. Storage: 64,128,256 → " +
          "unit GB). Leave Unit blank for TEXT, BOOLEAN, and categorical SELECT attributes (e.g. Color, Size).",
      ],
      [
        "Attribute Values",
        "Required when Type = SELECT — comma-separated list (e.g. Black,White,Blue). Ignored/leave blank " +
          "for TEXT, NUMBER, BOOLEAN.",
      ],
      [
        "Required / Filterable (fixed dropdown)",
        "Must be exactly true or false, chosen from the dropdown — controls whether a vendor must fill this " +
          "attribute when creating a product, and whether it shows up as a storefront filter.",
      ],
      [
        "Slug",
        "Generated automatically from the category Name on the backend — do not include a slug column here.",
      ],
    ];

    notes.forEach(([title, desc]) => {
      const r = inst.addRow([title, "", "", desc]);
      r.getCell(1).font = { bold: true };
      r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F4FD" } };
      r.getCell(4).alignment = { wrapText: true, vertical: "top" };
      r.height = 55;
    });
  }

  /**
   * Generate workbook buffer for HTTP response.
   * NOTE: ExcelJS's writeBuffer() is async — callers must await this.
   */
  static async generateWorkbookBuffer(options: TemplateOptions = {}): Promise<Buffer> {
    const workbook = await this.generateWorkbook(options);
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}