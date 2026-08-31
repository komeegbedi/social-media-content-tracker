/* Sanitized v1 email-usage doc / callable → view model (pure, display-only).
   No UTC period inference: the newest observation is shown as-is. Run: node --test src/emailUsageDoc.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { presentEmailUsageDoc, normalizeCallableUsage } from "./emailUsageDoc.js";

const MODEL = "resend-pre-send-used-v1";
// A sanitized adminDiagnostics/emailUsageV1 document.
const v1 = (over = {}) => ({
  model: MODEL, providerUsageProven: true,
  monthly: { used: 42, limit: 3000, percent: 1.4 },
  daily: { used: 3, limit: 100, percent: 3 }, dailyReason: null,
  observedAt: "2026-08-30T12:00:00.000Z", source: "resend-send-response", ...over,
});
const TELE = { appInitiatedThisMonth: 119, appSafetyCap: 2800 };

/* ---- presentEmailUsageDoc (real-time listener path) ---- */
test("a valid v1 doc → provider available (monthly + daily), no period gating", () => {
  const v = presentEmailUsageDoc(v1({ internalTelemetry: TELE }));
  assert.equal(v.providerAvailable, true);
  assert.deepEqual(v.monthly, { used: 42, limit: 3000, percent: 1.4 });
  assert.deepEqual(v.daily, { used: 3, limit: 100, percent: 3 });
  assert.equal(v.dailyReason, null);
  assert.equal(v.lastSyncedAt, "2026-08-30T12:00:00.000Z");
  assert.deepEqual(v.internalTelemetry, TELE);
});

test("an OLD observedAt still renders (no not-observed-this-month period logic)", () => {
  const v = presentEmailUsageDoc(v1({ observedAt: "2026-01-01T00:00:00.000Z" }));
  assert.equal(v.providerAvailable, true, "last-observed model ignores calendar period");
  assert.equal(v.lastSyncedAt, "2026-01-01T00:00:00.000Z");
});

test("a lower-but-later value renders as-is (never a fabricated reset/period)", () => {
  const v = presentEmailUsageDoc(v1({ monthly: { used: 9, limit: 3000, percent: 0.3 } }));
  assert.equal(v.providerAvailable, true);
  assert.equal(v.monthly.used, 9);
});

test("absent doc → not-observed", () => {
  const v = presentEmailUsageDoc(null);
  assert.equal(v.providerAvailable, false);
  assert.equal(v.providerError.code, "not-observed");
  assert.equal(v.monthly, null);
});

test("telemetry-only doc (no model, from a header-less send) → not-observed, telemetry kept", () => {
  const v = presentEmailUsageDoc({ internalTelemetry: TELE });
  assert.equal(v.providerAvailable, false);
  assert.equal(v.providerError.code, "not-observed");
  assert.deepEqual(v.internalTelemetry, TELE);
});

test("unknown model → Unavailable (fails closed), telemetry kept", () => {
  const v = presentEmailUsageDoc(v1({ model: "resend-future-v2", internalTelemetry: TELE }));
  assert.equal(v.providerAvailable, false);
  assert.equal(v.providerError.code, "provider-usage-unverified");
  assert.deepEqual(v.internalTelemetry, TELE);
});

test("missing providerUsageProven stamp → Unavailable", () => {
  const d = v1(); delete d.providerUsageProven;
  assert.equal(presentEmailUsageDoc(d).providerAvailable, false);
});

test("structurally impossible monthly (3001/3000, poisoned) → invalid-provider-observation, telemetry kept", () => {
  const v = presentEmailUsageDoc(v1({ monthly: { used: 3001, limit: 3000, percent: 100 }, internalTelemetry: TELE }));
  assert.equal(v.providerAvailable, false);
  assert.equal(v.providerError.code, "invalid-provider-observation");
  assert.deepEqual(v.internalTelemetry, TELE);
});

test("used exactly at limit (3000/3000) is valid", () => {
  assert.equal(presentEmailUsageDoc(v1({ monthly: { used: 3000, limit: 3000, percent: 100 } })).providerAvailable, true);
});

test("daily not-provided → daily null with reason", () => {
  const v = presentEmailUsageDoc(v1({ daily: null, dailyReason: "not-provided" }));
  assert.equal(v.providerAvailable, true);
  assert.equal(v.daily, null);
  assert.equal(v.dailyReason, "not-provided");
});

test("daily invalid → daily null with explicit 'invalid' reason (not collapsed to not-provided)", () => {
  const v = presentEmailUsageDoc(v1({ daily: null, dailyReason: "invalid" }));
  assert.equal(v.daily, null);
  assert.equal(v.dailyReason, "invalid");
});

/* ---- normalizeCallableUsage (getEmailUsage result) — same trust boundary ---- */
test("callable: a proven v1 result renders; telemetry preserved", () => {
  const v = normalizeCallableUsage({ providerAvailable: true, providerUsageProven: true, model: MODEL,
    source: "resend-send-response", monthly: { used: 44, limit: 3000, percent: 1.5 },
    daily: { used: 3, limit: 100, percent: 3 }, dailyReason: null, lastSyncedAt: "2026-08-30T10:00:00Z", internalTelemetry: TELE });
  assert.equal(v.providerAvailable, true);
  assert.deepEqual(v.monthly, { used: 44, limit: 3000, percent: 1.5 });
  assert.deepEqual(v.internalTelemetry, TELE);
});

test("callable: unknown model → Unavailable even if it claims providerAvailable:true", () => {
  const v = normalizeCallableUsage({ providerAvailable: true, providerUsageProven: true, model: "resend-future-v2",
    source: "resend-send-response", monthly: { used: 44, limit: 3000, percent: 1.5 }, lastSyncedAt: "2026-08-30T10:00:00Z", internalTelemetry: TELE });
  assert.equal(v.providerAvailable, false);
  assert.equal(v.providerError.code, "provider-usage-unverified");
});

test("callable: a bounded but UNPROVEN value is Unavailable (bounded ≠ proof)", () => {
  const v = normalizeCallableUsage({ providerAvailable: true, source: "resend-send-response",
    monthly: { used: 44, limit: 3000, percent: 1.5 }, lastSyncedAt: "2026-08-30T10:00:00Z", internalTelemetry: TELE });
  assert.equal(v.providerAvailable, false);
});

test("callable: a proven-but-poisoned value (3001) is rejected even with the stamp", () => {
  const v = normalizeCallableUsage({ providerAvailable: true, providerUsageProven: true, model: MODEL,
    source: "resend-send-response", monthly: { used: 3001, limit: 3000, percent: 100 }, lastSyncedAt: "2026-08-30T10:00:00Z", internalTelemetry: TELE });
  assert.equal(v.providerAvailable, false);
  assert.equal(v.providerError.code, "invalid-provider-observation");
});

test("callable: not-observed result → not-observed, telemetry kept", () => {
  const v = normalizeCallableUsage({ providerAvailable: false, providerUsageProven: false, monthly: null,
    providerError: { code: "not-observed" }, internalTelemetry: TELE });
  assert.equal(v.providerAvailable, false);
  assert.deepEqual(v.internalTelemetry, TELE);
});

test("callable: null data → call-failed, no throw", () => {
  assert.equal(normalizeCallableUsage(null).providerError.code, "call-failed");
});
