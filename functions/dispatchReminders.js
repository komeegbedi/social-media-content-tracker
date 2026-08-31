/* Hourly reminder dispatcher.

   Drains the reminderInstances queue: claims each due row atomically (a lease,
   so two overlapping runs can't both send), resolves recipients at send time
   (honoring task changes / removed crew), writes idempotent in-app
   notifications, records the outcome, and retries transient failures. Once a
   day at the configured local hour it also emits a leadership follow-up digest.

   Push + email delivery are added in Slices 4–5; this slice delivers in-app. */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions/v2");
const {
  db, FieldValue, Timestamp, TZ,
  loadUsers, loadSettings, notifyUsers, writeNotification, prefsAllow, emailAllow, isActive,
  resolveTaskRecipients, relativeDue, localHour, localToday, humanDate, formatContentTitle,
} = require("./lib");
const { eligibleAssigneeUids, indexUsersByName } = require("./assignmentIdentity");
const { recipientEligible } = require("./notificationPolicy");
const { resendApiKey, sendDigestEmail } = require("./emailService");
const { enqueueDigestItem, flushDigests } = require("./reminderDigest");
const quota = require("./emailQuota");

const LEASE_MINUTES = 10;
const MAX_ATTEMPTS = 3;

// Atomically move an instance pending→processing (or reclaim an expired lease).
// Returns the claimed data, or null if another execution owns it.
async function claim(ref, execId, now) {
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return null;
    const d = s.data();
    const leaseExpired = d.leaseUntil && d.leaseUntil.toDate() < now;
    const claimable = d.status === "pending" || (d.status === "processing" && leaseExpired);
    if (!claimable) return null;
    const attempts = (d.attempts || 0) + 1;
    tx.update(ref, {
      status: "processing", claimedBy: execId, attempts,
      leaseUntil: Timestamp.fromDate(new Date(now.getTime() + LEASE_MINUTES * 60000)),
    });
    return { ...d, attempts };
  });
}

async function leadershipDigest(users, settings) {
  const roles = settings.leadershipAlertRoles;
  // Leadership alerts go to leads/admins AND honor the per-type opt-out. This path
  // writes the in-app doc directly (not via notifyUsers), so BOTH the account+capability
  // eligibility gate (recipientEligible drops disabled/pending/removed and non-leads)
  // and the preference are applied here explicitly to match notifyUsers.
  const leaders = users.filter((u) =>
    ((roles.includes("admin") && u.role === "admin") || (roles.includes("lead") && u.lead))
    && recipientEligible("leadership", u)
    && prefsAllow(u, "leadership"));
  if (!leaders.length) return;

  const tasks = (await db.collection("tasks").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const today = localToday();
  // Trashed tasks are inactive — they must not inflate ANY leadership count.
  const live = tasks.filter((t) => !t.deletedAt);
  const active = live.filter((t) => t.status !== "Posted");
  const counts = {
    overdue: active.filter((t) => t.postDate && t.postDate < today).length,
    blocked: active.filter((t) => t.blockedOn).length,
    noOwner: active.filter((t) => !t.owner || t.owner === "Pending").length,
    noCrew: active.filter((t) => !t.support || !t.support.length).length,
    review: live.filter((t) => t.status === "In Review").length,
    pendingUsers: users.filter((u) => u.status === "pending").length,
  };
  const bits = [];
  if (counts.overdue) bits.push(`${counts.overdue} overdue`);
  if (counts.blocked) bits.push(`${counts.blocked} blocked`);
  if (counts.noOwner) bits.push(`${counts.noOwner} without owner`);
  if (counts.noCrew) bits.push(`${counts.noCrew} without crew`);
  if (counts.review) bits.push(`${counts.review} awaiting review`);
  if (counts.pendingUsers) bits.push(`${counts.pendingUsers} awaiting account approval`);
  if (!bits.length) return;

  const body = bits.join(" · ");
  await Promise.all(leaders.map((l) => writeNotification({
    id: `leadership_${l.uid}_${today}`, uid: l.uid, type: "leadership",
    title: "Team follow-up needed", body,
  })));
}

// Personal OVERDUE alerts — the people who own the NEXT action on a task whose
// postDate has passed (Winnipeg-local). Recipient ownership follows the workflow so
// nobody is blamed for work they can't act on:
//   Planned / In Progress / Changes Requested → active production owner + crew
//   Approved / Ready to Post                  → active captions/upload users
//   In Review                                 → nobody (QA + the leadership digest surface it)
// Admins/leads get the aggregate leadership digest, not per-task spam — they only
// appear here when they're an actual eligible owner/crew or captions user.
function overdueRecipients(task, byUid, nameIndex, captionsUsers) {
  const s = task.status;
  if (s === "In Review" || s === "Posted") return [];
  if (s === "Approved" || s === "Ready to Post") return captionsUsers;
  // Planned / In Progress / Changes Requested → the owner + assigned crew, resolved
  // via the shared assignment-identity helper (authoritative uids; a genuinely legacy
  // task falls back to a UNIQUE, production-eligible OWNER-name match only — name-only
  // crew are not authorized by Firestore and are logged as skipped).
  return eligibleAssigneeUids(task, { byUid, nameIndex, logger, taskId: task.id })
    .map((uid) => byUid[uid]).filter(Boolean);
}

// Daily overdue sweep. Returns accurate counts so the caller can log + retry.
// A task is only counted as an ALERT when notifyUsers actually created a doc — a task
// whose every recipient was ineligible or opted out counts as suppressed, not created.
// Any Firestore failure PROPAGATES (the sweep does not swallow it) so Cloud Scheduler
// can retry; the deterministic per-recipient idempotency key makes a retry safe.
async function overdueSweep(users, byUid, { notify = notifyUsers } = {}) {
  const today = localToday();
  const tasks = (await db.collection("tasks").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const captionsUsers = users.filter((u) => u.captions === true);   // recipientEligible drops QA/inactive
  const nameIndex = indexUsersByName(users);
  const stats = { date: today, tasksOverdue: 0, attempted: 0, created: 0, suppressed: 0, deduped: 0 };
  for (const t of tasks) {
    if (t.deletedAt || t.status === "Posted") continue;             // never missing/trashed/Posted
    if (!t.postDate || !(t.postDate < today)) continue;             // not overdue (missing due date → skip)
    stats.tasksOverdue++;
    const recips = overdueRecipients(t, byUid, nameIndex, captionsUsers);
    if (!recips.length) continue;
    // Idempotency key = task + DUE-DATE REVISION (postDate) + milestone + recipient
    // (added by notifyUsers). One alert on first overdue; a later postDate that goes
    // overdue again yields a new key → a fresh alert. notifyUsers dedups per recipient.
    const r = await notify(recips, {
      type: "overdue", taskId: t.id,
      keyBase: `overdue_${t.id}_${t.postDate}_first`,
      title: `'${formatContentTitle(t.title)}' is overdue`,
      body: `This was due ${humanDate(t.postDate)}. Open it to review the next action.`,
    });
    // Count only what actually happened. A task whose every recipient was ineligible
    // or opted out contributes to `suppressed`, never to `created`.
    stats.attempted += r.considered; stats.created += r.created;
    stats.suppressed += r.suppressed; stats.deduped += r.deduped;
  }
  return stats;
}

// Run the once-daily stages with STAGE ISOLATION. Both stages are ALWAYS attempted
// independently: a leadership-digest failure never blocks the overdue sweep, and an
// overdue failure never erases the record of a leadership failure. BOTH errors are
// captured and returned (never swallowed as success) so the caller can fail the
// scheduled function for a safe Cloud Scheduler retry — the deterministic idempotency
// keys make either stage's retry non-duplicating, and reminder-instance processing
// already committed above is independent and terminal.
async function runDailyStages({ leadership, overdue, date, log = logger }) {
  let leadershipError = null, overdueError = null, stats = null;
  try { await leadership(); }
  catch (e) { leadershipError = e; log.error("dispatch daily stage failed", { date, stage: "leadership", error: e.message }); }
  try {
    stats = await overdue();
    log.info("overdue sweep complete", { date, stage: "overdue", ...stats });
  } catch (e) {
    overdueError = e; log.error("dispatch daily stage failed", { date, stage: "overdue", error: e.message });
  }
  return { leadershipError, overdueError, stats };
}

async function runDispatch() {
  const now = new Date();
  const execId = `${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
  const { list: users, byName, byUid } = await loadUsers();
  const settings = await loadSettings();

  const dueSnap = await db.collection("reminderInstances")
    .where("status", "==", "pending").where("fireAt", "<=", Timestamp.fromDate(now)).get();
  const procSnap = await db.collection("reminderInstances").where("status", "==", "processing").get();
  const stale = procSnap.docs.filter((d) => { const lu = d.data().leaseUntil; return lu && lu.toDate() < now; });
  const candidates = [...dueSnap.docs, ...stale];

  let processed = 0, skipped = 0, failed = 0;
  // Reminder EMAILS are batched into one digest per user per day. The digest is
  // DURABLE (reminderDigests): a due reminder's email requirement is recorded
  // before its instance is marked processed, so a crash can't lose the email.
  const today = localToday();
  for (const snap of candidates) {
    const inst = await claim(snap.ref, execId, now);
    if (!inst) continue; // another run owns it
    try {
      const taskSnap = await db.doc(`tasks/${inst.taskId}`).get();
      const task = taskSnap.exists ? taskSnap.data() : null;
      // Re-read at send time and never remind on a missing, trashed, or completed
      // task. A trashed task is inactive: no in-app, no push, no email digest item
      // (the digest is only enqueued further down, after this skip).
      if (!task || task.deletedAt || task.status === "Posted") {
        await snap.ref.update({ status: "skipped", processedAt: FieldValue.serverTimestamp() });
        skipped++; continue;
      }
      const recipients = resolveTaskRecipients(inst.recipients, task, users, byName)
        .map((uid) => byUid[uid]).filter(Boolean);
      const dueText = relativeDue(task.postDate);
      const dispTitle = formatContentTitle(task.title);   // Title Case for reminder text + email digest
      // In-app + push per task (durable via notifyUsers; email deferred to the digest).
      await notifyUsers(recipients, {
        type: "reminder", taskId: inst.taskId,
        title: `'${dispTitle}' ${dueText}`,
        keyBase: `reminder_${snap.id}`,
        channels: (inst.channels || []).filter((c) => c !== "email"),
      });
      // Durably enqueue the email requirement BEFORE marking processed, so the
      // email survives a crash. Idempotent (arrayUnion) if the instance is reclaimed.
      if ((inst.channels || []).includes("email")) {
        for (const u of recipients) {
          if (!isActive(u) || !emailAllow(u) || !prefsAllow(u, "reminder")) continue;
          await enqueueDigestItem(u.uid, today, { taskId: inst.taskId, title: dispTitle, dueText });
        }
      }
      await snap.ref.update({ status: "processed", processedAt: FieldValue.serverTimestamp(), lastError: "" });
      processed++;
    } catch (e) {
      failed++;
      const msg = String((e && e.message) || e).slice(0, 300);
      await snap.ref.update(inst.attempts >= MAX_ATTEMPTS
        ? { status: "failed", lastError: msg }
        : { status: "pending", leaseUntil: null, claimedBy: null, lastError: msg });
    }
  }

  // Send every pending digest (across all runs — a crashed run's digest is picked
  // up here, not lost) idempotently from the durable store.
  const { sent: digests } = await flushDigests({ byUid, send: sendDigestEmail });

  // Once per day at the configured local hour: the leadership digest AND the personal
  // overdue sweep, with stage isolation. Both are idempotent, so the hourly cron is safe.
  const dailyDate = localToday();
  const dailyFail = [];
  if (localHour() === settings.reminderHourLocal) {
    const r = await runDailyStages({
      leadership: () => leadershipDigest(users, settings),
      overdue: () => overdueSweep(users, byUid),
      date: dailyDate,
    });
    if (r.leadershipError) dailyFail.push(`leadership: ${r.leadershipError.message}`);
    if (r.overdueError) dailyFail.push(`overdue: ${r.overdueError.message}`);
  }

  // Release reservations stuck in "unknown" after an uncertain send. (Safe cleanup —
  // runs even when a daily stage failed, BEFORE we surface that failure for retry.)
  let reconciled = 0;
  try { reconciled = await quota.reconcile(); } catch (e) { logger.warn("email reconcile failed", { error: e.message }); }

  // (Resend account usage is observed from POST /emails responses on every send — see
  // emailService.js/resendUsage.js — so there is no GET-based refresh to run here.)

  logger.info("dispatchReminders complete", {
    candidates: candidates.length, processed, skipped, failed, digests, reconciled,
    date: dailyDate, dailyStagesFailed: dailyFail,
  });
  // If EITHER daily stage failed, the run must NOT count as a success: fail AFTER the
  // safe cleanup above so Cloud Scheduler retries this Winnipeg-local hour. Both stage
  // names + messages are preserved in the surfaced error. Reminder instances committed
  // independently and are not reprocessed (their leases are terminal).
  if (dailyFail.length) throw new Error(`daily stage(s) failed on ${dailyDate} — surfacing for retry: ${dailyFail.join("; ")}`);
  return { candidates: candidates.length, processed, skipped, failed, digests, reconciled };
}

exports.dispatchReminders = onSchedule(
  { schedule: "every 1 hours", timeZone: TZ, memory: "256MiB", timeoutSeconds: 120, maxInstances: 1, secrets: [resendApiKey] },
  runDispatch,
);
// Exposed for emulator/manual testing without waiting for the scheduler.
exports.runDispatch = runDispatch;
exports.leadershipDigest = leadershipDigest; // exposed for emulator tests
exports.overdueSweep = overdueSweep;         // exposed for emulator tests
exports.overdueRecipients = overdueRecipients;
exports.runDailyStages = runDailyStages;     // exposed for unit tests (stage isolation)
