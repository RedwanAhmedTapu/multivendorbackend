// src/services/bulkImportCategoryService.ts
import ExcelJS from "exceljs";
import { prisma, prismaDirect } from "../config/prisma.ts";

// ─── Guards ───────────────────────────────────────────────────────────────
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_ROWS_PER_FILE = 3000;
const BATCH_SIZE = 500; // ✅ NEW: rows per transaction (1 connection)

const ATTRIBUTE_TYPE_VALUES = ["TEXT", "NUMBER", "BOOLEAN", "SELECT"] as const;
const BOOL_VALUES = ["true", "false"] as const;

type AttributeType = (typeof ATTRIBUTE_TYPE_VALUES)[number];

// ─── Types ────────────────────────────────────────────────────────────────
interface ParsedAttributeBlock {
  name?: string;
  type?: string;
  unit?: string;
  required?: string;
  filterable?: string;
  values?: string;
}

interface ParsedRow {
  excelRow: number;
  levels: string[];
  image: string;
  keywords: string;
  tags: string;
  attrs: ParsedAttributeBlock[];
}

export interface RowError {
  row: number;
  message: string;
}

export interface RowDetail {
  row: number;
  status: "imported" | "failed";
  path: string;
  message?: string;
  categoriesCreated: number;
  categoriesReused: number;
  attributesCreated: number;
  categoryAttributeLinks: number;
}

export interface ImportSummary {
  totalRows: number;
  imported: number;
  failed: number;
  categoriesCreated: number;
  categoriesReused: number;
  attributesCreated: number;
  categoryAttributeLinks: number;
  errors: RowError[];
  warnings: string[];
  rowDetails: RowDetail[];
}

// ─── Column-header parsing ────────────────────────────────────────────────
type ColumnKind =
  | { kind: "level"; index: number }
  | { kind: "image" }
  | { kind: "keywords" }
  | { kind: "tags" }
  | { kind: "attr"; index: number; field: "name" | "type" | "unit" | "required" | "filterable" | "values" };

const LEVEL_RE = /^Level (\d+)$/i;
const ATTR_RE = /^Attribute (\d+) (Name|Type|Unit|Required|Filterable|Values)$/i;

function classifyHeader(rawHeader: string): ColumnKind | null {
  const header = rawHeader.replace(/\s*\*$/, "").trim();

  const levelMatch = header.match(LEVEL_RE);
  if (levelMatch) return { kind: "level", index: Number(levelMatch[1]) };

  if (header === "Image") return { kind: "image" };
  if (header === "Keywords") return { kind: "keywords" };
  if (header === "Tags") return { kind: "tags" };

  const attrMatch = header.match(ATTR_RE);
  if (attrMatch) {
    const field = attrMatch[2].toLowerCase() as ColumnKind extends { kind: "attr"; field: infer F } ? F : never;
    return { kind: "attr", index: Number(attrMatch[1]), field };
  }

  return null;
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "text" in (value as any)) return String((value as any).text ?? "").trim();
  if (typeof value === "object" && "result" in (value as any)) return String((value as any).result ?? "").trim();
  return String(value).trim();
}

// ─── Workbook parsing ─────────────────────────────────────────────────────
async function parseWorkbook(buffer: Buffer): Promise<{ rows: ParsedRow[]; maxLevels: number; attrCount: number }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);

  const sheet = workbook.getWorksheet("Categories") ?? workbook.worksheets[0];
  if (!sheet) throw new Error('No worksheet found (expected a "Categories" sheet).');

  const headerRow = sheet.getRow(1);
  const columnMap = new Map<number, ColumnKind>();
  let maxLevels = 0;
  let attrCount = 0;

  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const kind = classifyHeader(cellToString(cell.value));
    if (!kind) return;
    columnMap.set(colNumber, kind);
    if (kind.kind === "level") maxLevels = Math.max(maxLevels, kind.index);
    if (kind.kind === "attr") attrCount = Math.max(attrCount, kind.index);
  });

  if (maxLevels === 0) {
    throw new Error('No "Level N" columns found — is this the right template?');
  }

  const rows: ParsedRow[] = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;

    const levels: string[] = Array.from({ length: maxLevels }, () => "");
    let image = "";
    let keywords = "";
    let tags = "";
    const attrs: ParsedAttributeBlock[] = Array.from({ length: attrCount }, () => ({}));
    let isEmpty = true;

    columnMap.forEach((kind, colNumber) => {
      const raw = cellToString(row.getCell(colNumber).value);
      if (raw !== "") isEmpty = false;

      if (kind.kind === "level") levels[kind.index - 1] = raw;
      else if (kind.kind === "image") image = raw;
      else if (kind.kind === "keywords") keywords = raw;
      else if (kind.kind === "tags") tags = raw;
      else if (kind.kind === "attr") {
        (attrs[kind.index - 1] as any)[kind.field] = raw;
      }
    });

    if (isEmpty) return;
    rows.push({ excelRow: rowNumber, levels, image, keywords, tags, attrs });
  });

  return { rows, maxLevels, attrCount };
}

// ─── Row-level validation ─────────────────────────────────────────────────
function validateRow(row: ParsedRow): RowError[] {
  const errors: RowError[] = [];
  const push = (message: string) => errors.push({ row: row.excelRow, message });

  if (!row.levels[0]) {
    push("Level 1 is required.");
  }

  let seenBlank = false;
  row.levels.forEach((val, i) => {
    if (val === "") {
      seenBlank = true;
    } else if (seenBlank) {
      push(`Level ${i + 1} is filled but an earlier level is blank — levels must be contiguous.`);
    }
  });

  row.attrs.forEach((attr, i) => {
    const n = i + 1;
    const hasAny = Object.values(attr).some((v) => v && v !== "");
    if (!hasAny) return;

    if (!attr.name) {
      push(`Attribute ${n}: Name is required when any field in the block is filled.`);
    }
    if (!attr.type) {
      push(`Attribute ${n}: Type is required.`);
    } else if (!ATTRIBUTE_TYPE_VALUES.includes(attr.type as AttributeType)) {
      push(`Attribute ${n}: Type "${attr.type}" is invalid — must be one of ${ATTRIBUTE_TYPE_VALUES.join(", ")}.`);
    }

    if (attr.required && !BOOL_VALUES.includes(attr.required as any)) {
      push(`Attribute ${n}: Required must be "true" or "false", got "${attr.required}".`);
    }
    if (attr.filterable && !BOOL_VALUES.includes(attr.filterable as any)) {
      push(`Attribute ${n}: Filterable must be "true" or "false", got "${attr.filterable}".`);
    }

    if (attr.type === "SELECT" && !attr.values) {
      push(`Attribute ${n}: Values is required when Type is SELECT.`);
    }
  });

  return errors;
}

// ─── Slug helpers ─────────────────────────────────────────────────────────
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

// ─── Sheet-level attribute conflict check ─────────────────────────────────
async function checkAttributeConflicts(rows: ParsedRow[]): Promise<RowError[]> {
  const errors: RowError[] = [];
  const seenInSheet = new Map<string, { type: string; row: number }>();

  // ✅ OPTIMIZED: Load all existing attributes ONCE instead of N queries
  const allExisting = await prisma.attribute.findMany({
    select: { slug: true, type: true },
  });
  const existingMap = new Map(allExisting.map((a) => [a.slug, a.type]));

  for (const row of rows) {
    for (const attr of row.attrs) {
      if (!attr.name || !attr.type) continue;
      const slug = slugify(attr.name);

      const priorInSheet = seenInSheet.get(slug);
      if (priorInSheet && priorInSheet.type !== attr.type) {
        errors.push({
          row: row.excelRow,
          message: `Attribute "${attr.name}" was Type ${priorInSheet.type} on row ${priorInSheet.row} but Type ${attr.type} here — an attribute's type can't vary across rows.`,
        });
        continue;
      }
      seenInSheet.set(slug, { type: attr.type, row: row.excelRow });

      const dbType = existingMap.get(slug);
      if (dbType && dbType !== attr.type) {
        errors.push({
          row: row.excelRow,
          message: `Attribute "${attr.name}" already exists with Type ${dbType}, but this row specifies Type ${attr.type}.`,
        });
      }
    }
  }

  return errors;
}

// ─── Post-import keyword/tag tracking ─────────────────────────────────────
async function trackKeywordTagUsage(allRawTags: string[]): Promise<void> {
  const counts = new Map<string, string>();
  const increments = new Map<string, number>();

  for (const raw of allRawTags) {
    const tag = raw.toLowerCase();
    if (!counts.has(tag)) counts.set(tag, raw);
    increments.set(tag, (increments.get(tag) ?? 0) + 1);
  }

  // ✅ OPTIMIZED: One transaction = one connection for all upserts
  await prismaDirect.$transaction(async (tx) => {
    for (const [tag, count] of increments) {
      await tx.keywordTag.upsert({
        where: { tag },
        create: { tag, label: counts.get(tag)!, usageCount: count },
        update: { usageCount: { increment: count } },
      });
    }
  }).catch((err) => {
    console.error("Post-import keyword tag tracking failed:", err);
  });
}

// ─── Batch DB import (ONE transaction = ONE connection) ───────────────────
async function importBatch(
  rows: ParsedRow[],
  batchNum: number
): Promise<{ details: RowDetail[]; stats: { categoriesCreated: number; categoriesReused: number; attributesCreated: number; categoryAttributeLinks: number } }> {
  return prismaDirect.$transaction(
    async (tx) => {
      // ─── 1️⃣ PRELOAD EVERYTHING INTO MEMORY ─────────────────────────────
      const [allCats, allAttrs, allAttrVals, allCatAttrs] = await Promise.all([
        tx.category.findMany({
          select: { id: true, name: true, parentId: true, slug: true, image: true, keywords: true, tags: true },
        }),
        tx.attribute.findMany({
          select: { id: true, name: true, slug: true, type: true, unit: true },
        }),
        tx.attributeValue.findMany({
          select: { id: true, attributeId: true, value: true },
        }),
        tx.categoryAttribute.findMany({
          select: { id: true, categoryId: true, attributeId: true, isRequired: true, filterable: true, sortOrder: true },
        }),
      ]);

      // Build lookup maps (eliminates all N+1 findFirst queries)
      const catPathMap = new Map<string, { id: string; slug: string }>(); // key: `${parentId}::${nameLower}`
      const catSlugMap = new Map<string, boolean>();
      const attrSlugMap = new Map<string, { id: string; type: string }>();
      const attrValueSet = new Set<string>(); // key: `${attrId}::${valueLower}`
      const catAttrMap = new Map<string, { id: string; sortOrder: number }>(); // key: `${catId}::${attrId}`

      for (const c of allCats) {
        catPathMap.set(`${c.parentId ?? "root"}::${c.name.toLowerCase()}`, { id: c.id, slug: c.slug });
        catSlugMap.set(c.slug, true);
      }
      for (const a of allAttrs) attrSlugMap.set(a.slug, { id: a.id, type: a.type });
      for (const v of allAttrVals) attrValueSet.add(`${v.attributeId}::${v.value.toLowerCase()}`);
      for (const ca of allCatAttrs) catAttrMap.set(`${ca.categoryId}::${ca.attributeId}`, { id: ca.id, sortOrder: ca.sortOrder });

      // Track new slugs created inside this batch to avoid intra-batch collisions
      const newSlugsThisBatch = new Set<string>();

      // ─── 2️⃣ HELPERS (pure memory lookups + create) ─────────────────────
      const getOrCreateCategory = async (name: string, parentId: string | null): Promise<string> => {
        const pathKey = `${parentId ?? "root"}::${name.toLowerCase()}`;
        const cached = catPathMap.get(pathKey);
        if (cached) {
          batchCatsReused++;
          return cached.id;
        }

        let slug = slugify(name);
        if (catSlugMap.has(slug) || newSlugsThisBatch.has(slug)) {
          slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
        }
        newSlugsThisBatch.add(slug);

        const created = await tx.category.create({
          data: { name, slug, parentId: parentId ?? null },
        });
        catPathMap.set(pathKey, { id: created.id, slug: created.slug });
        catSlugMap.set(created.slug, true);
        batchCatsCreated++;
        return created.id;
      };

      const getOrCreateAttribute = async (name: string, type: AttributeType, unit: string): Promise<string> => {
        const slug = slugify(name);
        const cached = attrSlugMap.get(slug);
        if (cached) return cached.id;

        const created = await tx.attribute.create({
          data: { name, slug, type, unit: unit || null },
        });
        attrSlugMap.set(slug, { id: created.id, type: created.type });
        batchAttrsCreated++;
        return created.id;
      };

      // ─── 3️⃣ PROCESS EACH ROW ───────────────────────────────────────────
      const details: RowDetail[] = [];
      let batchCatsCreated = 0;
      let batchCatsReused = 0;
      let batchAttrsCreated = 0;
      let batchLinksCreated = 0;

      for (const row of rows) {
        const path = row.levels.filter(Boolean).join(" > ") || "N/A";

        // Snapshot counters for accurate per-row stats
        const before = {
          catsCreated: batchCatsCreated,
          catsReused: batchCatsReused,
          attrsCreated: batchAttrsCreated,
          linksCreated: batchLinksCreated,
        };

        try {
          let parentId: string | null = null;
          let leafId: string | null = null;
          let rootId: string | null = null;

          for (const name of row.levels) {
            if (!name) break;
            const id = await getOrCreateCategory(name, parentId);
            if (!rootId) rootId = id;
            leafId = id;
            parentId = id;
          }

          if (!leafId || !rootId) {
            throw new Error("No valid category levels found");
          }

          // Image → root category
          if (row.image) {
            await tx.category.update({ where: { id: rootId }, data: { image: row.image } });
          }

          // Keywords & Tags → leaf category
          const keywordList = row.keywords ? splitList(row.keywords) : [];
          const tagList = row.tags ? splitList(row.tags) : [];
          if (keywordList.length > 0 || tagList.length > 0) {
            await tx.category.update({
              where: { id: leafId },
              data: {
                ...(keywordList.length > 0 ? { keywords: keywordList } : {}),
                ...(tagList.length > 0 ? { tags: tagList } : {}),
              },
            });
          }

          // Attributes
          for (let i = 0; i < row.attrs.length; i++) {
            const attr = row.attrs[i];
            if (!attr.name || !attr.type) continue;

            const attributeId = await getOrCreateAttribute(attr.name, attr.type as AttributeType, attr.unit || "");

            if (attr.type === "SELECT" && attr.values) {
              const values = splitList(attr.values);
              const toCreate = values.filter((v) => !attrValueSet.has(`${attributeId}::${v.toLowerCase()}`));
              if (toCreate.length > 0) {
                await tx.attributeValue.createMany({
                  data: toCreate.map((value) => ({ attributeId, value })),
                  skipDuplicates: true,
                });
                for (const v of toCreate) attrValueSet.add(`${attributeId}::${v.toLowerCase()}`);
              }
            }

            const caKey = `${leafId}::${attributeId}`;
            const existingLink = catAttrMap.get(caKey);
            if (!existingLink) {
              await tx.categoryAttribute.create({
                data: {
                  categoryId: leafId,
                  attributeId,
                  isRequired: attr.required === "true",
                  filterable: attr.filterable !== "false",
                  sortOrder: i,
                },
              });
              catAttrMap.set(caKey, { id: "new", sortOrder: i });
              batchLinksCreated++;
            } else {
              await tx.categoryAttribute.updateMany({
                where: { categoryId: leafId, attributeId },
                data: {
                  isRequired: attr.required === "true",
                  filterable: attr.filterable !== "false",
                  sortOrder: i,
                },
              });
            }
          }

          details.push({
            row: row.excelRow,
            status: "imported",
            path,
            categoriesCreated: batchCatsCreated - before.catsCreated,
            categoriesReused: batchCatsReused - before.catsReused,
            attributesCreated: batchAttrsCreated - before.attrsCreated,
            categoryAttributeLinks: batchLinksCreated - before.linksCreated,
          });
        } catch (error: any) {
          details.push({
            row: row.excelRow,
            status: "failed",
            path,
            message: error.message || "Unexpected database error while saving this row",
            categoriesCreated: 0,
            categoriesReused: 0,
            attributesCreated: 0,
            categoryAttributeLinks: 0,
          });
        }
      }

      return {
        details,
        stats: {
          categoriesCreated: batchCatsCreated,
          categoriesReused: batchCatsReused,
          attributesCreated: batchAttrsCreated,
          categoryAttributeLinks: batchLinksCreated,
        },
      };
    },
    {
      timeout: 60_000, // 1 minute per batch (plenty for 500 rows)
      maxWait: 10_000,
    }
  );
}

// ─── Public entry point ───────────────────────────────────────────────────
export class BulkImportCategoryService {
  static async importFromBuffer(buffer: Buffer): Promise<ImportSummary> {
    // 1️⃣ File size guard
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `File size (${(buffer.length / 1024 / 1024).toFixed(2)} MB) exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB limit. Please split into smaller files.`
      );
    }

    const { rows } = await parseWorkbook(buffer);

    // 2️⃣ Row count guard
    if (rows.length > MAX_ROWS_PER_FILE) {
      throw new Error(
        `Too many rows: ${rows.length}. Maximum allowed is ${MAX_ROWS_PER_FILE} per file. Please split your data into multiple files.`
      );
    }

    // 3️⃣ Sheet-level pre-checks
    const conflictErrors = await checkAttributeConflicts(rows);
    const conflictRowSet = new Set(conflictErrors.map((e) => e.row));

    // 4️⃣ Row-by-row validation (fast, no DB)
    const validationErrorMap = new Map<number, string[]>();
    for (const row of rows) {
      const errs = validateRow(row);
      if (errs.length > 0) {
        validationErrorMap.set(
          row.excelRow,
          errs.map((e) => e.message)
        );
      }
    }

    // 5️⃣ Split into batches and import
    const rowDetails: RowDetail[] = [];
    const allTagsToTrack: string[] = [];

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);

      // Filter out invalid rows from this batch before DB hit
      const validBatch: ParsedRow[] = [];
      for (const row of batch) {
        const path = row.levels.filter(Boolean).join(" > ") || "N/A";

        if (conflictRowSet.has(row.excelRow)) {
          const messages = conflictErrors.filter((e) => e.row === row.excelRow).map((e) => e.message);
          rowDetails.push({
            row: row.excelRow,
            status: "failed",
            path,
            message: `Attribute conflict: ${messages.join("; ")}`,
            categoriesCreated: 0,
            categoriesReused: 0,
            attributesCreated: 0,
            categoryAttributeLinks: 0,
          });
          continue;
        }

        const valErrs = validationErrorMap.get(row.excelRow);
        if (valErrs) {
          rowDetails.push({
            row: row.excelRow,
            status: "failed",
            path,
            message: valErrs.join("; "),
            categoriesCreated: 0,
            categoriesReused: 0,
            attributesCreated: 0,
            categoryAttributeLinks: 0,
          });
          continue;
        }

        validBatch.push(row);
      }

      if (validBatch.length === 0) continue;

      // ✅ ONE transaction = ONE connection for up to 500 rows
      const result = await importBatch(validBatch, Math.floor(i / BATCH_SIZE) + 1);
      rowDetails.push(...result.details);

      // Collect tags for post-processing
      for (const row of validBatch) {
        if (row.keywords) allTagsToTrack.push(...splitList(row.keywords));
        if (row.tags) allTagsToTrack.push(...splitList(row.tags));
      }
    }

    // 6️⃣ Post-import keyword/tag tracking (best-effort, one connection)
    if (allTagsToTrack.length > 0) {
      await trackKeywordTagUsage(allTagsToTrack);
    }

    // 7️⃣ Aggregate
    const importedRows = rowDetails.filter((r) => r.status === "imported");
    const failedRows = rowDetails.filter((r) => r.status === "failed");

    return {
      totalRows: rows.length,
      imported: importedRows.length,
      failed: failedRows.length,
      categoriesCreated: importedRows.reduce((s, r) => s + r.categoriesCreated, 0),
      categoriesReused: importedRows.reduce((s, r) => s + r.categoriesReused, 0),
      attributesCreated: importedRows.reduce((s, r) => s + r.attributesCreated, 0),
      categoryAttributeLinks: importedRows.reduce((s, r) => s + r.categoryAttributeLinks, 0),
      errors: failedRows.map((r) => ({ row: r.row, message: r.message || "Unknown error" })),
      warnings: [],
      rowDetails,
    };
  }
}