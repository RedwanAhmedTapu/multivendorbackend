import { prisma } from "../config/prisma.ts";
import pkg from "xlsx";
const { readFile, utils } = pkg;

export const BulkImportService = {
  async import(filePath: string) {
    // Read workbook
    const workbook = readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[][] = utils.sheet_to_json(sheet, { header: 1 });

    if (!rows.length) {
      return { success: false, message: "Empty file uploaded" };
    }

    const headers: string[] = rows[0].map((h: any) =>
      h?.toString().trim().toLowerCase()
    );

    // Find index ranges
    const specIndex = headers.findIndex((h) => h.includes("specification"));
    const attrIndex = headers.findIndex((h) => h.includes("attribute"));

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every((cell: any) => !cell)) continue; // skip empty rows

      // 1️⃣ Handle unlimited category layers before specifications
      let parentId: string | null = null;
      for (let c = 0; c < specIndex; c++) {
        const catName = row[c];
        if (!catName) continue;

        const slug = catName.toString().toLowerCase().replace(/\s+/g, "-");
        let category = await prisma.category.findUnique({ where: { slug } });

        if (!category) {
          category = await prisma.category.create({
            data: { name: catName, slug, parentId },
          });
        }

        parentId = category.id;
      }

      if (!parentId) continue;

      // 2️⃣ Handle multiple specifications (specName, specType, unit grouped in 3 columns)
      if (specIndex >= 0 && attrIndex > specIndex) {
        for (let c = specIndex; c < attrIndex; c += 3) {
          const specName = row[c];
          if (!specName) continue;

          const specType = row[c + 1];
          const unit = row[c + 2];
          const specSlug = specName.toString().toLowerCase().replace(/\s+/g, "-");

          let specification = await prisma.specification.findUnique({
            where: { slug: specSlug },
          });

          if (!specification) {
            specification = await prisma.specification.create({
              data: {
                name: specName,
                slug: specSlug,
                type: specType?.toString().toUpperCase() || "TEXT",
                unit: unit || null,
              },
            });
          }

          await prisma.categorySpecification.upsert({
            where: {
              categoryId_specificationId: {
                categoryId: parentId,
                specificationId: specification.id,
              },
            },
            create: { categoryId: parentId, specificationId: specification.id },
            update: {},
          });
        }
      }

      // 3️⃣ Handle multiple attributes (attrName, attrType, values grouped in 3 columns)
      if (attrIndex >= 0) {
        for (let c = attrIndex; c < row.length; c += 3) {
          const attrName = row[c];
          if (!attrName) continue;

          const attrType = row[c + 1];
          const valuesStr = row[c + 2];
          const attrSlug = attrName.toString().toLowerCase().replace(/\s+/g, "-");

          let attribute = await prisma.attribute.findUnique({
            where: { slug: attrSlug },
          });

          if (!attribute) {
            attribute = await prisma.attribute.create({
              data: {
                name: attrName,
                slug: attrSlug,
                type: attrType?.toString().toUpperCase() || "TEXT",
              },
            });
          }

          await prisma.categoryAttribute.upsert({
            where: {
              categoryId_attributeId: {
                categoryId: parentId,
                attributeId: attribute.id,
              },
            },
            create: { categoryId: parentId, attributeId: attribute.id },
            update: {},
          });

          // Handle attribute values if SELECT
          if (valuesStr && attrType?.toString().toUpperCase() === "SELECT") {
            const values = valuesStr.split(",").map((v: string) => v.trim());
            for (const v of values) {
              const exist = await prisma.attributeValue.findFirst({
                where: { attributeId: attribute.id, value: v },
              });
              if (!exist) {
                await prisma.attributeValue.create({
                  data: { attributeId: attribute.id, value: v },
                });
              }
            }
          }
        }
      }
    }

    return {
      success: true,
      message: "✅ Bulk import completed with nested categories, specs & attributes",
    };
  },
};
