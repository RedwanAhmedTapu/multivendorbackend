// src/modules/agent/agent.routes.ts
//
// Three routers, mounted in server.ts:
//   /api/agent/auth   agentAuthRouter    public auth + session endpoints
//   /api/agent        agentPortalRouter  authenticateAgent on EVERY route
//   /api/admin/agents adminAgentRouter   authenticateUser + (ADMIN, or admin-side staff
//                                        holding agentManagement) — never vendor staff
//
// Agent tokens never pass authenticateUser and user/admin tokens never pass
// authenticateAgent (different secret and audience) — see tests/agent-*.test.ts.

import { Router } from "express";
import { authenticateUser, authorizeRoles } from "../../middlewares/auth.middleware.ts";
import { blockVendorEmployees, requirePermission } from "../../middlewares/permission.middleware.ts";
import { authGeneralRateLimiter, loginRateLimiter } from "../../middlewares/rateLimit.middleware.ts";
import { authenticateAgent } from "./middlewares/agent-auth.middleware.ts";
import * as authC from "./controllers/agent-auth.controller.ts";
import * as portalC from "./controllers/agent-portal.controller.ts";
import * as adminC from "./controllers/agent-admin.controller.ts";
import * as commissionC from "./controllers/agent-commission.controller.ts";
import * as walletC from "./controllers/agent-wallet.controller.ts";
import * as referralC from "./controllers/agent-referral.controller.ts";
import * as growthC from "./controllers/agent-growth.controller.ts";
import * as chatC from "./chat/agent-chat.controller.ts";

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
// Commission Dashboard (Phase 6) — always the signed-in agent's own rows.
agentPortalRouter.get("/commissions/summary", commissionC.commissionSummary);
agentPortalRouter.get("/commissions/trend", commissionC.commissionEarningsTrend);
agentPortalRouter.get("/commissions/export", commissionC.exportMyCommissions);
agentPortalRouter.get("/commissions", commissionC.listMyCommissions);
// Wallet, payout methods and withdrawals (Phase 7) — always the signed-in agent's own.
agentPortalRouter.get("/wallet", walletC.getWallet);
agentPortalRouter.get("/wallet/transactions", walletC.listTransactions);
agentPortalRouter.get("/payout-methods", walletC.listPayoutMethods);
agentPortalRouter.post("/payout-methods", walletC.createPayoutMethod);
agentPortalRouter.patch("/payout-methods/:id", walletC.updatePayoutMethod);
agentPortalRouter.delete("/payout-methods/:id", walletC.deletePayoutMethod);
agentPortalRouter.post("/payout-methods/:id/default", walletC.setDefaultPayoutMethod);
agentPortalRouter.get("/withdrawals", walletC.listMyWithdrawals);
agentPortalRouter.post("/withdrawals", walletC.requestWithdrawal);
agentPortalRouter.post("/withdrawals/:id/cancel", walletC.cancelMyWithdrawal);
// Referral Tracking (Phase 8)
agentPortalRouter.get("/referral", referralC.getReferral);
agentPortalRouter.get("/referral/vendors", referralC.listReferredVendors);
// Growth features (Phase 9)
agentPortalRouter.get("/levels/me", growthC.getMyLevel);
agentPortalRouter.get("/bonuses/progress", growthC.getBonusProgress);
agentPortalRouter.get("/bonuses", growthC.getBonusHistory);
agentPortalRouter.get("/performance", growthC.getPerformance);
agentPortalRouter.get("/leaderboard", growthC.getLeaderboard);
agentPortalRouter.get("/alerts", growthC.getAlerts);
agentPortalRouter.get("/training", growthC.listTraining);
agentPortalRouter.get("/training/:id", growthC.getTraining);
// Agent chat inside the existing chat engine (P10) — 404 unless AGENT_CHAT_ENABLED.
agentPortalRouter.get("/chat/conversations", chatC.requireAgentChat, chatC.list);
agentPortalRouter.post("/chat/conversations/support", chatC.requireAgentChat, chatC.openSupport);
agentPortalRouter.post("/chat/conversations/vendor/:vendorId", chatC.requireAgentChat, chatC.openVendor);
agentPortalRouter.get("/chat/conversations/:conversationId/messages", chatC.requireAgentChat, chatC.messages);
agentPortalRouter.get("/chat/conversations/:conversationId/context", chatC.requireAgentChat, chatC.context);
agentPortalRouter.post("/chat/conversations/:conversationId/read", chatC.requireAgentChat, chatC.markRead);
agentPortalRouter.post("/chat/messages", chatC.requireAgentChat, chatC.send);
agentPortalRouter.post("/chat/messages/:messageId/image", chatC.requireAgentChat, chatC.agentChatUpload, chatC.uploadImage);
agentPortalRouter.get("/chat/unread", chatC.requireAgentChat, chatC.unread);

// ── /api/admin/agents ────────────────────────────────────────────────────
export const adminAgentRouter = Router();
// Same gate as the POS-subscription admin routes: ADMIN passes; an EMPLOYEE must
// be admin-side (blockVendorEmployees) and hold agentManagement (re-read from
// the DB on every request by requirePermission).
adminAgentRouter.use(authenticateUser, authorizeRoles("ADMIN", "EMPLOYEE"), blockVendorEmployees, requirePermission("agentManagement"));
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
// commissions (Phase 6), registered before "/:id"
adminAgentRouter.get("/commissions", commissionC.adminListCommissions);
adminAgentRouter.get("/commissions/export", commissionC.adminExportCommissions);
// withdrawals and accrual re-run (Phase 7), registered before "/:id"
adminAgentRouter.get("/withdrawals", walletC.adminListWithdrawals);
adminAgentRouter.get("/withdrawals/:id", walletC.adminGetWithdrawal);
adminAgentRouter.post("/withdrawals/:id/approve", walletC.adminApproveWithdrawal);
adminAgentRouter.post("/withdrawals/:id/reject", walletC.adminRejectWithdrawal);
adminAgentRouter.post("/withdrawals/:id/mark-paid", walletC.adminMarkWithdrawalPaid);
adminAgentRouter.post("/deliveries/:deliveryId/accrue", walletC.adminRerunAccrual);
// growth (Phase 9), wallet adjustment and payable report — before "/:id"
adminAgentRouter.post("/levels/evaluate", growthC.adminEvaluateLevels);
adminAgentRouter.get("/training", growthC.adminListTraining);
adminAgentRouter.post("/training", growthC.adminCreateTraining);
adminAgentRouter.patch("/training/:id", growthC.adminUpdateTraining);
adminAgentRouter.delete("/training/:id", growthC.adminDeleteTraining);
adminAgentRouter.get("/reports/payable", growthC.adminPayableReport);
// agent chat (P10): staff list; reading/replying uses the existing /api/chat routes
adminAgentRouter.get("/chat/conversations", chatC.requireAgentChat, chatC.staffList);
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
adminAgentRouter.get("/:id/wallet", growthC.adminGetAgentWallet);
adminAgentRouter.post("/:id/wallet/adjustments", growthC.adminAdjustAgentWallet);
adminAgentRouter.post("/:id/chat", chatC.requireAgentChat, chatC.staffOpenWithAgent);
