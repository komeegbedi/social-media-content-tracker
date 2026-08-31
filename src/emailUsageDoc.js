/* Convert the sanitized adminDiagnostics/emailUsageV1 document (and the getEmailUsage
   callable result) into the EmailUsage view model. DISPLAY-ONLY v1 "last observed" model:
   there is NO UTC period inference here — the newest observation is shown as-is with its
   timestamp. Pure + framework-free so it's node-unit-testable. Internal telemetry
   (app-initiated count, safety cap) is a SEPARATE, disjoint field and is preserved even
   when provider usage is unavailable. */

// DISPLAY trust boundary. Provider usage renders ONLY for the exact proven v1 model with
// providerUsageProven===true; everything else fails closed to Unavailable. This flag is
// DISPLAY-ONLY and unrelated to enforcement (which never reads this document).
export const PROVIDER_USAGE_DISPLAY_ENABLED = true;
export const SUPPORTED_PROVIDER_MODELS = ["resend-pre-send-used-v1"];
const providerTrusted = (d) =>
  PROVIDER_USAGE_DISPLAY_ENABLED && d && d.providerUsageProven === true && SUPPORTED_PROVIDER_MODELS.includes(d.model);

// Does the document even CLAIM a provider observation? (A telemetry-only doc — written by a
// send with no valid headers — carries internalTelemetry but no model/proof: that is
// "not-observed", not "unavailable".)
const claimsProvider = (d) => !!(d && (d.model != null || d.providerUsageProven === true || d.monthly != null));

const intOk = (n) => Number.isInteger(n) && n >= 0;
const blockValid = (b) => !!b && intOk(b.used) && (!Number.isInteger(b.limit) || b.used <= b.limit);

// Normalize the daily block + reason enum (null | "not-provided" | "invalid"). A present
// daily block must be structurally valid; otherwise it collapses to a reason.
function normalizeDaily(d) {
  const reason = d && (d.dailyReason === "not-provided" || d.dailyReason === "invalid") ? d.dailyReason : null;
  if (d && d.daily && blockValid(d.daily)) return { daily: d.daily, dailyReason: null };
  return { daily: null, dailyReason: reason || "not-provided" };
}

const unavailable = (code, d, tele) => ({
  providerAvailable: false, source: (d && d.source) || "internal-fallback", monthly: null, daily: null,
  dailyReason: null, lastSyncedAt: (d && d.observedAt) || (d && d.lastSyncedAt) || null, observedVia: null,
  stale: false, internalTelemetry: tele, providerError: { code },
});

// Build the shared view model from a sanitized provider snapshot (doc OR callable result).
function viewFrom(d, tele) {
  if (!d) return unavailable("not-observed", null, tele);
  if (!claimsProvider(d)) return { ...unavailable("not-observed", d, tele) };      // telemetry-only / empty
  if (!providerTrusted(d)) return unavailable("provider-usage-unverified", d, tele); // unknown model / not proven
  if (!blockValid(d.monthly)) return unavailable("invalid-provider-observation", d, tele); // poisoned / over-cap
  const { daily, dailyReason } = normalizeDaily(d);
  return {
    providerAvailable: true, source: d.source || "resend-send-response", monthly: d.monthly, daily, dailyReason,
    lastSyncedAt: d.observedAt || d.lastSyncedAt || null, observedVia: "send", stale: false,
    internalTelemetry: tele, providerError: null,
  };
}

// TRUST BOUNDARY for the admin callable (getEmailUsage) result — identical rule to the
// snapshot path, so the callable can never bypass what the listener enforces.
export function normalizeCallableUsage(data) {
  const tele = (data && data.internalTelemetry) || null;
  if (!data) return unavailable("call-failed", null, tele);
  return viewFrom(data, tele);
}

// The real-time listener path: the sanitized adminDiagnostics/emailUsageV1 doc → view model.
export function presentEmailUsageDoc(doc) {
  const tele = (doc && doc.internalTelemetry) || null;
  return viewFrom(doc, tele);
}
