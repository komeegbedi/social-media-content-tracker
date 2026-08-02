/* User-removal authorization matrix — pure.
   Run with: node --test functions/removalSaga.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { removalOpId, validateCaller, validateTarget } = require("./removalSaga");

const admin = { role: "admin", status: "approved" };
const member = { role: "member", status: "approved" };

test("removalOpId is deterministic per target (→ idempotent, resumable op)", () => {
  assert.equal(removalOpId("u9"), "remove_u9");
});

test("validateCaller: a non-admin caller is denied", () => {
  assert.equal(validateCaller({ caller: member, callerUid: "c", targetUid: "t" })[0], "permission-denied");
});

test("validateCaller: a disabled/removed admin caller is denied", () => {
  assert.equal(validateCaller({ caller: { ...admin, disabled: true }, callerUid: "c", targetUid: "t" })[0], "permission-denied");
});

test("validateCaller: self-removal is denied; an active admin removing another is allowed", () => {
  assert.equal(validateCaller({ caller: admin, callerUid: "c", targetUid: "c" })[0], "failed-precondition");
  assert.equal(validateCaller({ caller: admin, callerUid: "c", targetUid: "t" }), null);
});

test("validateTarget: removing the last active admin is denied", () => {
  assert.equal(validateTarget({ target: { ...admin }, activeAdminCount: 1 }).error[0], "failed-precondition");
  assert.deepEqual(validateTarget({ target: { ...admin }, activeAdminCount: 2 }), { ok: true });
});

test("validateTarget: an already-removed target is an idempotent success", () => {
  assert.deepEqual(validateTarget({ target: { ...member, status: "removed" }, activeAdminCount: 2 }), { alreadyRemoved: true });
  assert.deepEqual(validateTarget({ target: { ...member, disabled: true }, activeAdminCount: 2 }), { alreadyRemoved: true });
});

test("validateTarget: a missing target is not-found; a normal member is allowed", () => {
  assert.equal(validateTarget({ target: null, activeAdminCount: 2 }).error[0], "not-found");
  assert.deepEqual(validateTarget({ target: member, activeAdminCount: 2 }), { ok: true });
});
