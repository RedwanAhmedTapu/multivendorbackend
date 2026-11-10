// scripts/refund-records/backfill-refund-records.ts
//
// Phase 4 (H-2 / D3): create the missing RefundRecord for refunds that have
// none (see detect-orphan-refunds.sql), so they can be approved / rejected.
//
// SAFETY
//   - DRY RUN by default: reads only and prints refund ids + counts (no
//     customer data). Writes ONLY with BOTH `--apply` AND the environment
//     variable CONFIRM_REFUND_BACKFILL=yes.
//   - Never changes a Refund row, an amount or a status; only inserts the
//     missing record. Each insert re-checks inside its own transaction, and
//     RefundRecord.refundId is unique, so a re-run or a concurrent run cannot
//     create a second record.
//   - Refunds whose order has no paid payment are skipped and listed for
//     manual review.
//   NOT RUN as part of Phase 4 — requires the owner's approval.
//
//   npx tsx scripts/refund-records/backfill-refund-records.ts            # dry run
//   CONFIRM_REFUND_BACKFILL=yes npx tsx scripts/refund-records/backfill-refund-records.ts --apply

import { pathToFileURL } from "node:url";
import { newRefundNumber } from "../../src/services/refund-balance.ts";

const PAID_STATUSES = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"];

/** The record a backfilled refund gets — derived from the refund and its order's payment only. */
export function buildRefundRecordData(
  refund: { id: string; amount: unknown; reason: string | null; status: string; order?: { userId: string | null; vendorOrders?: { vendorId: string }[] } | null },
  payment: { amount: unknown; sslCommerzDetail?: { tranId?: string | null; vendorId?: string | null; customerId?: string | null } | null },
) {
  const refundAmount = Number(refund.amount);
  const originalAmount = Number(payment.amount);
  return {
    refundId: refund.id,
    refundNumber: newRefundNumber(),
    sslTranId: payment.sslCommerzDetail?.tranId ?? null,
    vendorId: payment.sslCommerzDetail?.vendorId ?? refund.order?.vendorOrders?.[0]?.vendorId ?? "UNKNOWN",
    customerId: payment.sslCommerzDetail?.customerId ?? refund.order?.userId ?? "",
    refundType: refundAmount + 0.005 >= originalAmount ? "FULL_REFUND" : "PARTIAL_REFUND",
    originalAmount: payment.amount,
    refundAmount: refund.amount,
    refundReason: refund.reason ?? "Backfilled record (Phase 4)",
    status: refund.status,
    initiatedBy: "backfill:phase4",
  };
}

export async function backfillRefundRecords(db: any, opts: { apply: boolean }) {
  const orphans = await db.refund.findMany({
    where: { detail: { is: null } },
    select: {
      id: true,
      orderId: true,
      amount: true,
      reason: true,
      status: true,
      order: { select: { userId: true, vendorOrders: { select: { vendorId: true }, take: 1 } } },
    },
    orderBy: { createdAt: "asc" },
  });

  const planned: string[] = [];
  const manualReview: string[] = [];
  const payments = new Map<string, any>();
  for (const r of orphans) {
    const payment = await db.payment.findFirst({
      where: { orderId: r.orderId, status: { in: PAID_STATUSES } },
      orderBy: { createdAt: "desc" },
      include: { sslCommerzDetail: true },
    });
    if (!payment) manualReview.push(r.id);
    else {
      planned.push(r.id);
      payments.set(r.id, payment);
    }
  }
  if (!opts.apply) return { mode: "dry-run" as const, orphanCount: orphans.length, planned, manualReview, created: [] as string[] };

  const created: string[] = [];
  for (const r of orphans) {
    const payment = payments.get(r.id);
    if (!payment) continue;
    await db.$transaction(async (tx: any) => {
      const existing = await tx.refundRecord.findUnique({ where: { refundId: r.id }, select: { id: true } });
      if (existing) return;
      await tx.refundRecord.create({ data: buildRefundRecordData(r, payment) });
      created.push(r.id);
    });
  }
  return { mode: "apply" as const, orphanCount: orphans.length, planned, manualReview, created };
}

export function writesAllowed(argv: string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes("--apply") && env.CONFIRM_REFUND_BACKFILL === "yes";
}

async function main() {
  const apply = writesAllowed(process.argv.slice(2), process.env);
  if (process.argv.includes("--apply") && !apply) {
    console.error("Refusing to write: --apply also requires CONFIRM_REFUND_BACKFILL=yes. Nothing was changed.");
    process.exitCode = 1;
    return;
  }
  const { prisma } = await import("../../src/config/prisma.ts");
  try {
    const result = await backfillRefundRecords(prisma, { apply });
    console.log(JSON.stringify({ ...result }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`Backfill failed: ${e?.message ?? e}`);
    process.exitCode = 1;
  });
}
