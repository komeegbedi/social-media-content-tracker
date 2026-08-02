/* Durable reminder digest — pure dedupe.
   Run with: node --test functions/reminderDigest.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { dedupeDigestItems, digestId } = require("./reminderDigest");

test("digestId is per user per day", () => {
  assert.equal(digestId("u1", "2026-07-27"), "u1_2026-07-27");
});

test("dedupeDigestItems keeps one row per task (first wins), drops malformed", () => {
  const items = [
    { taskId: "a", title: "A", dueText: "due" },
    { taskId: "a", title: "A again", dueText: "due" },
    { taskId: "b", title: "B", dueText: "due" },
    { title: "no task" },
    null,
  ];
  const out = dedupeDigestItems(items);
  assert.deepEqual(out.map((i) => i.taskId), ["a", "b"]);
  assert.equal(out[0].title, "A"); // first occurrence wins
});

test("dedupeDigestItems tolerates empty/undefined", () => {
  assert.deepEqual(dedupeDigestItems(), []);
  assert.deepEqual(dedupeDigestItems([]), []);
});
