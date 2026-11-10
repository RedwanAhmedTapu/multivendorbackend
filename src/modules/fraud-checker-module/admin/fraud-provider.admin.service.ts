import { PrismaClient } from "@prisma/client";
import { encryptCredentials, decryptCredentials, maskCredentials } from "../credential-cipher.ts";
import { getAdapter, listRegisteredAdapters } from "../providers/registry.ts";

const prisma = new PrismaClient();

export interface CreateProviderInput {
  slug: string;
  name: string;
  baseUrl?: string;
  isActive?: boolean;
  priority?: number;
  fallbackOnError?: boolean;
  credentials: Record<string, unknown>; // plaintext in — encrypted before it touches the DB
  configJson?: Record<string, unknown>;
  createdById?: string;
}

export type UpdateProviderInput = Partial<Omit<CreateProviderInput, "slug">>;

function assertKnownSlug(slug: string) {
  if (!getAdapter(slug)) {
    const known = listRegisteredAdapters().map((a) => a.slug).join(", ");
    throw new Error(`Unknown provider slug "${slug}". Registered adapters: ${known}.`);
  }
}

/** Strips credentialsEncrypted out of a row and replaces it with a masked view for the admin UI. */
function toSafeView(row: any) {
  const { credentialsEncrypted, ...rest } = row;
  let maskedCredentials: Record<string, string> = {};
  try {
    maskedCredentials = maskCredentials(decryptCredentials(credentialsEncrypted));
  } catch {
    maskedCredentials = { error: "unable to decrypt — check FRAUD_CRED_ENCRYPTION_KEY" } as any;
  }
  return { ...rest, credentials: maskedCredentials };
}

export class FraudProviderAdminService {
  /** For the admin "Add Provider" dropdown: every adapter the code knows how to run,
   *  plus which credential fields it needs, plus whether it's already configured. */
  async listAvailableAdapters() {
    const configuredSlugs = new Set((await prisma.fraudCheckerProvider.findMany({ select: { slug: true } })).map((r) => r.slug));
    return listRegisteredAdapters().map((a) => ({
      slug: a.slug,
      displayName: a.displayName,
      credentialFields: a.credentialFields,
      alreadyConfigured: configuredSlugs.has(a.slug),
    }));
  }

  async listProviders() {
    const rows = await prisma.fraudCheckerProvider.findMany({ orderBy: { priority: "asc" } });
    return rows.map(toSafeView);
  }

  async getProvider(id: string) {
    const row = await prisma.fraudCheckerProvider.findUniqueOrThrow({ where: { id } });
    return toSafeView(row);
  }

  async createProvider(input: CreateProviderInput) {
    assertKnownSlug(input.slug);

    const row = await prisma.fraudCheckerProvider.create({
      data: {
        slug: input.slug,
        name: input.name,
        baseUrl: input.baseUrl,
        isActive: input.isActive ?? false,
        priority: input.priority ?? 0,
        fallbackOnError: input.fallbackOnError ?? true,
        credentialsEncrypted: encryptCredentials(input.credentials),
        configJson: input.configJson ?? undefined,
        createdById: input.createdById,
      },
    });
    return toSafeView(row);
  }

  async updateProvider(id: string, input: UpdateProviderInput) {
    const existing = await prisma.fraudCheckerProvider.findUniqueOrThrow({ where: { id } });

    const row = await prisma.fraudCheckerProvider.update({
      where: { id },
      data: {
        name: input.name ?? existing.name,
        baseUrl: input.baseUrl ?? existing.baseUrl,
        isActive: input.isActive ?? existing.isActive,
        priority: input.priority ?? existing.priority,
        fallbackOnError: input.fallbackOnError ?? existing.fallbackOnError,
        // Only re-encrypt if the admin actually submitted new credentials —
        // otherwise leave the existing ciphertext untouched.
        credentialsEncrypted: input.credentials ? encryptCredentials(input.credentials) : existing.credentialsEncrypted,
        configJson: input.configJson ?? existing.configJson ?? undefined,
      },
    });
    return toSafeView(row);
  }

  /** One-click enable/disable — the most common admin action, kept separate from full update. */
  async setActive(id: string, isActive: boolean) {
    const row = await prisma.fraudCheckerProvider.update({ where: { id }, data: { isActive } });
    return toSafeView(row);
  }

  async deleteProvider(id: string) {
    await prisma.fraudCheckerProvider.delete({ where: { id } });
    return { success: true };
  }

  /** Recent success/failure log for the admin dashboard's per-provider health view. */
  async getProviderLogs(id: string, limit = 50) {
    return prisma.fraudCheckLog.findMany({
      where: { providerId: id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}

export const fraudProviderAdminService = new FraudProviderAdminService();
