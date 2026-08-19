/* ===================================================================
   Mention recipient resolution (pure) — server-side validation.

   The client sends a list of mentioned UIDs, but the trigger NEVER trusts it
   blindly: a mention only notifies a real, APPROVED, active user; the comment
   author is never self-notified; and duplicates collapse to one. UID is the
   authoritative identity (display names are only for the copy).
   =================================================================== */

// mentions: string[] of uids (client-supplied). selfUid: the author. byUid: the
// user directory. isActive(user): approval predicate. Returns the validated,
// deduped, self-excluded recipient user objects.
function resolveMentions(mentions, selfUid, byUid, isActive) {
  const seen = new Set();
  const out = [];
  for (const uid of Array.isArray(mentions) ? mentions : []) {
    if (!uid || uid === selfUid || seen.has(uid)) continue;
    seen.add(uid);
    const u = byUid && byUid[uid];
    if (u && (!isActive || isActive(u))) out.push(u); // unknown / removed / unapproved → dropped
  }
  return out;
}

// A task's AUTHORITATIVE assignee uids, derived SERVER-SIDE from the task document —
// never from a client-supplied expansion. Prefers the stored assigneeUids set (what
// the security rules read); falls back to ownerUid + support[].uid only for a legacy
// task that predates the field. Mirrors taskAssigneeUids() in src/data.js.
function taskAssigneeUids(taskData) {
  const t = taskData || {};
  const stored = Array.isArray(t.assigneeUids) ? t.assigneeUids.filter(Boolean) : [];
  if (stored.length) return [...new Set(stored)];
  const out = [];
  if (t.ownerUid) out.push(t.ownerUid);
  (Array.isArray(t.support) ? t.support : []).forEach((s) => { if (s && s.uid) out.push(s.uid); });
  return [...new Set(out.filter(Boolean))];
}

// Recipients of an @all / @everyone group mention: everyone ASSIGNED to this task,
// resolved from the task doc's assignee uids and run through the same validation as
// individual mentions (real, active, approved; author excluded; deduped). BOTH
// aliases map here — never to the whole application's user base.
function resolveGroupMention(taskData, selfUid, byUid, isActive) {
  return resolveMentions(taskAssigneeUids(taskData), selfUid, byUid, isActive);
}

module.exports = { resolveMentions, resolveGroupMention, taskAssigneeUids };
