import { PrismaClient } from "@prisma/client";
import { decryptCredentials } from "./credential-cipher.ts";
import { getAdapter } from "./providers/registry.ts";
import { FraudCheckerError, type NormalizedFraudCheckResult } from "./types.ts";

const prisma = new PrismaClient();

const PHONE_REGEX = /^01[3-9]\d{8}$/; // Bangladeshi mobile format

export class FraudCheckerService {
  /**
   * Runs a phone number through every ACTIVE provider in priority order
   * until one succeeds. If a provider errors and its row has
   * fallbackOnError = true, the next provider is tried; otherwise the
   * error is thrown immediately. Every attempt (success or failure) is
   * written to FraudCheckLog for the admin dashboard.
   *
   * Returns null if no active providers are configured at all — callers
   * (e.g. order risk scoring) should treat that as "fraud check
   * unavailable" rather than "customer is risky".
   */
  async checkPhone(phone: string): Promise<NormalizedFraudCheckResult | null> {
    if (!PHONE_REGEX.test(phone)) {
      throw new FraudCheckerError(`Invalid Bangladeshi phone number: ${phone}`, "validation");
    }

    const providerRows = await prisma.fraudCheckerProvider.findMany({
      where: { isActive: true },
      orderBy: { priority: "asc" },
    });

    if (providerRows.length === 0) return null;

    let lastError: Error | null = null;

    for (const row of providerRows) {
      const adapter = getAdapter(row.slug);
      if (!adapter) {
        // A row exists in the DB pointing at a slug with no matching
        // adapter registered in code — skip it rather than crash, but
        // this is worth surfacing to admins (e.g. via a health-check
        // endpoint that flags orphaned provider rows).
        continue;
      }

      const startedAt = Date.now();
      try {
        const credentials = decryptCredentials(row.credentialsEncrypted);
        const config = (row.configJson as Record<string, unknown>) ?? {};
        if (row.baseUrl) config.baseUrl = row.baseUrl;

        const result = await adapter.checkPhone(phone, credentials, config);

        await prisma.fraudCheckLog.create({
          data: {
            providerId: row.id,
            phone,
            success: true,
            riskLevel: result.riskLevel,
            responseJson: result.raw as any,
            latencyMs: Date.now() - startedAt,
          },
        });

        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;

        await prisma.fraudCheckLog.create({
          data: {
            providerId: row.id,
            phone,
            success: false,
            errorMessage: error.message,
            latencyMs: Date.now() - startedAt,
          },
        });

        if (!row.fallbackOnError) throw error;
        // else: fall through to the next provider in priority order
      }
    }

    // Every active provider failed.
    throw lastError ?? new FraudCheckerError("All fraud-checker providers failed.", "unknown");
  }

  /** Used by the admin panel's "Test Connection" button when saving a provider row. */
  async testProvider(providerId: string, samplePhone: string): Promise<NormalizedFraudCheckResult> {
    const row = await prisma.fraudCheckerProvider.findUniqueOrThrow({ where: { id: providerId } });
    const adapter = getAdapter(row.slug);
    if (!adapter) throw new FraudCheckerError(`No adapter registered for slug "${row.slug}".`, row.slug);

    const credentials = decryptCredentials(row.credentialsEncrypted);
    const config = (row.configJson as Record<string, unknown>) ?? {};
    if (row.baseUrl) config.baseUrl = row.baseUrl;

    return adapter.checkPhone(samplePhone, credentials, config);
  }
}

export const fraudCheckerService = new FraudCheckerService();
