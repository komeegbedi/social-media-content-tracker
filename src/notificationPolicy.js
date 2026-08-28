/* ===================================================================
   Notification eligibility — the single source of truth for WHICH per-type
   preferences apply to a user, derived from OVERLAPPING capabilities (not three
   hard-coded role lists). Mirrored, byte-for-byte in logic, by
   functions/notificationPolicy.js (a drift test asserts they never diverge), so
   the settings UI and the delivery system cannot disagree about who a given
   notification type is for.

   Capabilities (a user may hold several at once):
     - admin      : role === "admin" (application administration)
     - qa         : qa === true (review authority; a SEPARATE department)
     - captions   : captions === true (captions / upload / posting)
     - lead       : lead === true (department leadership)
     - production : approved + active + qa !== true (owner/crew eligible)

   QA is never production — this holds even for an Admin+QA account.
   =================================================================== */

// ---- capability atoms (kept inline so the backend mirror is trivial) ----
const active = (u) => !!u && u.disabled !== true;
const approved = (u) => !!u && (u.status === "approved" || u.role === "admin");
const eligible = (u) => active(u) && approved(u);                 // an active, approved account
const isQa = (u) => eligible(u) && u.qa === true;
const isAdmin = (u) => !!u && u.role === "admin" && active(u);
const isProduction = (u) => eligible(u) && u.qa !== true;         // owner/crew eligible (never QA)
const hasCaptions = (u) => isProduction(u) && u.captions === true; // posting is a production-side capability
const isLead = (u) => !!u && u.lead === true;

// type -> predicate(user): does this notification TYPE apply to the user (i.e. can a
// notification of this type ever be delivered to them, so its preference is relevant)?
export const NOTIF_APPLIES = {
  // Production work — owner/crew only (QA excluded, even Admin+QA).
  assigned:        isProduction,
  reminder:        isProduction,
  overdue:         isProduction,   // production work you're responsible for passing its due date
  changes:         isProduction,
  approved:        isProduction,
  weeklyTaskCheck: isProduction,
  // Review — QA capability only.
  qa:              isQa,
  // Publishing — captions capability only (an admin needs captions === true too).
  ready:           hasCaptions,
  // Leadership follow-up — leads or admins.
  leadership:      (u) => eligible(u) && (isLead(u) || isAdmin(u)),
  // Mentions — anyone who can be @mentioned (any active, approved account).
  mention:         eligible,
};

// Required / internal types: ALWAYS sent (bypass the user's per-type opt-out) but
// they still enforce account eligibility AND the recipient's capability. Every new
// producer MUST register its type here or in NOTIF_APPLIES — an unregistered type is
// never eligible, so delivery fails safe and forces the policy to be declared.
export const REQUIRED_APPLIES = {
  account_approved:      eligible,   // the just-approved account itself
  account_pending:       isAdmin,    // admins are alerted when someone needs approval
  admin_override:        eligible,   // the owner + admins on an audited override
  review_info:           isAdmin,    // admins' informational review copy
  admin_delivery_health: isAdmin,    // active admins only — email/notification delivery problems
};

// Catalogs.
export const USER_CONTROLLABLE_TYPES = Object.keys(NOTIF_APPLIES);
export const REQUIRED_TYPES = Object.keys(REQUIRED_APPLIES);
export function isKnownNotifType(type) { return !!(NOTIF_APPLIES[type] || REQUIRED_APPLIES[type]); }
export function isControllableType(type) { return !!NOTIF_APPLIES[type]; }

// THE authoritative delivery gate: may a notification of `type` be delivered to
// `user`? Enforces account eligibility (active + approved) for EVERY type and the
// per-type recipient capability. An UNKNOWN type is never eligible (fail safe).
export function recipientEligible(type, user) {
  if (!eligible(user)) return false;                        // pending / removed / disabled → never
  if (NOTIF_APPLIES[type]) return !!NOTIF_APPLIES[type](user);
  if (REQUIRED_APPLIES[type]) return !!REQUIRED_APPLIES[type](user);
  return false;
}

// Does a per-type preference apply to this user?
export function notifTypeApplies(type, user) {
  const p = NOTIF_APPLIES[type];
  return p ? !!p(user) : false;
}

// The ordered list of preference keys a user can meaningfully control.
export function applicableNotifTypes(user) {
  return Object.keys(NOTIF_APPLIES).filter((t) => notifTypeApplies(t, user));
}

// Required (always-on) messages the user receives regardless of preferences — shown
// as clearly-labelled, locked notices in the UI, never as a toggle.
//   account_approved      : your account lifecycle (one-time)
//   account_pending       : admins are alerted when someone needs approval
//   admin_delivery_health : admins are always alerted about delivery problems
export function requiredNotices(user) {
  const out = [];
  if (eligible(user)) out.push("account_approved");
  if (isAdmin(user)) out.push("account_pending", "admin_delivery_health");
  return out;
}

// Capability snapshot (handy for tests / debugging).
export function capabilitiesOf(user) {
  return { active: active(user), approved: approved(user), production: isProduction(user),
    qa: isQa(user), admin: isAdmin(user), captions: hasCaptions(user), lead: isLead(user) };
}

/* ---- pure preference DATA + helpers (moved here so they're node-testable and
   share the same module as the eligibility policy; re-exported by notifications.js
   for the app, which also carries the React/Firebase-bound icons + hooks). ---- */

// Grouped sections for the settings UI. Only the types that APPLY to the viewer
// (applicableNotifTypes) render under each; empty sections are hidden.
export const NOTIF_SECTIONS = [
  { id: "work",       label: "Work" },
  { id: "review",     label: "Review" },
  { id: "publishing", label: "Publishing" },
  { id: "leadership", label: "Leadership" },
  { id: "general",    label: "General" },
];

// The per-type toggles, each with a section + a short WHO/WHEN description. Which
// show for a given user is decided by applicableNotifTypes (capability-based), NOT
// this list. Required messages (account_approved + security) are shown separately
// as locked notices. ("overdue" was removed — no producer emits it.)
export const PREF_TYPES = [
  { key: "assigned",        section: "work",       label: "Assigned to content",        desc: "When you're made owner or crew on a piece." },
  { key: "reminder",        section: "work",       label: "Due-date reminders",         desc: "Upcoming shoot / post dates on your work." },
  { key: "overdue",         section: "work",       label: "Overdue tasks",              desc: "When production work you're responsible for passes its due date." },
  { key: "changes",         section: "work",       label: "Changes requested",          desc: "When QA sends your content back for edits." },
  { key: "approved",        section: "work",       label: "Content approved",           desc: "When QA approves a piece you own." },
  { key: "weeklyTaskCheck", section: "work",       label: "Weekly production check-in",  desc: "A Saturday reminder to review your upcoming production work." },
  { key: "qa",              section: "review",     label: "Review requests",            desc: "When content is submitted for your QA review." },
  { key: "ready",           section: "publishing", label: "Ready to post",              desc: "When approved content is ready for captions / upload." },
  { key: "leadership",      section: "leadership", label: "Leadership alerts",          desc: "A periodic digest of team items needing follow-up." },
  { key: "mention",         section: "general",    label: "Mentions",                   desc: "When someone @mentions you in a discussion." },
];

// Defaults for users who haven't set preferences yet: everything on.
export function defaultPrefs() {
  const perType = {};
  PREF_TYPES.forEach((t) => { perType[t.key] = true; });
  return { push: true, email: true, perType };
}

// Merge a user's saved prefs over the defaults (missing = default on). PRESERVES any
// stored keys not in the current PREF_TYPES (e.g. a legacy 'overdue', or a type not
// applicable to the user right now) so a capability change never resets a choice.
export function effectivePrefs(user) {
  const d = defaultPrefs();
  const p = (user && user.notifPrefs) || {};
  return {
    push: p.push !== undefined ? p.push : d.push,
    email: p.email !== undefined ? p.email : d.email,
    perType: { ...d.perType, ...(p.perType || {}) },
  };
}
