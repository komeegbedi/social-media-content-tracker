/* IFC Creative Academy v4 — editable category/topic records (pure):
   bootstrap vs records, renames, hidden categories/topics, stable-id intro,
   legacy tag compatibility, and hidden-category gating on every learner surface
   that's computed client-side (counts, recommendations, recent, paths).
   Run: node --test src/academyTaxonomy.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeCategories, categoryIn, categoryNameIn, categoryShortIn, INTRO_CATEGORY_ID, slugId, nameKey,
  topicChips, topicNamesFor, hasTopic, matchTopicIds, defaultCategoryRecords, resolvePathItems, pathProgress, isAcademyEditor,
} from "./academyProgress.js";
import { recommendations, recentlyPublished, categoryCounts } from "./academyRecommend.js";

const me = { id: "u", role: "member", status: "approved", department: "Videography" };

test("bootstrap: with no records the six starter categories render (Heart of Serving included, featured by stable id)", () => {
  const list = mergeCategories([]);
  assert.equal(list.length, 6);
  assert.equal(list[0].id, INTRO_CATEGORY_ID);
  assert.equal(list[0].intro, true);
  assert.ok(list.every((c) => !c.hidden));
  assert.deepEqual(defaultCategoryRecords().map((r) => r.id), list.map((c) => c.id));
});

test("records are authoritative: order, rename (label follows name, id stable), hidden, new categories, deleted defaults stay deleted", () => {
  const recs = [
    { id: "filmmaking", name: "Film & Video", description: "renamed", order: 1 },
    { id: "heart-of-serving", name: "Why We Serve", order: 0 },
    { id: "audio", name: "Audio", order: 2 },
    { id: "photography", name: "Photography", order: 3, hidden: true },
  ];
  const list = mergeCategories(recs);
  assert.deepEqual(list.map((c) => c.id), ["heart-of-serving", "filmmaking", "audio", "photography"]);
  assert.equal(categoryNameIn(list, "filmmaking"), "Film & Video");
  assert.equal(categoryNameIn(list, "videography"), "Film & Video", "legacy id resolves to the renamed record");
  assert.equal(categoryIn(list, "heart-of-serving").intro, true, "the featured category is found by id, whatever its name");
  assert.equal(categoryIn(list, "photography").hidden, true);
  assert.equal(categoryIn(list, "graphic-design"), null, "a default with no record (deleted) doesn't come back");
  assert.equal(categoryShortIn(list, "audio"), "Audio");
  assert.equal(categoryIn(list, "audio").description, "", "new categories may have no description");
});

test("slug ids + duplicate-name keys", () => {
  assert.equal(slugId("Social Media & Storytelling"), "social-media-and-storytelling");
  assert.equal(slugId("  Café  Lighting!! "), "cafe-lighting");
  assert.equal(slugId(""), "category");
  assert.equal(nameKey("  Colour   Grading "), nameKey("colour grading"));
});

test("topic chips: record names (renames apply), hidden topics omitted but associations kept, legacy tags matched by name", () => {
  const byId = {
    "colour-grading": { id: "colour-grading", name: "Colour grading & LUTs" },
    capcut: { id: "capcut", name: "CapCut", hidden: true },
    reels: { id: "reels", name: "Instagram Reels" },
  };
  const item = { topicIds: ["colour-grading", "capcut"], topics: ["instagram reels", "Lighting"] };
  assert.deepEqual(topicChips(item, byId), [{ id: "colour-grading", name: "Colour grading & LUTs" }, { id: "reels", name: "Instagram Reels" }, { id: null, name: "Lighting" }]);
  assert.deepEqual(topicNamesFor(item, byId), ["Colour grading & LUTs", "Instagram Reels", "Lighting"]);
  assert.ok(item.topicIds.includes("capcut"), "hiding never removes the association");
  assert.equal(hasTopic(item, byId.reels), true, "legacy string matches a record");
  assert.equal(hasTopic(item, byId["colour-grading"]), true);
  assert.equal(hasTopic({ topicIds: [] }, byId.reels), false);
  assert.deepEqual(matchTopicIds(["Instagram Reels", "nope"], byId), ["reels"]);
  // restoring the hidden topic brings it straight back
  assert.ok(topicChips(item, { ...byId, capcut: { ...byId.capcut, hidden: false } }).some((t) => t.id === "capcut"));
});

const course = (id, over = {}) => ({ id, title: `Course ${id}`, status: "published", category: "filmmaking", level: "beginner", modules: [{ id: "m", lessonIds: ["l1"] }], requiredLessonCount: 1, requiredQuizLessonIds: [], bonusLessonIds: [], publishedAt: 100, ...over });

test("hidden categories leak nowhere computed on the client: counts, recommendations, recently added", () => {
  const cats = mergeCategories([{ id: "filmmaking", name: "Film & Video", order: 0 }, { id: "worship", name: "Worship", order: 1, hidden: true }]);
  const courses = [course("a"), course("h", { category: "worship", publishedAt: 999 })];
  assert.deepEqual(categoryCounts(me, courses, ["worship"]), { filmmaking: 1 });
  const recs = recommendations({ me, courses, progressByCourse: {}, categories: cats });
  assert.deepEqual(recs.map((r) => r.course.id), ["a"]);
  assert.equal(recs[0].reason, "For the film & video team", "reason uses the CURRENT (renamed) category name");
  const recent = recentlyPublished({ me, courses, guides: [{ id: "g", status: "published", category: "worship", publishedAt: 500 }], hidden: ["worship"] });
  assert.deepEqual(recent.map((x) => x.item.id), ["a"]);
  // a course filed under a category with no record (deleted) is never recommended
  assert.deepEqual(recommendations({ me, courses: [course("z", { category: "gone" })], progressByCourse: {}, categories: cats }), []);
});

test("learning paths: a course in a hidden category resolves as unavailable for learners (never complete), available for editors", () => {
  const path = { items: [{ id: "a", type: "course", courseId: "h", required: true, label: "Lyric slides" }] };
  const ctx = (who) => ({ me: who, courses: { h: course("h", { category: "worship" }) }, lessons: {}, guides: {}, progressByCourse: { h: { lessons: { l1: { manualDone: true } } } }, reviews: {}, hidden: ["worship"] });
  const r = resolvePathItems(path, ctx(me));
  assert.equal(r[0].available, false); assert.equal(r[0].completed, false); assert.equal(r[0].title, "Lyric slides");
  assert.equal(pathProgress(r).unavailable, 1);
  const ed = resolvePathItems(path, ctx({ ...me, academyEditor: true }));
  assert.equal(ed[0].available, true);
});

test("editor role: admin or academyEditor; disabled/pending accounts never", () => {
  assert.equal(isAcademyEditor({ role: "admin", status: "approved" }), true);
  assert.equal(isAcademyEditor({ role: "member", status: "approved", academyEditor: true }), true);
  assert.equal(isAcademyEditor({ role: "member", status: "approved" }), false);
  assert.equal(isAcademyEditor({ role: "member", status: "pending", academyEditor: true }), false);
  assert.equal(isAcademyEditor({ role: "admin", status: "removed", disabled: true }), false);
});
