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
const TELE = { appInitiatedThisMonth: 119, appSafetyCap: 2800, appDailyThisDay: 5, appDailyLimit: 90 };

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
    daily: { used: 3, limit: 100, percent: 3 }, dailyReason: null, lastSyncedAt: "2026-08-30T10:00:00.000Z", internalTelemetry: TELE });
  assert.equal(v.providerAvailable, true);
  assert.deepEqual(v.monthly, { used: 44, limit: 3000, percent: 1.5 });
  assert.deepEqual(v.internalTelemetry, TELE);
});

test("callable: unknown model → Unavailable even if it claims providerAvailable:true", () => {
  const v = normalizeCallableUsage({ providerAvailable: true, providerUsageProven: true, model: "resend-future-v2",
    source: "resend-send-response", monthly: { used: 44, limit: 3000, percent: 1.5 }, lastSyncedAt: "2026-08-30T10:00:00.000Z", internalTelemetry: TELE });
  assert.equal(v.providerAvailable, false);
  assert.equal(v.providerError.code, "provider-usage-unverified");
});

test("callable: a bounded but UNPROVEN value is Unavailable (bounded ≠ proof)", () => {
  const v = normalizeCallableUsage({ providerAvailable: true, source: "resend-send-response",
    monthly: { used: 44, limit: 3000, percent: 1.5 }, lastSyncedAt: "2026-08-30T10:00:00.000Z", internalTelemetry: TELE });
  assert.equal(v.providerAvailable, false);
});

test("callable: a proven-but-poisoned value (3001) is rejected even with the stamp", () => {
  const v = normalizeCallableUsage({ providerAvailable: true, providerUsageProven: true, model: MODEL,
    source: "resend-send-response", monthly: { used: 3001, limit: 3000, percent: 100 }, lastSyncedAt: "2026-08-30T10:00:00.000Z", internalTelemetry: TELE });
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

/* ---- P0 hardening: strict trust-boundary validation (fail closed, never throw) ---- */
import { sanitizeTelemetry } from "./emailUsageDoc.js";

test("a missing/string/fractional/negative/zero/incorrect monthly limit fails closed", () => {
  for (const bad of [undefined, "3000", 3000.5, -3000, 0, 5000, 100]) {
    const v = presentEmailUsageDoc(v1({ monthly: { used: 42, limit: bad } }));
    assert.equal(v.providerAvailable, false, `limit ${bad} must fail closed`);
    assert.equal(v.monthly, null);
  }
});

test("used > limit fails closed (monthly and daily)", () => {
  assert.equal(presentEmailUsageDoc(v1({ monthly: { used: 3001, limit: 3000 } })).providerAvailable, false);
  assert.equal(presentEmailUsageDoc(v1({ daily: { used: 101, limit: 100 } })).providerAvailable, false);
});

test("persisted percent is IGNORED and recomputed (NaN/Infinity/negative/inconsistent)", () => {
  for (const p of [NaN, Infinity, -50, 9999]) {
    const v = presentEmailUsageDoc(v1({ monthly: { used: 42, limit: 3000, percent: p } }));
    assert.equal(v.providerAvailable, true);
    assert.equal(v.monthly.percent, 1.4, `percent recomputed regardless of persisted ${p}`);
  }
});

test("a non-canonical / invalid observedAt fails closed", () => {
  assert.equal(presentEmailUsageDoc(v1({ observedAt: "2026-08-30" })).providerAvailable, false);
  assert.equal(presentEmailUsageDoc(v1({ observedAt: "garbage" })).providerAvailable, false);
  assert.equal(presentEmailUsageDoc(v1({ observedAt: 1724990400000 })).providerAvailable, false);
});

test("contradictory dailyReason combinations fail closed", () => {
  // present daily block but a non-null reason
  assert.equal(presentEmailUsageDoc(v1({ daily: { used: 3, limit: 100 }, dailyReason: "not-provided" })).providerAvailable, false);
  // absent daily block but reason null
  assert.equal(presentEmailUsageDoc(v1({ daily: null, dailyReason: null })).providerAvailable, false);
  // absent daily block, unknown reason
  assert.equal(presentEmailUsageDoc(v1({ daily: null, dailyReason: "bogus" })).providerAvailable, false);
});

test("the P0 crasher {used:42, limit:undefined} never throws → Unavailable, no totals", () => {
  const v = presentEmailUsageDoc({ model: MODEL, providerUsageProven: true,
    monthly: { used: 42, limit: undefined }, daily: null, dailyReason: "not-provided",
    observedAt: "2026-08-30T12:00:00.000Z", source: "resend-send-response", internalTelemetry: TELE });
  assert.equal(v.providerAvailable, false);
  assert.equal(v.monthly, null);
  assert.equal(v.providerError.code, "invalid-provider-observation");
  assert.deepEqual(v.internalTelemetry, TELE);
});

test("sanitizeTelemetry: only the four-field contract with used<=limit survives", () => {
  assert.deepEqual(sanitizeTelemetry(TELE), TELE);
  assert.equal(sanitizeTelemetry({ appInitiatedThisMonth: 5, appSafetyCap: 2800 }), null); // 2-field dropped
  assert.equal(sanitizeTelemetry({ ...TELE, appDailyThisDay: 91, appDailyLimit: 90 }), null); // used>limit
  assert.equal(sanitizeTelemetry({ ...TELE, appSafetyCap: -1 }), null);
  assert.equal(sanitizeTelemetry(null), null);
});

test("a partial (2-field) telemetry is dropped but the provider observation still renders", () => {
  const v = presentEmailUsageDoc(v1({ internalTelemetry: { appInitiatedThisMonth: 5, appSafetyCap: 2800 } }));
  assert.equal(v.providerAvailable, true);
  assert.equal(v.internalTelemetry, null, "incomplete telemetry contract is not shown");
});

test("the exact source is required; missing/unknown/non-string fails closed", () => {
  const noSrc = v1(); delete noSrc.source;
  assert.equal(presentEmailUsageDoc(noSrc).providerError.code, "invalid-provider-observation");
  assert.equal(presentEmailUsageDoc(v1({ source: "spoofed" })).providerError.code, "invalid-provider-observation");
  assert.equal(presentEmailUsageDoc(v1({ source: 123 })).providerError.code, "invalid-provider-observation");
  assert.equal(presentEmailUsageDoc(v1({ source: "resend-send-response" })).providerAvailable, true);
});

test("sanitizeTelemetry requires POSITIVE-integer limits (0/0 invalid)", () => {
  assert.equal(sanitizeTelemetry({ appInitiatedThisMonth: 0, appSafetyCap: 0, appDailyThisDay: 0, appDailyLimit: 0 }), null);
  assert.equal(sanitizeTelemetry({ ...TELE, appSafetyCap: 0 }), null);
  assert.equal(sanitizeTelemetry({ ...TELE, appDailyLimit: 0 }), null);
});

test("callable: a server read-failed verdict is PRESERVED (never relabeled not-observed)", () => {
  const v = normalizeCallableUsage({ providerAvailable: false, providerUsageProven: false, monthly: null,
    providerError: { code: "read-failed" }, internalTelemetry: TELE });
  assert.equal(v.providerAvailable, false);
  assert.equal(v.providerError.code, "read-failed", "transient read failure kept distinct");
  assert.deepEqual(v.internalTelemetry, TELE);
});
