/* Sanitized email-usage doc → view model (pure) — STAGE A build (provider accounting
   DISABLED at the client level for rollback safety). Provider totals are NEVER rendered
   here: every provider document/callable — including a valid Stage D document left in
   Firestore after a rollback — reads as Unavailable, immediately, with no Firestore
   cleanup. Independently valid app-safety telemetry is preserved.
   Run: node --test src/emailUsageDoc.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { presentEmailUsageDoc, normalizeCallableUsage, PROVIDER_ACCOUNTING_ENABLED } from "./emailUsageDoc.js";

const AUG = Date.parse("2026-08-28T12:00:00.000Z");
const TELE = { appInitiatedThisMonth: 114, appSafetyCap: 2800 };
// A fully-valid Stage D document (proven + known model + current period + bounded totals).
const stageD = (over = {}) => ({
  monthly: { used: 44, limit: 3000, percent: 1.5 }, daily: { used: 5, limit: 100, percent: 5 }, dailyReason: null,
  periodMonth: "2026-08", periodDay: "2026-08-28", observedAt: "2026-08-28T12:00:00.000Z", observedVia: "send",
  source: "resend", providerUsageProven: true, providerUsageModel: "resend-pre-send-used-v1",
  internalTelemetry: TELE, ...over,
});

test("this build has provider accounting DISABLED", () => {
  assert.equal(PROVIDER_ACCOUNTING_ENABLED, false);
});

test("rollback safety: a valid Stage D DOCUMENT → Unavailable, telemetry kept", () => {
  const v = presentEmailUsageDoc(stageD(), AUG);
  assert.equal(v.providerAvailable, false);
  assert.equal(v.monthly, null);
  assert.equal(v.providerError.code, "provider-usage-unverified");
  assert.deepEqual(v.internalTelemetry, TELE);
});

test("rollback safety: a valid Stage D CALLABLE result → Unavailable, telemetry kept", () => {
  const v = normalizeCallableUsage({ providerAvailable: true, providerUsageProven: true, providerUsageModel: "resend-pre-send-used-v1",
    source: "resend", monthly: { used: 44, limit: 3000, percent: 1.5 }, lastSyncedAt: "2026-08-28T12:00:00Z", internalTelemetry: TELE });
  assert.equal(v.providerAvailable, false);
  assert.deepEqual(v.internalTelemetry, TELE);
});

test("a poisoned/unversioned doc (no proof, no model) → Unavailable", () => {
  const v = presentEmailUsageDoc({ monthly: { used: 3001, limit: 3000, percent: 100 }, periodMonth: "2026-08", periodDay: "2026-08-28",
    observedAt: "2026-08-28T12:00:00.000Z", internalTelemetry: TELE }, AUG);
  assert.equal(v.providerAvailable, false);
  assert.equal(v.monthly, null);
  assert.deepEqual(v.internalTelemetry, TELE);
});

test("empty/absent doc → not-observed, no fabricated numbers", () => {
  const v = presentEmailUsageDoc(null, AUG);
  assert.equal(v.providerAvailable, false);
  assert.equal(v.monthly, null);
  assert.equal(v.providerError.code, "not-observed");
});

test("null callable → call-failed, no throw", () => {
  assert.equal(normalizeCallableUsage(null).providerError.code, "call-failed");
});

test("surfaces internalTelemetry (app safety usage) from the doc when present", () => {
  const v = presentEmailUsageDoc(stageD({ internalTelemetry: { appInitiatedThisMonth: 3, appSafetyCap: 2800 } }), AUG);
  assert.deepEqual(v.internalTelemetry, { appInitiatedThisMonth: 3, appSafetyCap: 2800 });
});
