// services/vendorProductFieldRule.service.ts
import { prisma } from "../config/prisma.ts";
import type { ProductField } from "@prisma/client";

export const ALL_PRODUCT_FIELDS: ProductField[] = [
  "NAME_BN",
  "DESCRIPTION",
  "IMAGES",
  "VARIANT_IMAGES",
  "WARRANTY",
  "ATTRIBUTES",
  "SPECIAL_PRICE",
  "DISCOUNT",
  "SKU",
  "STOCK",
];

export const VendorProductFieldRuleService = {
  // ======================
  // Admin: list rules configured for a vendor
  // ======================
  async getByVendorId(vendorId: string, categoryId?: string) {
    const where: any = { vendorId };
    if (categoryId !== undefined) {
      where.categoryId = categoryId === "null" ? null : categoryId;
    }

    return prisma.vendorProductFieldRule.findMany({
      where,
      include: { category: { select: { id: true, name: true } } },
      orderBy: [{ categoryId: "asc" }, { field: "asc" }],
    });
  },

  // ======================
  // Vendor: resolve the effective rule per field.
  // Category-specific rule wins over vendor-wide rule, which wins
  // over the system default (enabled, not required).
  // ======================
  async getResolvedForVendor(vendorId: string, categoryId?: string) {
    const rules = await prisma.vendorProductFieldRule.findMany({
      where: {
        vendorId,
        OR: [
          ...(categoryId ? [{ categoryId }] : []),
          { categoryId: null },
        ],
      },
    });

    const resolved: Record<
      string,
      { isEnabled: boolean; isRequired: boolean; source: "category" | "vendor" | "default" }
    > = {};

    for (const field of ALL_PRODUCT_FIELDS) {
      const categoryRule = categoryId
        ? rules.find((r) => r.field === field && r.categoryId === categoryId)
        : undefined;
      const vendorWideRule = rules.find((r) => r.field === field && r.categoryId === null);
      const rule = categoryRule ?? vendorWideRule;

      resolved[field] = rule
        ? {
            isEnabled: rule.isEnabled,
            isRequired: rule.isRequired,
            source: categoryRule ? "category" : "vendor",
          }
        : { isEnabled: true, isRequired: false, source: "default" };
    }

    return resolved;
  },

  // ======================
  // Admin: create or update a single field rule.
  // Done as a manual find-then-write (not prisma upsert) because
  // Postgres treats NULL as distinct in unique constraints, so
  // @@unique([vendorId, categoryId, field]) won't dedupe rows where
  // categoryId is null the way Prisma's composite-key upsert expects.
  // ======================
  async upsert(
    vendorId: string,
    categoryId: string | null,
    field: ProductField,
    data: { isEnabled?: boolean; isRequired?: boolean },
    adminId: string
  ) {
    const existing = await prisma.vendorProductFieldRule.findFirst({
      where: { vendorId, categoryId, field },
    });

    if (existing) {
      return prisma.vendorProductFieldRule.update({
        where: { id: existing.id },
        data: {
          ...(data.isEnabled !== undefined && { isEnabled: data.isEnabled }),
          ...(data.isRequired !== undefined && { isRequired: data.isRequired }),
          setById: adminId,
        },
      });
    }

    return prisma.vendorProductFieldRule.create({
      data: {
        vendorId,
        categoryId,
        field,
        isEnabled: data.isEnabled ?? true,
        isRequired: data.isRequired ?? false,
        setById: adminId,
      },
    });
  },

  // ======================
  // Admin: save a whole settings form at once
  // ======================
  async bulkUpsert(
    vendorId: string,
    categoryId: string | null,
    rules: { field: ProductField; isEnabled?: boolean; isRequired?: boolean }[],
    adminId: string
  ) {
    const results = [];
    for (const rule of rules) {
      results.push(await this.upsert(vendorId, categoryId, rule.field, rule, adminId));
    }
    return results;
  },

  // ======================
  // Admin: remove a rule (field reverts to system default for that vendor/category)
  // ======================
  async remove(id: string) {
    const existing = await prisma.vendorProductFieldRule.findUnique({ where: { id } });
    if (!existing) {
      throw new Error("Vendor product field rule not found");
    }
    return prisma.vendorProductFieldRule.delete({ where: { id } });
  },

  getAvailableFields() {
    return ALL_PRODUCT_FIELDS;
  },
  // ======================
// Admin: list every configured (vendor, scope) pair, grouped with counts.
// Rules are stored per-field, so we fetch them all and group in memory —
// simplest correct approach unless this table grows very large, at which
// point a materialized summary table would be worth adding.
// ======================
async getAllScopes(options?: { search?: string; page?: number; limit?: number }) {
  const { search, page = 1, limit = 20 } = options ?? {};

  const rules = await prisma.vendorProductFieldRule.findMany({
    include: {
      vendor: { select: { id: true, storeName: true } },
      category: { select: { id: true, name: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  type ScopeSummary = {
    vendorId: string;
    vendorName: string;
    categoryId: string | null;
    categoryName: string | null;
    totalFields: number;
    enabledCount: number;
    requiredCount: number;
    updatedAt: Date;
  };

  const grouped = new Map<string, ScopeSummary>();

  for (const r of rules) {
    const key = `${r.vendorId}::${r.categoryId ?? "null"}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.totalFields += 1;
      if (r.isEnabled) existing.enabledCount += 1;
      if (r.isRequired) existing.requiredCount += 1;
      if (r.updatedAt > existing.updatedAt) existing.updatedAt = r.updatedAt;
    } else {
      grouped.set(key, {
        vendorId: r.vendorId,
        vendorName: r.vendor.storeName,
        categoryId: r.categoryId,
        categoryName: r.category?.name ?? null,
        totalFields: 1,
        enabledCount: r.isEnabled ? 1 : 0,
        requiredCount: r.isRequired ? 1 : 0,
        updatedAt: r.updatedAt,
      });
    }
  }

  let scopes = Array.from(grouped.values()).sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
  );

  if (search) {
    const q = search.toLowerCase();
    scopes = scopes.filter(
      (s) =>
        s.vendorName.toLowerCase().includes(q) ||
        (s.categoryName ?? "vendor-wide").toLowerCase().includes(q)
    );
  }

  const total = scopes.length;
  const start = (page - 1) * limit;
  const paginated = scopes.slice(start, start + limit);

  return {
    scopes: paginated,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
},

// ======================
// Admin: clear every field rule for a given vendor/scope in one shot
// (used by the "Remove" action in the assignments list)
// ======================
async removeByScope(vendorId: string, categoryId: string | null) {
  return prisma.vendorProductFieldRule.deleteMany({
    where: { vendorId, categoryId },
  });
},
};