// src/modules/subscriptions/subscription.jobs.ts
//
// Background jobs (single-instance runner; off unless JOBS_ENABLED=1). All are
// idempotent and none decides access: the entitlement check reads the dates.
//   subs:expiry-sweep       ACTIVE past end + grace → EXPIRED (+ event, notification)
//   subs:offer-expiry       offers past their end → EXPIRED + after-expiry behaviour
//                           (notify; SWITCH_PLAN opens a PENDING request, never a charge)
//   subs:renewal-reminder   one reminder per vendor per end date

import type { JobDefinition } from "../../jobs/job-runner.ts";
import { subscriptionService, type SubscriptionService } from "./subscription.service.ts";

export function subscriptionJobs(get: () => SubscriptionService = subscriptionService): JobDefinition[] {
  return [
    {
      name: "subs:expiry-sweep",
      intervalMs: 15 * 60_000,
      run: async ({ now }) => {
        const n = await get().runExpirySweep(now);
        if (n) console.log(`[jobs] subs:expiry-sweep marked ${n} subscription(s) expired`);
      },
    },
    {
      name: "subs:offer-expiry",
      intervalMs: 15 * 60_000,
      run: async ({ now }) => {
        const n = await get().runOfferExpiry(now);
        if (n) console.log(`[jobs] subs:offer-expiry closed ${n} offer(s)`);
      },
    },
    {
      name: "subs:renewal-reminder",
      intervalMs: 60 * 60_000,
      run: async ({ now }) => {
        const n = await get().runRenewalReminders(now);
        if (n) console.log(`[jobs] subs:renewal-reminder sent ${n} reminder(s)`);
      },
    },
  ];
}
