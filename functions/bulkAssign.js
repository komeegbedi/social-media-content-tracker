/* ===================================================================
   Bulk crew assignment — trusted backend, validated, chunked, resumable.

   The client used to fan out an UNBOUNDED Promise.all of task writes for
   "auto-assign crew to all empty tasks" — no validation, no resumability, no
   progress, and a partial failure looked like success. This moves the write
   orchestration to the backend: the whole request is validated server-side, then
   applied in bounded resumable chunks under a durable op doc that tracks a cursor,
   an applied count, and per-item failures.

   (The auto-assign heuristic itself stays client-side — it's a suggestion, not a
   security boundary — but every suggested assignment is validated here before it
   touches a task.)
   =================================================================== */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { db, FieldValue, loadUsers } = require("./lib");

const MAX_ASSIGNMENTS = 1000;
const CHUNK = 300;

// Authoritative assignee uid set = owner uid + every crew member's uid (deduped,
// non-empty). Mirrors computeAssigneeUids() in src/data.js and the rules.
function assigneeUidsFrom(ownerUid, support) {
  const uids = [ownerUid, ...(Array.isArray(support) ? support : []).map((s) => s && s.uid)];
  return [...new Set(uids.filter(Boolean))];
}
exports.assigneeUidsFrom = assigneeUidsFrom;
const VALID_ROLES = new Set(["shoot", "edit", "coordinate", "design", "shadow", "other"]);
const isActive = (u) => u && (u.status === "approved" || u.role === "admin") && u.disabled !== true;

/* Pure: split a request into valid assignments + explicit failures. Every crew
   member must be an active, non-QA (staffable), UNAMBIGUOUS user; every role must
   be known. The stored crew identity is REBUILT from the server-resolved user —
   the client's `uid` is never trusted, so a request that pairs a valid person's
   NAME with a foreign uid can't authorize that uid. `dupeNames` (names shared by
   two+ users) are rejected so an ambiguous name never resolves to the wrong person. */
function validateAssignments(assignments, byName, opts = {}) {
  const validRoles = opts.validRoles || VALID_ROLES;
  const dupeNames = opts.dupeNames || new Set();
  const valid = [];
  const failures = [];
  for (const a of Array.isArray(assignments) ? assignments : []) {
    if (!a || typeof a.taskId !== "string" || !Array.isArray(a.support)) {
      failures.push({ taskId: (a && a.taskId) || null, reason: "malformed" });
      continue;
    }
    let bad = null;
    const support = [];   // rebuilt server-side; client-supplied uids are discarded
    for (const s of a.support) {
      if (!s || !validRoles.has(s.role)) { bad = "invalid-role"; break; }
      if (typeof s.name !== "string" || !s.name) { bad = "invalid-assignee"; break; }
      if (dupeNames.has(s.name)) { bad = "ambiguous-name"; break; }
      const u = byName[s.name];
      if (!isActive(u)) { bad = "invalid-assignee"; break; }
      if (u.qa === true) { bad = "qa-not-staffable"; break; }
      // Trust ONLY the server-resolved identity — this is the security boundary.
      const entry = { name: u.name, uid: u.uid, role: s.role };
      if (s.role === "other" && typeof s.label === "string" && s.label) entry.label = s.label;
      support.push(entry);
    }
    if (bad) failures.push({ taskId: a.taskId, reason: bad });
    else valid.push({ taskId: a.taskId, support });
  }
  return { valid, failures };
}

/* Apply the op's valid assignments in bounded, resumable chunks. Re-applying a
   chunk is idempotent (it sets the same support), so a crash before the cursor
   advances is safe. A missing task is recorded as a per-item failure, never a
   thrown batch. `hooks.afterChunk` is a test seam. */
async function applyBulkAssign({ database, opRef, page = CHUNK, hooks = {} }) {
  for (;;) {
    const op = (await opRef.get()).data();
    const assignments = op.assignments || [];
    const cursor = op.cursor || 0;
    if (cursor >= assignments.length) break;
    const slice = assignments.slice(cursor, cursor + page);
    const results = await Promise.all(slice.map(async (a) => {
      try {
        // Re-read the task INSIDE the write transaction, immediately before the
        // update: a task trashed (or deleted) since validation must be skipped, not
        // mutated. The skip is an explicit per-item failure so the op stays honest
        // and continues applying the rest.
        const skip = await database.runTransaction(async (tx) => {
          const ref = database.collection("tasks").doc(a.taskId);
          const snap = await tx.get(ref);
          if (!snap.exists) return "missing";
          const cur = snap.data();
          if (cur.deletedAt) return "trashed";
          // Maintain the authoritative uid set alongside support so crew keep their
          // production access after an auto/bulk (re)assignment.
          tx.update(ref, {
            support: a.support,
            assigneeUids: assigneeUidsFrom(cur.ownerUid, a.support),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return null;
        });
        return skip ? { ok: false, taskId: a.taskId, reason: skip } : { ok: true };
      } catch (e) { return { ok: false, taskId: a.taskId, reason: (e && e.code) || "update-failed" }; }
    }));
    const applied = results.filter((r) => r.ok).length;
    const failures = results.filter((r) => !r.ok).map((r) => ({ taskId: r.taskId, reason: r.reason }));
    await opRef.update({
      cursor: cursor + slice.length,
      appliedCount: (op.appliedCount || 0) + applied,
      failures: [...(op.failures || []), ...failures].slice(0, 200),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (hooks.afterChunk) await hooks.afterChunk();
    if (slice.length < page) break;
  }
}

/* Testable core. Admin-only; validates the entire request server-side; creates or
   resumes the op; returns an op id + explicit progress/failure. */
async function bulkAssignCore({ database, callerUid, opId, assignments, deps = {} }) {
  const callerSnap = await database.doc(`users/${callerUid}`).get();
  const caller = callerSnap.exists ? callerSnap.data() : null;
  if (!caller || caller.role !== "admin" || caller.disabled === true)
    throw new HttpsError("permission-denied", "Only an active admin can bulk-assign crew.");
  if (!Array.isArray(assignments))
    throw new HttpsError("invalid-argument", "No assignments were provided.");
  if (assignments.length > MAX_ASSIGNMENTS)
    throw new HttpsError("invalid-argument", `Too many assignments (max ${MAX_ASSIGNMENTS}).`);

  const opRef = database.collection("adminOps").doc(`bulk_${opId}`);
  const existing = await opRef.get();
  if (existing.exists && existing.data().phase === "done") {
    const d = existing.data();
    return { opId: opRef.id, total: d.total, applied: d.appliedCount || 0, failed: (d.failures || []).length, failures: d.failures || [], phase: "done", alreadyDone: true };
  }
  if (!existing.exists) {
    const { byName, list } = await loadUsers();
    // Names shared by two+ users are ambiguous — reject them rather than let
    // byName's last-writer-wins silently resolve to the wrong person.
    const seen = new Set(), dupeNames = new Set();
    (list || []).forEach((u) => { if (!u || !u.name) return; if (seen.has(u.name)) dupeNames.add(u.name); else seen.add(u.name); });
    const { valid, failures } = validateAssignments(assignments, byName, { dupeNames });
    await opRef.create({
      type: "bulk_assign", requestedBy: callerUid, assignments: valid,
      cursor: 0, appliedCount: 0, failures, total: valid.length, requested: assignments.length,
      phase: "applying", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
  }

  await applyBulkAssign({ database, opRef, page: deps.page, hooks: deps.hooks || {} });
  await opRef.update({ phase: "done", completedAt: FieldValue.serverTimestamp() });

  const d = (await opRef.get()).data();
  return { opId: opRef.id, total: d.total, applied: d.appliedCount || 0, failed: (d.failures || []).length, failures: d.failures || [], phase: "done" };
}

exports.bulkAssign = onCall({ memory: "256MiB", timeoutSeconds: 300 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in and try again.");
  const opId = String((req.data && req.data.opId) || "").slice(0, 80) || `${Date.now()}`;
  const assignments = (req.data && req.data.assignments) || [];
  try {
    return await bulkAssignCore({ database: db, callerUid: req.auth.uid, opId, assignments });
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error("bulkAssign failed", { message: String((e && e.message) || e).slice(0, 300) });
    throw new HttpsError("internal", "Couldn't complete the bulk assignment. The error has been logged.");
  }
});

exports.bulkAssignCore = bulkAssignCore;   // for tests
exports.validateAssignments = validateAssignments;
