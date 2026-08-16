/* Trash (soft-delete) boundary contracts (src/data.js). Firebase-free.
   Run: node --test src/data.trash.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeleted, visibleTasks, trashedTasks, canRestoreTask, taskDeletionSummary } from "./data.js";

const active = { id: "a", title: "Reel A", status: "In Progress", owner: "Alex" };
const trashed = { id: "b", title: "Reel B", status: "Approved", owner: "Jordan", deletedAt: { seconds: 1 }, deletedBy: "u1", deletedByName: "Jane Doe" };

test("isDeleted keys ONLY off deletedAt (status is preserved, never repurposed)", () => {
  assert.equal(isDeleted(active), false);
  assert.equal(isDeleted(trashed), true);
  assert.equal(isDeleted(null), false);
  assert.equal(isDeleted({ status: "Posted" }), false);   // a real status is not "deleted"
});

test("visibleTasks excludes trashed; trashedTasks contains only trashed — the two partition the set", () => {
  const all = [active, trashed];
  assert.deepEqual(visibleTasks(all).map((t) => t.id), ["a"]);
  assert.deepEqual(trashedTasks(all).map((t) => t.id), ["b"]);
  assert.equal(visibleTasks(all).length + trashedTasks(all).length, all.length);
  assert.deepEqual(visibleTasks(null), []);   // null-safe
});

test("a trashed task keeps its exact workflow status (restore returns prior state)", () => {
  assert.equal(trashed.status, "Approved");                    // untouched by deletion
  assert.equal(taskDeletionSummary(trashed).previousStatus, "Approved");
});

test("canRestoreTask: admin + trashed only", () => {
  const admin = { role: "admin" }, member = { role: "member" };
  assert.equal(canRestoreTask(admin, trashed), true);
  assert.equal(canRestoreTask(member, trashed), false);   // non-admin cannot restore
  assert.equal(canRestoreTask(admin, active), false);     // active isn't restorable
  assert.equal(canRestoreTask(null, trashed), false);
});

test("taskDeletionSummary is null for active, populated for trashed", () => {
  assert.equal(taskDeletionSummary(active), null);
  const s = taskDeletionSummary(trashed);
  assert.equal(s.title, "Reel B");
  assert.equal(s.owner, "Jordan");
  assert.equal(s.deletedByName, "Jane Doe");
  assert.ok(s.deletedAt);
});
