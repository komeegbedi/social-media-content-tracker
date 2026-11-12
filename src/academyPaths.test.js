/* IFC Creative Academy v2 — categories (shared source of truth + legacy ids),
   topics, quick-guide review state, learning-path validation / resolution /
   progress, and combined continue-learning (pure).
   Run: node --test src/academyPaths.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACADEMY_CATEGORIES, LEGACY_CATEGORY_IDS, ALL_CATEGORY_IDS, normalizeCategory, categoryById, categoryLabel, categoryShort,
  INTRO_CATEGORY, PRACTICAL_CATEGORIES, ONBOARDING_SEQUENCE, CONTENT_FORMATS, formatLabel, normalizeTopics, filterCourses,
  guideReviewed, pathItemKey, validatePathItems, resolvePathItems, pathProgress, nextPathItem, continueLearningCombined,
  guidePublishBlockers, pathPublishBlockers, canViewContent,
} from "./academyProgress.js";
import { readFileSync } from "node:fs";

test("exactly six categories with the agreed names; one intro + five practical; onboarding order", () => {
  assert.deepEqual(ACADEMY_CATEGORIES.map((c) => c.label), [
    "The Heart of Serving", "Photography", "Filmmaking", "Graphic Design", "Social Media & Storytelling", "Creating Together"]);
  assert.equal(INTRO_CATEGORY.id, "heart-of-serving");
  assert.equal(PRACTICAL_CATEGORIES.length, 5);
  assert.ok(ACADEMY_CATEGORIES.every((c) => c.purpose && c.topics.length >= 5));
  assert.deepEqual(ONBOARDING_SEQUENCE, ["heart-of-serving", "creating-together"]);
  // Reels/TikTok/software are NOT categories (they're topics)
  assert.ok(!ACADEMY_CATEGORIES.some((c) => /reel|tiktok|capcut|lightroom/i.test(c.label)));
  assert.deepEqual(CONTENT_FORMATS.map((f) => f.id), ["course", "guide", "path"]);
  assert.equal(formatLabel("guide"), "Quick guide");
});

test("legacy ids read as the new categories (videography → Filmmaking, social-media → Social Media & Storytelling)", () => {
  assert.equal(normalizeCategory("videography"), "filmmaking");
  assert.equal(normalizeCategory("social-media"), "social-media-storytelling");
  assert.equal(normalizeCategory("photography"), "photography");
  assert.equal(categoryLabel("videography"), "Filmmaking");
  assert.equal(categoryLabel("social-media"), "Social Media & Storytelling");
  assert.equal(categoryShort("social-media"), "Social & Storytelling");
  assert.equal(categoryLabel("nope"), "Uncategorised");
  assert.equal(categoryById("graphic-design").label, "Graphic Design");
  assert.ok(ALL_CATEGORY_IDS.includes("videography") && ALL_CATEGORY_IDS.includes("filmmaking"));
});

test("firestore.rules: categories are RECORDS (no fixed name/id allowlist) + the legacy ids stay readable", () => {
  const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
  const m = rules.match(/function validCategory\(c\) \{[\s\S]*?\n    \}/);
  assert.ok(m, "validCategory missing from rules");
  assert.match(m[0], /exists\(\/databases\/\$\(database\)\/documents\/academyCategories\/\$\(c\)\)/, "a category is valid when its record exists");
  const quoted = [...m[0].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
  assert.deepEqual(quoted.sort(), Object.keys(LEGACY_CATEGORY_IDS).sort(), "only the legacy aliases are hard-coded");
  assert.ok(!/'photography'|'filmmaking'/.test(m[0]), "no fixed category allowlist");
});

test("topics: trimmed, de-duplicated case-insensitively, bounded; filter + search cover topics and formats", () => {
  assert.deepEqual(normalizeTopics(" Reels , reels, CapCut,, colour grading "), ["Reels", "CapCut", "colour grading"]);
  assert.equal(normalizeTopics(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 12);
  const items = [
    { id: 1, format: "course", title: "Filming Reels", category: "filmmaking", topics: ["Instagram Reels"] },
    { id: 2, format: "guide", title: "Publishing checklist", category: "social-media", body: "posting times" },
    { id: 3, format: "path", title: "Short-Form Content", category: "", purpose: "idea to posted reel" },
  ];
  assert.deepEqual(filterCourses(items, { q: "instagram" }).map((i) => i.id), [1], "topic search");
  assert.deepEqual(filterCourses(items, { format: "guide" }).map((i) => i.id), [2]);
  assert.deepEqual(filterCourses(items, { category: "social-media-storytelling" }).map((i) => i.id), [2], "legacy id matches new filter");
  assert.deepEqual(filterCourses(items, { q: "reel" }).map((i) => i.id), [1, 3]);
  assert.deepEqual(filterCourses(items, { q: "quick guide" }).map((i) => i.id), [2], "format label is searchable");
  assert.deepEqual(filterCourses(items, { category: "filmmaking", format: "path" }).map((i) => i.id), [], "category and format are independent");
});

test("guide review is a plain self-reported flag", () => {
  assert.equal(guideReviewed(null), false);
  assert.equal(guideReviewed({ reviewed: false }), false);
  assert.equal(guideReviewed({ reviewed: true }), true);
  assert.deepEqual(guidePublishBlockers({ title: "", category: "x", body: "" }).length, 3);
  assert.deepEqual(guidePublishBlockers({ title: "T", category: "photography", body: "", video: { provider: "youtube", id: "x" } }), []);
  assert.deepEqual(guidePublishBlockers({ title: "T", category: "photography", body: "text only" }), []);
});

const me = { id: "u", role: "member", status: "approved" };
const pub = (id, over = {}) => ({ id, title: `Course ${id}`, status: "published", instructorUid: "x", requiredLessonCount: 2, requiredQuizLessonIds: [], bonusLessonIds: [], ...over });
const lesson = (id, over = {}) => ({ id, title: `Lesson ${id}`, video: { provider: "youtube", id: "dQw4w9WgXcQ" }, ...over });
const ctx = (over = {}) => ({
  me,
  courses: { c1: pub("c1"), c2: pub("c2"), draft: pub("draft", { status: "draft" }) },
  lessons: { "c1/l1": lesson("l1"), "c1/l2": lesson("l2"), "draft/l1": lesson("l1") },
  guides: { g1: { id: "g1", title: "Guide 1", status: "published", instructorUid: "x" }, garch: { id: "garch", title: "Archived", status: "archived", instructorUid: "x" } },
  progressByCourse: {}, reviews: {}, ...over,
});

test("validatePathItems: duplicates and course/lesson overlap are rejected; incomplete refs flagged", () => {
  assert.deepEqual(validatePathItems([{ type: "course", courseId: "c1" }, { type: "guide", guideId: "g1" }]), []);
  assert.match(validatePathItems([{ type: "course", courseId: "c1" }, { type: "course", courseId: "c1" }])[0], /already in this path/);
  assert.match(validatePathItems([{ type: "guide", guideId: "g1" }, { type: "guide", guideId: "g1" }])[0], /already/);
  assert.match(validatePathItems([{ type: "course", courseId: "c1" }, { type: "lesson", courseId: "c1", lessonId: "l1" }])[0], /lesson of a course that's already/);
  assert.match(validatePathItems([{ type: "lesson", courseId: "c1" }])[0], /incomplete/);
  assert.match(validatePathItems([{ type: "video", id: "x" }])[0], /incomplete/);
  assert.equal(pathItemKey({ type: "lesson", courseId: "c1", lessonId: "l1" }), "lesson:c1/l1");
  assert.ok(pathPublishBlockers({ title: "", purpose: "", items: [] }).length >= 3);
});

test("resolvePathItems: completion is read from the SOURCE content; unavailable refs never leak titles or count complete", () => {
  const path = { items: [
    { id: "a", type: "guide", guideId: "g1", required: true, label: "Plan" },
    { id: "b", type: "lesson", courseId: "c1", lessonId: "l1", required: true },
    { id: "c", type: "course", courseId: "c2", required: true },
    { id: "d", type: "lesson", courseId: "draft", lessonId: "l1", required: true, label: "Bonus draft" },
    { id: "e", type: "guide", guideId: "garch", required: false },
    { id: "f", type: "guide", guideId: "missing", required: true },
    { id: "g", type: "lesson", courseId: "c1", lessonId: "gone", required: false },
  ] };
  const r = resolvePathItems(path, ctx({
    reviews: { g1: { reviewed: true } },
    progressByCourse: { c1: { lessons: { l1: { videoWatched: true } } }, c2: { startedAt: 1, lessons: { x: { videoWatched: true } } } },
  }));
  assert.deepEqual(r.map((i) => [i.available, i.completed]), [[true, true], [true, true], [true, false], [false, false], [false, false], [false, false], [false, false]]);
  assert.equal(r[0].title, "Plan", "editor label wins");
  assert.equal(r[1].title, "Lesson l1");
  assert.equal(r[3].title, "Bonus draft", "only the path's own label is shown for an unavailable item");
  assert.equal(r[4].title, "", "no title leaks from an archived guide");
  assert.equal(r[2].percent, 50);
  const s = pathProgress(r);
  // 5 required steps (a, b, c, d, f): 3 reachable, 2 done, 2 unavailable → 40 %, not complete
  assert.deepEqual([s.total, s.available, s.done, s.unavailable, s.percent, s.completed, s.blocked], [5, 3, 2, 2, 40, false, false]);
  assert.equal(s.optionalTotal, 2);
  assert.equal(nextPathItem(r).key, "course:c2");
  // the instructor sees their draft → it becomes available (and incomplete)
  const asEditor = resolvePathItems(path, ctx({ me: { id: "x", role: "member", status: "approved", academyEditor: true } }));
  assert.equal(asEditor[3].available, true);
  assert.equal(asEditor[3].title, "Bonus draft");
  // completing everything available → completed, with the unavailable count surfaced
  const all = resolvePathItems(path, ctx({
    reviews: { g1: { reviewed: true } },
    progressByCourse: { c1: { lessons: { l1: { videoWatched: true } } }, c2: { startedAt: 1, lessons: { x: { videoWatched: true }, y: { manualDone: true } } } },
  }));
  const done = pathProgress(all);
  assert.equal(done.completed, false, "unavailable REQUIRED steps block completion — never silently complete");
  assert.equal(done.blocked, true); assert.equal(done.unavailable, 2);
  assert.equal(nextPathItem(all).key, "guide:g1", "a completed path 'continues' at its first available step");
  assert.deepEqual(pathProgress([]), { total: 0, available: 0, done: 0, unavailable: 0, percent: 0, completed: false, blocked: false, optionalDone: 0, optionalTotal: 0, started: false });
});

test("editing a path preserves earned completion (completion is keyed by the source, not the path)", () => {
  const before = { items: [{ id: "a", type: "lesson", courseId: "c1", lessonId: "l1", required: true }] };
  const after = { items: [{ id: "z", type: "guide", guideId: "g1", required: true }, { id: "a", type: "lesson", courseId: "c1", lessonId: "l1", required: true }] };
  const c = ctx({ progressByCourse: { c1: { lessons: { l1: { videoWatched: true } } } } });
  assert.equal(pathProgress(resolvePathItems(before, c)).completed, true);
  const s = pathProgress(resolvePathItems(after, c));
  assert.equal(s.done, 1); assert.equal(s.total, 2); assert.equal(s.completed, false, "a new required step appears as outstanding, nothing lost");
});

test("a path never grants access: a learner can't view a draft course referenced by a published path", () => {
  assert.equal(canViewContent(me, pub("draft", { status: "draft" })), false);
  assert.equal(canViewContent(me, { status: "published" }), true);
});

test("continue learning: path + course entries de-duplicate on the same next action, newest first", () => {
  const courseEntries = [{ course: pub("c1"), summary: { percent: 10 }, lastViewedMs: 100 }, { course: pub("c9"), summary: { percent: 40 }, lastViewedMs: 300 }];
  const pathEntries = [{ path: { id: "p" }, summary: { percent: 20 }, next: { type: "lesson", courseId: "c1" }, lastViewedMs: 200 }];
  const out = continueLearningCombined({ courseEntries, pathEntries });
  assert.deepEqual(out.map((e) => e.kind + ":" + (e.course?.id || e.path.id)), ["course:c9", "path:p"], "c1 is folded into the path that points at it");
  const none = continueLearningCombined({ courseEntries, pathEntries: [{ path: { id: "q" }, summary: {}, next: { type: "guide", guideId: "g" }, lastViewedMs: 1 }] });
  assert.equal(none.length, 3);
});
