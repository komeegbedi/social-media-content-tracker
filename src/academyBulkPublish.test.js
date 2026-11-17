/* Showing a category + publishing chosen courses: who's affected, ORDER, honest outcomes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryCourseGroups, readinessOf, runCategoryPublish, outcomeSummary } from "./academyBulkPublish.js";

const list = [
  { id: "pub", title: "Published", category: "cat", liveCategory: "cat", status: "published", changes: false },
  { id: "edits", title: "Has edits", category: "cat", liveCategory: "cat", status: "published", changes: true },
  { id: "new", title: "Never published", category: "cat", liveCategory: "", status: "draft" },
  { id: "arch", title: "Archived", category: "cat", liveCategory: "cat", status: "archived" },
  { id: "elsewhere", title: "Other", category: "x", liveCategory: "x", status: "published" },
  { id: "moving-in", title: "Moving in", category: "cat", liveCategory: "x", status: "published", changes: true },
];

test("groups: already-published become visible; drafts/edits are candidates (never auto); archived stay hidden", () => {
  const g = categoryCourseGroups(list, "cat");
  assert.deepEqual(g.visible.map((c) => c.id), ["pub", "edits"]);            // the LIVE version of 'edits' becomes visible
  assert.deepEqual(g.never.map((c) => c.id), ["new"]);
  assert.deepEqual(g.edits.map((c) => c.id), ["edits", "moving-in"]);
  assert.deepEqual(g.archived.map((c) => c.id), ["arch"]);
});

test("readiness uses the same checks as Publish, pinned to the draft revision", () => {
  const ws = { draftExists: true, head: { rev: 7, publishedRev: 0 }, liveCourse: null,
    course: { title: "T", category: "cat", level: "beginner", cover: null, modules: [{ id: "m", lessonIds: ["l"] }] }, lessons: { l: { title: "L" } } };
  const r = readinessOf(ws, ["cat"]);
  assert.equal(r.rev, 7); assert.equal(r.ready, false); assert.equal(r.issues[0].label, "Course cover");
  assert.equal(readinessOf({ ...ws, course: { ...ws.course, cover: { path: "p" } } }, ["cat"]).ready, true);
});

test("order: courses first, category LAST and only if every course published; never early", async () => {
  const calls = [];
  const publish = async (id, rev) => { calls.push(`publish:${id}@${rev}`); if (id === "bad") throw Object.assign(new Error("x"), { code: "conflict" }); return {}; };
  const showCategory = async () => { calls.push("show"); };
  const ok = await runCategoryPublish({ items: [{ id: "a", rev: 3 }, { id: "b", rev: 5 }], show: true, publish, showCategory });
  assert.deepEqual(calls, ["publish:a@3", "publish:b@5", "show"]);
  assert.equal(ok.category, "shown");
  calls.length = 0;
  const partial = await runCategoryPublish({ items: [{ id: "a", rev: 3 }, { id: "bad", rev: 1 }, { id: "c", rev: 2 }], show: true, publish, showCategory });
  assert.deepEqual(calls, ["publish:a@3", "publish:bad@1", "publish:c@2"]);  // the rest still run; NO show
  assert.equal(partial.category, "held");
  assert.deepEqual(partial.results.map((r) => r.ok), [true, false, true]);
  assert.match(partial.results[1].message, /changed after you opened this list/);
  assert.match(outcomeSummary(partial, { wasHidden: true }), /^2 of 3 courses published\. 1 didn't publish\. The category is still hidden because not every selected course was published\.$/);
  // "Publish courses…" in an already-VISIBLE category: never hidden, siblings untouched
  assert.equal(outcomeSummary({ results: partial.results, category: "unchanged" }, { wasHidden: false }), "2 of 3 courses published. 1 didn't publish. The category stays visible, and courses that were already published are unchanged.");
});

test("show only (no courses); a failing show is reported, successful publishes are not undone; retry-safe 'already'", async () => {
  const r = await runCategoryPublish({ items: [], show: true, publish: async () => ({}), showCategory: async () => {} });
  assert.equal(r.category, "shown"); assert.equal(outcomeSummary(r, { wasHidden: true }), "The category is now visible to learners.");
  const f = await runCategoryPublish({ items: [{ id: "a", rev: 1 }], show: true, publish: async () => ({ already: true }), showCategory: async () => { throw Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" }); } });
  assert.equal(f.results[0].ok, true); assert.equal(f.results[0].already, true);
  assert.equal(f.category, "failed"); assert.match(f.categoryError, /^The server refused to show the category\. You may no longer have permission/);
  const none = await runCategoryPublish({ items: [{ id: "a", rev: 1 }], show: false, publish: async () => ({}), showCategory: async () => { throw new Error("must not be called"); } });
  assert.equal(none.category, "unchanged");
});

test("v6.11: with tips & resources in the run, the summary counts ‘items’ (never ‘courses’)", () => {
  const s = outcomeSummary({ results: [{ id: "c", type: "course", ok: true }, { id: "g", type: "guide", ok: false }], category: "held" }, { wasHidden: true });
  assert.equal(s, "1 of 2 items published. 1 didn't publish. The category is still hidden because not every selected item was published.");
  assert.equal(outcomeSummary({ results: [{ id: "c", type: "course", ok: false }], category: "held" }, { wasHidden: true }),
    "0 of 1 course published. 1 didn't publish. The category is still hidden because not every selected course was published.");
});

test("v6.11: a rules refusal is reported as a server refusal with what to check, not only ‘permission’", async () => {
  const r = await runCategoryPublish({ items: [{ id: "g", rev: 1, type: "guide", title: "G" }], show: false,
    publish: async () => { throw Object.assign(new Error("7 PERMISSION_DENIED: evaluation error at L1159"), { code: "permission-denied" }); }, showCategory: async () => {} });
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].message, /^The server refused to publish it\. .*something in it isn't valid\. Open it to check\.$/);
  assert.doesNotMatch(r.results[0].message, /L1159|evaluation error/);
});
