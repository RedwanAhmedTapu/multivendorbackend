// modules/analytics/analytics.routes.ts
//
//   POST /api/analytics/events                     browser events (PRODUCT_VIEW, CHECKOUT_STARTED)
//   GET  /api/analytics/business-advisor/overview  KPIs, journey funnel, trend, failures, orders, insights
//   GET  /api/analytics/business-advisor/products  product performance (sort, search, pagination)
//   GET  /api/analytics/business-advisor/journeys  event-based journeys (no customer identity)
//   /api/analytics/replay/*, /api/analytics/business-advisor/recordings/*
//                                                  visual session replay (session-replay.routes.ts)
//
// Authorization (Business Advisor): authenticateUser + requirePermission
// ("analytics") — ADMIN and VENDOR pass, EMPLOYEE needs the analytics grant,
// customers are refused. The vendor scope is derived from the session:
//   - VENDOR → its own vendor; a vendor's EMPLOYEE → that vendor;
//   - ADMIN / admin-side EMPLOYEE → platform-wide, or ?vendorId=<existing vendor>.
// A vendorId in the query from a vendor-side user is ignored, never trusted.
//
// Ingestion: public (anonymous browsing is measured), rate-limited per IP,
// strict body, product ids validated against public products, bots and staff
// accounts ignored. It always answers 202 (or 400 / 429) and never reveals
// whether a product exists.

import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../config/prisma.ts";
import { authenticateUser } from "../../middlewares/auth.middleware.ts";
import { requirePermission } from "../../middlewares/permission.middleware.ts";
import { publicProductWhere } from "../product-module/utils/filter-builder.util.ts";
import { ANALYTICS_LIMITS, EVENT_SOURCES, looksLikeBot } from "./analytics.contract.ts";
import { analyticsContext, customerUserId } from "./analytics.context.ts";
import { analyticsRecorder, type AnalyticsRecorder } from "./analytics.recorder.ts";
import {
  AnalyticsNotReadyError,
  InvalidRangeError,
  businessAdvisorService,
  type createBusinessAdvisorService,
} from "./business-advisor.service.ts";
import { createReplayAdminRouter, createReplayIngestRouter, type ReplayDeps } from "./session-replay.routes.ts";

type Delegate = Record<string, (...args: any[]) => Promise<any>>;

const EventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PRODUCT_VIEW"), productId: z.string().min(1).max(64), source: z.enum(EVENT_SOURCES).optional() }).strict(),
  z.object({ type: z.literal("CHECKOUT_STARTED") }).strict(),
]);
const IngestSchema = z.object({ events: z.array(EventSchema).min(1).max(ANALYTICS_LIMITS.maxEventsPerRequest) }).strict();

/** Like authenticateUser, but a missing / invalid / expired token just means "anonymous". */
export function softAuthenticate(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) return next();
  let done = false;
  const proceed = () => {
    if (done) return;
    done = true;
    next();
  };
  const fakeRes: any = {
    status() {
      return this;
    },
    json() {
      (req as any).user = undefined;
      proceed();
      return this;
    },
  };
  authenticateUser(req as any, fakeRes, proceed).catch(() => {
    (req as any).user = undefined;
    proceed();
  });
}

export function createAnalyticsRouter(deps: {
  db?: { product: Delegate; vendor: Delegate };
  recorder?: AnalyticsRecorder;
  advisor?: ReturnType<typeof createBusinessAdvisorService>;
  ingestLimit?: number;
  replay?: ReplayDeps;
} = {}) {
  const db = deps.db ?? (prisma as unknown as { product: Delegate; vendor: Delegate });
  const recorder = deps.recorder ?? analyticsRecorder;
  const advisor = deps.advisor ?? businessAdvisorService;
  const router = Router();

  const ingestLimiter = rateLimit({
    windowMs: 60_000,
    limit: deps.ingestLimit ?? 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many requests" },
  });

  router.post("/events", ingestLimiter, softAuthenticate, async (req: Request, res: Response) => {
    const parsed = IngestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: "Invalid analytics event" });
    if (looksLikeBot(req.headers["user-agent"])) return res.status(202).json({ success: true, accepted: 0 });
    const ctx = analyticsContext(req as any);
    if (!ctx) return res.status(202).json({ success: true, accepted: 0 });
    let accepted = 0;
    try {
      const views = parsed.data.events.filter((e): e is Extract<typeof e, { type: "PRODUCT_VIEW" }> => e.type === "PRODUCT_VIEW");
      if (views.length) {
        const ids = [...new Set(views.map((v) => v.productId))];
        const products = await db.product.findMany({ where: publicProductWhere({ id: { in: ids } }), select: { id: true, vendorId: true } });
        const byId = new Map(products.map((p: any) => [p.id, p.vendorId]));
        accepted += await recorder.productViews(
          ctx,
          views.filter((v) => byId.has(v.productId)).map((v) => ({ id: v.productId, vendorId: byId.get(v.productId) as string, source: v.source }))
        );
      }
      const userId = customerUserId((req as any).user);
      if (userId && parsed.data.events.some((e) => e.type === "CHECKOUT_STARTED")) {
        accepted += await recorder.checkoutStarted(ctx, userId);
      }
    } catch (err: any) {
      console.error("[analytics] ingest skipped:", err?.code ?? err?.name ?? "error");
    }
    return res.status(202).json({ success: true, accepted });
  });

  // ── Business Advisor (private) ──
  const advisorRouter = Router();
  advisorRouter.use(authenticateUser as any, requirePermission("analytics") as any);

  async function resolveScope(req: Request): Promise<{ vendorId: string | null } | { status: number; error: string }> {
    const user: any = (req as any).user;
    const role = String(user?.role ?? "").toUpperCase();
    if (role === "VENDOR") return user.vendorId ? { vendorId: user.vendorId } : { status: 403, error: "Forbidden" };
    if (role === "EMPLOYEE" && user.vendorId) return { vendorId: user.vendorId };
    if (role === "ADMIN" || role === "EMPLOYEE") {
      const requested = typeof req.query.vendorId === "string" ? req.query.vendorId.trim() : "";
      if (!requested) return { vendorId: null };
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(requested)) return { status: 400, error: "Invalid vendorId" };
      const vendor = await db.vendor.findUnique({ where: { id: requested }, select: { id: true } });
      return vendor ? { vendorId: vendor.id } : { status: 404, error: "Vendor not found" };
    }
    return { status: 403, error: "Forbidden" };
  }

  const handle = (fn: (scope: { vendorId: string | null }, q: any) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const scope = await resolveScope(req);
      if ("status" in scope) return res.status(scope.status).json({ success: false, error: scope.error });
      const data = await fn(scope, req.query);
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({ success: true, data });
    } catch (err: any) {
      if (err instanceof InvalidRangeError) return res.status(400).json({ success: false, code: "INVALID_RANGE", error: err.message });
      if (err instanceof AnalyticsNotReadyError) return res.status(503).json({ success: false, code: err.code, error: "Analytics isn't set up yet." });
      console.error("[business-advisor] request failed:", err?.code ?? err?.name ?? "error");
      return res.status(500).json({ success: false, error: "Internal server error" });
    }
  };

  advisorRouter.get("/overview", handle((s, q) => advisor.overview(s, q)));
  advisorRouter.get("/products", handle((s, q) => advisor.products(s, q)));
  advisorRouter.get("/journeys", handle((s, q) => advisor.journeys(s, q)));
  advisorRouter.use("/recordings", createReplayAdminRouter(deps.replay));
  router.use("/business-advisor", advisorRouter);
  router.use("/replay", createReplayIngestRouter({ ...deps.replay, authenticate: softAuthenticate }));
  return router;
}

export default createAnalyticsRouter;
