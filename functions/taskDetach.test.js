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

/* ---- UID-based assignment identity maintenance (feature/assigned-team-workflow) ---- */
test("detachPatch: UNASSIGN owner clears ownerUid and drops them from assigneeUids", () => {
  const t = { owner: "Gone User", ownerUid: "gone", support: [{ name: "Bo", uid: "bo", role: "edit" }], assigneeUids: ["gone", "bo"] };
  const p = detachPatch(t, "Gone User", "unassign", null, "gone", null);
  assert.equal(p.owner, "Pending");
  assert.equal(p.ownerUid, "");
  assert.deepEqual(p.assigneeUids, ["bo"]);           // gone removed, crew kept
});

test("detachPatch: REASSIGN owner stamps the target's uid into ownerUid + assigneeUids", () => {
  const t = { owner: "Gone User", ownerUid: "gone", support: [], assigneeUids: ["gone"] };
  const p = detachPatch(t, "Gone User", "reassign", "Keep User", "gone", "keep");
  assert.equal(p.owner, "Keep User");
  assert.equal(p.ownerUid, "keep");
  assert.deepEqual(p.assigneeUids, ["keep"]);
});

test("detachPatch: removing a CREW member drops their uid from support + assigneeUids", () => {
  const t = { owner: "Al", ownerUid: "al", support: [{ name: "Gone User", uid: "gone", role: "edit" }, { name: "Bo", uid: "bo", role: "shoot" }], assigneeUids: ["al", "gone", "bo"] };
  const p = detachPatch(t, "Gone User", "unassign", null, "gone", null);
  assert.deepEqual(p.support, [{ name: "Bo", uid: "bo", role: "shoot" }]);
  assert.deepEqual(p.assigneeUids.sort(), ["al", "bo"]);
});

test("detachPatch: matches by UID even if the display name changed (rename-safe)", () => {
  const t = { owner: "New Display Name", ownerUid: "gone", support: [], assigneeUids: ["gone"] };
  const p = detachPatch(t, "Old Tombstone Name", "unassign", null, "gone", null);  // name mismatch, uid matches
  assert.ok(p, "still detached via uid");
  assert.equal(p.ownerUid, "");
});
