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

module.exports = { resolveMentions };
