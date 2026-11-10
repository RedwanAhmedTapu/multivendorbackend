import type { CredentialField, FraudReport, IFraudCheckerAdapter, NormalizedFraudCheckResult, RiskLevel } from "../types.ts";
import { FraudCheckerError } from "../types.ts";

const DEFAULT_BASE_URL = "https://api.bdcourier.com/courier-check";

interface BdCourierEntry {
  name: string;
  logo: string;
  total_parcel: number;
  success_parcel: number;
  cancelled_parcel: number;
  success_ratio: number;
}

interface BdCourierSummary {
  total_parcel: number;
  success_parcel: number;
  cancelled_parcel: number;
  success_ratio: number;
}

interface BdCourierReport {
  id: string;
  name: string;
  details: string;
  created_at: string;
  courierLogo?: string;
  courierName?: string;
}

interface BdCourierResponse {
  status: "success" | "error";
  message?: string;
  data?: {
    summary: BdCourierSummary;
    [courierSlug: string]: BdCourierEntry | BdCourierSummary; // every key except "summary" is a BdCourierEntry
  };
  reports?: BdCourierReport[];
}

function riskFromSuccessRatio(rate: number): RiskLevel {
  if (Number.isNaN(rate)) return "unknown";
  if (rate >= 85) return "low";
  if (rate >= 60) return "medium";
  if (rate >= 30) return "high";
  return "very_high";
}

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, very_high: 3, unknown: 1 };
function worstRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

export const bdCourierProvider: IFraudCheckerAdapter = {
  slug: "bdcourier",
  displayName: "BD Courier — Multi-Courier + Fraud Reports",
  credentialFields: [{ key: "apiKey", label: "API Key", secret: true }] satisfies CredentialField[],

  async checkPhone(phone, credentials, config) {
    const apiKey = credentials.apiKey as string | undefined;
    if (!apiKey) {
      throw new FraudCheckerError("Missing apiKey for BD Courier provider.", "bdcourier");
    }

    const baseUrl = (config?.baseUrl as string) || DEFAULT_BASE_URL;
    const timeoutMs = (config?.timeoutMs as number) || 8000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ phone }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new FraudCheckerError(`BD Courier request failed: ${(err as Error).message}`, "bdcourier", err);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      throw new FraudCheckerError("BD Courier rate limit exceeded.", "bdcourier");
    }
    if (!response.ok) {
      throw new FraudCheckerError(`BD Courier returned HTTP ${response.status}.`, "bdcourier");
    }

    const data = (await response.json()) as BdCourierResponse;
    if (data.status !== "success" || !data.data) {
      throw new FraudCheckerError(data.message || "BD Courier returned an unsuccessful response.", "bdcourier");
    }

    const { summary, ...courierEntries } = data.data;

    const couriers = Object.values(courierEntries)
      .filter((entry): entry is BdCourierEntry => typeof entry === "object" && "total_parcel" in entry)
      .map((entry) => ({
        courierName: entry.name,
        totalParcels: entry.total_parcel,
        delivered: entry.success_parcel,
        returned: entry.cancelled_parcel,
      }));

    const fraudReports: FraudReport[] = (data.reports ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      details: r.details,
      createdAt: r.created_at,
      courierName: r.courierName,
    }));

    let riskLevel = riskFromSuccessRatio(summary.success_ratio);
    // An explicit merchant-reported fraud incident is a stronger, more direct
    // signal than a low delivery success ratio — never let it be masked by an
    // otherwise-decent success rate.
    if (fraudReports.length > 0) {
      riskLevel = worstRisk(riskLevel, "high");
    }

    const result: NormalizedFraudCheckResult = {
      providerSlug: "bdcourier",
      phone,
      totalParcels: summary.total_parcel,
      delivered: summary.success_parcel,
      returned: summary.cancelled_parcel,
      successRate: summary.success_ratio,
      riskLevel,
      couriers,
      fraudReports,
      raw: data,
    };
    return result;
  },
};