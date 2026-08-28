/* Mention recipient resolution — server-side validation (pure).
   Run with: node --test functions/mentions.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveMentions } = require("./mentions");

const byUid = {
  a: { uid: "a", name: "Ada", status: "approved" },
  b: { uid: "b", name: "Bo", status: "approved" },
  pend: { uid: "pend", name: "Peg", status: "pending" },
};
// Mirrors the shared server predicate in functions/lib.js: approved-or-admin AND
// NOT disabled. (The real isActive is exercised end-to-end in the emulator suites.)
const isActive = (u) => !!u && u.disabled !== true && (u.status === "approved" || u.role === "admin");
const uids = (list) => list.map((u) => u.uid);

test("duplicate mentions collapse to one recipient", () => {
  assert.deepEqual(uids(resolveMentions(["a", "a", "b", "b"], "x", byUid, isActive)), ["a", "b"]);
});

test("a self-mention is dropped", () => {
  assert.deepEqual(uids(resolveMentions(["a", "b"], "a", byUid, isActive)), ["b"]);
});

test("unknown / removed users are dropped", () => {
  assert.deepEqual(uids(resolveMentions(["a", "ghost"], "x", byUid, isActive)), ["a"]);
});

test("unapproved (pending) users are dropped by server-side validation", () => {
  assert.deepEqual(uids(resolveMentions(["a", "pend"], "x", byUid, isActive)), ["a"]);
});

test("tolerates empty / malformed input", () => {
  assert.deepEqual(resolveMentions(undefined, "x", byUid, isActive), []);
  assert.deepEqual(resolveMentions([null, "", "a"], "x", byUid, isActive).map((u) => u.uid), ["a"]);
});

/* ---- @all / @everyone group resolution — derived from the task's assignees ---- */
const { resolveGroupMention, taskAssigneeUids } = require("./mentions");

const roster = {
  author: { uid: "author", name: "Ada", status: "approved" },
  bo: { uid: "bo", name: "Bo", status: "approved" },
  cy: { uid: "cy", name: "Cy", status: "approved" },
  pend: { uid: "pend", name: "Peg", status: "pending" },
};
const gUids = (list) => list.map((u) => u.uid).sort();

test("taskAssigneeUids: a PRESENT assigneeUids is authoritative; absent falls back to owner+support", () => {
  assert.deepEqual(taskAssigneeUids({ assigneeUids: ["a", "b", "a"] }).sort(), ["a", "b"]);
  // Absent field → derive from ownerUid + support[].uid.
  assert.deepEqual(taskAssigneeUids({ ownerUid: "o", support: [{ uid: "s1" }, { uid: "s2" }, {}] }).sort(), ["o", "s1", "s2"]);
  assert.deepEqual(taskAssigneeUids({}), []);
  // A PRESENT empty assigneeUids authorizes NOBODY — never revert to a stale owner uid.
  assert.deepEqual(taskAssigneeUids({ assigneeUids: [], ownerUid: "stale", support: [{ uid: "ghost" }] }), []);
});

test("resolveGroupMention: notifies the task's active assignees, excluding the author", () => {
  const task = { assigneeUids: ["author", "bo", "cy"] };
  assert.deepEqual(gUids(resolveGroupMention(task, "author", roster, isActive)), ["bo", "cy"]); // author dropped
});

test("resolveGroupMention: drops inactive/unapproved and unknown assignees", () => {
  const task = { assigneeUids: ["bo", "pend", "ghost"] };
  assert.deepEqual(gUids(resolveGroupMention(task, "author", roster, isActive)), ["bo"]);
});

test("resolveGroupMention: dedupes assignees; a group of >20 is unbounded (no 20-cap)", () => {
  const byUid = {}; const uids = [];
  for (let i = 0; i < 25; i++) { const id = `u${i}`; byUid[id] = { uid: id, name: `U${i}`, status: "approved" }; uids.push(id); }
  const task = { assigneeUids: [...uids, ...uids] };   // duplicated
  assert.equal(resolveGroupMention(task, "author", byUid, isActive).length, 25);
});

test("resolveGroupMention: an empty/assignee-less task notifies nobody", () => {
  assert.deepEqual(resolveGroupMention({ assigneeUids: [] }, "author", roster, isActive), []);
  assert.deepEqual(resolveGroupMention({}, "author", roster, isActive), []);
  // A PRESENT empty assigneeUids means unassigned — @all must NOT reach a stale owner.
  assert.deepEqual(resolveGroupMention({ assigneeUids: [], ownerUid: "bo", support: [{ uid: "cy" }] }, "author", roster, isActive), []);
});

/* ---- disabled users are inactive (the shared isActive fix) ---- */
const disRoster = {
  ...roster,
  dis: { uid: "dis", name: "Dana", status: "approved", disabled: true },   // approved BUT disabled
};

test("a DISABLED user is dropped from an individual mention", () => {
  assert.deepEqual(resolveMentions(["bo", "dis"], "author", disRoster, isActive).map((u) => u.uid), ["bo"]);
});

test("a DISABLED assignee is dropped from an @all group mention", () => {
  const task = { assigneeUids: ["bo", "dis", "cy"] };
  assert.deepEqual(gUids(resolveGroupMention(task, "author", disRoster, isActive)), ["bo", "cy"]);
});

test("a DISABLED user named individually AND in @all is still never a recipient", () => {
  const task = { assigneeUids: ["bo", "dis"] };
  const individual = resolveMentions(["dis"], "author", disRoster, isActive);
  const group = resolveGroupMention(task, "author", disRoster, isActive);
  const ids = new Set([...individual, ...group].map((u) => u.uid));
  assert.equal(ids.has("dis"), false);
  assert.deepEqual([...ids].sort(), ["bo"]);
});
