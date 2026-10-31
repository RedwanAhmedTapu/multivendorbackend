// src/modules/agent/agent-db.ts
//
// Test hook (same convention as orderServiceDb / cartWishDb): every agent
// service reaches the database through this object at CALL time, so a test
// can swap `agentDb.prisma` / `agentDb.prismaDirect` for an in-memory fake
// without touching the shared clients.
//
// prisma        — pooled client for single statements.
// prismaDirect  — direct (non-pooled) client; REQUIRED for interactive
//                 $transaction(async tx => …) — see src/config/prisma.ts.

import type { PrismaClient, Prisma } from "@prisma/client";
import { prisma, prismaDirect } from "../../config/prisma.ts";

export const agentDb: { prisma: PrismaClient; prismaDirect: PrismaClient } = {
  prisma,
  prismaDirect,
};

/** Interactive-transaction client type. */
export type AgentTx = Prisma.TransactionClient;

/**
 * Run `fn` in a Serializable interactive transaction on the direct client,
 * retrying on serialization failures (P2034) — the same policy as
 * runStockMutation in modules/shared/stock-mutations.ts.
 */
export async function agentTransaction<T>(fn: (tx: AgentTx) => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await agentDb.prismaDirect.$transaction(fn, {
        isolationLevel: "Serializable",
        maxWait: 5_000,
        timeout: 15_000,
      });
    } catch (err: any) {
      lastError = err;
      if (err?.code !== "P2034" || attempt === maxAttempts) throw err;
    }
  }
  throw lastError;
}

/** Serialize writers of one configuration area inside a transaction. */
export async function lockConfigArea(tx: AgentTx, area: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"agent-config:" + area}))`;
}
