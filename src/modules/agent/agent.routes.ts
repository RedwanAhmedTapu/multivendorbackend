// src/modules/agent/agent.routes.ts
//
// Three routers, mounted in server.ts:
//   /api/agent/auth   agentAuthRouter    public auth + session endpoints
//   /api/agent        agentPortalRouter  authenticateAgent on EVERY route
//   /api/admin/agents adminAgentRouter   authenticateUser + ADMIN + no vendor staff
//
// Agent tokens never pass authenticateUser and user/admin tokens never pass
// authenticateAgent (different secret and audience) — see tests/agent-*.test.ts.

import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../middlewares/auth.middleware.ts";
import { blockVendorEmployees } from "../../middlewares/permission.middleware.ts";
import { authGeneralRateLimiter, loginRateLimiter } from "../../middlewares/rateLimit.middleware.ts";
import { authenticateAgent } from "./middlewares/agent-auth.middleware.ts";
import * as authC from "./controllers/agent-auth.controller.ts";
import * as portalC from "./controllers/agent-portal.controller.ts";
import * as adminC from "./controllers/agent-admin.controller.ts";

// ── /api/agent/auth ──────────────────────────────────────────────────────
export const agentAuthRouter = Router();
agentAuthRouter.use(authGeneralRateLimiter);
agentAuthRouter.post("/register", authC.register);
agentAuthRouter.post("/login", loginRateLimiter, authC.login);
agentAuthRouter.post("/refresh", authC.refresh);
agentAuthRouter.post("/logout", authC.logout);
agentAuthRouter.post("/forgot-password", authC.forgotPassword);
agentAuthRouter.post("/verify-reset-token", authC.verifyResetToken);
agentAuthRouter.post("/reset-password", authC.resetPassword);
agentAuthRouter.post("/logout-all", authenticateAgent, authC.logoutAll);
agentAuthRouter.post("/change-password", authenticateAgent, authC.changePassword);
agentAuthRouter.get("/me", authenticateAgent, authC.me);
agentAuthRouter.get("/sessions", authenticateAgent, authC.sessions);
agentAuthRouter.delete("/sessions/:id", authenticateAgent, authC.revokeSession);
agentAuthRouter.patch("/profile", authenticateAgent, authC.updateProfile);
agentAuthRouter.patch("/notification-prefs", authenticateAgent, authC.updateNotificationPrefs);

// ── /api/agent ───────────────────────────────────────────────────────────
export const agentPortalRouter = Router();
agentPortalRouter.use(authenticateAgent);
agentPortalRouter.get("/program", portalC.programInfo);
agentPortalRouter.get("/dashboard/summary", portalC.dashboardSummary);
agentPortalRouter.get("/dashboard/sales-trend", portalC.salesTrend);
agentPortalRouter.get("/dashboard/commission-trend", portalC.commissionTrend);
agentPortalRouter.get("/vendors", portalC.listVendors);
agentPortalRouter.get("/vendors/:vendorId", portalC.vendorDetail);
agentPortalRouter.get("/orders", portalC.listOrders);
agentPortalRouter.get("/orders/:vendorOrderId", portalC.orderDetail);
agentPortalRouter.get("/products", portalC.listProducts);
agentPortalRouter.get("/reviews", portalC.listReviews);
agentPortalRouter.get("/vendor-performance", portalC.vendorPerformance);
agentPortalRouter.get("/analytics/insights", portalC.analyticsInsights);

// ── /api/admin/agents ────────────────────────────────────────────────────
export const adminAgentRouter = Router();
adminAgentRouter.use(authenticateUser, authorizeRoles("ADMIN"), blockVendorEmployees);
// configuration (registered before "/:id" so the paths can't be shadowed)
adminAgentRouter.get("/settings", adminC.getSettings);
adminAgentRouter.patch("/settings", adminC.patchSettings);
adminAgentRouter.get("/audit", adminC.listAudit);
adminAgentRouter.get("/levels", adminC.listLevels);
adminAgentRouter.post("/levels", adminC.createLevel);
adminAgentRouter.patch("/levels/:id", adminC.updateLevel);
adminAgentRouter.delete("/levels/:id", adminC.deleteLevel);
adminAgentRouter.get("/overrides", adminC.listOverrides);
adminAgentRouter.post("/overrides", adminC.createOverride);
adminAgentRouter.post("/overrides/:id/end", adminC.endOverride);
adminAgentRouter.get("/rate-preview", adminC.ratePreview);
adminAgentRouter.get("/bonus-rules", adminC.listBonusRules);
adminAgentRouter.post("/bonus-rules", adminC.createBonusRule);
adminAgentRouter.patch("/bonus-rules/:id", adminC.updateBonusRule);
adminAgentRouter.delete("/bonus-rules/:id", adminC.deleteBonusRule);
adminAgentRouter.get("/lookup/vendors", adminC.lookupVendors);
adminAgentRouter.get("/lookup/categories", adminC.lookupCategories);
adminAgentRouter.get("/lookup/agents", adminC.lookupAgents);
adminAgentRouter.post("/vendor-links/:linkId/end", adminC.endVendorLink);
// agents
adminAgentRouter.get("/", adminC.listAgents);
adminAgentRouter.post("/", adminC.createAgent);
adminAgentRouter.get("/:id", adminC.getAgent);
adminAgentRouter.patch("/:id", adminC.updateAgent);
adminAgentRouter.post("/:id/approve", adminC.approveAgent);
adminAgentRouter.post("/:id/suspend", adminC.suspendAgent);
adminAgentRouter.post("/:id/reactivate", adminC.reactivateAgent);
adminAgentRouter.post("/:id/deactivate", adminC.deactivateAgent);
adminAgentRouter.post("/:id/vendors", adminC.assignVendor);
