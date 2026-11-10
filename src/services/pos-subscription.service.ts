// src/services/pos-subscription.service.ts
//
// POS subscription lifecycle: entitlement reads, trial policy, the one-time
// trial on vendor approval, admin grant/extend/revoke/suspend/restore, plans,
// vendor checkout through the platform's active gateway, verified callbacks
// and the expiry sweep / renewal reminders.
//
// Invariants
//   - Access is decided by evaluateEntitlement() on the persisted row at
//     request time (see modules/pos-subscription/entitlement.ts).
//   - Every entitlement change bumps PosSubscription.version (optimistic
//     concurrency), appends a PosSubscriptionPeriod row and an AuditLog row in
//     the SAME transaction.
//   - The automatic trial is gated by PosTrialGrant (PK = vendorId): at most
//     one per vendor, ever. It is only granted when an admin has enabled the
//     trial policy with a duration — there is no built-in default duration.
//   - A subscription payment is applied only after the gateway's own API
//     confirms it for this tran_id with the stored amount; applying is
//     idempotent (conditional PENDING→PAID + unique period.paymentId).
//   - The order-linked Payment model is never touched.

import { Prisma } from "@prisma/client";
import { randomInt } from "node:crypto";
import { prisma, prismaDirect } from "../config/prisma.ts";
import { AppError } from "../middlewares/error.middleware.ts";
import {
  POS_POLICY_KEYS,
  evaluateEntitlement,
  extendFrom,
  normalizeAmount,
  parsePosPolicy,
  sameAmount,
  validatePolicyInput,
  type Entitlement,
  type PosPolicy,
} from "../modules/pos-subscription/entitlement.ts";
import { paymentGatewayService } from "./payment-gateway.service.ts";
import { paymentService, sslcommerzValidationMismatch } from "./payment.service.ts";
import { epsService } from "./eps.service.ts";
import { paystationService } from "./paystation.service.ts";

type Tx = Prisma.TransactionClient;

export interface PosActorUser {
  rawId: string; // User.id
  role: string;
}

export type EnforcementMode = "enforce" | "monitor";

/** Fail closed unless monitor-only rollout is explicitly switched on. */
export function enforcementMode(raw: unknown = process.env.POS_SUBSCRIPTION_ENFORCEMENT): EnforcementMode {
  return String(raw ?? "").trim().toLowerCase() === "monitor" ? "monitor" : "enforce";
}

const ENVIRONMENT = process.env.NODE_ENV === "production" ? "PRODUCTION" : "SANDBOX";
const SUPPORTED_GATEWAYS = ["SSLCOMMERZ", "EPS", "PAYSTATION"] as const;
type Gateway = (typeof SUPPORTED_GATEWAYS)[number];
export type CallbackOutcome = "paid" | "failed" | "cancelled" | "pending" | "unknown";

const reasonOf = (v: unknown): string => {
  if (typeof v !== "string" || v.trim().length < 3) throw new AppError("A reason (at least 3 characters) is required", 400);
  if (v.trim().length > 500) throw new AppError("Reason is too long (max 500)", 400);
  return v.trim();
};

function snapshot(s: { status?: string; source?: string; expiresAt?: Date | null; planId?: string | null } | null) {
  if (!s) return Prisma.JsonNull;
  return { status: s.status ?? null, source: s.source ?? null, expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null, planId: s.planId ?? null };
}

// Small in-process cache: the policy is read on every POS request.
let policyCache: { at: number; value: PosPolicy } | null = null;
const POLICY_TTL_MS = 30_000;

export class PosSubscriptionService {
  // ─── policy ──────────────────────────────────────────────────────────────

  async getPolicy(db: Tx | typeof prisma = prisma, { fresh = false } = {}): Promise<PosPolicy> {
    if (!fresh && db === prisma && policyCache && Date.now() - policyCache.at < POLICY_TTL_MS) return policyCache.value;
    const rows = await db.platformSettings.findMany({ where: { key: { in: Object.values(POS_POLICY_KEYS) } } });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const value = parsePosPolicy({
      trialEnabled: byKey.get(POS_POLICY_KEYS.trialEnabled),
      trialDays: byKey.get(POS_POLICY_KEYS.trialDays),
      graceDays: byKey.get(POS_POLICY_KEYS.graceDays),
    });
    if (db === prisma) policyCache = { at: Date.now(), value };
    return value;
  }

  async setPolicy(input: unknown, actor: PosActorUser): Promise<PosPolicy> {
    const v = validatePolicyInput(input);
    if (!v.ok) throw new AppError(v.message, 400);
    const before = await this.getPolicy(prisma, { fresh: true });
    await prismaDirect.$transaction(async (tx) => {
      const write = (key: string, value: string, note: string) =>
        tx.platformSettings.upsert({ where: { key }, update: { value, note }, create: { key, value, note } });
      await write(POS_POLICY_KEYS.trialEnabled, String(v.value.trialEnabled), "Automatic POS trial on vendor approval");
      await write(POS_POLICY_KEYS.trialDays, v.value.trialDays === null ? "" : String(v.value.trialDays), "POS trial length (days)");
      await write(POS_POLICY_KEYS.graceDays, String(v.value.graceDays), "POS grace period after expiry (days)");
      await tx.auditLog.create({
        data: { action: "POS_POLICY_UPDATED", entity: "PlatformSettings", entityId: "pos.policy", oldData: before as any, newData: v.value as any, userId: actor.rawId },
      });
    });
    policyCache = null;
    return this.getPolicy(prisma, { fresh: true });
  }

  // ─── entitlement ─────────────────────────────────────────────────────────

  async entitlementFor(vendorId: string, now = new Date()): Promise<Entitlement> {
    const [sub, policy] = await Promise.all([
      prisma.posSubscription.findUnique({ where: { vendorId }, select: { status: true, source: true, expiresAt: true } }),
      this.getPolicy(),
    ]);
    return evaluateEntitlement(sub, now, policy.graceDays);
  }

  /** What the vendor (and its POS UI) may see about its own subscription. */
  async getVendorStatus(vendorId: string, now = new Date()) {
    const [sub, policy] = await Promise.all([
      prisma.posSubscription.findUnique({
        where: { vendorId },
        select: {
          status: true, source: true, expiresAt: true, startedAt: true, lastPaymentAt: true, suspendedAt: true,
          currentPlan: { select: { id: true, code: true, name: true, price: true, currency: true, durationDays: true } },
        },
      }),
      this.getPolicy(),
    ]);
    const entitlement = evaluateEntitlement(sub, now, policy.graceDays);
    return {
      entitlement,
      enforcement: enforcementMode(),
      subscription: sub
        ? {
            status: sub.status,
            source: sub.source,
            startedAt: sub.startedAt,
            expiresAt: sub.expiresAt,
            lastPaymentAt: sub.lastPaymentAt,
            suspended: !!sub.suspendedAt,
            plan: sub.currentPlan ? { ...sub.currentPlan, price: sub.currentPlan.price.toFixed(2) } : null,
          }
        : null,
      graceDays: policy.graceDays,
    };
  }

  // ─── one-time trial (called INSIDE the vendor approval transactions) ─────

  /**
   * Grants the automatic trial at most once per vendor:
   *   - policy off (the default) → nothing, and no new table is touched;
   *   - vendor already has a subscription row (admin grant / payment /
   *     legacy) → nothing;
   *   - PosTrialGrant insert with ON CONFLICT DO NOTHING decides the winner —
   *     re-approval, rejection → re-verification and concurrent approvals all
   *     find the existing grant and do nothing.
   * Timestamps are server-side; the trial length is the policy at grant time.
   */
  async grantTrialOnApproval(tx: Tx, vendorId: string, trigger: "VENDOR_APPROVAL" | "VENDOR_VERIFICATION", now = new Date()) {
    const policy = await this.getPolicy(tx, { fresh: true });
    if (!policy.trialEnabled || !policy.trialDays) return { granted: false as const, reason: "trial-disabled" };

    const existingSub = await tx.posSubscription.findUnique({ where: { vendorId }, select: { id: true } });
    if (existingSub) return { granted: false as const, reason: "has-subscription" };

    const endsAt = extendFrom(null, now, policy.trialDays);
    const inserted = await tx.posTrialGrant.createMany({
      data: [{ vendorId, grantedAt: now, endsAt, days: policy.trialDays, trigger }],
      skipDuplicates: true,
    });
    if (inserted.count !== 1) return { granted: false as const, reason: "already-granted" };

    const sub = await tx.posSubscription.create({
      data: { vendorId, plan: "TRIAL", status: "ACTIVE", source: "TRIAL", startedAt: now, expiresAt: endsAt, version: 1 },
    });
    await tx.posSubscriptionPeriod.create({
      data: {
        subscriptionId: sub.id, vendorId, kind: "TRIAL", previousStatus: null, newStatus: "ACTIVE",
        previousExpiresAt: null, newExpiresAt: endsAt, actorRole: "SYSTEM", reason: `Automatic ${policy.trialDays}-day trial (${trigger})`,
        meta: { days: policy.trialDays, trigger },
      },
    });
    return { granted: true as const, endsAt };
  }

  // ─── admin lifecycle ─────────────────────────────────────────────────────

  private async mutate(
    vendorId: string,
    actor: PosActorUser,
    kind: "GRANT" | "EXTEND" | "REVOKE" | "SUSPEND" | "RESTORE",
    reason: string,
    compute: (sub: Prisma.PosSubscriptionGetPayload<{}> | null, now: Date, tx: Tx) => Promise<Prisma.PosSubscriptionUncheckedUpdateInput & { meta?: Record<string, unknown> }>,
  ) {
    return prismaDirect.$transaction(async (tx) => {
      const vendor = await tx.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
      if (!vendor) throw new AppError("Vendor not found", 404);
      const sub = await tx.posSubscription.findUnique({ where: { vendorId } });
      const now = new Date();
      const { meta, ...data } = await compute(sub, now, tx);

      let saved;
      if (!sub) {
        try {
          saved = await tx.posSubscription.create({ data: { ...(data as any), vendorId, startedAt: now, version: 1 } });
        } catch (err: any) {
          if (err?.code === "P2002") throw new AppError("The subscription changed meanwhile — reload and try again", 409);
          throw err;
        }
      } else {
        const upd = await tx.posSubscription.updateMany({
          where: { id: sub.id, version: sub.version },
          data: { ...(data as any), version: { increment: 1 } },
        });
        if (upd.count !== 1) throw new AppError("The subscription changed meanwhile — reload and try again", 409);
        saved = await tx.posSubscription.findUniqueOrThrow({ where: { id: sub.id } });
      }

      await tx.posSubscriptionPeriod.create({
        data: {
          subscriptionId: saved.id,
          vendorId,
          kind,
          previousStatus: sub?.status ?? null,
          newStatus: saved.status,
          previousExpiresAt: sub?.expiresAt ?? null,
          newExpiresAt: saved.expiresAt,
          planId: saved.planId,
          actorUserId: actor.rawId,
          actorRole: actor.role,
          reason,
          meta: (meta ?? undefined) as any,
        },
      });
      await tx.auditLog.create({
        data: {
          action: `POS_SUBSCRIPTION_${kind}`,
          entity: "PosSubscription",
          entityId: saved.id,
          oldData: snapshot(sub as any),
          newData: snapshot(saved as any),
          userId: actor.rawId,
        },
      });
      return saved;
    });
  }

  /** Complimentary access until a future date, or open-ended (until = null). */
  async grant(vendorId: string, input: { until?: unknown; reason?: unknown }, actor: PosActorUser) {
    const reason = reasonOf(input?.reason);
    let until: Date | null = null;
    if (input?.until !== null && input?.until !== undefined && input?.until !== "") {
      until = new Date(String(input.until));
      if (!Number.isFinite(until.getTime())) throw new AppError("until must be a valid date", 400);
    }
    return this.mutate(vendorId, actor, "GRANT", reason, async (sub, now) => {
      if (until && until.getTime() <= now.getTime() + 60_000) throw new AppError("until must be in the future", 400);
      if (sub?.status === "SUSPENDED") throw new AppError("This subscription is suspended — restore it first", 409);
      return { status: "ACTIVE", source: "COMPLIMENTARY", expiresAt: until, suspendedAt: null, suspendedReason: null, meta: { openEnded: !until } };
    });
  }

  async extend(vendorId: string, input: { days?: unknown; reason?: unknown }, actor: PosActorUser) {
    const reason = reasonOf(input?.reason);
    const days = Number(input?.days);
    if (!Number.isInteger(days) || days < 1 || days > 3660) throw new AppError("days must be a whole number between 1 and 3660", 400);
    return this.mutate(vendorId, actor, "EXTEND", reason, async (sub, now) => {
      if (!sub) throw new AppError("This vendor has no POS subscription — grant access instead", 409);
      if (!sub.expiresAt && (sub.source === "COMPLIMENTARY" || sub.source === "LEGACY") && sub.status !== "CANCELLED") {
        throw new AppError("Access is open-ended — nothing to extend", 409);
      }
      const from = sub.status === "CANCELLED" ? null : sub.expiresAt;
      return {
        expiresAt: extendFrom(from, now, days),
        status: sub.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
        meta: { days },
      };
    });
  }

  async revoke(vendorId: string, input: { reason?: unknown }, actor: PosActorUser) {
    const reason = reasonOf(input?.reason);
    return this.mutate(vendorId, actor, "REVOKE", reason, async (sub, now) => {
      if (!sub) throw new AppError("This vendor has no POS subscription", 409);
      if (sub.status === "CANCELLED") throw new AppError("Access is already revoked", 409);
      const end = !sub.expiresAt || sub.expiresAt.getTime() > now.getTime() ? now : sub.expiresAt;
      return { status: "CANCELLED", expiresAt: end, suspendedAt: null, suspendedReason: null };
    });
  }

  async suspend(vendorId: string, input: { reason?: unknown }, actor: PosActorUser) {
    const reason = reasonOf(input?.reason);
    return this.mutate(vendorId, actor, "SUSPEND", reason, async (sub, now) => {
      if (!sub) throw new AppError("This vendor has no POS subscription", 409);
      if (sub.status === "SUSPENDED") throw new AppError("Already suspended", 409);
      return { status: "SUSPENDED", suspendedAt: now, suspendedReason: reason };
    });
  }

  /** Back to the status it had before the suspension (a revoked one stays revoked). */
  async restore(vendorId: string, input: { reason?: unknown }, actor: PosActorUser) {
    const reason = reasonOf(input?.reason);
    return this.mutate(vendorId, actor, "RESTORE", reason, async (sub, _now, tx) => {
      if (!sub || sub.status !== "SUSPENDED") throw new AppError("This subscription is not suspended", 409);
      const lastSuspend = await tx.posSubscriptionPeriod.findFirst({
        where: { subscriptionId: sub.id, kind: "SUSPEND" },
        orderBy: { createdAt: "desc" },
        select: { previousStatus: true },
      });
      const prev = lastSuspend?.previousStatus;
      const status = prev === "CANCELLED" ? "CANCELLED" : "ACTIVE";
      return { status, suspendedAt: null, suspendedReason: null, meta: { restoredTo: status } };
    });
  }

  // ─── admin reads ─────────────────────────────────────────────────────────

  async listForAdmin(q: { search?: unknown; status?: unknown; hasSubscription?: unknown; page?: unknown; limit?: unknown }, now = new Date()) {
    const page = Math.max(1, parseInt(String(q.page ?? "1"), 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(String(q.limit ?? "20"), 10) || 20), 100);
    const search = typeof q.search === "string" ? q.search.trim().slice(0, 100) : "";
    const status = ["ACTIVE", "EXPIRED", "CANCELLED", "SUSPENDED"].includes(String(q.status)) ? String(q.status) : null;
    const where: Prisma.VendorWhereInput = {
      ...(search ? { OR: [{ storeName: { contains: search, mode: "insensitive" } }, { email: { contains: search, mode: "insensitive" } }] } : {}),
      ...(q.hasSubscription === "no" ? { posSubscription: { is: null } } : {}),
      ...(q.hasSubscription === "yes" || status ? { posSubscription: { is: status ? { status: status as any } : {} } } : {}),
    };
    const [rows, total, policy] = await Promise.all([
      prisma.vendor.findMany({
        where,
        select: {
          id: true, storeName: true, email: true, status: true, verifiedAt: true,
          posSubscription: { select: { status: true, source: true, expiresAt: true, lastPaymentAt: true, currentPlan: { select: { name: true } } } },
          posTrialGrant: { select: { grantedAt: true, endsAt: true, days: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.vendor.count({ where }),
      this.getPolicy(),
    ]);
    return {
      data: rows.map((v) => ({
        vendorId: v.id,
        storeName: v.storeName,
        email: v.email,
        vendorStatus: v.status,
        subscription: v.posSubscription,
        trial: v.posTrialGrant,
        entitlement: evaluateEntitlement(v.posSubscription, now, policy.graceDays),
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async detailForAdmin(vendorId: string, now = new Date()) {
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, storeName: true, email: true, status: true, verifiedAt: true, posTrialGrant: true },
    });
    if (!vendor) throw new AppError("Vendor not found", 404);
    const [sub, payments, policy] = await Promise.all([
      prisma.posSubscription.findUnique({
        where: { vendorId },
        include: { currentPlan: true, periods: { orderBy: { createdAt: "desc" }, take: 100 } },
      }),
      prisma.posSubscriptionPayment.findMany({
        where: { vendorId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true, tranId: true, amount: true, currency: true, durationDays: true, status: true, gateway: true,
          createdAt: true, verifiedAt: true, appliedAt: true, failureReason: true, plan: { select: { name: true, code: true } },
        },
      }),
      this.getPolicy(),
    ]);
    return {
      vendor,
      subscription: sub,
      entitlement: evaluateEntitlement(sub, now, policy.graceDays),
      payments: payments.map((p) => ({ ...p, amount: p.amount.toFixed(2) })),
    };
  }

  // ─── plans ───────────────────────────────────────────────────────────────

  async listPlans({ includeInactive = false } = {}) {
    const plans = await prisma.posPlan.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return plans.map((p) => ({ ...p, price: p.price.toFixed(2) }));
  }

  private planData(input: Record<string, unknown>, partial: boolean) {
    const out: Record<string, unknown> = {};
    if (!partial || "code" in input) {
      const code = String(input.code ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9_]{2,32}$/.test(code)) throw new AppError("code: 2–32 letters, digits or underscores", 400);
      out.code = code;
    }
    if (!partial || "name" in input) {
      const name = String(input.name ?? "").trim();
      if (name.length < 2 || name.length > 80) throw new AppError("name must be 2–80 characters", 400);
      out.name = name;
    }
    if ("description" in input) {
      const d = input.description === null ? null : String(input.description ?? "").trim();
      if (d && d.length > 500) throw new AppError("description is too long", 400);
      out.description = d || null;
    }
    if (!partial || "price" in input) {
      const amount = normalizeAmount(input.price);
      if (!amount) throw new AppError("price must be a positive amount with at most 2 decimals", 400);
      out.price = new Prisma.Decimal(amount);
    }
    if ("currency" in input && input.currency !== "BDT") throw new AppError("Only BDT plans are supported by the configured gateways", 400);
    if (!partial || "durationDays" in input) {
      const d = Number(input.durationDays);
      if (!Number.isInteger(d) || d < 1 || d > 3660) throw new AppError("durationDays must be a whole number between 1 and 3660", 400);
      out.durationDays = d;
    }
    if ("isActive" in input) {
      if (typeof input.isActive !== "boolean") throw new AppError("isActive must be true or false", 400);
      out.isActive = input.isActive;
    }
    if ("sortOrder" in input) {
      const s = Number(input.sortOrder);
      if (!Number.isInteger(s) || s < 0 || s > 1000) throw new AppError("sortOrder must be 0–1000", 400);
      out.sortOrder = s;
    }
    return out;
  }

  async createPlan(input: Record<string, unknown>, actor: PosActorUser) {
    const data = this.planData(input ?? {}, false);
    return prismaDirect.$transaction(async (tx) => {
      let plan;
      try {
        plan = await tx.posPlan.create({ data: { ...(data as any), currency: "BDT" } });
      } catch (err: any) {
        if (err?.code === "P2002") throw new AppError("A plan with this code already exists", 409);
        throw err;
      }
      await tx.auditLog.create({ data: { action: "POS_PLAN_CREATED", entity: "PosPlan", entityId: plan.id, newData: { ...plan, price: plan.price.toFixed(2) } as any, userId: actor.rawId } });
      return { ...plan, price: plan.price.toFixed(2) };
    });
  }

  async updatePlan(planId: string, input: Record<string, unknown>, actor: PosActorUser) {
    const data = this.planData(input ?? {}, true);
    if ("code" in data) throw new AppError("A plan's code can't be changed", 400);
    return prismaDirect.$transaction(async (tx) => {
      const before = await tx.posPlan.findUnique({ where: { id: planId } });
      if (!before) throw new AppError("Plan not found", 404);
      const plan = await tx.posPlan.update({ where: { id: planId }, data: data as any });
      await tx.auditLog.create({
        data: {
          action: "POS_PLAN_UPDATED", entity: "PosPlan", entityId: plan.id,
          oldData: { ...before, price: before.price.toFixed(2) } as any, newData: { ...plan, price: plan.price.toFixed(2) } as any, userId: actor.rawId,
        },
      });
      return { ...plan, price: plan.price.toFixed(2) };
    });
  }

  // ─── vendor checkout ─────────────────────────────────────────────────────

  async listVendorPayments(vendorId: string) {
    const rows = await prisma.posSubscriptionPayment.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, tranId: true, amount: true, currency: true, durationDays: true, status: true, gateway: true, createdAt: true, appliedAt: true, plan: { select: { name: true } } },
    });
    return rows.map((r) => ({ ...r, amount: r.amount.toFixed(2) }));
  }

  /**
   * Vendor OWNER buys a plan. Amount and duration come from the plan row and
   * are snapshotted on the payment; nothing price-related is read from the
   * client. Returns the gateway's hosted page URL.
   */
  async startCheckout(vendorId: string, user: { rawId: string }, planIdRaw: unknown) {
    if (typeof planIdRaw !== "string" || !planIdRaw) throw new AppError("planId is required", 400);
    const [plan, sub, vendor] = await Promise.all([
      prisma.posPlan.findFirst({ where: { id: planIdRaw, isActive: true } }),
      prisma.posSubscription.findUnique({ where: { vendorId }, select: { status: true, source: true, expiresAt: true } }),
      prisma.vendor.findUnique({ where: { id: vendorId }, select: { storeName: true, email: true, user: { select: { phone: true, email: true } } } }),
    ]);
    if (!plan) throw new AppError("Plan not found", 404);
    if (plan.currency !== "BDT") throw new AppError("This plan's currency isn't supported", 409);
    if (!vendor) throw new AppError("Vendor not found", 404);
    if (sub?.status === "SUSPENDED") throw new AppError("Your POS access is suspended — contact FinixMart support", 409);
    if (sub && !sub.expiresAt && sub.status === "ACTIVE" && (sub.source === "COMPLIMENTARY" || sub.source === "LEGACY")) {
      throw new AppError("Your POS access is already open-ended — no payment needed", 409);
    }

    const recentPending = await prisma.posSubscriptionPayment.count({
      where: { vendorId, status: "PENDING", createdAt: { gte: new Date(Date.now() - 30 * 60_000) } },
    });
    if (recentPending >= 5) throw new AppError("Too many unfinished payment attempts — please wait a few minutes", 429);

    const { provider, credential } = await paymentGatewayService.getActiveProvider();
    const gateway = provider.name.toUpperCase() as Gateway;
    if (!SUPPORTED_GATEWAYS.includes(gateway)) throw new AppError(`Gateway ${provider.name} can't take subscription payments yet`, 409);

    const digits = `${Date.now()}${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
    const tranId = gateway === "EPS" ? digits : `POSSUB${digits}`;
    const amount = plan.price.toFixed(2);

    const payment = await prisma.posSubscriptionPayment.create({
      data: {
        vendorId, planId: plan.id, amount: plan.price, currency: "BDT", durationDays: plan.durationDays,
        status: "PENDING", gateway, paymentProviderId: provider.id, tranId, initiatedByUserId: user.rawId,
      },
    });

    const backend = (process.env.BACKEND_URL ?? "").replace(/\/+$/, "");
    if (!backend) throw new AppError("BACKEND_URL is not configured", 503);
    const productName = `FinixMart POS — ${plan.name}`;
    try {
      let redirectUrl: string;
      if (gateway === "SSLCOMMERZ") {
        const r = await paymentService.createExternalSslcommerzSession({
          tranId, amount, productName, callbackBase: `${backend}/api/pos-billing/sslcommerz`,
          customer: { name: vendor.storeName ?? "Vendor", email: (vendor.email ?? vendor.user?.email) ?? "", phone: vendor.user?.phone ?? "" }, reference: payment.id,
        });
        redirectUrl = r.gatewayPageURL;
      } else if (gateway === "EPS") {
        const r = await epsService.initializePayment(provider as any, credential as any, {
          customerOrderId: payment.id, merchantTransactionId: tranId, transactionTypeId: 1, totalAmount: Number(amount),
          successUrl: `${backend}/api/pos-billing/eps/success`, failUrl: `${backend}/api/pos-billing/eps/fail`, cancelUrl: `${backend}/api/pos-billing/eps/cancel`,
          customerName: vendor.storeName ?? "Vendor", customerEmail: (vendor.email ?? vendor.user?.email) ?? "vendor@example.com", customerAddress: "Dhaka", customerCity: "Dhaka",
          customerState: "Dhaka", customerPostcode: "1000", customerCountry: "Bangladesh", customerPhone: vendor.user?.phone ?? "01700000000",
          productName, ipAddress: "0.0.0.0",
        });
        redirectUrl = r.redirectUrl;
      } else {
        const r = await paystationService.initializePayment(provider as any, credential as any, {
          invoiceNumber: tranId, amount: Number(amount), customerName: vendor.storeName ?? "Vendor",
          customerPhone: vendor.user?.phone ?? "01700000000", customerEmail: (vendor.email ?? vendor.user?.email) ?? "vendor@example.com",
          callbackUrl: `${backend}/api/pos-billing/paystation/callback`, reference: payment.id, checkoutItems: productName,
        });
        redirectUrl = r.paymentUrl;
      }
      return { tranId, redirectUrl, amount, currency: "BDT", plan: { id: plan.id, name: plan.name, durationDays: plan.durationDays } };
    } catch (err: any) {
      await prisma.posSubscriptionPayment.updateMany({
        where: { id: payment.id, status: "PENDING" },
        data: { status: "FAILED", failureReason: `initiation: ${String(err?.message ?? err).slice(0, 300)}` },
      });
      throw new AppError("The payment gateway could not start the payment. Please try again.", 502);
    }
  }

  // ─── verified callbacks ──────────────────────────────────────────────────

  private async credentialFor(paymentProviderId: string | null) {
    if (!paymentProviderId) return null;
    const provider = await prisma.paymentProvider.findUnique({
      where: { id: paymentProviderId },
      include: { payment_credentials: { where: { environment: ENVIRONMENT as any } } },
    });
    const credential = provider?.payment_credentials?.[0];
    return provider && credential ? { provider, credential } : null;
  }

  /**
   * Every callback (IPN, success/fail/cancel redirects, PayStation callback)
   * lands here. The posted status is only a claim: the gateway's API decides.
   */
  async handleCallback(gateway: Gateway, tranIdRaw: unknown, opts: { valId?: unknown } = {}): Promise<CallbackOutcome> {
    const tranId = typeof tranIdRaw === "string" ? tranIdRaw.trim() : "";
    if (!tranId || tranId.length > 64) return "unknown";
    const payment = await prisma.posSubscriptionPayment.findUnique({ where: { tranId } });
    if (!payment || payment.gateway !== gateway) return "unknown";
    if (payment.status === "PAID") return "paid";
    const amount = payment.amount.toFixed(2);

    if (gateway === "SSLCOMMERZ") {
      let valId = typeof opts.valId === "string" && opts.valId ? opts.valId : null;
      if (!valId) {
        const outcome = await paymentService.verifiedSslcommerzOutcome(tranId);
        if (outcome.kind === "PAID") valId = outcome.valId;
        else if (outcome.kind === "FAILED" || outcome.kind === "CANCELLED") return this.markUnpaid(payment.id, outcome.kind, "Confirmed by SSLCommerz");
        else return "pending";
      }
      let validation: any;
      try {
        validation = await paymentService.validatePayment(valId);
      } catch {
        return "pending";
      }
      const mismatch = sslcommerzValidationMismatch(validation, { tranId, amount });
      if (mismatch) {
        await this.noteMismatch(payment.id, mismatch);
        return "pending";
      }
      return this.applyPaid(tranId, String(validation.bank_tran_id ?? valId), { gateway, val_id: valId, amount: validation.amount, currency: validation.currency });
    }

    const creds = await this.credentialFor(payment.paymentProviderId);
    if (!creds) return "pending";

    if (gateway === "EPS") {
      let r;
      try {
        r = await epsService.checkTransactionStatus(creds.provider as any, creds.credential as any, tranId);
      } catch {
        return "pending";
      }
      if (r.status === "Success") {
        if (!sameAmount(r.totalAmount, amount)) {
          await this.noteMismatch(payment.id, `amount ${r.totalAmount} does not match ${amount}`);
          return "pending";
        }
        return this.applyPaid(tranId, null, { gateway, status: r.status, amount: r.totalAmount });
      }
      if (r.status === "Failed" || r.status === "Cancelled") return this.markUnpaid(payment.id, r.status === "Failed" ? "FAILED" : "CANCELLED", `EPS: ${r.status}`);
      return "pending";
    }

    // PAYSTATION
    let r;
    try {
      r = await paystationService.checkTransactionStatus(creds.provider as any, creds.credential as any, tranId);
    } catch {
      return "pending";
    }
    if (r.status === "success") {
      if (!sameAmount(r.paymentAmount, amount)) {
        await this.noteMismatch(payment.id, `amount ${r.paymentAmount} does not match ${amount}`);
        return "pending";
      }
      return this.applyPaid(tranId, r.trxId, { gateway, status: r.status, amount: r.paymentAmount, method: r.paymentMethod });
    }
    if (r.status === "failed") return this.markUnpaid(payment.id, "FAILED", "PayStation: failed");
    return "pending";
  }

  private async noteMismatch(paymentId: string, why: string) {
    // Money may have moved but doesn't match this attempt: leave it PENDING for
    // manual reconciliation and record why. Never applied automatically.
    await prisma.posSubscriptionPayment.updateMany({
      where: { id: paymentId, status: "PENDING" },
      data: { failureReason: `verification mismatch: ${why}`.slice(0, 500) },
    });
  }

  private async markUnpaid(paymentId: string, status: "FAILED" | "CANCELLED", why: string): Promise<CallbackOutcome> {
    // Only ever PENDING → FAILED/CANCELLED; a paid payment is never downgraded.
    await prisma.posSubscriptionPayment.updateMany({
      where: { id: paymentId, status: "PENDING" },
      data: { status, failureReason: why.slice(0, 500) },
    });
    return status === "FAILED" ? "failed" : "cancelled";
  }

  /**
   * Idempotent: the conditional PENDING→PAID flip and the unique
   * period.paymentId each stop a double apply. A concurrent subscription
   * change (version conflict) rolls the attempt back and is retried, so a
   * VERIFIED payment is not left pending just because an admin acted at the
   * same moment. If every attempt conflicts, the payment stays PENDING and the
   * next callback (or a manual reconcile) applies it.
   */
  async applyPaid(tranId: string, gatewayRef: string | null, verification: Record<string, unknown>): Promise<CallbackOutcome> {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const outcome = await this.applyPaidOnce(tranId, gatewayRef, verification);
      if (outcome !== "conflict") return outcome;
    }
    return "pending";
  }

  private async applyPaidOnce(tranId: string, gatewayRef: string | null, verification: Record<string, unknown>): Promise<CallbackOutcome | "conflict"> {
    try {
      return await prismaDirect.$transaction(async (tx) => {
        const p = await tx.posSubscriptionPayment.findUnique({ where: { tranId } });
        if (!p) return "unknown" as const;
        if (p.status === "PAID") return "paid" as const;
        const now = new Date();
        const flipped = await tx.posSubscriptionPayment.updateMany({
          where: { id: p.id, status: { in: ["PENDING", "FAILED", "CANCELLED"] } },
          data: { status: "PAID", verifiedAt: now, appliedAt: now, gatewayRef, verification: verification as any, failureReason: null },
        });
        if (flipped.count !== 1) return "paid" as const;

        const sub = await tx.posSubscription.findUnique({ where: { vendorId: p.vendorId } });
        const openEnded = !!sub && !sub.expiresAt && sub.status === "ACTIVE" && (sub.source === "COMPLIMENTARY" || sub.source === "LEGACY");
        const newExpiresAt = openEnded ? null : extendFrom(sub && sub.status !== "CANCELLED" ? sub.expiresAt : null, now, p.durationDays);
        const status = sub?.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE";

        let saved;
        if (!sub) {
          saved = await tx.posSubscription.create({
            data: { vendorId: p.vendorId, status, source: "PAID", startedAt: now, expiresAt: newExpiresAt, planId: p.planId, lastPaymentAt: now, version: 1 },
          });
        } else {
          const upd = await tx.posSubscription.updateMany({
            where: { id: sub.id, version: sub.version },
            data: {
              status,
              ...(openEnded ? {} : { source: "PAID", expiresAt: newExpiresAt }),
              planId: p.planId,
              lastPaymentAt: now,
              version: { increment: 1 },
            },
          });
          if (upd.count !== 1) throw new AppError("Subscription changed concurrently", 409); // rolls back; the next callback retries
          saved = await tx.posSubscription.findUniqueOrThrow({ where: { id: sub.id } });
        }
        await tx.posSubscriptionPeriod.create({
          data: {
            subscriptionId: saved.id, vendorId: p.vendorId, kind: "PAYMENT", previousStatus: sub?.status ?? null, newStatus: saved.status,
            previousExpiresAt: sub?.expiresAt ?? null, newExpiresAt: saved.expiresAt, planId: p.planId, paymentId: p.id,
            actorRole: "SYSTEM", reason: `Payment ${p.tranId} (${p.amount.toFixed(2)} ${p.currency}, ${p.durationDays} days)`,
            meta: openEnded ? { note: "open-ended access kept; payment recorded without changing the end date" } : undefined,
          },
        });
        await tx.auditLog.create({
          data: { action: "POS_SUBSCRIPTION_PAYMENT_APPLIED", entity: "PosSubscription", entityId: saved.id, oldData: snapshot(sub as any), newData: snapshot(saved as any) },
        });
        return "paid" as const;
      });
    } catch (err: any) {
      if (err instanceof AppError && err.statusCode === 409) return "conflict";
      // Unique violation (period.paymentId, or the subscription row created by
      // a concurrent grant): retry — an already-applied payment then returns "paid".
      if (err?.code === "P2002") return "conflict";
      throw err;
    }
  }

  // ─── jobs ────────────────────────────────────────────────────────────────

  /** Tidy `status` for rows whose access (incl. grace) has ended. Access never depends on this. */
  async runExpirySweep(now = new Date(), batch = 200): Promise<number> {
    const policy = await this.getPolicy(prisma, { fresh: true });
    const cutoff = new Date(now.getTime() - policy.graceDays * 86_400_000);
    const due = await prisma.posSubscription.findMany({
      where: { status: "ACTIVE", expiresAt: { lt: cutoff } },
      select: { id: true, vendorId: true, version: true, expiresAt: true },
      take: batch,
    });
    let n = 0;
    for (const s of due) {
      await prismaDirect.$transaction(async (tx) => {
        const upd = await tx.posSubscription.updateMany({ where: { id: s.id, version: s.version, status: "ACTIVE" }, data: { status: "EXPIRED", version: { increment: 1 } } });
        if (upd.count !== 1) return;
        n++;
        await tx.posSubscriptionPeriod.create({
          data: { subscriptionId: s.id, vendorId: s.vendorId, kind: "EXPIRE", previousStatus: "ACTIVE", newStatus: "EXPIRED", previousExpiresAt: s.expiresAt, newExpiresAt: s.expiresAt, actorRole: "SYSTEM", reason: "Expiry sweep" },
        });
      });
    }
    return n;
  }

  /** One in-app reminder per vendor per end date, within `days` of expiry. */
  async runRenewalReminders(now = new Date(), days = 7, batch = 200): Promise<number> {
    const soon = new Date(now.getTime() + days * 86_400_000);
    const rows = await prisma.posSubscription.findMany({
      where: { status: "ACTIVE", expiresAt: { gt: now, lte: soon } },
      select: { id: true, vendorId: true, expiresAt: true, reminderSentFor: true },
      take: batch,
    });
    let n = 0;
    for (const s of rows) {
      if (!s.expiresAt || (s.reminderSentFor && s.reminderSentFor.getTime() === s.expiresAt.getTime())) continue;
      const claimed = await prisma.posSubscription.updateMany({
        where: { id: s.id, expiresAt: s.expiresAt, OR: [{ reminderSentFor: null }, { reminderSentFor: { not: s.expiresAt } }] },
        data: { reminderSentFor: s.expiresAt },
      });
      if (claimed.count !== 1) continue;
      const left = Math.max(1, Math.ceil((s.expiresAt.getTime() - now.getTime()) / 86_400_000));
      await prisma.notification.create({
        data: {
          type: "SYSTEM",
          title: "POS subscription ending soon",
          message: `Your FinixMart POS access ends in ${left} day${left === 1 ? "" : "s"}. Renew to keep selling.`,
          targetType: "VENDOR",
          targetId: s.vendorId,
          actionUrl: "/vendor-dashboard/pos-billing",
        },
      });
      n++;
    }
    return n;
  }

  // ─── rollout tooling (read-only) ─────────────────────────────────────────

  /**
   * Dry-run: what enforcement WOULD do to every vendor today. Reads only.
   * Vendors with POS activity but no subscription are the ones a LEGACY
   * backfill would cover; nothing is written here.
   */
  async rolloutDryRun(now = new Date()) {
    const policy = await this.getPolicy(prisma, { fresh: true });
    const vendors = await prisma.vendor.findMany({
      select: {
        id: true, storeName: true, status: true,
        posSubscription: { select: { status: true, source: true, expiresAt: true } },
        _count: { select: { posSales: true, posStaff: true } },
        posSettings: { select: { id: true } },
      },
    });
    const rows = vendors.map((v) => {
      const e = evaluateEntitlement(v.posSubscription, now, policy.graceDays);
      const usesPos = v._count.posSales > 0 || v._count.posStaff > 0 || !!v.posSettings;
      return {
        vendorId: v.id, storeName: v.storeName, vendorStatus: v.status, usesPos,
        sales: v._count.posSales, legacyTerminalLogins: v._count.posStaff, state: e.state, wouldBlockOperations: !e.canOperate,
        proposedAction: !v.posSubscription && usesPos ? "LEGACY_BACKFILL" : !v.posSubscription ? "NONE (no POS use)" : "KEEP",
      };
    });
    return {
      generatedAt: now.toISOString(),
      enforcement: enforcementMode(),
      policy,
      totals: {
        vendors: rows.length,
        usingPos: rows.filter((r) => r.usesPos).length,
        wouldBeBlocked: rows.filter((r) => r.usesPos && r.wouldBlockOperations).length,
        legacyBackfillCandidates: rows.filter((r) => r.proposedAction === "LEGACY_BACKFILL").length,
      },
      rows,
    };
  }
}

export const posSubscriptionService = new PosSubscriptionService();
