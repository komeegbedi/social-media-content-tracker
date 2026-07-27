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
const { db, FieldValue, loadUsers, writeNotification } = require("./lib");

const MONTHLY_LIMIT = Number(process.env.RESEND_MONTHLY_EMAIL_LIMIT) || 2800;
const DAILY_LIMIT = Number(process.env.RESEND_DAILY_SAFETY_LIMIT) || 250;

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

    // Gating (most restrictive first).
    let deny = null;
    if (mUsed >= mLimit) deny = "monthly_limit";
    else if (dUsed >= dLimit) deny = "daily_limit";
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
    return { settled: true };
  });
}

/* Post-reservation admin alerts (IN-APP only — never rely on email to warn
   about email). Idempotent: one per threshold per period. */
async function alertAdmins({ monthlyThresholds = [], daily = false, period, usedPct }) {
  if (!monthlyThresholds.length && !daily) return;
  const { list } = await loadUsers();
  const admins = list.filter((u) => u.role === "admin");
  const jobs = [];
  for (const t of monthlyThresholds) {
    const body = t >= 100
      ? "External email delivery is paused for the rest of this month (internal limit reached). In-app notifications continue."
      : `Email usage has reached ${t}% of the monthly limit.`;
    admins.forEach((a) => jobs.push(writeNotification({
      id: `emailquota_${t}_${period.month}_${a.uid}`, uid: a.uid, type: "leadership",
      title: t >= 100 ? "Email delivery paused (monthly limit)" : `Email usage at ${t}%`, body })));
  }
  if (daily) admins.forEach((a) => jobs.push(writeNotification({
    id: `emaildaily_${period.day}_${a.uid}`, uid: a.uid, type: "leadership",
    title: "Daily email safety limit reached", body: "Email sends are paused for today; in-app notifications continue." })));
  await Promise.all(jobs);
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
  MONTHLY_LIMIT, DAILY_LIMIT, priorityOf, periods,
  reserve, settleReservation, alertAdmins, reconcile, snapshot,
};
