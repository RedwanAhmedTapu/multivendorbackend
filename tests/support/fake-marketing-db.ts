// tests/support/fake-marketing-db.ts
//
// In-memory MarketingDb for the vendor-programme service tests. Supports
// exactly the query shapes the service uses (equality, in/notIn/not/lt/gt,
// contains, OR, count/groupBy, joined includes). Models the merge rules of the
// real schema: one programme per campaign page (unique campaignPageId) and a
// page can't be deleted while a programme points at it (FK RESTRICT).
// $transaction snapshots the store and restores it if the callback throws —
// so tests can assert a failed action left nothing behind.
// Vendor side: one registration per campaign + variant (unique key → a
// Prisma-like P2002 error), products/variants/vendors/users/employees.

import { Decimal } from "@prisma/client/runtime/library";
import type { MarketingDb } from "../../src/modules/marketing/campaign.service.ts";

type Row = Record<string, any>;
export interface Store {
  pages: Row[];
  campaigns: Row[];
  campaignCategories: Row[];
  registrations: Row[];
  categories: Row[];
  variants: Row[];
  products: Row[];
  vendors: Row[];
  users: Row[];
  employees: Row[];
  audit: Row[];
  notifications: Row[];
}

let seq = 0;
const nextId = (p: string) => `${p}_${++seq}`;

/** Deep clone that keeps Decimal and Date instances (structuredClone would not). */
function clone<T>(v: T): T {
  if (v instanceof Decimal) return new Decimal(v) as T;
  if (v instanceof Date) return new Date(v.getTime()) as T;
  if (Array.isArray(v)) return v.map(clone) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  return v;
}

function cmp(a: any, b: any) {
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() - new Date(b).getTime();
  if (a instanceof Decimal || b instanceof Decimal) return new Decimal(a).comparedTo(new Decimal(b));
  return a < b ? -1 : a > b ? 1 : 0;
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as Row[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !(cond instanceof Decimal)) {
      return Object.entries(cond).every(([op, x]) => {
        switch (op) {
          case "in": return (x as any[]).includes(v);
          case "notIn": return !(x as any[]).includes(v);
          case "not": return v !== x;
          case "lt": return cmp(v, x) < 0;
          case "gt": return cmp(v, x) > 0;
          case "contains": return String(v ?? "").toLowerCase().includes(String(x).toLowerCase());
          case "mode": return true;
          case "equals": return cmp(v, x) === 0;
          default: throw new Error(`fake db: unsupported operator ${op}`);
        }
      });
    }
    return cond instanceof Date ? cmp(v, cond) === 0 : v === cond;
  });
}

export function createFakeMarketingDb(seed: Partial<Store> = {}) {
  let s: Store = {
    pages: [], campaigns: [], campaignCategories: [], registrations: [], categories: [], variants: [], products: [], vendors: [], users: [], employees: [], audit: [], notifications: [],
    ...clone(seed),
  };

  const pageOf = (id: string) => s.pages.find((p) => p.id === id);
  const withRelations = (c: Row) => ({
    ...c,
    categories: s.campaignCategories.filter((x) => x.campaignId === c.id).map((x) => ({ ...x, category: s.categories.find((k) => k.id === x.categoryId) })),
    campaignPage: pageOf(c.campaignPageId),
  });
  const joinReg = (r: Row) => ({
    ...r,
    campaign: withRelations(s.campaigns.find((c) => c.id === r.campaignId)!),
    variant: s.variants.find((v) => v.id === r.variantId),
    product: s.products.find((p) => p.id === r.productId),
    vendor: s.vendors.find((v) => v.id === r.vendorId),
  });
  const byOrder = (a: Row = {}) => (x: Row, y: Row) => {
    const [[k, dir] = ["createdAt", "asc"]] = Object.entries(a.orderBy ?? {});
    return cmp(x[k], y[k]) * (dir === "desc" ? -1 : 1);
  };
  const page = <T,>(rows: T[], a: Row = {}) => rows.slice(a.skip ?? 0, a.take !== undefined ? (a.skip ?? 0) + a.take : undefined);

  const db: MarketingDb & { store: () => Store } = {
    store: () => s,
    campaignPage: {
      async findUnique({ where }: Row) { return pageOf(where.id) ?? null; },
      async findMany(a: Row = {}) {
        const rows = s.pages.filter((p) => matches(p, a.where)).sort((x, y) => cmp(y.updatedAt, x.updatedAt));
        return page(rows, a).map((p) => {
          const mc = s.campaigns.find((c) => c.campaignPageId === p.id);
          return { ...p, marketingCampaign: mc ? { id: mc.id, status: mc.status } : null };
        });
      },
      async count(a: Row = {}) { return s.pages.filter((p) => matches(p, a.where)).length; },
      async update({ where, data, include }: Row) {
        const p = pageOf(where.id);
        if (!p) throw new Error("fake db: page not found");
        Object.assign(p, data, { updatedAt: new Date() });
        return include ? { ...p, _count: { components: 0 } } : { ...p };
      },
      async delete({ where }: Row) {
        if (s.campaigns.some((c) => c.campaignPageId === where.id)) throw new Error("fake db: FK RESTRICT — programme still references the page");
        const p = pageOf(where.id);
        s.pages = s.pages.filter((x) => x.id !== where.id);
        return p;
      },
    } as any,
    marketingCampaign: {
      async findUnique({ where }) {
        const c = s.campaigns.find((x) => (where.id ? x.id === where.id : x.campaignPageId === where.campaignPageId));
        return c ? withRelations(c) : null;
      },
      async create({ data }) {
        if (s.campaigns.some((c) => c.campaignPageId === data.campaignPageId)) throw new Error("fake db: unique campaignPageId");
        const { categories, ...rest } = data;
        const row = { id: nextId("prog"), createdAt: new Date(), updatedAt: new Date(), maxProductsPerVendor: null, ...rest };
        s.campaigns.push(row);
        for (const c of categories?.create ?? []) s.campaignCategories.push({ id: nextId("cc"), campaignId: row.id, ...c });
        return withRelations(row);
      },
      async updateMany({ where, data }) {
        const rows = s.campaigns.filter((c) => matches(c, where));
        for (const r of rows) Object.assign(r, data, { updatedAt: new Date() });
        return { count: rows.length };
      },
      async delete({ where }: Row) {
        const c = s.campaigns.find((x) => x.id === where.id);
        s.campaigns = s.campaigns.filter((x) => x.id !== where.id);
        return c;
      },
      async findMany(a: Row = {}) { return s.campaigns.filter((c) => matches(c, a.where)).map(withRelations); },
    } as any,
    marketingCampaignCategory: {
      async deleteMany({ where }) {
        const before = s.campaignCategories.length;
        s.campaignCategories = s.campaignCategories.filter((x) => !matches(x, where));
        return { count: before - s.campaignCategories.length };
      },
      async create({ data }) { const row = { id: nextId("cc"), ...data }; s.campaignCategories.push(row); return row; },
    } as any,
    campaignRegistration: {
      async findUnique({ where }) { const r = s.registrations.find((x) => x.id === where.id); return r ? joinReg(r) : null; },
      async findMany(a: Row = {}) {
        const rows = s.registrations.filter((r) => matches(r, a.where)).sort(byOrder(a));
        return page(rows, a).map(joinReg);
      },
      async create({ data }: Row) {
        if (s.registrations.some((r) => r.campaignId === data.campaignId && r.variantId === data.variantId)) {
          throw Object.assign(new Error("fake db: unique (campaignId, variantId)"), { code: "P2002" });
        }
        const row = { id: nextId("reg"), createdAt: new Date(), updatedAt: new Date(), ...data };
        s.registrations.push(row);
        return { ...row };
      },
      async count(a = {}) { return s.registrations.filter((r) => matches(r, a.where)).length; },
      async updateMany({ where, data }) {
        const rows = s.registrations.filter((r) => matches(r, where));
        for (const r of rows) Object.assign(r, data, { updatedAt: new Date() });
        return { count: rows.length };
      },
      async groupBy({ by, where, _count }) {
        const groups = new Map<string, Row>();
        for (const r of s.registrations.filter((x) => matches(x, where))) {
          const key = by.map((k: string) => r[k]).join("|");
          const g = groups.get(key) ?? { ...Object.fromEntries(by.map((k: string) => [k, r[k]])), _count: { _all: 0 } };
          g._count._all++;
          groups.set(key, g);
        }
        return [...groups.values()].map((g) => (_count ? g : (({ _count: _c, ...rest }) => rest)(g)));
      },
    } as any,
    category: {
      async findMany({ where }) { return s.categories.filter((c) => matches(c, where)); },
      async findUnique({ where }) { return s.categories.find((c) => c.id === where.id) ?? null; },
    } as any,
    product: {
      async findMany(a: Row = {}) {
        return s.products.filter((p) => matches(p, a.where)).sort(byOrder(a)).map((p) => ({ ...p, variants: s.variants.filter((v) => v.productId === p.id) }));
      },
    } as any,
    productVariant: {
      async findMany(a: Row = {}) { return s.variants.filter((v) => matches(v, a.where)).map((v) => ({ ...v, product: s.products.find((p) => p.id === v.productId) })); },
    } as any,
    vendor: { async findUnique({ where }: Row) { return s.vendors.find((v) => v.id === where.id) ?? null; } } as any,
    user: { async findMany(a: Row = {}) { return s.users.filter((u) => matches(u, a.where)); } } as any,
    employee: { async findMany(a: Row = {}) { return s.employees.filter((e) => matches(e, a.where)); } } as any,
    auditLog: { async create({ data }) { const row = { id: nextId("audit"), createdAt: new Date(), ...data }; s.audit.push(row); return row; } } as any,
    notification: { async create({ data }) { const row = { id: nextId("notif"), ...data }; s.notifications.push(row); return row; } } as any,
    async $transaction(fn) {
      const saved = clone(s);
      try {
        return await fn(db);
      } catch (e) {
        s = saved;
        throw e;
      }
    },
  };
  return db;
}

/** A small consistent world: campaign pages, a category tree, two vendors, products, variants. */
export function seedWorld() {
  const t = (iso: string) => new Date(iso);
  return {
    pages: [
      { id: "PG1", title: "Mega Sale", slug: "mega-sale", status: "DRAFT", heroImage: null, startDate: t("2026-10-21T00:00:00Z"), endDate: t("2026-10-25T00:00:00Z"), updatedAt: t("2026-10-01T00:00:00Z") },
      { id: "PG2", title: "Eid Festival", slug: "eid-festival", status: "PUBLISHED", heroImage: null, startDate: t("2026-11-01T00:00:00Z"), endDate: t("2026-11-05T00:00:00Z"), updatedAt: t("2026-10-02T00:00:00Z") },
      { id: "PG_NODATES", title: "Evergreen landing page", slug: "evergreen", status: "PUBLISHED", heroImage: null, startDate: null, endDate: null, updatedAt: t("2026-09-01T00:00:00Z") },
    ],
    categories: [
      { id: "cat-root", name: "Electronics", parentId: null },
      { id: "cat-phones", name: "Phones", parentId: "cat-root" },
      { id: "cat-fashion", name: "Fashion", parentId: null },
    ],
    vendors: [
      { id: "V1", storeName: "Store One", status: "ACTIVE" },
      { id: "V2", storeName: "Store Two", status: "SUSPENDED" },
      { id: "V3", storeName: "Store Three", status: "ACTIVE" },
    ],
    // V1: P1, P2, P3, P4 · V3: P5
    products: [
      { id: "P1", name: "Phone X", slug: "phone-x", vendorId: "V1", approvalStatus: "ACTIVE", isDeleted: false, categoryId: "cat-phones" },
      { id: "P2", name: "Shirt", slug: "shirt", vendorId: "V1", approvalStatus: "ACTIVE", isDeleted: false, categoryId: "cat-fashion" },
      { id: "P3", name: "Phone Y", slug: "phone-y", vendorId: "V1", approvalStatus: "ACTIVE", isDeleted: false, categoryId: "cat-phones" },
      { id: "P4", name: "Phone Draft", slug: "phone-draft", vendorId: "V1", approvalStatus: "PENDING", isDeleted: false, categoryId: "cat-phones" },
      { id: "P5", name: "Other Store Phone", slug: "other-phone", vendorId: "V3", approvalStatus: "ACTIVE", isDeleted: false, categoryId: "cat-phones" },
    ],
    variants: [
      { id: "VAR1", productId: "P1", sku: "PX-1", name: null, price: new Decimal("1000"), specialPrice: null, stock: 50 },
      { id: "VAR2", productId: "P2", sku: "SH-1", name: null, price: new Decimal("500"), specialPrice: new Decimal("400"), stock: 5 },
      { id: "VAR3", productId: "P3", sku: "PY-1", name: null, price: new Decimal("2000"), specialPrice: null, stock: 20 },
      { id: "VAR1B", productId: "P1", sku: "PX-2", name: "256 GB", price: new Decimal("1200"), specialPrice: new Decimal("1100"), stock: 3 },
      { id: "VAR4", productId: "P4", sku: "PD-1", name: null, price: new Decimal("900"), specialPrice: null, stock: 30 },
      { id: "VAR5", productId: "P5", sku: "OP-1", name: null, price: new Decimal("1500"), specialPrice: null, stock: 40 },
    ],
    users: [
      { id: "U_ADMIN", role: "ADMIN", isActive: true },
      { id: "U_ADMIN_OFF", role: "ADMIN", isActive: false },
      { id: "U_VENDOR1", role: "VENDOR", isActive: true },
    ],
    employees: [
      { id: "E_MKT", vendorId: null, isActive: true, permissions: { marketingManagement: true } },
      { id: "E_OFFERS", vendorId: null, isActive: true, permissions: { offerManagement: true } },
      { id: "E_MKT_OFF", vendorId: null, isActive: false, permissions: { marketingManagement: true } },
      { id: "E_V1_MKT", vendorId: "V1", isActive: true, permissions: { marketingManagement: true } },
    ],
  };
}
