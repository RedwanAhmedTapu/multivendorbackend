// modules/marketing/email-sms/campaign.state.ts
//
// Pure campaign / send-attempt state rules. No Prisma, no HTTP, no provider:
// every rule here is unit-testable and is the single source of truth the service
// and the worker must consult. Mirrors the proposal enums in
// prisma/proposed/20261022120000_email_sms_campaigns.

export const CAMPAIGN_STATUSES = [
  "DRAFT",
  "SCHEDULED",
  "SENDING",
  "SUBMITTED",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const SEND_STATES = [
  "QUEUED",
  "SUBMITTED",
  "RECONCILIATION_REQUIRED",
  "DELIVERED",
  "BOUNCED",
  "FAILED",
] as const;
export type SendState = (typeof SEND_STATES)[number];

/** States a campaign can never leave. */
const TERMINAL_CAMPAIGN: ReadonlySet<CampaignStatus> = new Set(["COMPLETED", "CANCELLED", "FAILED"]);

/** States from which no provider call may ever be made again. */
const TERMINAL_SEND: ReadonlySet<SendState> = new Set(["SUBMITTED", "DELIVERED", "BOUNCED"]);

/** Attempts that still occupy the "open" slot for a recipient. */
const OPEN_SEND: ReadonlySet<SendState> = new Set(["QUEUED", "RECONCILIATION_REQUIRED"]);

const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  DRAFT: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["SENDING", "CANCELLED"],
  SENDING: ["SUBMITTED", "CANCELLED", "FAILED"],
  SUBMITTED: ["COMPLETED", "CANCELLED", "FAILED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertCampaignTransition(from: CampaignStatus, to: CampaignStatus): void {
  if (!canTransitionCampaign(from, to)) {
    throw new Error(`Illegal campaign transition ${from} -> ${to}`);
  }
}

export function isTerminalCampaign(status: CampaignStatus): boolean {
  return TERMINAL_CAMPAIGN.has(status);
}

/** A cancelled campaign can still receive outstanding provider results, but must never start work. */
export function mayStartProviderCall(campaign: CampaignStatus, send: SendState): boolean {
  if (campaign !== "SENDING" || TERMINAL_CAMPAIGN.has(campaign)) return false;
  return send === "QUEUED";
}

/**
 * Whether a NEW attempt row may be created for a recipient whose latest attempt
 * is `previous`. Mirrors the partial unique index
 * (recipientId) WHERE state IN ('QUEUED','RECONCILIATION_REQUIRED'): a new row is
 * only allowed once the previous one has left the open set.
 */
export function mayCreateNewAttempt(previous: SendState | null): boolean {
  if (previous === null) return true;
  if (OPEN_SEND.has(previous)) return false;
  if (TERMINAL_SEND.has(previous)) return false;
  return previous === "FAILED";
}

/** Only a failure that provably happened before transmission may be retried automatically. */
export function isSafelyRetryable(input: { state: SendState; transmitStartedAt: Date | null }): boolean {
  if (input.state !== "FAILED") return false;
  return input.transmitStartedAt === null;
}

/** A send whose transmission may have begun and whose outcome is unknown. */
export function requiresReconciliation(input: { state: SendState; transmitStartedAt: Date | null }): boolean {
  if (input.state === "RECONCILIATION_REQUIRED") return true;
  return input.state === "QUEUED" && input.transmitStartedAt !== null;
}

/** Manual resolution is permitted only for an ambiguous attempt. */
export function canResolveManually(state: SendState): boolean {
  return state === "RECONCILIATION_REQUIRED";
}

/**
 * Admin resolution may land on SUBMITTED or FAILED only. DELIVERED and BOUNCED
 * require provider evidence and must never be set by hand.
 */
export function isResolutionTargetAllowed(target: SendState): boolean {
  return target === "SUBMITTED" || target === "FAILED";
}

/**
 * Campaign completion: nothing is queued and nothing is unresolved. `FAILED` sends
 * do not block completion — they are reported alongside it.
 */
export function isCampaignFinished(sends: { state: SendState; transmitStartedAt?: Date | null }[]): boolean {
  return sends.every((s) => !OPEN_SEND.has(s.state) && !requiresReconciliation({ state: s.state, transmitStartedAt: s.transmitStartedAt ?? null }));
}

/** Next attempt number, derived from the highest existing attempt. */
export function nextAttemptNumber(attempts: (number | null | undefined)[]): number {
  const max = attempts.reduce<number>((m, a) => (typeof a === "number" && a > m ? a : m), 0);
  return max + 1;
}
