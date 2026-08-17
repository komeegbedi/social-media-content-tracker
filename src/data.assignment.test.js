/* Assigned-team workflow — stable UID assignment identity + shared predicates
   (src/data.js). Firebase-free. Mirrors the firestore.rules boundary.
   Run: node --test src/data.assignment.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  taskAssigneeUids, isTaskAssignee, canAdvanceProduction, computeAssigneeUids,
  withAssigneeUids, applyAssignment, autoAssign, workflowAction,
} from "./data.js";

const owner  = { id: "u-own", name: "Otis Owner", role: "member", status: "approved" };
const shooter = { id: "u-sho", name: "Sam Shooter", role: "member", status: "approved", skills: ["shoot"], location: ["479"] };
const editor  = { id: "u-edt", name: "Ed Editor",  role: "member", status: "approved", skills: ["edit"], location: ["479"] };
const outsider = { id: "u-out", name: "Odell Outsider", role: "member", status: "approved" };
const admin   = { id: "u-adm", name: "Ada Admin", role: "admin", status: "approved" };
const pending = { id: "u-pnd", name: "Peggy Pend", role: "member", status: "pending" };
const disabled = { id: "u-dis", name: "Del Disabled", role: "member", status: "approved", disabled: true };

const task = (over = {}) => ({
  id: "t1", type: "Reel", status: "In Progress",
  ownerUid: "u-own", owner: "Otis Owner",
  support: [{ name: "Sam Shooter", uid: "u-sho", role: "shoot" }, { name: "Ed Editor", uid: "u-edt", role: "edit" }],
  assigneeUids: ["u-own", "u-sho", "u-edt"], ...over,
});

test("taskAssigneeUids: prefers stored set; else derives from ownerUid + support[].uid", () => {
  assert.deepEqual(taskAssigneeUids(task()).sort(), ["u-edt", "u-own", "u-sho"]);
  const derived = { ownerUid: "a", support: [{ uid: "b" }, { uid: "b" }, { name: "Pending" }] };
  assert.deepEqual(taskAssigneeUids(derived).sort(), ["a", "b"]);   // deduped, Pending dropped
});

test("isTaskAssignee: owner AND every crew role qualify; unassigned does not", () => {
  const t = task();
  assert.equal(isTaskAssignee(t, owner), true);
  assert.equal(isTaskAssignee(t, shooter), true);    // crew (shooter)
  assert.equal(isTaskAssignee(t, editor), true);     // crew (editor)
  assert.equal(isTaskAssignee(t, outsider), false);  // not assigned
});

test("isTaskAssignee: legacy owner-NAME fallback only when no uid set", () => {
  const legacy = { owner: "Otis Owner", support: [{ name: "Sam Shooter", role: "shoot" }] };  // no uids
  assert.equal(isTaskAssignee(legacy, owner), true);      // owner by name
  assert.equal(isTaskAssignee(legacy, shooter), false);   // crew NOT granted by legacy name (uid-only)
});

test("canAdvanceProduction: any active approved assignee OR active admin; role-agnostic", () => {
  const t = task();
  assert.equal(canAdvanceProduction(t, shooter), true);   // shooter can advance production
  assert.equal(canAdvanceProduction(t, editor), true);    // editor too
  assert.equal(canAdvanceProduction(t, admin), true);     // admin (normal forward, not override)
  assert.equal(canAdvanceProduction(t, outsider), false); // unassigned
  assert.equal(canAdvanceProduction(t, { ...pending, id: "u-own" }), false);  // pending assignee denied
  assert.equal(canAdvanceProduction(t, { ...disabled, id: "u-sho" }), false); // disabled assignee denied
});

test("withAssigneeUids: maps names→uids, refuses DUPLICATE + UNMATCHED names, keeps Pending", () => {
  const users = [owner, shooter, editor, outsider, { id: "dup1", name: "Sam Shooter" }]; // duplicate 'Sam Shooter'
  const t = { owner: "Otis Owner", support: [
    { name: "Sam Shooter", role: "shoot" },   // duplicate → unresolved
    { name: "Ghost Person", role: "edit" },   // unmatched → unresolved
    { name: "Pending", role: "coordinate" },  // pending slot → left as-is
  ] };
  const { task: out, unresolved } = withAssigneeUids(t, users);
  assert.equal(out.ownerUid, "u-own");
  assert.equal(out.support[0].uid, undefined, "duplicate name not mapped");
  assert.equal(out.support[1].uid, undefined, "unmatched name not mapped");
  assert.deepEqual(out.assigneeUids, ["u-own"]);   // only the owner resolved
  const reasons = Object.fromEntries(unresolved.map((u) => [u.name, u.reason]));
  assert.equal(reasons["Sam Shooter"], "duplicate-name");
  assert.equal(reasons["Ghost Person"], "no-match");
});

test("applyAssignment: fills a Pending slot with uid + refreshes assigneeUids", () => {
  const t = { owner: "Pending", ownerSuggested: "Otis Owner", support: [] };
  const out = applyAssignment(t, owner);
  assert.equal(out.owner, "Otis Owner");
  assert.equal(out.ownerUid, "u-own");
  assert.deepEqual(out.assigneeUids, ["u-own"]);
});

test("autoAssign: every produced crew entry carries a stable uid", () => {
  const t = { id: "tx", type: "Reel", owner: "Otis Owner", location: "479", status: "Planned" };
  const crew = autoAssign(t, [owner, shooter, editor], []);
  assert.ok(crew.length >= 1);
  crew.forEach((c) => assert.ok(c.uid, `crew ${c.name} has a uid`));
});

test("workflowAction: an assigned CREW member (not owner) gets the production step", () => {
  assert.equal(workflowAction(task({ status: "Planned" }), shooter).to, "In Progress");
  assert.equal(workflowAction(task({ status: "In Progress" }), editor).to, "In Review");
  assert.equal(workflowAction(task({ status: "Changes Requested" }), shooter).to, "In Review");
  // Unassigned member gets NO production action.
  assert.equal(workflowAction(task({ status: "Planned" }), outsider), null);
  // In Review is the QA panel — no production action for anyone here.
  assert.equal(workflowAction(task({ status: "In Review" }), owner), null);
});

test("computeAssigneeUids: owner + crew uids, deduped, empties dropped", () => {
  assert.deepEqual(
    computeAssigneeUids({ ownerUid: "a", support: [{ uid: "b" }, { uid: "" }, { uid: "a" }] }).sort(),
    ["a", "b"]);
});

/* ============================================================================
   REVIEW-FIX regression tests (findings 2, 3, 7)
   ============================================================================ */
const qaUser = { id: "u-qa", name: "Quinn QA", role: "member", status: "approved", qa: true };

test("Finding 2 · canAdvanceProduction denies a QA-only user even if their uid is assigned", () => {
  const t = task({ ownerUid: "u-qa", owner: "Quinn QA", assigneeUids: ["u-qa"], support: [] });
  assert.equal(canAdvanceProduction(t, qaUser), false);
  const adminqa = { id: "u-aq", name: "Andy", role: "admin", status: "approved", qa: true };
  assert.equal(canAdvanceProduction(task({ assigneeUids: [] }), adminqa), true);
});

test("Finding 3 · a renamed assigned user keeps their uid + access; display name refreshes", () => {
  const renamed = { ...owner, name: "Otis NewName" };
  const { task: out } = withAssigneeUids({ owner: "Otis Owner", ownerUid: "u-own", support: [] }, [renamed, editor]);
  assert.equal(out.ownerUid, "u-own");
  assert.equal(out.owner, "Otis NewName");
  assert.equal(isTaskAssignee(out, renamed), true);
});

test("Finding 3 · another user taking the OLD display name does NOT steal ownership", () => {
  const imposter = { id: "u-imp", name: "Otis Owner", role: "member", status: "approved" };
  const renamedOwner = { ...owner, name: "Otis NewName" };
  const { task: out } = withAssigneeUids({ owner: "Otis Owner", ownerUid: "u-own", support: [] }, [renamedOwner, imposter]);
  assert.equal(out.ownerUid, "u-own");
  assert.equal(out.owner, "Otis NewName");
});

test("Finding 3 · a crew member's uid survives a stale stored display name", () => {
  const renamedCrew = { ...shooter, name: "Sam NewName" };
  const { task: out } = withAssigneeUids(
    { owner: "Otis Owner", ownerUid: "u-own", support: [{ name: "Sam Shooter", uid: "u-sho", role: "shoot" }] },
    [owner, renamedCrew]);
  assert.equal(out.support[0].uid, "u-sho");
  assert.equal(out.support[0].name, "Sam NewName");
  assert.ok(out.assigneeUids.includes("u-sho"));
});

test("Finding 3 · an explicit Admin reassignment (new uid) changes identity", () => {
  const { task: out } = withAssigneeUids({ owner: "Ed Editor", ownerUid: "u-edt", support: [] }, [owner, editor]);
  assert.equal(out.ownerUid, "u-edt");
  assert.deepEqual(out.assigneeUids, ["u-edt"]);
});

test("Finding 3 · pending / removed / disabled / QA are NOT resolved as production staff", () => {
  const removed = { id: "u-rem", name: "Removed R", status: "removed" };
  const { task: out, unresolved } = withAssigneeUids({ owner: "Peggy Pend", support: [
    { name: "Del Disabled", role: "edit" }, { name: "Quinn QA", role: "shoot" }, { name: "Removed R", role: "coordinate" },
  ] }, [pending, disabled, qaUser, removed]);
  assert.equal(out.ownerUid, "");
  assert.ok(out.support.every((s) => !s.uid));
  assert.deepEqual(out.assigneeUids, []);
  const byName = Object.fromEntries(unresolved.map((u) => [u.name, u.reason]));
  assert.equal(byName["Peggy Pend"], "ineligible");
  assert.equal(byName["Quinn QA"], "ineligible");
});

test("Finding 7 · isTaskAssignee: present assigneeUids:[] authorizes NOBODY (no name fallback)", () => {
  assert.equal(isTaskAssignee({ owner: "Otis Owner", assigneeUids: [] }, owner), false);
});
test("Finding 7 · isTaskAssignee: partial assigneeUids authorizes only stored uids", () => {
  const t = { owner: "Otis Owner", ownerUid: "u-own", assigneeUids: ["u-sho"] };
  assert.equal(isTaskAssignee(t, owner), false);
  assert.equal(isTaskAssignee(t, shooter), true);
});
