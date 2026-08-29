/* ===================================================================
   Resend account email-usage — "last observed" model.

   Resend does NOT expose usage on GET /emails (confirmed against the live account —
   only ratelimit-* request-throttle headers). It DOES return the account quota on a
   SEND: POST /emails responses carry
     x-resend-monthly-quota : used monthly account quota
     x-resend-daily-quota   : used daily account quota (free plan; absent ⇒ null)
   So emailService.js captures those on every successful send and calls
   recordObservedUsage() here, which caches them in a server-only Firestore doc and
   fires threshold alerts. The diagnostics panel reads that cache — there is no live
   "refresh" fetch, because the value only advances when the app sends email. It's
   therefore labelled "last observed", with the observation timestamp.

   The app's internal safety cap (emailQuota.js, 2,800/mo) is SEPARATE and is never
   presented as a Resend limit. A provider-unavailable state (nothing observed yet)
   returns providerAvailable:false — never a fabricated zero.
   =================================================================== */
const { logger } = require("firebase-functions/v2");

const posInt = (v, dflt) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : dflt; };
// PLAN limits (Resend account) — SEPARATE from the app's safety cap. Defaults match
// this Free account (3,000/mo, 100/day); override via env.
const PLAN_MONTHLY_LIMIT = posInt(process.env.RESEND_MONTHLY_LIMIT, 3000);
const PLAN_DAILY_LIMIT = posInt(process.env.RESEND_DAILY_LIMIT, 100);
const CACHE_DOC = "systemUsage/resendQuota";              // internal cache (server-only)
const PUBLIC_DOC = "adminDiagnostics/emailUsage";        // sanitized, admin-readable (real-time)

/* ---- CONTAINMENT: provider header semantics are NOT proven ----------------
   The x-resend-monthly-quota / x-resend-daily-quota headers have NOT been proven to be
   "used" counts (they could be remaining, plan capacity, or request-throttle values —
   see INCIDENT-resend-usage.md §3). A value that merely falls in [0, planLimit] is NOT
   evidence that it is a usage count. Until one controlled production observation proves
   the model, we DO NOT interpret these headers as usage:
     • recordObservedUsage persists NOTHING (diagnostic header logging still runs upstream);
     • getResendQuotaUsage reports providerAvailable:false (code "provider-usage-unverified");
     • no provider percentage bars, no provider-derived alerts, no provider-derived suppression.
   Internal safety enforcement (emailQuota) and real 429 quota-exceeded exhaustion markers
   are UNAFFECTED. Flipping this to true is a REVIEWED CODE CHANGE that must ship together
   with the proven accounting model — never an env toggle that silently re-enables Model A. */
const HEADER_SEMANTICS_PROVEN = false;
// An observation older than this is flagged stale in the UI (it only advances on sends).
const STALE_MS = posInt(process.env.RESEND_USAGE_STALE_MS, 12 * 60 * 60 * 1000);
const THRESHOLDS = [70, 85, 95, 100];

// A quota header/value → finite non-negative integer, else null (never 0 on bad input).
function parseQuotaHeader(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// ---- server-only cache store (Firestore) ----------------------------------
function firestoreStore() {
  const { db, FieldValue } = require("./lib"); // lazy → module loads without firebase-admin (unit tests)
  const ref = db.doc(CACHE_DOC);
  return {
    read: async () => { const s = await ref.get(); return s.exists ? s.data() : null; },
    write: async (snap) => { await ref.set({ ...snap, updatedAt: FieldValue.serverTimestamp() }, { merge: true }); },
  };
}

const isNonNegInt = (n) => Number.isInteger(n) && n >= 0;

/* STRICT validation of a provider observation BEFORE it is trusted. The
   x-resend-*-quota header semantics proved unreliable in production (a value of 3000 —
   the plan capacity — was returned and mis-treated as pre-send used, yielding 3001), so
   no observation is persisted/displayed unless it satisfies hard invariants:
     • pre-send used is a finite non-negative integer;
     • post-send (used + acceptedUnits) must NOT exceed the plan limit — an accepted
       send always had room, so used+units ≤ limit; a header == capacity is therefore
       never a valid pre-send used count for an accepted send;
     • monthly and daily are validated INDEPENDENTLY.
   Returns { valid, units, code?, reason? }. */
function validateObservation({ monthlyUsedBeforeSend, dailyUsedBeforeSend, acceptedUnits }) {
  const units = Number.isInteger(acceptedUnits) && acceptedUnits > 0 ? acceptedUnits : 1;
  if (!isNonNegInt(monthlyUsedBeforeSend)) return { valid: false, code: "invalid-provider-observation", reason: "monthly-not-integer" };
  if (monthlyUsedBeforeSend + units > PLAN_MONTHLY_LIMIT) return { valid: false, code: "invalid-provider-observation", reason: "monthly-exceeds-plan" };
  if (dailyUsedBeforeSend != null) {
    if (!isNonNegInt(dailyUsedBeforeSend)) return { valid: false, code: "invalid-provider-observation", reason: "daily-not-integer" };
    if (dailyUsedBeforeSend + units > PLAN_DAILY_LIMIT) return { valid: false, code: "invalid-provider-observation", reason: "daily-exceeds-plan" };
  }
  return { valid: true, units };
}

// Is a CACHED snapshot's provider usage structurally valid (used within plan limits)?
// Used at read time so an already-poisoned cache (e.g. 3001/3000) is shown as
// unavailable rather than rendered as a real observation.
function cachedUsageValid(snap) {
  if (!snap || typeof snap.monthlyUsed !== "number") return false;
  const mLimit = posInt(snap.monthlyLimit, PLAN_MONTHLY_LIMIT);
  if (!isNonNegInt(snap.monthlyUsed) || snap.monthlyUsed > mLimit) return false;
  return true;
}

// App-initiated send telemetry (this app only) — returned SEPARATELY, never mixed into
// the provider fields. Best-effort; null when unavailable.
async function defaultTelemetry() {
  try {
    const quota = require("./emailQuota");
    const s = await quota.snapshot();
    return { appInitiatedThisMonth: s.month.sentCount || 0, appSafetyCap: s.month.monthlyLimit || quota.MONTHLY_LIMIT };
  } catch { return { appInitiatedThisMonth: null, appSafetyCap: null }; }
}

// Threshold alerts from observed usage, deduped per CALENDAR month period key (the
// notifyUsers doc id embeds it → idempotent). Never fired from a fallback.
async function fireAlerts(thresholds, periodMonth, usedPct) {
  const quota = require("./emailQuota"); // lazy → avoid cycle
  await quota.alertAdmins({
    monthlyThresholds: thresholds, daily: false,
    period: { month: `resend-${periodMonth}`, day: new Date().toISOString().slice(0, 10) },
    usedPct,
  });
}

// Explicit UTC period keys — a reset is allowed ONLY across a period boundary, never
// from a small out-of-order decrease within the same period.
function periodKeysFor(nowMs) {
  const iso = new Date(nowMs).toISOString();
  return { month: iso.slice(0, 7), day: iso.slice(0, 10) };
}

const pct1 = (used, limit) => (limit > 0 ? Math.round((used / limit) * 1000) / 10 : null);

// Public result shape. Provider fields and internal telemetry are strictly separated;
// unavailable NEVER fills provider fields with internal numbers. `dailyReason`
// distinguishes WHY daily is null: "not-provided" (plan doesn't report it),
// "not-observed-today" (no send yet today), or null (a daily block is present).
function result({ providerAvailable, source, monthly, daily, dailyReason, lastSyncedAt, stale, providerErrorCode, telemetry }) {
  return {
    providerAvailable,
    source,                                                    // resend | internal-fallback
    monthly, daily, dailyReason: dailyReason || null,          // null when unavailable
    lastSyncedAt: lastSyncedAt || null,                        // last SEND that reported usage
    observedVia: providerAvailable ? "send" : null,            // usage advances on send, not refresh
    stale: !!stale,
    internalTelemetry: telemetry || { appInitiatedThisMonth: null },
    providerError: providerErrorCode ? { code: providerErrorCode } : null,
  };
}

/* PURE merge: fold a new observation into the previous cached snapshot, MONOTONICALLY
   POST /emails quota headers report account usage BEFORE this accepted request is
   counted, so the POST-SEND total is header + acceptedUnits. This fold is:
     • concurrency-safe: postSend = max(providerFloor, localFloor) where
       providerFloor = usedBeforeSend + units and localFloor = prevCachedUsage + units,
       so two concurrent sends both seeing header=42 end at 44 (Firestore retries the
       tx; the loser's localFloor wins).
     • idempotent: on a REPLAY (usageApplied already true) units=0, so it only
       reconciles max(prevCached, header) — never double-counts.
     • period-aware + monotonic: a reset is allowed only across a period boundary; an
       out-of-order response never regresses the total.
   Applied separately to monthly and daily within their period keys. Returns
   { snap, toFire, pct }. */
function applyObservation(prev, { monthlyUsedBeforeSend, dailyUsedBeforeSend, acceptedUnits }, alreadyApplied, nowMs) {
  const { month, day } = periodKeysFor(nowMs);
  const p = prev || {};
  const sameMonth = p.periodMonth === month;
  const sameDay = p.periodDay === day;
  const units = alreadyApplied ? 0 : acceptedUnits;
  // Self-heal: if the cached floor is itself IMPOSSIBLE (> plan capacity — a poisoned
  // value from before validation existed), ignore it so a fresh VALID observation resets
  // the total instead of the poison latching forever through this monotonic floor.
  const prevMonthlyRaw = sameMonth ? (Number(p.monthlyUsed) || 0) : 0;
  const prevDailyRaw = sameDay ? (Number(p.dailyUsed) || 0) : 0;
  const prevMonthly = prevMonthlyRaw > PLAN_MONTHLY_LIMIT ? 0 : prevMonthlyRaw;
  const prevDaily = prevDailyRaw > PLAN_DAILY_LIMIT ? 0 : prevDailyRaw;

  const monthlyUsed = Math.max(monthlyUsedBeforeSend + units, prevMonthly + units);
  let dailyUsed = null;
  if (dailyUsedBeforeSend != null) dailyUsed = Math.max(dailyUsedBeforeSend + units, prevDaily + units);
  else if (sameDay && p.dailyUsed != null) dailyUsed = p.dailyUsed;   // paid plan mid-day → keep prior, don't regress

  const limit = PLAN_MONTHLY_LIMIT;
  const pct = limit > 0 ? Math.round((monthlyUsed / limit) * 100) : 0;
  const prevAlerted = sameMonth ? (p.alertedThresholds || []) : [];
  const toFire = THRESHOLDS.filter((t) => !prevAlerted.includes(t) && pct >= t);

  const snap = {
    provider: "resend", monthlyUsed, dailyUsed: dailyUsed != null ? dailyUsed : null,
    monthlyLimit: limit, dailyLimit: PLAN_DAILY_LIMIT,
    observedAt: new Date(nowMs).toISOString(), observedVia: "send",
    periodMonth: month, periodDay: day,
    alertedThresholds: [...prevAlerted, ...toFire].sort((a, b) => a - b),
  };
  return { snap, toFire, pct };
}

// The SANITIZED, admin-readable projection of an observation for the real-time panel.
// Contains ONLY presentation fields — never keys, auth, recipients, message content,
// provider bodies, alert state, reservation state, or debug data.
function sanitizePublic(snap) {
  const mLimit = posInt(snap.monthlyLimit, PLAN_MONTHLY_LIMIT);
  const dHasHeader = snap.dailyUsed != null;
  const dLimit = snap.dailyLimit != null ? snap.dailyLimit : PLAN_DAILY_LIMIT;
  return {
    monthly: { used: snap.monthlyUsed, limit: mLimit, percent: pct1(snap.monthlyUsed, mLimit) },
    daily: dHasHeader ? { used: snap.dailyUsed, limit: dLimit, percent: pct1(snap.dailyUsed, dLimit) } : null,
    dailyReason: dHasHeader ? null : "not-provided",   // write-time reason; the client overlays period reasons
    periodMonth: snap.periodMonth, periodDay: snap.periodDay,
    observedAt: snap.observedAt, observedVia: snap.observedVia || "send", source: "resend",
  };
}

// Default Firestore transaction runner. Reads the cache + the delivery RECEIPT
// (emailDeliveries/{deliveryId}), then writes the internal cache, the sanitized public
// doc, and the receipt (usageApplied) ATOMICALLY — so the account total, the panel, and
// the "already counted" flag can never disagree, and a retry can't double-count.
function firestoreTx(deliveryId) {
  const { db, FieldValue } = require("./lib"); // lazy → avoid firebase-admin in unit tests
  const ref = db.doc(CACHE_DOC);
  const pubRef = db.doc(PUBLIC_DOC);
  const delRef = deliveryId ? db.doc(`emailDeliveries/${deliveryId}`) : null;
  return (fn) => db.runTransaction(async (t) => {
    const cacheSnap = await t.get(ref);                       // reads BEFORE writes
    const delSnap = delRef ? await t.get(delRef) : null;
    return fn({
      prev: cacheSnap.exists ? cacheSnap.data() : null,
      delivery: delSnap && delSnap.exists ? delSnap.data() : null,
      write: (data) => t.set(ref, { ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
      writePublic: (data) => t.set(pubRef, data, { merge: true }), // merge → preserves internalTelemetry
      writeReceipt: (units) => { if (delRef) t.set(delRef, { usageApplied: true, usageAppliedUnits: units, usageAppliedAt: FieldValue.serverTimestamp() }, { merge: true }); },
    });
  });
}

/* Record the POST-SEND account usage from a SUCCESSFUL POST /emails. The response
   quota headers are PRE-SEND values (this accepted request isn't counted yet), so the
   post-send total is header + acceptedUnits — applied concurrency- and retry-safely via
   applyObservation + the delivery RECEIPT (usageApplied), all in ONE transaction that
   also publishes the sanitized public doc. A missing/invalid monthly-before value is
   ignored (never a false observation). `observed`:
     { monthlyUsedBeforeSend, dailyUsedBeforeSend?, acceptedUnits, deliveryId }
   Alerts fire once, AFTER commit. Options injectable for tests. */
async function recordObservedUsage(observed, { now = Date.now, alerter = fireAlerts, runTransaction, provenSemantics = HEADER_SEMANTICS_PROVEN } = {}) {
  const o = observed || {};
  // CONTAINMENT gate: until header semantics are proven, NEVER persist a provider header
  // as usage — no cache write, no public write, no receipt, no alerts. The sanitized
  // diagnostic header log (emailService.js) still runs so the model can be proven. This is
  // the interim safe behavior; it takes precedence over the strict-validation path below.
  // (`provenSemantics` defaults to the module flag; tests inject true to exercise the
  // accounting math that ships when the flag is flipped.)
  if (!provenSemantics) {
    logger.info("resend usage: provider header observed but NOT persisted (semantics unproven)", {
      hasMonthly: o.monthlyUsedBeforeSend != null, hasDaily: o.dailyUsedBeforeSend != null, units: o.acceptedUnits,
    });
    return { skipped: true, reason: "header-semantics-unproven" };
  }
  // STRICT gate: a structurally invalid observation (e.g. a header == plan capacity that
  // would produce used > limit) is REJECTED — never persisted, never published, never
  // marks a period or fires alerts, and never overwrites the last known-good value.
  const v = validateObservation(o);
  if (!v.valid) {
    logger.warn("resend usage: REJECTED invalid provider observation (not persisted)", {
      code: v.code, reason: v.reason, monthlyBefore: o.monthlyUsedBeforeSend, dailyBefore: o.dailyUsedBeforeSend, units: o.acceptedUnits,
    });
    return { invalid: true, code: v.code, reason: v.reason };
  }
  const before = o.monthlyUsedBeforeSend;
  const dBefore = isNonNegInt(o.dailyUsedBeforeSend) ? o.dailyUsedBeforeSend : null;
  const units = v.units;
  const nowMs = now();
  const run = runTransaction || firestoreTx(observed && observed.deliveryId);
  const committed = await run(({ prev, delivery, write, writePublic, writeReceipt }) => {
    const alreadyApplied = !!(delivery && delivery.usageApplied);
    const { snap, toFire, pct } = applyObservation(prev, { monthlyUsedBeforeSend: before, dailyUsedBeforeSend: dBefore, acceptedUnits: units }, alreadyApplied, nowMs);
    write(snap);
    if (writePublic) writePublic(sanitizePublic(snap));
    if (!alreadyApplied && writeReceipt) writeReceipt(units);   // usage-application receipt (idempotent)
    return { snap, toFire, pct, periodMonth: snap.periodMonth };
  });
  if (committed && committed.toFire.length) {
    try { await alerter(committed.toFire, committed.periodMonth, committed.pct); }
    catch (e) { logger.warn("resend usage: threshold alert failed", { error: String(e && e.message).slice(0, 150) }); }
  }
  return committed ? committed.snap : null;
}

/* Read the last observed usage for the diagnostics panel — PERIOD-AWARE. NO live fetch
   (Resend only reports quota on SEND). A cached observation is only shown as CURRENT
   usage when its period keys match the current UTC period:
     • cached month ≠ current month → monthly:null, code "not-observed-this-month"
       (the old value stays available via lastSyncedAt for Technical details).
     • cached month = current but day ≠ today → keep monthly; daily:null with
       dailyReason "not-observed-today" (never show yesterday's count under "Today").
     • same day, but the plan sends no daily header → daily:null, "not-provided".
   Never throws. */
async function getResendQuotaUsage({ store, now = Date.now, telemetry, provenSemantics = HEADER_SEMANTICS_PROVEN } = {}) {
  const st = store || firestoreStore();
  const nowMs = now();
  const tele = telemetry || await defaultTelemetry();
  let cached = null;
  try { cached = await st.read(); } catch (e) { cached = null; }
  const cur = periodKeysFor(nowMs);

  // CONTAINMENT: header semantics unproven → provider usage is Unavailable regardless of
  // any (possibly stale/pre-fix) cached value. Internal telemetry is still returned so the
  // app-safety row keeps working; "View in Resend" stays available in the UI.
  if (!provenSemantics) {
    return result({ providerAvailable: false, source: "internal-fallback", monthly: null, daily: null,
      dailyReason: null, lastSyncedAt: (cached && cached.observedAt) || null, stale: true,
      providerErrorCode: "provider-usage-unverified", telemetry: tele });
  }

  if (!cached || typeof cached.monthlyUsed !== "number") {
    return result({ providerAvailable: false, source: "internal-fallback", monthly: null, daily: null,
      dailyReason: null, lastSyncedAt: null, stale: true, providerErrorCode: "not-observed", telemetry: tele });
  }

  // A structurally INVALID cached value (e.g. a poisoned 3001/3000) is never displayed
  // as a real observation — surface an unavailable state instead. Internal telemetry
  // (app safety usage) is still returned.
  if (!cachedUsageValid(cached)) {
    return result({ providerAvailable: false, source: "internal-fallback", monthly: null, daily: null,
      dailyReason: null, lastSyncedAt: cached.observedAt || null, stale: true, providerErrorCode: "invalid-provider-observation", telemetry: tele });
  }

  const observedAt = cached.observedAt || null;
  const ageStale = observedAt ? !((nowMs - Date.parse(observedAt)) < STALE_MS) : true;

  // A prior-month observation is NOT current monthly usage. A LEGACY cache with no
  // periodMonth (undefined !== current month) is treated the same → unavailable this
  // month; a new send rewrites it with the current schema and restores the display.
  if (cached.periodMonth !== cur.month) {
    return result({ providerAvailable: false, source: "resend", monthly: null, daily: null,
      dailyReason: null, lastSyncedAt: observedAt, stale: true, providerErrorCode: "not-observed-this-month", telemetry: tele });
  }

  const mLimit = posInt(cached.monthlyLimit, PLAN_MONTHLY_LIMIT);
  const monthly = { used: cached.monthlyUsed, limit: mLimit, percent: pct1(cached.monthlyUsed, mLimit) };

  let daily = null, dailyReason = null;
  if (cached.periodDay !== cur.day) {                 // includes null/undefined (legacy)
    dailyReason = "not-observed-today";               // a new day (or legacy), no send yet → don't show yesterday
  } else if (cached.dailyUsed == null) {
    dailyReason = "not-provided";                     // plan doesn't report a daily quota
  } else {
    const dLimit = cached.dailyLimit != null ? cached.dailyLimit : PLAN_DAILY_LIMIT;
    if (!isNonNegInt(cached.dailyUsed) || cached.dailyUsed > dLimit) dailyReason = "invalid"; // structurally invalid → don't show
    else daily = { used: cached.dailyUsed, limit: dLimit, percent: pct1(cached.dailyUsed, dLimit) };
  }

  return result({ providerAvailable: true, source: "resend", monthly, daily, dailyReason,
    lastSyncedAt: observedAt, stale: ageStale, providerErrorCode: null, telemetry: tele });
}

module.exports = {
  getResendQuotaUsage, recordObservedUsage, applyObservation, periodKeysFor, sanitizePublic,
  validateObservation, cachedUsageValid, parseQuotaHeader, pct1,
  PLAN_MONTHLY_LIMIT, PLAN_DAILY_LIMIT, CACHE_DOC, PUBLIC_DOC, THRESHOLDS, HEADER_SEMANTICS_PROVEN,
};
