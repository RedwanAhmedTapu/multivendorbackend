// jobs/purge-deleted-products.job.ts
import cron from "node-cron";
import { purgeExpiredSoftDeletes } from "../services/product/product-deletion.service.ts";

/**
 * Runs once a day at 03:00 server time — permanently removes any product
 * whose 90-day (3 month) soft-delete grace period has expired.
 *
 * Register this once at app bootstrap:
 *   import "./jobs/purge-deleted-products.job.ts";
 */
export function schedulePurgeJob() {
  cron.schedule("0 3 * * *", async () => {
    console.log("[purge-job] starting scheduled product purge run…");
    let totalPurged = 0;
    let totalChecked = 0;

    // Drain in batches in case there's a large backlog.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { checked, purged } = await purgeExpiredSoftDeletes(50);
      totalChecked += checked;
      totalPurged += purged;
      if (checked < 50) break; // no more due products
    }

    console.log(
      `[purge-job] done. checked=${totalChecked} purged=${totalPurged} at ${new Date().toISOString()}`
    );
  });

  console.log("[purge-job] scheduled: daily at 03:00 (permanently deletes products soft-deleted 90+ days ago)");
}

// Allow running manually: `ts-node src/jobs/purge-deleted-products.job.ts --now`
if (process.argv.includes("--now")) {
  purgeExpiredSoftDeletes(100).then((res) => {
    console.log("[purge-job] manual run result:", res);
    process.exit(0);
  });
}
