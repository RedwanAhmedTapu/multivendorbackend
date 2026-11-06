// tests/support/fake-billing-db.ts
//
// A small in-memory stand-in for the Prisma delegates used by the
// subscription and payout services (DB-free tests). Supports equality,
// in / not / lt / lte / gt / gte / startsWith / contains, OR, composite unique
// keys, include / select of declared relations (+ _count), increment,
// unique-constraint errors (code P2002) and rollback of $transaction on throw.
// Money is stored as decimal strings.

import { Decimal } from "@prisma/client/runtime/library";

type Row = Record<string, any>;
type Rel = { model: string; fk: string; many: boolean };

const RELATIONS: Record<string, Record<string, Rel>> = {
  subscriptionPackage: {
    features: { model: "subscriptionPackageFeature", fk: "packageId", many: true },
    prices: { model: "subscriptionPackagePrice", fk: "packageId", many: true },
    subscribers: { model: "vendorSubscription", fk: "packageId", many: true },
  },
  subscriptionFeature: { packages: { model: "subscriptionPackageFeature", fk: "featureId", many: true } },
  subscriptionPackageFeature: { feature: { model: "subscriptionFeature", fk: "featureId", many: false }, package: { model: "subscriptionPackage", fk: "packageId", many: false } },
  subscriptionPackagePrice: { cycle: { model: "subscriptionCycle", fk: "cycleId", many: false }, package: { model: "subscriptionPackage", fk: "packageId", many: false } },
  vendorSubscription: { vendor: { model: "vendor", fk: "vendorId", many: false }, package: { model: "subscriptionPackage", fk: "packageId", many: false }, cycle: { model: "subscriptionCycle", fk: "cycleId", many: false } },
  vendorSubscriptionOffer: { vendor: { model: "vendor", fk: "vendorId", many: false }, package: { model: "subscriptionPackage", fk: "packageId", many: false }, cycle: { model: "subscriptionCycle", fk: "cycleId", many: false }, feature: { model: "subscriptionFeature", fk: "featureId", many: false } },
  subscriptionPayment: { vendor: { model: "vendor", fk: "vendorId", many: false }, package: { model: "subscriptionPackage", fk: "packageId", many: false }, cycle: { model: "subscriptionCycle", fk: "cycleId", many: false } },
  payoutBatch: { items: { model: "payoutBatchItem", fk: "batchId", many: true } },
  payoutBatchItem: { batch: { model: "payoutBatch", fk: "batchId", many: false }, vendor: { model: "vendor", fk: "vendorId", many: false } },
  vendorPayoutRule: { vendor: { model: "vendor", fk: "vendorId", many: false } },
};

const UNIQUE: Record<string, string[][]> = {
  subscriptionFeature: [["key"]],
  subscriptionPackage: [["slug"]],
  subscriptionCycle: [["key"]],
  subscriptionPackageFeature: [["packageId", "featureId"]],
  subscriptionPackagePrice: [["packageId", "cycleId"]],
  vendorSubscription: [["vendorId"]],
  subscriptionPayment: [["idempotencyKey"]],
  vendorFeatureUsage: [["vendorId", "featureId", "limitKey", "periodKey"]],
  vendorPayoutRule: [["vendorId"]],
  vendorPayable: [["vendorId"]],
  payoutBatch: [["batchNumber"]],
  payoutBatchItem: [["batchId", "vendorId"]],
  platformSettings: [["key"]],
};

const PK: Record<string, string> = { vendorPayoutRule: "vendorId", platformSettings: "key" };

const DEFAULTS: Record<string, () => Row> = {
  subscriptionFeature: () => ({ limitDefs: [], enforced: false, isActive: true, sortOrder: 0, description: null, icon: null, color: null, category: null }),
  subscriptionPackage: () => ({ status: "DRAFT", visibility: "PUBLIC", isPopular: false, displayOrder: 0, trialDays: null, description: null, icon: null, color: null }),
  subscriptionPackageFeature: () => ({ enabled: true, config: {} }),
  subscriptionCycle: () => ({ isActive: true, sortOrder: 0 }),
  subscriptionPackagePrice: () => ({ promoPrice: null, discountPercent: null, isActive: true }),
  vendorSubscription: () => ({ planType: "FREE", isActive: true, packageId: null, cycleId: null, status: null, source: null, startedAt: null, expiresAt: null, graceDays: null, autoRenew: false, amountPaid: null, currency: "BDT", offerId: null, previousPackageId: null, suspendedReason: null, cancelledAt: null, reminderSentFor: null, version: 0 }),
  vendorSubscriptionOffer: () => ({ status: "ACTIVE", afterExpiry: "MANUAL_RENEWAL", afterExpiryPackageId: null, packageId: null, cycleId: null, featureId: null, value: null, note: null }),
  subscriptionPayment: () => ({ currency: "BDT", status: "PENDING", reference: null, offerId: null, periodStart: null, periodEnd: null, note: null }),
  vendorFeatureUsage: () => ({ used: 0 }),
  vendorPayoutRule: () => ({ cycle: null, weekday: null, monthDays: [], customIntervalDays: null, anchorDate: null, minThreshold: null, settlementDelayDays: null, requireApproval: null, paused: false, holdUntil: null, holdReason: null, note: null }),
  vendorPayable: () => ({ balance: "0", totalPaid: "0", totalPayouts: 0, lastPayoutAt: null, nextPayoutDate: null }),
  payoutBatch: () => ({ status: "DRAFT", totalAmount: "0", vendorCount: 0, approvedById: null, approvedAt: null, note: null, createdById: null }),
  payoutBatchItem: () => ({ status: "PENDING", method: null, reference: null, voucherId: null, paidAt: null, paidById: null, heldReason: null }),
};

const norm = (v: any): any => {
  if (v instanceof Decimal) return v.toString();
  if (v && typeof v === "object" && typeof v.toFixed === "function" && typeof v.plus === "function") return v.toString();
  return v;
};
const isNumLike = (v: any) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))));
const cmpVal = (a: any) => (a instanceof Date ? a.getTime() : isNumLike(a) ? Number(a) : a);
const eq = (a: any, b: any) => {
  if (a instanceof Date || b instanceof Date) return a != null && b != null && new Date(a).getTime() === new Date(b).getTime();
  if (isNumLike(a) && isNumLike(b) && (typeof a !== typeof b || typeof a === "string")) return Number(a) === Number(b);
  return a === b;
};

export function createFakeBillingDb(seed: Partial<Record<string, Row[]>> = {}) {
  let tables: Record<string, Row[]> = {};
  let seq = 0;
  for (const [k, rows] of Object.entries(seed)) tables[k] = (rows ?? []).map((r) => ({ ...r }));
  const table = (m: string) => (tables[m] ??= []);

  function matches(m: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [k, cond] of Object.entries(where)) {
      if (k === "OR") { if (!(cond as Row[]).some((w) => matches(m, row, w))) return false; continue; }
      if (k === "AND") { if (!(cond as Row[]).every((w) => matches(m, row, w))) return false; continue; }
      const rel = RELATIONS[m]?.[k];
      if (rel && !rel.many && cond && typeof cond === "object") {
        const target = table(rel.model).find((t) => t.id === row[rel.fk]);
        if (!target || !matches(rel.model, target, cond)) return false;
        continue;
      }
      const v = row[k];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
        for (const [op, x] of Object.entries(cond as Row)) {
          if (op === "in" && !(x as any[]).some((y) => eq(v, y))) return false;
          if (op === "notIn" && (x as any[]).some((y) => eq(v, y))) return false;
          if (op === "not" && (x === null ? v === null || v === undefined : eq(v, x))) return false;
          if (op === "lt" && !(v != null && cmpVal(v) < cmpVal(x))) return false;
          if (op === "lte" && !(v != null && cmpVal(v) <= cmpVal(x))) return false;
          if (op === "gt" && !(v != null && cmpVal(v) > cmpVal(x))) return false;
          if (op === "gte" && !(v != null && cmpVal(v) >= cmpVal(x))) return false;
          if (op === "startsWith" && !(typeof v === "string" && v.startsWith(x as string))) return false;
          if (op === "contains" && !(typeof v === "string" && v.toLowerCase().includes(String(x).toLowerCase()))) return false;
          if (op === "equals" && !eq(v, x)) return false;
        }
      } else if (cond === null) {
        if (v !== null && v !== undefined) return false;
      } else if (!eq(v, cond)) return false;
    }
    return true;
  }

  const flattenWhere = (where: Row) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(where)) if (k.includes("_") && v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && !("in" in v)) Object.assign(out, v);
      else out[k] = v;
    return out;
  };

  function shape(m: string, row: Row, spec: Row | undefined): Row {
    const out: Row = { ...row };
    if (!spec) return out;
    for (const [k, v] of Object.entries(spec)) {
      if (k === "_count") {
        const c: Row = {};
        for (const rk of Object.keys((v as Row).select ?? {})) {
          const rel = RELATIONS[m]?.[rk];
          c[rk] = rel ? table(rel.model).filter((t) => t[rel.fk] === row.id).length : 0;
        }
        out._count = c;
        continue;
      }
      const rel = RELATIONS[m]?.[k];
      if (!rel || !v) continue;
      const sub = typeof v === "object" ? (v as Row) : undefined;
      const nested = sub?.include ?? sub?.select;
      if (rel.many) {
        out[k] = table(rel.model).filter((t) => t[rel.fk] === row.id && matches(rel.model, t, sub?.where)).map((t) => shape(rel.model, t, nested));
      } else {
        const t = table(rel.model).find((x) => x.id === row[rel.fk]);
        out[k] = t ? shape(rel.model, t, nested) : null;
      }
    }
    return out;
  }

  function applyData(row: Row, data: Row) {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && "increment" in v) {
        const cur = row[k] ?? 0;
        row[k] = typeof cur === "number" && typeof v.increment === "number" ? cur + v.increment : new Decimal(String(cur)).plus(new Decimal(String(norm(v.increment)))).toString();
      } else row[k] = norm(v);
    }
    row.updatedAt = new Date();
  }

  function checkUnique(m: string, row: Row, selfId?: string) {
    for (const cols of UNIQUE[m] ?? []) {
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      if (table(m).some((r) => r !== row && r.id !== selfId && cols.every((c) => eq(r[c], row[c])))) throw Object.assign(new Error(`Unique constraint failed on ${m}(${cols.join(",")})`), { code: "P2002" });
    }
  }

  const sortRows = (rows: Row[], orderBy: any) => {
    const specs = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o: Row) => Object.entries(o));
    if (!specs.length) return rows;
    return [...rows].sort((a, b) => {
      for (const [k, dir] of specs) {
        if (typeof dir !== "string") continue;
        const x = cmpVal(a[k]), y = cmpVal(b[k]);
        if (x === y) continue;
        return (x > y ? 1 : -1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    });
  };

  function delegate(m: string) {
    const find = (where: Row | undefined) => table(m).filter((r) => matches(m, r, where ? flattenWhere(where) : undefined));
    return {
      findUnique: async ({ where, include, select }: Row) => { const r = find(where)[0]; return r ? shape(m, r, include ?? select) : null; },
      findFirst: async ({ where, include, select, orderBy }: Row = {}) => { const r = sortRows(find(where), orderBy)[0]; return r ? shape(m, r, include ?? select) : null; },
      findMany: async ({ where, include, select, orderBy, take, skip }: Row = {}) => {
        let rows = sortRows(find(where), orderBy);
        if (skip) rows = rows.slice(skip);
        if (take) rows = rows.slice(0, take);
        return rows.map((r) => shape(m, r, include ?? select));
      },
      count: async ({ where }: Row = {}) => find(where).length,
      create: async ({ data, include }: Row) => {
        const now = new Date();
        const row: Row = { ...(DEFAULTS[m]?.() ?? {}), createdAt: now, updatedAt: now };
        if (!PK[m] || PK[m] === "id") row.id = data.id ?? `${m}_${++seq}`;
        applyData(row, data);
        checkUnique(m, row);
        table(m).push(row);
        return shape(m, row, include);
      },
      update: async ({ where, data, include }: Row) => {
        const r = find(where)[0];
        if (!r) throw Object.assign(new Error(`${m} not found`), { code: "P2025" });
        const backup = { ...r };
        applyData(r, data);
        try { checkUnique(m, r, r.id); } catch (e) { Object.assign(r, backup); throw e; }
        return shape(m, r, include);
      },
      updateMany: async ({ where, data }: Row) => {
        const rows = find(where);
        for (const r of rows) applyData(r, data);
        return { count: rows.length };
      },
      upsert: async ({ where, update, create }: Row) => {
        const r = find(where)[0];
        if (r) { applyData(r, update); return { ...r }; }
        return delegate(m).create({ data: create });
      },
      aggregate: async ({ where, _sum }: Row) => {
        const rows = find(where);
        const sum: Row = {};
        for (const k of Object.keys(_sum ?? {})) sum[k] = rows.length ? rows.reduce((s, r) => s.plus(new Decimal(String(r[k] ?? 0))), new Decimal(0)).toString() : null;
        return { _sum: sum };
      },
    };
  }

  const db: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "$transaction") {
          return async (fn: (tx: any) => Promise<any>) => {
            const snapshot = structuredClone(tables);
            try {
              return await fn(db);
            } catch (e) {
              tables = snapshot;
              throw e;
            }
          };
        }
        if (prop === "tables") return tables;
        if (prop === "then") return undefined;
        return delegate(prop);
      },
    },
  );
  return db;
}
