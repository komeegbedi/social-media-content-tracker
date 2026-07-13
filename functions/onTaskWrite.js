/* Task trigger: fires immediate workflow notifications and (re)materializes
   the reminder queue whenever a task's due date or reminder config changes. */
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions/v2");
const {
  db, FieldValue, Timestamp,
  loadUsers, loadSettings, notifyUsers, crewRoleLabel, computeFireAt,
} = require("./lib");

const statusKey = (s) => String(s).replace(/\s+/g, "-");

// Rebuild the pending reminderInstances for a task. Never touches processed /
// failed history; skips instances whose fire time is already in the past (so a
// due-date edit doesn't retroactively spam). Posted/archived → none created.
async function materializeReminders(taskId, task) {
  const pending = await db.collection("reminderInstances")
    .where("taskId", "==", taskId).where("status", "==", "pending").get();
  if (!pending.empty) {
    const batch = db.batch();
    pending.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  if (task.status === "Posted" || !task.postDate) return;

  const settings = await loadSettings();
  const reminders = (task.reminders && task.reminders.length) ? task.reminders : settings.defaultReminders;
  const hour = settings.reminderHourLocal;
  const now = Date.now();

  await Promise.all(reminders.map(async (r, idx) => {
    if (r.enabled === false) return;
    const rid = r.id || `r${idx}`;
    const fireAt = computeFireAt(task.postDate, Number(r.offset) || 0, r.when || "before", hour);
    if (!fireAt || fireAt.getTime() < now) return;
    const id = `${taskId}_${rid}_${fireAt.toISOString().slice(0, 10)}`;
    try {
      await db.collection("reminderInstances").doc(id).create({
        taskId, reminderId: rid, fireAt: Timestamp.fromDate(fireAt),
        recipients: (r.recipients && r.recipients.length) ? r.recipients : ["owner"],
        channels: (r.channels && r.channels.length) ? r.channels : ["in-app"],
        status: "pending", leaseUntil: null, claimedBy: null,
        attempts: 0, lastError: "", dedupeKey: id, processedAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) { if (e.code !== 6) throw e; } // ALREADY_EXISTS → keep existing
  }));
}

exports.onTaskWrite = onDocumentWritten(
  { document: "tasks/{taskId}", memory: "256MiB", timeoutSeconds: 60 },
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
    const admins = users.filter((u) => u.role === "admin");
    const qaUsers = users.filter((u) => u.qa === true || u.role === "admin");
    const captionUsers = users.filter((u) => u.captions === true);

    // --- assignment notifications ---
    if (after.owner && after.owner !== "Pending" && after.owner !== before?.owner) {
      const ou = byName[after.owner];
      if (ou) await notifyUsers([ou], { type: "assigned", taskId,
        title: `You've been assigned to '${after.title}'`, body: "You're leading this piece.",
        keyBase: `assigned_owner_${taskId}` });
    }
    const beforeCrew = new Set((before?.support || []).map((s) => s.name));
    for (const s of (after.support || [])) {
      if (beforeCrew.has(s.name)) continue;
      const cu = byName[s.name];
      if (cu) await notifyUsers([cu], { type: "assigned", taskId,
        title: `You've been added to '${after.title}'`, body: `As ${crewRoleLabel(s)}.`,
        keyBase: `assigned_crew_${taskId}_${statusKey(s.name)}` });
    }

    // --- status transition notifications ---
    if (after.status !== before?.status) {
      const owner = byName[after.owner];
      const keyBase = `status_${taskId}_${statusKey(after.status)}`;
      if (after.status === "In Review")
        await notifyUsers([...qaUsers, ...admins], { type: "qa", taskId, keyBase,
          title: `'${after.title}' is awaiting review` });
      else if (after.status === "Changes Requested")
        await notifyUsers(owner ? [owner] : [], { type: "changes", taskId, keyBase,
          title: `Changes requested on '${after.title}'` });
      else if (after.status === "Approved")
        await notifyUsers([owner, ...captionUsers], { type: "approved", taskId, keyBase,
          title: `'${after.title}' has been approved` });
      else if (after.status === "Ready to Post")
        await notifyUsers(captionUsers, { type: "ready", taskId, keyBase,
          title: `'${after.title}' is ready to publish` });
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
