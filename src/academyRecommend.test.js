/* IFC Creative Academy — home-screen selection logic (pure, deterministic):
   recommendations with honest reasons, de-duplication, new-user fallback,
   recently-published ordering/access, category counts, next-lesson-from-modules,
   lesson kinds. Run: node --test src/academyRecommend.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendations, recentlyPublished, categoryCounts, continueTargets, departmentCategories } from "./academyRecommend.js";
import { nextLessonIdFromModules, lessonKind, lessonKindMeta, lessonState, LESSON_KINDS } from "./academyProgress.js";

const me = { id: "u", role: "member", status: "approved", department: "Photography" };
const inst = { id: "i", role: "member", status: "approved" };
const course = (id, over = {}) => ({
  id, title: `Course ${id}`, status: "published", category: "photography", level: "beginner", instructorUid: "i",
  modules: [{ id: "m", lessonIds: ["l1", "l2", "l3"] }], requiredLessonCount: 3, requiredQuizLessonIds: [], bonusLessonIds: [],
  publishedAt: 1000, ...over,
});

test("continue: the next unfinished lesson of a started course, with 'Continue learning' / 'Because you started' reasons", () => {
  const courses = [course("a"), course("b")];
  const progressByCourse = { a: { startedAt: 1, lastLessonId: "l1", lastViewedAt: 500, lessons: { l1: { videoWatched: true } } } };
  const lessonsById = { "a/l2": { id: "l2", title: "Second lesson" } };
  const recs = recommendations({ me, courses, progressByCourse, lessonsById });
  assert.equal(recs[0].kind, "continue");
  assert.equal(recs[0].course.id, "a");
  assert.equal(recs[0].lessonId, "l2");
  assert.equal(recs[0].lesson.title, "Second lesson");
  assert.equal(recs[0].reason, "Continue learning");
  const fresh = recommendations({ me, courses, progressByCourse: { a: { startedAt: 1, lessons: {} } }, lessonsById: {} });
  assert.equal(fresh[0].reason, "Because you started Course a");
  assert.equal(fresh[0].lessonId, "l1");
});

test("department relevance, de-duplication, caps at max, never suggests started or draft courses", () => {
  const courses = [course("a"), course("b", { level: "advanced" }), course("c", { category: "filmmaking" }), course("d", { status: "draft" }), course("e", { level: "intermediate" })];
  const recs = recommendations({ me, courses, progressByCourse: { a: { startedAt: 1, lessons: {} } }, lessonsById: {}, max: 3 });
  assert.equal(recs.length, 3);
  assert.deepEqual(recs.map((r) => r.course.id), ["a", "e", "b"], "continue first, then department courses beginner→advanced; filmmaking + draft excluded");
  assert.equal(recs[1].reason, "For the photography team");
  assert.equal(new Set(recs.map((r) => r.course.id)).size, recs.length, "no duplicates");
  const asInstructor = recommendations({ me: { ...inst, department: "Photography" }, courses, progressByCourse: {}, lessonsById: {}, max: 4 });
  assert.ok(!asInstructor.some((r) => r.course.id === "d"), "drafts are never recommended, not even to their editor — recommendations are published content only");
});

test("new learner without a department: onboarding categories first, then a neutral 'Explore'", () => {
  const courses = [course("x", { category: "graphic-design" }), course("h", { category: "heart-of-serving" }), course("t", { category: "creating-together", level: "intermediate" })];
  const recs = recommendations({ me: { id: "n", role: "member", status: "approved" }, courses, progressByCourse: {}, lessonsById: {} });
  assert.deepEqual(recs.map((r) => [r.course.id, r.reason]), [["h", "Recommended for new members"], ["t", "Start with Creating Together"]]);
  const only = recommendations({ me: { id: "n", role: "member", status: "approved" }, courses: [course("x", { category: "graphic-design" })], progressByCourse: {}, lessonsById: {} });
  assert.deepEqual(only.map((r) => r.reason), ["Explore"]);
  assert.deepEqual(recommendations({ me, courses: [], progressByCourse: {}, lessonsById: {} }), []);
});

test("requirements done but not finished → 'Ready to finish' (to the course page); finished → review suggestions; a QA member maps to Creating Together", () => {
  // progressModel 2 = written by v6.5 server functions (not a legacy completion)
  const done = { startedAt: 1, lastViewedAt: 9, progressModel: 2, lessons: { l1: { videoWatched: true }, l2: { manualDone: true }, l3: { videoWatched: true } } };
  const legacy = recommendations({ me, courses: [course("a")], progressByCourse: { a: { ...done, progressModel: undefined } }, lessonsById: {} });
  assert.equal(legacy[0].kind, "review", "a legacy completion (no marker) is completed, never 'ready to finish'");
  const ready = recommendations({ me, courses: [course("a")], progressByCourse: { a: done }, lessonsById: {} });
  assert.equal(ready[0].kind, "continue"); assert.equal(ready[0].ready, true); assert.equal(ready[0].reason, "Ready to finish");
  assert.equal(ready[0].lessonId, null, "a ready course opens its overview (Finish course), not a bonus lesson");
  const recs = recommendations({ me, courses: [course("a")], progressByCourse: { a: { ...done, finishedAt: 10 } }, lessonsById: {} });
  assert.equal(recs[0].kind, "review"); assert.match(recs[0].reason, /^Completed/);
  assert.deepEqual(departmentCategories({ departments: ["QA", "Videography", "Nope"] }), ["creating-together", "filmmaking"]);
  assert.deepEqual(departmentCategories({}), []);
});

test("continueTargets: most recent first, bounded; finished courses dropped, ready-to-finish ones kept", () => {
  const courses = [course("a"), course("b"), course("c"), course("d")];
  const p = (lv, extra = {}) => ({ startedAt: 1, lastViewedAt: lv, lessons: {}, ...extra });
  const all3 = { progressModel: 2, lessons: { l1: { videoWatched: true }, l2: { videoWatched: true }, l3: { videoWatched: true } } };
  const finished = continueTargets(courses, { a: p(1), b: p(4), c: p(3), d: p(9, { ...all3, finishedAt: 10 }) });
  assert.deepEqual(finished.map((x) => x.course.id), ["b", "c", "a"]);
  const ready = continueTargets(courses, { a: p(1), b: p(4), c: p(3), d: p(9, all3) });
  assert.deepEqual(ready.map((x) => [x.course.id, x.ready]), [["d", true], ["b", false], ["c", false]]);
});

test("nextLessonIdFromModules: course order as a suggestion; prerequisites (from prerequisiteMap) are the only locks", () => {
  const c = course("a", { modules: [{ id: "m1", lessonIds: ["l1", "l2"] }, { id: "m2", lessonIds: ["q", "bonus"] }], bonusLessonIds: ["bonus"], requiredQuizLessonIds: ["q"] });
  assert.equal(nextLessonIdFromModules(c, null), "l1");
  assert.equal(nextLessonIdFromModules(c, { lastLessonId: "l2", lessons: {} }), "l2", "no prerequisites → the last viewed lesson is open");
  assert.equal(nextLessonIdFromModules(c, { lastLessonId: "l2", lessons: { l1: { manualDone: true }, l2: { videoWatched: true } } }), "q");
  assert.equal(nextLessonIdFromModules(c, { lessons: { l1: { videoWatched: true }, l2: { videoWatched: true }, q: { videoWatched: true } } }), "q", "watching doesn't finish a required-quiz lesson");
  assert.equal(nextLessonIdFromModules(c, { lessons: { l1: { videoWatched: true }, l2: { videoWatched: true } }, earned: { q: {} } }), "bonus");
  assert.equal(nextLessonIdFromModules(c, { lessons: { l1: { videoWatched: true }, l2: { videoWatched: true }, bonus: { manualDone: true } }, earned: { q: {} } }), null);
  const withPre = { ...c, prerequisiteMap: { l2: ["l1"] } };
  assert.equal(nextLessonIdFromModules(withPre, { lastLessonId: "l2", lessons: {} }), "l1", "a LOCKED last-viewed lesson isn't offered");
  assert.equal(nextLessonIdFromModules({ ...withPre, prerequisiteMap: { l1: ["l2"] } }, { lastLessonId: "l1", lessons: {} }), "l2", "broken data (l1 needs a LATER lesson) isn't treated as satisfied: l1 is skipped");
  const reordered = { ...c, modules: [{ id: "m2", lessonIds: ["q"] }, { id: "m1", lessonIds: ["l2", "l1"] }, { id: "m3", lessonIds: ["bonus"] }] };
  assert.equal(nextLessonIdFromModules(reordered, null), "q");
});

test("recentlyPublished: publication date ordering, drafts/archived/inaccessible excluded, guides labelled", () => {
  const courses = [course("old", { publishedAt: 100 }), course("new", { publishedAt: 900 }), course("d", { status: "draft", publishedAt: 950 }), course("arch", { status: "archived", publishedAt: 960 }), course("nopub", { publishedAt: null, updatedAt: 999 })];
  const guides = [{ id: "g", title: "G", status: "published", instructorUid: "i", publishedAt: 500 }];
  const r = recentlyPublished({ me, courses, guides });
  assert.deepEqual(r.map((x) => `${x.item.format}:${x.item.id}`), ["course:new", "guide:g", "course:old"]);
  assert.equal(recentlyPublished({ me, courses, guides, limit: 1 }).length, 1);
  assert.equal(recentlyPublished({ me, courses, guides, now: 1000, maxAgeDays: 1 }).length, 3);
  assert.equal(recentlyPublished({ me: { id: "p", role: "member", status: "pending" }, courses, guides }).length, 0, "a pending account sees nothing");
});

test("categoryCounts counts only accessible published courses, normalising legacy ids", () => {
  const courses = [course("a"), course("b", { category: "videography" }), course("c", { category: "filmmaking" }), course("d", { status: "draft", category: "filmmaking" }), course("e", { category: "social-media" })];
  assert.deepEqual(categoryCounts(me, courses), { photography: 1, filmmaking: 2, "social-media-storytelling": 1 });
  assert.deepEqual(categoryCounts(inst, courses).filmmaking, 2, "counts are PUBLISHED courses only, even for the draft's editor");
});

test("lesson kinds: derived for legacy lessons; each kind completes by its own explicit action; links never add requirements", () => {
  assert.deepEqual(LESSON_KINDS.map((k) => k.id), ["video", "written", "exercise", "resource"]);
  assert.equal(lessonKind({ video: { provider: "youtube", id: "x" } }), "video");
  assert.equal(lessonKind({ video: null }), "written");
  assert.equal(lessonKind({ kind: "exercise", video: null }), "exercise");
  assert.equal(lessonKind({ kind: "bogus", video: null }), "written");
  assert.equal(lessonKindMeta({ kind: "resource" }).doneLabel, "Mark as reviewed");
  for (const kind of ["written", "exercise", "resource"]) {
    const l = { id: "x", kind, video: null, resources: [{ label: "r", url: "https://x.io" }] };
    assert.equal(lessonState(l, null).completed, false, kind);
    assert.equal(lessonState(l, { lessons: { x: { viewedAt: 1 } } }).completed, false, `${kind}: viewing is not completing`);
    assert.equal(lessonState(l, { lessons: { x: { manualDone: true } } }).completed, true, `${kind}: explicit self-report completes`);
    assert.equal(lessonState(l, null).kind, kind);
  }
  const video = { id: "v", kind: "video", video: { provider: "youtube", id: "x" }, resources: [{ label: "r", url: "https://x.io" }] };
  assert.equal(lessonState(video, { lessons: { v: { positionSec: 999 } } }).completed, false);
  assert.equal(lessonState(video, { lessons: { v: { videoWatched: true } } }).completed, true);
});
