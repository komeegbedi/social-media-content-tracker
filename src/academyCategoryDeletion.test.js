import { test } from "node:test";
import assert from "node:assert/strict";
import { courseFingerprint, courseRow, buildPlan, unresolved, reviewSummary, runCategoryDeletion, doneMessage } from "./academyCategoryDeletion.js";

const ts = (n) => ({ toMillis: () => n });
const ids = ["photo"];
const C = (id, over = {}) => ({ id, title: id.toUpperCase(), status: "published", publishedElsewhere: false, draftConflict: false, ...over });

test("course rows: every kind of course filed here, with conflicts flagged (never overwritten)", () => {
  assert.equal(courseRow("a", { status: "published", category: "photo" }, { category: "photo", rev: 3, publishedRev: 3 }, ids).status, "published");
  assert.equal(courseRow("a", { status: "published", category: "photo" }, { category: "photo", rev: 4, publishedRev: 3 }, ids).status, "published-edits");
  assert.equal(courseRow("a", { status: "archived", category: "photo" }, null, ids).status, "archived");
  assert.equal(courseRow("a", { status: "draft", category: "photo" }, null, ids).status, "unpublished");
  assert.equal(courseRow("a", null, { category: "photo", rev: 1 }, ids).status, "draft-only");
  const conflict = courseRow("a", { status: "published", category: "photo" }, { category: "film", rev: 5, publishedRev: 4 }, ids);
  assert.equal(conflict.draftConflict, true);
  const elsewhere = courseRow("a", { status: "published", category: "film" }, { category: "photo", rev: 2, publishedRev: 1 }, ids);
  assert.equal(elsewhere.publishedElsewhere, true); assert.equal(elsewhere.draftIn, true);
  assert.equal(courseFingerprint({ status: "published", category: "photo", updatedAt: ts(5) }, { category: "photo", rev: 2 }), "published|photo|photo|2|5");
});

test("plans: nothing preselected; every course AND resource needs an explicit choice; shared or per-item destinations; paths explicit", () => {
  const courses = [C("a"), C("b"), C("c")];
  const guides = [{ id: "g", title: "G" }, { id: "h", title: "H" }];
  const cats = ["film", "design"];
  assert.equal(unresolved(buildPlan({ mode: null, courses, guides }), { courses, guides }, cats).length, 5, "no mode → nothing resolved (never a default delete)");
  const each = buildPlan({ mode: "each", courses, guides, sharedDest: "film", rows: { a: { action: "move" }, b: { action: "move", dest: "design" }, c: { action: "delete" }, g: { action: "delete" }, h: { action: "move" } } });
  assert.deepEqual(each.courses, { a: { action: "move", dest: "film" }, b: { action: "move", dest: "design" }, c: { action: "delete" } });
  assert.deepEqual(each.guides, { g: { action: "delete" }, h: { action: "move", dest: "film" } });
  assert.deepEqual(unresolved(each, { courses, guides }, cats), []);
  const half = buildPlan({ mode: "each", courses, guides, sharedDest: "", rows: { a: { action: "move" } } });
  assert.deepEqual(unresolved(half, { courses, guides }, cats), ["Choose where to move the course “A”.", "Choose Move or Delete for the course “B”.", "Choose Move or Delete for the course “C”.", "Choose Move or Delete for the resource “G”.", "Choose Move or Delete for the resource “H”."]);
  // move-all / delete-all cover resources too; learning paths stay explicit (no silent default)
  const all = buildPlan({ mode: "move-all", courses, guides, sharedDest: "film", paths: [{ id: "p", title: "P" }] });
  assert.equal(all.guides.g.dest, "film");
  assert.equal(unresolved(all, { courses, guides, paths: [{ id: "p", title: "P" }] }, cats).length, 1);
  assert.deepEqual(buildPlan({ mode: "delete-all", courses, guides, paths: [{ id: "p" }], pathDest: { p: "" } }).paths, { p: "" }, "a path may keep no category");
  assert.match(unresolved(buildPlan({ mode: "delete-all", courses: [C("x", { publishedElsewhere: true })] }), { courses: [C("x", { publishedElsewhere: true })] }, cats)[0], /published in another category/);
  const dc = buildPlan({ mode: "each", courses: [C("d", { draftConflict: true })], sharedDest: "film", rows: { d: { action: "move", draftToo: true } } });
  assert.deepEqual(dc.courses.d, { action: "move", dest: "film", draftDest: "film" });
});

test("review wording: separate counts for courses and resources; specific final button", () => {
  const labelOf = (d) => ({ film: "Filmmaking", design: "Design" })[d];
  const courses = ["a", "b", "c"].map((x) => C(x)), guides = ["g", "h", "i", "j", "k"].map((x) => C(x));
  const mixed = { courses: { a: { action: "move", dest: "film" }, b: { action: "move", dest: "film" }, c: { action: "delete" } },
    guides: { g: { action: "move", dest: "film" }, h: { action: "move", dest: "design" }, i: { action: "move", dest: "film" }, j: { action: "delete" }, k: { action: "delete" } }, paths: {} };
  const s = reviewSummary(mixed, { category: "“Photography”", courses, guides, labelOf });
  assert.equal(s.sentence, "Move 2 courses and 3 resources. Delete 1 course and 2 resources. Delete the category “Photography”.");
  assert.equal(s.button, "Move 2 courses and 3 resources and delete 1 course and 2 resources");
  assert.deepEqual(s.destText, ["2 courses and 2 resources to Filmmaking", "1 resource to Design"]);
  const allDel = { courses: Object.fromEntries(courses.map((c) => [c.id, { action: "delete" }])), guides: Object.fromEntries(guides.slice(0, 2).map((g) => [g.id, { action: "delete" }])), paths: {} };
  assert.equal(reviewSummary(allDel, { category: "“P”", courses, guides: guides.slice(0, 2), labelOf }).button, "Delete category and 3 courses and 2 resources");
  const onlyCourses = { courses: { a: { action: "move", dest: "film" }, b: { action: "delete" } }, guides: {}, paths: {} };
  assert.equal(reviewSummary(onlyCourses, { category: "“P”", courses: courses.slice(0, 2), labelOf }).button, "Move 1 course and delete 1 course");
  assert.equal(reviewSummary({ courses: {}, guides: {}, paths: {} }, { category: "“X”", courses: [], labelOf }).button, "Delete category");
});

const plan = { courses: { a: { action: "move", dest: "film" }, b: { action: "delete" }, c: { action: "move", dest: "film" } }, guides: { g: { action: "move", dest: "film" }, x: { action: "delete" } }, paths: { p: "" } };
const items = [{ type: "course", id: "a", title: "A" }, { type: "course", id: "b", title: "B" }, { type: "course", id: "c", title: "C" }, { type: "guide", id: "g", title: "G" }, { type: "guide", id: "x", title: "X" }, { type: "path", id: "p", title: "P" }];
const okOps = (log, over = {}) => ({
  lock: async () => { log.push("lock"); return { ok: true }; },
  move: async (it, d) => { log.push(`move:${it.id}>${d}`); },
  deleteCourse: async (id) => { log.push(`delete:${id}`); return { pendingCleared: true }; },
  deleteGuide: async (id) => { log.push(`deleteGuide:${id}`); return { pendingCleared: true }; },
  appendOrder: async (d, ids) => { log.push(`order:${d}:${ids.join(",")}`); },
  finalize: async () => { log.push("finalize"); return { ok: true, coverPath: "academy/catCovers/photo/x.jpg" }; },
  deleteCover: async () => { log.push("cover"); },
  ...over,
});

test("run: lock first, every item, destination order (relative order kept), finalize LAST", async () => {
  const log = [];
  const r = await runCategoryDeletion({ plan, items, ops: okOps(log) });
  assert.equal(r.stage, "done");
  assert.deepEqual(log, ["lock", "move:a>film", "delete:b", "move:c>film", "move:g>film", "deleteGuide:x", "move:p>", "order:film:a,c", "finalize", "cover"]);
  assert.equal(doneMessage(r, "Photography", plan), "Deleted the category “Photography”. Moved 2 courses and 1 resource and permanently deleted 1 course and 1 resource. 1 learning path was updated too.");
});

test("run: changed since review → nothing done; a failure → no finalize, exact report; retry handles only what's left", async () => {
  const log = [];
  const changed = await runCategoryDeletion({ plan, items, ops: okOps(log, { lock: async () => ({ ok: false, changes: [{ kind: "added", type: "course", id: "z", title: "Z" }] }) }) });
  assert.equal(changed.stage, "changed"); assert.deepEqual(log, []);
  const log2 = [];
  const partial = await runCategoryDeletion({ plan, items, ops: okOps(log2, { deleteCourse: async () => { throw new Error("Network error"); } }) });
  assert.equal(partial.stage, "partial");
  assert.deepEqual(partial.moved.map((m) => m.id), ["a", "c", "g", "p"]);
  assert.deepEqual(partial.failed.map((f) => [f.id, f.message]), [["b", "Network error"]]);
  assert.ok(!log2.includes("finalize"), "the category is NOT deleted while anything remains");
  // retry: only the remaining item (the others are no longer filed here)
  const log3 = [];
  const retry = await runCategoryDeletion({ plan, items: [items[1]], ops: okOps(log3, { lock: async () => { log3.push("lock"); return { ok: true, already: true }; } }) });
  assert.equal(retry.stage, "done");
  assert.deepEqual(log3, ["lock", "delete:b", "finalize", "cover"]);
  // the message after a resumed run describes the WHOLE deletion (from the plan)
  assert.match(doneMessage(retry, "Photography", plan), /Moved 2 courses and 1 resource and permanently deleted 1 course and 1 resource\./);
  // the server still finds something filed here → partial, with what remains
  const left = await runCategoryDeletion({ plan, items: [], ops: okOps([], { finalize: async () => ({ ok: false, remaining: [{ type: "course", id: "new", title: "New" }] }) }) });
  assert.equal(left.stage, "partial"); assert.equal(left.remaining[0].title, "New");
  // cleanup still pending is reported, not treated as failure
  const pend = await runCategoryDeletion({ plan: { courses: { b: { action: "delete" } }, guides: {}, paths: {} }, items: [items[1]], ops: okOps([], { deleteCourse: async () => ({ pendingCleared: false }) }) });
  assert.equal(pend.stage, "done"); assert.match(doneMessage(pend, "P"), /clean-up .* is still pending/);
});
