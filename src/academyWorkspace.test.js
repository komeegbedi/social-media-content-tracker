/* IFC Creative Academy — authoring workspace logic (pure): the draft/published
   revision model, ordering (drag-and-drop results), resource-link naming and
   course runtime. Run: node --test src/academyWorkspace.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankCourse, isMeaningfulCourse, draftFromLive, normalizeOutline, hasUnpublishedChanges, imagePathsOf, deletableAfterDraftSave,
  splitLessonForLive, buildPublishPlan, courseRuntime, formatRuntime, formatClock,
} from "./academyDrafts.js";
import {
  moveId, outlineRows, moveLessonInOutline, moveLessonToModule, insertLesson, removeLesson, lessonPosition, orderCourses,
  moveModule, moduleIndexFromSlot, outlineSpan, outlineCanDrop,
  NO_SECTION, isNamedSection, ensureNoSection, defaultSectionName, addSection, renameSection, removeSectionTo, moveLessonToGroup, describeDrop, dropGroup,
  lessonDestinations, ungroupedLabel, topNoSectionId,
} from "./academyOrder.js";
import { normalizeLinkInput, isValidResourceUrl, sourceLabel, fileTypeFromUrl, fallbackLabel, applyLinkMeta, newLink } from "./academyLinks.js";

const ids = (mods) => mods.map((m) => m.lessonIds.join(","));

/* ---------------------------------------------------------- revision model */
test("opening a new-course screen writes nothing: a blank course isn't 'meaningful' until something is entered", () => {
  const c = blankCourse("lighting");
  assert.equal(c.category, "lighting");
  assert.equal(isMeaningfulCourse(c, {}), false);
  assert.equal(isMeaningfulCourse({ ...c, title: "  " }, {}), false);
  assert.equal(isMeaningfulCourse({ ...c, title: "Lighting 101" }, {}), true);
  assert.equal(isMeaningfulCourse(c, { l1: { kind: "video" } }), true);
  assert.equal(isMeaningfulCourse({ ...c, cover: { path: "x" } }, {}), true);
});

test("draft from a live course keeps lesson ids, module order and answer keys; legacy courses without modules get one section", () => {
  const live = { title: "T", category: "photo", level: "beginner", modules: [{ id: "m1", title: "", lessonIds: ["b", "a"] }], status: "published", lessonCount: 2 };
  const lessons = [{ id: "a", title: "A", quiz: { mode: "required", questions: [{ id: "q", options: [{ id: "o1" }] }] } }, { id: "b", title: "B" }];
  const d = draftFromLive(live, lessons, { a: { answers: { q: ["o1"] }, explanations: {} } });
  assert.deepEqual(d.course.modules[0].lessonIds, ["b", "a"]);
  assert.equal(d.course.status, undefined, "publication state isn't copied into the draft");
  assert.equal(d.course.lessonCount, undefined, "derived counters are recomputed at publish");
  assert.deepEqual(Object.keys(d.lessons).sort(), ["a", "b"]);
  assert.deepEqual(d.lessons.a.quizKey.answers, { q: ["o1"] });
  const legacy = draftFromLive({ title: "Old" }, [{ id: "x" }, { id: "y" }]);
  assert.deepEqual(legacy.course.modules, [{ id: "m1", title: "", lessonIds: ["x", "y"] }]);
});

test("the editable outline shows EVERY lesson in learner order (legacy and unlisted lessons are never dropped on publish)", () => {
  const lessons = { a: { createdAtMs: 2 }, b: { createdAtMs: 1 }, c: { createdAtMs: 3 } };
  assert.deepEqual(normalizeOutline({ modules: [] }, lessons).modules, [{ id: "m1", title: "", lessonIds: ["b", "a", "c"] }]);
  const partly = normalizeOutline({ modules: [{ id: "m1", title: "Basics", lessonIds: ["c", "gone", "c"] }] }, lessons);
  assert.deepEqual(partly.modules, [{ id: "m1", title: "Basics", lessonIds: ["c"] }, { id: "more", title: "More lessons", lessonIds: ["b", "a"] }]);
  assert.deepEqual(normalizeOutline({ modules: [] }, {}).modules, [{ id: "m1", title: "", lessonIds: [] }]);
});

test("unpublished changes = draft rev ahead of the published rev", () => {
  assert.equal(hasUnpublishedChanges(null), false);
  assert.equal(hasUnpublishedChanges({ rev: 3, publishedRev: 3 }), false);
  assert.equal(hasUnpublishedChanges({ rev: 4, publishedRev: 3 }), true);
  assert.equal(hasUnpublishedChanges({ rev: 1, publishedRev: 0 }), true);
});

test("image clean-up never deletes an upload still referenced by the draft OR the published version", () => {
  const draft = imagePathsOf({ cover: { path: "c2" } }, { l1: { thumb: { path: "t1" } } });
  const live = imagePathsOf({ cover: { path: "c1" } }, { l1: { thumb: { path: "t1" } } });
  assert.deepEqual(deletableAfterDraftSave(["c1", "c2", "t1", "old", "", null], { draftPaths: draft, livePaths: live }), ["old"]);
});

test("publish split: quiz answers go to the key, never the learner doc; no quiz → no key", () => {
  const { live, key } = splitLessonForLive({ title: "L", quiz: { mode: "required", passMark: 80, questions: [{ id: "q", options: [{ id: "a" }, { id: "b" }] }] }, quizKey: { answers: { q: ["b", "zz"] }, explanations: { q: "because" } } });
  assert.equal(live.quizKey, undefined);
  assert.deepEqual(key, { answers: { q: ["b"] }, explanations: { q: "because" } });
  assert.equal(live.quiz.passMark, 80);
  const none = splitLessonForLive({ title: "L", quiz: { mode: "none", questions: [{ id: "q" }] } });
  assert.equal(none.key, null);
  assert.deepEqual(none.live.quiz.questions, []);
});

test("publish plan: same lesson ids (progress/comments stay attached), removed lessons listed, order = draft outline, images diffed", () => {
  const draftCourse = { title: "C", category: "photo", level: "beginner", cover: { path: "cov2" }, modules: [{ id: "m1", title: "", lessonIds: ["l3", "l1"] }] };
  const draftLessons = { l1: { title: "One", kind: "video", video: { provider: "youtube", id: "x" } }, l3: { title: "Three", kind: "written", durationMinutes: 5 }, orphan: { title: "not in outline" } };
  const liveCourse = { cover: { path: "cov1" }, publishedAt: { seconds: 1 } };
  const liveLessons = [{ id: "l1", title: "One" }, { id: "l2", title: "Two", thumb: { path: "t2" } }];
  const p = buildPublishPlan({ draftCourse, draftLessons, liveCourse, liveLessons });
  // a draft lesson the outline doesn't list is published exactly where learners
  // would see it (appended) — and the workspace never hides it (normalizeOutline)
  assert.deepEqual(p.upserts.map((u) => u.id), ["l3", "l1", "orphan"]);
  assert.deepEqual(p.removes, ["l2"]);
  assert.equal(p.course.status, "published");
  assert.equal(p.course.lessonCount, 3);
  assert.deepEqual(p.imagesToDelete.sort(), ["cov1", "t2"]);
  assert.equal(p.firstPublish, false);
  assert.equal(buildPublishPlan({ draftCourse, draftLessons, liveCourse: null, liveLessons: [] }).firstPublish, true);
});

/* ------------------------------------------------------------------ runtime */
test("course runtime uses MEASURED video durations only; unknowns make it partial; live streams and reading time are separate", () => {
  const rt = courseRuntime([
    { video: { id: "a" }, videoMeta: { durationSec: 600 } },
    { video: { id: "b" }, videoMeta: { durationSec: 125 } },
    { video: { id: "c" }, videoMeta: null },
    { video: { id: "d" }, videoMeta: { isLive: true } },
    { kind: "written", durationMinutes: 7 },
  ]);
  assert.deepEqual(rt, { videoSec: 725, videos: 4, measured: 2, live: 1, partial: true, otherMin: 7 });
  assert.equal(courseRuntime([{ video: {}, videoMeta: { durationSec: 60 } }]).partial, false);
  assert.equal(formatRuntime(725), "12 min");
  assert.equal(formatRuntime(3 * 3600 + 20 * 60), "3 h 20 min");
  assert.equal(formatRuntime(0), "");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatClock(65), "1:05");
});

/* ----------------------------------------------------------------- ordering */
test("moveId moves by stable id (bottom → top, top → bottom, clamped)", () => {
  assert.deepEqual(moveId(["a", "b", "c", "d"], "d", 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveId(["a", "b", "c"], "a", 99), ["b", "c", "a"]);
  assert.deepEqual(moveId(["a", "b"], "zz", 0), ["a", "b"]);
});

test("outline drag: lessons with no sections, named sections, and No section at the top", () => {
  const one = [{ id: "m1", title: "", lessonIds: ["a", "b", "c"] }];
  assert.deepEqual(outlineRows(one).map((r) => r.id), ["a", "b", "c"], "no named sections: just the lessons, no headers");
  assert.deepEqual(ids(moveLessonInOutline(one, "c", 0)), ["c,a,b"]);
  const two = [{ id: "m1", title: "Basics", lessonIds: ["a", "b"] }, { id: "m2", title: "More", lessonIds: ["c"] }];
  const rows = outlineRows(two);
  assert.deepEqual(rows.map((r) => r.id), ["module:m1", "a", "b", "module:m2", "c"], "no permanent No section container");
  assert.deepEqual(ids(moveLessonInOutline(two, "a", 3, () => "ns")), ["b", "a,c"], "right after H2 → first in “More”");
  assert.deepEqual(ids(moveLessonInOutline(two, "c", 3, () => "ns")), ["a,b,c", ""], "end of section 1");
  // above the first header = No section at the top: a new untitled module is created ONLY by this move
  const out = moveLessonInOutline(two, "c", 0, () => "ns");
  assert.deepEqual(out.map((m) => `${m.id}:${m.title}:${m.lessonIds.join(",")}`), ["ns::c", "m1:Basics:a,b", "m2:More:"]);
});

test("empty untitled modules are stored structures, not visible groups; populated ones keep their place", () => {
  const empties = [{ id: "m1", title: "", lessonIds: [] }, { id: "s1", title: "Exposure", lessonIds: ["e1"] }, { id: "u2", title: "", lessonIds: [] }, { id: "s2", title: "Motion", lessonIds: [] }, { id: "u3", title: "", lessonIds: [] }];
  assert.deepEqual(outlineRows(empties).map((r) => r.id), ["module:s1", "e1", "module:s2", "empty:s2"], "three empty untitled modules → no rows at all");
  // dropping above the first section REUSES the empty top module (no new module)
  const back = moveLessonInOutline(empties, "e1", 0, () => "NEW");
  assert.deepEqual(back.map((m) => `${m.id}:${m.lessonIds.join(",")}`), ["m1:e1", "s1:", "u2:", "s2:", "u3:"]);
  const legacy = [{ id: "u0", title: "", lessonIds: ["w"] }, { id: "s1", title: "Exposure", lessonIds: ["a"] }, { id: "u1", title: "", lessonIds: ["b1", "b2"] }, { id: "s2", title: "Motion", lessonIds: ["c"] }];
  assert.deepEqual(outlineRows(legacy).map((r) => r.id), ["none:u0", "w", "module:s1", "a", "none:u1", "b1", "b2", "module:s2", "c"], "ungrouped lessons stay where they are");
  assert.deepEqual(lessonDestinations(legacy).map((d) => d.label), ["No section, at the top", "Exposure", "No section, after “Exposure”", "Motion"]);
  assert.deepEqual(lessonDestinations(empties).map((d) => `${d.group}:${d.label}`), ["m1:No section", "s1:Exposure", "s2:Motion"], "empty internal modules aren't destinations; the top one is reused");
  assert.equal(topNoSectionId([{ id: "s1", title: "A", lessonIds: [] }]), NO_SECTION);
  assert.equal(ungroupedLabel([{ id: "u", title: "", lessonIds: ["x"] }, { id: "s", title: "S", lessonIds: [] }], "u"), "No section");
  assert.equal(ungroupedLabel([{ id: "s0", title: "", lessonIds: [] }, { id: "u", title: "", lessonIds: ["x"] }, { id: "s", title: "Later", lessonIds: [] }], "u"), "No section, before “Later”");
});

test("a named section stays a section even when it's the only one (and when it's empty)", () => {
  const solo = [{ id: "s1", title: "Understanding light", lessonIds: ["a"] }];
  assert.deepEqual(outlineRows(solo).map((r) => r.type), ["module", "lesson"]);
  const empty = [{ id: "m1", title: "", lessonIds: [] }, { id: "s1", title: "Light", lessonIds: [] }];
  assert.deepEqual(outlineRows(empty).map((r) => r.id), ["module:s1", "empty:s1"]);
  assert.equal(isNamedSection({ title: "  " }), false);
  assert.equal(isNamedSection({ title: "A" }), true);
});

test("Add section creates exactly ONE named section; remove by stable id never resurrects it", () => {
  let mods = [{ id: "m1", title: "", lessonIds: [] }];
  mods = addSection(mods, "s1", defaultSectionName(mods));
  assert.deepEqual(mods.map((m) => `${m.id}:${m.title}`), ["m1:", "s1:Section 1"]);
  mods = renameSection(mods, "s1", "Understanding light");
  mods = addSection(mods, "s2", defaultSectionName(mods));
  assert.equal(mods[2].title, "Section 2");
  mods = removeSectionTo(mods, "s2");
  assert.deepEqual(mods.map((m) => `${m.id}:${m.title}`), ["m1:", "s1:Understanding light"]);
  mods = addSection(mods, "s3", defaultSectionName(mods));
  assert.deepEqual(mods.map((m) => m.id), ["m1", "s1", "s3"], "s2 never comes back");
  assert.equal(defaultSectionName([{ id: "a", title: "Section 1", lessonIds: [] }, { id: "b", title: "Section 2", lessonIds: [] }]), "Section 3");
  assert.equal(defaultSectionName([{ id: "a", title: "Section 2", lessonIds: [] }]), "Section 3", "never duplicates a name");
});

test("removing a populated section moves its lessons, in order, to No section (top) or another section — never deletes them", () => {
  const mods = [{ id: "s1", title: "A", lessonIds: ["a", "b"] }, { id: "s2", title: "B", lessonIds: ["c"] }];
  assert.deepEqual(removeSectionTo(mods, "s1", NO_SECTION, () => "ns").map((m) => `${m.id}:${m.title}:${m.lessonIds.join(",")}`), ["ns::a,b", "s2:B:c"]);
  assert.deepEqual(removeSectionTo(mods, "s1", "s2").map((m) => `${m.id}:${m.lessonIds.join(",")}`), ["s2:c,a,b"]);
  const withTop = [{ id: "m1", title: "", lessonIds: ["x"] }, ...mods];
  assert.deepEqual(removeSectionTo(withTop, "s2", NO_SECTION).map((m) => `${m.id}:${m.lessonIds.join(",")}`), ["m1:x,c", "s1:a,b"]);
  // a legacy untitled module further down is NOT "No section (top)": a top one is made
  const mid = [{ id: "s1", title: "A", lessonIds: ["a"] }, { id: "u1", title: "", lessonIds: ["u"] }, { id: "s2", title: "B", lessonIds: ["c"] }];
  assert.deepEqual(removeSectionTo(mid, "s2", NO_SECTION, () => "top").map((m) => `${m.id}:${m.lessonIds.join(",")}`), ["top:c", "s1:a", "u1:u"]);
  assert.deepEqual(removeSectionTo(mods, "nope", NO_SECTION), mods);
  const [made, id] = ensureNoSection(mods, () => "s1");   // an id clash never reuses an existing section's id
  assert.notEqual(id, "s1"); assert.equal(made[0].title, "");
});

test("drop words and targets: section + position, No section, ungrouped areas, empty sections", () => {
  const mods = [{ id: "m1", title: "", lessonIds: ["a"] }, { id: "s1", title: "Understanding light", lessonIds: ["b", "c"] }, { id: "s2", title: "Empty", lessonIds: [] }];
  const rows = outlineRows(mods);
  const a = rows.find((r) => r.id === "a"), rest = rows.filter((r) => r.id !== "a");
  // rest: [none:m1, module:s1, b, c, module:s2, empty:s2]
  assert.equal(describeDrop(mods, a, 3, rest), "Move to “Understanding light”, position 2");
  assert.equal(describeDrop(mods, a, 1, rest), "Move to No section, position 1");
  assert.equal(describeDrop(mods, a, 5, rest), "Move to “Empty”, position 1");
  assert.equal(dropGroup(a, 5, rest), "s2");
  assert.equal(outlineCanDrop(a, 0, rest), false, "a visible No section at the top: its first position is the same place");
  assert.equal(outlineCanDrop(a, 6, rest), false, "below an empty-state row = the same place; one slot only");
  assert.deepEqual(ids(moveLessonToGroup(mods, "b", "s2", 0)), ["a", "c", "b"]);
  const sec = rows.find((r) => r.id === "module:s2");
  assert.equal(describeDrop(mods, sec, 1, rows.filter((r) => r.moduleId !== "s2")), "Move section to position 1 of 2");
  // no ungrouped lessons: the spot above the first section = No section at the top
  const named = [{ id: "m0", title: "", lessonIds: [] }, { id: "s1", title: "Light", lessonIds: ["x", "y"] }];
  const nrows = outlineRows(named); const x = nrows.find((r) => r.id === "x"); const nrest = nrows.filter((r) => r.id !== "x");
  assert.equal(outlineCanDrop(x, 0, nrest), true);
  assert.equal(describeDrop(named, x, 0, nrest), "Move to No section, position 1");
  assert.equal(dropGroup(x, 0, nrest), NO_SECTION);
  const legacy = [{ id: "s1", title: "Exposure", lessonIds: ["e"] }, { id: "u1", title: "", lessonIds: ["b"] }, { id: "s2", title: "Motion", lessonIds: ["m"] }];
  const lrows = outlineRows(legacy); const m = lrows.find((r) => r.id === "m"); const lrest = lrows.filter((r) => r.id !== "m");
  assert.equal(describeDrop(legacy, m, 4, lrest), "Move to No section, after “Exposure”, position 2");
});

test("explicit Move to section / position, insertion points and removal", () => {
  const two = [{ id: "m1", lessonIds: ["a", "b"] }, { id: "m2", lessonIds: ["c"] }];
  assert.deepEqual(ids(moveLessonToModule(two, "a", "m2", 0)), ["b", "a,c"]);
  assert.deepEqual(ids(moveLessonToModule(two, "a", "m2")), ["b", "c,a"]);
  assert.deepEqual(ids(insertLesson(two, "n", { afterId: "a" })), ["a,n,b", "c"]);
  assert.deepEqual(ids(insertLesson(two, "n", { moduleId: "m1" })), ["a,b,n", "c"]);
  assert.deepEqual(ids(insertLesson(two, "n", {})), ["a,b", "c,n"], "default: end of the course");
  assert.deepEqual(ids(insertLesson([], "n")), ["n"]);
  assert.deepEqual(ids(removeLesson(two, "b")), ["a", "c"]);
  assert.deepEqual(lessonPosition(two, "c"), { index: 2, count: 3 });
});

test("course order in a category: explicit order first, then the Academy's original order (level, newest published)", () => {
  const cs = [
    { id: "adv", level: "advanced", publishedAt: { seconds: 300 } },
    { id: "beg-old", level: "beginner", publishedAt: { seconds: 100 } },
    { id: "beg-new", level: "beginner", publishedAt: { seconds: 200 } },
    { id: "int", level: "intermediate", publishedAtMs: 50 },
  ];
  assert.deepEqual(orderCourses(cs, []).map((c) => c.id), ["beg-new", "beg-old", "int", "adv"]);
  assert.deepEqual(orderCourses(cs, ["adv", "int"]).map((c) => c.id), ["adv", "int", "beg-new", "beg-old"]);
  assert.deepEqual(orderCourses(cs, ["gone", "beg-old"]).map((c) => c.id)[0], "beg-old", "ids no longer present are ignored");
});

/* ---------------------------------------------------------- resource links */
test("resource links: paste a URL only; name/type/source come from the URL when metadata isn't available", () => {
  assert.equal(normalizeLinkInput("example.com/guide"), "https://example.com/guide");
  assert.equal(isValidResourceUrl("javascript:alert(1)"), false);
  assert.equal(isValidResourceUrl("https://docs.google.com/document/d/abc/edit"), true);
  assert.equal(sourceLabel("https://docs.google.com/document/d/abc/edit"), "Google Docs");
  assert.equal(fileTypeFromUrl("https://docs.google.com/presentation/d/abc/edit"), "Slides");
  assert.equal(fileTypeFromUrl("https://cdn.example.org/packs/Film_LUTs.zip"), "ZIP");
  assert.equal(fallbackLabel("https://cdn.example.org/packs/Film_LUTs-v2.zip"), "Film LUTs v2.zip");
  assert.equal(fallbackLabel("https://docs.google.com/document/d/abc/edit"), "Google Docs");
  assert.deepEqual(newLink("https://www.studio.example.org/"), { url: "https://www.studio.example.org/", label: "studio.example.org", source: "studio.example.org", fileType: "" });
});

test("fetched titles fill the name but NEVER overwrite a custom name; private links keep a fallback and are flagged", () => {
  const base = newLink("https://docs.google.com/document/d/abc/edit");
  const fetched = applyLinkMeta(base, { available: true, title: "Shot list template", siteName: "Google Docs" });
  assert.equal(fetched.label, "Shot list template");
  const custom = applyLinkMeta({ ...base, label: "Our shot list", custom: true }, { available: true, title: "Shot list template" });
  assert.equal(custom.label, "Our shot list");
  const priv = applyLinkMeta(base, { available: false, restricted: true, reason: "restricted" });
  assert.deepEqual([priv.label, priv.restricted, priv.fileType], ["Google Docs", true, "Doc"]);
});

test("sections move as a block (same lesson ids and membership); drops only land on section boundaries", () => {
  const mods = [{ id: "m1", title: "A", lessonIds: ["a", "b"] }, { id: "m2", title: "B", lessonIds: ["c"] }, { id: "m3", title: "C", lessonIds: [] }];
  const rows = outlineRows(mods);
  assert.deepEqual(rows.map((r) => r.id), ["module:m1", "a", "b", "module:m2", "c", "module:m3", "empty:m3"]);
  assert.equal(outlineSpan(rows, 0), 3);
  assert.equal(outlineSpan(rows, 3), 2);
  assert.equal(outlineSpan(rows, 5), 2, "an empty section carries its empty-state row");
  assert.equal(outlineSpan(rows, 1), 1);
  const rest = rows.filter((r) => r.moduleId !== "m1");      // [H2, c, H3, e3]
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => outlineCanDrop(rows[0], s, rest)), [true, false, true, false, true]);
  assert.equal(moduleIndexFromSlot(rows, "m1", 2, mods), 1);
  assert.equal(moduleIndexFromSlot(rows, "m1", 4, mods), 2);
  assert.deepEqual(ids(moveModule(mods, "m1", 2)), ["c", "", "a,b"]);
  assert.equal(outlineCanDrop(rows[1], 0, rows.filter((r) => r.id !== "a")), true, "above the first named section = No section at the top");
  assert.equal(outlineCanDrop(rows[1], 1, rows.filter((r) => r.id !== "a")), true);
});

test("section drags land correctly even with hidden (empty untitled) modules in between", () => {
  const mods = [{ id: "m1", title: "", lessonIds: [] }, { id: "s1", title: "A", lessonIds: ["a"] }, { id: "u2", title: "", lessonIds: [] }, { id: "s2", title: "B", lessonIds: ["b"] }, { id: "u3", title: "", lessonIds: [] }];
  const rows = outlineRows(mods);                                   // [H s1, a, H s2, b]
  const toEnd = moveModule(mods, "s1", moduleIndexFromSlot(rows, "s1", 2, mods));
  assert.deepEqual(namedOrder(toEnd), ["B", "A"], "A dragged below B really ends up below B");
  const toTop = moveModule(mods, "s2", moduleIndexFromSlot(rows, "s2", 0, mods));
  assert.deepEqual(namedOrder(toTop), ["B", "A"]);
});
const namedOrder = (mods) => mods.filter((m) => m.title).map((m) => m.title);

test("images are only ever deleted from the course's OWN folders (a shared or foreign reference is left alone)", async () => {
  const { ownedByCourse } = await import("./academyDrafts.js");
  assert.equal(ownedByCourse("academy/covers/c1/v2.jpg", "c1"), true);
  assert.equal(ownedByCourse("academy/lessonThumbs/c1/l1/v1.jpg", "c1"), true);
  assert.equal(ownedByCourse("academy/covers/c10/v1.jpg", "c1"), false, "prefix must end at the id");
  assert.equal(ownedByCourse("academy/covers/other/seed.png", "c1"), false);
  const none = new Set();
  assert.deepEqual(deletableAfterDraftSave(["academy/covers/c1/a.jpg", "academy/covers/other/seed.png"], { draftPaths: none, livePaths: none }, "c1"), ["academy/covers/c1/a.jpg"]);
  const p = buildPublishPlan({ courseId: "c1", draftCourse: { cover: { path: "academy/covers/c1/new.jpg" }, modules: [] }, draftLessons: {},
    liveCourse: { cover: { path: "academy/covers/other/seed.png" } }, liveLessons: [{ id: "l", thumb: { path: "academy/lessonThumbs/c1/l/v.jpg" } }] });
  assert.deepEqual(p.imagesToDelete, ["academy/lessonThumbs/c1/l/v.jpg"]);
});

test("Markdown format version: new courses start at v2; legacy docs stay unversioned (v1); the version travels draft → publish", () => {
  assert.equal(blankCourse("x").mdVersion, 2);
  const legacy = draftFromLive({ title: "Old", about: "C:\\Users", modules: [] }, [{ id: "l1", description: "a \\* b" }]);
  assert.equal(legacy.course.mdVersion, undefined, "legacy course text keeps the legacy rules");
  assert.equal(legacy.lessons.l1.mdVersion, undefined);
  const converted = draftFromLive({ title: "New", about: "x", mdVersion: 2, modules: [{ id: "m1", lessonIds: ["l1"] }] }, [{ id: "l1", description: "y", mdVersion: 2 }]);
  assert.equal(converted.course.mdVersion, 2);
  assert.equal(converted.lessons.l1.mdVersion, 2);
  const plan = buildPublishPlan({ draftCourse: converted.course, draftLessons: converted.lessons, liveCourse: null, liveLessons: [] });
  assert.equal(plan.course.mdVersion, 2);
  assert.equal(plan.upserts[0].live.mdVersion, 2);
});

// round 7: the course time summary never presents a partial total as complete
import { courseTimeFacts } from "./academyDrafts.js";
test("courseTimeFacts: video time and reading estimates stay separate; unknowns are said, never invented", () => {
  // the reported case: video lessons without a measured length + reading estimates
  let f = courseTimeFacts([{ video: {}, videoMeta: null }, { video: {}, videoMeta: {} }, { durationMinutes: 12 }, { durationMinutes: 15 }]);
  assert.deepEqual(f.required, ["2 videos (length not known yet)", "~27 min reading & exercises"]);
  assert.equal(f.bonus, null);
  // some videos measured → "At least"
  f = courseTimeFacts([{ video: {}, videoMeta: { durationSec: 600 } }, { video: {}, videoMeta: null }]);
  assert.deepEqual(f.required, ["At least 10 min of video"]);
  // all measured → plain total; a lesson without an estimate makes reading "At least"
  f = courseTimeFacts([{ video: {}, videoMeta: { durationSec: 300 } }, { durationMinutes: 5 }, { kind: "written" }]);
  assert.deepEqual(f.required, ["5 min of video", "At least ~5 min reading & exercises"]);
  // live videos are counted, not timed
  f = courseTimeFacts([{ video: {}, videoMeta: { isLive: true } }]);
  assert.deepEqual(f.required, ["1 live video"]);
  // bonus lessons stay out of the required figures
  f = courseTimeFacts([{ durationMinutes: 10 }, { bonus: true, video: {}, videoMeta: { durationSec: 120 } }]);
  assert.deepEqual(f.required, ["~10 min reading & exercises"]);
  assert.equal(f.bonus, "1 bonus lesson: 2 min of video");
});
