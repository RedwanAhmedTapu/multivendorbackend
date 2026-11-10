// src/services/payment-gateway.service.ts
//
// Orchestrator sitting above the individual gateway integrations
// (payment.service.ts for SSLCommerz, eps.service.ts for EPS,
// paystation.service.ts for PayStation). Mirrors the admin-configurable-
// provider pattern already used for couriers: an admin activates exactly ONE
// PaymentProvider row, and:
//   - the storefront checkout UI asks getActiveGatewayPublicInfo() to know
//     what to show/use
//   - initiatePayment() dispatches to whichever gateway is active
//   - verifyAndConfirm*() dispatches based on the PAYMENT ROW'S OWN
//     paymentProviderId — not "whatever is active now" — because a
//     payment already in flight must still be verifiable against the
//     gateway that actually issued it, even if an admin flips the active
//     gateway in the meantime.
import { PrismaClient, PaymentStatus, PaymentMethod, OrderStatus } from "@prisma/client";
import { paymentService } from "./payment.service.ts";
import { postEvent0aForConfirmedPayment } from "./order-accounting.service.ts";
import { epsService } from "./eps.service.ts";
import { paystationService } from "./paystation.service.ts";
import { reconciliationOf, recordGatewayReport } from "./payment-reconciliation.ts";
import { settleVerifiedPayment, stockHoldMeta } from "./payment-settlement.ts";

const prisma = new PrismaClient();
/** Test seam (same pattern as payment.service's paymentServiceDb): lets DB-free tests stub this client. */
export const paymentGatewayDb = prisma;

const ENVIRONMENT = process.env.NODE_ENV === "production" ? "PRODUCTION" : "SANDBOX";

// Statuses that mean "money was already received" — used to keep callbacks/IPNs idempotent.
const PAID_STATES: PaymentStatus[] = [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED];

export type CredentialInput = Partial<{
  storeId: string;
  storePassword: string;
  merchantId: string;
  username: string;
  password: string;
  hashKey: string;
}>;

// Fields a credential row must have before a gateway can be switched on.
// SSLCOMMERZ is empty on purpose: payment.service.ts still reads its store
// id/password from .env, so the DB row only needs to exist (checked separately).
const REQUIRED_CREDENTIAL_FIELDS: Record<string, (keyof CredentialInput)[]> = {
  SSLCOMMERZ: [],
  EPS: ["merchantId", "storeId", "username", "password", "hashKey"],
  PAYSTATION: ["merchantId", "password"],
};

type InitiateParams = { orderId: string; userId: string; gatewayCode: string };

/** Credential columns that are secrets — never sent back to any browser. */
export const SECRET_CREDENTIAL_FIELDS = ["storePassword", "password", "hashKey", "accessToken"] as const;
export const REDACTED = "********";

/**
 * Admin API view of a stored credential: secret columns become a fixed
 * marker when set (null when not), so the admin UI can still show "Set" /
 * "Not set" but the values never leave the server. Identifiers (storeId,
 * merchantId, username) stay visible for configuration.
 */
export function redactCredential<T extends Record<string, unknown>>(credential: T): T {
  const out: Record<string, unknown> = { ...credential };
  for (const key of SECRET_CREDENTIAL_FIELDS) {
    if (key in out) out[key] = out[key] ? REDACTED : null;
  }
  return out as T;
}

/** Payment row + the provider/credentials that issued it, found via a value stored in Payment.meta. */
function findGatewayPayment(method: PaymentMethod, metaKey: string, value: string) {
  return prisma.payment.findFirst({
    where: { method, meta: { path: [metaKey], equals: value } },
    include: { paymentProvider: { include: { payment_credentials: true } } },
  });
}
type GatewayPayment = NonNullable<Awaited<ReturnType<typeof findGatewayPayment>>>;

export type PaystationCallbackOutcome = "success" | "failed" | "cancelled" | "pending";

export class PaymentGatewayService {
  /**
   * The provider an admin has switched on, with its credential for the
   * current environment. Throws if none is active — fail loud rather than
   * silently falling back to a hardcoded gateway.
   */
  async getActiveProvider() {
    const provider = await prisma.paymentProvider.findFirst({
      where: { isActive: true },
      include: { payment_credentials: { where: { environment: ENVIRONMENT, isActive: true } } },
    });
    if (!provider) {
      throw new Error("No active payment gateway is configured. Ask an admin to activate one.");
    }
    const credential = provider.payment_credentials[0];
    if (!credential) {
      throw new Error(`Active payment gateway "${provider.name}" has no ${ENVIRONMENT} credentials configured.`);
    }
    return { provider, credential };
  }

  /**
   * What the storefront checkout page needs to know: which gateway is
   * live right now, so it can show the right button/logo. Deliberately
   * returns nothing secret (no credentials).
   */
  async getActiveGatewayPublicInfo() {
    const provider = await prisma.paymentProvider.findFirst({
      where: { isActive: true },
      select: { id: true, name: true, displayName: true, logo: true, slug: true },
    });
    return provider; // null is a valid answer: "no gateway configured yet"
  }

  /**
   * Dispatches to the active gateway. Returns a shape compatible with what
   * PaymentController.createPayment already expects
   * ({ gatewayPageURL, sessionKey, transactionId }).
   */
  async initiatePayment(params: InitiateParams) {
    const { provider, credential } = await this.getActiveProvider();
    const key = provider.name.toUpperCase();

    if (key === "SSLCOMMERZ") {
      // Existing, unmodified SSLCommerz flow (payment.service.ts) — already
      // stamps paymentProviderId on the row it creates.
      return paymentService.initiatePayment(params);
    }
    if (key === "EPS") {
      return this.initiateEpsPayment(params, provider, credential);
    }
    if (key === "PAYSTATION") {
      return this.initiatePaystationPayment(params, provider, credential);
    }

    throw new Error(`No payment dispatcher implemented for gateway "${provider.name}"`);
  }

  private async loadOrderForPayment(orderId: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        address: true,
        vendorOrders: { include: { items: { include: { variant: { include: { product: { select: { name: true } } } } } } } },
      },
    });
    if (!order) throw new Error("Order not found");
    if (!order.user) throw new Error("Order has no associated user");
    const productNames =
      order.vendorOrders
        .flatMap((vo) => vo.items.map((i) => i.variant.product.name))
        .join(", ")
        .substring(0, 250) || "E-commerce Order";
    return { order, user: order.user, productNames };
  }

  // -------------------- EPS --------------------

  private async initiateEpsPayment(
    params: InitiateParams,
    provider: Awaited<ReturnType<PaymentGatewayService["getActiveProvider"]>>["provider"],
    credential: Awaited<ReturnType<PaymentGatewayService["getActiveProvider"]>>["credential"],
  ) {
    const { orderId } = params;
    const { order, user, productNames } = await this.loadOrderForPayment(orderId);

    // EPS requires a unique, minimum-10-digit merchantTransactionId.
    const merchantTransactionId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

    const payment = await prisma.payment.create({
      data: {
        orderId,
        method: PaymentMethod.EPS,
        amount: order.totalAmount,
        status: PaymentStatus.PENDING,
        paymentProviderId: provider.id,
        meta: { gateway: "EPS", merchantTransactionId, type: "order_payment" },
      },
    });

    try {
      // merchantId + storeId are read from the credential row inside epsService.
      const { transactionId, redirectUrl } = await epsService.initializePayment(provider, credential as any, {
        customerOrderId: orderId,
        merchantTransactionId,
        transactionTypeId: 1, // Web — pass 2/3 through params.gatewayCode if you add native app checkout later
        totalAmount: Number(order.totalAmount),
        successUrl: `${process.env.BACKEND_URL}/api/payment/success`,
        failUrl: `${process.env.BACKEND_URL}/api/payment/fail`,
        cancelUrl: `${process.env.BACKEND_URL}/api/payment/cancel`,
        customerName: user.name || "Customer",
        customerEmail: user.email || "customer@example.com",
        customerAddress: order.address?.address || "Dhaka",
        customerCity: order.address?.city || "Dhaka",
        customerState: order.address?.zone || "Dhaka",
        customerPostcode: "1000",
        customerCountry: order.address?.country || "Bangladesh",
        customerPhone: user.phone || order.address?.phone || "01700000000",
        productName: productNames,
        ipAddress: "127.0.0.1", // TODO: thread the real client IP through from the controller if EPS rejects this
      });

      await prisma.payment.update({
        where: { id: payment.id },
        data: { meta: { gateway: "EPS", merchantTransactionId, epsTransactionId: transactionId, type: "order_payment" } },
      });

      return {
        payment,
        sessionKey: null,
        gatewayPageURL: redirectUrl,
        redirectGatewayURL: redirectUrl,
        transactionId: merchantTransactionId,
      };
    } catch (error: any) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.FAILED } });
      throw error;
    }
  }

  // -------------------- PAYSTATION --------------------

  private async initiatePaystationPayment(
    params: InitiateParams,
    provider: Awaited<ReturnType<PaymentGatewayService["getActiveProvider"]>>["provider"],
    credential: Awaited<ReturnType<PaymentGatewayService["getActiveProvider"]>>["credential"],
  ) {
    const { orderId, userId } = params;
    if (!credential.merchantId || !credential.password) {
      throw new Error("PayStation credential is missing merchantId/password");
    }
    const { order, user, productNames } = await this.loadOrderForPayment(orderId);

    // Must be unique per attempt (PayStation rejects duplicates with 1008).
    const invoiceNumber = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

    const payment = await prisma.payment.create({
      data: {
        orderId,
        method: PaymentMethod.PAYSTATION,
        amount: order.totalAmount,
        status: PaymentStatus.PENDING,
        paymentProviderId: provider.id,
        meta: { gateway: "PAYSTATION", invoiceNumber, type: "order_payment" },
      },
    });

    try {
      const { paymentUrl } = await paystationService.initializePayment(provider, credential as any, {
        invoiceNumber,
        amount: Number(order.totalAmount),
        customerName: user.name || "Customer",
        customerPhone: user.phone || order.address?.phone || "01700000000",
        customerEmail: user.email || "customer@example.com",
        customerAddress: order.address?.address || undefined,
        callbackUrl: `${process.env.BACKEND_URL}/api/payment/paystation/callback`,
        reference: orderId,
        checkoutItems: productNames,
        optA: orderId,
        optB: userId,
        // false = merchant bears the gateway charge. Flip with PAYSTATION_PAY_WITH_CHARGE=1
        // to pass the charge to the customer (verification below accepts amount >= expected).
        payWithCharge: process.env.PAYSTATION_PAY_WITH_CHARGE === "1",
      });

      return {
        payment,
        sessionKey: null,
        gatewayPageURL: paymentUrl,
        redirectGatewayURL: paymentUrl,
        transactionId: invoiceNumber,
      };
    } catch (error: any) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.FAILED } });
      throw error;
    }
  }

  /**
   * Verify against PayStation's transaction-status API and, only if it
   * reports success for at least the expected amount, mark the payment
   * paid and the order confirmed. Safe to call repeatedly (IPN retries,
   * callback + IPN racing): an already-paid payment returns "success".
   *
   * `hint` is the (untrusted) `status` the browser callback carried; it is
   * only used to decide failed-vs-cancelled when the API says the payment
   * did NOT succeed, never to declare success.
   */
  private async syncPaystationPayment(payment: GatewayPayment, hint = ""): Promise<PaystationCallbackOutcome> {
    if (PAID_STATES.includes(payment.status)) return "success";
    if (reconciliationOf(payment.meta)) return "success"; // received earlier, recorded for reconciliation

    const provider = payment.paymentProvider;
    if (!provider) throw new Error("PayStation payment has no gateway attached");
    const credential = provider.payment_credentials.find((c) => c.environment === ENVIRONMENT);
    if (!credential) throw new Error("PayStation credential missing for current environment");

    const meta = (payment.meta ?? {}) as Record<string, any>;
    const invoiceNumber = String(meta.invoiceNumber ?? "");
    if (!invoiceNumber) throw new Error("PayStation payment has no invoice number");

    const result = await paystationService.checkTransactionStatus(provider, credential as any, invoiceNumber);

    if (result.status === "success") {
      const expected = Number(payment.amount);
      // With pay_with_charge=1 the customer pays slightly more, so only reject UNDER-payment.
      if (result.paymentAmount !== null && result.paymentAmount + 0.01 < expected) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { meta: { ...meta, paystationFlag: "AMOUNT_MISMATCH", paystationRaw: result.raw } as any },
        });
        throw new Error(`PayStation amount mismatch: expected ${expected}, gateway reports ${result.paymentAmount}`);
      }

      // Phase 6: settled under the order lock (payment-settlement.ts) — Event 0a
      // only for a payment that is applied; money the order can no longer take
      // is recorded (no Event 0a) and the order is left untouched.
      const paystationMeta = { paystationStatus: result.status, paystationTrxId: result.trxId, paystationMethod: result.paymentMethod, paystationRaw: result.raw };
      await settleVerifiedPayment(prisma, {
        orderId: payment.orderId,
        paymentId: payment.id,
        amount: payment.amount,
        gateway: "PAYSTATION",
        gatewayRef: result.trxId ?? invoiceNumber,
        unappliedMeta: paystationMeta,
        holdAuditData: { invoiceNumber },
        postEvent0a: () =>
          postEvent0aForConfirmedPayment({
            orderId: payment.orderId,
            paymentId: payment.id,
            amount: payment.amount,
            paymentGatewayId: payment.paymentProviderId ?? "SSLCOMMERZ",
            createdBy: "system",
          }),
        applyPayment: (tx, outcome, at) =>
          tx.payment.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.PAID, paidAt: at, meta: { ...meta, ...paystationMeta, ...(outcome === "HELD" ? stockHoldMeta(at) : {}) } as any },
          }),
      });
      return "success";
    }

    const cancelled = /cancel/.test(hint);
    const failedByHint = /cancel|fail|unsuccess|declin/.test(hint);
    if (result.status === "failed" || failedByHint) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.FAILED,
          meta: { ...meta, paystationStatus: result.status, paystationOutcome: cancelled ? "CANCELLED" : "FAILED" } as any,
        },
      });
      return cancelled ? "cancelled" : "failed";
    }

    // processing / not_found / unknown with no failure hint: the customer may still be mid-payment.
    return "pending";
  }

  /** Browser return from PayStation's checkout (callback_url). Verifies server-side, then reports where to send the customer. */
  async handlePaystationCallback(invoiceNumber: string, hint = ""): Promise<PaystationCallbackOutcome> {
    const payment = await findGatewayPayment(PaymentMethod.PAYSTATION, "invoiceNumber", invoiceNumber);
    if (!payment) throw new Error("Transaction not found for any configured gateway");
    return this.syncPaystationPayment(payment, hint.toLowerCase());
  }

  // -------------------- VERIFY / CONFIRM (IPN + callbacks) --------------------

  /**
   * Verify + confirm a payment by dispatching to whichever gateway
   * actually issued it (Payment.paymentProviderId), not necessarily the
   * currently-active one.
   */
  async verifyAndConfirmByTransactionId(transactionId: string, opts: { valId?: string } = {}) {
    // 1) SSLCommerz — its own table, keyed by tranId.
    const sslTxn = await prisma.sSLCommerzTransaction.findUnique({ where: { tranId: transactionId } });
    if (sslTxn) {
      if (!opts.valId) throw new Error("val_id is required to verify an SSLCommerz transaction");
      const validation = await paymentService.validatePayment(opts.valId);
      if (validation.status !== "VALID" && validation.status !== "VALIDATED") {
        throw new Error("Invalid SSLCommerz payment");
      }
      return paymentService.confirmPayment(transactionId, validation);
    }

    // 2) PayStation — invoice number stored in Payment.meta.
    const paystationPayment = await findGatewayPayment(PaymentMethod.PAYSTATION, "invoiceNumber", transactionId);
    if (paystationPayment) {
      const outcome = await this.syncPaystationPayment(paystationPayment);
      if (outcome !== "success") {
        throw new Error(`PayStation payment not successful (status: ${outcome})`);
      }
      return prisma.payment.findUniqueOrThrow({ where: { id: paystationPayment.id } });
    }

    // 3) EPS — merchantTransactionId stored in Payment.meta.
    const epsPayment = await findGatewayPayment(PaymentMethod.EPS, "merchantTransactionId", transactionId);
    if (!epsPayment || !epsPayment.paymentProvider) {
      throw new Error("Transaction not found for any configured gateway");
    }
    if (PAID_STATES.includes(epsPayment.status)) return epsPayment; // idempotent
    if (reconciliationOf(epsPayment.meta)) return epsPayment; // received earlier, recorded for reconciliation

    const credential = epsPayment.paymentProvider.payment_credentials.find((c) => c.environment === ENVIRONMENT);
    if (!credential) throw new Error("EPS credential missing for current environment");

    const result = await epsService.checkTransactionStatus(epsPayment.paymentProvider, credential as any, transactionId);

    if (result.status !== "Success") {
      await prisma.payment.update({
        where: { id: epsPayment.id },
        data: { status: PaymentStatus.FAILED, meta: { ...(epsPayment.meta as any), epsStatus: result.status } },
      });
      throw new Error(`EPS payment not successful (status: ${result.status})`);
    }

    // Phase 6: settled under the order lock (payment-settlement.ts); the payment
    // is marked PAID only when it is applied — otherwise the verified money is
    // recorded for reconciliation and the order is left untouched.
    const epsMeta = { ...((epsPayment.meta as Record<string, unknown> | null) ?? {}), epsStatus: result.status, epsRaw: result.raw };
    await settleVerifiedPayment(prisma, {
      orderId: epsPayment.orderId,
      paymentId: epsPayment.id,
      amount: epsPayment.amount,
      gateway: "EPS",
      gatewayRef: transactionId,
      unappliedMeta: { epsStatus: result.status, epsRaw: result.raw },
      holdAuditData: { merchantTransactionId: transactionId },
      // Phase 6: EPS never posted Event 0a, so delivery / refunds later released
      // escrow that was never booked. It now posts exactly what PayStation posts
      // (same function and accounts), keyed by the EPS provider, only when the
      // payment is applied, inside the settlement lock (a failure rolls back).
      postEvent0a: () =>
        postEvent0aForConfirmedPayment({
          orderId: epsPayment.orderId,
          paymentId: epsPayment.id,
          amount: epsPayment.amount,
          paymentGatewayId: epsPayment.paymentProviderId ?? "EPS",
          createdBy: "system",
        }),
      applyPayment: (tx, outcome, at) =>
        tx.payment.update({
          where: { id: epsPayment.id },
          data: { status: PaymentStatus.PAID, paidAt: at, meta: { ...epsMeta, ...(outcome === "HELD" ? stockHoldMeta(at) : {}) } as any },
        }),
    });

    return prisma.payment.findUniqueOrThrow({ where: { id: epsPayment.id } });
  }

  /**
   * Mark a payment failed/cancelled regardless of which gateway issued it.
   * SSLCommerz keeps its own status column on SSLCommerzTransaction (used
   * elsewhere for card/bank detail); EPS has no matching table, so its
   * failure reason just lives in Payment.meta.
   * (PayStation has no separate fail/cancel URLs — its single callback goes
   * through handlePaystationCallback.)
   */
  async markFailedOrCancelled(transactionId: string, outcome: "FAILED" | "CANCELLED") {
    // Phase 5 / Step 3: /payment/fail and /payment/cancel are public — the
    // posted tran_id and the URL's outcome are only a CLAIM. The gateway's own
    // API decides: a confirmed failure is applied as before (FAILED, stock
    // released); a payment the gateway reports as successful goes through the
    // normal verified success path; anything unconfirmed changes no state and
    // is only noted (recordGatewayReport).
    const sslTxn = await prisma.sSLCommerzTransaction.findUnique({ where: { tranId: transactionId } });
    if (sslTxn) {
      const payment = await prisma.payment.findUnique({ where: { id: sslTxn.paymentId }, select: { id: true, status: true, meta: true } });
      if (!payment) throw new Error("Payment not found for transaction");
      if (PAID_STATES.includes(payment.status) || reconciliationOf(payment.meta)) return payment;
      const verified = await paymentService.verifiedSslcommerzOutcome(transactionId);
      if (verified.kind === "PAID") return this.verifyAndConfirmByTransactionId(transactionId, { valId: verified.valId });
      if (verified.kind === "FAILED") return paymentService.handleFailedPayment(transactionId, "Confirmed failed by SSLCommerz");
      if (verified.kind === "CANCELLED") return paymentService.handleCancelledPayment(transactionId);
      return recordGatewayReport(prisma, payment.id, outcome);
    }

    const epsPayment = await findGatewayPayment(PaymentMethod.EPS, "merchantTransactionId", transactionId);
    if (!epsPayment) throw new Error("Transaction not found for any configured gateway");
    // A stray/forged fail-cancel hit must never downgrade money we already received.
    if (PAID_STATES.includes(epsPayment.status) || reconciliationOf(epsPayment.meta)) return epsPayment;

    const credential = epsPayment.paymentProvider?.payment_credentials.find((c) => c.environment === ENVIRONMENT);
    let gatewayStatus: string | null = null;
    if (epsPayment.paymentProvider && credential) {
      try {
        gatewayStatus = (await epsService.checkTransactionStatus(epsPayment.paymentProvider, credential as any, transactionId)).status;
      } catch {
        gatewayStatus = null;
      }
    }
    if (gatewayStatus === "Success") return this.verifyAndConfirmByTransactionId(transactionId);
    if (gatewayStatus === "Failed" || gatewayStatus === "Cancelled") {
      return prisma.payment.update({
        where: { id: epsPayment.id },
        data: {
          status: PaymentStatus.FAILED,
          meta: { ...(epsPayment.meta as any), epsStatus: gatewayStatus, epsOutcome: gatewayStatus === "Cancelled" ? "CANCELLED" : "FAILED" },
        },
      });
    }
    return recordGatewayReport(prisma, epsPayment.id, outcome);
  }

  // ==================== ADMIN CRUD (mirrors courier admin pattern) ====================

  async getAllProviders() {
    const providers = await prisma.paymentProvider.findMany({
      include: { payment_credentials: true },
      orderBy: [{ isActive: "desc" }, { priority: "asc" }],
    });
    return providers.map((p) => ({ ...p, payment_credentials: p.payment_credentials.map((c) => redactCredential(c)) }));
  }

  async createProvider(data: {
    name: string;
    displayName?: string;
    description?: string;
    logo?: string;
    sandboxBaseUrl?: string;
    productionBaseUrl: string;
    authType: "BASIC" | "TOKEN";
    priority?: number;
  }) {
    const id = data.name.toLowerCase().replace(/\s+/g, "_");
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return prisma.paymentProvider.create({
      data: { id, slug, isActive: false, priority: data.priority ?? 100, ...data },
    });
  }

  /**
   * Create or update the credential for one provider + environment.
   * Blank/undefined fields are ignored, so a partial update (e.g. rotating
   * just the password) keeps every other saved value.
   */
  async upsertCredential(providerId: string, environment: "SANDBOX" | "PRODUCTION", data: CredentialInput) {
    const cleaned: CredentialInput = {};
    for (const [k, v] of Object.entries(data) as [keyof CredentialInput, string | undefined | null][]) {
      if (typeof v === "string" && v.trim() !== "") cleaned[k] = v.trim();
    }

    // The cached bearer token (EPS) was minted with the OLD username/password/hashKey — drop it.
    const authChanged = "username" in cleaned || "password" in cleaned || "hashKey" in cleaned;
    const update = { ...cleaned, ...(authChanged ? { accessToken: null, tokenExpiresAt: null } : {}) };

    const saved = await prisma.paymentCredential.upsert({
      where: { paymentProviderId_environment: { paymentProviderId: providerId, environment } },
      create: { paymentProviderId: providerId, environment, ...cleaned },
      update,
    });
    return redactCredential(saved);
  }

  /**
   * A gateway may only go live if checkout can actually use it: an enabled
   * credential for the CURRENT environment with every field that gateway needs.
   * (e.g. EPS without merchantId fails InitializeEPS with an opaque HTTP 400.)
   */
  private async assertProviderReady(providerId: string) {
    const provider = await prisma.paymentProvider.findUnique({
      where: { id: providerId },
      include: { payment_credentials: { where: { environment: ENVIRONMENT } } },
    });
    if (!provider) throw new Error("Payment gateway not found");

    const label = provider.displayName || provider.name;
    const credential = provider.payment_credentials[0];
    if (!credential || !credential.isActive) {
      throw new Error(`${label} has no enabled ${ENVIRONMENT} credentials — add them before activating.`);
    }

    const required = REQUIRED_CREDENTIAL_FIELDS[provider.name.toUpperCase()] ?? [];
    const missing = required.filter((f) => !credential[f]);
    if (missing.length) {
      throw new Error(`${label} ${ENVIRONMENT} credentials are missing: ${missing.join(", ")}.`);
    }
  }

  /**
   * Activate exactly ONE gateway, deactivating every other one in the same
   * transaction. This is the "admin flips a switch, storefront follows"
   * behavior the checkout UI relies on.
   */
  async setActiveProvider(providerId: string) {
    await this.assertProviderReady(providerId);
    return prisma.$transaction([
      prisma.paymentProvider.updateMany({ data: { isActive: false }, where: { id: { not: providerId } } }),
      prisma.paymentProvider.update({ where: { id: providerId }, data: { isActive: true } }),
    ]);
  }

  async deactivateProvider(providerId: string) {
    return prisma.paymentProvider.update({ where: { id: providerId }, data: { isActive: false } });
  }
}

export const paymentGatewayService = new PaymentGatewayService();
export default paymentGatewayService;