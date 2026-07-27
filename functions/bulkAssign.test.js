/* Bulk assignment — pure request validation.
   Run with: node --test functions/bulkAssign.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateAssignments } = require("./bulkAssign");

const byName = {
  "Bo Crew": { name: "Bo Crew", status: "approved" },
  "Quinn QA": { name: "Quinn QA", status: "approved", qa: true },
  "Ex User": { name: "Ex User", status: "removed", disabled: true },
};

test("valid assignments pass; each invalid one is an explicit, reasoned failure", () => {
  const { valid, failures } = validateAssignments([
    { taskId: "t1", support: [{ name: "Bo Crew", role: "shoot" }] },     // ok
    { taskId: "t2", support: [{ name: "Bo Crew", role: "bogus" }] },     // bad role
    { taskId: "t3", support: [{ name: "Ghost", role: "edit" }] },        // unknown assignee
    { taskId: "t4", support: [{ name: "Ex User", role: "edit" }] },      // removed assignee
    { taskId: "t5", support: [{ name: "Quinn QA", role: "edit" }] },     // QA not staffable
    { taskId: "t6" },                                                     // malformed
  ], byName);

  assert.deepEqual(valid.map((v) => v.taskId), ["t1"]);
  assert.deepEqual(failures, [
    { taskId: "t2", reason: "invalid-role" },
    { taskId: "t3", reason: "invalid-assignee" },
    { taskId: "t4", reason: "invalid-assignee" },
    { taskId: "t5", reason: "qa-not-staffable" },
    { taskId: "t6", reason: "malformed" },
  ]);
});

test("an empty support list is valid (clears crew)", () => {
  const { valid, failures } = validateAssignments([{ taskId: "t1", support: [] }], byName);
  assert.equal(valid.length, 1);
  assert.equal(failures.length, 0);
});

test("tolerates non-array input", () => {
  assert.deepEqual(validateAssignments(undefined, byName), { valid: [], failures: [] });
});
