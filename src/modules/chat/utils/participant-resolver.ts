// modules/chat/utils/participant-resolver.ts
//
// The ONE place that maps a chat participant type to its identity column on
// ConversationParticipant / NotificationSetting and its sender column on
// Message. Before this module the same mapping was copied in ~20 places with
// slightly different fallbacks; every caller now goes through these helpers
// and keeps its own historical fallback EXPLICITLY (see `fallback` below), so
// the behaviour of the existing chat is unchanged (tests/chat-baseline/).
//
//   CUSTOMER → userId           / senderId
//   VENDOR   → vendorId         / senderVendorId
//   ADMIN    → employeeId       / senderEmployeeId   (admin's employee row)
//   EMPLOYEE → employeeId       / senderEmployeeId
//   DELIVERY → deliveryPersonId / senderDeliveryPersonId

import type { ParticipantType } from "@prisma/client";

export type IdentityColumn = "userId" | "vendorId" | "employeeId" | "deliveryPersonId";
export type SenderColumn = "senderId" | "senderVendorId" | "senderEmployeeId" | "senderDeliveryPersonId";

export const IDENTITY_COLUMNS: readonly IdentityColumn[] = ["userId", "vendorId", "employeeId", "deliveryPersonId"];
export const SENDER_COLUMNS: readonly SenderColumn[] = ["senderId", "senderVendorId", "senderEmployeeId", "senderDeliveryPersonId"];

const IDENTITY_BY_TYPE: Readonly<Record<string, IdentityColumn>> = {
  CUSTOMER: "userId",
  VENDOR: "vendorId",
  ADMIN: "employeeId",
  EMPLOYEE: "employeeId",
  DELIVERY: "deliveryPersonId",
};
const SENDER_BY_IDENTITY: Readonly<Record<IdentityColumn, SenderColumn>> = {
  userId: "senderId",
  vendorId: "senderVendorId",
  employeeId: "senderEmployeeId",
  deliveryPersonId: "senderDeliveryPersonId",
};

/** Role (req.user.role / type) → participant type. Anything unknown → CUSTOMER (historical). */
export function participantTypeForRole(role?: string | null): ParticipantType {
  switch (String(role ?? "").toUpperCase()) {
    case "VENDOR":
      return "VENDOR";
    case "ADMIN":
      return "ADMIN";
    case "EMPLOYEE":
      return "EMPLOYEE";
    case "DELIVERY":
      return "DELIVERY";
    default:
      return "CUSTOMER";
  }
}

/** Identity column of a known type, or null for an unknown one. */
export function identityColumnOf(type: string): IdentityColumn | null {
  return IDENTITY_BY_TYPE[type] ?? null;
}

/**
 * `{ <identityColumn>: id }` for a participant. `fallback` is the column an
 * UNKNOWN type maps to — each caller passes the one it always used:
 *   "employeeId" — access checks, sender filters, notification owner (staff default);
 *   "userId"     — the unread NOT filter (customer default);
 *   "none"       — no identity column at all (the read-receipt lookup, Stage 1 quirk).
 */
export function identityWhere(type: string, id: string, fallback: IdentityColumn | "none"): Record<string, string> {
  const col = identityColumnOf(type) ?? (fallback === "none" ? null : fallback);
  return col ? { [col]: id } : {};
}

/** All four identity columns for a new participant row: the type's column = id, the rest null. */
export function identityColumns(type: string, id: string): Record<IdentityColumn, string | null> {
  const col = identityColumnOf(type);
  return { userId: col === "userId" ? id : null, vendorId: col === "vendorId" ? id : null, employeeId: col === "employeeId" ? id : null, deliveryPersonId: col === "deliveryPersonId" ? id : null };
}

/** All four sender columns for a new message: the sender type's column = id, the rest null. */
export function senderColumns(type: string, id: string): Record<SenderColumn, string | null> {
  const col = identityColumnOf(type);
  const sender = col ? SENDER_BY_IDENTITY[col] : null;
  return {
    senderId: sender === "senderId" ? id : null,
    senderVendorId: sender === "senderVendorId" ? id : null,
    senderEmployeeId: sender === "senderEmployeeId" ? id : null,
    senderDeliveryPersonId: sender === "senderDeliveryPersonId" ? id : null,
  };
}

/** The owner id of a participant row: the first non-null identity column (historical ?? order). */
export function ownerIdOf(row: Partial<Record<IdentityColumn, string | null>>): string | null {
  return row.userId ?? row.vendorId ?? row.employeeId ?? row.deliveryPersonId ?? null;
}

/** Is this participant row the given (type, id)? Unknown types never match (historical fan-out rule). */
export function isOwnRow(row: Partial<Record<IdentityColumn, string | null>>, type: string, id: string): boolean {
  const col = identityColumnOf(type);
  return !!col && row[col] === id;
}

/**
 * Did (type, id) send this message? ADMIN and EMPLOYEE share employeeId, and
 * an unknown actor type is treated as staff (historical isSender default).
 */
export function isMessageSender(
  message: { senderType: string } & Partial<Record<SenderColumn, string | null>>,
  type: string,
  id: string,
): boolean {
  const col = identityColumnOf(type) ?? "employeeId";
  if (col === "employeeId") return (message.senderType === "ADMIN" || message.senderType === "EMPLOYEE") && message.senderEmployeeId === id;
  return message.senderType === type && message[SENDER_BY_IDENTITY[col]] === id;
}
