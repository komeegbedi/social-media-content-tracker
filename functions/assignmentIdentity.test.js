/* Assignment identity — the shared backend helper (pure).
   Run: node --test functions/assignmentIdentity.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  assigneeUidsFromTask, hasUidIdentity, indexUsersByName, resolveLegacyName, eligibleAssigneeUids,
} = require("./assignmentIdentity");

/* ---- uid identity (authoritative, incl. present-empty) ---- */

test("present populated assigneeUids is authoritative (deduped, truthy)", () => {
  assert.deepEqual(assigneeUidsFromTask({ assigneeUids: ["a", "b", "a", ""] }).sort(), ["a", "b"]);
});

test("present EMPTY assigneeUids returns nobody, despite stale owner/support uids", () => {
  assert.deepEqual(assigneeUidsFromTask({ assigneeUids: [], ownerUid: "stale", support: [{ uid: "ghost" }] }), []);
  assert.equal(hasUidIdentity({ assigneeUids: [] }), true); // present [] is authoritative identity
});

test("absent assigneeUids falls back to ownerUid + support[].uid", () => {
  assert.deepEqual(assigneeUidsFromTask({ ownerUid: "o", support: [{ uid: "s1" }, { uid: "s2" }, {}] }).sort(), ["o", "s1", "s2"]);
  assert.deepEqual(assigneeUidsFromTask({}), []);
});

/* ---- legacy NAME fallback (unique + production-eligible only) ---- */

const roster = [
  { uid: "own", name: "Otis Owner", status: "approved" },
  { uid: "cam", name: "Cam Crew", status: "approved" },
  { uid: "qa", name: "Quinn QA", status: "approved", qa: true },
  { uid: "aq", name: "Andy AQ", role: "admin", qa: true },
  { uid: "pend", name: "Peg Pend", status: "pending" },
  { uid: "dis", name: "Del Dis", status: "approved", disabled: true },
  { uid: "rem", name: "Rex Rem", status: "removed" },
  // Two DIFFERENT users share a display name → ambiguous, must never resolve.
  { uid: "dupe1", name: "Sam Twin", status: "approved" },
  { uid: "dupe2", name: "Sam Twin", status: "approved" },
];
const byUid = Object.fromEntries(roster.map((u) => [u.uid, u]));
const nameIndex = indexUsersByName(roster);
const collect = (task, logs = []) =>
  eligibleAssigneeUids(task, { byUid, nameIndex, taskId: "t", logger: { warn: (m, f) => logs.push(f) } });

test("name-only legacy OWNER resolves when unique + eligible", () => {
  assert.deepEqual(collect({ owner: "Otis Owner" }), ["own"]);
});

test("name-only legacy SUPPORT crew is NOT authorized → never notified, and is logged as skipped", () => {
  const logs = [];
  const out = eligibleAssigneeUids(
    { owner: "Otis Owner", support: [{ name: "Cam Crew", role: "shoot" }] },
    { byUid, nameIndex, taskId: "t", logger: { warn: (m, f) => logs.push({ m, f }) } },
  );
  assert.deepEqual(out, ["own"], "only the legacy owner name is authorized");
  const skip = logs.find((l) => /support crew not authorized/i.test(l.m));
  assert.ok(skip, "a warning explains why legacy support was skipped");
  assert.equal(skip.f.name, "Cam Crew");
});

test("duplicate names resolve to nobody (never last-write-wins)", () => {
  const logs = [];
  assert.deepEqual(collect({ owner: "Sam Twin" }, logs), []);
  assert.equal(logs[0].reason, "ambiguous");
});

test("QA / Admin+QA / pending / disabled / removed legacy names resolve to nobody", () => {
  for (const name of ["Quinn QA", "Andy AQ", "Peg Pend", "Del Dis", "Rex Rem"]) {
    const logs = [];
    assert.deepEqual(collect({ owner: name }, logs), [], `${name} must not resolve`);
    assert.equal(logs[0].reason, "ineligible");
  }
});

test("an unknown legacy name logs 'unknown' and resolves to nobody", () => {
  const logs = [];
  assert.deepEqual(collect({ owner: "Nobody Here" }, logs), []);
  assert.equal(logs[0].reason, "unknown");
});

test("a Pending slot is silently skipped (no log, no recipient)", () => {
  const logs = [];
  assert.deepEqual(collect({ owner: "Pending", support: [{ name: "Pending" }] }, logs), []);
  assert.equal(logs.length, 0);
});

/* ---- uid-identity path filters to production-eligible ---- */

test("uid identity keeps only production-eligible resolved users", () => {
  // owner is production; qa + disabled are present in assigneeUids but ineligible.
  assert.deepEqual(
    eligibleAssigneeUids({ assigneeUids: ["own", "qa", "dis", "aq"] }, { byUid, nameIndex }).sort(),
    ["own"],
  );
});

test("present-empty assigneeUids never triggers the name fallback (authoritative empty)", () => {
  // Even with a legacy owner NAME present, an authoritative empty set wins → nobody.
  assert.deepEqual(eligibleAssigneeUids({ assigneeUids: [], owner: "Otis Owner" }, { byUid, nameIndex }), []);
});

test("resolveLegacyName reason codes", () => {
  assert.equal(resolveLegacyName("", nameIndex).reason, "empty");
  assert.equal(resolveLegacyName("Pending", nameIndex).reason, "empty");
  assert.equal(resolveLegacyName("Sam Twin", nameIndex).reason, "ambiguous");
  assert.equal(resolveLegacyName("Ghost", nameIndex).reason, "unknown");
  assert.equal(resolveLegacyName("Quinn QA", nameIndex).reason, "ineligible");
  assert.deepEqual(resolveLegacyName("Otis Owner", nameIndex), { uid: "own", reason: "resolved" });
});
