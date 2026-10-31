// src/modules/agent/services/agent-audit.service.ts
//
// Append-only audit of agent configuration changes (settings, levels,
// overrides, bonus rules, agent status, vendor links). Always written with
// the SAME transaction client as the change it describes, so a change and
// its audit row commit or roll back together.

import { agentDb, type AgentTx } from "../agent-db.ts";

export type AuditEntity = "SETTING" | "LEVEL" | "OVERRIDE" | "BONUS_RULE" | "AGENT" | "VENDOR_LINK" | "WITHDRAWAL" | "COMMISSION" | "TRAINING" | "WALLET" | "BONUS_AWARD";
export type AuditAction = "CREATE" | "UPDATE" | "DELETE" | "ACTIVATE" | "DEACTIVATE" | "STATUS" | "RERUN";

/** Who made the change — from the authenticated admin request. */
export type AdminActor = {
  userId: string;
  name: string | null;
  ip: string | null;
  userAgent: string | null;
};

/** JSON-safe copy: Decimal → string, Date → ISO, undefined dropped. */
export function auditJson(value: unknown): any {
  if (value === undefined) return null;
  // Prisma.Decimal (decimal.js) and Date both implement toJSON.
  return JSON.parse(JSON.stringify(value));
}

export async function writeConfigAudit(
  tx: AgentTx,
  entry: {
    entity: AuditEntity;
    entityId: string;
    action: AuditAction;
    oldValue?: unknown;
    newValue?: unknown;
    actor: AdminActor;
  },
): Promise<void> {
  await tx.agentConfigAudit.create({
    data: {
      // WITHDRAWAL / COMMISSION / RERUN come from migration 20261101000000; the
      // casts keep this compiling against a client generated before it.
      entity: entry.entity as any,
      entityId: entry.entityId,
      action: entry.action as any,
      oldValue: entry.oldValue === undefined || entry.oldValue === null ? undefined : auditJson(entry.oldValue),
      newValue: entry.newValue === undefined || entry.newValue === null ? undefined : auditJson(entry.newValue),
      actorUserId: entry.actor.userId,
      actorName: entry.actor.name,
      ip: entry.actor.ip,
      userAgent: entry.actor.userAgent,
    },
  });
}

export async function listConfigAudit(filter: {
  entity?: AuditEntity;
  entityId?: string;
  page: number;
  limit: number;
}) {
  const where: any = {};
  if (filter.entity) where.entity = filter.entity;
  if (filter.entityId) where.entityId = filter.entityId;
  const [items, total] = await Promise.all([
    agentDb.prisma.agentConfigAudit.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    }),
    agentDb.prisma.agentConfigAudit.count({ where }),
  ]);
  return { items, total, page: filter.page, limit: filter.limit };
}
