/* Task detachment — pure policy validation + per-task patch.
   Run with: node --test functions/taskDetach.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validatePolicy, detachPatch } = require("./taskDetach");

const byUid = {
  keep: { uid: "keep", name: "Keep User", status: "approved" },
  off: { uid: "off", name: "Off", status: "approved", disabled: true },
};

test("validatePolicy: unassign needs no target", () => {
  assert.deepEqual(validatePolicy({ mode: "unassign" }, byUid, "gone"), { ok: true, resolvedTargetName: null });
  assert.deepEqual(validatePolicy(undefined, byUid, "gone"), { ok: true, resolvedTargetName: null }); // default
});

test("validatePolicy: reassign resolves the target's name from its uid", () => {
  assert.deepEqual(validatePolicy({ mode: "reassign", reassignToUid: "keep" }, byUid, "gone"),
    { ok: true, resolvedTargetName: "Keep User" });
});

test("validatePolicy: rejects a bad mode, a missing target, self-target, or an inactive target", () => {
  assert.equal(validatePolicy({ mode: "bogus" }, byUid, "gone").error[0], "invalid-argument");
  assert.equal(validatePolicy({ mode: "reassign", reassignToUid: "ghost" }, byUid, "gone").error[0], "invalid-argument");
  assert.equal(validatePolicy({ mode: "reassign", reassignToUid: "gone" }, byUid, "gone").error[0], "failed-precondition");
  assert.equal(validatePolicy({ mode: "reassign", reassignToUid: "off" }, byUid, "gone").error[0], "failed-precondition");
});

test("detachPatch: owner reassigned or set Pending; crew removed; uninvolved → null", () => {
  const owned = { owner: "Gone User", support: [] };
  assert.equal(detachPatch(owned, "Gone User", "reassign", "Keep User").owner, "Keep User");
  assert.equal(detachPatch(owned, "Gone User", "unassign", null).owner, "Pending");

  const crew = { owner: "Someone", support: [{ name: "Gone User", role: "shoot" }, { name: "Al", role: "edit" }] };
  const p = detachPatch(crew, "Gone User", "unassign", null);
  assert.deepEqual(p.support, [{ name: "Al", role: "edit" }]);
  assert.equal(p.owner, undefined); // not the owner → owner untouched

  assert.equal(detachPatch({ owner: "Al", support: [{ name: "Bo" }] }, "Gone User", "unassign", null), null);
});

test("detachPatch: reassign with no resolved target falls back to Pending", () => {
  assert.equal(detachPatch({ owner: "Gone User" }, "Gone User", "reassign", null).owner, "Pending");
});
