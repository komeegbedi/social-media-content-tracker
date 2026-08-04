/* Administrative override — pure logic (authorisation, validation, server-authored
   attribution). The transactional write is covered by the emulator rules tests
   (client forgery denied) + integration; here we prove the decision + record shape.
   Run: node --test functions/adminOverride.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  isOverrideAuthorized, validateOverrideInput, buildOverride, OVERRIDE_STATUSES,
} = require("./adminOverride");

test("override is authorised for ACTIVE ADMINS only — never QA-derived", () => {
  assert.equal(isOverrideAuthorized({ role: "admin", status: "approved" }), true);
  assert.equal(isOverrideAuthorized({ role: "admin", qa: true }), true, "Admin+QA ok (as admin)");
  assert.equal(isOverrideAuthorized({ role: "member", qa: true, status: "approved" }), false, "QA is not an admin power");
  assert.equal(isOverrideAuthorized({ role: "member", status: "approved" }), false);
  assert.equal(isOverrideAuthorized({ role: "admin", disabled: true }), false, "disabled admin denied");
  assert.equal(isOverrideAuthorized(null), false);
});

test("validateOverrideInput requires a valid status and a non-empty reason", () => {
  assert.equal(validateOverrideInput({ toStatus: "Approved", reason: "wrong reviewer" }), null);
  assert.equal(validateOverrideInput({ toStatus: "Bogus", reason: "x" }), "bad-status");
  assert.equal(validateOverrideInput({ toStatus: "Approved", reason: "" }), "no-reason");
  assert.equal(validateOverrideInput({ toStatus: "Approved", reason: "   " }), "no-reason", "whitespace-only rejected");
  assert.equal(validateOverrideInput({ toStatus: "Approved", reason: "x".repeat(2001) }), "reason-too-long");
  // Reason alone is enough for every destination EXCEPT Changes Requested.
  for (const s of OVERRIDE_STATUSES.filter((s) => s !== "Changes Requested")) {
    assert.equal(validateOverrideInput({ toStatus: s, reason: "r" }), null, `${s} valid with reason only`);
  }
});

test("validateOverrideInput: Changes Requested REQUIRES a separate requestedChanges (server-enforced)", () => {
  const base = { toStatus: "Changes Requested", reason: "outside normal QA" };
  assert.equal(validateOverrideInput(base), "no-requested-changes", "missing requestedChanges");
  assert.equal(validateOverrideInput({ ...base, requestedChanges: 42 }), "no-requested-changes", "must be a string");
  assert.equal(validateOverrideInput({ ...base, requestedChanges: "   " }), "no-requested-changes", "whitespace-only rejected");
  assert.equal(validateOverrideInput({ ...base, requestedChanges: "x".repeat(2001) }), "requested-changes-too-long");
  assert.equal(validateOverrideInput({ ...base, requestedChanges: "Tighten the hook." }), null, "valid");
  // The audit reason is still independently required.
  assert.equal(validateOverrideInput({ toStatus: "Changes Requested", reason: "", requestedChanges: "fix it" }), "no-reason");
});

test("buildOverride returns null for a no-op (same status)", () => {
  assert.equal(buildOverride({ task: { id: "t", status: "Approved" }, toStatus: "Approved", reason: "r", actorUid: "u1", actorName: "Ada", now: 5 }), null);
});

test("no-op guard: buildOverride returns null (NO records) for EVERY status → itself", () => {
  // null means the callable writes nothing — no activity entry, no audit event, no
  // updatedAt / archivedAt change — and returns failed-precondition.
  for (const s of OVERRIDE_STATUSES) {
    assert.equal(
      buildOverride({ task: { id: "t", status: s }, toStatus: s, reason: "r", requestedChanges: "rc", actorUid: "u", actorName: "A", now: 1 }),
      null, `${s} → ${s} produces no records`);
  }
  // A DIFFERENT valid destination still builds records.
  assert.notEqual(buildOverride({ task: { id: "t", status: "In Review" }, toStatus: "Approved", reason: "r", actorUid: "u", actorName: "A", now: 1 }), null);
});

test("buildOverride is an admin_override event — NOT a QA approval — with server-derived attribution", () => {
  const task = { id: "t1", title: "Reel", status: "In Review", activity: [] };
  const built = buildOverride({ task, toStatus: "Approved", reason: "  original reviewer left  ", actorUid: "admin-uid", actorName: "Ada Admin", now: 123 });
  // Activity entry
  assert.equal(built.entry.type, "admin_override", "explicitly an override, not 'approved'");
  assert.notEqual(built.entry.type, "approved");
  assert.equal(built.entry.uid, "admin-uid");
  assert.equal(built.entry.by, "Ada Admin");
  assert.equal(built.entry.cap, "admin");
  assert.equal(built.entry.from, "In Review");
  assert.equal(built.entry.to, "Approved");
  assert.equal(built.entry.reason, "original reviewer left", "reason trimmed");
  assert.equal(built.entry.at, 123);
  // Audit record
  assert.equal(built.audit.type, "admin_override");
  assert.equal(built.audit.taskId, "t1");
  assert.equal(built.audit.actorUid, "admin-uid");
  assert.equal(built.audit.actorName, "Ada Admin");
  assert.equal(built.audit.actorCap, "admin");
  assert.equal(built.audit.fromStatus, "In Review");
  assert.equal(built.audit.toStatus, "Approved");
  assert.equal(built.audit.reason, "original reviewer left");
  // No revision instructions on a non-Changes-Requested override.
  assert.equal("requestedChanges" in built.entry, false);
  assert.equal("requestedChanges" in built.audit, false);
});

test("buildOverride stores TRIMMED requestedChanges (entry + audit) ONLY for Changes Requested", () => {
  const task = { id: "t2", title: "Reel", status: "In Review", activity: [] };
  const built = buildOverride({ task, toStatus: "Changes Requested",
    reason: "  bypassing QA: reviewer OOO  ", requestedChanges: "  Shorten the opening to 3s.  ",
    actorUid: "admin-uid", actorName: "Ada Admin", now: 7 });
  assert.equal(built.entry.type, "admin_override");
  assert.equal(built.entry.to, "Changes Requested");
  assert.equal(built.entry.reason, "bypassing QA: reviewer OOO", "audit reason trimmed + separate");
  assert.equal(built.entry.requestedChanges, "Shorten the opening to 3s.", "revision instructions trimmed + separate");
  assert.equal(built.audit.requestedChanges, "Shorten the opening to 3s.");
  assert.equal(built.audit.reason, "bypassing QA: reviewer OOO");
  // The two concepts are NOT merged.
  assert.notEqual(built.entry.reason, built.entry.requestedChanges);
});

test("buildOverride OMITS requestedChanges for destinations other than Changes Requested", () => {
  const task = { id: "t3", title: "Reel", status: "In Review", activity: [] };
  // Even if a client sends requestedChanges for a non-CR destination, it isn't stored.
  const built = buildOverride({ task, toStatus: "Approved", reason: "r", requestedChanges: "ignored", actorUid: "u", actorName: "A", now: 1 });
  assert.equal("requestedChanges" in built.entry, false);
  assert.equal("requestedChanges" in built.audit, false);
});

test("archive invariant: entering Posted SETS archivedAt; leaving Posted CLEARS it", () => {
  // Entering Posted → set.
  assert.equal(buildOverride({ task: { id: "t", status: "Ready to Post" }, toStatus: "Posted", reason: "r", actorUid: "u", actorName: "A", now: 1 }).archiveOp, "set");
  // Overriding Posted → any other status → clear (un-archive).
  for (const to of ["Planned", "In Progress", "In Review", "Changes Requested", "Approved", "Ready to Post"]) {
    assert.equal(buildOverride({ task: { id: "t", status: "Posted" }, toStatus: to, reason: "r", actorUid: "u", actorName: "A", now: 1 }).archiveOp, "clear", `${to} clears archivedAt`);
  }
  // Any non-Posted destination clears, regardless of origin.
  assert.equal(buildOverride({ task: { id: "t", status: "In Review" }, toStatus: "Approved", reason: "r", actorUid: "u", actorName: "A", now: 1 }).archiveOp, "clear");
});
