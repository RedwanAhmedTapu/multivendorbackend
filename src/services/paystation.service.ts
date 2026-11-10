// src/services/paystation.service.ts
//
// PayStation (paystation.com.bd) hosted-checkout integration.
// Docs: https://www.paystation.com.bd (API v1 & v2)
//
// Flow:
//   1. POST {base}/initiate-payment      -> payment_url (redirect the customer there)
//   2. Customer pays, PayStation redirects the browser to callback_url AND
//      (for successful payments only) POSTs a JSON IPN to the merchant's IPN URL.
//   3. POST {base}/transaction-status (header: merchantId, body: invoice_number)
//      -> THE authoritative check. Never mark an order paid from the callback
//      query-string or the IPN body alone; both are plain, unauthenticated HTTP.
//
// Credentials (from PaymentCredential): merchantId + password. No token / HMAC.
import axios from "axios";

interface PaystationCredentialRow {
  merchantId: string | null;
  password: string | null;
  environment: "SANDBOX" | "PRODUCTION";
}

interface PaystationProviderRow {
  sandboxBaseUrl: string | null;
  productionBaseUrl: string;
}

// Used when the provider row doesn't carry a URL. Note: sandbox NEVER falls
// back to the production URL — a missing sandbox URL must not hit live money.
const DEFAULT_BASE_URL = {
  SANDBOX: "https://sandbox.paystation.com.bd",
  PRODUCTION: "https://api.paystation.com.bd",
} as const;

export type PaystationTrxStatus = "success" | "failed" | "processing" | "refund" | "not_found" | "unknown";

export interface PaystationStatusResult {
  status: PaystationTrxStatus;
  trxId: string | null;
  paymentAmount: number | null;
  paymentMethod: string | null;
  raw: any;
}

export class PaystationService {
  private baseUrl(provider: PaystationProviderRow, credential: PaystationCredentialRow): string {
    const url =
      credential.environment === "SANDBOX"
        ? provider.sandboxBaseUrl || DEFAULT_BASE_URL.SANDBOX
        : provider.productionBaseUrl || DEFAULT_BASE_URL.PRODUCTION;
    return url.replace(/\/+$/, "");
  }

  /**
   * Create a hosted-checkout session. `invoiceNumber` must be unique per
   * attempt (PayStation rejects duplicates with status_code 1008).
   */
  async initializePayment(
    provider: PaystationProviderRow,
    credential: PaystationCredentialRow,
    input: {
      invoiceNumber: string;
      amount: number;
      customerName: string;
      customerPhone: string;
      customerEmail: string;
      customerAddress?: string;
      callbackUrl: string;
      reference?: string;
      checkoutItems?: string;
      optA?: string;
      optB?: string;
      optC?: string;
      /** true = customer bears the gateway charge, false = merchant bears it */
      payWithCharge?: boolean;
    },
  ): Promise<{ paymentUrl: string }> {
    if (!credential.merchantId || !credential.password) {
      throw new Error("PayStation credential is missing merchantId/password");
    }

    const body = new URLSearchParams();
    body.set("merchantId", credential.merchantId);
    body.set("password", credential.password);
    body.set("invoice_number", input.invoiceNumber);
    body.set("currency", "BDT");
    // Trim float noise (1250.5 -> "1250.5", 1250 -> "1250") without rounding the value.
    body.set("payment_amount", String(Number(input.amount.toFixed(2))));
    body.set("pay_with_charge", input.payWithCharge ? "1" : "0");
    body.set("cust_name", input.customerName);
    body.set("cust_phone", input.customerPhone);
    body.set("cust_email", input.customerEmail);
    body.set("callback_url", input.callbackUrl);
    if (input.customerAddress) body.set("cust_address", input.customerAddress);
    if (input.reference) body.set("reference", input.reference);
    if (input.checkoutItems) body.set("checkout_items", input.checkoutItems);
    if (input.optA) body.set("opt_a", input.optA);
    if (input.optB) body.set("opt_b", input.optB);
    if (input.optC) body.set("opt_c", input.optC);

    let data: any;
    try {
      const response = await axios.post(`${this.baseUrl(provider, credential)}/initiate-payment`, body.toString(), {
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 30_000,
      });
      data = response.data;
    } catch (error: any) {
      throw new Error(`PayStation initiate-payment failed: ${error.response?.data?.message || error.message}`);
    }

    if (String(data?.status_code) !== "200" || data?.status !== "success" || !data?.payment_url) {
      throw new Error(`PayStation initiate-payment failed: ${data?.message || "no payment_url returned"}`);
    }
    return { paymentUrl: data.payment_url };
  }

  /**
   * Transaction Status v1 — look up by OUR invoice number. This is the only
   * call whose result may mark an order paid.
   */
  async checkTransactionStatus(
    provider: PaystationProviderRow,
    credential: PaystationCredentialRow,
    invoiceNumber: string,
  ): Promise<PaystationStatusResult> {
    if (!credential.merchantId) {
      throw new Error("PayStation credential is missing merchantId");
    }

    let data: any;
    try {
      const response = await axios.post(
        `${this.baseUrl(provider, credential)}/transaction-status`,
        new URLSearchParams({ invoice_number: invoiceNumber }).toString(),
        {
          headers: {
            merchantId: credential.merchantId,
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          timeout: 30_000,
        },
      );
      data = response.data;
    } catch (error: any) {
      // PayStation may answer 2001 with a non-2xx HTTP code — treat "not found" as a normal outcome.
      const errData = error.response?.data;
      if (String(errData?.status_code) === "2001") {
        return { status: "not_found", trxId: null, paymentAmount: null, paymentMethod: null, raw: errData };
      }
      throw new Error(`PayStation transaction-status failed: ${errData?.message || error.message}`);
    }

    if (String(data?.status_code) === "2001") {
      return { status: "not_found", trxId: null, paymentAmount: null, paymentMethod: null, raw: data };
    }
    if (String(data?.status_code) !== "200" || !data?.data) {
      throw new Error(`PayStation transaction-status failed: ${data?.message || "unexpected response"}`);
    }

    const t = data.data;
    const amount = Number(t.payment_amount);
    return {
      status: this.normalizeStatus(t.trx_status),
      trxId: t.trx_id || null,
      paymentAmount: Number.isFinite(amount) ? amount : null,
      paymentMethod: t.payment_method || null,
      raw: data,
    };
  }

  // The docs show both "Success" and "success" — compare case-insensitively.
  private normalizeStatus(raw: unknown): PaystationTrxStatus {
    const s = String(raw ?? "").trim().toLowerCase();
    if (s === "success" || s === "successful") return "success";
    if (s === "failed" || s === "fail") return "failed";
    if (s === "processing" || s === "pending") return "processing";
    if (s === "refund" || s === "refunded") return "refund";
    return "unknown";
  }
}

export const paystationService = new PaystationService();
export default paystationService;