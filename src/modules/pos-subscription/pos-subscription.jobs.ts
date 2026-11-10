// src/modules/pos-subscription/pos-subscription.jobs.ts
//
// Background jobs for POS subscriptions (single-instance job runner; disabled
// unless JOBS_ENABLED=1). Both are idempotent and neither decides access —
// the entitlement gate reads expiresAt directly, so a late tick can't extend
// anyone's POS use.
//   pos:expiry-sweep     ACTIVE rows past expiry + grace → EXPIRED (+ period row)
//   pos:renewal-reminder one in-app reminder per vendor per end date (≤ 7 days left)

import type { JobDefinition } from "../../jobs/job-runner.ts";
import { posSubscriptionService } from "../../services/pos-subscription.service.ts";

export function posSubscriptionJobs(service = posSubscriptionService): JobDefinition[] {
  return [
    {
      name: "pos:expiry-sweep",
      intervalMs: 15 * 60_000,
      run: async ({ now }) => {
        const n = await service.runExpirySweep(now);
        if (n) console.log(`[jobs] pos:expiry-sweep marked ${n} subscription(s) expired`);
      },
    },
    {
      name: "pos:renewal-reminder",
      intervalMs: 60 * 60_000,
      run: async ({ now }) => {
        const n = await service.runRenewalReminders(now);
        if (n) console.log(`[jobs] pos:renewal-reminder sent ${n} reminder(s)`);
      },
    },
  ];
}
