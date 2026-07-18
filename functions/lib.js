/* ===================================================================
   Shared helpers for the notification backend.

   All human-facing schedules use America/Winnipeg; every stored
   timestamp is UTC. Notification writes are idempotent (deterministic
   doc id via .create()), so a re-fired trigger never double-notifies.
   =================================================================== */
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { logger } = require("firebase-functions/v2");
const { DateTime } = require("luxon");

if (!getApps().length) initializeApp();
const db = getFirestore();

const TZ = "America/Winnipeg";
const ALREADY_EXISTS = 6; // gRPC status code

// Fallback default reminder schedule if settings/notifications isn't set yet.
const CH = ["in-app", "push", "email"]; // all channels; each still respects per-user prefs
const DEFAULT_REMINDERS = [
  { id: "d1", offset: 7, when: "before", channels: CH, recipients: ["owner", "crew"], enabled: true },
  { id: "d2", offset: 3, when: "before", channels: CH, recipients: ["owner", "crew"], enabled: true },
  { id: "d3", offset: 1, when: "before", channels: CH, recipients: ["owner", "crew"], enabled: true },
  { id: "d4", offset: 3, when: "after",  channels: CH, recipients: ["owner", "admins"], enabled: true },
];

/* ---- users ---- */
async function loadUsers() {
  const snap = await db.collection("users").get();
  const list = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  const byName = {}, byUid = {};
  list.forEach((u) => { byUid[u.uid] = u; if (u.name) byName[u.name] = u; });
  return { list, byName, byUid };
}

async function loadSettings() {
  const snap = await db.doc("settings/notifications").get();
  const d = snap.exists ? snap.data() : {};
  return {
    defaultReminders: d.defaultReminders && d.defaultReminders.length ? d.defaultReminders : DEFAULT_REMINDERS,
    reminderHourLocal: d.reminderHourLocal != null ? d.reminderHourLocal : 9,
    leadershipAlertRoles: d.leadershipAlertRoles && d.leadershipAlertRoles.length ? d.leadershipAlertRoles : ["admin", "lead"],
  };
}

/* ---- notification preferences (mirror of the client default: everything on) ---- */
function prefsAllow(user, type) {
  const per = (user && user.notifPrefs && user.notifPrefs.perType) || {};
  return per[type] !== false; // missing = on
}
const pushAllow = (user) => !(user && user.notifPrefs && user.notifPrefs.push === false); // missing = on
const emailAllow = (user) => !(user && user.notifPrefs && user.notifPrefs.email === false); // missing = on
const isActive = (user) => user && (user.status === "approved" || user.role === "admin");

/* ---- web push (FCM) ---- send to all of a user's devices, prune dead tokens.
   Safe no-op when the user has no tokens (e.g. in the emulator). */
async function sendPush(uid, { title, body, url }) {
  const col = db.collection("users").doc(uid).collection("fcmTokens");
  const snap = await col.get();
  if (snap.empty) return;
  const tokens = snap.docs.map((d) => d.id);
  let resp;
  try {
    resp = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title, body: body || "" },
      data: { url: url || "/" },
      webpush: { fcmOptions: { link: url || "/" } },
    });
  } catch (e) { logger.warn("push send failed", { uid, error: e.message }); return; }
  const dead = [];
  resp.responses.forEach((r, i) => {
    const code = !r.success && r.error && r.error.code;
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-argument") dead.push(tokens[i]);
  });
  await Promise.all(dead.map((t) => col.doc(t).delete()));
}

/* ---- idempotent notification write ---- */
async function writeNotification({ id, uid, type, title, body = "", taskId = "", eventOccurrenceId = "" }) {
  try {
    await db.collection("notifications").doc(id).create({
      uid, type, title, body, taskId, eventOccurrenceId,
      read: false, channels: ["in-app"], dedupeKey: id,
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    if (e.code === ALREADY_EXISTS) return false; // already sent — idempotent
    throw e;
  }
}

// Notify a set of user objects: writes an idempotent in-app notification and,
// when newly created and allowed, sends a web push. Honors per-type prefs
// (unless `required`) and the notification's `channels` (default: push allowed).
// `keyBase` yields one deterministic doc per recipient.
async function notifyUsers(recipients, { type, title, body, taskId, eventOccurrenceId, keyBase, required = false, channels = null, whenText = "", priority = "" }) {
  const url = taskId ? `/?task=${taskId}` : "/";
  const pushChannel = !channels || channels.includes("push");
  const emailChannel = !channels || channels.includes("email");
  const seen = new Set();
  await Promise.all(recipients.filter(Boolean).map(async (u) => {
    if (seen.has(u.uid)) return; seen.add(u.uid);
    if (!required && !prefsAllow(u, type)) return;
    const notificationId = `${keyBase}_${u.uid}`;
    const created = await writeNotification({ id: notificationId, uid: u.uid, type, title, body, taskId, eventOccurrenceId });
    if (!created) return; // idempotent: someone already delivered this one
    // Fan out to external channels (only on the first write; each respects prefs).
    if (pushChannel && pushAllow(u)) await sendPush(u.uid, { title, body, url });
    if (emailChannel && emailAllow(u) && isActive(u)) {
      const { sendNotificationEmail } = require("./emailService"); // lazy → avoid load-order cycle
      await sendNotificationEmail({ user: u, type, title, body, taskId, eventId: eventOccurrenceId, url, notificationId, whenText, priority });
    }
  }));
}

/* ---- recipient resolution (role tags → users) ---- */
function resolveTaskRecipients(roleTags, task, users, byName) {
  const tags = roleTags && roleTags.length ? roleTags : ["owner"];
  const uids = new Set();
  for (const tag of tags) {
    if (tag === "owner") { const u = byName[task.owner]; if (u) uids.add(u.uid); }
    else if (tag === "crew") (task.support || []).forEach((s) => { const u = byName[s.name]; if (u) uids.add(u.uid); });
    else if (tag === "lead") users.filter((u) => u.lead).forEach((u) => uids.add(u.uid));
    else if (tag === "admins") users.filter((u) => u.role === "admin").forEach((u) => uids.add(u.uid));
  }
  return [...uids];
}

const CREW_LABEL = { shoot: "shooter", edit: "editor", coordinate: "coordinator", design: "designer", shadow: "shadow" };
const crewRoleLabel = (s) => (s.role === "other" ? (s.label || "crew") : (CREW_LABEL[s.role] || "crew"));

/* ---- time helpers (Winnipeg ↔ UTC) ---- */
// fireAt = local `hour` on the due date, shifted by offset days, as a UTC Date.
function computeFireAt(postDateISO, offset, when, hour) {
  if (!postDateISO) return null;
  let dt = DateTime.fromISO(postDateISO, { zone: TZ }).set({ hour, minute: 0, second: 0, millisecond: 0 });
  if (!dt.isValid) return null;
  dt = when === "after" ? dt.plus({ days: offset }) : dt.minus({ days: offset });
  return dt.toUTC().toJSDate();
}

// Human "is due in 3 days" / "is 2 days overdue" for a reminder title.
function relativeDue(postDateISO) {
  if (!postDateISO) return "needs attention";
  const today = DateTime.now().setZone(TZ).startOf("day");
  const due = DateTime.fromISO(postDateISO, { zone: TZ }).startOf("day");
  const days = Math.round(due.diff(today, "days").days);
  if (days > 1) return `is due in ${days} days`;
  if (days === 1) return "is due tomorrow";
  if (days === 0) return "is due today";
  if (days === -1) return "was due yesterday";
  return `is ${Math.abs(days)} days overdue`;
}

const localHour = () => DateTime.now().setZone(TZ).hour;
const localToday = () => DateTime.now().setZone(TZ).toISODate();

module.exports = {
  db, FieldValue, Timestamp, TZ, DEFAULT_REMINDERS,
  loadUsers, loadSettings, prefsAllow, pushAllow, emailAllow, isActive, sendPush, writeNotification, notifyUsers,
  resolveTaskRecipients, crewRoleLabel, computeFireAt, relativeDue, localHour, localToday,
};
