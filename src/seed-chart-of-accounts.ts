// seed-chart-of-accounts.ts
//
// Server start howar somoy call korle:
//   Platform (Admin)-er mandatory 20 ta COA account auto create kore (na thakle)
//
// ⚠️ Vendor COA is NO LONGER seeded here. It's created per-vendor, on-demand,
// when that vendor is approved/verified — see VendorService.ensureVendorChartOfAccounts.
// This avoids creating 13 unused ledger accounts for vendors who never get approved.
//
// Idempotent: proti account create-er age findFirst() diye check kora hoy.

import { prisma } from "./config/prisma.ts";
import { EntityType } from "@prisma/client";
import { PLATFORM_ACCOUNTS, type AccountSeed } from "./constants/chartOfAccountTemplates.ts";

async function upsertAccount(
  account: AccountSeed,
  entityType: EntityType,
  entityId: string | null,
  isSystem = true,
): Promise<void> {
  const { code, name, accountClass, accountType, group, nature } = account;

  const existing = await prisma.chartOfAccount.findFirst({
    where: { code, entityType, entityId },
  });

  if (existing) return;

  await prisma.chartOfAccount.create({
    data: {
      code,
      name,
      accountClass,
      accountType,
      group,
      nature,
      entityType,
      entityId,
      isSystem,
      isActive: true,
      canDelete: false,
      description: `Auto-seeded system account: ${name}`,
    },
  });
}

export async function seedChartOfAccounts(): Promise<void> {
  console.log('[COA Seed] Starting Platform Chart of Accounts sync...');

  for (const acc of PLATFORM_ACCOUNTS) {
    await upsertAccount(acc, EntityType.ADMIN, null);
  }

  console.log(`[COA Seed] Platform accounts synced: ${PLATFORM_ACCOUNTS.length}`);
  console.log('[COA Seed] Done.');
}