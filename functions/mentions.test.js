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
const isActive = (u) => u && (u.status === "approved" || u.role === "admin");
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

test("taskAssigneeUids: prefers stored assigneeUids; legacy fallback to owner + support", () => {
  assert.deepEqual(taskAssigneeUids({ assigneeUids: ["a", "b", "a"] }).sort(), ["a", "b"]);
  assert.deepEqual(taskAssigneeUids({ ownerUid: "o", support: [{ uid: "s1" }, { uid: "s2" }, {}] }).sort(), ["o", "s1", "s2"]);
  assert.deepEqual(taskAssigneeUids({}), []);
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
});
