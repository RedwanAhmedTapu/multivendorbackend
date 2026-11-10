// tests/email-sms.state.test.ts
// Pure state rules for Email & SMS campaigns. No database, no provider.
//   npx tsx --test tests/email-sms.state.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertCampaignTransition, canResolveManually, canTransitionCampaign, isCampaignFinished,
  isResolutionTargetAllowed, isSafelyRetryable, mayCreateNewAttempt, mayStartProviderCall,
  nextAttemptNumber, requiresReconciliation, type SendState,
} from "../src/modules/marketing/email-sms/campaign.state.ts";

test("state: legal campaign transitions only", () => {
  assert.equal(canTransitionCampaign("DRAFT", "SCHEDULED"), true);
  assert.equal(canTransitionCampaign("SCHEDULED", "SENDING"), true);
  assert.equal(canTransitionCampaign("SENDING", "SUBMITTED"), true);
  assert.equal(canTransitionCampaign("SUBMITTED", "COMPLETED"), true);
  assert.equal(canTransitionCampaign("SCHEDULED", "CANCELLED"), true);
  for (const t of ["DRAFT", "SENDING", "CANCELLED", "COMPLETED", "FAILED"] as const) {
    assert.equal(canTransitionCampaign("COMPLETED", t), false, `completed -> ${t} must be illegal`);
  }
  assert.equal(canTransitionCampaign("DRAFT", "SENDING"), false, "draft must be scheduled first");
  assert.throws(() => assertCampaignTransition("CANCELLED", "SENDING"), /Illegal campaign transition/);
});

test("state: no provider call after cancellation or outside SENDING", () => {
  assert.equal(mayStartProviderCall("SENDING", "QUEUED"), true);
  assert.equal(mayStartProviderCall("CANCELLED", "QUEUED"), false);
  assert.equal(mayStartProviderCall("SCHEDULED", "QUEUED"), false);
  assert.equal(mayStartProviderCall("SENDING", "RECONCILIATION_REQUIRED"), false);
  assert.equal(mayStartProviderCall("SENDING", "SUBMITTED"), false);
});

test("state: a new attempt only after the previous one left the open set", () => {
  assert.equal(mayCreateNewAttempt(null), true);
  assert.equal(mayCreateNewAttempt("QUEUED"), false);
  assert.equal(mayCreateNewAttempt("RECONCILIATION_REQUIRED"), false);
  assert.equal(mayCreateNewAttempt("SUBMITTED"), false);
  assert.equal(mayCreateNewAttempt("DELIVERED"), false);
  assert.equal(mayCreateNewAttempt("BOUNCED"), false);
  assert.equal(mayCreateNewAttempt("FAILED"), true);
});

test("state: retry only when transmission provably never started", () => {
  assert.equal(isSafelyRetryable({ state: "FAILED", transmitStartedAt: null }), true);
  assert.equal(isSafelyRetryable({ state: "FAILED", transmitStartedAt: new Date() }), false);
  assert.equal(isSafelyRetryable({ state: "QUEUED", transmitStartedAt: null }), false);
});

test("state: ambiguous outcomes require reconciliation, never a blind retry", () => {
  assert.equal(requiresReconciliation({ state: "RECONCILIATION_REQUIRED", transmitStartedAt: null }), true);
  assert.equal(requiresReconciliation({ state: "QUEUED", transmitStartedAt: new Date() }), true, "marker set => unresolved");
  assert.equal(requiresReconciliation({ state: "QUEUED", transmitStartedAt: null }), false);
  assert.equal(requiresReconciliation({ state: "SUBMITTED", transmitStartedAt: new Date() }), false);
  assert.equal(canResolveManually("RECONCILIATION_REQUIRED"), true);
  assert.equal(canResolveManually("QUEUED"), false);
});

test("state: manual resolution can never claim delivery", () => {
  assert.equal(isResolutionTargetAllowed("SUBMITTED"), true);
  assert.equal(isResolutionTargetAllowed("FAILED"), true);
  assert.equal(isResolutionTargetAllowed("DELIVERED"), false);
  assert.equal(isResolutionTargetAllowed("BOUNCED"), false);
});

test("state: completion means nothing open and nothing unresolved", () => {
  assert.equal(isCampaignFinished([{ state: "SUBMITTED" }, { state: "FAILED" }, { state: "DELIVERED" }]), true);
  assert.equal(isCampaignFinished([{ state: "SUBMITTED" }, { state: "QUEUED" }]), false);
  assert.equal(isCampaignFinished([{ state: "RECONCILIATION_REQUIRED" }]), false);
  assert.equal(isCampaignFinished([{ state: "QUEUED", transmitStartedAt: new Date() }]), false);
  assert.equal(isCampaignFinished([]), true);
});

test("state: attempt numbering is monotonic", () => {
  assert.equal(nextAttemptNumber([]), 1);
  assert.equal(nextAttemptNumber([1]), 2);
  assert.equal(nextAttemptNumber([1, 3, null]), 4);
  assert.equal(nextAttemptNumber([undefined]), 1);
});