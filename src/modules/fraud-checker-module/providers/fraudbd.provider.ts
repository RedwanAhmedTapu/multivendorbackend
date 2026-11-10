import type { CredentialField, IFraudCheckerAdapter, NormalizedFraudCheckResult, RiskLevel } from "../types.ts";
import { FraudCheckerError } from "../types.ts";

const DEFAULT_BASE_URL = "https://fraudbd.com/api/check-courier-info";

interface FraudBdRatingSummary {
  data_type: "rating";
  customer_rating: string;
  risk_level: RiskLevel;
  success_rate?: number;
  total: number;
  success: number;
  cancel: number;
}

interface FraudBdDeliverySummary {
  data_type: "delivery";
  total: number;
  success: number;
  cancel: number;
}

type FraudBdSummary = FraudBdRatingSummary | FraudBdDeliverySummary;

interface FraudBdResponse {
  status: boolean;
  message: string;
  data: {
    Summaries: Record<string, FraudBdSummary>;
    totalSummary: { total: number; success: number; cancel: number; successRate: number; cancelRate: number };
  } | null;
}

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, very_high: 3, unknown: 1 };

function worstRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

function riskFromRate(rate: number): RiskLevel {
  if (Number.isNaN(rate)) return "unknown";
  if (rate >= 85) return "low";
  if (rate >= 60) return "medium";
  if (rate >= 30) return "high";
  return "very_high";
}

export const fraudBdProvider: IFraudCheckerAdapter = {
  slug: "fraudbd",
  displayName: "FraudBD.com — Multi-Courier Check",
  credentialFields: [{ key: "apiKey", label: "API Key", secret: true }] satisfies CredentialField[],

  async checkPhone(phone, credentials, config) {
    const apiKey = credentials.apiKey as string | undefined;
    if (!apiKey) {
      throw new FraudCheckerError("Missing apiKey for FraudBD provider.", "fraudbd");
    }

    const baseUrl = (config?.baseUrl as string) || DEFAULT_BASE_URL;
    const timeoutMs = (config?.timeoutMs as number) || 8000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", api_key: apiKey },
        body: JSON.stringify({ phone_number: phone }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new FraudCheckerError(`FraudBD request failed: ${(err as Error).message}`, "fraudbd", err);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      throw new FraudCheckerError("FraudBD rate limit exceeded.", "fraudbd");
    }
    if (!response.ok) {
      throw new FraudCheckerError(`FraudBD returned HTTP ${response.status}.`, "fraudbd");
    }

    let data: FraudBdResponse;
    try {
      data = (await response.json()) as FraudBdResponse;
    } catch {
      throw new FraudCheckerError(
        `FraudBD returned a non-JSON response (check the endpoint URL: ${baseUrl}).`,
        "fraudbd",
      );
    }
    if (!data.status || !data.data) {
      throw new FraudCheckerError(data.message || "FraudBD returned an unsuccessful response.", "fraudbd");
    }

    const couriers: NormalizedFraudCheckResult["couriers"] = [];
    let ratingRisk: RiskLevel | null = null;

    for (const [name, summary] of Object.entries(data.data.Summaries)) {
      if (summary.data_type === "rating") {
        ratingRisk = summary.risk_level;
        couriers.push({
          courierName: name,
          totalParcels: 0,
          delivered: 0,
          returned: 0,
          ratingOnly: true,
          customerRating: summary.customer_rating,
        });
      } else {
        couriers.push({
          courierName: name,
          totalParcels: summary.total,
          delivered: summary.success,
          returned: summary.cancel,
        });
      }
    }

    const { total, success, cancel, successRate } = data.data.totalSummary;
    let riskLevel = riskFromRate(successRate);
    if (ratingRisk) riskLevel = worstRisk(riskLevel, ratingRisk);

    const result: NormalizedFraudCheckResult = {
      providerSlug: "fraudbd",
      phone,
      totalParcels: total,
      delivered: success,
      returned: cancel,
      successRate,
      riskLevel,
      couriers,
      raw: data,
    };
    return result;
  },
};