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
const { isClaimable, claimChannel, finalizeChannel, skipChannel, rollup, LEASE_MS } = require("./deliveryCore");
const { randomUUID } = require("crypto");

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
   Returns a delivery outcome (never throws): { ok } | { skip, reason } |
   { ok:false, errorClass, code }. A caller records it as the push channel's state
   so a failure is retried with backoff instead of silently lost.

   FCM push is AT-LEAST-ONCE, not idempotent: there is no send-side dedup key. The
   per-channel lease stops a concurrent trigger + sweep from both sending, but it
   cannot close the crash window between FCM accepting a message and Firestore
   recording success — a retry after that window sends again. We pass a stable
   `tag` (the notification id) as the webpush collapse identifier so the browser
   REPLACES rather than stacks a duplicate, reducing (not eliminating) double
   presentation. Email, by contrast, is exactly-once (Resend idempotency key +
   emailDeliveries ledger). */
const DEAD_TOKEN = new Set(["messaging/registration-token-not-registered", "messaging/invalid-argument"]);
async function sendPush(uid, { title, body, url, tag }) {
  const col = db.collection("users").doc(uid).collection("fcmTokens");
  const snap = await col.get();
  if (snap.empty) return { skip: true, reason: "no-tokens" };
  const tokens = snap.docs.map((d) => d.id);
  const webpush = { fcmOptions: { link: url || "/" } };
  if (tag) webpush.notification = { tag }; // collapse duplicates to one on-screen toast
  let resp;
  try {
    resp = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title, body: body || "" },
      data: { url: url || "/" },
      webpush,
    });
  } catch (e) {
    logger.warn("push send failed", { uid, error: e.message });
    return { ok: false, errorClass: "temporary", code: String((e && (e.code || e.message)) || "push-error").slice(0, 60) };
  }
  const dead = [];
  resp.responses.forEach((r, i) => {
    const code = !r.success && r.error && r.error.code;
    if (DEAD_TOKEN.has(code)) dead.push(tokens[i]);
  });
  await Promise.all(dead.map((t) => col.doc(t).delete()));
  if (resp.successCount > 0) return { ok: true };
  // Every device failed. If all failures were dead tokens (now pruned), a retry
  // is pointless → permanent. Otherwise a transient FCM error → retry.
  const allDead = resp.responses.every((r) => DEAD_TOKEN.has(r.error && r.error.code));
  return { ok: false, errorClass: allDead ? "permanent" : "temporary", code: "push-failed" };
}

/* Canonical deep-link for push/email, mirroring src/nav.js notificationDestination
   so an external tap lands exactly where an in-app tap would. Kept in sync by
   hand (server is CommonJS, client is ESM); the client mapper is the reference. */
function deepLinkUrl({ type, taskId, eventOccurrenceId, commentId, userId, route }) {
  if (route) return route;
  if (taskId) {
    const focus = type === "qa" ? "review"
      : (type === "mention" || type === "changes") ? "comments" : "";
    const q = [];
    if (focus) q.push(`focus=${focus}`);
    if (focus === "comments" && commentId) q.push(`comment=${encodeURIComponent(commentId)}`);
    return `/content/${encodeURIComponent(taskId)}${q.length ? `?${q.join("&")}` : ""}`;
  }
  if (eventOccurrenceId) return `/workflow?event=${encodeURIComponent(eventOccurrenceId)}`;
  // Account/people alerts → Admin → People, highlighting the user when known.
  if (type === "account_pending") return `/admin?section=people${userId ? `&user=${encodeURIComponent(userId)}` : ""}`;
  if (type === "leadership") return "/workflow?filter=attention";
  if (type === "weeklyTaskCheck") return "/my-day";
  return "/";
}

/* ---- notification doc + per-channel delivery state ---- */
// Seed the delivery map: in-app is delivered the moment the doc exists; every
// other channel starts pending and due now (nextAttemptAt = now).
function seedDelivery(channels, nowMs) {
  const delivery = { "in-app": { status: "sent", attempts: 1, firstAttemptAt: nowMs, lastAttemptAt: nowMs, sentAt: nowMs } };
  for (const ch of channels) if (ch !== "in-app") delivery[ch] = { status: "pending", attempts: 0, nextAttemptAt: nowMs };
  return delivery;
}
const toTs = (ms) => (ms != null ? Timestamp.fromMillis(ms) : null);

// Idempotent in-app-only notification (create-if-absent). Returns whether it was
// newly created. Used by senders that fan out no external channels (leadership,
// weekly digest). Retry-safe: a re-fired trigger never double-writes.
async function writeNotification({ id, uid, type, title, body = "", taskId = "", eventOccurrenceId = "", commentId = "", userId = "" }) {
  const nowMs = Date.now();
  const delivery = seedDelivery(["in-app"], nowMs);
  try {
    await db.collection("notifications").doc(id).create({
      uid, type, title, body, taskId, eventOccurrenceId, commentId, userId,
      read: false, channels: ["in-app"], dedupeKey: id,
      delivery, deliveryPending: false, nextAttemptAt: null,
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    if (e.code === ALREADY_EXISTS) return false; // already sent — idempotent
    throw e;
  }
}

// Create-if-absent a multi-channel notification, seeding delivery state for every
// channel. Idempotent per (event, recipient) via the deterministic doc id.
async function ensureNotification({ id, uid, type, title, body = "", taskId = "", eventOccurrenceId = "", commentId = "", userId = "", channels, whenText = "", priority = "", route = "" }) {
  const ref = db.collection("notifications").doc(id);
  const nowMs = Date.now();
  const delivery = seedDelivery(channels, nowMs);
  const roll = rollup(delivery);
  try {
    await ref.create({
      uid, type, title, body, taskId, eventOccurrenceId, commentId, userId,
      read: false, channels, dedupeKey: id, whenText, priority, route,
      delivery, deliveryPending: roll.deliveryPending, nextAttemptAt: toTs(roll.nextAttemptAt),
      createdAt: FieldValue.serverTimestamp(),
    });
    return { ref, created: true };
  } catch (e) {
    if (e.code === ALREADY_EXISTS) return { ref, created: false };
    throw e;
  }
}

// Map an emailService result to a delivery outcome. `sent`/`already-sent` are
// success; quota-suppressed and prefs/inactive skips are terminal; permanent
// provider rejections don't retry; everything uncertain retries (Resend's
// idempotency key makes a retry safe).
function emailOutcome(r) {
  const s = r && r.status;
  if (s === "sent" || s === "already-sent") return { ok: true };
  if (s === "skipped") return { skip: true, reason: (r && r.reason) || "skipped" };
  if (s === "suppressed") return { skip: true, reason: (r && r.reason) || "quota" };
  if (s === "failed") return { ok: false, errorClass: r && r.permanent ? "permanent" : "temporary", code: "email-failed" };
  return { ok: false, errorClass: "temporary", code: String(s || "email-error") }; // unknown / in-progress / claim
}

// The real channel senders. Injected in tests; the default here talks to FCM +
// Resend. `ctx` carries everything needed to (re)build the message identically
// on a retry, so the sweep reproduces the same send.
const DEFAULT_SENDERS = {
  push: (ctx) => sendPush(ctx.uid, { title: ctx.title, body: ctx.body, url: ctx.url, tag: ctx.notificationId }),
  email: async (ctx) => {
    const { sendNotificationEmail } = require("./emailService"); // lazy → avoid load-order cycle
    return emailOutcome(await sendNotificationEmail({
      user: ctx.user, type: ctx.type, title: ctx.title, body: ctx.body,
      taskId: ctx.taskId, eventId: ctx.eventId, url: ctx.url,
      notificationId: ctx.notificationId, whenText: ctx.whenText, priority: ctx.priority,
    }));
  },
};

// Write one channel's new state + the recomputed doc rollup, inside a transaction.
function writeChannel(tx, ref, docData, ch, chState) {
  const delivery = { ...(docData.delivery || {}), [ch]: chState };
  const roll = rollup(delivery);
  tx.update(ref, { [`delivery.${ch}`]: chState, deliveryPending: roll.deliveryPending, nextAttemptAt: toTs(roll.nextAttemptAt) });
}

// Attempt (or re-attempt) every due external channel for one notification doc.
// Called both inline (right after creation) and by the retry sweep — same path,
// so a delivery that failed the first time is retried later with backoff.
//
// Each channel is delivered under a transactional lease so a concurrent trigger
// and sweep can't both send:
//   1. CLAIM (txn): if the channel is claimable, mark it processing with a lease
//      owned by this execution. A rival with a valid lease is skipped.
//   2. SEND (no txn): the external call, outside the transaction.
//   3. COMMIT (txn): fold the outcome in — but ONLY if we still own the lease
//      (an expired-and-reclaimed channel is left to its new owner).
// In-app needs no work here (its state == the doc existing).
async function deliverToUser(ref, user, { senders = DEFAULT_SENDERS, execId = randomUUID(), now = Date.now } = {}) {
  const snap = await ref.get();
  if (!snap.exists) return;
  const n = snap.data();
  const external = (n.channels || ["in-app"]).filter((c) => c !== "in-app");
  if (!external.length) return;
  const url = n.route || deepLinkUrl({ type: n.type, taskId: n.taskId, eventOccurrenceId: n.eventOccurrenceId, commentId: n.commentId, userId: n.userId });
  const ctx = {
    uid: user.uid, user, title: n.title, body: n.body, url, type: n.type,
    taskId: n.taskId, eventId: n.eventOccurrenceId, notificationId: ref.id,
    whenText: n.whenText || "", priority: n.priority || policyFor(n.type).priority,
  };
  // Channel-level prefs are re-checked at delivery time (the user may have toggled
  // a channel off after the doc was created) → a terminal skip, no external call.
  const preSkip = (ch) => {
    if (ch === "push" && !pushAllow(user)) return "push-off";
    if (ch === "email" && !emailAllow(user)) return "email-off";
    if (ch === "email" && !isActive(user)) return "inactive";
    return null;
  };

  for (const ch of external) {
    // 1. Claim (or record a skip) atomically.
    const claimed = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return false;
      const d = s.data();
      const st = (d.delivery || {})[ch];
      if (!isClaimable(st, now())) return false; // terminal, not due, or a valid lease is held
      const skip = preSkip(ch);
      if (skip) { writeChannel(tx, ref, d, ch, skipChannel(st, skip, now())); return false; }
      writeChannel(tx, ref, d, ch, claimChannel(st, execId, now(), LEASE_MS));
      return true;
    });
    if (!claimed) continue;

    // 2. External send, outside any transaction. Never throws past here.
    let outcome;
    try { outcome = await senders[ch](ctx); }
    catch (e) { outcome = { ok: false, errorClass: "temporary", code: String((e && (e.code || e.message)) || "error").slice(0, 60) }; }

    // 3. Commit the outcome only if we still own the lease.
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return;
      const d = s.data();
      const st = (d.delivery || {})[ch];
      if (!st || st.leaseOwner !== execId) return; // reclaimed by another executor → discard our result
      writeChannel(tx, ref, d, ch, finalizeChannel(st, outcome, now()));
    });
  }
}

// Notify a set of user objects: writes an idempotent in-app notification and,
// when newly created and allowed, sends a web push. Honors per-type prefs
// (unless `required`) and the notification's `channels` (default: push allowed).
// `keyBase` yields one deterministic doc per recipient.
// Per-type channel + priority policy (v1.2). "Notify the person who owns the
// next action" — email is reserved for blocked/required/escalation cases so
// routine events don't fill inboxes. Callers may override `channels` (e.g. the
// reminder dispatcher strips email to batch a digest; the Approved handler
// gives the caption team push while the owner gets an in-app-only heads-up).
const NOTIFY_POLICY = {
  assigned:         { channels: ["in-app", "push"],           priority: "critical" },
  qa:               { channels: ["in-app", "push"],           priority: "action" },
  changes:          { channels: ["in-app", "push", "email"],  priority: "critical" },
  approved:         { channels: ["in-app"],                    priority: "standard" },
  ready:            { channels: ["in-app", "push"],            priority: "action" },
  reminder:         { channels: ["in-app", "push"],            priority: "action" },
  overdue:          { channels: ["in-app", "push"],            priority: "critical" },
  mention:          { channels: ["in-app", "push"],            priority: "action" },
  account_approved: { channels: ["in-app", "email"],          priority: "critical" },
  account_pending:  { channels: ["in-app", "push", "email"],  priority: "critical" },
  leadership:       { channels: ["in-app"],                    priority: "standard" },
  weeklyTaskCheck:  { channels: ["in-app", "push"],            priority: "standard" },
};
const policyFor = (type) => NOTIFY_POLICY[type] || { channels: ["in-app", "push"], priority: "standard" };

async function notifyUsers(recipients, { type, title, body, taskId, eventOccurrenceId, commentId = "", userId = "", keyBase, required = false, channels = null, whenText = "", priority = "", route = "" }) {
  const pol = policyFor(type);
  const chans = channels || pol.channels;              // explicit override wins
  const pri = priority || pol.priority;
  const seen = new Set();
  await Promise.all(recipients.filter(Boolean).map(async (u) => {
    if (seen.has(u.uid)) return; seen.add(u.uid);
    // A per-TYPE opt-out suppresses the whole notification (no in-app either);
    // per-CHANNEL prefs are handled downstream in deliverToUser.
    if (!required && !prefsAllow(u, type)) return;
    const id = `${keyBase}_${u.uid}`;
    // Ensure the doc + seed delivery state (idempotent), then attempt each
    // external channel INDEPENDENTLY of whether the in-app doc already existed —
    // so a crash/failure between channels is retried, not swallowed.
    const { ref } = await ensureNotification({ id, uid: u.uid, type, title, body, taskId, eventOccurrenceId, commentId, userId, channels: chans, whenText, priority: pri, route });
    await deliverToUser(ref, u);
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

/* Content-title Title Case — mirror of src/data.js formatContentTitle(). Used
   when generating notification/push/email text so titles read correctly there
   too. Keep in sync with the frontend copy. */
const TITLE_SMALL = new Set(["a","an","and","as","at","but","by","en","for","if",
  "in","nor","of","on","or","per","the","to","v","vs","via","with"]);
const TITLE_SPECIAL = { qa:"QA", csv:"CSV", ifc:"IFC", pwa:"PWA",
  instagram:"Instagram", youtube:"YouTube", ig:"IG", tiktok:"TikTok" };
function titleCaseToken(word, forceCap) {
  if (!word) return word;
  const lower = word.toLowerCase();
  const m = lower.match(/^([^a-z0-9]*)([a-z0-9](?:.*[a-z0-9])?)([^a-z0-9]*)$/);
  if (!m) return word;
  const [, pre, core, post] = m;
  if (TITLE_SPECIAL[core]) return pre + TITLE_SPECIAL[core] + post;
  if (!forceCap && TITLE_SMALL.has(core)) return pre + core + post;
  return pre + core.charAt(0).toUpperCase() + core.slice(1) + post;
}
function titleCaseWord(word, isFirst, isLast) {
  if (word.indexOf("-") === -1) return titleCaseToken(word, isFirst || isLast);
  const parts = word.split("-");
  return parts.map((p, i) => titleCaseToken(p, i === 0 || i === parts.length - 1)).join("-");
}
function formatContentTitle(title) {
  const s = (title == null ? "" : String(title)).trim();
  if (!s) return "";
  const toks = s.split(/(\s+)/);
  const wordPos = [];
  toks.forEach((t, i) => { if (/\S/.test(t)) wordPos.push(i); });
  const first = wordPos[0], last = wordPos[wordPos.length - 1];
  return toks.map((t, i) => /\S/.test(t) ? titleCaseWord(t, i === first, i === last) : t).join("");
}

module.exports = {
  db, FieldValue, Timestamp, TZ, DEFAULT_REMINDERS,
  loadUsers, loadSettings, prefsAllow, pushAllow, emailAllow, isActive, sendPush,
  writeNotification, ensureNotification, deliverToUser, notifyUsers, emailOutcome, seedDelivery,
  resolveTaskRecipients, crewRoleLabel, computeFireAt, relativeDue, localHour, localToday, formatContentTitle,
};
