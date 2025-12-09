import { prisma } from "../config/prisma.ts";
import pkg from "xlsx";
const { readFile, utils } = pkg;

export const BulkImportService = {
  async import(filePath: string) {
    try {
      const workbook = readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows: any[][] = utils.sheet_to_json(sheet, { header: 1 });

      if (!rows.length) {
        return { success: false, message: "Empty file uploaded" };
      }

      const headers: string[] = rows[0].map((h: any) =>
        h?.toString().trim().toLowerCase()
      );

      // Find special column indices
      const keywordsIndex = headers.indexOf("keywords");
      const tagsIndex = headers.indexOf("tags");
      const imageIndex = headers.indexOf("image");
      const attrStartIndex = headers.findIndex((h) => h.startsWith("attr_"));

      // Determine where category columns end
      const specialIndices = [keywordsIndex, tagsIndex, imageIndex, attrStartIndex].filter(idx => idx !== -1);
      const categoryEndIndex = specialIndices.length > 0 ? Math.min(...specialIndices) : headers.length;

      let stats = {
        categoriesCreated: 0,
        categoriesUpdated: 0,
        attributesCreated: 0,
        attributeValuesCreated: 0,
      };

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.every((cell: any) => !cell)) continue;

        // 1️⃣ Build category hierarchy - support unlimited nesting
        let parentId: string | null = null;
        let rootCategory: any = null;
        let leafCategory: any = null;
        const categoryLevels: any[] = [];

        for (let c = 0; c < categoryEndIndex; c++) {
          const catName = row[c];
          if (!catName) continue;

          const slug = catName
            .toString()
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9-]/g, "");

          let category = await prisma.category.findUnique({ where: { slug } });

          if (!category) {
            category = await prisma.category.create({
              data: { name: catName.toString(), slug, parentId },
            });
            stats.categoriesCreated++;
          } else if (category.parentId !== parentId) {
            // Update parent if different
            category = await prisma.category.update({
              where: { id: category.id },
              data: { parentId },
            });
            stats.categoriesUpdated++;
          }

          // Track root (first) and leaf (last) categories
          if (!rootCategory) rootCategory = category;
          leafCategory = category;
          categoryLevels.push(category);
          
          parentId = category.id;
        }

        if (!leafCategory || !rootCategory) continue;

        // 2️⃣ Add IMAGE to ROOT (top-level) category only
        if (imageIndex !== -1 && row[imageIndex] && rootCategory) {
          const imageUrl = row[imageIndex].toString();
          await prisma.category.update({
            where: { id: rootCategory.id },
            data: { image: imageUrl },
          });
        }

        // 3️⃣ Add KEYWORDS and TAGS to LEAF (last/deepest) category only
        const leafUpdates: any = {};

        if (keywordsIndex !== -1 && row[keywordsIndex]) {
          leafUpdates.keywords = row[keywordsIndex]
            .toString()
            .split(",")
            .map((k: string) => k.trim())
            .filter(Boolean);
        }

        if (tagsIndex !== -1 && row[tagsIndex]) {
          leafUpdates.tags = row[tagsIndex]
            .toString()
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean);
        }

        if (Object.keys(leafUpdates).length > 0) {
          await prisma.category.update({
            where: { id: leafCategory.id },
            data: leafUpdates,
          });
        }

        // 4️⃣ Process attributes - attach to LEAF category
        if (attrStartIndex !== -1) {
          for (let c = attrStartIndex; c < row.length; c += 6) {
            const attrName = row[c];
            if (!attrName) continue;

            const attrType = row[c + 1]?.toString().toUpperCase() || "TEXT";
            const attrUnit = row[c + 2] || null;
            const isRequired = row[c + 3]?.toString().toLowerCase() === "true";
            const filterable = row[c + 4]?.toString().toLowerCase() !== "false";
            const valuesStr = row[c + 5];

            const attrSlug = attrName
              .toString()
              .toLowerCase()
              .replace(/\s+/g, "-")
              .replace(/[^a-z0-9-]/g, "");

            // Create or get attribute
            let attribute = await prisma.attribute.findUnique({
              where: { slug: attrSlug },
            });

            if (!attribute) {
              attribute = await prisma.attribute.create({
                data: {
                  name: attrName.toString(),
                  slug: attrSlug,
                  type: attrType as any,
                  unit: attrUnit?.toString() || null,
                },
              });
              stats.attributesCreated++;
            }

            // Link attribute to LEAF category
            await prisma.categoryAttribute.upsert({
              where: {
                categoryId_attributeId: {
                  categoryId: leafCategory.id,
                  attributeId: attribute.id,
                },
              },
              create: {
                categoryId: leafCategory.id,
                attributeId: attribute.id,
                isRequired,
                filterable,
              },
              update: {
                isRequired,
                filterable,
              },
            });

            // Handle attribute values for SELECT/MULTISELECT
            if (
              valuesStr &&
              (attrType === "SELECT" || attrType === "MULTISELECT")
            ) {
              const values = valuesStr
                .toString()
                .split(",")
                .map((v: string) => v.trim())
                .filter(Boolean);

              for (const v of values) {
                const existing = await prisma.attributeValue.findFirst({
                  where: { attributeId: attribute.id, value: v },
                });

                if (!existing) {
                  await prisma.attributeValue.create({
                    data: { attributeId: attribute.id, value: v },
                  });
                  stats.attributeValuesCreated++;
                }
              }
            }
          }
        }
      }

      return {
        success: true,
        message: "✅ Bulk import completed successfully",
        stats,
      };
    } catch (error: any) {
      console.error("Bulk import error:", error);
      return {
        success: false,
        message: `Import failed: ${error.message}`,
      };
    }
  },
};