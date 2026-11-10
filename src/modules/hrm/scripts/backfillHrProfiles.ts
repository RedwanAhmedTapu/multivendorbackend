// src/modules/hrm/scripts/backfillHrProfiles.ts
//
// One-off script: creates an HrEmployeeProfile for every existing Employee
// row that doesn't have one yet (i.e. every employee created BEFORE the
// HRM module was wired into employee.service.ts).
//
// Safe to re-run — ensureProfile() is idempotent, and this script only
// looks at employees with no profile at all, so already-migrated employees
// are skipped automatically.
//
// Run once, from the project root:
//   npx tsx src/modules/hrm/scripts/backfillHrProfiles.ts
//   (or: npx ts-node --esm src/modules/hrm/scripts/backfillHrProfiles.ts)

import { prisma } from "../../../config/prisma.ts";
import { employeeProfileService } from "../services/employeeProfile.service.ts";

async function main() {
  const employeesWithoutProfile = await prisma.employee.findMany({
    where: { hrProfile: null },
    include: { user: true },
  });

  console.log(`Found ${employeesWithoutProfile.length} employee(s) without an HR profile.`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const employee of employeesWithoutProfile) {
    if (!employee.userId || !employee.user) {
      console.warn(`  ⚠ Skipping Employee ${employee.id} — no linked User row, cannot backfill.`);
      skipped++;
      continue;
    }

    try {
      await employeeProfileService.ensureProfile(
        { vendorId: employee.vendorId ?? null, actorUserId: employee.createdById ?? employee.userId, role: employee.vendorId ? "VENDOR" : "ADMIN" },
        {
          linkedUserId: employee.userId,
          linkedEmployeeId: employee.id,
          fullName: employee.user.name || employee.user.email || employee.user.phone || `Employee ${employee.id.slice(0, 6)}`,
        }
      );
      created++;
      console.log(`  ✓ Created HR profile for Employee ${employee.id} (${employee.user.name ?? employee.user.email ?? "unnamed"})`);
    } catch (err: any) {
      failed++;
      console.error(`  ✗ Failed for Employee ${employee.id}: ${err.message}`);
    }
  }

  console.log("\n── Backfill summary ──");
  console.log(`  Created: ${created}`);
  console.log(`  Skipped (no linked user): ${skipped}`);
  console.log(`  Failed:  ${failed}`);
}

main()
  .catch((err) => {
    console.error("Backfill script crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
