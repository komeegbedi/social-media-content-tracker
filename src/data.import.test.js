/* CSV import — stable UID stamping (finding 4). Imported tasks must carry
   ownerUid / support[].uid / assigneeUids resolved through the SAME logic as
   normal creation; Pending / duplicate / ineligible / unmatched stay unresolved
   and are reported; the deterministic document identity (buildRowKeys) is derived
   from the RAW row and must be independent of name resolution.
   Run: node --test src/data.import.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowToTask, isTaskAssignee, canAdvanceProduction, workflowAction } from "./data.js";
import { buildRowKeys } from "./importPlan.js";

const owner   = { id: "u-own", name: "Otis Owner",  role: "member", status: "approved" };
const shooter = { id: "u-sho", name: "Sam Shooter", role: "member", status: "approved", skills: ["shoot"], location: ["479"] };
const editor  = { id: "u-edt", name: "Ed Editor",   role: "member", status: "approved", skills: ["edit"],  location: ["479"] };
const qaUser  = { id: "u-qa",  name: "Quinn QA",    role: "member", status: "approved", qa: true };
const pending = { id: "u-pnd", name: "Peggy Pend",  role: "member", status: "pending" };
const ROSTER  = [owner, shooter, editor, qaUser, pending];

const row = (over = {}) => ({
  title: "Launch Reel", type: "Reel", location: "479", status: "Planned",
  owner: "Otis Owner", "support team": "Sam Shooter - shoot || Ed Editor - edit",
  ...over,
});

test("finding 4 · resolved owner + crew are stamped with uids + assigneeUids", () => {
  const { task, error, unresolved } = rowToTask(row(), ROSTER);
  assert.equal(error, null);
  assert.equal(task.ownerUid, "u-own");
  assert.ok(task.support.every((s) => s.uid), "every matched crew has a uid");
  const crewUids = task.support.map((s) => s.uid);
  assert.ok(crewUids.includes("u-sho") && crewUids.includes("u-edt"));
  assert.deepEqual([...task.assigneeUids].sort(), ["u-edt", "u-own", "u-sho"]);
  assert.deepEqual(unresolved, []);
});

test("finding 4 · a DUPLICATE crew name stays unresolved (no uid) and is reported", () => {
  const dup = { id: "u-sho2", name: "Sam Shooter", role: "member", status: "approved" };
  const { task } = rowToTask(row(), [...ROSTER, dup]);
  // An ambiguous name is refused (never silently mapped) — it lands as a Pending
  // slot carrying the sheet name as a suggestion for the admin to reconcile.
  const sam = task.support.find((s) => s.suggested === "Sam Shooter");
  assert.ok(sam, "ambiguous crew is surfaced as a Pending suggestion");
  assert.equal(sam.name, "Pending");
  assert.equal(sam.uid, undefined, "ambiguous name is NOT mapped to any uid");
  assert.ok(!task.assigneeUids.includes("u-sho") && !task.assigneeUids.includes("u-sho2"));
});

test("finding 4 · an unmatched owner imports as Pending with no uid, and is reported", () => {
  const { task, unresolved } = rowToTask(row({ owner: "Nobody Known" }), ROSTER);
  assert.equal(task.owner, "Pending");
  assert.equal(task.ownerUid, "");
  assert.equal(task.ownerSuggested, "Nobody Known");
  assert.ok(!task.assigneeUids.includes(""));
  // owner reconciliation is surfaced by the import UI (reconcileNames); crew here still resolve.
  assert.ok(task.assigneeUids.includes("u-sho") && task.assigneeUids.includes("u-edt"));
});

test("finding 4 · a QA person named as crew is NOT stamped as a production assignee", () => {
  const { task } = rowToTask(row({ "support team": "Quinn QA - shoot" }), ROSTER);
  const quinn = task.support.find((s) => s.name === "Quinn QA");
  assert.equal(quinn.uid, undefined, "QA is not eligible production crew");
  assert.ok(!task.assigneeUids.includes("u-qa"));
});

test("finding 4 · deterministic doc identity is independent of name resolution (idempotent)", async () => {
  const raw = row();
  const a = await buildRowKeys([raw]);
  const b = await buildRowKeys([raw]);               // re-import same raw row
  assert.equal(a[0].id, b[0].id, "same raw row → same id");
  assert.equal(a[0].fingerprint, b[0].fingerprint);
  // Resolving against a DIFFERENT roster changes stamped uids but MUST NOT change the id.
  const t1 = rowToTask(raw, ROSTER).task;
  const t2 = rowToTask(raw, [owner]).task;           // sparser roster → fewer resolved uids
  assert.notDeepEqual(t1.assigneeUids, t2.assigneeUids);
  assert.equal(a[0].id, b[0].id);                    // identity unchanged regardless
});

test("finding 4 · imported assigned crew can perform the allowed production transition", () => {
  const { task } = rowToTask(row(), ROSTER);
  assert.equal(isTaskAssignee(task, shooter), true);
  assert.equal(canAdvanceProduction(task, shooter), true);
  assert.equal(workflowAction(task, shooter).to, "In Progress");  // Planned → In Progress
});
