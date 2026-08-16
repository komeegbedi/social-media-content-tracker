/* onCommentCreate Trash guard (pure). A mention only notifies when its target
   task is active — missing or trashed content produces no mention notification.
   Run: node --test functions/onCommentCreate.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { commentTargetActive } = require("./onCommentCreate");

test("commentTargetActive: active task notifies; missing/trashed does not", () => {
  assert.equal(commentTargetActive(true, { title: "Reel" }), true);            // active → notify
  assert.equal(commentTargetActive(false, null), false);                       // vanished → skip
  assert.equal(commentTargetActive(true, { title: "Reel", deletedAt: new Date() }), false); // trashed → skip
});
