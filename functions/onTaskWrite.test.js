/* onTaskWrite review-notification recipient policy (pure).
   Review authority is qa === true ONLY — admin-only users are never reviewers, and
   an Admin+QA user is never double-notified.
   Run: node --test functions/onTaskWrite.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { reviewRecipients } = require("./onTaskWrite");

const users = [
  { uid: "m",  role: "member", qa: false },              // member
  { uid: "a",  role: "admin",  qa: false },              // admin-only
  { uid: "q",  role: "member", qa: true },               // QA-only
  { uid: "aq", role: "admin",  qa: true },               // admin + QA
];

test("reviewers are qa === true only — admin-only is excluded", () => {
  const { reviewers } = reviewRecipients(users);
  const ids = reviewers.map((u) => u.uid).sort();
  assert.deepEqual(ids, ["aq", "q"], "QA-only and Admin+QA are reviewers");
  assert.ok(!ids.includes("a"), "admin-only is NOT a reviewer");
  assert.ok(!ids.includes("m"), "member is NOT a reviewer");
});

test("admin-only users get the informational notice; reviewers are not in it", () => {
  const { infoAdmins } = reviewRecipients(users);
  const ids = infoAdmins.map((u) => u.uid);
  assert.deepEqual(ids, ["a"], "only the admin-only user is informational");
});

test("an Admin+QA user is a reviewer and is NOT also an info-admin (no duplicate)", () => {
  const { reviewers, infoAdmins } = reviewRecipients(users);
  const reviewerIds = new Set(reviewers.map((u) => u.uid));
  const infoIds = new Set(infoAdmins.map((u) => u.uid));
  assert.ok(reviewerIds.has("aq"), "Admin+QA reviews");
  assert.ok(!infoIds.has("aq"), "Admin+QA is excluded from the info list");
  // No overlap between the two audiences at all.
  for (const id of reviewerIds) assert.ok(!infoIds.has(id), `no overlap for ${id}`);
});

test("handles empty / missing input", () => {
  assert.deepEqual(reviewRecipients([]), { reviewers: [], infoAdmins: [] });
  assert.deepEqual(reviewRecipients(undefined), { reviewers: [], infoAdmins: [] });
});
