/* Assignment-notification recipient resolution — by STABLE uid identity.
   ------------------------------------------------------------------------
   A task carries an owner and crew whose durable identity is a uid (ownerUid /
   support[].uid); the display name is only copy. Resolving notification
   recipients by NAME breaks in three ways this module guards against:
     - a RENAME looks like a new assignment (name changed) → a spurious "you've
       been assigned" notification, and the *new* name might resolve to nobody;
     - a DUPLICATE display name resolves to whichever user last won byName →
       the WRONG person is notified;
     - a same-name REPLACEMENT (user A → user B sharing a display name) looks
       unchanged by name → user B's legitimate assignment is suppressed.
   So we resolve uid-first: a slot with a uid is authoritative (no name fallback);
   a name is consulted ONLY for a genuinely legacy slot that never had a uid, AND
   only when that name belongs to EXACTLY ONE user (an ambiguous legacy name
   notifies nobody and is reported). */

// Names shared by two or more users — an ambiguous legacy name must resolve to
// NOBODY, never to byName's last-writer-wins entry. Derived from the FULL list.
function deriveDupeNames(list) {
  const seen = new Set(), dupes = new Set();
  (list || []).forEach((u) => {
    const n = u && u.name;
    if (!n) return;
    if (seen.has(n)) dupes.add(n); else seen.add(n);
  });
  return dupes;
}

// uid present → uid is authoritative (no name fallback, so a rename or a duplicate
// name can't misdirect). uid absent → legacy slot: resolve by name ONLY when that
// name is unique across the whole roster; a duplicated/ambiguous name → null.
function resolveByIdentity(uid, name, byUid = {}, byName = {}, dupeNames = null) {
  if (uid) return byUid[uid] || null;
  if (!name) return null;
  if (dupeNames && dupeNames.has(name)) return null;   // ambiguous legacy name → nobody
  return byName[name] || null;
}

/* Pure: the users who become NEWLY assigned by this write (owner lead + added
   crew), each as { user, kind: "owner"|"crew", crew? }. Detection is uid-based
   with a strict legacy name fallback, so a pure rename yields no recipients and a
   same-name replacement is still detected. Unresolvable legacy names (ambiguous or
   unknown) notify nobody and are reported via deps.onUnresolved(info). */
function assignmentRecipients(before, after, deps = {}) {
  const byUid = deps.byUid || {};
  const byName = deps.byName || {};
  // A caller may pass an explicit dupeNames set; otherwise derive it from the full
  // user list so we never trust byName's collapsed (last-writer-wins) entry.
  const dupeNames = deps.dupeNames || deriveDupeNames(deps.list);
  const report = typeof deps.onUnresolved === "function" ? deps.onUnresolved : () => {};
  const out = [];
  const b = before || {};
  const a = after || {};

  // Owner: notify only on a genuine (re)assignment. Prefer uid-change detection;
  // fall back to name-change only for legacy tasks that never had an ownerUid.
  const hadOwnerUid = !!a.ownerUid || !!b.ownerUid;
  const ownerAssigned = hadOwnerUid
    ? (!!a.ownerUid && a.ownerUid !== b.ownerUid)
    : (!!a.owner && a.owner !== "Pending" && a.owner !== b.owner);
  if (ownerAssigned && a.owner !== "Pending") {
    const u = resolveByIdentity(a.ownerUid, a.owner, byUid, byName, dupeNames);
    if (u) out.push({ user: u, kind: "owner" });
    else if (!a.ownerUid && a.owner) report({ kind: "owner", name: a.owner, reason: dupeNames.has(a.owner) ? "duplicate-name" : "no-match" });
  }

  // Crew "newness":
  //   - a slot WITH a uid is new unless that uid was already present, OR its name
  //     matched a previous LEGACY (no-uid) slot — the backfill/stamping case, not a
  //     new assignment. A same-name REPLACEMENT (old slot HAD a uid) is therefore
  //     still detected as new, because the old name is not in the legacy-name set.
  //   - a legacy slot WITHOUT a uid is new unless its name was present before.
  const beforeUids = new Set((b.support || []).map((s) => s && s.uid).filter(Boolean));
  const beforeLegacyNames = new Set((b.support || []).filter((s) => s && !s.uid && s.name).map((s) => s.name));
  const beforeAllNames = new Set((b.support || []).map((s) => s && s.name).filter(Boolean));
  for (const s of (a.support || [])) {
    if (!s || s.name === "Pending") continue;
    const wasThere = s.uid
      ? (beforeUids.has(s.uid) || (s.name && beforeLegacyNames.has(s.name)))
      : (!!s.name && beforeAllNames.has(s.name));
    if (wasThere) continue;
    const u = resolveByIdentity(s.uid, s.name, byUid, byName, dupeNames);
    if (u) out.push({ user: u, kind: "crew", crew: s });
    else if (!s.uid && s.name) report({ kind: "crew", name: s.name, reason: dupeNames.has(s.name) ? "duplicate-name" : "no-match" });
  }
  return out;
}

module.exports = { assignmentRecipients, resolveByIdentity, deriveDupeNames };
