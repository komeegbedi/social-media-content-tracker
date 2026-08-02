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
