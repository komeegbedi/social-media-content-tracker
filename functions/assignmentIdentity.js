/* ===================================================================
   Assignment identity — the ONE server-side helper for "who is assigned to a
   task", shared by @all mentions, the weekly check-in, and the overdue sweep so
   they agree with each other and with the Firestore authorization boundary
   (isTaskAssignee / pIsTaskAssignee).

   UID identity is AUTHORITATIVE:
     • `assigneeUids` present as an array (even []) → those uids, and ONLY those.
       A present empty array authorizes nobody; we must NOT fall back to stale
       owner/support uids (that is the bug this module fixes).
     • `assigneeUids` genuinely ABSENT but UID identity exists → derive from
       ownerUid + support[].uid.
     • A genuinely legacy task with NO uid identity at all → the legacy fallback
       authorizes ONLY the OWNER NAME (isTaskAssignee: assigneeUids absent →
       task.owner === user.name), and only when it uniquely matches one active,
       approved, production-eligible user. Name-only SUPPORT crew are NOT authorized
       by Firestore, so they are never notified — they are logged as skipped (a
       separate UID backfill is required to make them actionable). Duplicate/unknown/
       ineligible owner names resolve to nobody — never a last-write-wins name guess.
   =================================================================== */
const { isProductionEligible } = require("./notificationPolicy");

// AUTHORITATIVE uid identity (pure). A present `assigneeUids` array wins outright —
// even when empty — so nobody is ever notified against an authoritative empty set.
function assigneeUidsFromTask(task) {
  const t = task || {};
  if (Array.isArray(t.assigneeUids)) return [...new Set(t.assigneeUids.filter(Boolean))];
  const out = [];
  if (t.ownerUid) out.push(t.ownerUid);
  (Array.isArray(t.support) ? t.support : []).forEach((s) => { if (s && s.uid) out.push(s.uid); });
  return [...new Set(out.filter(Boolean))];
}

// Does the task carry ANY uid-based assignment identity? A present `assigneeUids`
// array (even []) counts — it is authoritative and disables the name fallback.
function hasUidIdentity(task) {
  const t = task || {};
  if (Array.isArray(t.assigneeUids)) return true;
  if (t.ownerUid) return true;
  return (Array.isArray(t.support) ? t.support : []).some((s) => s && s.uid);
}

// Index the roster by display name so duplicates are detectable. Returns
// { byName: Map<name, user>, dupes: Set<name> } — a name in `dupes` is ambiguous
// and must never resolve (no last-write-wins).
function indexUsersByName(users) {
  const byName = new Map();
  const dupes = new Set();
  (users || []).forEach((u) => {
    const nm = u && typeof u.name === "string" ? u.name.trim() : "";
    if (!nm) return;
    if (byName.has(nm)) dupes.add(nm);
    else byName.set(nm, u);
  });
  return { byName, dupes };
}

// Resolve ONE legacy display name to a unique, production-eligible uid.
// Returns { uid, reason }: reason ∈ empty|ambiguous|unknown|ineligible|resolved.
function resolveLegacyName(name, nameIndex) {
  const nm = typeof name === "string" ? name.trim() : "";
  if (!nm || nm === "Pending") return { uid: null, reason: "empty" };
  if (nameIndex.dupes.has(nm)) return { uid: null, reason: "ambiguous" };
  const u = nameIndex.byName.get(nm);
  if (!u) return { uid: null, reason: "unknown" };
  if (!isProductionEligible(u)) return { uid: null, reason: "ineligible" };
  return { uid: u.uid || u.id, reason: "resolved" };
}

// PRODUCER-FACING: the production-eligible assignee uids for a task (weekly / overdue),
// matching isTaskAssignee / Firestore authorization:
//   • uid identity present → those uids, kept only when the resolved user is
//     production-eligible (drops QA, Admin+QA, pending, disabled, removed, unknown);
//   • genuinely legacy (no uid identity) → resolve ONLY the OWNER NAME to a unique,
//     production-eligible user (ambiguous/unknown/ineligible → nobody, logged).
//     Name-only SUPPORT crew are NOT authorized by the legacy fallback, so they are
//     never notified — each is logged as skipped (needs a UID backfill to act).
// `nameIndex` may be passed in (built once per sweep) or derived from byUid.
function eligibleAssigneeUids(task, { byUid = {}, nameIndex = null, logger = null, taskId = null } = {}) {
  const t = task || {};
  if (hasUidIdentity(t)) {
    return assigneeUidsFromTask(t).filter((uid) => isProductionEligible(byUid[uid]));
  }
  const idx = nameIndex || indexUsersByName(Object.values(byUid));
  const id = taskId || t.id || null;
  const out = new Set();
  // Only the OWNER name is authorized by the legacy fallback.
  const r = resolveLegacyName(t.owner, idx);
  if (r.uid) out.add(r.uid);
  else if (r.reason !== "empty" && logger && logger.warn)
    logger.warn("legacy owner name unresolved — notifying nobody", { taskId: id, name: t.owner, reason: r.reason });
  // Name-only support crew: Firestore does not authorize them → never notified.
  (Array.isArray(t.support) ? t.support : []).forEach((s) => {
    const nm = s && (typeof s === "string" ? s : s.name);
    if (nm && nm !== "Pending" && logger && logger.warn)
      logger.warn("legacy support crew not authorized by name — skipped (needs a UID backfill)", { taskId: id, name: nm });
  });
  return [...out];
}

module.exports = {
  assigneeUidsFromTask, hasUidIdentity, indexUsersByName, resolveLegacyName, eligibleAssigneeUids,
};
