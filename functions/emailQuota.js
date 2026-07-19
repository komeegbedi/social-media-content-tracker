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

/* Atomically reserve one email against the monthly + daily budgets, applying
   priority gating. Returns { allowed, reason?, usedPct, newThresholds[], dailyAlert }. */
async function reserve({ type, priority, period }) {
  const pr = priorityOf(type, priority);
  const mRef = monthRef(period.month), dRef = dayRef(period.day);
  return db.runTransaction(async (tx) => {
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
      return { allowed: false, reason: deny, usedPct };
    }

    // Reserve.
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

    return { allowed: true, usedPct: Math.round((newUsedM / mLimit) * 100), newThresholds, dailyAlert };
  });
}

// reserved -1, sent +1 (email accepted by Resend).
function commitSent(period) { return adjust(period, { rM: -1, sM: +1, rD: -1, sD: +1 }); }
// reserved -1, failed +1 (permanent Resend failure).
function commitFailed(period) { return adjust(period, { rM: -1, fM: +1, rD: -1 }); }
// reserved -1 (temporary failure — not sent; will retry, no send/fail counted).
function release(period) { return adjust(period, { rM: -1, rD: -1 }); }

async function adjust(period, { rM = 0, sM = 0, fM = 0, rD = 0, sD = 0 }) {
  const mRef = monthRef(period.month), dRef = dayRef(period.day);
  await db.runTransaction(async (tx) => {
    const [mS, dS] = await Promise.all([tx.get(mRef), tx.get(dRef)]);
    const m = mS.exists ? mS.data() : monthDefaults(period.month);
    const d = dS.exists ? dS.data() : dayDefaults(period.day);
    tx.set(mRef, { reservedCount: Math.max(0, (m.reservedCount || 0) + rM),
      sentCount: (m.sentCount || 0) + sM, failedCount: (m.failedCount || 0) + fM,
      lastUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(dRef, { reservedCount: Math.max(0, (d.reservedCount || 0) + rD),
      sentCount: (d.sentCount || 0) + sD, lastUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
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

/* Reconcile deliveries whose outcome is unknown (function crashed/timed out
   after reserving): release the stuck reservation and mark them failed, so
   reservations don't leak. Idempotency keys mean we never resend. */
async function reconcile(graceMs = 60 * 60 * 1000) {
  const cutoff = Date.now() - graceMs;
  const stuck = await db.collection("emailDeliveries").where("status", "==", "unknown").limit(50).get();
  let released = 0;
  for (const doc of stuck.docs) {
    const x = doc.data();
    const ra = x.reservedAt && x.reservedAt.toMillis ? x.reservedAt.toMillis() : 0;
    if (ra && ra > cutoff) continue; // still within grace
    if (x.usagePeriod && x.usageDay) await release({ month: x.usagePeriod, day: x.usageDay });
    await doc.ref.update({ status: "failed", errorCode: "reconciled", errorMessage: "released after uncertain outcome" });
    released++;
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
  reserve, commitSent, commitFailed, release, alertAdmins, reconcile, snapshot,
};
