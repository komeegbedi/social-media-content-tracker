/* Sanitized email-usage doc → view model (pure). Mirrors the server's period logic.
   Run: node --test src/emailUsageDoc.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { presentEmailUsageDoc } from "./emailUsageDoc.js";

const AUG = Date.parse("2026-08-28T12:00:00.000Z"); // month 2026-08, day 2026-08-28
// providerUsageProven:true represents the FUTURE proven-model doc — the server only stamps
// it once header semantics are proven. The interim (containment) default is unproven.
const docOf = (over = {}) => ({
  monthly: { used: 40, limit: 3000, percent: 1.3 },
  daily: { used: 0, limit: 100, percent: 0 },
  dailyReason: null, periodMonth: "2026-08", periodDay: "2026-08-28",
  observedAt: "2026-08-28T12:00:00.000Z", observedVia: "send", source: "resend",
  providerUsageProven: true, ...over,
});

test("current-period doc → observed view (monthly + daily), not stale", () => {
  const v = presentEmailUsageDoc(docOf(), AUG);
  assert.equal(v.providerAvailable, true);
  assert.equal(v.source, "resend");
  assert.deepEqual(v.monthly, { used: 40, limit: 3000, percent: 1.3 });
  assert.deepEqual(v.daily, { used: 0, limit: 100, percent: 0 });
  assert.equal(v.stale, false);
  assert.equal(v.observedVia, "send");
});

test("empty/absent doc → not-observed, no fabricated numbers", () => {
  const v = presentEmailUsageDoc(null, AUG);
  assert.equal(v.providerAvailable, false);
  assert.equal(v.monthly, null);
  assert.equal(v.providerError.code, "not-observed");
});

test("containment: a doc WITHOUT providerUsageProven → provider-usage-unverified, telemetry kept", () => {
  // A stale/pre-fix doc that still carries provider numbers must NOT be shown as valid.
  const v = presentEmailUsageDoc({ monthly: { used: 40, limit: 3000, percent: 1.3 }, periodMonth: "2026-08", periodDay: "2026-08-28",
    observedAt: "2026-08-28T12:00:00.000Z", internalTelemetry: { appInitiatedThisMonth: 114, appSafetyCap: 2800 } }, AUG);
  assert.equal(v.providerAvailable, false);
  assert.equal(v.monthly, null);
  assert.equal(v.providerError.code, "provider-usage-unverified");
  assert.deepEqual(v.internalTelemetry, { appInitiatedThisMonth: 114, appSafetyCap: 2800 });
});

test("prior month → monthly null, not-observed-this-month, old timestamp kept", () => {
  const v = presentEmailUsageDoc(docOf({ periodMonth: "2026-08", periodDay: "2026-08-31" }), Date.parse("2026-09-02T10:00:00Z"));
  assert.equal(v.providerAvailable, false);
  assert.equal(v.monthly, null);
  assert.equal(v.providerError.code, "not-observed-this-month");
  assert.equal(v.lastSyncedAt, "2026-08-28T12:00:00.000Z");
});

test("legacy doc without period keys → not shown as current", () => {
  const v = presentEmailUsageDoc({ monthly: { used: 40, limit: 3000, percent: 1.3 }, observedAt: "2026-08-28T12:00:00.000Z", providerUsageProven: true }, AUG);
  assert.equal(v.providerAvailable, false);
  assert.equal(v.providerError.code, "not-observed-this-month");
});

test("new day (same month) → keep monthly; daily null with not-observed-today", () => {
  const v = presentEmailUsageDoc(docOf({ periodDay: "2026-08-28", daily: { used: 7, limit: 100, percent: 7 } }), Date.parse("2026-08-29T00:30:00Z"));
  assert.equal(v.providerAvailable, true);
  assert.deepEqual(v.monthly, { used: 40, limit: 3000, percent: 1.3 });
  assert.equal(v.daily, null);
  assert.equal(v.dailyReason, "not-observed-today");
});

test("paid plan (no daily header, same day) → not-provided", () => {
  const v = presentEmailUsageDoc(docOf({ daily: null, dailyReason: "not-provided" }), AUG);
  assert.equal(v.daily, null);
  assert.equal(v.dailyReason, "not-provided");
});

test("old observation (same month) is flagged stale but still shown", () => {
  const v = presentEmailUsageDoc(docOf({ observedAt: "2026-08-27T00:00:00.000Z" }), AUG); // >12h old
  assert.equal(v.providerAvailable, true);
  assert.equal(v.stale, true);
});

test("a structurally impossible reading (3001/3000) is NOT shown as valid → invalid-provider-observation", () => {
  const v = presentEmailUsageDoc(docOf({ monthly: { used: 3001, limit: 3000, percent: 100 }, internalTelemetry: { appInitiatedThisMonth: 114, appSafetyCap: 2800 } }), AUG);
  assert.equal(v.providerAvailable, false);
  assert.equal(v.monthly, null);
  assert.equal(v.providerError.code, "invalid-provider-observation");
  assert.deepEqual(v.internalTelemetry, { appInitiatedThisMonth: 114, appSafetyCap: 2800 }); // app safety still shown
});
test("used exactly at the limit is still valid (3000/3000)", () => {
  const v = presentEmailUsageDoc(docOf({ monthly: { used: 3000, limit: 3000, percent: 100 } }), AUG);
  assert.equal(v.providerAvailable, true);
});

test("surfaces internalTelemetry (app safety usage) from the doc when present", () => {
  const v = presentEmailUsageDoc(docOf({ internalTelemetry: { appInitiatedThisMonth: 3, appSafetyCap: 2800 } }), AUG);
  assert.deepEqual(v.internalTelemetry, { appInitiatedThisMonth: 3, appSafetyCap: 2800 });
  const none = presentEmailUsageDoc(docOf(), AUG);
  assert.equal(none.internalTelemetry, null); // absent → null (component keeps the callable's value)
});
