// server.ts
(BigInt.prototype as any).toJSON = function() {
  return this.toString();
};
import 'dotenv/config';
import { initRedis } from "./config/redis.ts";
import { startJobRunner } from "./jobs/job-runner.ts";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import cookieParser from "cookie-parser";

// Import routes
import authRoutes from "./modules/auth/routes/auth.routes.ts";
import webauthnRoutes from "./modules/auth/routes/webauthn.routes.ts";
import customerProfileRouter from './routes/customerProfile.routes.ts';
import productRoutes from "../src/modules/product-module/routes/product.routes.ts";
import productReviewRoutes  from "./modules/product-module/routes/review.routes.ts";
import vendorReviewRoutes from "./modules/product-module/routes/review-vendor.routes.ts";
import adminReviewRoutes from "./modules/product-module/routes/review-admin.routes.ts";
import categoryRoutes from "./routes/category.routes.ts";
import attributeRoutes from "./routes/attribute.routes.ts";
import specificationRoutes from "./routes/specification.routes.ts";
import sliderRoutes from "./routes/slider.routes.ts";
import campaignPageRoutes from "./routes/campaignPage.routes.ts";
import marketingAdminRoutes from "./modules/marketing/admin-campaign.routes.ts";
import { createEmailSmsCampaignRouter } from "./modules/marketing/email-sms/campaign.routes.ts";
import { prisma } from "./config/prisma.ts";
import marketingVendorRoutes from "./modules/marketing/vendor-campaign.routes.ts";
import vendorManagementRoutes from "./routes/vendor.routes.ts";
import customerRoutes from "./routes/customer.routes.ts";
import orderRoutes from "./routes/order.routes.ts";
import payoutRoutes from "./routes/payout.routes.ts";
import chatRoutes from "./routes/chat.routes.ts";
import shippingApi from "./routes/shippingProvider.routes.ts";
import TermsRoutes from "./routes/terms.routes.ts";
import { ChatSocket } from "./socket/chatSocket.ts";
// ✅ FIX: import chatController so we can wire the socket instance into it
import { chatController } from "./controllers/chat.controller.ts";
import courierRoutes from "./routes/courier.routes.ts";
import courierWebhookRoutes from "./routes/courierWebhook.routes.ts";
import { errorHandler } from "./middlewares/error.middleware.ts";
import vendorstorage from "./routes/vendor-storage.routes.ts";
import filemanger from "./routes/vendor.folder.routes.ts";
import offerRoutes from "./routes/offers.routes.ts";
import employeeroutes from "./routes/employee.routes.ts";
// HRM module — organization, profiles, attendance, leave, payroll, etc.
// (login accounts + permissions stay on /api/employees above)
import hrmRoutes from "./modules/hrm/hrm.routes.ts";
import uploadRoutes from "./routes/upload.routes.ts"; 
import { storeDecorationRoutes } from "./routes/storeLayout.routes.ts";
import bulkproducttemplates from "./routes/bulkproductTemplate.routes.ts";
import categoryFilterRoutes from './routes/categoryFilterRoutes.ts';
import faqRoutes from './routes/faq.routes.ts'; 
import themeRoutes from './routes/theme.routes.ts';
import categoryTemplate from "./routes/category.template.routes.ts";
import bulkImportCategoryRoutes from "./routes/bulkImportCategoryRoutes.ts";
import TranslateproductNameToBn from "./routes/translate.routes.ts";
import LocationsRoutes from "./routes/location.routes.ts";
import VendorwarehoueRoutes from "./routes/warehouse.routes.ts";
import CartWishitems from "./routes/cartWish.routes.ts";
import accountingRoutes from './routes/accounting.routes.ts';
import UserAddressRoutes  from './routes/user-address.routes.ts';
import footerSettingsRoutes from "./routes/footerSettings.routes.ts";
import vendorOrderRoutes from "./routes/vendor.order.routes.ts";
import adminOrderRoutes from "./routes/admin.order.routes.ts";
import fraudProviderAdminRoutes from "./modules/fraud-checker-module/admin/fraud-provider.admin.routes.ts";
import supplierRoutes      from './routes/supplier.routes.ts';
import purchaseOrderRoutes from './routes/purchase-order.routes.ts';
import stockRoutes         from './routes/stock.routes.ts';
import { orderChargeRoutes } from './routes/orderCharge.routes.ts';
import PosRoutes from './routes/pos.routes.ts';
import { posBillingCallbackRoutes, posSubscriptionAdminRoutes } from './routes/pos-billing.routes.ts';
import { posSubscriptionJobs } from './modules/pos-subscription/pos-subscription.jobs.ts';
import { createAdminSubscriptionRouter, createVendorSubscriptionRouter } from './modules/subscriptions/subscription.routes.ts';
import { subscriptionJobs } from './modules/subscriptions/subscription.jobs.ts';
import { createAdminPayoutRouter, createVendorPayoutRouter } from './modules/payouts/payout.routes.ts';
import { payoutJobs } from './modules/payouts/payout.jobs.ts';
import BrandRoutes from './routes/brand.routes.ts';
import vendorProductFieldRuleRoutes from './routes/vendorProductFieldRule.routes.ts'; 
import { setupChatModule } from "./modules/chat/chat.module.ts";
import { setupAgentChatSocket } from "./modules/agent/chat/agent-chat.socket.ts";
import { createAnalyticsRouter } from "./modules/analytics/analytics.routes.ts";
import { analyticsRetentionJob } from "./modules/analytics/analytics.retention.ts";
// SECURITY: the legacy unauthenticated SSLCommerz webhook
// (./webhooks/paymentwebhook/sslcommerz.webhook.ts) is intentionally NOT
// mounted — it marked an arbitrary Payment PAID without verification.
// The verified SSLCommerz flow is /api/payment/ipn (+ /success) in payment.routes.ts.
import blogRoutes from "./modules/blog-module/routes/blog.routes.ts";
import paymentRoutes from "./routes/payment.routes.ts";
import BankRoutes from "./routes/bank.routes.ts";
// Agent Commission System (docs/agent-system-plan.md) — separate agent auth.
import { agentAuthRouter, agentPortalRouter, adminAgentRouter } from "./modules/agent/agent.routes.ts";
import { agentFrontendOrigin, reportAgentAuthConfig } from "./modules/agent/agent.config.ts";
import { agentAwareCorsOptions } from "./modules/agent/agent-cors.ts";
import { agentCommissionJobs } from "./modules/agent/agent.jobs.ts";
// import { seedChartOfAccounts } from './seed-chart-of-accounts.ts';

// Fix __dirname in ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

const allowedOrigins = [
  process.env.FRONTEND_URL || "http://localhost:3000",
  process.env.BLOG_FRONTEND_URL || "http://localhost:3001",
];

app.set("trust proxy", 1);
// ✅ INCREASE PAYLOAD SIZE LIMIT
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ✅ CRITICAL: Add cookie parser middleware
app.use(cookieParser());

// Express CORS
// The agent portal is its own app (port 3002). Its origin is allowed on the
// agent API (/api/agent/*) only — never on the rest of the REST API, and not
// for Socket.IO below (see modules/agent/agent-cors.ts).
app.use(cors(agentAwareCorsOptions(allowedOrigins, agentFrontendOrigin())));

// Socket.io CORS
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST"],
  },
});
app.use((req, res, next) => {
  res.setHeader(
    "Accept-CH",
    [
      "Sec-CH-UA-Platform",
      "Sec-CH-UA-Platform-Version",
      "Sec-CH-UA-Model",
    ].join(", "),
  );
  res.setHeader(
    "Vary",
    [
      "Sec-CH-UA-Platform",
      "Sec-CH-UA-Platform-Version",
      "Sec-CH-UA-Model",
    ].join(", "),
  );
  next();
});
// ✅ Static file serving (uploads)
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));
app.use('/templates', express.static(path.join(__dirname, 'templates')));

// ✅ Routes
app.use("/api/auth", authRoutes);
app.use("/api/webauthn", webauthnRoutes);
app.use("/api/sliders", sliderRoutes);
app.use("/api/campaigns", campaignPageRoutes);
// Marketing Center admin API (marketingManagement). Requires the Phase 1 migration + regenerated client.
app.use("/api/marketing/admin", marketingAdminRoutes);
app.use("/api/marketing/admin/email-sms", createEmailSmsCampaignRouter({ db: prisma as any }));
app.use("/api/marketing/vendor", marketingVendorRoutes);

app.use('/api/customer/profile', customerProfileRouter);
app.use("/api/products", productRoutes);
app.use("/api/reviews", productReviewRoutes);
app.use("/api/vendor/reviews", vendorReviewRoutes);
app.use("/api/admin/reviews", adminReviewRoutes);
app.use("/api/categories", categoryRoutes);
app.use('/api/category-template', categoryTemplate);
app.use("/api/bulk-import-category", bulkImportCategoryRoutes);
app.use('/api/categories-filter', categoryFilterRoutes);
app.use("/api/attributes", attributeRoutes);
app.use("/api/specifications", specificationRoutes);
app.use("/api/vendormanagement", vendorManagementRoutes);
app.use("/api/customermanagement", customerRoutes);
app.use("/api/user-orders", orderRoutes);
app.use("/api/vendor-orders", vendorOrderRoutes);
app.use("/api/admin-orders", adminOrderRoutes);
app.use("/api/admin-fraud-providers", fraudProviderAdminRoutes);
app.use("/api/payout", payoutRoutes);
app.use("/api/shippingapi",shippingApi);
app.use("/api/courier", courierRoutes);
// 1C-11 (B3): canonical provider webhook surface (signature/token verified —
// mounted outside any application auth; providers do not use app JWTs).
app.use("/api/webhooks", courierWebhookRoutes);
app.use('/api/locations',LocationsRoutes);

app.use("/api/terms", TermsRoutes);
app.use("/api/vendor-storage",vendorstorage);
app.use("/api/filemanager",filemanger);
app.use('/api/offers', offerRoutes);
app.use('/api/employees', employeeroutes);
app.use('/api/hrm', hrmRoutes);
app.use('/api/store-decoration', storeDecorationRoutes);
app.use('/api/upload', uploadRoutes);

app.use("/api/cart-wish",CartWishitems);
app.use('/api/faqs', faqRoutes);
app.use('/api/themes', themeRoutes);
app.use('/api/warehouse',VendorwarehoueRoutes);
app.use('/api/user-address', UserAddressRoutes);
app.use('/api/translate', TranslateproductNameToBn);
app.use('/api/accounting',accountingRoutes);
app.use("/api/footer-settings", footerSettingsRoutes);

app.use('/api/suppliers',        supplierRoutes);
app.use('/api/purchase-orders',  purchaseOrderRoutes);
app.use('/api/stock',            stockRoutes);
app.use('/api/order-charges',      orderChargeRoutes);
app.use('/api/pos',                PosRoutes);
// POS subscriptions: public gateway callbacks (verified with the gateway) + admin management.
app.use('/api/pos-billing',        posBillingCallbackRoutes);
app.use('/api/admin/pos-subscriptions', posSubscriptionAdminRoutes);
// Dynamic plans + features (docs/subscription-payout-audit.md) and scheduled vendor payouts on the ledger.
app.use('/api/admin/subscriptions', createAdminSubscriptionRouter());
app.use('/api/vendor/subscription', createVendorSubscriptionRouter());
app.use('/api/admin/payouts', createAdminPayoutRouter());
app.use('/api/vendor/payouts', createVendorPayoutRouter());
app.use('/api/brands',             BrandRoutes);
app.use("/api/product-field-rules", vendorProductFieldRuleRoutes);
app.use("/api/blog", blogRoutes);

app.use("/api/payment",paymentRoutes);
app.use("/api/banks", BankRoutes);
app.use("/api/agent/auth", agentAuthRouter);
app.use("/api/agent", agentPortalRouter);
app.use("/api/admin/agents", adminAgentRouter);
reportAgentAuthConfig();

// ✅ FIX: Capture the ChatSocket instance, then immediately hand it to the
//    controller so chatController.chatSocketInstance is never null when an
//    HTTP send-message request arrives.
//
//    Previously this was just:  new ChatSocket(io);
//    The returned instance was thrown away, leaving chatSocketInstance = null,
//    so broadcastNewMessage() was never called and the vendor never received
//    real-time message events.
app.use("/api/chat", setupChatModule(io));
// P10: agents' own Socket.IO server on /agent-socket (agent origin, agent tokens) —
// unless the AGENT_CHAT_ENABLED kill switch is "0" / "false"; the default server above is untouched.
setupAgentChatSocket(server);
// Business Advisor: event ingestion + private analytics (see modules/analytics).
app.use("/api/analytics", createAnalyticsRouter());

app.get("/", (_req, res) => res.send("E-commerce API running 🚀"));

await initRedis();
// await seedChartOfAccounts();
// Marketing Center: single-instance job runner (Redis lock). No-op unless
// JOBS_ENABLED=1; jobs are registered by later phases.
// Business Advisor: analytics retention (only when JOBS_ENABLED=1, like every job).
await startJobRunner((runner) => {
  runner.register(analyticsRetentionJob());
  for (const job of posSubscriptionJobs()) runner.register(job);
  for (const job of subscriptionJobs()) runner.register(job);
  for (const job of payoutJobs()) runner.register(job);
  for (const job of agentCommissionJobs()) runner.register(job);
});

// 1C-11: central error handler must be mounted AFTER all routes — Express'
// default HTML error page leaks absolute filesystem paths.
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ ChatSocket wired to ChatController — real-time messaging active`);
});

export default app;
