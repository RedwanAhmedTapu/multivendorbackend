// src/modules/agent/services/agent-payout.service.ts
//
// Phase 7 — the agent's payout methods (bKash / Nagad / bank). Only the owning
// agent reaches these functions (agentId always comes from req.agent). Lists
// never return the full account number; a withdrawal copies the full details
// into its own methodSnapshot, which only admins read in full.
//
// Which types can be added or used is the admin setting enabledPayoutMethods,
// read fresh on every write. A method of a type the admin later disabled stays
// listed (flagged enabled: false) but can't be used for a new withdrawal.

import { agentDb, agentTransaction } from "../agent-db.ts";
import { AgentError, conflict, notFound } from "../agent-http.ts";
import { getAgentSettings, requireConfigured } from "./agent-settings.service.ts";
import { payoutMethodCreateSchema, payoutMethodUpdateSchema } from "../validators/agent-wallet.validators.ts";

/** Hard cap so a client can't create unbounded rows. */
export const MAX_PAYOUT_METHODS = 10;

export const OPEN_WITHDRAWAL_STATUSES = ["REQUESTED", "APPROVED"] as const;

export const PAYOUT_LABEL: Record<string, string> = { BKASH: "bKash", NAGAD: "Nagad", BANK: "Bank transfer" };

/** "•••• 5678" — never more than the last four characters. */
export function maskAccountNumber(n: string | null | undefined): string {
  const s = String(n ?? "");
  return s.length <= 4 ? "••••" : `•••• ${s.slice(-4)}`;
}

type MethodRow = {
  id: string;
  type: string;
  accountName: string;
  accountNumber: string;
  bankName: string | null;
  branch: string | null;
  routingNumber: string | null;
  isDefault: boolean;
  createdAt: Date;
};

export function maskedMethod(m: MethodRow, enabledTypes: readonly string[] | null) {
  return {
    id: m.id,
    type: m.type,
    label: PAYOUT_LABEL[m.type] ?? m.type,
    accountName: m.accountName,
    accountNumberMasked: maskAccountNumber(m.accountNumber),
    bankName: m.bankName,
    branch: m.branch,
    isDefault: m.isDefault,
    enabled: !!enabledTypes?.includes(m.type),
    createdAt: m.createdAt,
  };
}

const METHOD_SELECT = {
  id: true,
  type: true,
  accountName: true,
  accountNumber: true,
  bankName: true,
  branch: true,
  routingNumber: true,
  isDefault: true,
  createdAt: true,
} as const;

export async function listPayoutMethods(agentId: string) {
  const settings = await getAgentSettings();
  const rows: MethodRow[] = await (agentDb.prisma as any).agentPayoutMethod.findMany({
    where: { agentId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: METHOD_SELECT,
  });
  rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.getTime() - b.createdAt.getTime());
  const enabledTypes = settings.values.enabledPayoutMethods;
  return {
    items: rows.map((m) => maskedMethod(m, enabledTypes)),
    enabledTypes: enabledTypes ?? [],
    configured: enabledTypes != null,
  };
}

async function enabledTypesFresh(db: any): Promise<string[]> {
  const settings = await getAgentSettings({ fresh: true, db });
  requireConfigured(settings, ["enabledPayoutMethods"], "Payout methods");
  return settings.values.enabledPayoutMethods!;
}

function assertTypeEnabled(type: string, enabled: string[]) {
  if (!enabled.includes(type)) {
    throw new AgentError(`${PAYOUT_LABEL[type] ?? type} payouts are not enabled`, 409, "PAYOUT_METHOD_DISABLED", { enabledTypes: enabled });
  }
}

export async function createPayoutMethod(agentId: string, input: unknown) {
  const data = payoutMethodCreateSchema.parse(input);
  return agentTransaction(async (tx: any) => {
    const enabled = await enabledTypesFresh(tx);
    assertTypeEnabled(data.type, enabled);
    const existing: MethodRow[] = await tx.agentPayoutMethod.findMany({ where: { agentId }, select: METHOD_SELECT });
    if (existing.length >= MAX_PAYOUT_METHODS) throw conflict(`You can save at most ${MAX_PAYOUT_METHODS} payout methods`, "TOO_MANY_PAYOUT_METHODS");
    if (existing.some((m) => m.type === data.type && m.accountNumber === data.accountNumber)) {
      throw conflict("This payout method is already saved", "DUPLICATE_PAYOUT_METHOD");
    }
    const row = await tx.agentPayoutMethod.create({
      data: {
        agentId,
        type: data.type,
        accountName: data.accountName,
        accountNumber: data.accountNumber,
        bankName: data.type === "BANK" ? data.bankName : null,
        branch: data.type === "BANK" ? data.branch : null,
        routingNumber: data.type === "BANK" ? data.routingNumber : null,
        isDefault: existing.length === 0,
      },
      select: METHOD_SELECT,
    });
    return maskedMethod(row, enabled);
  });
}

export async function updatePayoutMethod(agentId: string, id: string, input: unknown) {
  const patch = payoutMethodUpdateSchema.parse(input);
  return agentTransaction(async (tx: any) => {
    const current: MethodRow | null = await tx.agentPayoutMethod.findFirst({ where: { id, agentId }, select: METHOD_SELECT });
    if (!current) throw notFound("Payout method");
    const enabled = await enabledTypesFresh(tx);
    assertTypeEnabled(current.type, enabled);
    // Re-validate the merged method with the create rules for its type.
    const merged =
      current.type === "BANK"
        ? {
            type: "BANK",
            accountName: patch.accountName ?? current.accountName,
            accountNumber: patch.accountNumber ?? current.accountNumber,
            bankName: patch.bankName ?? current.bankName ?? "",
            branch: (patch.branch !== undefined ? patch.branch : current.branch) ?? undefined,
            routingNumber: (patch.routingNumber !== undefined ? patch.routingNumber : current.routingNumber) ?? undefined,
          }
        : {
            type: current.type,
            accountName: patch.accountName ?? current.accountName,
            accountNumber: patch.accountNumber ?? current.accountNumber,
          };
    if (current.type !== "BANK" && (patch.bankName || patch.branch || patch.routingNumber)) {
      throw new AgentError("Bank details apply to bank accounts only", 400, "VALIDATION_ERROR");
    }
    const data = payoutMethodCreateSchema.parse(merged);
    const others: MethodRow[] = await tx.agentPayoutMethod.findMany({ where: { agentId, NOT: { id } }, select: METHOD_SELECT });
    if (others.some((m) => m.type === data.type && m.accountNumber === data.accountNumber)) {
      throw conflict("This payout method is already saved", "DUPLICATE_PAYOUT_METHOD");
    }
    const row = await tx.agentPayoutMethod.update({
      where: { id },
      data: {
        accountName: data.accountName,
        accountNumber: data.accountNumber,
        ...(data.type === "BANK" ? { bankName: data.bankName, branch: data.branch, routingNumber: data.routingNumber } : {}),
      },
      select: METHOD_SELECT,
    });
    return maskedMethod(row, enabled);
  });
}

export async function deletePayoutMethod(agentId: string, id: string) {
  return agentTransaction(async (tx: any) => {
    const current: MethodRow | null = await tx.agentPayoutMethod.findFirst({ where: { id, agentId }, select: METHOD_SELECT });
    if (!current) throw notFound("Payout method");
    const open = await tx.agentWithdrawal.count({ where: { agentId, payoutMethodId: id, status: { in: [...OPEN_WITHDRAWAL_STATUSES] } } });
    if (open > 0) throw conflict("This method has a withdrawal in progress; it can be removed once that is paid or rejected", "PAYOUT_METHOD_IN_USE");
    await tx.agentPayoutMethod.delete({ where: { id } });
    if (current.isDefault) {
      const next: MethodRow[] = await tx.agentPayoutMethod.findMany({ where: { agentId }, orderBy: { createdAt: "asc" }, take: 1, select: METHOD_SELECT });
      if (next[0]) await tx.agentPayoutMethod.update({ where: { id: next[0].id }, data: { isDefault: true } });
    }
    return { id, deleted: true };
  });
}

export async function setDefaultPayoutMethod(agentId: string, id: string) {
  return agentTransaction(async (tx: any) => {
    const current = await tx.agentPayoutMethod.findFirst({ where: { id, agentId }, select: { id: true } });
    if (!current) throw notFound("Payout method");
    await tx.agentPayoutMethod.updateMany({ where: { agentId, isDefault: true, NOT: { id } }, data: { isDefault: false } });
    await tx.agentPayoutMethod.update({ where: { id }, data: { isDefault: true } });
    return { id, isDefault: true };
  });
}
