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
  loadUsers, loadSettings, notifyUsers, writeNotification,
  resolveTaskRecipients, relativeDue, localHour, localToday,
} = require("./lib");

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
  const leaders = users.filter((u) =>
    (roles.includes("admin") && u.role === "admin") || (roles.includes("lead") && u.lead));
  if (!leaders.length) return;

  const tasks = (await db.collection("tasks").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const today = localToday();
  const active = tasks.filter((t) => t.status !== "Posted");
  const counts = {
    overdue: active.filter((t) => t.postDate && t.postDate < today).length,
    blocked: active.filter((t) => t.blockedOn).length,
    noOwner: active.filter((t) => !t.owner || t.owner === "Pending").length,
    noCrew: active.filter((t) => !t.support || !t.support.length).length,
    review: tasks.filter((t) => t.status === "In Review").length,
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
  for (const snap of candidates) {
    const inst = await claim(snap.ref, execId, now);
    if (!inst) continue; // another run owns it
    try {
      const taskSnap = await db.doc(`tasks/${inst.taskId}`).get();
      const task = taskSnap.exists ? taskSnap.data() : null;
      if (!task || task.status === "Posted") {
        await snap.ref.update({ status: "skipped", processedAt: FieldValue.serverTimestamp() });
        skipped++; continue;
      }
      const recipients = resolveTaskRecipients(inst.recipients, task, users, byName)
        .map((uid) => byUid[uid]).filter(Boolean);
      await notifyUsers(recipients, {
        type: "reminder", taskId: inst.taskId,
        title: `'${task.title}' ${relativeDue(task.postDate)}`,
        keyBase: `reminder_${snap.id}`, channels: inst.channels,
      });
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

  // Morning leadership digest (once per day at the configured local hour).
  if (localHour() === settings.reminderHourLocal) {
    await leadershipDigest(users, settings);
  }

  logger.info("dispatchReminders complete", { candidates: candidates.length, processed, skipped, failed });
  return { candidates: candidates.length, processed, skipped, failed };
}

exports.dispatchReminders = onSchedule(
  { schedule: "every 1 hours", timeZone: TZ, memory: "256MiB", timeoutSeconds: 120, maxInstances: 1 },
  runDispatch,
);
// Exposed for emulator/manual testing without waiting for the scheduler.
exports.runDispatch = runDispatch;
