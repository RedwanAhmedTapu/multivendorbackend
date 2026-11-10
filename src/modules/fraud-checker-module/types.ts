// ============================================================
// Shared contract every fraud-checker provider adapter must follow.
// Adding a new provider (e.g. FraudShield BD, Mr Fraud Checker) means:
//   1. Write one file implementing IFraudCheckerAdapter (providers/*.ts)
//   2. Register it with one line in providers/registry.ts
//   3. Add its row (with encrypted credentials) via the admin panel
// No other file in the app needs to change.
// ============================================================

export type RiskLevel = "low" | "medium" | "high" | "very_high" | "unknown";

/** Per-courier breakdown, normalized across providers that report differently. */
export interface CourierBreakdown {
  courierName: string;
  totalParcels: number;
  delivered: number;
  returned: number;
  /** Some providers (e.g. Pathao's newer rating system) give a rating instead of counts. */
  ratingOnly?: boolean;
  customerRating?: string;
}

/** A merchant-submitted fraud incident against a phone number, when a provider offers this (e.g. BD Courier's `reports`). */
export interface FraudReport {
  id: string;
  name: string;
  details: string;
  createdAt: string;
  courierName?: string;
}

/** The shape every adapter must return, regardless of the underlying API's format. */
export interface NormalizedFraudCheckResult {
  providerSlug: string;
  phone: string;
  totalParcels: number;
  delivered: number;
  returned: number;
  successRate: number; // 0-100
  riskLevel: RiskLevel;
  couriers: CourierBreakdown[];
  /** Explicit merchant fraud reports against this number, when the provider exposes them. Absent/empty for providers that don't. */
  fraudReports?: FraudReport[];
  /** Original provider response, kept for debugging / FraudCheckLog.responseJson. */
  raw: unknown;
}

/** Declares which credential fields a provider needs, so the admin form can render them generically. */
export interface CredentialField {
  key: string;
  label: string;
  secret: boolean; // true = mask in UI, e.g. apiSecret; false = e.g. a non-secret account id
}

export interface IFraudCheckerAdapter {
  /** Must match FraudCheckerProvider.slug in the database. */
  readonly slug: string;
  readonly displayName: string;
  readonly credentialFields: CredentialField[];

  /**
   * Runs the actual HTTP call against the provider and returns a
   * normalized result. `credentials` is the decrypted object for this
   * provider's row. `config` is the row's non-secret configJson
   * (timeoutMs, custom baseUrl override, etc.).
   */
  checkPhone(
    phone: string,
    credentials: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<NormalizedFraudCheckResult>;
}

export class FraudCheckerError extends Error {
  public readonly providerSlug: string;
  public readonly cause?: unknown;

  constructor(message: string, providerSlug: string, cause?: unknown) {
    super(message);
    this.name = "FraudCheckerError";
    this.providerSlug = providerSlug;
    this.cause = cause;
  }
}