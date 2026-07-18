/* ===================================================================
   Transactional email via Resend.

   Flow:  Cloud Function → Resend API → recipient.

   - The API key lives in Google Cloud Secret Manager as RESEND_API_KEY
     and is bound to each sending function via `secrets: [resendApiKey]`.
     It is never read from the frontend, env files, or Firestore, and is
     never logged.
   - Sends are idempotent: an `emailDeliveries/{notificationId}` record is
     atomically claimed (pending→processing→sent) before sending, and the
     same notificationId is passed to Resend as its idempotency key, so a
     retried trigger / duplicate instance / post-accept timeout can't send
     the same email twice.
   - Preferences and account state are re-checked here as a safety net.
   =================================================================== */
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions/v2");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { Resend } = require("resend");

// Bound to functions via `secrets: [resendApiKey]`. Exported for that binding.
const resendApiKey = defineSecret("RESEND_API_KEY");

// --- configurable senders (server-side only) ---
const SENDER = "IFC Creatives Board <notifications@ifcwpg.com>";
// Reply-to: set to a real, monitored IFC inbox when one exists (e.g. via the
// IFC_REPLY_TO function env var). Left unset → no Reply-To header (we don't
// invent an address). Keep configurable.
const REPLY_TO = process.env.IFC_REPLY_TO || "";
const APP_URL = (process.env.IFC_APP_URL || "https://ifc-social-media-tracker.web.app").replace(/\/$/, "");

// In the Functions emulator we skip real Resend calls for the automatic
// (trigger-driven) flow, so local dev + seeding never hammer the live API or
// spend quota. The admin test callable still sends for real (explicit action).
const IN_EMULATOR = process.env.FUNCTIONS_EMULATOR === "true";
const LEASE_MS = 5 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = (e) => typeof e === "string" && EMAIL_RE.test(e.trim());
const firstName = (name) => (name || "there").split(/\s+/)[0];

// --- per-type copy: subject, call-to-action label, and "why you got this" ---
const TEMPLATES = {
  assigned:         { subject: (t) => `You've been assigned: ${t}`,        cta: "Open content", why: "you were assigned to this content." },
  reminder:         { subject: (t) => `Reminder — ${t}`,                   cta: "Open content", why: "you're on this content and it's coming due." },
  overdue:          { subject: (t) => `Overdue — ${t}`,                    cta: "Open content", why: "this content is past its due date." },
  qa:               { subject: (t) => `Review requested — ${t}`,           cta: "Review now",   why: "content is ready for your review." },
  changes:          { subject: (t) => `Changes requested — ${t}`,          cta: "Open content", why: "changes were requested on your content." },
  approved:         { subject: (t) => `Approved — ${t}`,                   cta: "Open content", why: "this content was approved." },
  ready:            { subject: (t) => `Ready to post — ${t}`,              cta: "Open content", why: "this content is ready to publish." },
  mention:          { subject: (t) => `You were mentioned — ${t}`,         cta: "View comment", why: "someone mentioned you in a comment." },
  account_approved: { subject: () => `Your IFC Creatives Board account is approved`, cta: "Open the board", why: "your account was approved." },
  leadership:       { subject: (t) => `IFC Creatives Board — ${t}`,        cta: "Open the board", why: "you're an admin or department lead." },
  event:            { subject: (t) => `Upcoming — ${t}`,                   cta: "Plan content", why: "this ministry event is coming up." },
  test:             { subject: () => `IFC Creatives Board Email Test`,     cta: "Open the board", why: "an admin sent a test from the notification settings." },
};

// Inline-styled HTML (email clients need inline CSS). Branding + CTA + why-note.
function renderHtml({ title, body, recipientName, cta, url, why, whenText }) {
  const safe = (s) => String(s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  return `<!doctype html><html><body style="margin:0;background:#f4f2f8;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#211b33">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e7e3f0">
      <tr><td style="padding:18px 24px;background:#6d4aff;color:#fff;font-weight:700;font-size:15px">✦ IFC Creatives Board</td></tr>
      <tr><td style="padding:24px">
        <p style="margin:0 0 6px;font-size:15px">Hi ${safe(firstName(recipientName))},</p>
        <p style="margin:0 0 4px;font-size:17px;font-weight:700;line-height:1.35">${safe(title)}</p>
        ${body ? `<p style="margin:8px 0 0;font-size:14px;color:#4a4360;line-height:1.5">${safe(body)}</p>` : ""}
        ${whenText ? `<p style="margin:10px 0 0;font-size:13px;color:#6b6480">${safe(whenText)}</p>` : ""}
        <p style="margin:22px 0 6px"><a href="${safe(url)}" style="display:inline-block;background:#6d4aff;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:999px">${safe(cta)} →</a></p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-top:1px solid #eee;color:#8b849c;font-size:12px;line-height:1.5">
        You're receiving this because ${safe(why)}<br>
        Manage email preferences in the app under Notifications → settings.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function renderText({ title, body, recipientName, cta, url, why, whenText }) {
  return [
    `Hi ${firstName(recipientName)},`, "", title,
    body || "", whenText || "", "", `${cta}: ${url}`, "",
    `— IFC Creatives Board`, `You're receiving this because ${why}`,
  ].filter((l) => l !== "").join("\n");
}

function buildEmail({ type, title, body, recipientName, url, whenText }) {
  const tpl = TEMPLATES[type] || TEMPLATES.leadership;
  const ctx = { title, body, recipientName, cta: tpl.cta, url, why: tpl.why, whenText };
  return { subject: tpl.subject(title), html: renderHtml(ctx), text: renderText(ctx) };
}

// Resend errors: 4xx (except 429) are permanent; 429 + 5xx + network are temporary.
function isPermanent(err) {
  const code = (err && (err.statusCode || err.status)) || 0;
  if (code === 429) return false;
  return code >= 400 && code < 500;
}

// Atomically claim the delivery record. Returns "claimed" | "already-sent" | "in-progress".
async function claimDelivery(ref, meta) {
  const now = Date.now();
  return getFirestore().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) {
      tx.set(ref, { ...meta, status: "processing", attemptCount: 1, leaseUntil: now + LEASE_MS,
        createdAt: FieldValue.serverTimestamp() });
      return "claimed";
    }
    const d = s.data();
    if (d.status === "sent") return "already-sent";
    if (d.status === "processing" && d.leaseUntil && d.leaseUntil > now) return "in-progress";
    tx.update(ref, { status: "processing", attemptCount: (d.attemptCount || 0) + 1, leaseUntil: now + LEASE_MS });
    return "claimed";
  });
}

function getKey() {
  try { const k = resendApiKey.value(); return k || ""; } catch { return ""; }
}

// Digest email listing several reminders as ONE message (counts as one send).
function buildDigestEmail({ recipientName, items, url }) {
  const safe = (s) => String(s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const rows = items.map((i) => `<li style="margin:0 0 6px;font-size:14px;color:#211b33"><b>${safe(i.title)}</b> — <span style="color:#6b6480">${safe(i.dueText)}</span></li>`).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f2f8;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#211b33">
  <table role="presentation" width="100%"><tr><td align="center"><table role="presentation" width="480" style="max-width:480px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e7e3f0">
    <tr><td style="padding:18px 24px;background:#6d4aff;color:#fff;font-weight:700;font-size:15px">✦ IFC Creatives Board</td></tr>
    <tr><td style="padding:24px">
      <p style="margin:0 0 6px;font-size:15px">Hi ${safe(firstName(recipientName))},</p>
      <p style="margin:0 0 10px;font-size:16px;font-weight:700">You have ${items.length} content item${items.length !== 1 ? "s" : ""} coming due:</p>
      <ul style="margin:0 0 4px;padding-left:18px">${rows}</ul>
      <p style="margin:22px 0 6px"><a href="${safe(url)}" style="display:inline-block;background:#6d4aff;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:999px">Open My Day →</a></p>
    </td></tr>
    <tr><td style="padding:16px 24px;border-top:1px solid #eee;color:#8b849c;font-size:12px">You're receiving this because you're on this content. Manage email preferences in the app under Notifications → settings.</td></tr>
  </table></td></tr></table></body></html>`;
  const text = [`Hi ${firstName(recipientName)},`, "", `You have ${items.length} content item(s) coming due:`,
    ...items.map((i) => `• ${i.title} — ${i.dueText}`), "", `Open My Day: ${url}`, "", "— IFC Creatives Board"].join("\n");
  return { subject: `You have ${items.length} content reminder${items.length !== 1 ? "s" : ""}`, html, text };
}

/* Shared core: claim → reserve budget → send via Resend → commit outcome.
   Idempotent per notificationId. Never throws. */
async function _deliver({ notificationId, to, type, priority, subject, html, text, meta }) {
  const quota = require("./emailQuota");
  const db = getFirestore();
  if (IN_EMULATOR) { logger.debug("email skipped (emulator)", { notificationId, type }); return { status: "skipped", reason: "emulator" }; }
  const key = getKey();
  if (!key) { logger.warn("email skipped: RESEND_API_KEY not available", { notificationId }); return { status: "skipped", reason: "no-secret" }; }

  const ref = db.collection("emailDeliveries").doc(notificationId);
  let claim;
  try { claim = await claimDelivery(ref, meta); }
  catch (e) { logger.error("email claim failed", { notificationId, error: e.message }); return { status: "error", reason: "claim" }; }
  if (claim !== "claimed") return { status: claim };

  // Atomically reserve budget; suppress (in-app is unaffected) if denied.
  const period = quota.periods();
  const res = await quota.reserve({ type, priority, period });
  if (!res.allowed) {
    await ref.update({ status: "suppressed_quota_limit", suppressReason: res.reason, failedAt: FieldValue.serverTimestamp() });
    logger.warn("email suppressed by quota", { notificationId, type, reason: res.reason, usedPct: res.usedPct });
    return { status: "suppressed", reason: res.reason };
  }
  if ((res.newThresholds && res.newThresholds.length) || res.dailyAlert) {
    try { await quota.alertAdmins({ monthlyThresholds: res.newThresholds || [], daily: !!res.dailyAlert, period, usedPct: res.usedPct }); }
    catch (e) { logger.warn("quota alert failed", { error: e.message }); }
  }
  await ref.update({ usagePeriod: period.month, usageDay: period.day, reservedAt: FieldValue.serverTimestamp() });

  const payload = { from: SENDER, to, subject, html, text };
  if (REPLY_TO) payload.reply_to = REPLY_TO;
  let response;
  try { response = await new Resend(key).emails.send(payload, { idempotencyKey: notificationId }); }
  catch (e) {
    // Uncertain outcome (network/timeout): keep the reservation, leave "unknown"
    // for the reconcile job — never release/resend blindly.
    await ref.update({ status: "unknown", errorCode: "network", errorMessage: String((e && e.message) || "").slice(0, 300) });
    logger.error("email send uncertain (kept reserved)", { notificationId, error: String((e && e.message) || "").slice(0, 200) });
    return { status: "unknown" };
  }
  const { data, error } = response;
  if (error) {
    const permanent = isPermanent({ statusCode: error.statusCode });
    if (permanent) { await quota.commitFailed(period); await ref.update({ status: "failed", failedAt: FieldValue.serverTimestamp(), errorCode: String(error.statusCode || ""), errorMessage: String(error.message || "").slice(0, 300) }); }
    else { await quota.release(period); await ref.update({ status: "pending", errorCode: String(error.statusCode || ""), errorMessage: String(error.message || "").slice(0, 300) }); }
    logger.error("email send failed", { notificationId, permanent, code: error.statusCode });
    return { status: "failed", permanent };
  }
  await quota.commitSent(period);
  await ref.update({ status: "sent", providerMessageId: (data && data.id) || "", sentAt: FieldValue.serverTimestamp(), errorCode: "", errorMessage: "" });
  logger.info("email sent", { notificationId, type, providerMessageId: (data && data.id) || "" });
  return { status: "sent", providerMessageId: (data && data.id) || "" };
}

/* One notification email. Idempotent per `notificationId`. */
async function sendNotificationEmail({ user, type, title, body, taskId = "", eventId = "", url, notificationId, whenText = "", priority = "" }) {
  const to = user && user.email;
  if (!validEmail(to)) { logger.warn("email skipped: invalid recipient", { notificationId, type }); return { status: "skipped", reason: "invalid-email" }; }
  if (!(user.status === "approved" || user.role === "admin")) return { status: "skipped", reason: "inactive-user" };
  const link = url && url.startsWith("http") ? url : `${APP_URL}${url || "/"}`;
  const { subject, html, text } = buildEmail({ type, title, body, recipientName: user.name, url: link, whenText });
  const meta = { notificationId, userId: user.uid, recipientEmail: to, notificationType: type, taskId, eventId, provider: "resend", idempotencyKey: notificationId };
  return _deliver({ notificationId, to, type, priority, subject, html, text, meta });
}

/* One batched reminder digest for a user (counts as a single email). */
async function sendDigestEmail({ user, items, notificationId }) {
  const to = user && user.email;
  if (!validEmail(to)) return { status: "skipped", reason: "invalid-email" };
  if (!(user.status === "approved" || user.role === "admin")) return { status: "skipped", reason: "inactive-user" };
  if (!items || !items.length) return { status: "skipped", reason: "empty" };
  const { subject, html, text } = buildDigestEmail({ recipientName: user.name, items, url: `${APP_URL}/` });
  const meta = { notificationId, userId: user.uid, recipientEmail: to, notificationType: "reminder_digest", provider: "resend", idempotencyKey: notificationId };
  return _deliver({ notificationId, to, type: "reminder", priority: "standard", subject, html, text, meta });
}

/* Admin-only test send. Returns { messageId }. */
async function sendTest(to) {
  if (!validEmail(to)) throw new Error("invalid-recipient");
  const key = getKey();
  if (!key) throw new Error("no-secret");
  const notificationId = `test_${Date.now()}`;
  const { subject, html, text } = buildEmail({
    type: "test", title: "Your email notifications are working",
    body: "Your IFC Creatives Board email notification system is working correctly.",
    recipientName: to.split("@")[0], url: APP_URL,
  });
  const payload = { from: SENDER, to, subject, html, text };
  if (REPLY_TO) payload.reply_to = REPLY_TO;
  const resend = new Resend(key);
  const { data, error } = await resend.emails.send(payload, { idempotencyKey: notificationId });
  if (error) throw Object.assign(new Error(error.message || "Resend error"), { statusCode: error.statusCode });
  const messageId = (data && data.id) || "";
  await getFirestore().collection("emailDeliveries").doc(notificationId).set({
    notificationId, notificationType: "test", recipientEmail: to, provider: "resend",
    providerMessageId: messageId, idempotencyKey: notificationId, status: "sent",
    attemptCount: 1, createdAt: FieldValue.serverTimestamp(), sentAt: FieldValue.serverTimestamp(),
  });
  logger.info("test email sent", { messageId });
  return { messageId };
}

module.exports = { resendApiKey, SENDER, sendNotificationEmail, sendDigestEmail, sendTest, validEmail };
