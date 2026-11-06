// src/modules/subscriptions/subscription.service.ts
//
// Dynamic subscription platform (extends VendorSubscription; see
// docs/subscription-payout-audit.md). One factory, injectable db for tests.
//
// Invariants
//   - Plans, features, cycles and prices come only from the database; nothing
//     here names a plan or a price.
//   - Every change to a vendor's subscription bumps VendorSubscription.version
//     (optimistic concurrency) and appends a VendorSubscriptionEvent + AuditLog
//     row in the SAME transaction. Events are never updated or deleted.
//   - A paid period starts only from a recorded PAID SubscriptionPayment
//     (idempotencyKey @unique) or an explicit admin activation with a reason.
//     Nothing charges a vendor; nothing changes a plan on its own. Offer
//     expiry only ends the offer, notifies, and (SWITCH_PLAN) opens a PENDING
//     payment request that someone must confirm.
//   - FREE_PLAN / FREE_FEATURE offers are access overlays read by the
//     entitlement check; they never rewrite the vendor's own subscription.
//   - Subscription billing never touches vendor earnings (VendorPayable / ledger).

import { randomUUID } from "node:crypto";
import { prisma, prismaDirect } from "../../config/prisma.ts";
import {
  DEFAULT_SUBS_SETTINGS,
  SUBS_SETTING_KEYS,
  OPERATIVE_STATES,
  decideFeature,
  evaluateSubscription,
  isFeatureKey,
  isSlug,
  money,
  offerIsLive,
  parseSubsSettings,
  periodFor,
  quote,
  usagePeriodKey,
  validateLimitConfig,
  validateLimitDefs,
  validateSubsSettings,
  type FeatureDecision,
  type LimitConfig,
  type LimitDef,
  type OfferRow,
  type SubsSettings,
} from "./subscription.rules.ts";

// The generated client may predate this module's migration; keep the db loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SubsDb = any;

export class SubscriptionError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, statusCode = 400, code = "SUBSCRIPTION_ERROR") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface Actor {
  userId: string;
  name?: string | null;
}

const DAY = 86_400_000;
const str = (v: unknown, max: number, field: string, required = false): string | null => {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (required) throw new SubscriptionError(`${field} is required`, 400, "VALIDATION");
    return null;
  }
  if (typeof v !== "string") throw new SubscriptionError(`${field} must be text`, 400, "VALIDATION");
  if (v.trim().length > max) throw new SubscriptionError(`${field} is too long (max ${max})`, 400, "VALIDATION");
  return v.trim();
};
const reasonOf = (v: unknown): string => {
  const r = str(v, 500, "Reason", true)!;
  if (r.length < 3) throw new SubscriptionError("A reason (at least 3 characters) is required", 400, "VALIDATION");
  return r;
};
const intOf = (v: unknown, lo: number, hi: number, field: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new SubscriptionError(`${field} must be a whole number from ${lo} to ${hi}`, 400, "VALIDATION");
  return v;
};
const moneyOf = (v: unknown, field: string, { allowNull = false } = {}) => {
  if ((v === null || v === undefined || v === "") && allowNull) return null;
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(s)) throw new SubscriptionError(`${field} must be an amount ≥ 0 with at most 2 decimals`, 400, "VALIDATION");
  return s;
};
const colorOf = (v: unknown) => {
  const c = str(v, 20, "Color");
  if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) throw new SubscriptionError("Color must be #RRGGBB", 400, "VALIDATION");
  return c;
};
const dateOf = (v: unknown, field: string): Date => {
  const d = typeof v === "string" || v instanceof Date ? new Date(v as string) : null;
  if (!d || Number.isNaN(d.getTime())) throw new SubscriptionError(`${field} must be a date`, 400, "VALIDATION");
  return d;
};
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const subSnapshot = (s: any) =>
  s
    ? { status: s.status ?? null, source: s.source ?? null, packageId: s.packageId ?? null, cycleId: s.cycleId ?? null, expiresAt: iso(s.expiresAt), offerId: s.offerId ?? null }
    : null;
const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";

export function createSubscriptionService(deps: { db?: SubsDb; txDb?: SubsDb; now?: () => Date } = {}) {
  const db: SubsDb = deps.db ?? prisma;
  const txDb: SubsDb = deps.txDb ?? deps.db ?? prismaDirect;
  const clock = deps.now ?? (() => new Date());

  let settingsCache: { at: number; value: SubsSettings } | null = null;

  // ─── settings ─────────────────────────────────────────────────────────────

  async function getSettings({ fresh = false } = {}): Promise<SubsSettings> {
    if (!fresh && settingsCache && Date.now() - settingsCache.at < 30_000) return settingsCache.value;
    const rows: { key: string; value: string }[] = await db.platformSettings.findMany({ where: { key: { in: Object.values(SUBS_SETTING_KEYS) } } });
    const by = new Map(rows.map((r) => [r.key, r.value]));
    const value = parseSubsSettings({
      graceDays: by.get(SUBS_SETTING_KEYS.graceDays),
      reminderDays: by.get(SUBS_SETTING_KEYS.reminderDays),
      changeStartsFrom: by.get(SUBS_SETTING_KEYS.changeStartsFrom),
      enforcement: by.get(SUBS_SETTING_KEYS.enforcement),
    });
    settingsCache = { at: Date.now(), value };
    return value;
  }

  async function setSettings(input: unknown, actor: Actor): Promise<SubsSettings> {
    const v = validateSubsSettings(input);
    if (!v.ok) throw new SubscriptionError(v.message, 400, "VALIDATION");
    const before = await getSettings({ fresh: true });
    await txDb.$transaction(async (tx: SubsDb) => {
      for (const [k, key] of Object.entries(SUBS_SETTING_KEYS) as [keyof SubsSettings, string][]) {
        const value = String(v.value[k]);
        await tx.platformSettings.upsert({ where: { key }, update: { value }, create: { key, value, note: `Subscription setting: ${k}` } });
      }
      await tx.auditLog.create({ data: { action: "SUBS_SETTINGS_UPDATED", entity: "PlatformSettings", entityId: "subs.settings", oldData: before, newData: v.value, userId: actor.userId } });
    });
    settingsCache = null;
    return getSettings({ fresh: true });
  }

  // ─── features ─────────────────────────────────────────────────────────────

  const featureOut = (f: any) => ({ ...f, limitDefs: (f.limitDefs ?? []) as LimitDef[] });

  async function listFeatures() {
    const rows = await db.subscriptionFeature.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], include: { _count: { select: { packages: true } } } });
    return rows.map(featureOut);
  }

  function featureData(input: any, partial: boolean) {
    const data: Record<string, unknown> = {};
    if (!partial || input.name !== undefined) data.name = str(input.name, 80, "Name", true);
    if (input.description !== undefined) data.description = str(input.description, 500, "Description");
    if (input.icon !== undefined) data.icon = str(input.icon, 40, "Icon");
    if (input.color !== undefined) data.color = colorOf(input.color);
    if (input.category !== undefined) data.category = str(input.category, 40, "Category");
    if (input.sortOrder !== undefined) data.sortOrder = intOf(input.sortOrder, 0, 10_000, "Order");
    if (input.isActive !== undefined) data.isActive = Boolean(input.isActive);
    if (input.enforced !== undefined) data.enforced = Boolean(input.enforced);
    if (!partial || input.limitDefs !== undefined) {
      const v = validateLimitDefs(input.limitDefs);
      if (!v.ok) throw new SubscriptionError(v.message, 400, "VALIDATION");
      data.limitDefs = v.value;
    }
    return data;
  }

  async function createFeature(input: any, actor: Actor) {
    if (!isFeatureKey(input?.key)) throw new SubscriptionError("Key: 2-50 lowercase letters, digits or _ (starting with a letter)", 400, "VALIDATION");
    const data = { key: input.key, ...featureData(input, false), createdById: actor.userId };
    try {
      const f = await txDb.$transaction(async (tx: SubsDb) => {
        const row = await tx.subscriptionFeature.create({ data });
        await tx.auditLog.create({ data: { action: "SUBS_FEATURE_CREATED", entity: "SubscriptionFeature", entityId: row.id, newData: data, userId: actor.userId } });
        return row;
      });
      return featureOut(f);
    } catch (e) {
      if (isUnique(e)) throw new SubscriptionError(`A feature with key "${input.key}" already exists`, 409, "DUPLICATE");
      throw e;
    }
  }

  async function updateFeature(id: string, input: any, actor: Actor) {
    const before = await db.subscriptionFeature.findUnique({ where: { id } });
    if (!before) throw new SubscriptionError("Feature not found", 404, "NOT_FOUND");
    if (input?.key !== undefined && input.key !== before.key) throw new SubscriptionError("A feature key can't be changed (routes and plans refer to it)", 400, "VALIDATION");
    const data = featureData(input ?? {}, true);
    if (data.limitDefs) {
      // Existing plan values must still fit the new definitions.
      const assigned = await db.subscriptionPackageFeature.findMany({ where: { featureId: id } });
      for (const a of assigned) {
        const v = validateLimitConfig(data.limitDefs as LimitDef[], a.config);
        if (!v.ok) throw new SubscriptionError(`A plan still uses a limit you removed or changed: ${v.message}`, 409, "IN_USE");
      }
    }
    return txDb.$transaction(async (tx: SubsDb) => {
      const row = await tx.subscriptionFeature.update({ where: { id }, data });
      await tx.auditLog.create({ data: { action: "SUBS_FEATURE_UPDATED", entity: "SubscriptionFeature", entityId: id, oldData: featureOut(before), newData: data, userId: actor.userId } });
      return featureOut(row);
    });
  }

  // ─── cycles ───────────────────────────────────────────────────────────────

  const listCycles = () => db.subscriptionCycle.findMany({ orderBy: [{ sortOrder: "asc" }, { months: "asc" }] });

  async function createCycle(input: any, actor: Actor) {
    if (!isFeatureKey(input?.key)) throw new SubscriptionError("Key: 2-50 lowercase letters, digits or _", 400, "VALIDATION");
    const data = {
      key: input.key,
      name: str(input.name, 60, "Name", true),
      months: intOf(input.months, 1, 120, "Months"),
      sortOrder: input.sortOrder === undefined ? 0 : intOf(input.sortOrder, 0, 10_000, "Order"),
      isActive: input.isActive === undefined ? true : Boolean(input.isActive),
    };
    try {
      return await txDb.$transaction(async (tx: SubsDb) => {
        const row = await tx.subscriptionCycle.create({ data });
        await tx.auditLog.create({ data: { action: "SUBS_CYCLE_CREATED", entity: "SubscriptionCycle", entityId: row.id, newData: data, userId: actor.userId } });
        return row;
      });
    } catch (e) {
      if (isUnique(e)) throw new SubscriptionError(`A billing cycle with key "${input.key}" already exists`, 409, "DUPLICATE");
      throw e;
    }
  }

  async function updateCycle(id: string, input: any, actor: Actor) {
    const before = await db.subscriptionCycle.findUnique({ where: { id } });
    if (!before) throw new SubscriptionError("Billing cycle not found", 404, "NOT_FOUND");
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = str(input.name, 60, "Name", true);
    // Changing months only affects future purchases; paid periods keep their dates.
    if (input.months !== undefined) data.months = intOf(input.months, 1, 120, "Months");
    if (input.sortOrder !== undefined) data.sortOrder = intOf(input.sortOrder, 0, 10_000, "Order");
    if (input.isActive !== undefined) data.isActive = Boolean(input.isActive);
    return txDb.$transaction(async (tx: SubsDb) => {
      const row = await tx.subscriptionCycle.update({ where: { id }, data });
      await tx.auditLog.create({ data: { action: "SUBS_CYCLE_UPDATED", entity: "SubscriptionCycle", entityId: id, oldData: before, newData: data, userId: actor.userId } });
      return row;
    });
  }

  // ─── packages (plans) ─────────────────────────────────────────────────────

  const packageInclude = {
    features: { include: { feature: true } },
    prices: { include: { cycle: true } },
    _count: { select: { subscribers: true } },
  };

  async function listPackages(q: { status?: string } = {}) {
    const where = q.status && ["DRAFT", "PUBLISHED", "ARCHIVED"].includes(q.status) ? { status: q.status } : {};
    return db.subscriptionPackage.findMany({ where, orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }], include: packageInclude });
  }

  async function getPackage(id: string) {
    const p = await db.subscriptionPackage.findUnique({ where: { id }, include: packageInclude });
    if (!p) throw new SubscriptionError("Plan not found", 404, "NOT_FOUND");
    return p;
  }

  function packageData(input: any, partial: boolean) {
    const data: Record<string, unknown> = {};
    if (!partial || input.name !== undefined) data.name = str(input.name, 80, "Name", true);
    if (!partial || input.slug !== undefined) {
      if (!isSlug(input.slug)) throw new SubscriptionError("Slug: lowercase letters, digits and dashes (max 60)", 400, "VALIDATION");
      data.slug = input.slug;
    }
    if (input.description !== undefined) data.description = str(input.description, 1000, "Description");
    if (input.icon !== undefined) data.icon = str(input.icon, 40, "Icon");
    if (input.color !== undefined) data.color = colorOf(input.color);
    if (input.displayOrder !== undefined) data.displayOrder = intOf(input.displayOrder, 0, 10_000, "Order");
    if (input.visibility !== undefined) {
      if (!["PUBLIC", "HIDDEN"].includes(input.visibility)) throw new SubscriptionError("Visibility must be PUBLIC or HIDDEN", 400, "VALIDATION");
      data.visibility = input.visibility;
    }
    if (input.isPopular !== undefined) data.isPopular = Boolean(input.isPopular);
    if (input.trialDays !== undefined) data.trialDays = input.trialDays === null ? null : intOf(input.trialDays, 1, 365, "Trial days");
    return data;
  }

  async function createPackage(input: any, actor: Actor) {
    const data = { ...packageData(input ?? {}, false), status: "DRAFT", createdById: actor.userId };
    try {
      return await txDb.$transaction(async (tx: SubsDb) => {
        const row = await tx.subscriptionPackage.create({ data });
        await tx.auditLog.create({ data: { action: "SUBS_PLAN_CREATED", entity: "SubscriptionPackage", entityId: row.id, newData: data, userId: actor.userId } });
        return row;
      });
    } catch (e) {
      if (isUnique(e)) throw new SubscriptionError(`The slug "${input.slug}" is taken`, 409, "DUPLICATE");
      throw e;
    }
  }

  async function updatePackage(id: string, input: any, actor: Actor) {
    const before = await getPackage(id);
    const data = packageData(input ?? {}, true);
    try {
      return await txDb.$transaction(async (tx: SubsDb) => {
        const row = await tx.subscriptionPackage.update({ where: { id }, data });
        await tx.auditLog.create({ data: { action: "SUBS_PLAN_UPDATED", entity: "SubscriptionPackage", entityId: id, oldData: { name: before.name, slug: before.slug }, newData: data, userId: actor.userId } });
        return row;
      });
    } catch (e) {
      if (isUnique(e)) throw new SubscriptionError(`The slug "${input.slug}" is taken`, 409, "DUPLICATE");
      throw e;
    }
  }

  async function duplicatePackage(id: string, actor: Actor) {
    const src = await getPackage(id);
    let slug = `${src.slug}-copy`.slice(0, 60);
    for (let n = 2; await db.subscriptionPackage.findUnique({ where: { slug } }); n++) slug = `${src.slug}-copy-${n}`.slice(0, 60);
    return txDb.$transaction(async (tx: SubsDb) => {
      const row = await tx.subscriptionPackage.create({
        data: {
          name: `${src.name} (copy)`.slice(0, 80), slug, description: src.description, icon: src.icon, color: src.color,
          displayOrder: src.displayOrder, status: "DRAFT", visibility: src.visibility, isPopular: false, trialDays: src.trialDays, createdById: actor.userId,
        },
      });
      for (const f of src.features) await tx.subscriptionPackageFeature.create({ data: { packageId: row.id, featureId: f.featureId, enabled: f.enabled, config: f.config ?? {} } });
      for (const p of src.prices) await tx.subscriptionPackagePrice.create({ data: { packageId: row.id, cycleId: p.cycleId, price: p.price, promoPrice: p.promoPrice, discountPercent: p.discountPercent, isActive: p.isActive } });
      await tx.auditLog.create({ data: { action: "SUBS_PLAN_DUPLICATED", entity: "SubscriptionPackage", entityId: row.id, oldData: { from: id }, newData: { slug }, userId: actor.userId } });
      return row;
    });
  }

  /** Publish / unpublish (back to DRAFT) / archive. Current subscribers keep their plan until it ends. */
  async function setPackageStatus(id: string, status: string, actor: Actor) {
    if (!["DRAFT", "PUBLISHED", "ARCHIVED"].includes(status)) throw new SubscriptionError("Status must be DRAFT, PUBLISHED or ARCHIVED", 400, "VALIDATION");
    const p = await getPackage(id);
    if (status === "PUBLISHED") {
      const sellable = p.prices.filter((x: any) => x.isActive && x.cycle?.isActive);
      if (!sellable.length) throw new SubscriptionError("Add at least one active price on an active billing cycle before publishing", 422, "NOT_SELLABLE");
    }
    return txDb.$transaction(async (tx: SubsDb) => {
      const row = await tx.subscriptionPackage.update({ where: { id }, data: { status } });
      await tx.auditLog.create({ data: { action: `SUBS_PLAN_${status}`, entity: "SubscriptionPackage", entityId: id, oldData: { status: p.status }, newData: { status, subscribers: p._count?.subscribers ?? 0 }, userId: actor.userId } });
      return row;
    });
  }

  /** Upsert the plan's feature set. Features left out are switched off (rows kept, nothing deleted). */
  async function setPackageFeatures(id: string, input: any, actor: Actor) {
    const p = await getPackage(id);
    if (!Array.isArray(input)) throw new SubscriptionError("Send a list of features", 400, "VALIDATION");
    const features = await db.subscriptionFeature.findMany({ where: { id: { in: input.map((x: any) => x?.featureId).filter(Boolean) } } });
    const byId = new Map(features.map((f: any) => [f.id, f]));
    const rows = input.map((x: any) => {
      const f: any = byId.get(x?.featureId);
      if (!f) throw new SubscriptionError("Unknown feature in the list", 400, "VALIDATION");
      const v = validateLimitConfig((f.limitDefs ?? []) as LimitDef[], x.config);
      if (!v.ok) throw new SubscriptionError(`${f.name}: ${v.message}`, 400, "VALIDATION");
      return { featureId: f.id, enabled: x.enabled !== false, config: v.value };
    });
    const keep = new Set(rows.map((r: any) => r.featureId));
    return txDb.$transaction(async (tx: SubsDb) => {
      for (const r of rows) {
        await tx.subscriptionPackageFeature.upsert({
          where: { packageId_featureId: { packageId: id, featureId: r.featureId } },
          update: { enabled: r.enabled, config: r.config },
          create: { packageId: id, ...r },
        });
      }
      for (const old of p.features) if (!keep.has(old.featureId) && old.enabled) await tx.subscriptionPackageFeature.update({ where: { id: old.id }, data: { enabled: false } });
      await tx.auditLog.create({ data: { action: "SUBS_PLAN_FEATURES_SET", entity: "SubscriptionPackage", entityId: id, oldData: p.features.map((f: any) => ({ featureId: f.featureId, enabled: f.enabled, config: f.config })), newData: rows, userId: actor.userId } });
      return tx.subscriptionPackageFeature.findMany({ where: { packageId: id }, include: { feature: true } });
    });
  }

  /** Upsert prices per cycle. Cycles left out are deactivated (rows kept). */
  async function setPackagePrices(id: string, input: any, actor: Actor) {
    const p = await getPackage(id);
    if (!Array.isArray(input)) throw new SubscriptionError("Send a list of prices", 400, "VALIDATION");
    const cycles = await db.subscriptionCycle.findMany({ where: { id: { in: input.map((x: any) => x?.cycleId).filter(Boolean) } } });
    const known = new Set(cycles.map((c: any) => c.id));
    const seen = new Set<string>();
    const rows = input.map((x: any) => {
      if (!known.has(x?.cycleId)) throw new SubscriptionError("Unknown billing cycle in the list", 400, "VALIDATION");
      if (seen.has(x.cycleId)) throw new SubscriptionError("Each billing cycle can have one price", 400, "VALIDATION");
      seen.add(x.cycleId);
      const price = moneyOf(x.price, "Price")!;
      const promoPrice = moneyOf(x.promoPrice, "Promo price", { allowNull: true });
      if (promoPrice !== null && money(promoPrice).greaterThan(money(price))) throw new SubscriptionError("Promo price can't be above the regular price", 400, "VALIDATION");
      let discountPercent: string | null = null;
      if (x.discountPercent !== null && x.discountPercent !== undefined && x.discountPercent !== "") {
        const d = Number(x.discountPercent);
        if (!Number.isFinite(d) || d < 0 || d > 100) throw new SubscriptionError("Discount must be 0 to 100%", 400, "VALIDATION");
        discountPercent = d.toFixed(2);
      }
      if (promoPrice !== null && discountPercent !== null) throw new SubscriptionError("Use a promo price or a discount %, not both", 400, "VALIDATION");
      return { cycleId: x.cycleId, price, promoPrice, discountPercent, isActive: x.isActive !== false };
    });
    if (p.status === "PUBLISHED" && !rows.some((r: any) => r.isActive)) throw new SubscriptionError("A published plan needs at least one active price (unpublish it first)", 422, "NOT_SELLABLE");
    return txDb.$transaction(async (tx: SubsDb) => {
      for (const r of rows) {
        await tx.subscriptionPackagePrice.upsert({
          where: { packageId_cycleId: { packageId: id, cycleId: r.cycleId } },
          update: { price: r.price, promoPrice: r.promoPrice, discountPercent: r.discountPercent, isActive: r.isActive },
          create: { packageId: id, ...r },
        });
      }
      for (const old of p.prices) if (!seen.has(old.cycleId) && old.isActive) await tx.subscriptionPackagePrice.update({ where: { id: old.id }, data: { isActive: false } });
      await tx.auditLog.create({ data: { action: "SUBS_PLAN_PRICES_SET", entity: "SubscriptionPackage", entityId: id, oldData: p.prices.map((x: any) => ({ cycleId: x.cycleId, price: String(x.price), promoPrice: x.promoPrice === null ? null : String(x.promoPrice), discountPercent: x.discountPercent === null ? null : String(x.discountPercent), isActive: x.isActive })), newData: rows, userId: actor.userId } });
      return tx.subscriptionPackagePrice.findMany({ where: { packageId: id }, include: { cycle: true } });
    });
  }

  // ─── vendor subscriptions ────────────────────────────────────────────────

  async function evaluationFor(vendorId: string, now = clock()) {
    const [sub, settings] = await Promise.all([db.vendorSubscription.findUnique({ where: { vendorId } }), getSettings()]);
    return { sub, settings, evaluation: evaluateSubscription(sub, now, settings.graceDays) };
  }

  async function liveOffers(vendorId: string, now = clock()): Promise<OfferRow[]> {
    const rows = await db.vendorSubscriptionOffer.findMany({ where: { vendorId, status: "ACTIVE", startsAt: { lte: now }, endsAt: { gt: now } } });
    return rows.filter((o: OfferRow) => offerIsLive(o, now));
  }

  /**
   * Apply a change to the vendor's subscription row (creating it if needed),
   * with an event + audit row, in the given transaction. Optimistic: the row's
   * version must not have moved since it was read.
   */
  async function writeSubscription(
    tx: SubsDb,
    vendorId: string,
    data: Record<string, unknown>,
    ev: { kind: string; actor?: Actor | null; reason?: string | null; paymentId?: string | null; offerId?: string | null },
  ) {
    const current = await tx.vendorSubscription.findUnique({ where: { vendorId } });
    let after: any;
    if (!current) {
      try {
        after = await tx.vendorSubscription.create({ data: { vendorId, isActive: true, ...data, version: 1 } });
      } catch (e) {
        if (isUnique(e)) throw new SubscriptionError("The subscription changed at the same time. Reload and try again.", 409, "CONFLICT");
        throw e;
      }
    } else {
      const res = await tx.vendorSubscription.updateMany({ where: { id: current.id, version: current.version }, data: { ...data, version: { increment: 1 } } });
      if (res.count !== 1) throw new SubscriptionError("The subscription changed at the same time. Reload and try again.", 409, "CONFLICT");
      after = await tx.vendorSubscription.findUnique({ where: { vendorId } });
    }
    await tx.vendorSubscriptionEvent.create({
      data: {
        subscriptionId: after.id, vendorId, kind: ev.kind, before: subSnapshot(current), after: subSnapshot(after),
        paymentId: ev.paymentId ?? null, offerId: ev.offerId ?? null, actorUserId: ev.actor?.userId ?? null, reason: ev.reason ?? null,
      },
    });
    await tx.auditLog.create({ data: { action: `SUBS_${ev.kind}`, entity: "VendorSubscription", entityId: after.id, oldData: subSnapshot(current), newData: { ...subSnapshot(after), reason: ev.reason ?? null }, userId: ev.actor?.userId ?? null } });
    return after;
  }

  async function sellablePrice(packageId: string, cycleId: string, { forAdmin = false } = {}) {
    const pkg = await db.subscriptionPackage.findUnique({ where: { id: packageId } });
    if (!pkg) throw new SubscriptionError("Plan not found", 404, "NOT_FOUND");
    if (!forAdmin && pkg.status !== "PUBLISHED") throw new SubscriptionError("This plan isn't available", 422, "PLAN_UNAVAILABLE");
    if (forAdmin && pkg.status === "ARCHIVED") throw new SubscriptionError("Archived plans can't be sold", 422, "PLAN_UNAVAILABLE");
    const price = await db.subscriptionPackagePrice.findUnique({ where: { packageId_cycleId: { packageId, cycleId } }, include: { cycle: true } });
    if (!price || !price.isActive || !price.cycle?.isActive) throw new SubscriptionError("This plan has no active price for that billing cycle", 422, "PRICE_UNAVAILABLE");
    return { pkg, price, cycle: price.cycle };
  }

  async function quoteFor(vendorId: string, packageId: string, cycleId: string, opts: { forAdmin?: boolean } = {}) {
    const now = clock();
    const { pkg, price, cycle } = await sellablePrice(packageId, cycleId, opts);
    const offers = await liveOffers(vendorId, now);
    return { pkg, cycle, quote: quote(price, offers, packageId, cycleId, now) };
  }

  async function vendorExists(vendorId: string) {
    const v = await db.vendor.findUnique({ where: { id: vendorId }, select: { id: true, storeName: true } });
    if (!v) throw new SubscriptionError("Vendor not found", 404, "NOT_FOUND");
    return v;
  }

  /** Apply a PAID payment's period. Must run inside the payment's transaction. */
  async function applyPaidPayment(tx: SubsDb, payment: any, actor: Actor | null, now: Date) {
    const settings = await getSettings();
    const current = await tx.vendorSubscription.findUnique({ where: { vendorId: payment.vendorId } });
    const ev = evaluateSubscription(current, now, settings.graceDays);
    const cycle = await tx.subscriptionCycle.findUnique({ where: { id: payment.cycleId } });
    const period = periodFor({ state: ev.state, packageId: current?.packageId ?? null, expiresAt: current?.expiresAt ?? null }, payment.packageId, cycle.months, now, settings.changeStartsFrom);
    await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { periodStart: period.start, periodEnd: period.end } });
    const keepStart = period.kind === "RENEWAL" && current?.startedAt;
    return writeSubscription(
      tx,
      payment.vendorId,
      {
        packageId: payment.packageId, cycleId: payment.cycleId, status: "ACTIVE", source: "PAID",
        startedAt: keepStart ? current.startedAt : period.start, expiresAt: period.end, amountPaid: payment.amount, currency: payment.currency,
        offerId: payment.offerId ?? null, previousPackageId: current?.packageId && current.packageId !== payment.packageId ? current.packageId : current?.previousPackageId ?? null,
        suspendedReason: null, cancelledAt: null, isActive: true,
      },
      { kind: period.kind === "RENEWAL" ? "RENEWED" : period.kind === "CHANGE" ? "PLAN_CHANGED" : "ACTIVATED", actor, paymentId: payment.id, offerId: payment.offerId ?? null, reason: payment.note ?? null },
    );
  }

  /**
   * Admin records a verified payment (manual / bank / mobile wallet) and the
   * period starts in the same transaction. Idempotent on idempotencyKey. The
   * amount must match the vendor's quote unless an override reason is given.
   */
  async function recordPayment(vendorId: string, input: any, actor: Actor) {
    await vendorExists(vendorId);
    const idempotencyKey = str(input?.idempotencyKey, 100, "Idempotency key", true)!;
    const existing = await db.subscriptionPayment.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.vendorId !== vendorId) throw new SubscriptionError("That idempotency key belongs to another payment", 409, "DUPLICATE");
      return { payment: existing, duplicate: true };
    }
    const { quote: q } = await quoteFor(vendorId, input.packageId, input.cycleId, { forAdmin: true });
    const amount = moneyOf(input.amount, "Amount")!;
    const method = str(input.method, 40, "Payment method", true)!;
    const reference = str(input.reference, 120, "Reference", true)!;
    const overrideReason = str(input.overrideReason, 500, "Override reason");
    if (!money(amount).equals(money(q.finalPrice)) && !overrideReason)
      throw new SubscriptionError(`The vendor's price is ৳${q.finalPrice}. Give a reason to record a different amount.`, 422, "AMOUNT_MISMATCH");
    const now = clock();
    try {
      return await txDb.$transaction(async (tx: SubsDb) => {
        const payment = await tx.subscriptionPayment.create({
          data: {
            vendorId, packageId: input.packageId, cycleId: input.cycleId, amount, listAmount: q.listPrice, currency: "BDT", status: "PAID",
            method, reference, offerId: q.offerId, idempotencyKey, recordedById: actor.userId,
            note: [str(input.note, 500, "Note"), overrideReason ? `Amount override: ${overrideReason}` : null].filter(Boolean).join(" · ") || null,
          },
        });
        const subscription = await applyPaidPayment(tx, payment, actor, now);
        await notifyVendor(tx, vendorId, "Subscription active", `Your FinixMart plan is active until ${subscription.expiresAt ? new Date(subscription.expiresAt).toISOString().slice(0, 10) : "further notice"}.`);
        return { payment: await tx.subscriptionPayment.findUnique({ where: { id: payment.id } }), subscription, duplicate: false };
      });
    } catch (e) {
      if (isUnique(e)) {
        const p = await db.subscriptionPayment.findUnique({ where: { idempotencyKey } });
        if (p && p.vendorId === vendorId) return { payment: p, duplicate: true };
      }
      throw e;
    }
  }

  /** Admin confirms a vendor's PENDING plan request (exactly once). */
  async function confirmPayment(paymentId: string, input: any, actor: Actor) {
    const reference = str(input?.reference, 120, "Reference", true)!;
    const method = str(input?.method, 40, "Payment method");
    const now = clock();
    return txDb.$transaction(async (tx: SubsDb) => {
      const p = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      if (!p) throw new SubscriptionError("Payment not found", 404, "NOT_FOUND");
      const claimed = await tx.subscriptionPayment.updateMany({ where: { id: paymentId, status: "PENDING" }, data: { status: "PAID", reference, recordedById: actor.userId, ...(method ? { method } : {}) } });
      if (claimed.count !== 1) throw new SubscriptionError(`This payment is already ${String(p.status).toLowerCase()}`, 409, "ALREADY_PROCESSED");
      const paid = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      const subscription = await applyPaidPayment(tx, paid, actor, now);
      await notifyVendor(tx, p.vendorId, "Subscription active", "Your FinixMart plan payment was confirmed and your plan is active.");
      return { payment: await tx.subscriptionPayment.findUnique({ where: { id: paymentId } }), subscription };
    });
  }

  /** Close a payment without applying it (PENDING → CANCELLED / FAILED) or mark a PAID one REFUNDED (record only). */
  async function setPaymentStatus(paymentId: string, status: string, reasonRaw: unknown, actor: Actor) {
    const reason = reasonOf(reasonRaw);
    const allowed: Record<string, string[]> = { CANCELLED: ["PENDING"], FAILED: ["PENDING"], REFUNDED: ["PAID"] };
    if (!allowed[status]) throw new SubscriptionError("Status must be CANCELLED, FAILED or REFUNDED", 400, "VALIDATION");
    return txDb.$transaction(async (tx: SubsDb) => {
      const p = await tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
      if (!p) throw new SubscriptionError("Payment not found", 404, "NOT_FOUND");
      const res = await tx.subscriptionPayment.updateMany({ where: { id: paymentId, status: { in: allowed[status] } }, data: { status, note: [p.note, `${status}: ${reason}`].filter(Boolean).join(" · ").slice(0, 1000) } });
      if (res.count !== 1) throw new SubscriptionError(`A ${String(p.status).toLowerCase()} payment can't be marked ${status.toLowerCase()}`, 409, "INVALID_STATE");
      await tx.auditLog.create({ data: { action: `SUBS_PAYMENT_${status}`, entity: "SubscriptionPayment", entityId: paymentId, oldData: { status: p.status }, newData: { status, reason, note: status === "REFUNDED" ? "Subscription period left unchanged; suspend or cancel separately if needed." : null }, userId: actor.userId } });
      return tx.subscriptionPayment.findUnique({ where: { id: paymentId } });
    });
  }

  /** Admin activation without a payment (complimentary / trial / admin), with a reason. */
  async function activate(vendorId: string, input: any, actor: Actor) {
    await vendorExists(vendorId);
    const reason = reasonOf(input?.reason);
    const source = input?.source ?? "COMPLIMENTARY";
    if (!["COMPLIMENTARY", "TRIAL", "ADMIN"].includes(source)) throw new SubscriptionError("Source must be COMPLIMENTARY, TRIAL or ADMIN", 400, "VALIDATION");
    const { pkg, cycle } = await sellablePrice(input.packageId, input.cycleId, { forAdmin: true });
    const now = clock();
    let expiresAt: Date | null;
    if (input.expiresAt === null && source !== "TRIAL") expiresAt = null; // open-ended complimentary access
    else if (input.expiresAt !== undefined) {
      expiresAt = dateOf(input.expiresAt, "End date");
      if (expiresAt <= now) throw new SubscriptionError("The end date must be in the future", 400, "VALIDATION");
    } else expiresAt = periodFor(null, pkg.id, cycle.months, now).end;
    return txDb.$transaction(async (tx: SubsDb) => {
      const current = await tx.vendorSubscription.findUnique({ where: { vendorId } });
      const sub = await writeSubscription(
        tx, vendorId,
        {
          packageId: pkg.id, cycleId: cycle.id, status: "ACTIVE", source, startedAt: now, expiresAt, amountPaid: null, offerId: null,
          previousPackageId: current?.packageId && current.packageId !== pkg.id ? current.packageId : current?.previousPackageId ?? null,
          suspendedReason: null, cancelledAt: null, isActive: true,
        },
        { kind: "ADMIN_ACTIVATED", actor, reason },
      );
      await notifyVendor(tx, vendorId, "Plan activated", `FinixMart activated the ${pkg.name} plan for your store${expiresAt ? ` until ${expiresAt.toISOString().slice(0, 10)}` : ""}.`);
      return sub;
    });
  }

  async function mutateExisting(vendorId: string, kind: string, actor: Actor, reasonRaw: unknown, build: (sub: any, now: Date) => Record<string, unknown>) {
    const reason = reasonOf(reasonRaw);
    const now = clock();
    return txDb.$transaction(async (tx: SubsDb) => {
      const sub = await tx.vendorSubscription.findUnique({ where: { vendorId } });
      if (!sub || !sub.status || !sub.packageId) throw new SubscriptionError("This vendor has no plan subscription", 404, "NOT_FOUND");
      return writeSubscription(tx, vendorId, build(sub, now), { kind, actor, reason });
    });
  }

  const extend = (vendorId: string, input: any, actor: Actor) => {
    const days = intOf(input?.days, 1, 3650, "Days");
    return mutateExisting(vendorId, "EXTENDED", actor, input?.reason, (sub, now) => {
      if (sub.status === "CANCELLED") throw new SubscriptionError("A cancelled subscription can't be extended; activate a plan instead", 409, "INVALID_STATE");
      if (!sub.expiresAt) throw new SubscriptionError("This subscription has no end date", 409, "INVALID_STATE");
      const base = sub.expiresAt > now ? sub.expiresAt : now;
      return { expiresAt: new Date(base.getTime() + days * DAY), ...(sub.status === "EXPIRED" ? { status: "ACTIVE" } : {}) };
    });
  };
  const suspend = (vendorId: string, input: any, actor: Actor) =>
    mutateExisting(vendorId, "SUSPENDED", actor, input?.reason, (sub) => {
      if (sub.status === "SUSPENDED") throw new SubscriptionError("Already suspended", 409, "INVALID_STATE");
      return { status: "SUSPENDED", suspendedReason: reasonOf(input?.reason) };
    });
  const restore = (vendorId: string, input: any, actor: Actor) =>
    mutateExisting(vendorId, "RESTORED", actor, input?.reason, (sub) => {
      if (sub.status !== "SUSPENDED") throw new SubscriptionError("Only a suspended subscription can be restored", 409, "INVALID_STATE");
      return { status: "ACTIVE", suspendedReason: null };
    });
  const cancel = (vendorId: string, input: any, actor: Actor) =>
    mutateExisting(vendorId, "CANCELLED", actor, input?.reason, (sub, now) => {
      if (sub.status === "CANCELLED") throw new SubscriptionError("Already cancelled", 409, "INVALID_STATE");
      return { status: "CANCELLED", cancelledAt: now };
    });

  async function listSubscriptions(q: { state?: string; q?: string; packageId?: string; page?: number; pageSize?: number } = {}) {
    const settings = await getSettings();
    const now = clock();
    const where: Record<string, unknown> = { status: { not: null } };
    if (q.packageId) where.packageId = q.packageId;
    if (q.q) where.vendor = { storeName: { contains: q.q, mode: "insensitive" } };
    const rows = await db.vendorSubscription.findMany({
      where,
      include: { vendor: { select: { id: true, storeName: true, avatar: true } }, package: { select: { id: true, name: true, color: true } }, cycle: { select: { id: true, name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 2000,
    });
    let items = rows.map((r: any) => ({ ...r, evaluation: evaluateSubscription(r, now, settings.graceDays) }));
    if (q.state) items = items.filter((r: any) => r.evaluation.state === q.state);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 25));
    const page = Math.max(1, q.page ?? 1);
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
  }

  async function vendorDetailForAdmin(vendorId: string) {
    const vendor = await vendorExists(vendorId);
    const { sub, evaluation } = await evaluationFor(vendorId);
    const [events, payments, offers, entitlements] = await Promise.all([
      db.vendorSubscriptionEvent.findMany({ where: { vendorId }, orderBy: { createdAt: "desc" }, take: 100 }),
      db.subscriptionPayment.findMany({ where: { vendorId }, orderBy: { createdAt: "desc" }, take: 100, include: { package: { select: { name: true } }, cycle: { select: { name: true } } } }),
      db.vendorSubscriptionOffer.findMany({ where: { vendorId }, orderBy: { createdAt: "desc" }, include: { package: { select: { name: true } }, feature: { select: { name: true, key: true } } } }),
      entitlementsFor(vendorId),
    ]);
    const pkg = sub?.packageId ? await db.subscriptionPackage.findUnique({ where: { id: sub.packageId }, select: { id: true, name: true, color: true } }) : null;
    return { vendor, subscription: sub, package: pkg, evaluation, events, payments, offers, entitlements };
  }

  /** Vendor picker for admins (id + store name only). */
  async function searchVendors(q: string | undefined) {
    const term = (q ?? "").trim().slice(0, 60);
    return db.vendor.findMany({
      where: term ? { OR: [{ storeName: { contains: term, mode: "insensitive" } }, { id: term }] } : {},
      select: { id: true, storeName: true, status: true },
      orderBy: { storeName: "asc" },
      take: 20,
    });
  }

  // ─── offers ───────────────────────────────────────────────────────────────

  async function createOffer(input: any, actor: Actor) {
    const vendorId = str(input?.vendorId, 64, "Vendor", true)!;
    const vendor = await vendorExists(vendorId);
    const kinds = ["PRICE_OVERRIDE", "PERCENT_DISCOUNT", "FIXED_DISCOUNT", "FREE_PLAN", "FREE_FEATURE"];
    if (!kinds.includes(input.kind)) throw new SubscriptionError("Unknown offer type", 400, "VALIDATION");
    const afterExpiry = input.afterExpiry ?? "MANUAL_RENEWAL";
    if (!["NORMAL_PRICE", "PREVIOUS_SUBSCRIPTION", "SWITCH_PLAN", "DISABLE_FEATURE", "MANUAL_RENEWAL"].includes(afterExpiry)) throw new SubscriptionError("Unknown after-expiry behaviour", 400, "VALIDATION");
    const startsAt = input.startsAt ? dateOf(input.startsAt, "Start") : clock();
    const endsAt = dateOf(input.endsAt, "End");
    if (endsAt <= startsAt) throw new SubscriptionError("The offer must end after it starts", 400, "VALIDATION");
    if (endsAt <= clock()) throw new SubscriptionError("The offer must end in the future", 400, "VALIDATION");
    let packageId: string | null = null, cycleId: string | null = null, featureId: string | null = null, value: string | null = null;
    let label = "";
    if (input.kind === "FREE_FEATURE") {
      const f = await db.subscriptionFeature.findUnique({ where: { id: input.featureId } });
      if (!f) throw new SubscriptionError("Choose a feature", 400, "VALIDATION");
      featureId = f.id;
      label = f.name;
    } else {
      const p = await db.subscriptionPackage.findUnique({ where: { id: input.packageId } });
      if (!p || p.status === "ARCHIVED") throw new SubscriptionError("Choose a plan that isn't archived", 400, "VALIDATION");
      packageId = p.id;
      label = p.name;
      if (input.cycleId) {
        const c = await db.subscriptionCycle.findUnique({ where: { id: input.cycleId } });
        if (!c) throw new SubscriptionError("Unknown billing cycle", 400, "VALIDATION");
        cycleId = c.id;
      }
      if (input.kind !== "FREE_PLAN") {
        value = moneyOf(input.value, input.kind === "PERCENT_DISCOUNT" ? "Discount %" : "Amount")!;
        if (input.kind === "PERCENT_DISCOUNT" && (money(value).greaterThan(100) || money(value).lessThanOrEqualTo(0))) throw new SubscriptionError("Discount must be above 0 and at most 100%", 400, "VALIDATION");
      }
    }
    let afterExpiryPackageId: string | null = null;
    if (afterExpiry === "SWITCH_PLAN") {
      const p = await db.subscriptionPackage.findUnique({ where: { id: input.afterExpiryPackageId } });
      if (!p || p.status !== "PUBLISHED") throw new SubscriptionError("Choose a published plan to switch to after the offer", 400, "VALIDATION");
      afterExpiryPackageId = p.id;
    }
    const data = { vendorId, kind: input.kind, packageId, cycleId, featureId, value, startsAt, endsAt, status: "ACTIVE", afterExpiry, afterExpiryPackageId, note: str(input.note, 500, "Note"), createdById: actor.userId };
    return txDb.$transaction(async (tx: SubsDb) => {
      const row = await tx.vendorSubscriptionOffer.create({ data });
      await tx.auditLog.create({ data: { action: "SUBS_OFFER_CREATED", entity: "VendorSubscriptionOffer", entityId: row.id, newData: { ...data, startsAt: iso(startsAt), endsAt: iso(endsAt) }, userId: actor.userId } });
      await notifyVendor(tx, vendor.id, "Special plan offer", `FinixMart has a special offer for your store on ${label}, valid until ${endsAt.toISOString().slice(0, 10)}. See Subscription for details.`);
      return row;
    });
  }

  async function setOfferStatus(id: string, action: string, reasonRaw: unknown, actor: Actor) {
    const reason = reasonOf(reasonRaw);
    const map: Record<string, { from: string[]; to: string }> = { pause: { from: ["ACTIVE"], to: "PAUSED" }, resume: { from: ["PAUSED"], to: "ACTIVE" }, revoke: { from: ["ACTIVE", "PAUSED"], to: "REVOKED" } };
    const m = map[action];
    if (!m) throw new SubscriptionError("Action must be pause, resume or revoke", 400, "VALIDATION");
    return txDb.$transaction(async (tx: SubsDb) => {
      const o = await tx.vendorSubscriptionOffer.findUnique({ where: { id } });
      if (!o) throw new SubscriptionError("Offer not found", 404, "NOT_FOUND");
      if (action === "resume" && o.endsAt <= clock()) throw new SubscriptionError("This offer has already ended", 409, "INVALID_STATE");
      const res = await tx.vendorSubscriptionOffer.updateMany({ where: { id, status: { in: m.from } }, data: { status: m.to, updatedById: actor.userId } });
      if (res.count !== 1) throw new SubscriptionError(`A ${String(o.status).toLowerCase()} offer can't be ${action}d`, 409, "INVALID_STATE");
      await tx.auditLog.create({ data: { action: `SUBS_OFFER_${m.to}`, entity: "VendorSubscriptionOffer", entityId: id, oldData: { status: o.status }, newData: { status: m.to, reason }, userId: actor.userId } });
      return tx.vendorSubscriptionOffer.findUnique({ where: { id } });
    });
  }

  const listOffers = (q: { vendorId?: string; status?: string } = {}) =>
    db.vendorSubscriptionOffer.findMany({
      where: { ...(q.vendorId ? { vendorId: q.vendorId } : {}), ...(q.status ? { status: q.status } : {}) },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { vendor: { select: { id: true, storeName: true } }, package: { select: { id: true, name: true } }, cycle: { select: { id: true, name: true } }, feature: { select: { id: true, name: true, key: true } } },
    });

  // ─── transactions and reports ────────────────────────────────────────────

  async function listPayments(q: { vendorId?: string; status?: string; from?: string; to?: string; page?: number; pageSize?: number } = {}) {
    const where: Record<string, unknown> = {};
    if (q.vendorId) where.vendorId = q.vendorId;
    if (q.status) where.status = q.status;
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: dateOf(q.from, "From") } : {}), ...(q.to ? { lte: dateOf(q.to, "To") } : {}) };
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 25));
    const page = Math.max(1, q.page ?? 1);
    const [items, total] = await Promise.all([
      db.subscriptionPayment.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { vendor: { select: { id: true, storeName: true } }, package: { select: { name: true } }, cycle: { select: { name: true } } } }),
      db.subscriptionPayment.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async function overview() {
    const now = clock();
    const settings = await getSettings();
    const [subs, paid, pending, offers, packages] = await Promise.all([
      db.vendorSubscription.findMany({ where: { status: { not: null } }, select: { status: true, packageId: true, expiresAt: true, graceDays: true, source: true, amountPaid: true, cycleId: true } }),
      db.subscriptionPayment.findMany({ where: { status: "PAID", createdAt: { gte: new Date(now.getTime() - 366 * DAY) } }, select: { amount: true, createdAt: true, packageId: true } }),
      db.subscriptionPayment.count({ where: { status: "PENDING" } }),
      db.vendorSubscriptionOffer.count({ where: { status: "ACTIVE", endsAt: { gt: now } } }),
      db.subscriptionPackage.findMany({ select: { id: true, name: true, color: true, status: true } }),
    ]);
    const states: Record<string, number> = { ACTIVE: 0, GRACE: 0, EXPIRED: 0, SUSPENDED: 0, CANCELLED: 0, PENDING: 0 };
    const byPackage = new Map<string, number>();
    let expiringSoon = 0, trials = 0;
    for (const s of subs) {
      const e = evaluateSubscription(s, now, settings.graceDays);
      if (e.state in states) states[e.state]++;
      if (OPERATIVE_STATES.includes(e.state)) {
        byPackage.set(s.packageId, (byPackage.get(s.packageId) ?? 0) + 1);
        if (s.source === "TRIAL") trials++;
        if (s.expiresAt && s.expiresAt.getTime() - now.getTime() <= settings.reminderDays * DAY) expiringSoon++;
      }
    }
    const months: { month: string; revenue: string }[] = [];
    const revenueByMonth = new Map<string, ReturnType<typeof money>>();
    const revenueByPackage = new Map<string, ReturnType<typeof money>>();
    for (const p of paid) {
      const d = new Date(new Date(p.createdAt).getTime() + 6 * 3_600_000);
      const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      revenueByMonth.set(k, (revenueByMonth.get(k) ?? money(0)).plus(money(p.amount)));
      revenueByPackage.set(p.packageId, (revenueByPackage.get(p.packageId) ?? money(0)).plus(money(p.amount)));
    }
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(new Date(now.getTime() + 6 * 3_600_000).getUTCFullYear(), new Date(now.getTime() + 6 * 3_600_000).getUTCMonth() - i, 1));
      const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      months.push({ month: k, revenue: (revenueByMonth.get(k) ?? money(0)).toFixed(2) });
    }
    const thisMonth = months[months.length - 1].revenue;
    return {
      totals: { active: states.ACTIVE + states.GRACE, grace: states.GRACE, expired: states.EXPIRED, suspended: states.SUSPENDED, cancelled: states.CANCELLED, trials, expiringSoon, pendingPayments: pending, activeOffers: offers, revenueThisMonth: thisMonth, revenue12m: months.reduce((s, m) => s.plus(money(m.revenue)), money(0)).toFixed(2) },
      revenueByMonth: months,
      byPackage: packages.map((p: any) => ({ ...p, activeSubscribers: byPackage.get(p.id) ?? 0, revenue12m: (revenueByPackage.get(p.id) ?? money(0)).toFixed(2) })),
      plans: { published: packages.filter((p: any) => p.status === "PUBLISHED").length, draft: packages.filter((p: any) => p.status === "DRAFT").length, archived: packages.filter((p: any) => p.status === "ARCHIVED").length },
    };
  }

  // ─── entitlement ─────────────────────────────────────────────────────────

  async function decideFor(vendorId: string, feature: any, ctx: { sub: any; state: any; offers: OfferRow[] }): Promise<FeatureDecision> {
    if (!feature) return decideFeature({ feature: null, subState: ctx.state, planAssignment: null, freePlanAssignments: [], freeFeatureOfferIds: [] });
    const planPkgs = [ctx.sub?.packageId, ...ctx.offers.filter((o) => o.kind === "FREE_PLAN").map((o) => o.packageId)].filter(Boolean) as string[];
    const assignments = planPkgs.length ? await db.subscriptionPackageFeature.findMany({ where: { featureId: feature.id, packageId: { in: planPkgs } } }) : [];
    const find = (pid: string | null | undefined) => assignments.find((a: any) => a.packageId === pid);
    const plan = find(ctx.sub?.packageId);
    return decideFeature({
      feature: { id: feature.id, key: feature.key, isActive: feature.isActive, enforced: feature.enforced, limitDefs: (feature.limitDefs ?? []) as LimitDef[] },
      subState: ctx.state,
      planAssignment: plan ? { enabled: plan.enabled, config: (plan.config ?? {}) as LimitConfig } : null,
      freePlanAssignments: ctx.offers
        .filter((o) => o.kind === "FREE_PLAN")
        .map((o) => ({ offerId: o.id, a: find(o.packageId) }))
        .filter((x) => x.a)
        .map((x) => ({ offerId: x.offerId, enabled: x.a.enabled, config: (x.a.config ?? {}) as LimitConfig })),
      freeFeatureOfferIds: ctx.offers.filter((o) => o.kind === "FREE_FEATURE" && o.featureId === feature.id).map((o) => o.id),
    });
  }

  /** Decision for one feature key, including the platform-wide monitor switch. */
  async function entitlementFor(vendorId: string, featureKey: string) {
    const now = clock();
    // Feature first: an unknown feature needs no other query (the POS fallback
    // asks for "pos" on every denied POS request).
    const feature = await db.subscriptionFeature.findUnique({ where: { key: featureKey } });
    if (!feature) {
      const decision = decideFeature({ feature: null, subState: "NONE", planAssignment: null, freePlanAssignments: [], freeFeatureOfferIds: [] });
      return { ...decision, monitor: false, feature: null, subscription: evaluateSubscription(null, now, DEFAULT_SUBS_SETTINGS.graceDays) };
    }
    const [{ sub, settings, evaluation }, offers] = await Promise.all([evaluationFor(vendorId, now), liveOffers(vendorId, now)]);
    const decision = await decideFor(vendorId, feature, { sub, state: evaluation.state, offers });
    const monitor = settings.enforcement === "monitor";
    return { ...decision, allowed: decision.allowed || (monitor && decision.reason !== "FEATURE_UNKNOWN"), monitor, feature: feature ? { id: feature.id, key: feature.key, name: feature.name, limitDefs: (feature.limitDefs ?? []) as LimitDef[] } : null, subscription: evaluation };
  }

  /** Every active feature, for the vendor's own page and the admin detail view. */
  async function entitlementsFor(vendorId: string) {
    const now = clock();
    const [{ sub, evaluation }, features, offers] = await Promise.all([evaluationFor(vendorId, now), db.subscriptionFeature.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }), liveOffers(vendorId, now)]);
    const out = [];
    for (const f of features) {
      const d = await decideFor(vendorId, f, { sub, state: evaluation.state, offers });
      const usage = await db.vendorFeatureUsage.findMany({ where: { vendorId, featureId: f.id } });
      out.push({
        key: f.key, name: f.name, icon: f.icon, color: f.color, granted: d.granted, enforced: d.enforced, sources: d.sources, limits: d.limits,
        limitDefs: f.limitDefs ?? [],
        usage: ((f.limitDefs ?? []) as LimitDef[]).map((def) => ({ key: def.key, used: usage.find((u: any) => u.limitKey === def.key && u.periodKey === usagePeriodKey(def, now))?.used ?? 0 })),
      });
    }
    return out;
  }

  /**
   * Consume `amount` of a numeric limit atomically. Unlimited (null) always
   * succeeds and is still counted. Returns ok:false (nothing written) when the
   * cap would be exceeded.
   */
  async function consumeUsage(vendorId: string, featureKey: string, limitKey: string, amount = 1) {
    const ent = await entitlementFor(vendorId, featureKey);
    const def = ent.feature?.limitDefs.find((d) => d.key === limitKey);
    if (!ent.feature || !def || def.type !== "number") throw new SubscriptionError(`Unknown usage limit ${featureKey}.${limitKey}`, 500, "LIMIT_UNKNOWN");
    const cap = ent.granted ? (ent.limits[limitKey] as number | null | undefined) ?? null : 0;
    const periodKey = usagePeriodKey(def, clock());
    const key = { vendorId_featureId_limitKey_periodKey: { vendorId, featureId: ent.feature.id, limitKey, periodKey } };
    await db.vendorFeatureUsage.upsert({ where: key, update: {}, create: { vendorId, featureId: ent.feature.id, limitKey, periodKey, used: 0 } });
    const where: Record<string, unknown> = { vendorId, featureId: ent.feature.id, limitKey, periodKey };
    if (cap !== null && ent.enforced && !ent.monitor) where.used = { lte: cap - amount };
    const res = await db.vendorFeatureUsage.updateMany({ where, data: { used: { increment: amount } } });
    const row = await db.vendorFeatureUsage.findUnique({ where: key });
    return { ok: res.count === 1, used: row?.used ?? 0, cap, periodKey, enforced: ent.enforced && !ent.monitor };
  }

  // ─── vendor side ─────────────────────────────────────────────────────────

  /** Published plans the vendor can buy (public, plus hidden plans offered to this vendor), with the vendor's own prices. */
  async function vendorPlans(vendorId: string) {
    const now = clock();
    const offers = await liveOffers(vendorId, now);
    const offeredPkgs = offers.map((o) => o.packageId).filter(Boolean);
    const pkgs = await db.subscriptionPackage.findMany({
      where: { status: "PUBLISHED", OR: [{ visibility: "PUBLIC" }, { id: { in: offeredPkgs } }] },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
      include: { features: { where: { enabled: true }, include: { feature: true } }, prices: { where: { isActive: true }, include: { cycle: true } } },
    });
    const cycles = (await listCycles()).filter((c: any) => c.isActive);
    return {
      cycles: cycles.map((c: any) => ({ id: c.id, key: c.key, name: c.name, months: c.months })),
      plans: pkgs.map((p: any) => ({
        id: p.id, name: p.name, slug: p.slug, description: p.description, icon: p.icon, color: p.color, isPopular: p.isPopular, trialDays: p.trialDays,
        features: p.features
          .filter((f: any) => f.feature.isActive)
          .sort((a: any, b: any) => a.feature.sortOrder - b.feature.sortOrder)
          .map((f: any) => ({ key: f.feature.key, name: f.feature.name, icon: f.feature.icon, description: f.feature.description, limits: f.config ?? {}, limitDefs: f.feature.limitDefs ?? [] })),
        prices: p.prices
          .filter((x: any) => x.cycle?.isActive)
          .sort((a: any, b: any) => a.cycle.months - b.cycle.months)
          .map((x: any) => ({ cycleId: x.cycleId, cycleName: x.cycle.name, months: x.cycle.months, ...quote(x, offers, p.id, x.cycleId, now) })),
        freeUntil: offers.filter((o) => o.kind === "FREE_PLAN" && o.packageId === p.id).map((o) => iso(o.endsAt))[0] ?? null,
      })),
    };
  }

  async function vendorCurrent(vendorId: string) {
    const now = clock();
    const { sub, evaluation, settings } = await evaluationFor(vendorId, now);
    const [pkg, cycle, offers, entitlements, pending] = await Promise.all([
      sub?.packageId ? db.subscriptionPackage.findUnique({ where: { id: sub.packageId }, select: { id: true, name: true, color: true, icon: true } }) : null,
      sub?.cycleId ? db.subscriptionCycle.findUnique({ where: { id: sub.cycleId }, select: { id: true, name: true, months: true } }) : null,
      db.vendorSubscriptionOffer.findMany({ where: { vendorId, status: "ACTIVE", endsAt: { gt: now } }, include: { package: { select: { name: true } }, feature: { select: { name: true } } }, orderBy: { endsAt: "asc" } }),
      entitlementsFor(vendorId),
      db.subscriptionPayment.findMany({ where: { vendorId, status: "PENDING" }, include: { package: { select: { name: true } }, cycle: { select: { name: true } } } }),
    ]);
    return {
      evaluation,
      graceDays: sub?.graceDays ?? settings.graceDays,
      subscription: sub ? { status: sub.status, source: sub.source, startedAt: iso(sub.startedAt), expiresAt: iso(sub.expiresAt), amountPaid: sub.amountPaid === null ? null : String(sub.amountPaid), currency: sub.currency } : null,
      package: pkg,
      cycle,
      offers: offers.map((o: any) => ({ id: o.id, kind: o.kind, value: o.value === null ? null : String(o.value), startsAt: iso(o.startsAt), endsAt: iso(o.endsAt), planName: o.package?.name ?? null, featureName: o.feature?.name ?? null, afterExpiry: o.afterExpiry, live: offerIsLive(o, now) })),
      entitlements,
      pendingRequests: pending,
    };
  }

  const vendorPayments = (vendorId: string) =>
    db.subscriptionPayment.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, amount: true, listAmount: true, currency: true, status: true, method: true, reference: true, periodStart: true, periodEnd: true, createdAt: true, package: { select: { name: true } }, cycle: { select: { name: true } } },
    });

  /**
   * The vendor asks for a plan. A price of ৳0 (free tier, 100% offer) starts
   * right away; anything else becomes ONE pending request per plan + cycle for
   * FinixMart to confirm after payment. Nothing is charged here.
   */
  async function vendorRequestPlan(vendorId: string, input: any) {
    const { pkg, cycle, quote: q } = await quoteFor(vendorId, input?.packageId, input?.cycleId);
    const now = clock();
    const method = str(input?.method, 40, "Payment method") ?? "MANUAL";
    const reference = str(input?.reference, 120, "Reference");
    if (money(q.finalPrice).isZero()) {
      return txDb.$transaction(async (tx: SubsDb) => {
        const payment = await tx.subscriptionPayment.create({
          data: { vendorId, packageId: pkg.id, cycleId: cycle.id, amount: "0", listAmount: q.listPrice, status: "PAID", method: "FREE", offerId: q.offerId, idempotencyKey: `FREE:${vendorId}:${randomUUID()}`, note: "No charge" },
        });
        const subscription = await applyPaidPayment(tx, payment, null, now);
        return { status: "ACTIVE", payment, subscription };
      });
    }
    const existing = await db.subscriptionPayment.findFirst({ where: { vendorId, packageId: pkg.id, cycleId: cycle.id, status: "PENDING" } });
    if (existing) return { status: "PENDING", payment: existing, duplicate: true };
    return txDb.$transaction(async (tx: SubsDb) => {
      const payment = await tx.subscriptionPayment.create({
        data: { vendorId, packageId: pkg.id, cycleId: cycle.id, amount: q.finalPrice, listAmount: q.listPrice, status: "PENDING", method, reference, offerId: q.offerId, idempotencyKey: `REQ:${vendorId}:${randomUUID()}` },
      });
      // Admins see pending requests on the subscription dashboard (Notification has no admin target).
      await tx.auditLog.create({ data: { action: "SUBS_PLAN_REQUESTED", entity: "SubscriptionPayment", entityId: payment.id, newData: { vendorId, packageId: pkg.id, cycleId: cycle.id, amount: q.finalPrice }, userId: null } });
      return { status: "PENDING", payment, duplicate: false };
    });
  }

  /** The vendor withdraws its own pending request. */
  async function vendorCancelRequest(vendorId: string, paymentId: string) {
    const res = await db.subscriptionPayment.updateMany({ where: { id: paymentId, vendorId, status: "PENDING" }, data: { status: "CANCELLED", note: "Withdrawn by the vendor" } });
    if (res.count !== 1) throw new SubscriptionError("No pending request found", 404, "NOT_FOUND");
    return { ok: true };
  }

  // ─── jobs ────────────────────────────────────────────────────────────────

  async function notifyVendor(tx: SubsDb, vendorId: string, title: string, message: string) {
    await tx.notification.create({ data: { type: "SYSTEM", title, message, targetType: "VENDOR", targetId: vendorId, actionUrl: "/vendor-dashboard/subscription" } });
  }

  /** ACTIVE rows past end + grace → EXPIRED (event row). Access never waits for this: it reads the dates. */
  async function runExpirySweep(now = clock()) {
    const settings = await getSettings({ fresh: true });
    const rows = await db.vendorSubscription.findMany({ where: { status: "ACTIVE", expiresAt: { lt: now } }, take: 500 });
    let n = 0;
    for (const s of rows) {
      if (evaluateSubscription(s, now, settings.graceDays).state !== "EXPIRED") continue;
      try {
        await txDb.$transaction(async (tx: SubsDb) => {
          await writeSubscription(tx, s.vendorId, { status: "EXPIRED" }, { kind: "EXPIRED", reason: "Period and grace ended" });
          await notifyVendor(tx, s.vendorId, "Subscription ended", "Your FinixMart plan has ended. Renew from Subscription to keep its features.");
        });
        n++;
      } catch (e) {
        if (!(e instanceof SubscriptionError && e.code === "CONFLICT")) throw e;
      }
    }
    return n;
  }

  /** Offers past their end → EXPIRED, then their after-expiry behaviour (never a charge or a silent plan change). */
  async function runOfferExpiry(now = clock()) {
    const rows = await db.vendorSubscriptionOffer.findMany({ where: { status: { in: ["ACTIVE", "PAUSED"] }, endsAt: { lte: now } }, include: { package: { select: { name: true } } }, take: 500 });
    let n = 0;
    for (const o of rows) {
      await txDb.$transaction(async (tx: SubsDb) => {
        const claimed = await tx.vendorSubscriptionOffer.updateMany({ where: { id: o.id, status: { in: ["ACTIVE", "PAUSED"] } }, data: { status: "EXPIRED" } });
        if (claimed.count !== 1) return;
        let message = "Your special offer has ended.";
        const result: Record<string, unknown> = { afterExpiry: o.afterExpiry };
        if (o.afterExpiry === "SWITCH_PLAN" && o.afterExpiryPackageId && o.status === "ACTIVE") {
          const target = await tx.subscriptionPackage.findUnique({ where: { id: o.afterExpiryPackageId }, include: { prices: { where: { isActive: true }, include: { cycle: true } } } });
          const price = target?.status === "PUBLISHED" ? target.prices.filter((p: any) => p.cycle?.isActive).sort((a: any, b: any) => a.cycle.months - b.cycle.months)[0] : null;
          if (price) {
            const q = quote(price, [], target.id, price.cycleId, now);
            const pending = await tx.subscriptionPayment.create({
              data: { vendorId: o.vendorId, packageId: target.id, cycleId: price.cycleId, amount: q.finalPrice, listAmount: q.listPrice, status: "PENDING", method: "MANUAL", idempotencyKey: `OFFER_SWITCH:${o.id}`, note: "Opened when a special offer ended. Not charged; confirm after payment." },
            });
            result.pendingPaymentId = pending.id;
            message = `Your special offer has ended. A ${target.name} plan request for ৳${q.finalPrice} is waiting. Nothing is charged until you pay.`;
          } else result.skipped = "target plan not sellable";
        } else if (o.afterExpiry === "PREVIOUS_SUBSCRIPTION") message = "Your special offer has ended. Your own plan (if any) continues as before.";
        else if (o.afterExpiry === "NORMAL_PRICE") message = "Your special offer has ended. Plans are back to their normal price.";
        else if (o.afterExpiry === "DISABLE_FEATURE") message = "Your free feature access has ended.";
        else message = "Your special offer has ended. Renew from Subscription whenever you are ready.";
        await tx.auditLog.create({ data: { action: "SUBS_OFFER_EXPIRED", entity: "VendorSubscriptionOffer", entityId: o.id, oldData: { status: o.status, endsAt: iso(o.endsAt) }, newData: result, userId: null } });
        await notifyVendor(tx, o.vendorId, "Special offer ended", message);
        n++;
      });
    }
    return n;
  }

  /** One reminder per vendor per end date, within the reminder window. */
  async function runRenewalReminders(now = clock()) {
    const settings = await getSettings({ fresh: true });
    if (settings.reminderDays <= 0) return 0;
    const rows = await db.vendorSubscription.findMany({ where: { status: "ACTIVE", expiresAt: { gt: now, lte: new Date(now.getTime() + settings.reminderDays * DAY) } }, take: 1000 });
    let n = 0;
    for (const s of rows) {
      if (s.reminderSentFor && new Date(s.reminderSentFor).getTime() === new Date(s.expiresAt).getTime()) continue;
      const claimed = await db.vendorSubscription.updateMany({ where: { id: s.id, expiresAt: s.expiresAt, OR: [{ reminderSentFor: null }, { reminderSentFor: { not: s.expiresAt } }] }, data: { reminderSentFor: s.expiresAt } });
      if (claimed.count !== 1) continue;
      const left = Math.max(1, Math.ceil((new Date(s.expiresAt).getTime() - now.getTime()) / DAY));
      await notifyVendor(db, s.vendorId, "Subscription ending soon", `Your FinixMart plan ends in ${left} day${left === 1 ? "" : "s"}. Renew to keep its features.`);
      n++;
    }
    return n;
  }

  return {
    getSettings, setSettings,
    listFeatures, createFeature, updateFeature,
    listCycles, createCycle, updateCycle,
    listPackages, getPackage, createPackage, updatePackage, duplicatePackage, setPackageStatus, setPackageFeatures, setPackagePrices,
    quoteFor, searchVendors, recordPayment, confirmPayment, setPaymentStatus, activate, extend, suspend, restore, cancel, listSubscriptions, vendorDetailForAdmin,
    createOffer, setOfferStatus, listOffers,
    listPayments, overview,
    entitlementFor, entitlementsFor, consumeUsage,
    vendorPlans, vendorCurrent, vendorPayments, vendorRequestPlan, vendorCancelRequest,
    runExpirySweep, runOfferExpiry, runRenewalReminders,
    defaults: DEFAULT_SUBS_SETTINGS,
  };
}

export type SubscriptionService = ReturnType<typeof createSubscriptionService>;

let singleton: SubscriptionService | null = null;
export const subscriptionService = (): SubscriptionService => (singleton ??= createSubscriptionService());
