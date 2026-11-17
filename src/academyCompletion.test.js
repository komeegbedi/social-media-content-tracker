/* Course completion: what's still required, and what to suggest next (pure).
   Run: node --test src/academyCompletion.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { remainingRequirement, pathContextFor, nextCourseSuggestion } from "./academyCompletion.js";
import { courseProgress, mergeCategories } from "./academyProgress.js";

const course = { id: "c1", title: "C1", category: "photography", modules: [{ id: "m", lessonIds: ["a", "b", "q", "bonus"] }] };
const quiz = { mode: "required", passMark: 70, retryLimit: 0, questions: [{ id: "x", prompt: "?", options: [{ id: "o1" }, { id: "o2" }] }] };
const lessons = [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "q", title: "Quiz lesson", quiz }, { id: "bonus", title: "Bonus", bonus: true }];
const prog = (done, earned = {}) => ({ lessons: Object.fromEntries(done.map((id) => [id, { manualDone: true }])), earned });

test("completion needs every REQUIRED item (incl. the required quiz); optional items never block it", () => {
  assert.equal(courseProgress(course, lessons, prog(["a", "b", "q"])).completed, false, "manual done doesn't satisfy a required quiz");
  assert.equal(courseProgress(course, lessons, prog(["a", "b"], { q: true })).completed, true, "bonus left open — still complete");
});
test("remaining requirement: an EARLIER outstanding lesson is found even from the last lesson", () => {
  const left = remainingRequirement(course, lessons, prog(["b"], { q: true }), "bonus");
  assert.equal(left.lesson.id, "a");
  assert.equal(left.count, 1);
  assert.equal(left.isCurrent, false);
});
test("remaining requirement: the current lesson's quiz → 'Finish quiz'", () => {
  const left = remainingRequirement(course, lessons, prog(["a", "b"]), "q");
  assert.deepEqual([left.lesson.id, left.isCurrent, left.needsQuiz], ["q", true, true]);
  assert.equal(remainingRequirement(course, lessons, prog(["a", "b"], { q: true }), "q"), null);
});

const cats = mergeCategories([{ id: "photography", name: "Photography", order: 0, courseOrder: ["c3", "c1", "c2", "c4"] }, { id: "film", name: "Film", order: 1 }, { id: "secret", name: "Secret", order: 2, hidden: true }]);
const C = (id, over = {}) => ({ id, title: id.toUpperCase(), category: "photography", status: "published", level: "beginner", requiredLessonCount: 1, ...over });
const me = { id: "u", role: "member", status: "approved" };

test("next course: the next accessible, unfinished course in the category's CONFIGURED order (wrapping)", () => {
  const courses = [C("c1"), C("c2"), C("c3"), C("c4")];
  assert.equal(nextCourseSuggestion({ me, current: courses[0], courses, categories: cats, progressByCourse: {} }).course.id, "c2");
  // c2 done → skip to c4; then wrap round to c3
  const done = { c2: { earned: { x: true } } };
  assert.equal(nextCourseSuggestion({ me, current: courses[0], courses, categories: cats, progressByCourse: done }).course.id, "c4");
  assert.equal(nextCourseSuggestion({ me, current: courses[0], courses: [C("c1"), C("c2"), C("c3")], categories: cats, progressByCourse: done }).course.id, "c3");
});
test("next course excludes the current, completed, archived, draft and hidden-category courses; falls back to recommendations; else null", () => {
  const current = C("c1");
  const courses = [current, C("c2", { status: "archived" }), C("c3", { status: "draft" }), C("h1", { category: "secret" }), C("f1", { category: "film" })];
  const s = nextCourseSuggestion({ me, current, courses, categories: cats, progressByCourse: {} });
  assert.equal(s.course.id, "f1", "fallback: an accessible course elsewhere");
  assert.equal(nextCourseSuggestion({ me, current, courses: [current, C("c2", { status: "archived" })], categories: cats, progressByCourse: {} }), null);
  assert.equal(nextCourseSuggestion({ me, current, courses: [current, C("f1", { category: "film" })], categories: cats, progressByCourse: { f1: { earned: { x: true } } } }), null, "completed courses aren't suggested");
});
test("learning-path context is EXPLICIT (?path=) and validated — never guessed from started paths", () => {
  const P = (id, over = {}) => ({ id, title: id, status: "published", category: "", items: [{ type: "course", courseId: "c1" }], ...over });
  const paths = [P("p1"), P("p2", { items: [{ type: "lesson", courseId: "c1", lessonId: "a" }] }), P("p3", { items: [{ type: "course", courseId: "zz" }] }),
    P("draftpath", { status: "draft" }), P("hiddenpath", { category: "secret" })];
  // direct lesson visit: no context → null, even though the learner has several started paths containing c1
  assert.equal(pathContextFor({ pathId: null, paths, courseId: "c1", me }), null, "direct visit: no path");
  // multiple started paths contain c1: the one in the URL wins, whichever it is
  assert.equal(pathContextFor({ pathId: "p1", paths, courseId: "c1", me }).id, "p1");
  assert.equal(pathContextFor({ pathId: "p2", paths, courseId: "c1", me }).id, "p2", "a lesson step counts too");
  // invalid context → null (falls back to the next course / recommendations)
  assert.equal(pathContextFor({ pathId: "p3", paths, courseId: "c1", me }), null, "path doesn't contain this course");
  assert.equal(pathContextFor({ pathId: "nope", paths, courseId: "c1", me }), null, "unknown / deleted path");
  assert.equal(pathContextFor({ pathId: "draftpath", paths, courseId: "c1", me }), null, "unpublished path (learner)");
  assert.equal(pathContextFor({ pathId: "hiddenpath", paths, courseId: "c1", me, hidden: ["secret"] }), null, "path in a hidden category");
});

/* ---- v6.5 progression: requirements vs prerequisites ---------------------- */
import { lessonAccess, accessFor, actionableFor, readyToFinish, courseStatus, isFinished, lessonState, lessonOpenFromModules, resumeLessonId, validatePrerequisites, dependentsOf, prerequisiteStatus, eligiblePrerequisites, courseCounters, flatLessons } from "./academyProgress.js";
import { moveLessonInOutline, moveModule, insertLesson, removeLesson } from "./academyOrder.js";

// The example from the brief: Composition has no prerequisites; Advanced Exposure requires Exposure Triangle.
const photo = { id: "ph", modules: [{ id: "m", lessonIds: ["tri", "comp", "adv", "opt"] }] };
const photoLessons = [{ id: "tri", title: "Exposure Triangle" }, { id: "comp", title: "Composition" }, { id: "adv", title: "Advanced Exposure", prerequisites: ["tri"] }, { id: "opt", title: "Optional extra", bonus: true }];
const open = (p, ls = photoLessons, c = photo) => Object.fromEntries(lessonAccess(c, ls, p).map((a) => [a.id, a.accessible]));

test("required ≠ locked: required lessons with no prerequisites open independently", () => {
  assert.deepEqual(open(null), { tri: true, comp: true, adv: false, opt: true });
  assert.equal(accessFor(lessonAccess(photo, photoLessons, null), "adv").blockedBy.title, "Exposure Triangle");
  assert.deepEqual(open(prog(["comp"])), { tri: true, comp: true, adv: false, opt: true }, "completing an unrelated lesson unlocks nothing");
  assert.deepEqual(open(prog(["tri"])), { tri: true, comp: true, adv: true, opt: true });
});
test("multiple prerequisites: all must be complete; the route goes to an actionable one (through chains)", () => {
  const ls = [...photoLessons.slice(0, 2), { id: "adv", title: "Advanced", prerequisites: ["tri", "comp"] }, { id: "opt", title: "Opt", bonus: true, prerequisites: ["adv"] }];
  const a = accessFor(lessonAccess(photo, ls, prog(["tri"])), "adv");
  assert.equal(a.accessible, false); assert.deepEqual(a.missing.map((m) => m.id), ["comp"]);
  assert.equal(actionableFor(lessonAccess(photo, ls, null), "opt").id, "tri", "opt → adv (locked) → tri (open)");
});
test("a failed / unpassed required quiz blocks only what depends on it", () => {
  const ls = [{ id: "q", title: "Quiz", quiz }, { id: "x", title: "Unrelated" }, { id: "y", title: "Depends", prerequisites: ["q"] }];
  const c = { modules: [{ id: "m", lessonIds: ["q", "x", "y"] }] };
  assert.deepEqual(open(prog(["q"]), ls, c), { q: true, x: true, y: false }, "manual flag on a quiz lesson doesn't count");
  assert.deepEqual(open(prog([], { q: { at: 1 } }), ls, c), { q: true, x: true, y: true });
});
test("completion flags come from `lessons` only — client-writable `playback` can't complete or unlock", () => {
  const spoof = { playback: { tri: { manualDone: true, videoWatched: true, positionSec: 40 } } };
  assert.equal(lessonState(photoLessons[0], spoof).completed, false);
  assert.equal(lessonState(photoLessons[0], spoof).positionSec, 40);
  assert.equal(open(spoof).adv, false);
});
test("BROKEN prerequisite data is never treated as satisfied (self / missing / later lesson / not a list) — only that lesson is affected", () => {
  const ls = [{ id: "a", title: "A" }, { id: "b", title: "B", prerequisites: ["gone"] }, { id: "c", title: "C", prerequisites: ["d"] }, { id: "d", title: "D" }, { id: "e", title: "E", prerequisites: ["e"] }, { id: "f", title: "F", prerequisites: "a" }, { id: "g", title: "G", prerequisites: ["a"] }];
  const c = { modules: [{ id: "m", lessonIds: ["a", "b", "c", "d", "e", "f", "g"] }] };
  const acc = lessonAccess(c, ls, null);
  assert.deepEqual(acc.map((x) => [x.id, x.accessible, x.broken]), [["a", true, null], ["b", false, "missing"], ["c", false, "order"], ["d", true, null], ["e", false, "self"], ["f", false, "shape"], ["g", false, null]]);
  assert.equal(accessFor(lessonAccess(c, ls, prog(["b"])), "b").accessible, true, "a completion already earned stays reviewable");
  assert.equal(actionableFor(acc, "g").id, "a");
  assert.equal(prerequisiteStatus([{ id: "x", prerequisites: ["y"] }, { id: "y" }]).get("x").broken, "order");
});
test("earlier-lesson rule: the first lesson can't have prerequisites; C may require A/B but not C/D; across sections", () => {
  const ls = ["A", "B", "C", "D"].map((t) => ({ id: t.toLowerCase(), title: t }));
  const two = { modules: [{ id: "s1", lessonIds: ["a", "b"] }, { id: "s2", lessonIds: ["c", "d"] }] };
  const ordered = flatLessons(two, ls);
  assert.deepEqual(eligiblePrerequisites(ordered, "a"), [], "first lesson");
  assert.deepEqual(eligiblePrerequisites(ordered, "c").map((l) => l.id), ["a", "b"], "the first lesson of a later section can require earlier sections");
  const k = (pre) => validatePrerequisites(flatLessons(two, ls.map((l) => (l.id === "c" ? { ...l, prerequisites: pre } : l)))).map((i) => i.kind).sort();
  assert.deepEqual(k(["a"]), []); assert.deepEqual(k(["b"]), []); assert.deepEqual(k(["a", "b"]), []);
  assert.deepEqual(k(["c"]), ["self"]);
  assert.deepEqual(k(["d"]), ["order"]);
  assert.match(validatePrerequisites(flatLessons(two, ls.map((l) => (l.id === "c" ? { ...l, prerequisites: ["d"] } : l))))[0].message, /“C” requires “D”, which comes after it/);
  assert.deepEqual(validatePrerequisites([{ id: "a", title: "A", prerequisites: ["b"] }, { id: "b", title: "B" }]).map((i) => i.kind), ["order"], "the first lesson can't require anything");
});
test("reordering a lesson or a whole section can invalidate a prerequisite (flagged, never silently removed)", () => {
  const ls = [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C", prerequisites: ["a"] }];
  const mods = [{ id: "s1", title: "One", lessonIds: ["a", "b"] }, { id: "s2", title: "Two", lessonIds: ["c"] }];
  const kinds = (m) => validatePrerequisites(flatLessons({ modules: m }, ls)).map((i) => i.kind);
  assert.deepEqual(kinds(mods), []);
  assert.deepEqual(kinds(moveModule(mods, "s2", 0)), ["order"], "section 'Two' dragged above 'One'");
  const lessonFirst = insertLesson(removeLesson(mods, "c"), "c", { moduleId: "s1" });
  assert.deepEqual(kinds([{ ...lessonFirst[0], lessonIds: ["c", "a", "b"] }, lessonFirst[1]]), ["order"], "lesson dragged above its prerequisite");
  assert.deepEqual(ls[2].prerequisites, ["a"], "the relationship itself is untouched");
  const fixed = insertLesson(removeLesson(moveModule(mods, "s2", 0), "c"), "c", { afterId: "a" });
  assert.deepEqual(kinds(fixed), [], "'Move below' fix restores validity");
});
test("dependents for delete warnings; reorder doesn't change prerequisites (stable ids); counters denormalise them", () => {
  assert.deepEqual(dependentsOf(photoLessons, "tri").map((l) => l.id), ["adv"]);
  const moved = { modules: [{ id: "m", lessonIds: ["comp", "tri", "opt", "adv"] }] };
  assert.deepEqual(open(null, photoLessons, moved), open(null), "same availability in any VALID order");
  const renamed = photoLessons.map((l) => (l.id === "tri" ? { ...l, title: "Exposure basics" } : l));
  assert.equal(accessFor(lessonAccess(photo, renamed, null), "adv").blockedBy.title, "Exposure basics", "renaming keeps the relationship (ids)");
  assert.deepEqual(courseCounters(photo, photoLessons).prerequisiteMap, { adv: ["tri"] });
});
test("ready vs completed: requirements in any order; optional extras never block; legacy completions stay completed", () => {
  const outOfOrder = { ...prog(["comp", "tri", "adv"]), progressModel: 2 };
  assert.equal(readyToFinish(photo, photoLessons, outOfOrder).ready, true);
  assert.equal(courseStatus(courseProgress(photo, photoLessons, outOfOrder), outOfOrder), "ready");
  const legacy = prog(["comp", "tri", "adv"]);                       // no progressModel: completed before Finish course
  assert.equal(courseStatus(courseProgress(photo, photoLessons, legacy), legacy), "completed", "never downgraded to ready");
  const finished = { ...outOfOrder, finishedAt: 5 };
  assert.equal(isFinished(finished), true);
  const grown = { ...photo, modules: [{ id: "m", lessonIds: ["tri", "comp", "adv", "opt", "new"] }] };
  assert.equal(courseStatus(courseProgress(grown, [...photoLessons, { id: "new", title: "New" }], finished), finished), "completed", "a lesson added later doesn't un-complete a finished course");
  const started = { ...prog(["comp"]), startedAt: 1, progressModel: 2 };
  assert.equal(courseStatus(courseProgress(photo, photoLessons, started), started), "in-progress");
});
test("resume + learning-path lesson steps use prerequisites", () => {
  assert.equal(resumeLessonId(photo, photoLessons, { lastLessonId: "adv", lessons: {} }), "tri", "a locked last-viewed lesson isn't resumed");
  assert.equal(resumeLessonId(photo, photoLessons, { lastLessonId: "comp", lessons: {} }), "comp");
  const c = { ...photo, prerequisiteMap: { adv: ["tri"] } };
  assert.equal(lessonOpenFromModules(c, null, "comp"), true);
  assert.equal(lessonOpenFromModules(c, null, "adv"), false);
  assert.equal(lessonOpenFromModules(c, prog(["tri"]), "adv"), true);
  assert.equal(lessonOpenFromModules(photo, null, "adv"), true, "a course doc without a prerequisiteMap (pre-v6.5) has no prerequisites");
});
test("next-course suggestion never offers a finished course", () => {
  const cats = mergeCategories([]);
  const a = { id: "a1", title: "A1", status: "published", category: "photography" };
  const b = { id: "b1", title: "B1", status: "published", category: "photography", requiredLessonCount: 2 };
  const me = { id: "u", role: "member", status: "approved" };
  assert.equal(nextCourseSuggestion({ me, current: a, courses: [a, b], categories: cats, progressByCourse: {} })?.course.id, "b1");
  const s = nextCourseSuggestion({ me, current: a, courses: [a, b], categories: cats, progressByCourse: { b1: { finishedAt: 3, lessons: {} } } });
  assert.notEqual(s?.course?.id, "b1");
});
