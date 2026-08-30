/* Convert a sanitized adminDiagnostics/emailUsage document into the EmailUsage view
   model, applying the SAME period-awareness as the server callable
   (functions/resendUsage.js getResendQuotaUsage) so the real-time listener and the
   callable can't disagree. Pure + framework-free so it's node-unit-testable.
   Internal telemetry (app-initiated count, safety cap) is NOT in the sanitized doc —
   it comes only from the admin callable and is merged in by the component. */

const STALE_MS = 12 * 60 * 60 * 1000; // an observation older than this is flagged stale

// ROLLBACK-SAFETY: this is the Stage A (containment) build — provider account accounting is
// DISABLED here. The client rejects EVERY provider model, so if a rollback to this build
// happens while a valid Stage D document (providerUsageProven:true, a known model) is still
// in Firestore, the panel shows Unavailable IMMEDIATELY — no wait for another send, no
// Firestore cleanup. (The Stage D build flips this to true and additionally checks the
// model version.)
export const PROVIDER_ACCOUNTING_ENABLED = false;
export const SUPPORTED_PROVIDER_MODELS = [];
const providerTrusted = (d) =>
  PROVIDER_ACCOUNTING_ENABLED && d && d.providerUsageProven === true && SUPPORTED_PROVIDER_MODELS.includes(d.providerUsageModel);

export function periodKeys(nowMs) {
  const iso = new Date(nowMs).toISOString();
  return { month: iso.slice(0, 7), day: iso.slice(0, 10) };
}

// TRUST BOUNDARY for the admin callable (getEmailUsage) result. The callable returns a
// view-model, but an OLD (pre-fix) callable — or any callable during a mixed-version
// rollout — can report providerAvailable:true with an unproven/poisoned monthly (e.g. a
// latched 3001, or even a plausible-looking 44). A bounded number is NOT proof. Provider
// totals are trusted ONLY when the server stamped providerUsageProven===true AND the
// numbers are structurally valid (finite non-negative integer ≤ plan limit) with the
// required source metadata. Otherwise provider usage is Unavailable; independently valid
// internalTelemetry is preserved. This enforces the SAME providerUsageProven===true rule as
// presentEmailUsageDoc, so the callable path can never bypass the snapshot's trust boundary.
// (Period-awareness is applied server-side before the result is returned.)
export function normalizeCallableUsage(data) {
  const tele = (data && data.internalTelemetry) || null;
  const unavailable = (code) => ({
    providerAvailable: false, source: "internal-fallback", monthly: null, daily: null,
    dailyReason: null, lastSyncedAt: (data && data.lastSyncedAt) || null, observedVia: null,
    stale: true, internalTelemetry: tele, providerError: { code },
  });
  if (!data) return unavailable("call-failed");
  // Stage A build: accounting disabled → reject ALL provider data (any model, proven or not).
  if (!providerTrusted(data)) {
    return unavailable((data.providerError && data.providerError.code) || "provider-usage-unverified");
  }
  const intOk = (n) => Number.isInteger(n) && n >= 0;
  const blockOk = (b) => !b || (intOk(b.used) && (!Number.isInteger(b.limit) || b.used <= b.limit));
  const m = data.monthly;
  if (!m || !intOk(m.used) || (Number.isInteger(m.limit) && m.used > m.limit) || !blockOk(data.daily) || !data.source || !data.lastSyncedAt) {
    return unavailable("invalid-provider-observation");
  }
  return { ...data, internalTelemetry: tele };
}

export function presentEmailUsageDoc(doc, nowMs = Date.now()) {
  // internalTelemetry (app-initiated count + safety cap) is published by settleReservation
  // in the same doc — surface it (may be absent) so the panel's app-safety row updates live.
  const tele = (doc && doc.internalTelemetry) || null;
  if (!doc) {
    return { providerAvailable: false, source: "internal-fallback", monthly: null, daily: null,
      dailyReason: null, lastSyncedAt: null, observedVia: null, stale: true, internalTelemetry: tele, providerError: { code: "not-observed" } };
  }
  // CONTAINMENT (checked BEFORE the monthly shape, so a NEUTRALIZED doc — monthly:null,
  // providerUsageProven:false — reads as Unavailable, not "not-observed"): provider usage
  // is shown ONLY when the server explicitly stamps providerUsageProven (header semantics
  // proven + correct accounting live). Until then — including any stale/pre-fix doc that
  // still carries provider fields — report Unavailable and keep app-safety telemetry.
  // Mirrors resendUsage.getResendQuotaUsage so the listener and callable can't disagree.
  // Stage A build: accounting disabled → reject ALL provider docs, including a valid Stage D
  // document left in Firestore after a rollback (fails closed → Unavailable immediately).
  if (!providerTrusted(doc)) {
    return { providerAvailable: false, source: "internal-fallback", monthly: null, daily: null,
      dailyReason: null, lastSyncedAt: doc.observedAt || null, observedVia: null, stale: true, internalTelemetry: tele, providerError: { code: "provider-usage-unverified" } };
  }
  if (!doc.monthly || typeof doc.monthly.used !== "number") {
    return { providerAvailable: false, source: "internal-fallback", monthly: null, daily: null,
      dailyReason: null, lastSyncedAt: null, observedVia: null, stale: true, internalTelemetry: tele, providerError: { code: "not-observed" } };
  }
  // Fail-safe: never render a structurally IMPOSSIBLE reading (used > limit, e.g. a
  // poisoned 3001 / 3000) as a valid observation. Keep app-safety telemetry.
  const m = doc.monthly;
  if (!(Number.isInteger(m.used) && m.used >= 0) || (Number.isInteger(m.limit) && m.used > m.limit)) {
    return { providerAvailable: false, source: "internal-fallback", monthly: null, daily: null,
      dailyReason: null, lastSyncedAt: doc.observedAt || null, observedVia: null, stale: true, internalTelemetry: tele, providerError: { code: "invalid-provider-observation" } };
  }
  const cur = periodKeys(nowMs);
  const observedAt = doc.observedAt || null;

  // Prior-month (or legacy/no-key) observation → not current usage.
  if (doc.periodMonth !== cur.month) {
    return { providerAvailable: false, source: "resend", monthly: null, daily: null,
      dailyReason: null, lastSyncedAt: observedAt, observedVia: null, stale: true, internalTelemetry: tele, providerError: { code: "not-observed-this-month" } };
  }

  let daily = null, dailyReason = null;
  if (doc.periodDay !== cur.day) daily = null, dailyReason = "not-observed-today"; // new day, no send yet
  else if (!doc.daily) dailyReason = doc.dailyReason || "not-provided";            // plan sends no daily header
  else daily = doc.daily;

  const stale = observedAt ? !((nowMs - Date.parse(observedAt)) < STALE_MS) : true;
  return { providerAvailable: true, source: "resend", monthly: doc.monthly, daily, dailyReason,
    lastSyncedAt: observedAt, observedVia: doc.observedVia || "send", stale, internalTelemetry: tele, providerError: null };
}
