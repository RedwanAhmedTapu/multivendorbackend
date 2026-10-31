// src/modules/agent/agent.jobs.ts
//
// Background jobs for the agent commission engine (single-instance runner,
// disabled unless JOBS_ENABLED=1 — src/jobs/job-runner.ts). Idempotent: every
// read derives "withdrawable" from availableAt, so this only tidies the stored
// status and a skipped or repeated tick changes nothing that matters.
//   agent:commission-clearance   PENDING_CLEARANCE → AVAILABLE once availableAt passed,
//                                then (Phase 7) credit matured commissions and debit
//                                reversals in each affected wallet (idempotent: each
//                                commission / reversal is posted once, under the wallet lock)

import type { JobDefinition } from "../../jobs/job-runner.ts";
import { clearMaturedAgentCommissions } from "./services/agent-commission.service.ts";
import { syncDueAgentWallets } from "./services/agent-wallet.service.ts";
import { evaluateAllBonuses } from "./services/agent-bonus.service.ts";
import { monthlyLevelEvaluation } from "./services/agent-level.service.ts";

export function agentCommissionJobs(
  clear = clearMaturedAgentCommissions,
  syncWallets = syncDueAgentWallets,
  growth: { bonuses: typeof evaluateAllBonuses; levels: typeof monthlyLevelEvaluation } = { bonuses: evaluateAllBonuses, levels: monthlyLevelEvaluation },
): JobDefinition[] {
  return [
    {
      name: "agent:commission-clearance",
      intervalMs: 15 * 60_000,
      run: async ({ now }) => {
        const n = await clear(now);
        if (n) console.log(`[jobs] agent:commission-clearance made ${n} commission(s) available`);
        const w = await syncWallets(now);
        if (w.agents) console.log(`[jobs] agent:commission-clearance synced ${w.agents} wallet(s)${w.failed ? `, ${w.failed} failed` : ""}`);
      },
    },
      {
      // Phase 9: catch-up for milestone bonuses (also evaluated after every
      // accrual) and the once-per-Asia/Dhaka-month level evaluation (upgrade only).
      name: "agent:growth",
      intervalMs: 6 * 3600_000,
      run: async ({ now }) => {
        const b = await growth.bonuses(now);
        if (b.awarded) console.log(`[jobs] agent:growth awarded ${b.awarded} bonus(es)`);
        const l = await growth.levels(now);
        if (l) console.log(`[jobs] agent:growth level evaluation: ${l.evaluated} evaluated, ${l.upgraded} upgraded, ${l.failed} failed`);
      },
    },
  ];
}
