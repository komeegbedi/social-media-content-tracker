/* ===================================================================
   Email quota safeguards (Resend).

   The Resend plan allows 3,000 emails/month. We cap OURSELVES lower
   (2,800) so manual tests, dashboard sends, retries and usage drift
   can't push the account over. A daily safety limit (250) stops a bug
   from burning the month in a day.

   Usage is tracked in server-only Firestore docs and mutated inside
   transactions, so many concurrent function instances can't oversend:
     systemUsage/email-{YYYY-MM}      (monthly, UTC calendar month)
     systemUsage/emailDaily-{YYYY-MM-DD} (daily, UTC date)

   Reservation model:  reserve() → send via Resend → commitSent()
   (or release()/commitFailed()/leave "unknown" for reconcile).

   NOTE: emails sent OUTSIDE the app (e.g. straight from the Resend
   dashboard) are not seen here — that's why the internal cap sits below
   the true 3,000 allowance. This counter is the app's own estimate.
   =================================================================== */
const { db, FieldValue, loadUsers, notifyUsers } = require("./lib");
const { logger } = require("firebase-functions/v2");

const posInt = (v, dflt) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : dflt; };

// The provider's ACTUAL plan limits (account-level, incl. out-of-band usage) — used for
// the account-aware deny below, kept SEPARATE from the app's safety caps. Defaults match
// this Free account (3,000/mo, 100/day); override via env.
const RESEND_PLAN_MONTHLY_LIMIT = posInt(process.env.RESEND_MONTHLY_LIMIT, 3000);
const RESEND_PLAN_DAILY_LIMIT = posInt(process.env.RESEND_DAILY_LIMIT, 100);

// The app's CONSERVATIVE sending safety caps (local, atomic) — deliberately below the
// provider plan so app-initiated sends alone can't exhaust the account. The DAILY cap
// defaults to 90 (ten below the 100/day Free plan, leaving headroom for out-of-band
// activity). GUARD: the safety cap can never exceed the plan limit — if misconfigured
// higher, it's clamped to the plan limit and a warning is logged at startup.
const MONTHLY_LIMIT = Math.min(posInt(process.env.RESEND_MONTHLY_EMAIL_LIMIT, 2800), RESEND_PLAN_MONTHLY_LIMIT);
const RAW_DAILY_SAFETY = posInt(process.env.RESEND_DAILY_SAFETY_LIMIT, 90);
const DAILY_LIMIT = Math.min(RAW_DAILY_SAFETY, RESEND_PLAN_DAILY_LIMIT);
if (RAW_DAILY_SAFETY > RESEND_PLAN_DAILY_LIMIT)
  logger.warn("RESEND_DAILY_SAFETY_LIMIT exceeds the plan daily limit — clamping to the plan limit",
    { requested: RAW_DAILY_SAFETY, planDaily: RESEND_PLAN_DAILY_LIMIT, applied: DAILY_LIMIT });

const RESEND_QUOTA_DOC = "systemUsage/resendQuota";        // written by resendUsage.js
const DIAGNOSTICS_DOC = "adminDiagnostics/emailUsage";     // sanitized real-time panel doc
const RESEND_GATE_MAX_AGE_MS = posInt(process.env.RESEND_GATE_MAX_AGE_MS, 15 * 60 * 1000);

// AUTHORITATIVE server-side switch for provider-PERIOD-based enforcement (denying a
// reservation because the provider's own daily/monthly quota window is believed exhausted).
// It is FALSE, and hard-coded off — NOT env-overridable — because Resend's reset boundaries
// are unproven (QUOTA_HEADER_MODEL_PROVEN=true, but MONTHLY_PERIOD_PROVEN=DAILY_PERIOD_PROVEN
// =false). While this is false, reserve() must never deny on a provider period marker: the
// app's own caps (2,800/UTC-month, 90/UTC-day) and priority gates are the only enforcement.
// See docs/incident-resend-usage.md (Option A). Do NOT flip this to re-use the legacy
// dailyExhaustedDay/monthlyExhaustedMonth fields — those are an INCOMPATIBLE legacy schema
// keyed on an UNVERIFIED UTC boundary; any future enforcement must use NEW versioned
// provider-period fields (or an explicit, reviewed migration), not these.
const PROVIDER_PERIOD_BASED_ENFORCEMENT_ENABLED = false;

// The latest Resend account state, read OUTSIDE the reservation transaction (eventually
// consistent; avoids contention with the usage writer). Returns the monthly-used (when
// recent) and whether the current UTC MONTH/DAY are marked exhausted by a provider
// quota_exceeded. The exhaustion MARKERS are NOT gated by snapshot age — a monthly
// marker suppresses for the remainder of that month regardless of observation freshness;
// a marker from a previous period never blocks. Null/absent → local safety cap governs.
async function readResendGate(period) {
  // CONTAINMENT: while header semantics are unproven, provider header-derived usage must
  // NOT drive send suppression at all (a value in [0, plan] is not proven to be "used").
  // The local safety cap alone governs projected volume. Provider PERIOD exhaustion markers
  // are ALSO ignored here (their reset boundary is unproven) — see the return block below.
  const { HEADER_SEMANTICS_PROVEN } = require("./resendUsage");
  try {
    const s = await db.doc(RESEND_QUOTA_DOC).get();
    if (!s.exists) return { monthlyUsed: null, monthlyExhausted: false, dailyExhausted: false };
    const x = s.data();
    const fresh = x.observedAt && (Date.now() - Date.parse(x.observedAt)) < RESEND_GATE_MAX_AGE_MS;
    const headerUsable = HEADER_SEMANTICS_PROVEN && fresh
      && Number.isInteger(x.monthlyUsed) && x.monthlyUsed >= 0 && x.monthlyUsed <= RESEND_PLAN_MONTHLY_LIMIT;
    return {
      // Unproven semantics OR a structurally invalid value (poisoned 3001) → ignore it and
      // fall back to the local cap; never let the provider header block email.
      monthlyUsed: headerUsable ? x.monthlyUsed : null,
      // PROVIDER-PERIOD ENFORCEMENT IS DISABLED (unproven reset boundaries): the legacy
      // exhaustion markers (x.monthlyExhaustedMonth / x.dailyExhaustedDay) are READ but
      // deliberately IGNORED — both flags resolve to false while the switch is off, so
      // reserve() can never deny on them. The fields are left untouched in Firestore (a
      // passive, non-destructive read); they are an incompatible legacy schema and are NOT
      // to be revived by flipping the switch. This is the single authoritative choke point.
      monthlyExhausted: PROVIDER_PERIOD_BASED_ENFORCEMENT_ENABLED
        && !!(period && period.month) && x.monthlyExhaustedMonth === period.month,
      dailyExhausted: PROVIDER_PERIOD_BASED_ENFORCEMENT_ENABLED
        && !!(period && period.day) && x.dailyExhaustedDay === period.day,
    };
  } catch { return { monthlyUsed: null, monthlyExhausted: false, dailyExhausted: false }; }
}

// NOTE: the former markDailyExhausted / markMonthlyExhausted writers were REMOVED (Option A).
// On a real quota 429 the current delivery is settled suppressed_quota_limit and an alert is
// raised, but NO provider period exhaustion marker is written — provider-period enforcement is
// disabled (unproven reset boundaries; PROVIDER_PERIOD_BASED_ENFORCEMENT_ENABLED=false). Any
// pre-existing dailyExhaustedDay/monthlyExhaustedMonth fields are ignored by readResendGate and
// left untouched. See docs/incident-resend-usage.md (Option A).

// Priority by notification type (callers may override, e.g. new-signup alerts).
const PRIORITY = {
  assigned: "critical", qa: "critical", changes: "critical", account_approved: "critical",
  approved: "standard", ready: "standard", reminder: "standard",
  overdue: "low", mention: "low", event: "low", leadership: "standard",
};
const priorityOf = (type, override) => override || PRIORITY[type] || "standard";

// Percentage thresholds that trigger a one-time admin alert.
const THRESHOLDS = [70, 85, 95, 100];

// UTC period keys — one canonical definition used everywhere.
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);      // YYYY-MM
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);       // YYYY-MM-DD
function periods() { const d = new Date(); return { month: monthKey(d), day: dayKey(d) }; }
const monthRef = (p) => db.doc(`systemUsage/email-${p}`);
const dayRef = (p) => db.doc(`systemUsage/emailDaily-${p}`);

const monthDefaults = (period) => ({ provider: "resend", period, monthlyLimit: MONTHLY_LIMIT,
  reservedCount: 0, sentCount: 0, failedCount: 0, suppressedCount: 0, alertedThresholds: [] });
const dayDefaults = (period) => ({ provider: "resend", period, dailyLimit: DAILY_LIMIT,
  reservedCount: 0, sentCount: 0, suppressedCount: 0, alertedDaily: false });

/* Atomically reserve ONE email against the monthly + daily budgets, applying
   priority gating — and, in the SAME transaction, stamp the delivery doc as
   `reserved` so a reservation and its record can never disagree (no leak on a
   crash between the two). Idempotent per delivery: if the doc is already
   reserved (a prior attempt), no second reservation is taken.
   Returns { allowed, reason?, usedPct, newThresholds[], dailyAlert }. */
async function reserve({ type, priority, period, deliveryRef }) {
  const pr = priorityOf(type, priority);
  const mRef = monthRef(period.month), dRef = dayRef(period.day);
  // Authoritative account usage (Resend), read before the tx. Combined with local
  // in-flight reservations below to stop a send that would push the ACCOUNT over its
  // plan limit — even from out-of-band usage the local counters can't see.
  const gate = await readResendGate(period);
  const accountUsed = gate.monthlyUsed;
  return db.runTransaction(async (tx) => {
    // Reads first. A reservation already held for this delivery → reuse it.
    const dvSnap = deliveryRef ? await tx.get(deliveryRef) : null;
    if (dvSnap && dvSnap.exists && dvSnap.data().reserved) return { allowed: true, already: true };

    const [mSnap, dSnap] = await Promise.all([tx.get(mRef), tx.get(dRef)]);
    const m = mSnap.exists ? mSnap.data() : monthDefaults(period.month);
    const d = dSnap.exists ? dSnap.data() : dayDefaults(period.day);
    const mLimit = m.monthlyLimit || MONTHLY_LIMIT;
    const dLimit = d.dailyLimit || DAILY_LIMIT;
    const mUsed = (m.sentCount || 0) + (m.reservedCount || 0);
    const dUsed = (d.sentCount || 0) + (d.reservedCount || 0);
    const usedPct = Math.round((mUsed / mLimit) * 100);

    // Gating (most restrictive first). The account-aware check uses Resend usage +
    // this-app's in-flight reservations (not yet reflected by Resend) vs the plan limit;
    // it only applies when a recent snapshot exists (else the safety cap alone governs).
    const accountProjected = accountUsed != null ? accountUsed + (m.reservedCount || 0) + 1 : null;
    let deny = null;
    // gate.monthlyExhausted / gate.dailyExhausted are forced false by readResendGate while
    // PROVIDER_PERIOD_BASED_ENFORCEMENT_ENABLED is off, so these two provider-period branches
    // are INERT (never fire). They are retained only as the wiring a future, reviewed
    // provider-period design would re-enable through that single switch — see readResendGate.
    if (gate.monthlyExhausted) deny = "resend_monthly_exhausted";      // inert (provider-period enforcement disabled)
    else if (mUsed >= mLimit) deny = "monthly_limit";                  // APP-owned monthly safety cap (2,800/UTC month)
    else if (accountProjected != null && accountProjected > RESEND_PLAN_MONTHLY_LIMIT) deny = "resend_account_limit"; // inert: accountUsed is null while header semantics unproven
    else if (gate.dailyExhausted) deny = "resend_daily_exhausted";     // inert (provider-period enforcement disabled)
    else if (dUsed >= dLimit) deny = "daily_limit";                    // APP-owned daily safety cap (90/UTC day)
    else if (usedPct >= 95 && pr !== "critical") deny = "quota_95_noncritical";
    else if (usedPct >= 85 && pr === "low") deny = "quota_85_low";

    if (deny) {
      tx.set(mRef, { ...m, suppressedCount: (m.suppressedCount || 0) + 1, lastUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(dRef, { ...d, suppressedCount: (d.suppressedCount || 0) + 1, lastUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
      // Suppressed is terminal — never reserved, so it's already settled.
      if (deliveryRef) tx.update(deliveryRef, { status: "suppressed_quota_limit", suppressReason: deny, reserved: false, settled: true, failedAt: FieldValue.serverTimestamp() });
      return { allowed: false, reason: deny, usedPct };
    }

    // Reserve, and flag the delivery doc atomically.
    const newReservedM = (m.reservedCount || 0) + 1;
    const newUsedM = (m.sentCount || 0) + newReservedM;
    const alerted = m.alertedThresholds || [];
    const newThresholds = THRESHOLDS.filter((t) => !alerted.includes(t) && newUsedM >= Math.round((t / 100) * mLimit));
    tx.set(mRef, { ...m, reservedCount: newReservedM,
      alertedThresholds: [...alerted, ...newThresholds], lastUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });

    const newReservedD = (d.reservedCount || 0) + 1;
    const dailyAlert = !d.alertedDaily && (newReservedD + (d.sentCount || 0)) >= dLimit;
    tx.set(dRef, { ...d, reservedCount: newReservedD,
      alertedDaily: d.alertedDaily || dailyAlert, lastUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });

    if (deliveryRef) tx.update(deliveryRef, { reserved: true, settled: false,
      usagePeriod: period.month, usageDay: period.day, reservedAt: FieldValue.serverTimestamp() });

    return { allowed: true, usedPct: Math.round((newUsedM / mLimit) * 100), newThresholds, dailyAlert };
  });
}

/* Settle a delivery's SINGLE reservation EXACTLY ONCE, atomically with the
   delivery-doc flag flip, so a reservation can never leak or be double-released.
   kind: "sent" | "failed" | "release". `extra` patches the delivery doc. A no-op
   (but still records `extra`) when the delivery was never reserved or is already
   settled — this is what makes double-release impossible. */
async function settleReservation(deliveryRef, kind, period, extra = {}) {
  const mRef = monthRef(period.month), dRef = dayRef(period.day);
  return db.runTransaction(async (tx) => {
    const dvSnap = await tx.get(deliveryRef);
    if (!dvSnap.exists) return { settled: false };
    const dv = dvSnap.data();
    if (!dv.reserved || dv.settled) {
      if (Object.keys(extra).length) tx.update(deliveryRef, extra);
      return { settled: false };
    }
    const [mS, dS] = await Promise.all([tx.get(mRef), tx.get(dRef)]);
    const m = mS.exists ? mS.data() : monthDefaults(period.month);
    const day = dS.exists ? dS.data() : dayDefaults(period.day);
    const adj = kind === "sent" ? { rM: -1, sM: +1, rD: -1, sD: +1 }
      : kind === "failed" ? { rM: -1, fM: +1, rD: -1 }
        : { rM: -1, rD: -1 }; // release
    tx.set(mRef, { reservedCount: Math.max(0, (m.reservedCount || 0) + adj.rM),
      sentCount: (m.sentCount || 0) + (adj.sM || 0), failedCount: (m.failedCount || 0) + (adj.fM || 0),
      lastUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(dRef, { reservedCount: Math.max(0, (day.reservedCount || 0) + adj.rD),
      sentCount: (day.sentCount || 0) + (adj.sD || 0), lastUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.update(deliveryRef, { reserved: false, settled: true, ...extra });
    // On a SUCCESSFUL send, publish the app's internal safety usage to the real-time
    // panel doc (merge → preserves the sanitized provider fields). Concurrent settlements
    // serialize on the monthly doc, so appInitiatedThisMonth advances monotonically. No
    // recipient/delivery data is written. Failed/released sends never increment sentCount.
    if (kind === "sent") {
      // Internal telemetry: monthly is UTC-CALENDAR-MONTH scoped (NOT the Resend provider
      // period) → telemetry only, not a provider safety cap. Daily is the real enforced guard.
      const appInitiatedThisMonth = (m.sentCount || 0) + 1;
      const appDailyThisDay = (day.sentCount || 0) + 1;
      const pub = { internalTelemetry: { appInitiatedThisMonth, appSafetyCap: m.monthlyLimit || MONTHLY_LIMIT,
        appDailyThisDay, appDailyLimit: day.dailyLimit || DAILY_LIMIT } };
      // COMPATIBILITY SIGNAL (containment): while header semantics are unproven, actively
      // NEUTRALIZE any provider usage fields in the sanitized panel doc on each successful
      // send. This overwrites a poisoned value (e.g. 3001) so that even an ALREADY-LOADED
      // old frontend bundle (a tab left open across the deploy, whose listener predates the
      // providerUsageProven gate) stops rendering it. New clients read providerUsageProven.
      const { HEADER_SEMANTICS_PROVEN } = require("./resendUsage");
      if (!HEADER_SEMANTICS_PROVEN) {
        pub.monthly = null; pub.daily = null; pub.dailyReason = null;
        pub.providerUsageProven = false; pub.providerError = { code: "provider-usage-unverified" };
      }
      tx.set(db.doc(DIAGNOSTICS_DOC), pub, { merge: true });
    }
    return { settled: true };
  });
}

/* Post-reservation admin alerts about EMAIL DELIVERY HEALTH. These are a REQUIRED
   admin type (admin_delivery_health): IN-APP ONLY (never rely on email to warn about
   email), always on (NOT gated by the Leadership opt-out — a delivery outage must
   reach admins regardless of preferences), active admins only, deep-linked to the
   admin console. Routed through notifyUsers so account + capability eligibility (and
   idempotency: one per threshold per period) are enforced centrally. */
async function alertAdmins({ monthlyThresholds = [], daily = false, period, usedPct }) {
  if (!monthlyThresholds.length && !daily) return;
  const { list } = await loadUsers();
  const admins = list.filter((u) => u.role === "admin"); // notifyUsers enforces active + admin capability
  if (!admins.length) return;
  for (const t of monthlyThresholds) {
    const body = t >= 100
      ? "External email delivery is paused for the rest of this month (internal limit reached). In-app notifications continue."
      : `Email usage has reached ${t}% of the monthly limit.`;
    await notifyUsers(admins, {
      type: "admin_delivery_health", required: true, keyBase: `emailquota_${t}_${period.month}`, route: "/admin",
      title: t >= 100 ? "Email delivery paused (monthly limit)" : `Email usage at ${t}%`, body });
  }
  if (daily) await notifyUsers(admins, {
    type: "admin_delivery_health", required: true, keyBase: `emaildaily_${period.day}`, route: "/admin",
    title: "Daily email safety limit reached", body: "Email sends are paused for today; in-app notifications continue." });
}

/* Backstop for deliveries left unresolved past the grace window — a crash with no
   retry loop to finish them. The retry loops (the notification delivery sweep and
   the digest flush) normally resolve `unknown`/`pending` by re-attempting with the
   same idempotency key; reconcile only gives up on the stragglers, releasing the
   single reservation EXACTLY ONCE (guarded by the settled flag → never a
   double-release). Idempotency keys mean we never resend. */
async function reconcile(graceMs = 60 * 60 * 1000) {
  const cutoff = Date.now() - graceMs;
  const stuck = await db.collection("emailDeliveries")
    .where("status", "in", ["unknown", "pending"]).limit(50).get();
  let released = 0;
  for (const doc of stuck.docs) {
    const x = doc.data();
    if (x.settled || !x.reserved) continue;                 // already accounted for
    const ra = (x.reservedAt && x.reservedAt.toMillis) ? x.reservedAt.toMillis() : 0;
    if (ra && ra > cutoff) continue;                        // still within grace → let the retry loops try
    if (!x.usagePeriod || !x.usageDay) { await doc.ref.update({ settled: true, status: "failed" }); continue; }
    const r = await settleReservation(doc.ref, "release", { month: x.usagePeriod, day: x.usageDay },
      { status: "failed", errorCode: "reconciled", errorMessage: "released after grace (gave up)" });
    if (r.settled) released++;
  }
  return released;
}

async function snapshot() {
  const p = periods();
  const [m, d] = await Promise.all([monthRef(p.month).get(), dayRef(p.day).get()]);
  return { month: m.exists ? m.data() : monthDefaults(p.month), day: d.exists ? d.data() : dayDefaults(p.day) };
}

module.exports = {
  MONTHLY_LIMIT, DAILY_LIMIT, RESEND_PLAN_DAILY_LIMIT, priorityOf, periods,
  reserve, settleReservation, alertAdmins, reconcile, snapshot,
};
