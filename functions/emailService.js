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
const { createHash } = require("crypto");

// Non-sensitive short identifier for a delivery, for correlating log stages without
// exposing the notificationId (which, while not secret, we still avoid logging raw).
const hashId = (id) => createHash("sha256").update(String(id || "")).digest("hex").slice(0, 12);

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
// Preferred name -> first name -> "there". Never a raw username/email prefix.
const firstName = (name) => {
  const n = (name || "").trim();
  if (!n || n.includes("@") || /^[a-z0-9._-]{12,}$/.test(n)) return "there";
  return n.split(/\s+/)[0];
};

// --- per-type copy: subject, call-to-action label, and "why you got this" ---
const TEMPLATES = {
  assigned:         { subject: (t) => `You've been assigned: ${t}`,        cta: "View task", why: "you were assigned to this content." },
  reminder:         { subject: (t) => `Reminder — ${t}`,                   cta: "Open My Day", why: "you're on this content and it's coming due." },
  overdue:          { subject: (t) => `Overdue — ${t}`,                    cta: "Open My Day", why: "this content is past its due date." },
  qa:               { subject: (t) => `Review requested — ${t}`,           cta: "Review now",   why: "content is ready for your review." },
  changes:          { subject: (t) => `Changes requested — ${t}`,          cta: "View changes", why: "changes were requested on your content." },
  approved:         { subject: (t) => `Approved — ${t}`,                   cta: "View task", why: "this content was approved." },
  ready:            { subject: (t) => `Ready to post — ${t}`,              cta: "View task", why: "this content is ready to publish." },
  mention:          { subject: (t) => `You were mentioned — ${t}`,         cta: "View comment", why: "someone mentioned you in a comment." },
  account_approved: { subject: () => `Your IFC Creatives Board account is approved`, cta: "Open the board", why: "your account was approved." },
  leadership:       { subject: (t) => `IFC Creatives Board — ${t}`,        cta: "Open the board", why: "you're an admin or department lead." },
  event:            { subject: (t) => `Upcoming — ${t}`,                   cta: "View event", why: "this ministry event is coming up." },
  test:             { subject: () => `IFC Creatives Board Email Test`,     cta: "Open the board", why: "an admin sent a test from the notification settings." },
};

// Inline-styled HTML (email clients need inline CSS). Branding + CTA + why-note.
function renderHtml({ title, body, recipientName, cta, url, why, whenText, context }) {
  const safe = (s) => String(s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const ctxRows = (context || []).filter(([,v])=>v).map(([k,v]) =>
    `<tr><td style="padding:3px 0;font-size:12px;color:#777187;width:90px">${safe(k)}</td><td style="padding:3px 0;font-size:13px;color:#211b32;font-weight:600">${safe(v)}</td></tr>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#f4f3f7;padding:20px 12px;font-family:Arial,Helvetica,sans-serif;color:#211b32">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e2ec">
      <tr><td style="padding:16px 28px 14px;border-bottom:3px solid #6750c8">
        <span style="font-weight:700;font-size:14px;color:#211b32;letter-spacing:.02em">IFC <span style="color:#6750c8">Creatives Board</span></span></td></tr>
      <tr><td style="padding:26px 28px 8px">
        <p style="margin:0 0 10px;font-size:15px;color:#211b32">Hi ${safe(firstName(recipientName))},</p>
        <p style="margin:0 0 6px;font-size:22px;font-weight:700;line-height:1.3;color:#211b32">${safe(title)}</p>
        ${body ? `<p style="margin:8px 0 0;font-size:15px;color:#545063;line-height:1.55">${safe(body)}</p>` : ""}
        ${whenText ? `<p style="margin:10px 0 0;font-size:13px;color:#777187">${safe(whenText)}</p>` : ""}
        ${ctxRows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 0;background:#f7f6fa;border:1px solid #e6e2ec;border-radius:10px;width:100%"><tr><td style="padding:12px 16px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%">${ctxRows}</table></td></tr></table>` : ""}
        <p style="margin:24px 0 26px"><a href="${safe(url)}" style="display:inline-block;background:#6750c8;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 26px;border-radius:10px">${safe(cta)}</a></p>
      </td></tr>
      <tr><td style="padding:14px 28px;border-top:1px solid #eee;color:#8b849c;font-size:12px;line-height:1.6">
        You're receiving this because ${safe(why)}<br>
        Manage email preferences in the app under Notifications &rarr; settings.
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

function buildEmail({ type, title, body, recipientName, url, whenText, context }) {
  const tpl = TEMPLATES[type] || TEMPLATES.leadership;
  const ctx = { title, body, recipientName, cta: tpl.cta, url, why: tpl.why, whenText, context };
  return { subject: tpl.subject(title), html: renderHtml(ctx), text: renderText(ctx) };
}

// Resend errors: 4xx (except 429) are permanent; 429 + 5xx + network are temporary.
function isPermanent(err) {
  const code = (err && (err.statusCode || err.status)) || 0;
  if (code === 429) return false;
  return code >= 400 && code < 500;
}

// Atomically claim the delivery record for an attempt. Returns
// { status: "claimed"|"sent"|"failed"|"suppressed_quota_limit"|"in-progress",
//   attemptCount, reserved }. A settled delivery (sent/failed/suppressed) is
// terminal and never re-attempted; an unsettled pending/unknown one is claimable
// (and carries its existing reservation forward via `reserved`).
async function claimDelivery(ref, meta) {
  const now = Date.now();
  return getFirestore().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) {
      tx.set(ref, { ...meta, status: "processing", attemptCount: 1, reserved: false, settled: false,
        leaseUntil: now + LEASE_MS, createdAt: FieldValue.serverTimestamp() });
      return { status: "claimed", attemptCount: 1, reserved: false };
    }
    const d = s.data();
    if (d.settled || d.status === "sent") return { status: d.status };          // terminal
    if (d.status === "processing" && d.leaseUntil && d.leaseUntil > now) return { status: "in-progress" };
    const attemptCount = (d.attemptCount || 0) + 1;
    tx.update(ref, { status: "processing", attemptCount, leaseUntil: now + LEASE_MS });
    return { status: "claimed", attemptCount, reserved: !!d.reserved };
  });
}

// Give up after this many attempts (releasing the one reservation exactly once).
const MAX_EMAIL_ATTEMPTS = 5;

// A transient/uncertain outcome: retry (keeping the single reservation) until the
// attempt cap, then give up — releasing that reservation exactly once. Returns a
// retryable status before the cap, or a terminal permanent-failure at it.
async function retryOrGiveUp(ref, quota, period, attemptCount, transientStatus, code, msg, notificationId) {
  if (attemptCount >= MAX_EMAIL_ATTEMPTS) {
    await quota.settleReservation(ref, "release", period, {
      status: "failed", errorCode: "exhausted", errorMessage: String(msg || "").slice(0, 300),
      failedAt: FieldValue.serverTimestamp(),
    });
    logger.error("email gave up after retries", { notificationId, attempts: attemptCount });
    return { status: "failed", permanent: true };
  }
  await ref.update({ status: transientStatus, errorCode: code, errorMessage: String(msg || "").slice(0, 300) });
  logger.warn("email transient — will retry", { notificationId, attempt: attemptCount, transientStatus });
  return { status: transientStatus };
}

function getKey() {
  try { const k = resendApiKey.value(); if (k) return k; } catch { /* unbound in some contexts */ }
  return process.env.RESEND_API_KEY || "";
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

/* Shared core: claim → reserve budget ONCE → send via Resend → settle outcome
   EXACTLY ONCE. Idempotent per notificationId, and safe to re-attempt: the single
   reservation is reused across retries (never re-reserved) and the same Resend
   idempotency key means a re-send never double-delivers. Never throws. */
async function _deliver({ notificationId, to, type, priority, subject, html, text, meta }) {
  const quota = require("./emailQuota");
  const db = getFirestore();
  // Skip real Resend calls in the emulator (dev/seed/tests) — EXCEPT when an
  // integration test explicitly forces the send path with a stubbed global fetch.
  if (IN_EMULATOR && process.env.EMAIL_FORCE_SEND !== "true") { logger.debug("email skipped (emulator)", { notificationId, type }); return { status: "skipped", reason: "emulator" }; }
  const key = getKey();
  if (!key) { logger.warn("email skipped: RESEND_API_KEY not available", { notificationId }); return { status: "skipped", reason: "no-secret" }; }

  const ref = db.collection("emailDeliveries").doc(notificationId);
  const period = quota.periods();
  let claim;
  try { claim = await claimDelivery(ref, meta); }
  catch (e) { logger.error("email claim failed", { notificationId, error: e.message }); return { status: "error", reason: "claim" }; }
  if (claim.status !== "claimed") {
    if (claim.status === "sent") return { status: "already-sent" };
    if (claim.status === "in-progress") return { status: "in-progress" };
    // A quota-suppressed delivery is TERMINAL — re-invoking it must consistently return
    // suppressed (never retried, never re-sent), without calling Resend.
    if (String(claim.status).startsWith("suppressed")) return { status: "suppressed", reason: claim.status };
    return { status: "failed", permanent: true };            // other already-settled terminal
  }

  // Reserve budget EXACTLY ONCE (atomic with the doc flag; a retry reuses it).
  if (!claim.reserved) {
    const res = await quota.reserve({ type, priority, period, deliveryRef: ref });
    if (!res.allowed) {
      logger.warn("email suppressed by quota", { notificationId, type, reason: res.reason, usedPct: res.usedPct });
      return { status: "suppressed", reason: res.reason };
    }
    // MONTHLY usage alerts are now driven by AUTHORITATIVE Resend account usage (see
    // resendUsage.js), not this app's internal counter — so only the app's own DAILY
    // safety-cap alert is raised from the send path here.
    if (res.dailyAlert) {
      try { await quota.alertAdmins({ monthlyThresholds: [], daily: true, period, usedPct: res.usedPct }); }
      catch (e) { logger.warn("quota daily-cap alert failed", { error: e.message }); }
    }
  }

  const payload = { from: SENDER, to, subject, html, text };
  if (REPLY_TO) payload.reply_to = REPLY_TO;
  const sent = await resendPostSend(key, payload, notificationId);
  if (sent.transport) {
    // Uncertain (network/timeout): keep the reservation and re-attempt later with
    // the SAME idempotency key (Resend dedupes → never a double-send).
    return retryOrGiveUp(ref, quota, period, claim.attemptCount, "unknown", "network", (sent.transport.message) || "", notificationId);
  }
  const { data, error } = sent;
  if (error) {
    const c = classifyProviderError(error.statusCode, error.name);
    // Provider QUOTA exhaustion (429 daily/monthly_quota_exceeded) is NOT a request-rate
    // failure: don't retry it. Release the reservation, suppress ONLY this delivery, and
    // alert. Option A (strict current-delivery-only): we deliberately do NOT write any
    // provider period exhaustion marker — Resend's reset boundary is unproven, so nothing
    // here may suppress SUBSEQUENT deliveries; a later organic send that also hits a quota
    // 429 settles the same way on its own (it is not a probe). See docs/incident-resend-usage.md.
    if (c.kind === "quota") {
      // Release the reservation (no email went out) and record a TERMINAL
      // suppressed_quota_limit status — this is quota exhaustion, not a generic failure.
      await quota.settleReservation(ref, "release", period, {
        status: "suppressed_quota_limit", failedAt: FieldValue.serverTimestamp(),
        errorCode: String(error.name || "quota_exceeded"), errorMessage: String(error.message || "").slice(0, 300),
      });
      // Operational alert only (deduped per UTC period — an application notification bucket,
      // NOT a provider reset window, and it never influences reserve() or delivery eligibility).
      if (c.scope === "daily") {
        try { await quota.alertAdmins({ monthlyThresholds: [], daily: true, period, usedPct: 100 }); } catch (e) { logger.warn("daily-quota alert failed", { error: e.message }); }
      } else {
        try { await quota.alertAdmins({ monthlyThresholds: [100], daily: false, period, usedPct: 100 }); } catch (e) { logger.warn("monthly-quota alert failed", { error: e.message }); }
      }
      logger.warn("email suppressed: resend quota exceeded", { notificationId, scope: c.scope });
      // TERMINAL suppression — NOT a failure. emailOutcome maps this to skip:true (no
      // retry) and flushDigests marks the digest done. Never retried end-to-end.
      return { status: "suppressed", reason: `${c.scope}_quota_exceeded` };
    }
    if (c.kind === "permanent") {
      await quota.settleReservation(ref, "failed", period, {
        status: "failed", failedAt: FieldValue.serverTimestamp(),
        errorCode: String(error.statusCode || ""), errorMessage: String(error.message || "").slice(0, 300),
      });
      logger.error("email send failed (permanent)", { notificationId, code: error.statusCode });
      return { status: "failed", permanent: true };
    }
    // request-rate 429 (rate_limit_exceeded) OR other transient → retry, same key.
    return retryOrGiveUp(ref, quota, period, claim.attemptCount, "pending", String(error.statusCode || ""), error.message, notificationId);
  }
  const settle = await quota.settleReservation(ref, "sent", period, {
    status: "sent", providerMessageId: (data && data.id) || "", sentAt: FieldValue.serverTimestamp(),
    errorCode: "", errorMessage: "",
  });
  // Sanitized settlement stage — pairs with the "email send stage" log via the delivery
  // hash so a stuck panel can be traced to record-failure vs settle-failure.
  logger.info("email settle stage", {
    delivery: hashId(notificationId), type, settled: !!(settle && settle.settled),
    usageRecorded: !sent.usageRecordError, usageRecordError: sent.usageRecordError || undefined,
  });
  return { status: "sent", providerMessageId: (data && data.id) || "", usageRecordError: sent.usageRecordError || null };
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

// Normalise an email for sending: trim, and lowercase the (case-insensitive)
// domain part. Rejects display-name-only values via validEmail.
function normalizeEmail(raw) {
  const s = String(raw || "").trim();
  const at = s.lastIndexOf("@");
  return at < 0 ? s : `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}`;
}

// Classify a Resend error into a stable, non-sensitive code the callable maps to
// a user-facing message. The raw provider message is logged, never returned.
const parseIntHeader = (v) => { if (v == null) return null; const s = String(v).trim(); return /^\d+$/.test(s) ? Number(s) : null; };

// The quota UNITS a payload consumes: every address across to/cc/bcc (Resend counts
// each recipient separately). Each field may be a string (one address) or an array;
// absent fields are ignored. Pure. For notification/digest/test sends this is normally 1.
function quotaUnits(payload) {
  const count = (v) => (v == null ? 0 : Array.isArray(v) ? v.filter((x) => x != null && String(x).trim()).length : (String(v).trim() ? 1 : 0));
  const p = payload || {};
  return count(p.to) + count(p.cc) + count(p.bcc);
}

// Response headers safe to log for PROVING quota semantics. We deliberately MATCH broadly
// on quota/usage/rate names (so an as-yet-unknown header that reveals the true model is
// still captured), but hard-EXCLUDE anything sensitive (auth, cookies, keys, addresses) so
// the diagnostic can never leak a secret or recipient. Pure + exported so the secrecy
// property is unit-tested. Accepts a Headers-like object (forEach(v,k)) or a plain map.
const DIAG_INCLUDE_RE = /quota|usage|used|remaining|reset|limit|rate|throttle/i;
const DIAG_EXCLUDE_RE = /authorization|cookie|token|secret|api[-_]?key|\bkey\b|signature|bearer|email|recipient|\bto\b|\bfrom\b|\bcc\b|\bbcc\b|address/i;
function pickDiagnosticHeaders(headers) {
  const out = {};
  const consider = (v, k) => {
    const key = String(k).toLowerCase();
    if (DIAG_INCLUDE_RE.test(key) && !DIAG_EXCLUDE_RE.test(key)) out[key] = String(v);
  };
  if (headers && typeof headers.forEach === "function") headers.forEach(consider);
  else if (headers && typeof headers === "object") for (const [k, v] of Object.entries(headers)) consider(v, k);
  return out;
}

const RESEND_SEND_TIMEOUT_MS = Number(process.env.RESEND_SEND_TIMEOUT_MS) || 10000;

/* THE Resend send — a raw POST /emails so we can observe response HEADERS (the SDK
   hides them). Resend returns the account quota (x-resend-monthly-quota / -daily-quota)
   on SEND, not on GET, so we record the latest "last observed" usage on any response
   that carries it — including a 429 quota-exceeded (best-effort; a failed record never
   fails the send). Hardened: AbortController timeout + explicit User-Agent, preserving
   Authorization / Content-Type / Idempotency-Key. Returns the { data, error } contract
   the callers expect; `transport` is set on a timeout/network error (uncertain → retry
   with the SAME idempotency key). `fetchImpl`/`record` are injectable for tests. */
async function resendPostSend(key, payload, idempotencyKey, { fetchImpl = globalThis.fetch, record, timeoutMs = RESEND_SEND_TIMEOUT_MS } = {}) {
  const recordUsage = record || ((obs) => require("./resendUsage").recordObservedUsage(obs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "User-Agent": "IFC-Creatives-Board/1.0",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    return { transport: e, timedOut: !!(e && e.name === "AbortError") };
  } finally { clearTimeout(timer); }

  let body = null;
  try { body = await res.json(); } catch { body = null; } // malformed / non-JSON

  // DIAGNOSTIC (server-only, non-sensitive): log the quota/limit/rate header NAMES+VALUES
  // so the true semantics can be proven from a real invocation. Never a key/recipient/body.
  try {
    const diag = pickDiagnosticHeaders(res.headers);
    logger.info("resend response headers (diagnostic)", { delivery: hashId(idempotencyKey), status: res.status, headers: diag });
  } catch { /* header iteration not supported → skip */ }

  // The quota headers are treated as PRE-SEND used values, but their semantics proved
  // unreliable (a value == plan capacity was returned) — recordObservedUsage now VALIDATES
  // before persisting. Only a SUCCESSFUL send counts; never on a rejection/timeout/uncertain.
  const monthlyUsedBeforeSend = parseIntHeader(res.headers.get("x-resend-monthly-quota"));
  const dailyUsedBeforeSend = parseIntHeader(res.headers.get("x-resend-daily-quota"));
  const headersValid = res.ok && monthlyUsedBeforeSend != null;
  const units = quotaUnits(payload);
  let usageRecordError = null;
  if (headersValid) {
    try {
      await recordUsage({ monthlyUsedBeforeSend, dailyUsedBeforeSend, acceptedUnits: units, deliveryId: idempotencyKey });
    } catch (e) {
      // A usage-recording failure AFTER a successful send must NOT be silently swallowed
      // as success — surface it (returned + logged) so a stuck panel is diagnosable.
      usageRecordError = String((e && e.code) || (e && e.name) || "record-failed").slice(0, 40);
      logger.error("email usage: observation record FAILED after successful send", { delivery: hashId(idempotencyKey), code: usageRecordError });
    }
  }
  // Sanitized stage log — no key/recipient/headers, just the accounting stages.
  logger.info("email send stage", {
    delivery: hashId(idempotencyKey), accepted: res.ok, units,
    quotaHeaders: res.ok ? (monthlyUsedBeforeSend != null ? "valid" : "missing") : "n/a",
    recorded: headersValid && !usageRecordError, recordError: usageRecordError || undefined,
  });
  const error = res.ok ? null
    : { statusCode: res.status, name: body && body.name, message: (body && body.message) || `provider ${res.status}` };
  return { ok: res.ok, status: res.status, data: res.ok ? body : null, error, usageRecordError };
}

/* Decide how to handle a provider error. 429 is NOT always a request-rate failure —
   Resend uses it for quota exhaustion too, which must NOT be retried as transient:
     daily_quota_exceeded / monthly_quota_exceeded → { kind:"quota", scope }
     rate_limit_exceeded (or unnamed 429)          → { kind:"rate-limit" }  (retry)
     4xx (non-429)                                 → { kind:"permanent" }
     5xx / other                                   → { kind:"transient" }   (retry) */
function classifyProviderError(statusCode, name) {
  const code = Number(statusCode) || 0;
  if (code === 429) {
    if (name === "daily_quota_exceeded") return { kind: "quota", scope: "daily" };
    if (name === "monthly_quota_exceeded") return { kind: "quota", scope: "monthly" };
    return { kind: "rate-limit" };
  }
  if (isPermanent({ statusCode: code })) return { kind: "permanent" };
  return { kind: "transient" };
}

function classifyResend(error) {
  const code = Number(error && (error.statusCode || error.status)) || 0;
  const msg = String((error && (error.message || error.name)) || "").toLowerCase();
  if (code === 429) return "rate-limit";
  if (code >= 500) return "temporary";
  if (/not verified|domain|forbidden|unauthor/.test(msg) || code === 403) return "unverified-sender";
  if (/invalid.*(to|recipient|email|address)|validation/.test(msg) || code === 422) return "invalid-email";
  if (code >= 400) return "provider-rejected";
  return "provider-rejected";
}
// A classified, non-sensitive error the caller can map. `.emailCode` is safe;
// `.message` (may contain provider detail) must only be logged, never returned.
function classifiedError(emailCode, message) {
  const e = new Error(message || emailCode);
  e.emailCode = emailCode;
  return e;
}

// Map a _deliver() result to the test-send outcome. A suppressed send yields the
// appropriate admin-facing quota message; success returns the provider message id.
function testOutcome(res) {
  if (res.status === "sent") return { messageId: res.providerMessageId || "" };
  if (res.status === "already-sent") return { messageId: "" };
  if (res.status === "suppressed") {
    const r = String(res.reason || "");
    if (/month|account/.test(r)) throw classifiedError("monthly-quota", r);
    if (/dai/.test(r)) throw classifiedError("daily-quota", r);
    throw classifiedError("rate-limit", r);          // priority-based quota denies (85/95%)
  }
  if (res.status === "skipped") {
    if (res.reason === "no-config") throw classifiedError("no-config", "RESEND_API_KEY not available");
    // The local emulator intentionally skips real Resend sends → nothing is sent or
    // recorded. Report it as a benign SKIP (not a failure) so the panel doesn't chase a
    // usage observation that will never arrive in dev.
    if (res.reason === "emulator") return { messageId: "", skipped: true, reason: "emulator" };
    throw classifiedError("temporary", res.reason || "skipped");
  }
  if (res.status === "failed" && res.permanent) throw classifiedError("provider-rejected", "permanent failure");
  throw classifiedError("temporary", res.status || "failed"); // pending / unknown / error / transient failed
}

/* Admin-only test send. Routes through the SAME lifecycle as every other email —
   claim → reserve → POST /emails → record post-send usage → settle sent — so a test
   counts toward the app's safety caps, respects exhausted-period markers, is idempotent,
   and updates both provider + internal usage. _deliver owns the delivery doc (no second
   record). Returns { messageId }; throws a classified `.emailCode` the caller maps. */
async function sendTest(rawTo) {
  const to = normalizeEmail(rawTo);
  if (!validEmail(to)) throw classifiedError("invalid-email", "invalid recipient");
  const notificationId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const { subject, html, text } = buildEmail({
    type: "test", title: "Your email notifications are working",
    body: "Your IFC Creatives Board email notification system is working correctly.",
    recipientName: to.split("@")[0], url: APP_URL,
  });
  const meta = { notificationId, notificationType: "test", recipientEmail: to, provider: "resend", idempotencyKey: notificationId };
  const res = await _deliver({ notificationId, to, type: "test", priority: "standard", subject, html, text, meta });
  return testOutcome(res);
}

module.exports = { resendApiKey, SENDER, sendNotificationEmail, sendDigestEmail, sendTest, validEmail, normalizeEmail, classifyResend, resendPostSend, classifyProviderError, parseIntHeader, quotaUnits, pickDiagnosticHeaders };
