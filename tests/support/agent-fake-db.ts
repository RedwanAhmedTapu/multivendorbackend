// tests/support/agent-fake-db.ts
//
// Small in-memory stand-in for the Prisma delegates the agent module uses.
// Supports the where-shapes the agent services actually send: equality,
// null, { in }, { gt/gte/lt/lte }, { contains }, NOT, OR, AND. Interactive
// transactions run the callback against the same store; $executeRaw (advisory
// locks) is a no-op. Install with installAgentFakeDb(); restore afterwards.

import { Prisma } from "@prisma/client";
import { agentDb } from "../../src/modules/agent/agent-db.ts";

/** Prisma writes Prisma.JsonNull as a JSON null and reads it back as null. */
const unwrapJsonNull = (v: any) => (v instanceof (Prisma as any).NullTypes.JsonNull ? null : v);

type Row = Record<string, any>;

let idSeq = 0;
export const nextId = (prefix = "id") => `${prefix}_${++idSeq}`;

function cmp(a: any, b: any): number {
  const av = a instanceof Date ? a.getTime() : typeof a === "object" && a !== null && "toString" in a && typeof a !== "string" ? Number(a.toString()) : a;
  const bv = b instanceof Date ? b.getTime() : typeof b === "object" && b !== null && "toString" in b && typeof b !== "string" ? Number(b.toString()) : b;
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function matchValue(value: any, cond: any): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond !== "object") return value === cond;
  if (Array.isArray(cond)) return JSON.stringify(value) === JSON.stringify(cond);
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case "equals":
        if ((cond as any).mode === "insensitive" ? String(value).toLowerCase() !== String(arg).toLowerCase() : value !== arg) return false;
        break;
      case "in":
        if (!(arg as any[]).includes(value)) return false;
        break;
      case "gt":
        if (value == null || cmp(value, arg) <= 0) return false;
        break;
      case "gte":
        if (value == null || cmp(value, arg) < 0) return false;
        break;
      case "lt":
        if (value == null || cmp(value, arg) >= 0) return false;
        break;
      case "lte":
        if (value == null || cmp(value, arg) > 0) return false;
        break;
      case "not":
        if (matchValue(value, arg)) return false;
        break;
      case "contains": {
        const hay = String(value ?? "");
        if ((cond as any).mode === "insensitive" ? !hay.toLowerCase().includes(String(arg).toLowerCase()) : !hay.includes(String(arg))) return false;
        break;
      }
      case "mode":
        break;
      default:
        return false;
    }
  }
  return true;
}

export function matches(row: Row, where: any): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === "OR") {
      if (!(cond as any[]).some((w) => matches(row, w))) return false;
    } else if (key === "AND") {
      if (!(cond as any[]).every((w) => matches(row, w))) return false;
    } else if (key === "NOT") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((w) => matches(row, w))) return false;
    } else if (!matchValue(row[key], cond)) return false;
  }
  return true;
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in (v as any)) row[k] = (row[k] ?? 0) + (v as any).increment;
    else if (v !== undefined) row[k] = unwrapJsonNull(v);
  }
  row.updatedAt = new Date();
}

function pick(row: Row, select?: any): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) if (v === true) out[k] = row[k];
  return out;
}

export type FakeTable = ReturnType<typeof makeTable>;

export function makeTable(name: string, opts: { unique?: string[]; relations?: Record<string, () => any>; defaults?: () => Row } = {}) {
  const rows: Row[] = [];
  const checkUnique = (candidate: Row, except?: Row) => {
    for (const key of opts.unique ?? []) {
      if (candidate[key] == null) continue;
      if (rows.some((r) => r !== except && r[key] === candidate[key])) {
        const err: any = new Error(`Unique constraint failed on ${name}.${key}`);
        err.code = "P2002";
        err.meta = { target: [key] };
        throw err;
      }
    }
  };
  const withRelations = (row: Row, select?: any) => {
    const out = pick(row, select);
    if (select && opts.relations) {
      for (const [k, v] of Object.entries(select)) {
        if (v && typeof v === "object" && opts.relations[k]) out[k] = opts.relations[k]()(row, (v as any).select);
      }
    }
    return out;
  };
  const table = {
    rows,
    async findUnique({ where, select }: any) {
      const row = rows.find((r) => matches(r, where));
      return row ? withRelations(row, select) : null;
    },
    async findFirst({ where, select }: any = {}) {
      const row = rows.find((r) => matches(r, where));
      return row ? withRelations(row, select) : null;
    },
    async findMany({ where, select, take, skip }: any = {}) {
      let list = rows.filter((r) => matches(r, where));
      if (skip) list = list.slice(skip);
      if (take) list = list.slice(0, take);
      return list.map((r) => withRelations(r, select));
    },
    async count({ where }: any = {}) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async create({ data, select }: any) {
      const row: Row = { id: data.id ?? nextId(name), createdAt: new Date(), updatedAt: new Date(), ...(opts.defaults?.() ?? {}), ...data };
      for (const k of Object.keys(row)) row[k] = unwrapJsonNull(row[k]);
      checkUnique(row);
      rows.push(row);
      return withRelations(row, select);
    },
    async update({ where, data, select }: any) {
      const row = rows.find((r) => matches(r, where));
      if (!row) {
        const err: any = new Error("Record not found");
        err.code = "P2025";
        throw err;
      }
      const next = { ...row };
      applyData(next, data);
      checkUnique(next, row);
      Object.assign(row, next);
      return withRelations(row, select);
    },
    async upsert({ where, create, update }: any) {
      const row = rows.find((r) => matches(r, where));
      if (row) return table.update({ where, data: update });
      return table.create({ data: create });
    },
    async updateMany({ where, data }: any) {
      const list = rows.filter((r) => matches(r, where));
      for (const r of list) applyData(r, data);
      return { count: list.length };
    },
    async delete({ where }: any) {
      const idx = rows.findIndex((r) => matches(r, where));
      if (idx < 0) {
        const err: any = new Error("Record not found");
        err.code = "P2025";
        throw err;
      }
      return rows.splice(idx, 1)[0];
    },
  };
  return table;
}

export function makeAgentFakeDb() {
  const db: any = {};
  db.agentLevel = makeTable("level", { unique: ["name", "rank"], defaults: () => ({ isActive: true, perks: [] }) });
  db.agent = makeTable("agent", {
    unique: ["email", "phone", "agentCode", "referralCode"],
    defaults: () => ({ status: "PENDING", tokenVersion: 0, phone: null, levelId: null, notificationPrefs: {}, avatar: null, lastLoginAt: null }),
    relations: {
      level: () => (row: Row, select: any) => {
        const l = db.agentLevel.rows.find((x: Row) => x.id === row.levelId);
        return l ? pick(l, select) : null;
      },
    },
  });
  db.agentSession = makeTable("session", {
    unique: ["refreshTokenHash"],
    defaults: () => ({ revokedAt: null }),
    relations: {
      agent: () => (row: Row, select: any) => pick(db.agent.rows.find((a: Row) => a.id === row.agentId), select),
    },
  });
  db.agentPasswordReset = makeTable("reset", { unique: ["tokenHash"], defaults: () => ({ usedAt: null }) });
  db.agentSetting = makeTable("setting");
  // settings rows are keyed by `key`
  const origCreate = db.agentSetting.create;
  db.agentSetting.create = (args: any) => origCreate({ ...args, data: { id: args.data.key, ...args.data } });
  db.agentConfigAudit = makeTable("audit");
  db.agentVendorLink = makeTable("link", { defaults: () => ({ endedAt: null, startedAt: new Date() }) });
  db.agentCommissionOverride = makeTable("override", { defaults: () => ({ isActive: true, effectiveFrom: new Date(), effectiveTo: null, vendorId: null, agentId: null, categoryId: null }) });
  db.agentBonusRule = makeTable("bonus", { defaults: () => ({ isActive: true }) });
  db.vendor = makeTable("vendor");
  db.category = makeTable("category");
  db.$executeRaw = async () => 0;
  db.$transaction = async (fn: any) => fn(db);
  return db;
}

/** Point agentDb at a fresh fake; returns the fake and a restore function. */
export function installAgentFakeDb() {
  const db = makeAgentFakeDb();
  const saved = { prisma: agentDb.prisma, prismaDirect: agentDb.prismaDirect };
  agentDb.prisma = db;
  agentDb.prismaDirect = db;
  return {
    db,
    restore() {
      agentDb.prisma = saved.prisma;
      agentDb.prismaDirect = saved.prismaDirect;
    },
  };
}
