/* Administrative status override — an EXCEPTIONAL, audited recovery action that is
   deliberately distinct from a QA review decision.

   Admin and QA are separate capability axes: an Admin does not review content. When
   an Admin must correct the workflow (including forcing In Review → Approved), they
   use THIS callable, which:
     - authorises an ACTIVE ADMIN only (never QA-derived);
     - requires a destination status and a non-empty reason;
     - rejects a no-op (same status);
     - writes, in one transaction, the new status + an explicit `admin_override`
       activity entry + an immutable server-authored `auditEvents` record;
     - records the authenticated Admin's uid + display name, the previous and
       resulting statuses, the reason, and a SERVER timestamp.

   Client-supplied identity, timestamps, and audit fields are never trusted — they
   are read from the caller's own profile and set with the server clock. The normal
   client update path in firestore.rules denies an Admin the In Review → Approved /
   Changes Requested transition, so this is the ONLY way an Admin can reach those,
   and the history says "administratively overridden", not "QA-approved". */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { db, FieldValue } = require("./lib");

const STATUSES = ["Planned", "In Progress", "In Review", "Changes Requested",
  "Approved", "Ready to Post", "Posted"];

/* ---- pure, unit-testable pieces (no Firestore) ---- */

// Override is an ADMIN-only recovery action — never QA-derived. Active admin only.
function isOverrideAuthorized(caller) {
  return !!caller && caller.role === "admin" && caller.disabled !== true;
}

// Validate the request. Returns an error code (for the HttpsError map) or null.
function validateOverrideInput({ toStatus, reason } = {}) {
  if (!STATUSES.includes(toStatus)) return "bad-status";
  const r = String(reason || "").trim();
  if (!r) return "no-reason";
  if (r.length > 2000) return "reason-too-long";
  return null;
}

// Build the server-authored records for an override. Attribution (uid + name +
// capability) comes from the caller's own profile, NOT from client input; the
// caller passes `now` for the client-side entry timestamp while the doc-level
// updatedAt/at use the server clock. Returns null for a no-op (same status).
function buildOverride({ task, toStatus, reason, actorUid, actorName, now }) {
  const fromStatus = task.status;
  if (fromStatus === toStatus) return null;
  const r = String(reason).trim();
  const name = actorName || "Admin";
  const entry = {
    type: "admin_override", by: name, uid: actorUid, cap: "admin",
    from: fromStatus, to: toStatus, note: r, reason: r, at: now,
  };
  const audit = {
    type: "admin_override", taskId: task.id || null, title: task.title || "",
    actorUid, actorName: name, actorCap: "admin",
    fromStatus, toStatus, reason: r,
  };
  // Archive invariant, enforced on BOTH directions: Posted ⇒ set archivedAt;
  // any other destination ⇒ clear it (so overriding backward out of Posted
  // un-archives instead of leaving a stale timestamp).
  const archiveOp = toStatus === "Posted" ? "set" : "clear";
  return { fromStatus, toStatus, entry, audit, archiveOp };
}

module.exports.isOverrideAuthorized = isOverrideAuthorized;
module.exports.validateOverrideInput = validateOverrideInput;
module.exports.buildOverride = buildOverride;
module.exports.OVERRIDE_STATUSES = STATUSES;

exports.adminOverrideStatus = onCall(
  { memory: "256MiB", timeoutSeconds: 30 },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in and try again.");
    const uid = req.auth.uid;

    // Authorise: an ACTIVE ADMIN only. This is the Admin axis — never QA-derived.
    let callerSnap;
    try { callerSnap = await db.doc(`users/${uid}`).get(); }
    catch (e) {
      logger.error("adminOverrideStatus: caller lookup failed", { uid, message: String(e && e.message).slice(0, 300) });
      throw new HttpsError("unavailable", "Couldn't verify your account just now. Please try again shortly.");
    }
    const caller = callerSnap.exists ? callerSnap.data() : null;
    if (!isOverrideAuthorized(caller))
      throw new HttpsError("permission-denied", "Only admins can perform an administrative override.");

    const taskId = String((req.data && req.data.taskId) || "").trim();
    const toStatus = String((req.data && req.data.toStatus) || "").trim();
    const reason = String((req.data && req.data.reason) || "").trim();
    if (!taskId) throw new HttpsError("invalid-argument", "Missing content reference.");
    const inputErr = validateOverrideInput({ toStatus, reason });
    if (inputErr === "bad-status") throw new HttpsError("invalid-argument", "Choose a valid destination status.");
    if (inputErr === "no-reason") throw new HttpsError("invalid-argument", "A reason is required for an administrative override.");
    if (inputErr === "reason-too-long") throw new HttpsError("invalid-argument", "Reason is too long (2000 characters max).");

    const taskRef = db.doc(`tasks/${taskId}`);
    const actorName = (caller.name && String(caller.name)) || "Admin";

    let result;
    try {
      result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(taskRef);
        if (!snap.exists) throw new HttpsError("not-found", "That content no longer exists.");
        const task = { id: taskId, ...snap.data() };

        // Server-authored records — attribution from the caller's profile, never client input.
        const built = buildOverride({ task, toStatus, reason, actorUid: uid, actorName, now: Date.now() });
        if (!built) return { noop: true, fromStatus: task.status };

        const update = {
          status: toStatus,
          activity: [...(task.activity || []), built.entry],
          updatedAt: FieldValue.serverTimestamp(),           // server clock
          // Archive invariant (decided by buildOverride.archiveOp): Posted ⇒ set,
          // any other status ⇒ remove — so overriding backward out of Posted
          // un-archives the content instead of leaving a stale timestamp.
          archivedAt: built.archiveOp === "set" ? FieldValue.serverTimestamp() : FieldValue.delete(),
        };
        tx.update(taskRef, update);

        // Immutable, server-authored audit record (auditEvents denies all client writes).
        const auditRef = db.collection("auditEvents").doc();
        tx.set(auditRef, { ...built.audit, at: FieldValue.serverTimestamp() });
        return { noop: false, fromStatus: built.fromStatus, toStatus, auditId: auditRef.id };
      });
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error("adminOverrideStatus failed", { uid, taskId, message: String(e && e.message).slice(0, 300) });
      throw new HttpsError("unavailable", "Couldn't apply the override just now. Please try again.");
    }

    if (result.noop)
      throw new HttpsError("failed-precondition", `The content is already "${result.fromStatus}".`);

    // Affected-people notifications are owned by onTaskWrite, which detects the
    // admin_override activity entry and uses override-specific copy (so the action
    // is never presented as a normal QA decision) — no duplicate notification here.
    logger.info("adminOverrideStatus applied", {
      uid, taskId, from: result.fromStatus, to: result.toStatus, auditId: result.auditId,
    });
    return { ok: true, from: result.fromStatus, to: result.toStatus };
  },
);
