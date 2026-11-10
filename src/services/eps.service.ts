// src/services/eps.service.ts
//
// EPS (Easy Payment System, eps.com.bd) Merchant API integration.
// Based on "EPS Merchant API Integration Guide V0.4" (Jan 2024).
//
// Flow:
//   1. GetToken            — exchange username/password for a bearer token
//   2. InitializeEPS       — start a transaction, get a RedirectURL
//   3. CheckMerchantTransactionStatus — verify what actually happened
//      (this is the ONLY call that should ever mark an order paid —
//      exactly like SSLCommerz's validatePayment; never trust a client
//      redirect/query-string by itself)
//
// Every request needs an `x-hash` header:
//   x-hash = Base64( HMAC-SHA512( key = UTF8(hashKey), data = <field> ) )
// where <field> is `userName` for GetToken and `merchantTransactionId` for
// InitializeEPS / CheckMerchantTransactionStatus.
//
// FIX (see chat history): InitializeEPS was returning HTTP 400 because
// `merchantId` was never sent in the body at all (EPS docs list it as
// Mandatory), and `storeId` was being passed in per-call by the caller
// instead of being read from the stored PaymentCredential row — both are
// merchant-level constants from the EPS portal, not order-level data, so
// both now come from `credential`.
import crypto from "crypto";
import axios from "axios";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function computeXHash(hashKey: string, value: string): string {
  return crypto.createHmac("sha512", Buffer.from(hashKey, "utf8")).update(value, "utf8").digest("base64");
}

interface EpsCredentialRow {
  id: string;
  username: string | null;
  password: string | null;
  hashKey: string | null;
  storeId: string | null; // merchant-level constant from the EPS portal
  merchantId: string | null; // merchant-level constant from the EPS portal — required by InitializeEPS
  accessToken: string | null;
  tokenExpiresAt: Date | null;
  environment: "SANDBOX" | "PRODUCTION";
}

interface EpsProviderRow {
  sandboxBaseUrl: string | null;
  productionBaseUrl: string;
}

export class EpsService {
  private baseUrl(provider: EpsProviderRow, credential: EpsCredentialRow): string {
    return credential.environment === "SANDBOX"
      ? provider.sandboxBaseUrl || provider.productionBaseUrl
      : provider.productionBaseUrl;
  }

  /**
   * API No. 01 — GetToken. Caches the token on the credential row and
   * reuses it until close to expiry, the same pattern already used for
   * Pathao's OAuth2 token in courier.service.ts.
   */
  async getToken(provider: EpsProviderRow, credential: EpsCredentialRow): Promise<string> {
    if (!credential.username || !credential.password || !credential.hashKey) {
      throw new Error("EPS credential is missing username/password/hashKey");
    }

    const now = new Date();
    const expiryBuffer = new Date(now.getTime() + 5 * 60_000);
    if (credential.accessToken && credential.tokenExpiresAt && credential.tokenExpiresAt > expiryBuffer) {
      return credential.accessToken;
    }

    const baseUrl = this.baseUrl(provider, credential);
    const xHash = computeXHash(credential.hashKey, credential.username);

    try {
      const response = await axios.post(
        `${baseUrl}/v1/Auth/GetToken`,
        { userName: credential.username, password: credential.password },
        { headers: { "x-hash": xHash, "Content-Type": "application/json" } },
      );

      const { token, expireDate, errorMessage, errorCode } = response.data;
      if (errorCode || !token) {
        throw new Error(errorMessage || "EPS GetToken failed");
      }

      await prisma.paymentCredential.update({
        where: { id: credential.id },
        data: { accessToken: token, tokenExpiresAt: new Date(expireDate) },
      });

      return token;
    } catch (error: any) {
      throw new Error(`EPS GetToken failed: ${error.response?.data?.errorMessage || error.message}`);
    }
  }

  /**
   * API No. 02 — Initialize Payment. Returns EPS's own TransactionId (used
   * later to verify) and the RedirectURL to send the customer's browser to.
   *
   * `merchantId` and `storeId` are no longer accepted as order-level input
   * — they're merchant constants, read from `credential`. If either is
   * missing on the credential row, this fails fast with a clear error
   * instead of letting EPS's API return an opaque 400.
   */
  async initializePayment(
    provider: EpsProviderRow,
    credential: EpsCredentialRow,
    order: {
      customerOrderId: string;
      merchantTransactionId: string; // must be unique, 10+ digits, per EPS docs
      transactionTypeId: number; // 1=Web, 2=Android, 3=iOS
      totalAmount: number;
      successUrl: string;
      failUrl: string;
      cancelUrl: string;
      customerName: string;
      customerEmail: string;
      customerAddress: string;
      customerCity: string;
      customerState: string;
      customerPostcode: string;
      customerCountry: string;
      customerPhone: string;
      productName: string;
      ipAddress: string;
    },
  ): Promise<{ transactionId: string; redirectUrl: string }> {
    if (!credential.merchantId || !credential.storeId) {
      throw new Error("EPS credential is missing merchantId/storeId");
    }

    const token = await this.getToken(provider, credential);
    const baseUrl = this.baseUrl(provider, credential);
    const xHash = computeXHash(credential.hashKey!, order.merchantTransactionId);

    const body = {
      merchantId: credential.merchantId, // FIX: was missing entirely — root cause of the 400
      storeId: credential.storeId, // FIX: now sourced from credential, not caller input
      CustomerOrderId: order.customerOrderId,
      merchantTransactionId: order.merchantTransactionId,
      transactionTypeId: order.transactionTypeId,
      financialEntityId: 0,
      transitionStatusId: 0,
      totalAmount: order.totalAmount,
      ipAddress: order.ipAddress,
      version: "1",
      successUrl: order.successUrl,
      failUrl: order.failUrl,
      cancelUrl: order.cancelUrl,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      CustomerAddress: order.customerAddress,
      CustomerCity: order.customerCity,
      CustomerState: order.customerState,
      CustomerPostcode: order.customerPostcode,
      CustomerCountry: order.customerCountry,
      CustomerPhone: order.customerPhone,
      ShippingMethod: "NO",
      NoOfItem: "1",
      ProductName: order.productName,
      ProductProfile: "general",
      ProductCategory: "general",
    };

    try {
      const response = await axios.post(`${baseUrl}/v1/EPSEngine/InitializeEPS`, body, {
        headers: {
          "x-hash": xHash,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      const { TransactionId, RedirectURL, ErrorMessage, ErrorCode } = response.data;
      if (ErrorCode || !RedirectURL) {
        throw new Error(ErrorMessage || "EPS InitializeEPS failed");
      }

      return { transactionId: TransactionId, redirectUrl: RedirectURL };
    } catch (error: any) {
      throw new Error(`EPS InitializeEPS failed: ${error.response?.data?.ErrorMessage || error.message}`);
    }
  }

  /**
   * API No. 03 — Verify Transaction. THE authoritative check — call this
   * from your own server before marking anything paid, the same way
   * SSLCommerzService.validatePayment() is the authority for SSLCommerz.
   * `merchantTransactionId` is the SAME value you generated and sent to
   * InitializeEPS (not EPS's own TransactionId).
   */
  async checkTransactionStatus(
    provider: EpsProviderRow,
    credential: EpsCredentialRow,
    merchantTransactionId: string,
  ): Promise<{
    status: "Success" | "Failed" | "Cancelled" | "Pending" | string;
    totalAmount: string;
    transactionDate: string;
    financialEntity: string;
    raw: any;
  }> {
    const token = await this.getToken(provider, credential);
    const baseUrl = this.baseUrl(provider, credential);
    const xHash = computeXHash(credential.hashKey!, merchantTransactionId);

    try {
      const response = await axios.get(
        `${baseUrl}/v1/EPSEngine/CheckMerchantTransactionStatus`,
        {
          params: { merchantTransactionId },
          headers: { "x-hash": xHash, Authorization: `Bearer ${token}` },
        },
      );

      return {
        status: response.data.Status,
        totalAmount: response.data.TotalAmount,
        transactionDate: response.data.TransactionDate,
        financialEntity: response.data.FinancialEntity,
        raw: response.data,
      };
    } catch (error: any) {
      throw new Error(`EPS CheckMerchantTransactionStatus failed: ${error.response?.data?.ErrorMessage || error.message}`);
    }
  }
}

export const epsService = new EpsService();
export default epsService;