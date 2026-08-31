/* Convert the sanitized adminDiagnostics/emailUsageV1 document (and the getEmailUsage
   callable result) into the EmailUsage view model. DISPLAY-ONLY v1 "last observed" model:
   NO UTC period inference — the newest observation is shown as-is with its timestamp.

   This is a STRICT, FAIL-CLOSED trust boundary that MIRRORS the server sanitizer
   (functions/resendObservationV1.js): exact v1 plan limits, integer ranges, a RECOMPUTED
   percentage (persisted percent is never trusted), a canonical ISO timestamp, and a strict
   dailyReason enum. Any missing/contradictory value → Unavailable. Never throws while
   rendering. Internal telemetry is a SEPARATE, disjoint four-field contract, preserved even
   when provider usage is unavailable. Pure + framework-free so it's node-unit-testable. */

// DISPLAY trust boundary — unrelated to enforcement (which never reads this document).
export const PROVIDER_USAGE_DISPLAY_ENABLED = true;
export const SUPPORTED_PROVIDER_MODELS = ["resend-pre-send-used-v1"];
// EXACT v1 plan limits. If Resend changes these, ship a NEW versioned model — never silently
// accept a different limit under v1.
const MONTHLY_LIMIT_V1 = 3000;
const DAILY_LIMIT_V1 = 100;

const isNonNegInt = (n) => Number.isInteger(n) && n >= 0;
// Canonical ISO instant that round-trips through Date (the form toISOString() produces).
const isCanonicalIso = (s) =>
  typeof s === "string" && s.length > 0 && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
// Recompute the percentage from validated used/limit; clamp finite result to 0..100.
function safePercent(used, limit) {
  const p = limit > 0 ? Math.round((used / limit) * 1000) / 10 : null;
  return p == null || !Number.isFinite(p) ? 0 : Math.min(100, Math.max(0, p));
}
// A dimension block is valid ONLY at its EXACT v1 plan limit with an integer used in
// [0, limit]. Returns a RECOMPUTED sanitized block, or null (fail closed).
function sanitizeBlock(b, planLimit) {
  if (!b || !isNonNegInt(b.used) || b.limit !== planLimit || b.used > planLimit) return null;
  return { used: b.used, limit: planLimit, percent: safePercent(b.used, planLimit) };
}
// The exact four-field internal-telemetry contract emailQuota.settleReservation writes. All
// non-negative integers, each used <= its configured limit; else null (fail closed). Used by
// BOTH the callable-normalize and the snapshot paths so Refresh and live render identically.
export function sanitizeTelemetry(t) {
  if (!t) return null;
  const { appInitiatedThisMonth: mU, appSafetyCap: mC, appDailyThisDay: dU, appDailyLimit: dC } = t;
  if (![mU, mC, dU, dC].every(isNonNegInt)) return null;
  if (mU > mC || dU > dC) return null;
  return { appInitiatedThisMonth: mU, appSafetyCap: mC, appDailyThisDay: dU, appDailyLimit: dC };
}

const providerTrusted = (d) =>
  PROVIDER_USAGE_DISPLAY_ENABLED && d && d.providerUsageProven === true && SUPPORTED_PROVIDER_MODELS.includes(d.model);
// Does the doc even CLAIM a provider observation? A telemetry-only doc (a send with no valid
// headers) carries internalTelemetry but no model/proof: that is "not-observed", not "invalid".
const claimsProvider = (d) => !!(d && (d.model != null || d.providerUsageProven === true || d.monthly != null));

const unavailable = (code, d, tele) => ({
  providerAvailable: false, source: (d && d.source) || "internal-fallback", monthly: null, daily: null,
  dailyReason: null, lastSyncedAt: (d && isCanonicalIso(d.observedAt) ? d.observedAt : (d && isCanonicalIso(d.lastSyncedAt) ? d.lastSyncedAt : null)),
  observedVia: null, stale: false, internalTelemetry: tele, providerError: { code },
});

// Build the shared view model from a sanitized provider snapshot (doc OR callable result).
// STRICT + fail-closed; never throws (any unexpected shape → invalid-provider-observation).
function viewFrom(d, tele) {
  try {
    if (!d) return unavailable("not-observed", null, tele);
    if (!claimsProvider(d)) return unavailable("not-observed", d, tele);          // telemetry-only / empty
    if (!providerTrusted(d)) return unavailable("provider-usage-unverified", d, tele); // unknown model / not proven
    const monthly = sanitizeBlock(d.monthly, MONTHLY_LIMIT_V1);
    const observedAt = isCanonicalIso(d.observedAt) ? d.observedAt : (isCanonicalIso(d.lastSyncedAt) ? d.lastSyncedAt : null);
    if (!monthly || !observedAt) return unavailable("invalid-provider-observation", d, tele);
    let daily = null, dailyReason;
    if (d.daily != null) {                                                        // present ⇒ reason must be null
      daily = sanitizeBlock(d.daily, DAILY_LIMIT_V1);
      if (!daily || d.dailyReason != null) return unavailable("invalid-provider-observation", d, tele);
      dailyReason = null;
    } else {                                                                      // absent ⇒ exactly not-provided|invalid
      if (d.dailyReason !== "not-provided" && d.dailyReason !== "invalid") return unavailable("invalid-provider-observation", d, tele);
      dailyReason = d.dailyReason;
    }
    return {
      providerAvailable: true, source: "resend-send-response", monthly, daily, dailyReason,
      lastSyncedAt: observedAt, observedVia: "send", stale: false, internalTelemetry: tele, providerError: null,
    };
  } catch {
    return unavailable("invalid-provider-observation", null, tele);              // never throw during render
  }
}

// TRUST BOUNDARY for the admin callable (getEmailUsage) result — identical rule to the
// snapshot path, so the callable can never bypass what the listener enforces.
export function normalizeCallableUsage(data) {
  const tele = sanitizeTelemetry(data && data.internalTelemetry);
  if (!data) return unavailable("call-failed", null, tele);
  return viewFrom(data, tele);
}

// The real-time listener path: the sanitized adminDiagnostics/emailUsageV1 doc → view model.
export function presentEmailUsageDoc(doc) {
  const tele = sanitizeTelemetry(doc && doc.internalTelemetry);
  return viewFrom(doc, tele);
}
