/* ===================================================================
   User-removal saga — durable, resumable phases.

   Firebase Auth and Firestore can't share a transaction, so removal is modelled
   as a saga: a durable operation doc (adminOps/remove_<uid>) records the last
   completed phase, and every phase is IDEMPOTENT, so a crash after any phase
   resumes safely by re-running the current phase.

     validating → disabled → tokens_cleared → [tasks_detached (4B)] → audited → done

   Removal is REVERSIBLE: the Firebase Auth account is disabled (never deleted)
   and the profile becomes a tombstone that keeps name + uid for historical
   attribution while stripping every access/operational field.
   =================================================================== */
const { FieldValue } = require("./lib");

const removalOpId = (uid) => `remove_${uid}`;

/* Pure authorization — all inputs are server-read; nothing trusts client claims.
   These two run in a deliberate order in removeUserCore: the CALLER checks always
   run, then an in-progress op is resumed regardless of tombstone state, and only
   a FRESH removal runs the TARGET checks. (Splitting them is what lets a crash-
   resumed op finish even though the target is already tombstoned.) */

// Returns an error tuple [httpsCode, message] or null.
function validateCaller({ caller, callerUid, targetUid }) {
  if (!caller || caller.role !== "admin" || caller.disabled === true)
    return ["permission-denied", "Only an active admin can remove a team member."];
  if (!targetUid) return ["invalid-argument", "No user was specified."];
  if (targetUid === callerUid) return ["failed-precondition", "You can't remove your own account."];
  return null;
}

// Returns { ok } | { alreadyRemoved } | { error: [httpsCode, message] }.
function validateTarget({ target, activeAdminCount }) {
  if (!target) return { error: ["not-found", "That team member no longer exists."] };
  if (target.status === "removed" || target.disabled === true) return { alreadyRemoved: true }; // idempotent
  if (target.role === "admin" && activeAdminCount <= 1)
    return { error: ["failed-precondition", "You can't remove the last active admin."] };
  return { ok: true };
}

// Tombstone patch: keep identity (name + uid), strip all access/operational
// fields, and delete the sensitive ones. Merged onto the existing profile.
function buildTombstonePatch(removedByUid) {
  return {
    status: "removed", disabled: true, removedBy: removedByUid || "",
    removedAt: FieldValue.serverTimestamp(),
    role: "member", skills: [], qa: false, captions: false, lead: false,
    available: false, deprioritize: false, limited: false, manualSchedule: false,
    email: FieldValue.delete(), notifPrefs: FieldValue.delete(),
  };
}

// Delete every fcmTokens doc for a user, in bounded batches (well under the 500-op
// limit). Re-running after a partial delete is safe — it just finishes the rest.
async function deleteAllTokens(db, uid) {
  const col = db.collection("users").doc(uid).collection("fcmTokens");
  for (;;) {
    const snap = await col.limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

// Immutable, server-authored audit event. create-if-absent → idempotent.
async function writeAuditEvent(db, opId, { targetUid, targetName, removedBy }) {
  try {
    await db.collection("auditEvents").doc(opId).create({
      type: "user_removed", opId, targetUid, targetName: targetName || "",
      removedBy: removedBy || "", reversible: true, at: FieldValue.serverTimestamp(),
    });
  } catch (e) { if (e.code !== 6) throw e; } // ALREADY_EXISTS → already audited
}

/* Run the saga forward from whatever phase the op doc is on. Every step is
   idempotent; `disableAuthUser` is injected (defaults wired in removeUser.js) so
   the Firestore-only emulator tests can verify Auth-disable and simulate a crash.
   `hooks.afterDisable` is a test seam for the crash-after-Auth-disable case. */
async function runRemoval({ db, opRef, targetUid, targetName, removedBy, disableAuthUser, hooks = {} }) {
  let phase = (await opRef.get()).data().phase;

  if (phase === "validating") {
    // Tombstone FIRST (denies Firestore access instantly), then disable Auth.
    await db.doc(`users/${targetUid}`).set(buildTombstonePatch(removedBy), { merge: true });
    await disableAuthUser(targetUid);
    if (hooks.afterDisable) await hooks.afterDisable();
    await opRef.update({ phase: "disabled", updatedAt: FieldValue.serverTimestamp() });
    phase = "disabled";
  }
  if (phase === "disabled") {
    await deleteAllTokens(db, targetUid);
    await opRef.update({ phase: "tokens_cleared", updatedAt: FieldValue.serverTimestamp() });
    phase = "tokens_cleared";
  }
  // NOTE: 4B inserts a "tasks_detached" phase here (chunked reassignment).
  if (phase === "tokens_cleared") {
    await writeAuditEvent(db, opRef.id, { targetUid, targetName, removedBy });
    await opRef.update({ phase: "audited", updatedAt: FieldValue.serverTimestamp() });
    phase = "audited";
  }
  if (phase === "audited") {
    await opRef.update({ phase: "done", completedAt: FieldValue.serverTimestamp() });
    phase = "done";
  }
  return phase;
}

module.exports = {
  removalOpId, validateCaller, validateTarget, buildTombstonePatch, deleteAllTokens, writeAuditEvent, runRemoval,
};
