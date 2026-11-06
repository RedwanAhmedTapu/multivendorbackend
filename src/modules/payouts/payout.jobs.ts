// src/modules/payouts/payout.jobs.ts
//   payout:auto-propose   on payout days, when the policy's autoPropose is on,
//                         drafts one batch. It never approves and never pays.

import type { JobDefinition } from "../../jobs/job-runner.ts";
import { payoutService, type PayoutService } from "./payout.service.ts";

export function payoutJobs(get: () => PayoutService = payoutService): JobDefinition[] {
  return [
    {
      name: "payout:auto-propose",
      intervalMs: 60 * 60_000,
      run: async ({ now }) => {
        const n = await get().runAutoPropose(now);
        if (n) console.log("[jobs] payout:auto-propose drafted a payout batch (awaiting admin approval)");
      },
    },
  ];
}
