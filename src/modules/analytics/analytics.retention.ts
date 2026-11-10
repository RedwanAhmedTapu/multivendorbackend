// modules/analytics/analytics.retention.ts
//
// Retention for Business Advisor events: rows older than
// ANALYTICS_RETENTION_DAYS (30–730, default 180) are deleted by a job on the
// existing single-instance job runner (jobs/job-runner.ts — only runs when
// JOBS_ENABLED=1). A no-op until the analytics table exists. The same job
// removes expired visual session recordings (session-replay.routes.ts).

import { prisma } from "../../config/prisma.ts";
import type { JobDefinition } from "../../jobs/job-runner.ts";
import { RETENTION_DAYS_DEFAULT } from "./analytics.contract.ts";
import { purgeExpiredRecordings } from "./session-replay.routes.ts";

export function retentionDays(raw: unknown = process.env.ANALYTICS_RETENTION_DAYS): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 30 && n <= 730 ? n : RETENTION_DAYS_DEFAULT;
}

type Db = { analyticsEvent?: { deleteMany: (args: any) => Promise<{ count: number }> } };

export async function purgeExpiredAnalyticsEvents(db: Db, now: Date, days: number = retentionDays()): Promise<number> {
  if (!db.analyticsEvent?.deleteMany) return 0;
  try {
    const r = await db.analyticsEvent.deleteMany({ where: { occurredAt: { lt: new Date(now.getTime() - days * 86_400_000) } } });
    return r.count;
  } catch (err: any) {
    if (err?.code === "P2021") return 0; // table not created yet
    throw err;
  }
}

export function analyticsRetentionJob(db: Db = prisma as unknown as Db): JobDefinition {
  return {
    name: "analytics:retention",
    intervalMs: 6 * 60 * 60_000,
    run: async ({ now }) => {
      const removed = await purgeExpiredAnalyticsEvents(db, now);
      if (removed) console.log(`[analytics] retention removed ${removed} event(s)`);
      const replay = await purgeExpiredRecordings(undefined, undefined, now);
      if (replay.removed || replay.closed) console.log(`[analytics] replay retention removed ${replay.removed}, closed ${replay.closed}`);
    },
  };
}
