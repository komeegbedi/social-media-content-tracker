/* Task trigger: fires immediate workflow notifications and (re)materializes
   the reminder queue whenever a task's due date or reminder config changes. */
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions/v2");
const {
  db, FieldValue, Timestamp,
  loadUsers, loadSettings, notifyUsers, crewRoleLabel, computeFireAt, formatContentTitle,
} = require("./lib");
const { resendApiKey } = require("./emailService");
const { eventToken, notificationKeyBase } = require("./eventIdentity");
const { scheduleRevision, instanceId } = require("./reminderSchedule");

// Rebuild the pending reminderInstances for a task. Every instance id carries a
// schedule-revision hash, so:
//   - a redelivered write reproduces the same ids (idempotent — no duplicates);
//   - a changed schedule mints NEW ids, even on the same calendar date, without
//     colliding with the PROCESSED history of the old schedule.
// The create + delete run in ONE transaction, so there is never a moment with no
// instances (no delete-then-create gap) and never a double-fire overlap. Only
// PENDING instances of a superseded revision are removed; processed/failed
// history is preserved. Posted/no-postDate → all pending cancelled.
async function materializeReminders(taskId, task) {
  const rebuild = task.status !== "Posted" && !!task.postDate;
  const settings = await loadSettings();
  const reminders = rebuild
    ? ((task.reminders && task.reminders.length) ? task.reminders : settings.defaultReminders)
    : [];
  const hour = settings.reminderHourLocal;
  const rev = scheduleRevision(task.postDate, reminders, hour);
  const now = Date.now();

  // Desired future instances for the current schedule (past fire times are
  // skipped so a due-date edit doesn't retroactively spam).
  const desired = [];
  reminders.forEach((r, idx) => {
    if (r.enabled === false) return;
    const rid = r.id || `r${idx}`;
    const fireAt = computeFireAt(task.postDate, Number(r.offset) || 0, r.when || "before", hour);
    if (!fireAt || fireAt.getTime() < now) return;
    desired.push({
      id: instanceId(taskId, rid, fireAt.toISOString().slice(0, 10), rev),
      rid, fireAt,
      recipients: (r.recipients && r.recipients.length) ? r.recipients : ["owner"],
      channels: (r.channels && r.channels.length) ? r.channels : ["in-app"],
    });
  });

  const col = db.collection("reminderInstances");
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(col.where("taskId", "==", taskId));
    const existing = new Set(snap.docs.map((d) => d.id));
    // Create any missing desired instances (skip ones already there → idempotent).
    for (const d of desired) {
      if (existing.has(d.id)) continue;
      tx.set(col.doc(d.id), {
        taskId, reminderId: d.rid, scheduleRev: rev, fireAt: Timestamp.fromDate(d.fireAt),
        recipients: d.recipients, channels: d.channels,
        status: "pending", leaseUntil: null, claimedBy: null,
        attempts: 0, lastError: "", dedupeKey: d.id, processedAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    // Remove only PENDING instances of a superseded schedule (or all pending when
    // not rebuilding). Processed/failed history is never touched.
    snap.docs.forEach((doc) => {
      const data = doc.data();
      if (data.status !== "pending") return;
      if (!rebuild || data.scheduleRev !== rev) tx.delete(doc.ref);
    });
  });
}

exports.onTaskWrite = onDocumentWritten(
  { document: "tasks/{taskId}", memory: "256MiB", timeoutSeconds: 60, secrets: [resendApiKey] },
  async (event) => {
    const taskId = event.params.taskId;
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;

    if (!after) { // task deleted → drop its pending reminders
      const pend = await db.collection("reminderInstances")
        .where("taskId", "==", taskId).where("status", "==", "pending").get();
      const batch = db.batch(); pend.docs.forEach((d) => batch.delete(d.ref));
      if (!pend.empty) await batch.commit();
      return;
    }

    const { list: users, byName } = await loadUsers();
    const dispTitle = formatContentTitle(after.title);   // Title Case for all notification text
    const admins = users.filter((u) => u.role === "admin");
    const qaUsers = users.filter((u) => u.qa === true || u.role === "admin");
    const captionUsers = users.filter((u) => u.captions === true);
    // Immutable per-event token from Firestore event metadata (CloudEvent id, or
    // the after-snapshot commit time as fallback) — identical on a Firebase retry,
    // distinct for every later write. Notification id = type + taskId + token + uid,
    // so a redelivery dedupes while any genuinely new write re-notifies.
    const token = eventToken(event.id, event.data.after.updateTime);
    const kb = (type) => notificationKeyBase(type, taskId, token);

    // --- assignment notifications ---
    if (after.owner && after.owner !== "Pending" && after.owner !== before?.owner) {
      const ou = byName[after.owner];
      if (ou) await notifyUsers([ou], { type: "assigned", taskId,
        title: `You've been assigned to '${dispTitle}'`, body: "You're leading this piece.",
        keyBase: kb("assigned") });
    }
    const beforeCrew = new Set((before?.support || []).map((s) => s.name));
    for (const s of (after.support || [])) {
      if (beforeCrew.has(s.name)) continue;
      const cu = byName[s.name];
      // Crew identity is the recipient uid (+ event token); the display name is
      // only copy. A re-add is a new write → new token → re-notify.
      if (cu) await notifyUsers([cu], { type: "assigned", taskId,
        title: `You've been added to '${dispTitle}'`, body: `As ${crewRoleLabel(s)}.`,
        keyBase: kb("assigned") });
    }

    // --- status transition notifications ---
    if (after.status !== before?.status) {
      const owner = byName[after.owner];
      if (after.status === "In Review") {
        // QA reviewers own the next action (review). Admins get in-app only,
        // and only if they aren't already reviewers, so they aren't push-spammed.
        const reviewers = qaUsers;
        const reviewerIds = new Set(reviewers.map((u) => u.uid));
        await notifyUsers(reviewers, { type: "qa", taskId, keyBase: kb("qa"),
          title: `'${dispTitle}' is awaiting review` });
        const otherAdmins = admins.filter((u) => !reviewerIds.has(u.uid));
        if (otherAdmins.length) await notifyUsers(otherAdmins, { type: "qa", taskId, keyBase: kb("qa"),
          channels: ["in-app"], title: `'${dispTitle}' was submitted for review` });
      } else if (after.status === "Changes Requested") {
        await notifyUsers(owner ? [owner] : [], { type: "changes", taskId, keyBase: kb("changes"),
          title: `Changes requested on '${dispTitle}'` });
      } else if (after.status === "Approved") {
        // Owner: informational (in-app only). Caption/posting team: action —
        // approval is their cue to caption, so they get push.
        if (owner) await notifyUsers([owner], { type: "approved", taskId, keyBase: kb("approved"), channels: ["in-app"],
          title: `'${dispTitle}' has been approved` });
        const captioners = captionUsers.filter((u) => !owner || u.uid !== owner.uid);
        if (captioners.length) await notifyUsers(captioners, { type: "ready", taskId, keyBase: kb("ready"),
          title: `'${dispTitle}' is approved — ready to caption` });
      } else if (after.status === "Ready to Post") {
        await notifyUsers(captionUsers, { type: "ready", taskId, keyBase: kb("ready"),
          title: `'${dispTitle}' is ready to publish` });
      }
    }

    // --- reminder materialization ---
    const created = !before;
    const dueChanged = before?.postDate !== after.postDate;
    const remindersChanged = JSON.stringify(before?.reminders || null) !== JSON.stringify(after.reminders || null);
    const statusChanged = before?.status !== after.status;
    if (created || dueChanged || remindersChanged || statusChanged) {
      await materializeReminders(taskId, after);
    }
    logger.debug("onTaskWrite handled", { taskId, status: after.status });
  },
);
// Exposed for emulator tests (materialization without firing the whole trigger).
exports.materializeReminders = materializeReminders;
