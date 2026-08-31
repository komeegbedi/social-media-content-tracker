/* ===================================================================
   Resend account usage — DISPLAY-ONLY "last observed" model (v1).

   PROVEN header model (QUOTA_HEADER_MODEL_PROVEN): a SUCCESSFUL POST /emails response
   carries x-resend-monthly-quota / x-resend-daily-quota as USED counters observed BEFORE
   this accepted request is counted, so post-send used = header + acceptedUnits. This
   module records that SANITIZED observation for the admin panel ONLY.

   It NEVER feeds enforcement: no reserve() gate, no priority gate, no exhaustion marker,
   no provider-period logic. The display flags below (QUOTA_HEADER_MODEL_PROVEN,
   PROVIDER_USAGE_DISPLAY_ENABLED) MUST NOT be imported by emailQuota.js or any enforcement
   path. Enforcement remains governed solely by the app-owned caps + priority gates, with
   PROVIDER_PERIOD_BASED_ENFORCEMENT_ENABLED=false and the legacy enforcement-facing
   HEADER_SEMANTICS_PROVEN=false (that legacy constant name is intentionally left unchanged
   in this scoped change even though it now reads as misleading).

   "LAST OBSERVED", not high-water: the newest response (by responseReceivedAt) wins; a
   lower-but-newer value is accepted as a NEW observation (the provider may have reset its
   counter) — never labelled a reset, never tied to a guessed UTC period. No Math.max, no
   period keys, no reset inference, no alerts.

   Storage (approved, TWO docs only):
     • emailDeliveries/{deliveryId}  — server-only idempotency receipt (usageV1Applied)
     • adminDiagnostics/emailUsageV1 — sanitized current-display snapshot
   The poisoned/legacy docs (systemUsage/resendQuota, adminDiagnostics/emailUsage) are
   NEVER read or written here.
   =================================================================== */
const { logger } = require("firebase-functions/v2");
const { pct1, validateDimension } = require("./resendQuotaMath");

// IMMUTABLE v1 schema limits. The "resend-pre-send-used-v1" model is DEFINED at these
// literals; it is deliberately NOT derived from enforcement env (RESEND_MONTHLY_LIMIT /
// RESEND_DAILY_LIMIT), so a production override of the app's caps can never make the server
// publish a v1 document that the client necessarily rejects. A future plan with different
// limits ⇒ a NEW provider model version, never a re-parameterization of v1.
const V1_MONTHLY_LIMIT = 3000;
const V1_DAILY_LIMIT = 100;

const V1_DISPLAY_DOC = "adminDiagnostics/emailUsageV1";
const MODEL = "resend-pre-send-used-v1";
const SOURCE = "resend-send-response";

/* DISPLAY-ONLY flags — DECOUPLED from enforcement (see header). QUOTA_HEADER_MODEL_PROVEN
   records the proven header model; PROVIDER_USAGE_DISPLAY_ENABLED gates whether the panel
   shows it. NEITHER may be imported by emailQuota.js / reserve() / any gate. */
const QUOTA_HEADER_MODEL_PROVEN = true;
const PROVIDER_USAGE_DISPLAY_ENABLED = true;

// ---- strict V1 schema validation (the SAME contract enforced on the client) ----
const isNonNegInt = (n) => Number.isInteger(n) && n >= 0;
const isPosInt = (n) => Number.isInteger(n) && n > 0;
// A canonical ISO instant that round-trips through Date (the form new Date().toISOString()
// produces). Rejects strings, junk, and non-canonical variants.
const isCanonicalIso = (s) =>
  typeof s === "string" && s.length > 0 && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
// Recompute the percentage from validated used/limit — NEVER trust a persisted percent;
// clamp finite result to 0..100.
function safePercent(used, limit) {
  const p = pct1(used, limit);
  return p == null || !Number.isFinite(p) ? 0 : Math.min(100, Math.max(0, p));
}
// A dimension block is valid ONLY at its EXACT v1 plan limit with an integer used in
// [0, limit]. Returns a RECOMPUTED sanitized block, or null (fail closed).
function sanitizeBlock(b, planLimit) {
  if (!b || !isNonNegInt(b.used) || b.limit !== planLimit || b.used > planLimit) return null;
  return { used: b.used, limit: planLimit, percent: safePercent(b.used, planLimit) };
}
// Full sanitize of a stored/candidate v1 snapshot. Returns the sanitized presentation
// fields or null. `code` distinguishes not-observed vs unverified vs invalid for callers.
function sanitizeV1Snapshot(snap) {
  const claims = !!(snap && (snap.model != null || snap.providerUsageProven === true || snap.monthly != null));
  if (!claims) return { ok: false, code: "not-observed" };
  if (snap.model !== MODEL || snap.providerUsageProven !== true) return { ok: false, code: "provider-usage-unverified" };
  const monthly = sanitizeBlock(snap.monthly, V1_MONTHLY_LIMIT);
  // The full declared contract, incl. the exact source string and a canonical observedAt.
  if (!monthly || !isCanonicalIso(snap.observedAt) || snap.source !== SOURCE) return { ok: false, code: "invalid-provider-observation" };
  let daily = null, dailyReason;
  if (snap.daily != null) {                                    // present block ⇒ reason must be null
    daily = sanitizeBlock(snap.daily, V1_DAILY_LIMIT);
    if (!daily || snap.dailyReason != null) return { ok: false, code: "invalid-provider-observation" };
    dailyReason = null;
  } else {                                                     // absent block ⇒ exactly not-provided|invalid
    if (snap.dailyReason !== "not-provided" && snap.dailyReason !== "invalid") return { ok: false, code: "invalid-provider-observation" };
    dailyReason = snap.dailyReason;
  }
  return { ok: true, monthly, daily, dailyReason, observedAt: snap.observedAt };
}
// Sanitize the four-field internal-telemetry contract (matches emailQuota's write): USED
// counters are non-negative integers, LIMITS are POSITIVE integers (a 0/0 pair is invalid),
// and each used ≤ its limit; else null (fail closed).
function sanitizeTelemetry(t) {
  if (!t) return null;
  const { appInitiatedThisMonth: mUsed, appSafetyCap: mCap, appDailyThisDay: dUsed, appDailyLimit: dCap } = t;
  if (!isNonNegInt(mUsed) || !isNonNegInt(dUsed) || !isPosInt(mCap) || !isPosInt(dCap)) return null;
  if (mUsed > mCap || dUsed > dCap) return null;
  return { appInitiatedThisMonth: mUsed, appSafetyCap: mCap, appDailyThisDay: dUsed, appDailyLimit: dCap };
}

/* App-initiated send telemetry (this app only) — returned SEPARATELY from provider fields
   in the EXACT four-field contract emailQuota.settleReservation writes, so Refresh (callable)
   and the live snapshot render identical telemetry. Replicated here (not imported) so the
   dormant legacy module stays byte-unchanged. Best-effort → null when unavailable. */
async function displayTelemetry() {
  try {
    const quota = require("./emailQuota");
    const s = await quota.snapshot();
    return {
      appInitiatedThisMonth: s.month.sentCount || 0,
      appSafetyCap: s.month.monthlyLimit || quota.MONTHLY_LIMIT,
      appDailyThisDay: s.day.sentCount || 0,
      appDailyLimit: s.day.dailyLimit || quota.DAILY_LIMIT,
    };
  } catch { return null; }
}

function firestoreStore() {
  const { db } = require("./lib"); // lazy → module loads without firebase-admin (unit tests)
  return { read: async () => { const s = await db.doc(V1_DISPLAY_DOC).get(); return s.exists ? s.data() : null; } };
}

/* Record a POST-SEND observation from a SUCCESSFUL send. Transient inputs (NEVER published):
     { monthlyUsedBeforeSend, dailyUsedBeforeSend?, acceptedUnits, deliveryId, responseReceivedAt }
   `responseReceivedAt` is an ISO string captured immediately after the successful Resend
   response, BEFORE the transaction — it orders observations by application response-receipt
   time, NOT by any claimed Resend billing period. Best-effort; NEVER fails the already-
   accepted email (Firestore errors propagate to the caller's try/catch). `runTransaction`
   is injectable for unit tests. */
async function recordObservationV1(observed, { runTransaction, proven = QUOTA_HEADER_MODEL_PROVEN } = {}) {
  const o = observed || {};
  if (!proven) return { skipped: true, reason: "display-disabled" };
  const deliveryId = o.deliveryId;
  const responseReceivedAt = o.responseReceivedAt;
  if (!deliveryId || !responseReceivedAt) return { skipped: true, reason: "missing-delivery-context" };
  // Require a CANONICAL ISO instant BEFORE any transaction/receipt mutation — not merely a
  // Date.parse-able value (so "2026-08-30", odd tz forms, numbers, etc. are rejected without
  // writing). Ordering compares by milliseconds (never lexicographically).
  if (!isCanonicalIso(responseReceivedAt)) { logger.warn("resend usage v1: non-canonical responseReceivedAt (rejected)", {}); return { skipped: true, reason: "invalid-timestamp" }; }
  const incomingMs = Date.parse(responseReceivedAt);
  const observedAtIso = responseReceivedAt;

  // MONTHLY is REQUIRED. Malformed/missing/at-or-over-capacity → NO provider observation at
  // all (never fabricate zero). Both before-send and computed-after-send are validated.
  const m = validateDimension(o.monthlyUsedBeforeSend, o.acceptedUnits, V1_MONTHLY_LIMIT);
  if (!m.valid) {
    logger.warn("resend usage v1: monthly observation rejected (not written)", { code: m.code, reason: m.reason });
    return { invalid: true, dimension: "monthly", reason: m.reason };
  }
  const monthly = { used: m.after, limit: V1_MONTHLY_LIMIT, percent: pct1(m.after, V1_MONTHLY_LIMIT) };

  // DAILY is OPTIONAL. Absent → not-provided. Present-but-invalid → keep monthly, drop daily
  // with an EXPLICIT "invalid" reason + a sanitized server warning (no raw values/headers).
  let daily = null, dailyReason = "not-provided";
  if (o.dailyUsedBeforeSend != null) {
    const d = validateDimension(o.dailyUsedBeforeSend, o.acceptedUnits, V1_DAILY_LIMIT);
    if (d.valid) { daily = { used: d.after, limit: V1_DAILY_LIMIT, percent: pct1(d.after, V1_DAILY_LIMIT) }; dailyReason = null; }
    else { dailyReason = "invalid"; logger.warn("resend usage v1: daily observation invalid (monthly retained)", { reason: d.reason }); }
  }

  const { db, FieldValue } = require("./lib");
  const run = runTransaction || ((fn) => db.runTransaction(async (t) => {
    const delRef = db.doc(`emailDeliveries/${deliveryId}`);
    const pubRef = db.doc(V1_DISPLAY_DOC);
    const delSnap = await t.get(delRef);   // reads BEFORE writes
    const pubSnap = await t.get(pubRef);
    return fn({
      deliveryExists: delSnap.exists,
      alreadyApplied: !!(delSnap.exists && delSnap.data().usageV1Applied === true),
      prevObservedAt: pubSnap.exists ? (pubSnap.data().observedAt || null) : null,
      writeSnapshot: (data) => t.set(pubRef, data, { merge: true }),   // merge → keeps disjoint internalTelemetry
      markApplied: () => t.set(delRef, { usageV1Applied: true, usageV1AppliedAt: FieldValue.serverTimestamp() }, { merge: true }),
    });
  }));

  return run(({ deliveryExists, alreadyApplied, prevObservedAt, writeSnapshot, markApplied }) => {
    if (!deliveryExists) return { skipped: true, reason: "no-delivery-receipt" };  // never orphan a receipt/snapshot
    if (alreadyApplied) return { replay: true };                                   // exactly-once
    // OUT-OF-ORDER GUARD (last-observed, NOT high-water): compare by MILLISECONDS. A newer
    // responseReceivedAt wins; an older delayed response cannot regress the snapshot; a
    // lower-but-newer value is accepted. A MALFORMED stored observedAt is treated as
    // absent so the next valid observation REPAIRS the document.
    const prevMs = Date.parse(prevObservedAt);
    const prevValid = prevObservedAt != null && !Number.isNaN(prevMs);
    if (!prevValid || incomingMs > prevMs) {
      writeSnapshot({ model: MODEL, providerUsageProven: true, monthly, daily, dailyReason,
        observedAt: observedAtIso, source: SOURCE });
    }
    markApplied();   // this delivery is accounted for even if it lost the ordering race
    return { applied: true };
  });
}

/* Read the SANITIZED last-observed usage for the admin panel + callable. NO live fetch, NO
   period gating. providerAvailable:false ("not-observed") until a valid v1 observation
   exists; otherwise the sanitized presentation model + separated telemetry. Never throws. */
async function getObservationV1({ store, telemetry } = {}) {
  const st = store || firestoreStore();
  const tele = sanitizeTelemetry(telemetry || await displayTelemetry());
  const unavailable = (code, snap) => ({
    providerAvailable: false, providerUsageProven: false, source: SOURCE, monthly: null, daily: null,
    dailyReason: null, lastSyncedAt: (snap && isCanonicalIso(snap.observedAt)) ? snap.observedAt : null,
    observedVia: null, stale: false, internalTelemetry: tele, providerError: { code },
  });
  if (!PROVIDER_USAGE_DISPLAY_ENABLED) return unavailable("not-observed", null);
  // An ACTUAL read failure is distinct from a genuine absence: return "read-failed" so the
  // client can preserve a shown observation and never mislabel a transient outage as
  // "no usage observed". `not-observed` is returned ONLY on a successful, empty read.
  let snap;
  try { snap = await st.read(); } catch { return unavailable("read-failed", null); }
  const v = sanitizeV1Snapshot(snap);
  if (!v.ok) return unavailable(v.code, snap);   // not-observed | provider-usage-unverified | invalid-provider-observation
  return {
    providerAvailable: true, providerUsageProven: true, model: MODEL, source: SOURCE,
    monthly: v.monthly, daily: v.daily, dailyReason: v.dailyReason,
    lastSyncedAt: v.observedAt, observedVia: "send", stale: false,
    internalTelemetry: tele, providerError: null,
  };
}

module.exports = {
  recordObservationV1, getObservationV1, displayTelemetry,
  sanitizeV1Snapshot, sanitizeBlock, sanitizeTelemetry, isCanonicalIso, safePercent,
  QUOTA_HEADER_MODEL_PROVEN, PROVIDER_USAGE_DISPLAY_ENABLED,
  V1_MONTHLY_LIMIT, V1_DAILY_LIMIT, V1_DISPLAY_DOC, MODEL, SOURCE,
};
