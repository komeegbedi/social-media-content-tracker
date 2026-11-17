/* IFC Creative Academy — completion, progress %, ordering, roles, quiz
   validation (pure). Run: node --test src/academyProgress.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orderedCurriculum, flatLessons, lessonState, courseProgress, resumeLessonId, lessonNeighbours, continueLearning,
  estimateProgress, courseCounters, validateQuizAnswers, canAttemptQuiz, filterCourses, publishBlockers,
  canEditCourse, canViewCourse, canViewLearnerProgress, quizMode,
} from "./academyProgress.js";

const L = (id, over = {}) => ({ id, title: id, video: { provider: "youtube", id: "dQw4w9WgXcQ" }, ...over });
const quiz = (mode, n = 2) => ({ mode, passMark: 70, questions: Array.from({ length: n }, (_, i) => ({ id: `q${i}`, prompt: "?", multi: false, options: [{ id: "a", text: "A" }, { id: "b", text: "B" }] })) });
const course = { id: "c1", status: "published", instructorUid: "inst", modules: [
  { id: "m1", title: "Basics", lessonIds: ["l1", "l2"] },
  { id: "m2", title: "More", lessonIds: ["l3", "bonus"] },
], requiredLessonCount: 3 };
const lessons = [L("l3"), L("l1"), L("l2", { quiz: quiz("required") }), L("bonus", { bonus: true }), L("orphan")];

test("curriculum order comes from course.modules; unlisted lessons are appended, never lost", () => {
  const cur = orderedCurriculum(course, lessons);
  assert.deepEqual(cur.map((m) => m.lessons.map((l) => l.id)), [["l1", "l2"], ["l3", "bonus"], ["orphan"]]);
  assert.equal(cur[2].implicit, true);
  assert.deepEqual(flatLessons(course, lessons).map((l) => l.id), ["l1", "l2", "l3", "bonus", "orphan"]);
  // a module referencing a deleted lesson id simply skips it
  assert.deepEqual(flatLessons({ modules: [{ id: "m", lessonIds: ["gone", "l1"] }] }, lessons).map((l) => l.id), ["l1", "l3", "l2", "bonus", "orphan"]);
});

test("lesson completion rules: video watched / manual done / required quiz earned", () => {
  const plain = L("p");
  assert.equal(lessonState(plain, null).completed, false);
  assert.equal(lessonState(plain, { lessons: { p: { positionSec: 300 } } }).completed, false, "seeking/position never completes");
  assert.equal(lessonState(plain, { lessons: { p: { videoWatched: true } } }).completed, true);
  assert.equal(lessonState(plain, { lessons: { p: { manualDone: true } } }).completed, true);

  const req = L("r", { quiz: quiz("required") });
  const watched = { lessons: { r: { videoWatched: true, manualDone: true } } };
  const st = lessonState(req, watched);
  assert.equal(st.completed, false, "watching (or manual) never completes a required-quiz lesson");
  assert.equal(st.videoWatched, true);
  assert.equal(st.pending, "quiz");
  assert.equal(lessonState(req, { ...watched, earned: { r: { at: 1 } } }).completed, true);
  assert.equal(lessonState(req, { earned: { r: { at: 1 } } }).completed, true, "passing the quiz completes even without the video");

  const practice = L("x", { quiz: quiz("practice") });
  assert.equal(lessonState(practice, { earned: { x: {} } }).completed, false, "practice never gates and never completes by itself");
  assert.equal(lessonState(practice, { lessons: { x: { videoWatched: true } } }).completed, true);

  const noVideo = L("n", { video: null });
  assert.equal(lessonState(noVideo, null).pending, "manual");
  assert.equal(lessonState(noVideo, { lessons: { n: { manualDone: true } } }).completed, true);
});

test("quizMode treats an empty question list as none", () => {
  assert.equal(quizMode({ quiz: { mode: "required", questions: [] } }), "none");
  assert.equal(quizMode({ quiz: quiz("required") }), "required");
  assert.equal(quizMode({}), "none");
});

test("course % counts REQUIRED lessons only; bonus excluded; earned entries survive edits", () => {
  const p = { startedAt: 1, lessons: { l1: { videoWatched: true }, bonus: { manualDone: true } }, earned: { l2: { at: 1 } } };
  const s = courseProgress(course, lessons, p);
  // required = l1, l2, l3, orphan (4); done = l1 (watched), l2 (earned)
  assert.equal(s.total, 4); assert.equal(s.done, 2); assert.equal(s.percent, 50);
  assert.equal(s.bonusTotal, 1); assert.equal(s.bonusDone, 1); assert.equal(s.completed, false);
  // a new lesson appears as upcoming and lowers the % without resetting anything
  const more = [...lessons, L("new")];
  assert.equal(courseProgress(course, more, p).percent, 40);
  // removing a lesson the learner earned keeps the earned entry harmlessly
  const fewer = lessons.filter((l) => l.id !== "l2");
  assert.equal(courseProgress(course, fewer, p).done, 1);
  assert.equal(courseProgress({ modules: [] }, [], p).percent, 0, "empty course never divides by zero");
});

test("resume + neighbours", () => {
  const p = { lastLessonId: "l2", lessons: { l1: { videoWatched: true } } };
  assert.equal(resumeLessonId(course, lessons, p), "l2", "last viewed, still incomplete");
  assert.equal(resumeLessonId(course, lessons, { lastLessonId: "gone" }), "l1", "stale last id → first incomplete");
  const allDone = { lessons: Object.fromEntries(lessons.map((l) => [l.id, { videoWatched: true }])), earned: { l2: {} } };
  assert.equal(resumeLessonId(course, lessons, allDone), "l1", "completed course → revisit from the top");
  assert.equal(resumeLessonId({ modules: [] }, [], null), null);
  const nb = lessonNeighbours(course, lessons, "l2");
  assert.equal(nb.prev.id, "l1"); assert.equal(nb.next.id, "l3"); assert.equal(nb.index, 1); assert.equal(nb.count, 5);
  assert.equal(lessonNeighbours(course, lessons, "l1").prev, null);
  assert.equal(lessonNeighbours(course, lessons, "orphan").next, null);
});

test("continue learning lists started, unfinished, published courses — most recent first", () => {
  const c2 = { ...course, id: "c2" }, draft = { ...course, id: "d", status: "draft" };
  const prog = {
    c1: { startedAt: 1, lastViewedAt: 1000, lessons: {} },
    c2: { startedAt: 1, lastViewedAt: 5000, lessons: {} },
    d: { startedAt: 1, lastViewedAt: 9000, lessons: {} },
  };
  const out = continueLearning([course, c2, draft], prog, { c1: lessons, c2: lessons });
  assert.deepEqual(out.map((x) => x.course.id), ["c2", "c1"]);
  // finished courses drop out
  const done = { startedAt: 1, lastViewedAt: 1, lessons: Object.fromEntries(lessons.map((l) => [l.id, { videoWatched: true }])), earned: { l2: {} } };
  assert.equal(continueLearning([course], { c1: done }, { c1: lessons }).length, 0);
  assert.equal(continueLearning([course], {}, {}).length, 0, "never started → not listed");
});

test("estimateProgress + courseCounters agree with the full computation", () => {
  const counters = courseCounters(course, lessons);
  assert.equal(counters.lessonCount, 5);
  assert.equal(counters.requiredLessonCount, 4);
  assert.deepEqual(counters.requiredQuizLessonIds, ["l2"]);
  assert.deepEqual(counters.bonusLessonIds, ["bonus"]);
  const p = { startedAt: 1, lessons: { l1: { videoWatched: true }, l2: { videoWatched: true }, bonus: { manualDone: true } }, earned: {} };
  const est = estimateProgress({ ...course, ...counters }, p);
  const full = courseProgress(course, lessons, p);
  assert.equal(est.done, full.done, "l2 is a required-quiz lesson: watched ≠ complete in both");
  assert.equal(est.percent, full.percent);
  assert.equal(estimateProgress({ ...course, ...counters }, null).started, false);
});

test("quiz answer validation (client) rejects blanks, unknown options and multi-select on single", () => {
  const q = quiz("required");
  assert.equal(validateQuizAnswers(q, {}).ok, false);
  assert.equal(validateQuizAnswers(q, { q0: ["a"], q1: ["zzz"] }).ok, false);
  assert.equal(validateQuizAnswers(q, { q0: ["a", "b"], q1: ["a"] }).ok, false);
  const v = validateQuizAnswers(q, { q0: ["a"], q1: ["b", "b"] });
  assert.equal(v.ok, true); assert.deepEqual(v.answers, { q0: ["a"], q1: ["b"] });
});

test("retry policy: 0 = unlimited; staff-granted extra attempts add to a limit", () => {
  assert.deepEqual(canAttemptQuiz({ retryLimit: 0 }, 99), { ok: true, remaining: null, allowed: null, used: 99 });
  assert.deepEqual(canAttemptQuiz({ retryLimit: 2 }, 1), { ok: true, remaining: 1, allowed: 2, used: 1 });
  assert.deepEqual(canAttemptQuiz({ retryLimit: 2 }, 2), { ok: false, remaining: 0, allowed: 2, used: 2 });
  assert.deepEqual(canAttemptQuiz({ retryLimit: 3 }, 3, 1), { ok: true, remaining: 1, allowed: 4, used: 3 }, "one extra attempt granted");
});

test("roles: editor = admin or instructor; drafts invisible to learners; leaders = admin or lead", () => {
  const admin = { id: "a", role: "admin", status: "approved" };
  const inst = { id: "inst", role: "member", status: "approved", academyEditor: true };   // v4: global editor role
  const exinst = { id: "inst", role: "member", status: "approved" };                       // matches instructorUid, no role
  const member = { id: "m", role: "member", status: "approved" };
  const pending = { id: "p", role: "member", status: "pending" };
  const lead = { id: "l", role: "member", status: "approved", lead: true };
  const disabledAdmin = { id: "x", role: "admin", status: "removed", disabled: true };
  const draft = { ...course, status: "draft" };
  assert.equal(canEditCourse(admin, draft), true);
  assert.equal(canEditCourse(inst, draft), true);
  assert.equal(canEditCourse(member, draft), false);
  assert.equal(canEditCourse(disabledAdmin, draft), false);
  assert.equal(canViewCourse(member, course), true);
  assert.equal(canViewCourse(member, draft), false);
  assert.equal(canViewCourse(inst, draft), true);
  assert.equal(canEditCourse(exinst, draft), false, "instructorUid on a course no longer grants editing");
  assert.equal(canViewCourse(exinst, draft), false);
  assert.equal(canViewCourse(member, { ...course, category: "photography" }, ["photography"]), false, "hidden category hides a published course");
  assert.equal(canViewCourse(member, { ...course, category: "videography" }, ["filmmaking"]), false, "legacy id follows its category");
  assert.equal(canViewCourse(inst, { ...course, category: "photography" }, ["photography"]), true, "editors keep access");
  assert.equal(canViewCourse(pending, course), false);
  assert.equal(canViewLearnerProgress(lead), true);
  assert.equal(canViewLearnerProgress(member), false);
  assert.equal(canViewLearnerProgress(admin), true);
});

test("catalogue filter: text over title/instructor/category, plus category/level", () => {
  const cs = [{ id: 1, title: "Lighting basics", category: "photography", level: "beginner", instructorName: "Ada" },
              { id: 2, title: "Reels that land", category: "social-media", level: "intermediate", instructorName: "Bo" }];
  assert.deepEqual(filterCourses(cs, { q: "photo" }).map((c) => c.id), [1]);
  assert.deepEqual(filterCourses(cs, { q: "bo" }).map((c) => c.id), [2]);
  assert.deepEqual(filterCourses(cs, { category: "social-media" }).map((c) => c.id), [2]);
  assert.deepEqual(filterCourses(cs, { level: "beginner", q: "reels" }).map((c) => c.id), []);
});

test("publishBlockers names every missing piece", () => {
  const b = publishBlockers({ title: "", category: "x", level: "beginner", cover: null, modules: [] }, []);
  assert.ok(b.some((s) => /title/.test(s)));
  assert.ok(b.some((s) => /category/.test(s)));
  assert.ok(b.some((s) => /cover/.test(s)));
  assert.ok(b.some((s) => /lesson/.test(s)));
  const ok = publishBlockers({ title: "T", category: "photography", level: "beginner", cover: { path: "academy/covers/c/v.jpg" }, modules: [{ id: "m", lessonIds: ["l1"] }] }, [L("l1")]);
  assert.deepEqual(ok, []);
  // admin-created categories count once their record exists
  assert.deepEqual(publishBlockers({ title: "T", category: "lighting-ab12", level: "beginner", cover: { path: "p" }, modules: [{ id: "m", lessonIds: ["l1"] }] }, [L("l1")], ["photography", "lighting-ab12"]), []);
  assert.ok(publishBlockers({ title: "T", category: "lighting-ab12", level: "beginner", cover: { path: "p" }, modules: [{ id: "m", lessonIds: ["l1"] }] }, [L("l1")], ["photography"]).includes("Choose a category."));
  const badQuiz = publishBlockers({ title: "T", category: "photography", level: "beginner", cover: { path: "p" }, modules: [{ id: "m", lessonIds: ["q"] }] },
    [L("q", { quiz: { mode: "required", questions: [{ id: "a", prompt: "", options: [] }] } })]);
  assert.ok(badQuiz.length >= 1);
});

test("publishIssues: structured, field-addressable; the old blocker wording is unchanged", async () => {
  const { publishIssues, categoryIdFromName } = await import("./academyProgress.js");
  const course = { title: "", category: "photography", level: "beginner", cover: null, modules: [{ id: "m", lessonIds: ["v", "q"] }] };
  const lessons = [
    { id: "v", title: "", kind: "video", video: null },
    { id: "q", title: "Quiz me", kind: "written", quiz: { mode: "required", questions: [{ id: "x", prompt: "Which?", options: [{ id: "o1", text: "A" }, { id: "o2", text: "B" }] }] }, quizKey: { answers: {} } },
  ];
  const is = publishIssues(course, lessons, ["photography"]);
  const byKey = Object.fromEntries(is.map((i) => [i.key, i]));
  assert.equal(byKey.title.item, "details"); assert.equal(byKey.title.field, "title");
  assert.equal(byKey.cover.label, "Course cover"); assert.equal(byKey.cover.message, "Add a cover image before publishing.");
  assert.equal(byKey.cover.blocker, "Upload a cover image.");                                 // publish errors keep their wording
  assert.equal(byKey["lt:v"].item, "v");
  assert.equal(byKey["lv:v"].field, "video");                                                 // a video lesson needs its link
  assert.equal(byKey["qa:q"].kind, "quiz");                                                   // no correct answer marked → unpassable
  assert.equal(byKey["qa:q"].field, "qa:x");
  assert.ok(!is.some((i) => i.kind === "missing" && i.field === "category"));
  // a quiz with no questions isn't an issue (it counts as no quiz); a correct answer that refers to a removed option doesn't count
  const q2 = [{ id: "q", title: "T", quiz: { mode: "practice", questions: [] } }];
  assert.ok(publishIssues({ ...course, title: "T", cover: { path: "p" }, modules: [{ id: "m", lessonIds: ["q"] }] }, q2, ["photography"]).length === 0);   // empty quiz = no quiz
  const q3 = [{ id: "q", title: "T", quiz: { mode: "required", questions: [{ id: "x", prompt: "?", options: [{ id: "o1" }, { id: "o2" }] }] }, quizKey: { answers: { x: ["gone"] } } }];
  assert.ok(publishIssues({ ...course, title: "T", cover: { path: "p" }, modules: [{ id: "m", lessonIds: ["q"] }] }, q3, ["photography"]).some((i) => i.key === "qa:q"));
  const ok = [{ id: "q", title: "T", quiz: { mode: "required", questions: [{ id: "x", prompt: "?", options: [{ id: "o1" }, { id: "o2" }] }] }, quizKey: { answers: { x: ["o2"] } } }];
  assert.deepEqual(publishIssues({ ...course, title: "T", cover: { path: "p" }, modules: [{ id: "m", lessonIds: ["q"] }] }, ok, ["photography"]), []);
  // non-video kinds never need a link; legacy lessons without a kind aren't flagged
  assert.ok(!publishIssues({ ...course, title: "T", cover: { path: "p" }, modules: [{ id: "m", lessonIds: ["w"] }] }, [{ id: "w", title: "W", kind: "written" }], ["photography"]).length);
  // new category ids: ≤ 40 chars (rules), digits allowed
  const long = categoryIdFromName("A very long category name that keeps going and going", "k3x9");
  assert.ok(long.length <= 40 && /^[a-z0-9-]+$/.test(long), long);
  assert.equal(categoryIdFromName("Testing 123", "ab12"), "testing-123-ab12");
});
