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

const posInt = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };
const PLAN_MONTHLY_LIMIT = posInt(process.env.RESEND_MONTHLY_LIMIT, 3000);
const PLAN_DAILY_LIMIT = posInt(process.env.RESEND_DAILY_LIMIT, 100);

const V1_DISPLAY_DOC = "adminDiagnostics/emailUsageV1";
const MODEL = "resend-pre-send-used-v1";
const SOURCE = "resend-send-response";

/* DISPLAY-ONLY flags — DECOUPLED from enforcement (see header). QUOTA_HEADER_MODEL_PROVEN
   records the proven header model; PROVIDER_USAGE_DISPLAY_ENABLED gates whether the panel
   shows it. NEITHER may be imported by emailQuota.js / reserve() / any gate. */
const QUOTA_HEADER_MODEL_PROVEN = true;
const PROVIDER_USAGE_DISPLAY_ENABLED = true;

/* App-initiated send telemetry (this app only) — returned SEPARATELY from provider fields,
   in the SAME sanitized 2-field shape the callable has always returned. Replicated here
   (not imported) so the dormant legacy module stays byte-unchanged. Best-effort. */
async function displayTelemetry() {
  try {
    const quota = require("./emailQuota");
    const s = await quota.snapshot();
    return { appInitiatedThisMonth: s.month.sentCount || 0, appSafetyCap: s.month.monthlyLimit || quota.MONTHLY_LIMIT };
  } catch { return { appInitiatedThisMonth: null, appSafetyCap: null }; }
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

  // MONTHLY is REQUIRED. Malformed/missing/at-or-over-capacity → NO provider observation at
  // all (never fabricate zero). Both before-send and computed-after-send are validated.
  const m = validateDimension(o.monthlyUsedBeforeSend, o.acceptedUnits, PLAN_MONTHLY_LIMIT);
  if (!m.valid) {
    logger.warn("resend usage v1: monthly observation rejected (not written)", { code: m.code, reason: m.reason });
    return { invalid: true, dimension: "monthly", reason: m.reason };
  }
  const monthly = { used: m.after, limit: PLAN_MONTHLY_LIMIT, percent: pct1(m.after, PLAN_MONTHLY_LIMIT) };

  // DAILY is OPTIONAL. Absent → not-provided. Present-but-invalid → keep monthly, drop daily
  // with an EXPLICIT "invalid" reason + a sanitized server warning (no raw values/headers).
  let daily = null, dailyReason = "not-provided";
  if (o.dailyUsedBeforeSend != null) {
    const d = validateDimension(o.dailyUsedBeforeSend, o.acceptedUnits, PLAN_DAILY_LIMIT);
    if (d.valid) { daily = { used: d.after, limit: PLAN_DAILY_LIMIT, percent: pct1(d.after, PLAN_DAILY_LIMIT) }; dailyReason = null; }
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
    // OUT-OF-ORDER GUARD (last-observed, NOT high-water): a NEWER responseReceivedAt wins; an
    // older delayed response cannot regress the snapshot. A lower-but-newer value is accepted.
    if (!prevObservedAt || responseReceivedAt > prevObservedAt) {
      writeSnapshot({ model: MODEL, providerUsageProven: true, monthly, daily, dailyReason,
        observedAt: responseReceivedAt, source: SOURCE });
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
  const tele = telemetry || await displayTelemetry();
  let snap = null;
  try { snap = await st.read(); } catch { snap = null; }
  const notObserved = (code) => ({
    providerAvailable: false, providerUsageProven: false, source: SOURCE, monthly: null, daily: null,
    dailyReason: null, lastSyncedAt: (snap && snap.observedAt) || null, observedVia: null, stale: false,
    internalTelemetry: tele, providerError: { code },
  });
  if (!PROVIDER_USAGE_DISPLAY_ENABLED) return notObserved("not-observed");
  if (!snap || snap.model !== MODEL || snap.providerUsageProven !== true || !snap.monthly) return notObserved("not-observed");
  return {
    providerAvailable: true, providerUsageProven: true, model: MODEL, source: SOURCE,
    monthly: snap.monthly, daily: snap.daily || null, dailyReason: snap.dailyReason || null,
    lastSyncedAt: snap.observedAt || null, observedVia: "send", stale: false,
    internalTelemetry: tele, providerError: null,
  };
}

module.exports = {
  recordObservationV1, getObservationV1, displayTelemetry,
  QUOTA_HEADER_MODEL_PROVEN, PROVIDER_USAGE_DISPLAY_ENABLED,
  PLAN_MONTHLY_LIMIT, PLAN_DAILY_LIMIT, V1_DISPLAY_DOC, MODEL, SOURCE,
};
