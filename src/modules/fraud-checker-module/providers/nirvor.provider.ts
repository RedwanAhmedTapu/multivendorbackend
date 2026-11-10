import type { CredentialField, IFraudCheckerAdapter, NormalizedFraudCheckResult, RiskLevel } from "../types.ts";
import { FraudCheckerError } from "../types.ts";

const DEFAULT_BASE_URL = "https://nirvor.app/api/v1/search";

interface NirvorCourierBlock {
  courier_name: string;
  total_parcels: number;
  delivered: number;
  returned: number;
  error?: string;
}

interface NirvorResponse {
  success: boolean;
  phone: string;
  error?: string;
  overall: { total_parcels: number; delivered: number; returned: number };
  pathao?: NirvorCourierBlock;
  redx?: NirvorCourierBlock;
  paperfly?: NirvorCourierBlock;
  steadfast?: NirvorCourierBlock;
}

function riskFromSuccessRate(rate: number): RiskLevel {
  if (Number.isNaN(rate)) return "unknown";
  if (rate >= 85) return "low";
  if (rate >= 60) return "medium";
  if (rate >= 30) return "high";
  return "very_high";
}

export const nirvorProvider: IFraudCheckerAdapter = {
  slug: "nirvor",
  displayName: "Nirvor.app — Courier Fraud Check",
  credentialFields: [
    { key: "apiKey", label: "API Key", secret: true },
    { key: "apiSecret", label: "API Secret", secret: true },
  ] satisfies CredentialField[],

  async checkPhone(phone, credentials, config) {
    const apiKey = credentials.apiKey as string | undefined;
    const apiSecret = credentials.apiSecret as string | undefined;
    if (!apiKey || !apiSecret) {
      throw new FraudCheckerError("Missing apiKey/apiSecret for Nirvor provider.", "nirvor");
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
          "X-API-Key": apiKey,
          "X-API-Secret": apiSecret,
        },
        body: JSON.stringify({ phone }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new FraudCheckerError(`Nirvor request failed: ${(err as Error).message}`, "nirvor", err);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      throw new FraudCheckerError("Nirvor daily API limit exceeded.", "nirvor");
    }
    if (!response.ok) {
      throw new FraudCheckerError(`Nirvor returned HTTP ${response.status}.`, "nirvor");
    }

    const data = (await response.json()) as NirvorResponse;
    if (!data.success) {
      throw new FraudCheckerError(data.error || "Nirvor returned an unsuccessful response.", "nirvor");
    }

    const courierBlocks: [string, NirvorCourierBlock | undefined][] = [
      ["Pathao", data.pathao],
      ["RedX", data.redx],
      ["Paperfly", data.paperfly],
      ["Steadfast", data.steadfast],
    ];

    const couriers = courierBlocks
      .filter(([, block]) => block && !block.error)
      .map(([name, block]) => ({
        courierName: name,
        totalParcels: block!.total_parcels,
        delivered: block!.delivered,
        returned: block!.returned,
      }));

    const { total_parcels, delivered, returned } = data.overall;
    const successRate = total_parcels > 0 ? Math.round((delivered / total_parcels) * 10000) / 100 : 0;

    const result: NormalizedFraudCheckResult = {
      providerSlug: "nirvor",
      phone: data.phone,
      totalParcels: total_parcels,
      delivered,
      returned,
      successRate,
      riskLevel: riskFromSuccessRate(successRate),
      couriers,
      raw: data,
    };
    return result;
  },
};
