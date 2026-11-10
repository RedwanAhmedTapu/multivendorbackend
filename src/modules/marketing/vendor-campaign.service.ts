// src/modules/marketing/vendor-campaign.service.ts
//
// Marketing Center — the VENDOR side of campaign programmes.
//
// A vendor sees only campaigns whose programme is PUBLISHED and whose page has
// not ended, registers its own variants with a campaign price (PENDING rows),
// edits a PENDING registration while registration is open, and withdraws a
// PENDING/APPROVED registration before the campaign goes live.
//
// Every method takes the vendor id from the authenticated identity
// (req.vendorScope) — never from the request. Rows of another vendor are
// reported as 404 so their ids are not confirmed.
//
// Rules are the SAME functions the admin uses at approval
// (evaluateRegistration + effectivePrice + the category chain), plus the
// registration-window check. One registration per campaign + variant (unique
// key); a retry with identical values is a no-op (idempotent).
// Writes are one transaction each: rows + AuditLog (actor = User id) +
// one admin-side notification per recipient per submission.

import { Decimal } from "@prisma/client/runtime/library";
import { effectivePrice } from "../shared/pricing.ts";
import {
  campaignPhase,
  evaluateRegistration,
  maxCampaignPrice,
  registrationWindowViolation,
  type RuleViolation,
} from "./campaign.rules.ts";
import {
  AUDIT,
  MarketingError,
  PAGE_SELECT,
  categoryChainOf,
  rulesOf,
  snapshot,
  windowsOf,
  type Actor,
  type MarketingDb,
} from "./campaign.service.ts";

type Args = Record<string, any>;

export interface RegisterItem {
  variantId: string;
  campaignPrice: string; // validated money string, ≤ 2 decimals
  committedStock: number;
}

const ACTIVE = ["PENDING", "APPROVED"] as const;
const PROGRAMME_INCLUDE = {
  categories: { select: { categoryId: true, category: { select: { id: true, name: true, slug: true } } } },
  campaignPage: { select: PAGE_SELECT },
} as const;
const VARIANT_SELECT = { id: true, sku: true, name: true, price: true, specialPrice: true, stock: true, productId: true } as const;
const PRODUCT_SELECT = { id: true, name: true, slug: true, vendorId: true, categoryId: true, approvalStatus: true, isDeleted: true } as const;

const pageArgs = (page?: number, limit?: number) => {
  const l = Math.min(Math.max(Math.trunc(limit ?? 20), 1), 100);
  const p = Math.max(Math.trunc(page ?? 1), 1);
  return { skip: (p - 1) * l, take: l, page: p, limit: l };
};
const pagination = (page: number, limit: number, total: number) => ({ page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
const money = (v: unknown) => new Decimal(v as any);
const samePrice = (a: unknown, b: unknown) => money(a).toDecimalPlaces(4).equals(money(b).toDecimalPlaces(4));

/** Prisma unique-constraint violation (a concurrent identical submission). */
const isUniqueViolation = (e: unknown) => (e as any)?.code === "P2002";

/** Same rules as the admin; on the vendor side the cap counts pending + approved, so say so. */
const forVendor = (violations: RuleViolation[], counted: number, limit: number | null) =>
  violations.map((v) => (v.rule === "maxProductsPerVendor" ? { ...v, message: `Your store already has ${counted} products registered for this campaign (limit ${limit})` } : v));

export function createVendorCampaignService(db: MarketingDb, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());

  async function audit(tx: MarketingDb, actor: Actor, action: string, entityId: string, oldData: unknown, newData: unknown) {
    await tx.auditLog.create({
      data: { userId: actor.userId, action, entity: "CampaignRegistration", entityId, oldData: snapshot(oldData) ?? undefined, newData: snapshot(newData) ?? undefined },
    });
  }

  /** Admin-side recipients: every active ADMIN user, and active admin-side staff holding marketingManagement. */
  async function adminRecipients(tx: MarketingDb) {
    const [admins, staff] = await Promise.all([
      tx.user.findMany({ where: { role: "ADMIN", isActive: true }, select: { id: true } }),
      tx.employee.findMany({ where: { vendorId: null, isActive: true }, select: { id: true, permissions: true } }),
    ]);
    return [
      ...admins.map((a) => ({ targetType: "USER", targetId: a.id as string })),
      ...staff.filter((e) => (e.permissions as Record<string, unknown> | null)?.marketingManagement === true).map((e) => ({ targetType: "EMPLOYEE", targetId: e.id as string })),
    ];
  }

  /** A PUBLISHED programme with its page — 404 for anything a vendor may not see. */
  async function visibleProgramme(tx: MarketingDb, programmeId: string) {
    const p = await tx.marketingCampaign.findUnique({ where: { id: programmeId }, include: PROGRAMME_INCLUDE });
    if (!p || p.status !== "PUBLISHED" || !p.campaignPage?.startDate || !p.campaignPage?.endDate) throw new MarketingError(404, "Campaign not found");
    return p;
  }

  const endOf = (p: any) => new Date(p.campaignPage.endDate);
  const startOf = (p: any) => new Date(p.campaignPage.startDate);

  /** Card / header fields shared by the list and the detail. */
  function campaignView(p: any, mine: Record<string, number>) {
    const w = windowsOf(p, p.campaignPage);
    const rules = rulesOf(p);
    const active = (mine.PENDING ?? 0) + (mine.APPROVED ?? 0);
    return {
      id: p.id,
      campaignPageId: p.campaignPageId,
      title: p.campaignPage.title,
      slug: p.campaignPage.slug,
      heroImage: p.campaignPage.heroImage,
      startAt: w.startAt,
      endAt: w.endAt,
      registrationStartAt: w.registrationStartAt,
      registrationEndAt: w.registrationEndAt, // the registration deadline
      phase: campaignPhase({ ...w, status: p.status }, now()),
      registrationOpen: registrationWindowViolation(w, now()) === null,
      rules: {
        minDiscountPercent: String(rules.minDiscountPercent),
        minStock: rules.minStock,
        maxProductsPerVendor: rules.maxProductsPerVendor,
        categories: (p.categories ?? []).map((c: any) => ({ id: c.categoryId, name: c.category?.name ?? null })),
      },
      registered: { count: active, limit: rules.maxProductsPerVendor }, // "x/y" (limit null = no limit)
      myCounts: { pending: mine.PENDING ?? 0, approved: mine.APPROVED ?? 0, rejected: mine.REJECTED ?? 0, withdrawn: mine.WITHDRAWN ?? 0 },
    };
  }

  async function myCountsByProgramme(tx: MarketingDb, vendorId: string, programmeIds: string[]) {
    const out = new Map<string, Record<string, number>>();
    if (!programmeIds.length) return out;
    const groups = await tx.campaignRegistration.groupBy({ by: ["campaignId", "status"], where: { vendorId, campaignId: { in: programmeIds } }, _count: { _all: true } });
    for (const g of groups) {
      const m = out.get(g.campaignId) ?? {};
      m[g.status] = g._count._all as number;
      out.set(g.campaignId, m);
    }
    return out;
  }

  // ── list / detail ─────────────────────────────────────────────────────────

  /** PUBLISHED programmes whose campaign has not ended, soonest registration deadline first. */
  async function listCampaigns(vendorId: string, q: { page?: number; limit?: number }) {
    const t = now();
    const all = await db.marketingCampaign.findMany({ where: { status: "PUBLISHED" }, include: PROGRAMME_INCLUDE });
    const visible = all
      .filter((p) => p.campaignPage?.startDate && p.campaignPage?.endDate && endOf(p) > t)
      .sort((a, b) => new Date(a.registrationEndAt).getTime() - new Date(b.registrationEndAt).getTime() || endOf(a).getTime() - endOf(b).getTime());
    const { skip, take, page, limit } = pageArgs(q.page, q.limit);
    const rows = visible.slice(skip, skip + take);
    const counts = await myCountsByProgramme(db, vendorId, rows.map((r) => r.id));
    return {
      items: rows.map((p) => campaignView(p, counts.get(p.id) ?? {})),
      // Earliest end among the visible campaigns (null when there are none).
      earliestEndAt: visible.length ? visible.map(endOf).reduce((a, b) => (b < a ? b : a)) : null,
      pagination: pagination(page, limit, visible.length),
    };
  }

  /** Rules + this vendor's variants, each judged with the admin's rule function. */
  async function getCampaign(vendorId: string, programmeId: string, q: { search?: string; eligibleOnly?: boolean; page?: number; limit?: number }) {
    const p = await visibleProgramme(db, programmeId);
    const counts = (await myCountsByProgramme(db, vendorId, [p.id])).get(p.id) ?? {};
    const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: { status: true } });
    const where: Args = { vendorId, isDeleted: false };
    if (q.search?.trim()) where.name = { contains: q.search.trim(), mode: "insensitive" };
    const products = await db.product.findMany({ where, orderBy: { name: "asc" }, select: { ...PRODUCT_SELECT, variants: { select: VARIANT_SELECT } } });
    const regs = await db.campaignRegistration.findMany({ where: { campaignId: p.id, vendorId }, select: { id: true, variantId: true, status: true, campaignPrice: true, committedStock: true, rejectionReason: true } });
    const regByVariant = new Map(regs.map((r) => [r.variantId, r]));
    const active = regs.filter((r) => (ACTIVE as readonly string[]).includes(r.status));
    const rules = rulesOf(p);
    const chains = new Map<string, string[]>();

    const variants = [];
    for (const prod of products) {
      if (!chains.has(prod.categoryId)) chains.set(prod.categoryId, await categoryChainOf(db, prod.categoryId));
      for (const v of prod.variants ?? []) {
        const selling = effectivePrice(v.price, v.specialPrice).price;
        const maxPrice = maxCampaignPrice(selling, rules.minDiscountPercent);
        const reg = regByVariant.get(v.id) ?? null;
        // Judge the best case the vendor could submit: the highest allowed
        // price and the minimum stock — what is left is what blocks this variant.
        const violations = evaluateRegistration({
          campaign: { ...rules, status: p.status, endAt: endOf(p) },
          registration: { campaignPrice: maxPrice ?? 0, committedStock: Math.max(rules.minStock, 1) },
          current: {
            sellingPrice: selling,
            stock: v.stock,
            productApproved: prod.approvalStatus === "ACTIVE",
            productDeleted: !!prod.isDeleted,
            vendorActive: vendor?.status === "ACTIVE",
            categoryChain: chains.get(prod.categoryId)!,
            approvedForVendor: active.filter((r) => r.variantId !== v.id).length,
          },
          now: now(),
        });
        variants.push({
          variantId: v.id,
          sku: v.sku,
          variantName: v.name ?? null,
          product: { id: prod.id, name: prod.name, slug: prod.slug },
          listPrice: String(v.price),
          currentPrice: selling.toString(),
          maxCampaignPrice: maxPrice?.toString() ?? null,
          stock: v.stock,
          eligible: violations.length === 0,
          violations: forVendor(violations, active.filter((r) => r.variantId !== v.id).length, rules.maxProductsPerVendor),
          registration: reg ? { id: reg.id, status: reg.status, campaignPrice: String(reg.campaignPrice), committedStock: reg.committedStock, rejectionReason: reg.rejectionReason } : null,
        });
      }
    }
    const filtered = q.eligibleOnly ? variants.filter((v) => v.eligible) : variants;
    const { skip, take, page, limit } = pageArgs(q.page, q.limit);
    return {
      campaign: campaignView(p, counts),
      variants: filtered.slice(skip, skip + take),
      pagination: pagination(page, limit, filtered.length),
    };
  }

  // ── register ──────────────────────────────────────────────────────────────

  async function registerOnce(actor: Actor, vendorId: string, programmeId: string, items: RegisterItem[]) {
    return db.$transaction(async (tx) => {
      const p = await visibleProgramme(tx, programmeId);
      const closed = registrationWindowViolation(p, now());
      if (closed) throw new MarketingError(422, closed.message, { violations: [closed] });

      const ids = items.map((i) => i.variantId);
      const variants = await tx.productVariant.findMany({ where: { id: { in: ids } }, select: { ...VARIANT_SELECT, product: { select: PRODUCT_SELECT } } });
      const byId = new Map(variants.filter((v) => v.product?.vendorId === vendorId).map((v) => [v.id, v]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) throw new MarketingError(404, "Variant not found", { variantIds: missing });

      const vendor = await tx.vendor.findUnique({ where: { id: vendorId }, select: { status: true, storeName: true } });
      const existing = await tx.campaignRegistration.findMany({ where: { campaignId: p.id, variantId: { in: ids } } });
      const existingByVariant = new Map(existing.map((r) => [r.variantId, r]));
      const activeOthers = await tx.campaignRegistration.count({ where: { campaignId: p.id, vendorId, status: { in: [...ACTIVE] }, variantId: { notIn: ids } } });
      const rules = rulesOf(p);

      const unchanged: any[] = [];
      const duplicates: { variantId: string; registrationId: string; status: string }[] = [];
      const invalid: { variantId: string; violations: RuleViolation[] }[] = [];
      const toWrite: { item: RegisterItem; variant: any; selling: Decimal; previous: any | null }[] = [];
      // Active registrations of this vendor that count towards the cap, in order.
      let counted = activeOthers;

      for (const item of items) {
        const v = byId.get(item.variantId)!;
        const prev = existingByVariant.get(item.variantId) ?? null;
        if (prev && (ACTIVE as readonly string[]).includes(prev.status)) {
          if (samePrice(prev.campaignPrice, item.campaignPrice) && prev.committedStock === item.committedStock) unchanged.push(prev); // retry → no-op
          else duplicates.push({ variantId: item.variantId, registrationId: prev.id, status: prev.status });
          counted++;
          continue;
        }
        const selling = effectivePrice(v.price, v.specialPrice).price;
        const violations = evaluateRegistration({
          campaign: { ...rules, status: p.status, endAt: endOf(p) },
          registration: { campaignPrice: item.campaignPrice, committedStock: item.committedStock },
          current: {
            sellingPrice: selling,
            stock: v.stock,
            productApproved: v.product.approvalStatus === "ACTIVE",
            productDeleted: !!v.product.isDeleted,
            vendorActive: vendor?.status === "ACTIVE",
            categoryChain: await categoryChainOf(tx, v.product.categoryId),
            approvedForVendor: counted,
          },
          now: now(),
        });
        if (violations.length) invalid.push({ variantId: item.variantId, violations: forVendor(violations, counted, rules.maxProductsPerVendor) });
        else {
          toWrite.push({ item, variant: v, selling, previous: prev });
          counted++; // only rows that will be written use up the cap
        }
      }

      if (duplicates.length) {
        throw new MarketingError(409, "Some variants are already registered for this campaign — edit or withdraw those registrations instead", { duplicates });
      }
      if (invalid.length) throw new MarketingError(422, "Some variants do not meet the campaign rules", { items: invalid });

      const created: any[] = [];
      for (const { item, variant, selling, previous } of toWrite) {
        const values = {
          campaignPrice: money(item.campaignPrice),
          originalPrice: selling, // snapshot of the selling price at registration
          committedStock: item.committedStock,
          status: "PENDING",
          rejectionReason: null,
          reviewedById: null,
          reviewedAt: null,
        };
        let row;
        if (previous) {
          // A REJECTED/WITHDRAWN registration is re-submitted (one row per campaign + variant).
          const claimed = await tx.campaignRegistration.updateMany({ where: { id: previous.id, status: previous.status }, data: values });
          if (claimed.count === 0) throw new MarketingError(409, "This registration changed while you were submitting — reload and try again");
          row = { ...previous, ...values };
        } else {
          row = await tx.campaignRegistration.create({ data: { campaignId: p.id, vendorId, productId: variant.productId, variantId: variant.id, ...values } });
        }
        await audit(tx, actor, AUDIT.vendorRegister, row.id, previous, { ...row, listPrice: variant.price, resubmitted: !!previous });
        created.push(row);
      }

      if (created.length) {
        const store = vendor?.storeName ?? "A vendor";
        const n = created.length;
        for (const r of await adminRecipients(tx)) {
          await tx.notification.create({
            data: {
              type: "PROMOTION",
              title: "New campaign registrations",
              message: `${store} submitted ${n} ${n === 1 ? "product" : "products"} for "${p.campaignPage.title}" on FinixMart — waiting for review.`,
              targetType: r.targetType,
              targetId: r.targetId,
              actionUrl: "/admin-dashboard/campaigns",
              meta: { programmeId: p.id, campaignPageId: p.campaignPageId, vendorId, registrationIds: created.map((c) => c.id) },
            },
          });
        }
      }
      return { created, unchanged };
    });
  }

  /** All-or-nothing; a concurrent identical submission (unique key) is retried once and then reads as a no-op. */
  async function register(actor: Actor, vendorId: string, programmeId: string, items: RegisterItem[]) {
    const ids = items.map((i) => i.variantId);
    if (new Set(ids).size !== ids.length) throw new MarketingError(400, "Each variant may appear only once per submission");
    try {
      return await registerOnce(actor, vendorId, programmeId, items);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      return registerOnce(actor, vendorId, programmeId, items);
    }
  }

  // ── edit / withdraw / mine ────────────────────────────────────────────────

  /** The vendor's own registration with its programme (404 otherwise). */
  async function ownRegistration(tx: MarketingDb, vendorId: string, id: string) {
    const reg = await tx.campaignRegistration.findUnique({
      where: { id },
      include: { campaign: { include: PROGRAMME_INCLUDE }, variant: { select: VARIANT_SELECT }, product: { select: PRODUCT_SELECT } },
    });
    if (!reg || reg.vendorId !== vendorId) throw new MarketingError(404, "Registration not found");
    return reg;
  }

  async function editRegistration(actor: Actor, vendorId: string, id: string, patch: { campaignPrice?: string; committedStock?: number }) {
    return db.$transaction(async (tx) => {
      const reg = await ownRegistration(tx, vendorId, id);
      if (reg.status !== "PENDING") throw new MarketingError(409, `Only a pending registration can be edited (this one is ${String(reg.status).toLowerCase()})`);
      const p = reg.campaign;
      if (p.status !== "PUBLISHED") throw new MarketingError(409, "This campaign is no longer open for registration");
      const closed = registrationWindowViolation(p, now());
      if (closed) throw new MarketingError(422, closed.message, { violations: [closed] });

      const next = {
        campaignPrice: patch.campaignPrice !== undefined ? money(patch.campaignPrice) : money(reg.campaignPrice),
        committedStock: patch.committedStock ?? reg.committedStock,
      };
      const { campaign, variant, product, ...before } = reg;
      if (samePrice(next.campaignPrice, reg.campaignPrice) && next.committedStock === reg.committedStock) return before; // nothing changed

      const vendor = await tx.vendor.findUnique({ where: { id: vendorId }, select: { status: true } });
      const activeOthers = await tx.campaignRegistration.count({ where: { campaignId: p.id, vendorId, status: { in: [...ACTIVE] }, id: { not: reg.id } } });
      const violations = evaluateRegistration({
        campaign: { ...rulesOf(p), status: p.status, endAt: endOf(p) },
        registration: next,
        current: {
          sellingPrice: effectivePrice(variant.price, variant.specialPrice).price,
          stock: variant.stock,
          productApproved: product.approvalStatus === "ACTIVE",
          productDeleted: !!product.isDeleted,
          vendorActive: vendor?.status === "ACTIVE",
          categoryChain: await categoryChainOf(tx, product.categoryId),
          approvedForVendor: activeOthers,
        },
        now: now(),
      });
      if (violations.length) throw new MarketingError(422, "The registration does not meet the campaign rules", { violations: forVendor(violations, activeOthers, rulesOf(p).maxProductsPerVendor) });

      const claimed = await tx.campaignRegistration.updateMany({ where: { id: reg.id, status: "PENDING" }, data: next });
      if (claimed.count === 0) throw new MarketingError(409, "This registration was reviewed while you were editing it — reload and try again");
      const after = { ...before, ...next };
      await audit(tx, actor, AUDIT.vendorEdit, reg.id, before, after);
      return after;
    });
  }

  async function withdrawRegistration(actor: Actor, vendorId: string, id: string, reason?: string) {
    return db.$transaction(async (tx) => {
      const reg = await ownRegistration(tx, vendorId, id);
      if (reg.status !== "PENDING" && reg.status !== "APPROVED") {
        throw new MarketingError(409, `Only a pending or approved registration can be withdrawn (this one is ${String(reg.status).toLowerCase()})`);
      }
      if (!reg.campaign.campaignPage?.startDate || now() >= startOf(reg.campaign)) {
        throw new MarketingError(409, "The campaign is already live — registrations can't be withdrawn now");
      }
      const claimed = await tx.campaignRegistration.updateMany({ where: { id: reg.id, status: reg.status }, data: { status: "WITHDRAWN" } });
      if (claimed.count === 0) throw new MarketingError(409, "This registration changed while you were withdrawing it — reload and try again");
      const { campaign, variant, product, ...before } = reg;
      const after = { ...before, status: "WITHDRAWN" };
      await audit(tx, actor, AUDIT.vendorWithdraw, reg.id, before, { ...after, reason: reason?.trim() || null });
      return after;
    });
  }

  async function listMyRegistrations(vendorId: string, q: { status?: string; campaignId?: string; page?: number; limit?: number }) {
    const where: Args = { vendorId };
    if (q.status) where.status = q.status;
    if (q.campaignId) where.campaignId = q.campaignId;
    const { skip, take, page, limit } = pageArgs(q.page, q.limit);
    const [rows, total] = await Promise.all([
      db.campaignRegistration.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: {
          campaign: { select: { id: true, status: true, campaignPage: { select: PAGE_SELECT } } },
          product: { select: { id: true, name: true, slug: true } },
          variant: { select: { id: true, sku: true, price: true, specialPrice: true, stock: true } },
        },
      }),
      db.campaignRegistration.count({ where }),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      status: r.status,
      rejectionReason: r.rejectionReason ?? null,
      campaignPrice: String(r.campaignPrice),
      originalPrice: String(r.originalPrice),
      committedStock: r.committedStock,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      reviewedAt: r.reviewedAt ?? null,
      campaign: {
        id: r.campaign.id,
        status: r.campaign.status,
        title: r.campaign.campaignPage?.title,
        slug: r.campaign.campaignPage?.slug,
        heroImage: r.campaign.campaignPage?.heroImage ?? null,
        startAt: r.campaign.campaignPage?.startDate ?? null,
        endAt: r.campaign.campaignPage?.endDate ?? null,
      },
      product: r.product,
      variant: { id: r.variant.id, sku: r.variant.sku, currentPrice: effectivePrice(r.variant.price, r.variant.specialPrice).price.toString(), stock: r.variant.stock },
    }));
    return { items, pagination: pagination(page, limit, total) };
  }

  return { listCampaigns, getCampaign, register, editRegistration, withdrawRegistration, listMyRegistrations };
}

export type VendorCampaignService = ReturnType<typeof createVendorCampaignService>;
