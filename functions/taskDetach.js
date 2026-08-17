/* ===================================================================
   Task detachment for user removal — the tasks_detached saga phase.

   Legacy model note: tasks reference people by DISPLAY NAME (task.owner is a
   name; task.support is [{name,...}]). There are no owner uids yet (the ownerUid
   migration is roadmapped), so detachment matches on the removed user's name —
   preserved on the tombstone precisely so this still resolves. When stable uids
   land on tasks, this switches to uid matching.

   Posted tasks are HISTORY and are never touched — the removed user stays in the
   record of what shipped. Only active staffing is changed.

   Writes are processed in bounded, resumable chunks (<= ~400 tasks + the cursor,
   well under Firestore's 500-op limit), with the cursor advanced ATOMICALLY with
   each chunk's writes, so a crash between chunks resumes with no duplicate effect.
   =================================================================== */
const { FieldValue } = require("./lib");

/* Pure policy validation. policy = { mode:"reassign"|"unassign", reassignToUid? }.
   Returns { ok, resolvedTargetName } | { error:[httpsCode,message] }. Absent →
   the safe default (unassign). Server-resolves the reassignment target's NAME
   (the legacy task key) from its uid, and refuses an inactive/removed target. */
function validatePolicy(policy, byUid, removedUid) {
  const mode = (policy && policy.mode) || "unassign";
  if (mode !== "reassign" && mode !== "unassign")
    return { error: ["invalid-argument", "Choose whether to reassign or unassign this person's active work."] };
  if (mode === "unassign") return { ok: true, resolvedTargetName: null };
  const uid = policy && policy.reassignToUid;
  if (!uid) return { error: ["invalid-argument", "The person to reassign work to wasn't found."] };
  if (uid === removedUid) return { error: ["failed-precondition", "You can't reassign work to the person being removed."] };
  const u = byUid ? byUid[uid] : null;
  if (!u) return { error: ["invalid-argument", "The person to reassign work to wasn't found."] };
  if (u.disabled === true || !(u.status === "approved" || u.role === "admin"))
    return { error: ["failed-precondition", "You can only reassign work to an active team member."] };
  return { ok: true, resolvedTargetName: u.name || "" };
}

/* Pure per-task patch. Returns null when the user isn't on the task (→ idempotent
   no-op on a re-run). Owner → reassigned or set Pending; crew → removed. Never
   called for Posted tasks. Matches by UID when available (rename-safe) AND legacy
   name, and MAINTAINS the stable identity fields: ownerUid + the authoritative
   assigneeUids set (so a removed user's uid is dropped and a reassignment target's
   uid is added — keeping production access correct after removal/reassignment). */
function detachPatch(task, userName, mode, resolvedTargetName, removedUid, resolvedTargetUid) {
  const support = Array.isArray(task.support) ? task.support : [];
  const matches = (val, uid) => val === userName || (!!removedUid && uid === removedUid);
  const isOwner = matches(task.owner, task.ownerUid);
  const crewHas = support.some((s) => s && matches(s.name, s.uid));
  if (!isOwner && !crewHas) return null;
  const patch = {};
  let ownerUid = task.ownerUid || "";
  let newSupport = support;
  if (isOwner) {
    if (mode === "reassign") { patch.owner = resolvedTargetName || "Pending"; ownerUid = resolvedTargetUid || ""; }
    else { patch.owner = "Pending"; ownerUid = ""; }
    patch.ownerSuggested = "";
    patch.ownerUid = ownerUid;
  }
  if (crewHas) {
    newSupport = support.filter((s) => s && !matches(s.name, s.uid));
    patch.support = newSupport;
  }
  patch.assigneeUids = [...new Set([ownerUid, ...newSupport.map((s) => s && s.uid)].filter(Boolean))];
  return patch;
}

/* Chunked, resumable detach. Cursor is persisted on the op doc and advanced in the
   same batch as the chunk's task writes. `hooks.afterChunk` is a test seam for the
   crash-between-chunks case. */
async function detachTasks({ db, opRef, userName, mode, resolvedTargetName, removedUid, resolvedTargetUid, page = 400, hooks = {} }) {
  let cursor = (await opRef.get()).data().taskCursor || null;
  for (;;) {
    let q = db.collection("tasks").orderBy("__name__").limit(page);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    const batch = db.batch();
    for (const doc of snap.docs) {
      const t = doc.data();
      if (t.status === "Posted") continue;              // history — never touched
      // A trashed task is inactive and its data is preserved AS-IS while in Trash —
      // detachment leaves its owner/crew untouched. Consequence (documented): if the
      // content is later RESTORED after this user was removed, it re-enters active
      // views still showing the removed (disabled) person; the admin then reassigns
      // it through the normal owner/crew flow, exactly like any restored content.
      if (t.deletedAt) continue;
      const patch = detachPatch(t, userName, mode, resolvedTargetName, removedUid, resolvedTargetUid);
      if (patch) { patch.updatedAt = FieldValue.serverTimestamp(); batch.update(doc.ref, patch); }
    }
    cursor = snap.docs[snap.docs.length - 1].id;
    batch.update(opRef, { taskCursor: cursor, updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();                                // writes + cursor advance are atomic
    if (hooks.afterChunk) await hooks.afterChunk();
    if (snap.size < page) break;                         // last page
  }
}

module.exports = { validatePolicy, detachPatch, detachTasks };
