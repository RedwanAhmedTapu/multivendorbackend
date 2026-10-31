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

export function agentCommissionJobs(clear = clearMaturedAgentCommissions, syncWallets = syncDueAgentWallets): JobDefinition[] {
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
  ];
}
