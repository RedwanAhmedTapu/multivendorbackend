// src/modules/marketing/campaign.service.ts
//
// Marketing Center — the VENDOR PROGRAMME of a campaign landing page.
//
// A campaign is one CampaignPage (title, slug, hero, live window
// startDate/endDate — edited in the existing Campaigns builder). Its optional
// programme (MarketingCampaign) adds the vendor side: registration window,
// rules, eligible categories, registrations and their review. Landing-page-
// only campaigns have no programme and are not affected by anything here.
//
// Every write is one transaction: the state change (claimed conditionally on
// the expected status, so a concurrent action gets 409), its AuditLog row
// (old/new data, actor = User id) and any vendor notifications.
// The database is injected (`MarketingDb`) — production passes the Prisma
// client (regenerated after the migrations); tests pass a fake.

import { Decimal } from "@prisma/client/runtime/library";
import { effectivePrice } from "../shared/pricing.ts";
import {
  campaignPhase,
  classifyRuleChanges,
  evaluateRegistration,
  validateCampaignWindows,
  type CampaignRules,
  type CampaignStatus,
  type RuleViolation,
} from "./campaign.rules.ts";

// ── injected database (loosely typed delegates) ─────────────────────────────

type Args = Record<string, any>;
interface Delegate {
  findMany(args?: Args): Promise<any[]>;
  findUnique(args: Args): Promise<any>;
  findFirst(args: Args): Promise<any>;
  create(args: Args): Promise<any>;
  update(args: Args): Promise<any>;
  updateMany(args: Args): Promise<{ count: number }>;
  delete(args: Args): Promise<any>;
  deleteMany(args: Args): Promise<{ count: number }>;
  count(args?: Args): Promise<number>;
  groupBy(args: Args): Promise<any[]>;
}
export interface MarketingDb {
  campaignPage: Delegate;
  marketingCampaign: Delegate;
  marketingCampaignCategory: Delegate;
  campaignRegistration: Delegate;
  category: Delegate;
  auditLog: Delegate;
  notification: Delegate;
  // Vendor registration (vendor-campaign.service.ts).
  product: Delegate;
  productVariant: Delegate;
  vendor: Delegate;
  user: Delegate;
  employee: Delegate;
  $transaction<T>(fn: (tx: MarketingDb) => Promise<T>): Promise<T>;
}

// Explicit fields, not parameter properties: Node's strip-only TypeScript
// mode (npm run dev) rejects parameter properties at startup.
export class MarketingError extends Error {
  statusCode: 400 | 404 | 409 | 422;
  details?: unknown;
  constructor(statusCode: 400 | 404 | 409 | 422, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface Actor {
  userId: string; // User.id (AuditLog.user → User)
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** JSON-safe snapshot for AuditLog (Decimal → string, Date → ISO). */
export function snapshot(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (v instanceof Decimal) return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(snapshot);
  if (typeof v === "object") {
    if (typeof (v as any).toFixed === "function" && typeof (v as any).toNumber === "function") return String(v);
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, snapshot(x)]));
  }
  return v;
}

const pageArgs = (page?: number, limit?: number) => {
  const l = Math.min(Math.max(Math.trunc(limit ?? 20), 1), 100);
  const p = Math.max(Math.trunc(page ?? 1), 1);
  return { skip: (p - 1) * l, take: l, page: p, limit: l };
};

export function rulesOf(c: any): CampaignRules {
  return {
    minDiscountPercent: c.minDiscountPercent,
    minStock: c.minStock,
    maxProductsPerVendor: c.maxProductsPerVendor ?? null,
    categoryIds: (c.categories ?? []).map((x: any) => x.categoryId).sort(),
  };
}

const sameTime = (a: unknown, b: unknown) => (a == null && b == null) || (a != null && b != null && new Date(a as any).getTime() === new Date(b as any).getTime());

/** The programme's four dates: its registration window + the page's live window. */
export function windowsOf(programme: { registrationStartAt: Date; registrationEndAt: Date }, page: { startDate: Date | null; endDate: Date | null }) {
  return { registrationStartAt: new Date(programme.registrationStartAt), registrationEndAt: new Date(programme.registrationEndAt), startAt: page.startDate ? new Date(page.startDate) : (null as unknown as Date), endAt: page.endDate ? new Date(page.endDate) : (null as unknown as Date) };
}

export const AUDIT = {
  create: "MKT_CAMPAIGN_CREATE",
  update: "MKT_CAMPAIGN_UPDATE",
  publish: "MKT_CAMPAIGN_PUBLISH",
  cancel: "MKT_CAMPAIGN_CANCEL",
  extend: "MKT_CAMPAIGN_EXTEND",
  approve: "MKT_REGISTRATION_APPROVE",
  reject: "MKT_REGISTRATION_REJECT",
  // Vendor side (vendor-campaign.service.ts).
  vendorRegister: "MKT_REGISTRATION_SUBMIT",
  vendorEdit: "MKT_REGISTRATION_EDIT",
  vendorWithdraw: "MKT_REGISTRATION_WITHDRAW",
} as const;

export interface ProgrammeInput {
  registrationStartAt: Date;
  registrationEndAt: Date;
  minDiscountPercent: number;
  minStock: number;
  maxProductsPerVendor?: number | null;
  categoryIds: string[];
}

export const PAGE_SELECT = { id: true, title: true, slug: true, status: true, heroImage: true, startDate: true, endDate: true } as const;

/** The category followed by its ancestors (bounded, cycle-safe). */
export async function categoryChainOf(tx: MarketingDb, categoryId: string | null) {
  const chain: string[] = [];
  let id = categoryId;
  for (let depth = 0; id && depth < 12 && !chain.includes(id); depth++) {
    chain.push(id);
    id = (await tx.category.findUnique({ where: { id }, select: { parentId: true } }))?.parentId ?? null;
  }
  return chain;
}

export function createCampaignService(db: MarketingDb, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());

  async function audit(tx: MarketingDb, actor: Actor, action: string, entity: string, entityId: string, oldData: unknown, newData: unknown) {
    await tx.auditLog.create({
      data: { userId: actor.userId, action, entity, entityId, oldData: snapshot(oldData) ?? undefined, newData: snapshot(newData) ?? undefined },
    });
  }

  async function countsFor(tx: MarketingDb, programmeIds: string[]) {
    const out = new Map<string, { pending: number; approved: number; rejected: number; withdrawn: number; total: number; vendors: number }>();
    for (const id of programmeIds) out.set(id, { pending: 0, approved: 0, rejected: 0, withdrawn: 0, total: 0, vendors: 0 });
    if (programmeIds.length === 0) return out;
    const byStatus = await tx.campaignRegistration.groupBy({ by: ["campaignId", "status"], where: { campaignId: { in: programmeIds } }, _count: { _all: true } });
    for (const g of byStatus) {
      const c = out.get(g.campaignId)!;
      const n = g._count._all as number;
      c[String(g.status).toLowerCase() as "pending"] += n;
      c.total += n;
    }
    const byVendor = await tx.campaignRegistration.groupBy({ by: ["campaignId", "vendorId"], where: { campaignId: { in: programmeIds } } });
    for (const g of byVendor) out.get(g.campaignId)!.vendors += 1;
    return out;
  }

  async function loadPage(tx: MarketingDb, pageId: string) {
    const page = await tx.campaignPage.findUnique({ where: { id: pageId }, select: PAGE_SELECT });
    if (!page) throw new MarketingError(404, "Campaign not found");
    return page;
  }

  async function loadProgramme(tx: MarketingDb, id: string) {
    const p = await tx.marketingCampaign.findUnique({ where: { id }, include: { categories: { select: { categoryId: true } }, campaignPage: { select: PAGE_SELECT } } });
    if (!p) throw new MarketingError(404, "Vendor programme not found");
    return p;
  }

  async function assertCategoriesExist(tx: MarketingDb, ids: string[]) {
    if (ids.length === 0) return;
    const found = await tx.category.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const missing = ids.filter((id) => !found.some((f: any) => f.id === id));
    if (missing.length) throw new MarketingError(422, "Unknown categories", { categoryIds: missing });
  }

  /** Registration window vs the page's live window; the page must have both dates. */
  function checkWindows(programme: { registrationStartAt: Date; registrationEndAt: Date }, page: { startDate: Date | null; endDate: Date | null }, requireFuture: boolean) {
    if (!page.startDate || !page.endDate) {
      throw new MarketingError(422, "Set the campaign's start and end dates (Details) before enabling vendor registration", { startAt: "The campaign needs a start date", endAt: "The campaign needs an end date" });
    }
    const errors = validateCampaignWindows(windowsOf(programme, page), now(), { requireFuture });
    if (Object.keys(errors).length) throw new MarketingError(422, "Invalid campaign dates", errors);
  }

  const withPhase = (p: any, counts?: unknown) => ({
    ...p,
    categoryIds: rulesOf(p).categoryIds,
    phase: p.campaignPage?.startDate && p.campaignPage?.endDate ? campaignPhase({ ...windowsOf(p, p.campaignPage), status: p.status }, now()) : p.status,
    counts,
  });

  // ── pages (list for staff + programme badges for the admin list) ─────────

  async function listCampaignPages(q: { search?: string; page?: number; limit?: number }) {
    const where: Args = {};
    if (q.search?.trim()) where.OR = [{ title: { contains: q.search.trim(), mode: "insensitive" } }, { slug: { contains: q.search.trim(), mode: "insensitive" } }];
    const { skip, take, page, limit } = pageArgs(q.page, q.limit ?? 100);
    const [rows, total] = await Promise.all([
      db.campaignPage.findMany({ where, orderBy: { updatedAt: "desc" }, skip, take, select: { ...PAGE_SELECT, marketingCampaign: { select: { id: true, status: true } } } }),
      db.campaignPage.count({ where }),
    ]);
    const counts = await countsFor(db, rows.filter((r) => r.marketingCampaign).map((r) => r.marketingCampaign.id));
    return {
      items: rows.map(({ marketingCampaign, ...p }) => ({ ...p, programme: marketingCampaign ? { ...marketingCampaign, counts: counts.get(marketingCampaign.id) } : null })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** The page plus its programme (null for landing-page-only campaigns). */
  async function getProgrammeByPage(pageId: string) {
    const page = await loadPage(db, pageId);
    const p = await db.marketingCampaign.findUnique({
      where: { campaignPageId: pageId },
      include: { categories: { include: { category: { select: { id: true, name: true, slug: true } } } }, campaignPage: { select: PAGE_SELECT } },
    });
    if (!p) return { page, programme: null };
    const counts = (await countsFor(db, [p.id])).get(p.id);
    return { page, programme: withPhase(p, counts) };
  }

  // ── programme lifecycle ───────────────────────────────────────────────────

  async function createProgramme(actor: Actor, pageId: string, input: ProgrammeInput) {
    const categoryIds = [...new Set(input.categoryIds)];
    return db.$transaction(async (tx) => {
      const page = await loadPage(tx, pageId);
      if (await tx.marketingCampaign.findUnique({ where: { campaignPageId: pageId }, select: { id: true } })) {
        throw new MarketingError(409, "This campaign already has a vendor programme");
      }
      checkWindows(input, page, true);
      await assertCategoriesExist(tx, categoryIds);
      const created = await tx.marketingCampaign.create({
        data: {
          campaignPageId: pageId,
          registrationStartAt: input.registrationStartAt,
          registrationEndAt: input.registrationEndAt,
          minDiscountPercent: new Decimal(input.minDiscountPercent),
          minStock: input.minStock,
          maxProductsPerVendor: input.maxProductsPerVendor ?? null,
          createdById: actor.userId,
          status: "DRAFT",
          categories: { create: categoryIds.map((categoryId) => ({ categoryId })) },
        },
        include: { categories: { select: { categoryId: true } }, campaignPage: { select: PAGE_SELECT } },
      });
      await audit(tx, actor, AUDIT.create, "MarketingCampaign", created.id, null, created);
      return withPhase(created);
    });
  }

  async function updateProgramme(actor: Actor, id: string, patch: Partial<ProgrammeInput>, opts: { acknowledgeTightening?: boolean } = {}) {
    return db.$transaction(async (tx) => {
      const before = await loadProgramme(tx, id);
      if (before.status === "CANCELLED" || before.status === "ENDED") throw new MarketingError(409, `A ${before.status.toLowerCase()} vendor programme cannot be edited`);
      const dateKeys = ["registrationStartAt", "registrationEndAt"] as const;
      const changedDates = dateKeys.filter((k) => patch[k] !== undefined && !sameTime(patch[k], before[k]));

      let warning: undefined | { tightened: string[]; affectedRegistrations: number };
      if (before.status === "PUBLISHED") {
        if (changedDates.length) throw new MarketingError(422, "The registration window of a published programme cannot be changed", { fields: changedDates });
        const nextRules: CampaignRules = {
          minDiscountPercent: patch.minDiscountPercent ?? before.minDiscountPercent,
          minStock: patch.minStock ?? before.minStock,
          maxProductsPerVendor: patch.maxProductsPerVendor !== undefined ? patch.maxProductsPerVendor : before.maxProductsPerVendor,
          categoryIds: patch.categoryIds ? [...new Set(patch.categoryIds)].sort() : rulesOf(before).categoryIds,
        };
        const { loosened, tightened } = classifyRuleChanges(rulesOf(before), nextRules);
        const registered = await tx.campaignRegistration.count({ where: { campaignId: id } });
        if (registered > 0 && loosened.length) {
          throw new MarketingError(422, "Rules of a published programme cannot be loosened after vendors have registered", { loosened });
        }
        if (registered > 0 && tightened.length) {
          // Same rule function as approval, limited to the tightened rules.
          const live = await tx.campaignRegistration.findMany({
            where: { campaignId: id, status: { in: ["PENDING", "APPROVED"] } },
            include: { variant: { select: { price: true, specialPrice: true, stock: true } }, product: { select: { categoryId: true } } },
          });
          const chains = new Map<string | null, string[]>();
          const approvedByVendor = new Map<string, number>();
          let affected = 0;
          for (const r of live) {
            if (!chains.has(r.product.categoryId)) chains.set(r.product.categoryId, await categoryChain(tx, r.product.categoryId));
            const approvedSoFar = approvedByVendor.get(r.vendorId) ?? 0;
            const violations = evaluateRegistration({
              campaign: { ...nextRules, status: "PUBLISHED", endAt: new Date(8.64e15) },
              registration: { campaignPrice: r.campaignPrice, committedStock: r.committedStock },
              current: {
                sellingPrice: effectivePrice(r.variant.price, r.variant.specialPrice).price,
                stock: Number.MAX_SAFE_INTEGER,
                productApproved: true,
                productDeleted: false,
                vendorActive: true,
                categoryChain: chains.get(r.product.categoryId)!,
                approvedForVendor: r.status === "APPROVED" ? approvedSoFar : 0,
              },
              now: now(),
            }).filter((v) => tightened.includes(v.rule === "category" ? "categoryIds" : v.rule));
            if (r.status === "APPROVED") approvedByVendor.set(r.vendorId, approvedSoFar + 1);
            if (violations.length) affected++;
          }
          warning = { tightened, affectedRegistrations: affected };
          if (!opts.acknowledgeTightening) {
            throw new MarketingError(409, "Tightening the rules affects registered vendors — resend with acknowledgeTightening: true to apply", warning);
          }
        }
      } else if (changedDates.length) {
        const merged = {
          registrationStartAt: patch.registrationStartAt !== undefined ? new Date(patch.registrationStartAt) : new Date(before.registrationStartAt),
          registrationEndAt: patch.registrationEndAt !== undefined ? new Date(patch.registrationEndAt) : new Date(before.registrationEndAt),
        };
        checkWindows(merged, before.campaignPage, true);
      }

      const data: Args = {};
      for (const k of dateKeys) if (patch[k] !== undefined) data[k] = new Date(patch[k] as Date);
      if (patch.minDiscountPercent !== undefined) data.minDiscountPercent = new Decimal(patch.minDiscountPercent);
      if (patch.minStock !== undefined) data.minStock = patch.minStock;
      if (patch.maxProductsPerVendor !== undefined) data.maxProductsPerVendor = patch.maxProductsPerVendor;

      // Conditional claim: no concurrent status change slipped in.
      const claimed = await tx.marketingCampaign.updateMany({ where: { id, status: before.status }, data });
      if (claimed.count === 0) throw new MarketingError(409, "The programme changed while you were editing it — reload and try again");
      if (patch.categoryIds) {
        const ids = [...new Set(patch.categoryIds)];
        await assertCategoriesExist(tx, ids);
        await tx.marketingCampaignCategory.deleteMany({ where: { campaignId: id } });
        for (const categoryId of ids) await tx.marketingCampaignCategory.create({ data: { campaignId: id, categoryId } });
      }
      const after = await loadProgramme(tx, id);
      await audit(tx, actor, AUDIT.update, "MarketingCampaign", id, before, { ...after, ...(warning ? { tighteningAcknowledged: warning } : {}) });
      return { programme: withPhase(after), warning };
    });
  }

  async function publishProgramme(actor: Actor, id: string) {
    return db.$transaction(async (tx) => {
      const before = await loadProgramme(tx, id);
      if (before.status !== "DRAFT") throw new MarketingError(409, `Only a draft programme can be published (this one is ${before.status.toLowerCase()})`);
      checkWindows(before, before.campaignPage, true);
      const claimed = await tx.marketingCampaign.updateMany({ where: { id, status: "DRAFT" }, data: { status: "PUBLISHED" } });
      if (claimed.count === 0) throw new MarketingError(409, "The programme was changed by someone else — reload and try again");
      const after = await loadProgramme(tx, id);
      await audit(tx, actor, AUDIT.publish, "MarketingCampaign", id, before, after);
      return withPhase(after);
    });
  }

  async function cancelProgramme(actor: Actor, id: string, reason: string) {
    const why = reason?.trim();
    if (!why) throw new MarketingError(400, "A cancellation reason is required");
    return db.$transaction(async (tx) => {
      const before = await loadProgramme(tx, id);
      if (before.status !== "DRAFT" && before.status !== "PUBLISHED") throw new MarketingError(409, `A ${before.status.toLowerCase()} programme cannot be cancelled`);
      const claimed = await tx.marketingCampaign.updateMany({ where: { id, status: before.status }, data: { status: "CANCELLED" } });
      if (claimed.count === 0) throw new MarketingError(409, "The programme was changed by someone else — reload and try again");
      const after = await loadProgramme(tx, id);
      await audit(tx, actor, AUDIT.cancel, "MarketingCampaign", id, before, { ...after, reason: why });
      const vendors = await tx.campaignRegistration.groupBy({ by: ["vendorId"], where: { campaignId: id } });
      for (const v of vendors) {
        await tx.notification.create({
          data: { type: "PROMOTION", title: "Campaign cancelled", message: `"${before.campaignPage.title}" was cancelled. Reason: ${why}`, targetType: "VENDOR", targetId: v.vendorId },
        });
      }
      return withPhase(after);
    });
  }

  // ── page rules (called by the existing Campaigns builder) ─────────────────

  /**
   * Updates a CampaignPage, enforcing its programme's date rules:
   *   - no programme, or a cancelled/ended one → unchanged behaviour;
   *   - DRAFT programme → the new dates must still fit its registration window;
   *   - PUBLISHED programme → startDate is frozen and endDate may only be
   *     EXTENDED; an extension is audit-logged and every vendor with a pending
   *     or approved registration is notified.
   */
  async function updateCampaignPage(actor: Actor | null, pageId: string, data: Args, include?: Args) {
    return db.$transaction(async (tx) => {
      const programme = await tx.marketingCampaign.findUnique({ where: { campaignPageId: pageId }, include: { campaignPage: { select: PAGE_SELECT } } });
      const touchesDates = "startDate" in data || "endDate" in data;
      let extendedFrom: Date | null = null;
      if (programme && touchesDates && (programme.status === "DRAFT" || programme.status === "PUBLISHED")) {
        const page = programme.campaignPage;
        const nextStart = "startDate" in data ? (data.startDate == null ? null : new Date(data.startDate)) : page.startDate;
        const nextEnd = "endDate" in data ? (data.endDate == null ? null : new Date(data.endDate)) : page.endDate;
        if (programme.status === "PUBLISHED") {
          if (!sameTime(nextStart, page.startDate)) {
            throw new MarketingError(409, "The start date can't change while vendor registration is published", { fields: ["startDate"] });
          }
          if (!sameTime(nextEnd, page.endDate)) {
            if (!nextEnd || !page.endDate || nextEnd.getTime() <= new Date(page.endDate).getTime()) {
              throw new MarketingError(409, "The end date can only be extended while vendor registration is published", { fields: ["endDate"] });
            }
            if (nextEnd.getTime() <= now().getTime()) throw new MarketingError(422, "The new end date must be in the future", { fields: ["endDate"] });
            extendedFrom = new Date(page.endDate);
          }
        } else {
          checkWindows(programme, { startDate: nextStart, endDate: nextEnd }, false);
        }
      }
      if (extendedFrom && !actor) throw new MarketingError(400, "Missing authenticated user");
      const updated = await tx.campaignPage.update({ where: { id: pageId }, data, ...(include ? { include } : {}) });
      if (extendedFrom && programme && actor) {
        await audit(tx, actor, AUDIT.extend, "CampaignPage", pageId, { endDate: extendedFrom }, { endDate: updated.endDate, programmeId: programme.id });
        const vendors = await tx.campaignRegistration.groupBy({ by: ["vendorId"], where: { campaignId: programme.id, status: { in: ["PENDING", "APPROVED"] } } });
        for (const v of vendors) {
          await tx.notification.create({
            data: {
              type: "PROMOTION",
              title: "Campaign extended",
              message: `"${programme.campaignPage.title}" now ends on ${new Date(updated.endDate).toISOString().slice(0, 10)} (was ${extendedFrom.toISOString().slice(0, 10)}).`,
              targetType: "VENDOR",
              targetId: v.vendorId,
            },
          });
        }
      }
      return updated;
    });
  }

  /** Deletes a CampaignPage. A programme without registrations is removed with
   *  it; a programme with registrations blocks the delete (409). */
  async function deleteCampaignPage(pageId: string) {
    return db.$transaction(async (tx) => {
      const programme = await tx.marketingCampaign.findUnique({ where: { campaignPageId: pageId }, select: { id: true } });
      if (programme) {
        const registered = await tx.campaignRegistration.count({ where: { campaignId: programme.id } });
        if (registered > 0) throw new MarketingError(409, "This campaign has vendor registrations and can't be deleted — cancel its vendor programme instead");
        await tx.marketingCampaignCategory.deleteMany({ where: { campaignId: programme.id } });
        await tx.marketingCampaign.delete({ where: { id: programme.id } });
      }
      return tx.campaignPage.delete({ where: { id: pageId } });
    });
  }

  // ── registrations ─────────────────────────────────────────────────────────

  async function listRegistrations(programmeId: string, q: { status?: string; vendorId?: string; page?: number; limit?: number }) {
    const where: Args = { campaignId: programmeId };
    if (q.status) where.status = q.status;
    if (q.vendorId) where.vendorId = q.vendorId;
    const { skip, take, page, limit } = pageArgs(q.page, q.limit);
    const [items, total] = await Promise.all([
      db.campaignRegistration.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip,
        take,
        include: {
          vendor: { select: { id: true, storeName: true } },
          product: { select: { id: true, name: true, slug: true } },
          variant: { select: { id: true, sku: true, price: true, specialPrice: true, stock: true } },
        },
      }),
      db.campaignRegistration.count({ where }),
    ]);
    return { items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  }

  const categoryChain = categoryChainOf;

  /** Loads everything needed to judge a registration NOW. */
  async function factsFor(tx: MarketingDb, registrationId: string) {
    const reg = await tx.campaignRegistration.findUnique({
      where: { id: registrationId },
      include: {
        campaign: { include: { categories: { select: { categoryId: true } }, campaignPage: { select: PAGE_SELECT } } },
        variant: { select: { price: true, specialPrice: true, stock: true } },
        product: { select: { approvalStatus: true, isDeleted: true, categoryId: true, name: true } },
        vendor: { select: { status: true } },
      },
    });
    if (!reg) throw new MarketingError(404, "Registration not found");
    const approvedForVendor = await tx.campaignRegistration.count({
      where: { campaignId: reg.campaignId, vendorId: reg.vendorId, status: "APPROVED", id: { not: reg.id } },
    });
    const endAt = reg.campaign.campaignPage?.endDate ? new Date(reg.campaign.campaignPage.endDate) : new Date(0);
    const violations: RuleViolation[] = evaluateRegistration({
      campaign: { ...rulesOf(reg.campaign), status: reg.campaign.status, endAt },
      registration: { campaignPrice: reg.campaignPrice, committedStock: reg.committedStock },
      current: {
        sellingPrice: effectivePrice(reg.variant.price, reg.variant.specialPrice).price,
        stock: reg.variant.stock,
        productApproved: reg.product.approvalStatus === "ACTIVE",
        productDeleted: !!reg.product.isDeleted,
        vendorActive: reg.vendor.status === "ACTIVE",
        categoryChain: await categoryChain(tx, reg.product.categoryId),
        approvedForVendor,
      },
      now: now(),
    });
    return { reg, violations };
  }

  async function approveInTx(tx: MarketingDb, actor: Actor, registrationId: string) {
    const { reg, violations } = await factsFor(tx, registrationId);
    if (reg.status !== "PENDING") throw new MarketingError(409, `Only pending registrations can be reviewed (this one is ${String(reg.status).toLowerCase()})`);
    if (violations.length) throw new MarketingError(422, "The registration no longer meets the campaign rules", { violations });
    const at = now();
    const claimed = await tx.campaignRegistration.updateMany({ where: { id: reg.id, status: "PENDING" }, data: { status: "APPROVED", reviewedById: actor.userId, reviewedAt: at, rejectionReason: null } });
    if (claimed.count === 0) throw new MarketingError(409, "The registration was reviewed by someone else");
    const { campaign, variant, product, vendor, ...before } = reg;
    await audit(tx, actor, AUDIT.approve, "CampaignRegistration", reg.id, before, { ...before, status: "APPROVED", reviewedById: actor.userId, reviewedAt: at });
    await tx.notification.create({
      data: { type: "PROMOTION", title: "Campaign product approved", message: `"${product.name}" was approved for "${campaign.campaignPage.title}".`, targetType: "VENDOR", targetId: reg.vendorId, productId: reg.productId },
    });
    return { id: reg.id, status: "APPROVED" as const };
  }

  async function rejectInTx(tx: MarketingDb, actor: Actor, registrationId: string, reason: string) {
    const why = reason?.trim();
    if (!why) throw new MarketingError(400, "A rejection reason is required");
    if (why.length > 500) throw new MarketingError(400, "Keep the rejection reason under 500 characters");
    const reg = await tx.campaignRegistration.findUnique({
      where: { id: registrationId },
      include: { campaign: { select: { campaignPage: { select: { title: true } } } }, product: { select: { name: true } } },
    });
    if (!reg) throw new MarketingError(404, "Registration not found");
    if (reg.status !== "PENDING") throw new MarketingError(409, `Only pending registrations can be reviewed (this one is ${String(reg.status).toLowerCase()})`);
    const at = now();
    const claimed = await tx.campaignRegistration.updateMany({ where: { id: reg.id, status: "PENDING" }, data: { status: "REJECTED", rejectionReason: why, reviewedById: actor.userId, reviewedAt: at } });
    if (claimed.count === 0) throw new MarketingError(409, "The registration was reviewed by someone else");
    const { campaign, product, ...before } = reg;
    await audit(tx, actor, AUDIT.reject, "CampaignRegistration", reg.id, before, { ...before, status: "REJECTED", rejectionReason: why, reviewedById: actor.userId, reviewedAt: at });
    await tx.notification.create({
      data: { type: "PROMOTION", title: "Campaign product rejected", message: `"${product.name}" was not accepted for "${campaign.campaignPage.title}". Reason: ${why}`, targetType: "VENDOR", targetId: reg.vendorId, productId: reg.productId },
    });
    return { id: reg.id, status: "REJECTED" as const };
  }

  const approveRegistration = (actor: Actor, id: string) => db.$transaction((tx) => approveInTx(tx, actor, id));
  const rejectRegistration = (actor: Actor, id: string, reason: string) => db.$transaction((tx) => rejectInTx(tx, actor, id, reason));

  /**
   * Bulk review of PENDING registrations. Without `confirm` it only reports
   * what WOULD happen (count + rule check); with `confirm` the caller must
   * send back the `expectedCount` it was shown, otherwise 409 (selection
   * changed). Each registration is applied in its own transaction.
   */
  async function bulkReview(actor: Actor, programmeId: string, body: { action: "approve" | "reject"; registrationIds?: string[]; reason?: string; confirm?: boolean; expectedCount?: number }) {
    await loadProgramme(db, programmeId);
    if (body.action === "reject" && !body.reason?.trim()) throw new MarketingError(400, "A rejection reason is required");
    const where: Args = { campaignId: programmeId, status: "PENDING" };
    if (body.registrationIds?.length) where.id = { in: [...new Set(body.registrationIds)] };
    const pending = await db.campaignRegistration.findMany({ where, select: { id: true }, orderBy: { createdAt: "asc" } });
    const ids = pending.map((p) => p.id);

    if (!body.confirm) {
      if (body.action === "reject") return { confirmRequired: true, action: "reject", count: ids.length };
      const preview = { eligible: [] as string[], ineligible: [] as { id: string; violations: RuleViolation[] }[] };
      for (const id of ids) {
        const { violations } = await factsFor(db, id);
        if (violations.length) preview.ineligible.push({ id, violations });
        else preview.eligible.push(id);
      }
      return { confirmRequired: true, action: "approve", count: ids.length, eligibleCount: preview.eligible.length, ineligible: preview.ineligible };
    }

    if (body.expectedCount !== ids.length) {
      throw new MarketingError(409, "The selection changed since the preview — review the new count and confirm again", { expectedCount: body.expectedCount, currentCount: ids.length });
    }
    const applied: string[] = [];
    const skipped: { id: string; status: number; message: string; details?: unknown }[] = [];
    for (const id of ids) {
      try {
        await db.$transaction<{ id: string; status: "APPROVED" | "REJECTED" }>((tx) =>
          body.action === "approve" ? approveInTx(tx, actor, id) : rejectInTx(tx, actor, id, body.reason!),
        );
        applied.push(id);
      } catch (e) {
        if (!(e instanceof MarketingError)) throw e;
        skipped.push({ id, status: e.statusCode, message: e.message, details: e.details });
      }
    }
    return { action: body.action, count: ids.length, appliedCount: applied.length, applied, skipped };
  }

  return {
    listCampaignPages,
    getProgrammeByPage,
    createProgramme,
    updateProgramme,
    publishProgramme,
    cancelProgramme,
    updateCampaignPage,
    deleteCampaignPage,
    listRegistrations,
    approveRegistration,
    rejectRegistration,
    bulkReview,
  };
}

export type CampaignService = ReturnType<typeof createCampaignService>;
export type { CampaignStatus };
