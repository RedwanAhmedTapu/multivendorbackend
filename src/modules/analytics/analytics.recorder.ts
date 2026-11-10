// modules/analytics/analytics.recorder.ts
//
// Writes Business Advisor events. Every public function here is SAFE:
//   - it never throws and never changes the cart / checkout / order / payment
//     outcome — callers fire and forget (`void recorder.x(...)`);
//   - until the analytics migration is applied and the Prisma client is
//     regenerated, `db.analyticsEvent` is missing and recording is a no-op;
//   - vendorId / productId always come from the database rows passed in
//     (cart lines, order lines, validated products), never from a client;
//   - dedupKey + createMany({ skipDuplicates }) make retries, re-renders,
//     React Strict Mode double effects and repeated requests idempotent.

import { randomUUID } from "node:crypto";
import { prisma } from "../../config/prisma.ts";
import {
  dhakaDay,
  halfHourBucket,
  tenMinuteBucket,
  hashKey,
  toMinor,
  safeSource,
  type AnalyticsEventType,
  type CheckoutFailureReason,
} from "./analytics.contract.ts";

export interface EventRow {
  type: AnalyticsEventType;
  occurredAt: Date;
  day: Date;
  vendorId: string;
  productId: string;
  variantId: string | null;
  sessionKey: string;
  actorKey: string;
  groupKey: string | null;
  orderId: string | null;
  quantity: number | null;
  valueMinor: number | null;
  source: string | null;
  reason: string | null;
  dedupKey: string;
}

type Delegate = Record<string, (...args: any[]) => Promise<any>>;
export interface AnalyticsDb {
  analyticsEvent?: Delegate;
  carts: Delegate;
  cart_items: Delegate;
  product: Delegate;
}

/** Journey context taken from the request (see analytics.context.ts). */
export interface ActorContext {
  actorKey: string;
  sessionKey: string;
}

/** A cart / order line as read from the database. */
export interface Line {
  productId: string;
  variantId: string | null;
  vendorId: string;
  quantity?: number | null;
  valueMinor?: number | null;
  lineId?: string;
}

const base = (type: AnalyticsEventType, ctx: ActorContext, at: Date) => ({
  type,
  occurredAt: at,
  day: dhakaDay(at),
  sessionKey: ctx.sessionKey,
  actorKey: ctx.actorKey,
  groupKey: null as string | null,
  orderId: null as string | null,
  quantity: null as number | null,
  valueMinor: null as number | null,
  source: null as string | null,
  reason: null as string | null,
});

export function createAnalyticsRecorder(db: AnalyticsDb, deps: { now?: () => Date; log?: (m: string) => void } = {}) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.error(m));

  /** Store rows; returns how many were inserted (0 when analytics isn't set up or on error). */
  async function write(rows: EventRow[]): Promise<number> {
    if (!rows.length || !db.analyticsEvent?.createMany) return 0;
    try {
      const r = await db.analyticsEvent.createMany({ data: rows, skipDuplicates: true });
      return typeof r?.count === "number" ? r.count : rows.length;
    } catch (err: any) {
      // never the row contents — only the error kind
      log(`[analytics] write skipped: ${err?.code ?? err?.name ?? "error"}`);
      return 0;
    }
  }

  /** The signed-in customer's SELECTED cart lines (what checkout / place-order act on). */
  async function selectedCartLines(userId: string): Promise<Line[]> {
    const cart = await db.carts.findFirst({
      where: { userId },
      select: {
        cart_items: {
          where: { isSelected: true },
          select: { id: true, productId: true, variantId: true, quantity: true, products: { select: { vendorId: true } } },
        },
      },
    });
    return (cart?.cart_items ?? [])
      .filter((ci: any) => ci?.products?.vendorId)
      .map((ci: any) => ({ lineId: ci.id, productId: ci.productId, variantId: ci.variantId, vendorId: ci.products.vendorId, quantity: ci.quantity }));
  }

  /** A cart line as stored — read before it is removed. Null when missing / on error. */
  async function cartLine(itemId: string): Promise<Line | null> {
    try {
      const ci = await db.cart_items.findUnique({
        where: { id: itemId },
        select: { productId: true, variantId: true, quantity: true, products: { select: { vendorId: true } } },
      });
      return ci?.products?.vendorId ? { productId: ci.productId, variantId: ci.variantId, vendorId: ci.products.vendorId, quantity: ci.quantity } : null;
    } catch {
      return null;
    }
  }

  return {
    write,
    selectedCartLines,
    cartLine,

    /** PRODUCT_VIEW — products already validated (public, vendor from the database). */
    async productViews(ctx: ActorContext, products: { id: string; vendorId: string; source?: unknown }[]) {
      try {
        const at = now();
        const bucket = halfHourBucket(at);
        return await write(
          products.map((p) => ({
            ...base("PRODUCT_VIEW", ctx, at),
            vendorId: p.vendorId,
            productId: p.id,
            variantId: null,
            source: safeSource(p.source) ?? "PRODUCT_PAGE",
            dedupKey: `view:${ctx.sessionKey}:${p.id}:${bucket}`,
          }))
        );
      } catch {
        return 0;
      }
    },

    /** ADD_TO_CART — after the cart mutation succeeded (the returned cart line is the source of truth). */
    async addToCart(ctx: ActorContext, line: Line, source?: unknown) {
      try {
        const at = now();
        return await write([
          {
            ...base("ADD_TO_CART", ctx, at),
            vendorId: line.vendorId,
            productId: line.productId,
            variantId: line.variantId,
            quantity: line.quantity ?? null,
            source: safeSource(source) ?? "PRODUCT_PAGE",
            dedupKey: `atc:${randomUUID()}`, // every successful add is a real add
          },
        ]);
      } catch {
        return 0;
      }
    },

    async removeFromCart(ctx: ActorContext, line: Line) {
      try {
        const at = now();
        return await write([
          { ...base("REMOVE_FROM_CART", ctx, at), vendorId: line.vendorId, productId: line.productId, variantId: line.variantId, quantity: line.quantity ?? null, dedupKey: `rfc:${randomUUID()}` },
        ]);
      } catch {
        return 0;
      }
    },

    async quantityChanged(ctx: ActorContext, line: Line) {
      try {
        const at = now();
        return await write([
          { ...base("CART_QUANTITY_CHANGED", ctx, at), vendorId: line.vendorId, productId: line.productId, variantId: line.variantId, quantity: line.quantity ?? null, dedupKey: `cqc:${randomUUID()}` },
        ]);
      } catch {
        return 0;
      }
    },

    /**
     * CHECKOUT_STARTED — the customer opened checkout with these selected
     * lines. One logical start per actor · cart selection · 30 minutes.
     */
    async checkoutStarted(ctx: ActorContext, userId: string) {
      try {
        const lines = await selectedCartLines(userId);
        if (!lines.length) return 0;
        const at = now();
        const selection = hashKey(lines.map((l) => l.lineId ?? `${l.variantId}`).sort());
        const groupKey = `co:${hashKey([ctx.actorKey, selection, String(halfHourBucket(at))])}`;
        return await write(
          lines.map((l) => ({
            ...base("CHECKOUT_STARTED", ctx, at),
            vendorId: l.vendorId,
            productId: l.productId,
            variantId: l.variantId,
            quantity: l.quantity ?? null,
            groupKey,
            source: "CHECKOUT",
            dedupKey: `${groupKey}:${l.variantId ?? l.productId}`,
          }))
        );
      } catch {
        return 0;
      }
    },

    /**
     * CHECKOUT_FAILED — a quote or place-order attempt failed with `reason`.
     * Attributed to the vendors concerned (all lines when unknown). The same
     * failure repeated within 10 minutes for the same selection counts once.
     */
    async checkoutFailed(ctx: ActorContext, userId: string, reason: CheckoutFailureReason, onlyVendorIds?: string[]) {
      try {
        let lines = await selectedCartLines(userId);
        if (onlyVendorIds?.length) {
          const only = new Set(onlyVendorIds);
          const scoped = lines.filter((l) => only.has(l.vendorId));
          if (scoped.length) lines = scoped;
        }
        if (!lines.length) return 0;
        const at = now();
        const selection = hashKey(lines.map((l) => l.lineId ?? `${l.variantId}`).sort());
        const groupKey = `cf:${hashKey([ctx.actorKey, selection, reason, String(tenMinuteBucket(at))])}`;
        return await write(
          lines.map((l) => ({
            ...base("CHECKOUT_FAILED", ctx, at),
            vendorId: l.vendorId,
            productId: l.productId,
            variantId: l.variantId,
            quantity: l.quantity ?? null,
            groupKey,
            reason,
            source: "CHECKOUT",
            dedupKey: `${groupKey}:${l.variantId ?? l.productId}`,
          }))
        );
      } catch {
        return 0;
      }
    },

    /** ORDER_PLACED — from the committed order (authoritative). Idempotent per order line. */
    async orderPlaced(ctx: ActorContext, order: { id: string; vendorOrders?: any[] }) {
      try {
        const at = now();
        const rows: EventRow[] = [];
        for (const vo of order?.vendorOrders ?? []) {
          for (const item of vo?.items ?? []) {
            const product = item?.variant?.product;
            const vendorId = product?.vendorId ?? vo?.vendor?.id ?? vo?.vendorId;
            if (!product?.id || !vendorId) continue;
            const quantity = Number(item.quantity) || 0;
            rows.push({
              ...base("ORDER_PLACED", ctx, at),
              vendorId,
              productId: product.id,
              variantId: item?.variant?.id ?? null,
              orderId: order.id,
              groupKey: `order:${order.id}`,
              quantity,
              valueMinor: toMinor(item.price, quantity),
              source: "CHECKOUT",
              dedupKey: `op:${order.id}:${item.id ?? `${item?.variant?.id}`}`,
            });
          }
        }
        return await write(rows);
      } catch {
        return 0;
      }
    },
  };
}

export type AnalyticsRecorder = ReturnType<typeof createAnalyticsRecorder>;

/** Fire-and-forget at call sites: analytics must never surface an (unhandled) rejection into a request. */
export function trackAnalytics(p: Promise<unknown> | undefined | null): void {
  if (p && typeof (p as Promise<unknown>).catch === "function") (p as Promise<unknown>).catch(() => undefined);
}

/** The production recorder (the regenerated Prisma client provides analyticsEvent). */
export const analyticsRecorder = createAnalyticsRecorder(prisma as unknown as AnalyticsDb);
