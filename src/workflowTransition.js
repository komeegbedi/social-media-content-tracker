/* Shared, SDK-agnostic workflow-transition core.
   ------------------------------------------------------------------------
   The single source of truth for what a production/QA/posting status advance
   DOES. Both callers run the SAME code, so there is no simulation drift:

     - the client (src/App.jsx `advanceTask`) runs it inside a Firebase Web SDK
       runTransaction, re-reading the task first;
     - the concurrency regression test (test/assigned-workflow.test.js) runs it
       inside a Firebase Admin SDK runTransaction against the emulator.

   `planTransition` is pure and Firebase-free: given the task's CURRENT (freshly
   re-read) state it decides idempotent / stale / links-missing / apply-this-write.
   Each caller only supplies its SDK's server-timestamp sentinel for updatedAt /
   archivedAt. Firestore's transaction retry (on write contention) re-invokes the
   whole callback, so the loser of a race re-reads the winner's committed status and
   `planTransition` returns an idempotent no-op — exactly one workflow event is ever
   appended, and no existing activity is lost. */
import { missingLinks, activityEntry, statusRequiresLinks } from "./data.js";

// Action-specific capability attribution: which authority the actor is EXERCISING
// for THIS transition — not merely what their profile could do. Recorded on the
// appended activity entry so the history reflects the true basis of each action.
//   QA decision (approve / request changes)   → 'qa'
//   Admin driving production or posting        → 'admin'
//   Captions-authorized user driving posting   → 'captions'
//   Assigned owner/crew driving production      → 'member'
// (Administrative override is server-authored elsewhere and is always 'admin'.)
export function workflowCapability(user, kind) {
  if (kind === "approved" || kind === "changes_requested") return "qa";
  if (user && user.role === "admin") return "admin";
  if ((kind === "ready" || kind === "posted") && user && user.captions === true) return "captions";
  return "member";
}

/* Decide a workflow advance against the task's CURRENT state. Returns exactly one of:
     { ok:false, reason:'gone'|'trashed'|'stale'|'links', current? }
     { ok:true, idempotent:true, current }        — already at destination: NO write
     { ok:true, update:{...}, archive:boolean }   — apply `update`; caller adds the
                                                     SDK's updatedAt (+ archivedAt when
                                                     archive) server-timestamp sentinels
   `actor` is { uid, name, cap } (cap from workflowCapability). */
export function planTransition(cur, opts = {}) {
  const { fromStatus, toStatus, kind, note, extra = {}, actor } = opts;
  if (!cur) return { ok: false, reason: "gone" };
  if (cur.deletedAt) return { ok: false, reason: "trashed" };
  // IDEMPOTENT: already at the destination (a retry, or the loser of a race that
  // re-read the winner's status) → succeed WITHOUT appending a second event.
  if (cur.status === toStatus) return { ok: true, idempotent: true, current: cur.status };
  // STALE: an unexpected current status (a competing action moved it elsewhere) →
  // report without writing, so we never advance from the wrong state.
  if (fromStatus != null && cur.status !== fromStatus) return { ok: false, reason: "stale", current: cur.status };
  const merged = { ...cur, ...extra };
  // A transition INTO a link-gated stage (In Review / Approved / Ready to Post /
  // Posted) requires the type's deliverable link(s) to be present AND valid — this
  // covers submit + resubmit, and blocks QA approval of a legacy record whose links
  // are missing or invalid. Mirrored in firestore.rules (pStatusRequiresLinks).
  if (statusRequiresLinks(toStatus) && missingLinks(merged).length) return { ok: false, reason: "links" };
  const meta = actor ? { uid: actor.uid, cap: actor.cap } : null;
  const entry = activityEntry(kind, actor && actor.name, note != null ? note : toStatus, meta);
  const update = {
    status: toStatus, ...extra,
    activity: [...(cur.activity || []), entry],
  };
  return { ok: true, update, archive: toStatus === "Posted" };
}
