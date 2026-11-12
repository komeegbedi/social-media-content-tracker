/* IFC Creative Academy — Firestore Security Rules (allowed vs denied) against
   the emulator. Proves: draft visibility, Academy-editor boundaries, quiz
   keys never readable by learners, `earned` is server-only, attempts are
   server-written, discussion permissions, settings admin-only.

   Run (self-contained):   npm run test:academy
   Or against a running emulator: node --test test/academy.rules.test.js */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import {
  doc, collection, collectionGroup, query, where, setDoc, getDoc, getDocs, updateDoc, deleteDoc, addDoc, serverTimestamp,
} from "firebase/firestore";

const PROJECT_ID = process.env.RULES_TEST_PROJECT || ("academy-rules-" + Date.now());
let env;
async function seed(path, id, data) {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path, id), data); });
}
const as = (uid) => env.authenticatedContext(uid).firestore();

const USERS = {
  admin:    { name: "Ada Admin",   role: "admin",  status: "approved" },
  // v4: an Academy EDITOR (global role). Fixtures still carry instructorUid "inst"
  // on some docs to prove the old per-course field grants nothing by itself.
  inst:     { name: "Ines Editor", role: "member", status: "approved", academyEditor: true },
  exinst:   { name: "Former Instructor", role: "member", status: "approved" },
  lead:     { name: "Lee Lead",    role: "member", status: "approved", lead: true },
  member:   { name: "Mel Member",  role: "member", status: "approved" },
  other:    { name: "Odell Other", role: "member", status: "approved" },
  pending:  { name: "Peggy Pend",  role: "member", status: "pending" },
  exadmin:  { name: "Ex Admin",    role: "admin",  status: "removed", disabled: true },
};
const course = (over = {}) => ({
  title: "Lighting", category: "photography", level: "beginner", status: "published", instructorUid: "inst", instructorName: "Ines",
  about: "", outcomes: [], requirements: [], modules: [{ id: "m1", title: "", lessonIds: ["l1"] }], cover: null,
  lessonCount: 1, requiredLessonCount: 1, requiredQuizLessonIds: [], bonusLessonIds: [], durationMinutes: 0,
  createdAt: new Date(1), createdBy: "admin", updatedAt: new Date(1), updatedBy: "admin", ...over,
});
const lesson = (over = {}) => ({
  title: "L1", moduleId: "m1", video: { provider: "youtube", id: "dQw4w9WgXcQ" }, description: "", resources: [], thumb: null, bonus: false,
  durationMinutes: 5, quiz: { mode: "required", passMark: 70, retryLimit: 0, questions: [{ id: "q1", prompt: "?", multi: false, options: [{ id: "a", text: "A" }, { id: "b", text: "B" }] }] },
  createdAt: new Date(1), createdAtMs: 1, updatedAt: new Date(1), ...over,
});
const seedCourse = async (id, over, lessonOver) => {
  await seed("courses", id, course(over));
  await seed(`courses/${id}/lessons`, "l1", lesson(lessonOver));
  await seed(`courses/${id}/quizKeys`, "l1", { answers: { q1: ["a"] }, explanations: {} });
};

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
after(async () => { if (env) await env.cleanup(); });
const CATEGORY_IDS = ["heart-of-serving", "photography", "filmmaking", "graphic-design", "social-media-storytelling", "creating-together"];
beforeEach(async () => {
  await env.clearFirestore();
  for (const [k, u] of Object.entries(USERS)) await seed("users", k, u);
  // v4: categories are records; content may only be filed under an existing one.
  for (const [i, id] of CATEGORY_IDS.entries()) await seed("academyCategories", id, { name: id, description: "", order: i, hidden: false, cover: null, createdAt: new Date(1), createdBy: "admin", updatedAt: new Date(1), updatedBy: "admin" });
  await seedCourse("pub");
  await seedCourse("draft", { status: "draft" });
  await seedCourse("arch", { status: "archived" });
});

/* ---- visibility ---- */
test("published courses + lessons: approved members read; pending / disabled / anonymous denied", async () => {
  await assertSucceeds(getDoc(doc(as("member"), "courses", "pub")));
  await assertSucceeds(getDoc(doc(as("member"), "courses/pub/lessons", "l1")));
  await assertFails(getDoc(doc(as("pending"), "courses", "pub")));
  await assertFails(getDoc(doc(as("exadmin"), "courses", "pub")));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "courses", "pub")));
});

test("drafts and archived courses are invisible to learners (get AND list), visible to admin + the instructor", async () => {
  await assertFails(getDoc(doc(as("member"), "courses", "draft")));
  await assertFails(getDoc(doc(as("member"), "courses/draft/lessons", "l1")));
  await assertFails(getDoc(doc(as("member"), "courses", "arch")));
  await assertFails(getDoc(doc(as("lead"), "courses", "draft")), "a lead is not an editor");
  await assertSucceeds(getDoc(doc(as("admin"), "courses", "draft")));
  await assertSucceeds(getDoc(doc(as("inst"), "courses", "draft")));
  await assertSucceeds(getDoc(doc(as("inst"), "courses/draft/lessons", "l1")));
  // list: the learner's published-only query works; an unfiltered list (which would include drafts) is denied
  // Learners list with the visible-category constraint the app sends (rules can prove it).
  await assertSucceeds(getDocs(query(collection(as("member"), "courses"), where("status", "==", "published"), where("category", "in", CATEGORY_IDS))));
  await assertFails(getDocs(collection(as("member"), "courses")));
  await assertSucceeds(getDocs(collection(as("admin"), "courses")));
  await assertSucceeds(getDocs(collection(as("inst"), "courses")), "Academy editors list everything");
  await assertFails(getDoc(doc(as("exinst"), "courses", "draft")), "the old instructorUid field grants nothing without the editor role");
});

/* ---- quiz keys ---- */
test("quiz keys: never readable or writable by learners; editors only", async () => {
  await assertFails(getDoc(doc(as("member"), "courses/pub/quizKeys", "l1")));
  await assertFails(getDoc(doc(as("lead"), "courses/pub/quizKeys", "l1")));
  await assertFails(setDoc(doc(as("member"), "courses/pub/quizKeys", "l1"), { answers: { q1: ["b"] }, explanations: {} }));
  await assertSucceeds(getDoc(doc(as("inst"), "courses/pub/quizKeys", "l1")));
  await assertSucceeds(getDoc(doc(as("admin"), "courses/pub/quizKeys", "l1")));
  await assertSucceeds(setDoc(doc(as("inst"), "courses/pub/quizKeys", "l1"), { answers: { q1: ["a"] }, explanations: { q1: "x" }, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(as("inst"), "courses/pub/quizKeys", "l1"), { answers: {}, leak: true }), "strict keys");
  await assertFails(deleteDoc(doc(as("member"), "courses/pub/quizKeys", "l1")));
  await assertSucceeds(deleteDoc(doc(as("inst"), "courses/pub/quizKeys", "l1")), "editors delete keys with the lesson");
});

test("a lesson doc may not carry an `answers` key inside quiz (keys live in quizKeys)", async () => {
  const bad = lesson({ quiz: { mode: "required", passMark: 70, retryLimit: 0, questions: [], answers: { q1: ["a"] } }, updatedAt: serverTimestamp() });
  await assertFails(setDoc(doc(as("admin"), "courses/pub/lessons", "l2"), bad));
  await assertSucceeds(setDoc(doc(as("admin"), "courses/pub/lessons", "l2"), lesson({ updatedAt: serverTimestamp() })));
});

/* ---- course management ---- */
test("create: Academy editors (admin or academyEditor), draft or first-publish, stamped; members and former instructors cannot", async () => {
  const fresh = (over) => course({ status: "draft", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: "admin", updatedBy: "admin", ...over });
  await assertSucceeds(setDoc(doc(as("admin"), "courses", "new1"), fresh()));
  // v6: a first Publish creates the live doc already published (editors could
  // always publish, so this adds no capability); it can never be born archived.
  await assertSucceeds(setDoc(doc(as("admin"), "courses", "new2"), fresh({ status: "published", publishedAt: serverTimestamp() })), "first publish");
  await assertFails(setDoc(doc(as("admin"), "courses", "new2b"), fresh({ status: "archived" })), "can't be born archived");
  await assertSucceeds(setDoc(doc(as("inst"), "courses", "new3"), fresh({ createdBy: "inst", updatedBy: "inst" })), "no owner/instructor needed");
  { const { instructorUid, instructorName, ...noOwner } = fresh({ createdBy: "inst", updatedBy: "inst" });
    await assertSucceeds(setDoc(doc(as("inst"), "courses", "new3b"), noOwner), "instructor/owner fields are optional"); }
  await assertFails(setDoc(doc(as("member"), "courses", "new4"), fresh({ createdBy: "member", updatedBy: "member" })));
  await assertFails(setDoc(doc(as("exinst"), "courses", "new4b"), fresh({ createdBy: "exinst", updatedBy: "exinst" })));
  await assertFails(setDoc(doc(as("admin"), "courses", "new5"), fresh({ category: "cooking" })), "category enum");
  await assertFails(setDoc(doc(as("admin"), "courses", "new6"), fresh({ cover: { path: "../etc/passwd" } })), "cover path must be under academy/");
});

test("update: Academy editors may edit + publish any course; members and former instructors can't touch it", async () => {
  await assertSucceeds(updateDoc(doc(as("inst"), "courses", "draft"), { status: "published", publishedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: "inst" }));
  await assertSucceeds(updateDoc(doc(as("admin"), "courses", "pub"), { title: "Renamed", updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertFails(updateDoc(doc(as("exinst"), "courses", "pub"), { title: "x", updatedAt: serverTimestamp(), updatedBy: "exinst" }), "instructorUid on the doc doesn't grant edit rights");
  await assertFails(updateDoc(doc(as("inst"), "courses", "pub"), { title: "x", updatedAt: serverTimestamp(), updatedBy: "admin" }), "updatedBy must be the writer");
  await assertFails(updateDoc(doc(as("inst"), "courses", "pub"), { title: "x", updatedBy: "inst" }), "updatedAt must be server time");
  await assertFails(updateDoc(doc(as("member"), "courses", "pub"), { title: "Hacked", updatedAt: serverTimestamp(), updatedBy: "member" }));
  await assertFails(updateDoc(doc(as("other"), "courses", "draft"), { status: "published", updatedAt: serverTimestamp(), updatedBy: "other" }));
});

test("delete: admin only, and never while published", async () => {
  await assertFails(deleteDoc(doc(as("admin"), "courses", "pub")));
  await assertFails(deleteDoc(doc(as("inst"), "courses", "draft")));
  await assertSucceeds(deleteDoc(doc(as("admin"), "courses", "draft")));
});

test("lessons: editors write with a valid shape; learners cannot", async () => {
  await assertSucceeds(setDoc(doc(as("inst"), "courses/pub/lessons", "l9"), lesson({ updatedAt: serverTimestamp() })));
  await assertFails(setDoc(doc(as("member"), "courses/pub/lessons", "l9"), lesson({ updatedAt: serverTimestamp() })));
  await assertFails(setDoc(doc(as("inst"), "courses/pub/lessons", "l8"), lesson({ video: { provider: "evil", id: "x" }, updatedAt: serverTimestamp() })), "provider enum");
  await assertFails(setDoc(doc(as("inst"), "courses/pub/lessons", "l8"), lesson({ video: { provider: "youtube", id: "x", embedUrl: "javascript:1" }, updatedAt: serverTimestamp() })), "no stored embed urls");
  await assertSucceeds(deleteDoc(doc(as("inst"), "courses/pub/lessons", "l1")));
});

/* ---- progress ---- */
const prog = (over = {}) => ({ uid: "member", courseId: "pub", startedAt: serverTimestamp(), lastLessonId: "l1", lastViewedAt: serverTimestamp(), updatedAt: serverTimestamp(), lessons: { l1: { positionSec: 30 } }, ...over });

test("progress: the learner creates/updates their own doc; `earned` can never be set or changed by a client", async () => {
  const ref = doc(as("member"), "learnerProgress/member/courseProgress", "pub");
  await assertSucceeds(setDoc(ref, prog()));
  await assertSucceeds(setDoc(ref, prog({ lessons: { l1: { videoWatched: true, manualDone: true } } }), { merge: true }));
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/courseProgress", "pub2"), prog({ courseId: "pub2", earned: { l1: { at: 1 } } })), "earned on create");
  await assertFails(setDoc(ref, prog({ earned: { l1: { at: 1 } } }), { merge: true }), "earned on update");
  await seed("learnerProgress/member/courseProgress", "pub", { uid: "member", courseId: "pub", updatedAt: new Date(1), lessons: {}, earned: { l1: { at: 1 } } });
  await assertFails(setDoc(ref, prog({ earned: {} }), { merge: true }), "can't clear earned");
  await assertFails(setDoc(ref, prog({ earned: { l1: { at: 1 }, l2: { at: 2 } } }), { merge: true }), "can't add to earned");
  await assertSucceeds(setDoc(ref, prog(), { merge: true }), "a merge that leaves earned untouched is fine");
  await assertFails(deleteDoc(ref));
});

test("progress: not for drafts, not for others' docs, not for pending accounts; leaders may read", async () => {
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/courseProgress", "draft"), prog({ courseId: "draft" })));
  await assertFails(setDoc(doc(as("member"), "learnerProgress/other/courseProgress", "pub"), prog({ uid: "other" })));
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/courseProgress", "pub"), prog({ uid: "other" })), "uid must match the path");
  await assertFails(setDoc(doc(as("pending"), "learnerProgress/pending/courseProgress", "pub"), prog({ uid: "pending" })));
  await seed("learnerProgress/member/courseProgress", "pub", { uid: "member", courseId: "pub", updatedAt: new Date(1), lessons: {}, earned: {} });
  await assertSucceeds(getDoc(doc(as("member"), "learnerProgress/member/courseProgress", "pub")));
  await assertFails(getDoc(doc(as("other"), "learnerProgress/member/courseProgress", "pub")));
  await assertSucceeds(getDoc(doc(as("lead"), "learnerProgress/member/courseProgress", "pub")));
  await assertSucceeds(getDoc(doc(as("admin"), "learnerProgress/member/courseProgress", "pub")));
  await assertSucceeds(getDocs(query(collectionGroup(as("lead"), "courseProgress"), where("courseId", "==", "pub"))));
  await assertFails(getDocs(query(collectionGroup(as("member"), "courseProgress"), where("courseId", "==", "pub"))));
});

/* ---- attempts ---- */
test("quiz attempts: server-written only; learners read their own; leaders read any", async () => {
  await assertFails(setDoc(doc(as("member"), "quizAttempts/member/attempts", "a1"), { uid: "member", courseId: "pub", lessonId: "l1", passed: true, percent: 100 }));
  await seed("quizAttempts/member/attempts", "a1", { uid: "member", courseId: "pub", lessonId: "l1", passed: true, percent: 100, createdAt: new Date(1) });
  await assertSucceeds(getDoc(doc(as("member"), "quizAttempts/member/attempts", "a1")));
  await assertFails(updateDoc(doc(as("member"), "quizAttempts/member/attempts", "a1"), { passed: true }));
  await assertFails(deleteDoc(doc(as("member"), "quizAttempts/member/attempts", "a1")));
  await assertFails(getDoc(doc(as("other"), "quizAttempts/member/attempts", "a1")));
  await assertSucceeds(getDoc(doc(as("lead"), "quizAttempts/member/attempts", "a1")));
  await assertSucceeds(getDocs(query(collectionGroup(as("admin"), "attempts"), where("courseId", "==", "pub"))));
  await assertFails(getDocs(query(collectionGroup(as("member"), "attempts"), where("courseId", "==", "pub"))));
});

/* ---- discussion ---- */
const comment = (uid, over = {}) => ({ uid, name: USERS[uid].name, role: "learner", txt: "Great lesson", parentId: null, pinned: false, createdAt: serverTimestamp(), ...over });

test("comments: approved members post on published lessons with their REAL role; drafts closed to learners", async () => {
  const col = (uid, c = "pub") => collection(as(uid), `courses/${c}/lessons/l1/comments`);
  await assertSucceeds(addDoc(col("member"), comment("member")));
  await assertFails(addDoc(col("member"), comment("member", { role: "moderator" })), "can't badge yourself");
  await assertFails(addDoc(col("member"), comment("member", { role: "instructor" })), "the retired instructor badge can't be claimed either");
  await assertFails(addDoc(col("member"), comment("member", { role: "admin" })));
  await assertSucceeds(addDoc(col("inst"), comment("inst", { role: "moderator" })));
  await assertFails(addDoc(col("inst"), comment("inst", { role: "learner" })), "role must be exact");
  await assertSucceeds(addDoc(col("admin"), comment("admin", { role: "admin" })));
  await assertFails(addDoc(col("member"), comment("member", { pinned: true })), "only editors pin, and only via update");
  await assertFails(addDoc(col("member"), comment("member", { uid: "other" })));
  await assertFails(addDoc(col("member"), comment("member", { txt: "" })));
  await assertFails(addDoc(col("member"), comment("member", { txt: "x".repeat(2001) })));
  await assertFails(addDoc(col("member"), comment("member", { html: "<b>" })), "strict keys");
  await assertFails(addDoc(col("pending"), comment("pending")));
  await assertFails(addDoc(col("member", "draft"), comment("member")));
  await assertSucceeds(addDoc(col("inst", "draft"), comment("inst", { role: "moderator" })));
  await assertSucceeds(addDoc(col("member"), comment("member", { parentId: "someParent" })), "threaded reply");
});

test("comments: authors edit/delete their own text; editors moderate + pin; nobody else", async () => {
  const path = "courses/pub/lessons/l1/comments";
  await seed(path, "c1", { uid: "member", name: "Mel", role: "learner", txt: "hi", parentId: null, pinned: false, createdAt: new Date(1) });
  await assertSucceeds(updateDoc(doc(as("member"), path, "c1"), { txt: "hi (edited)", editedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("member"), path, "c1"), { txt: "x", editedAt: serverTimestamp(), pinned: true }), "author can't pin");
  await assertFails(updateDoc(doc(as("member"), path, "c1"), { txt: "x", editedAt: serverTimestamp(), role: "admin" }));
  await assertFails(updateDoc(doc(as("other"), path, "c1"), { txt: "vandal", editedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as("inst"), path, "c1"), { txt: "hi (edited)", pinned: true, editedAt: serverTimestamp() }), "moderator pins");
  await assertSucceeds(updateDoc(doc(as("admin"), path, "c1"), { txt: "[moderated]", editedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("lead"), path, "c1"), { txt: "x", editedAt: serverTimestamp() }), "a lead is not a moderator");
  await assertFails(deleteDoc(doc(as("other"), path, "c1")));
  await assertSucceeds(deleteDoc(doc(as("inst"), path, "c1")));
  await seed(path, "c2", { uid: "member", name: "Mel", role: "learner", txt: "bye", parentId: null, pinned: false, createdAt: new Date(1) });
  await assertSucceeds(deleteDoc(doc(as("member"), path, "c2")));
});

/* ---- settings ---- */
test("academySettings (purpose video): approved read; admin-only write with a strict shape", async () => {
  await seed("academySettings", "purposeVideo", { title: "Why", intro: "", video: { provider: "youtube", id: "dQw4w9WgXcQ" }, thumb: null, updatedAt: new Date(1), updatedBy: "admin" });
  await assertSucceeds(getDoc(doc(as("member"), "academySettings", "purposeVideo")));
  await assertFails(getDoc(doc(as("pending"), "academySettings", "purposeVideo")));
  const ok = { title: "Why we serve", intro: "x", video: { provider: "vimeo", id: "123456" }, thumb: null, updatedAt: serverTimestamp(), updatedBy: "admin" };
  await assertSucceeds(setDoc(doc(as("admin"), "academySettings", "purposeVideo"), ok));
  await assertFails(setDoc(doc(as("inst"), "academySettings", "purposeVideo"), { ...ok, updatedBy: "inst" }));
  await assertFails(setDoc(doc(as("admin"), "academySettings", "purposeVideo"), { ...ok, video: { provider: "youtube", id: "x", src: "https://evil" } }));
});

/* ===================== v2: quick guides, learning paths, reviews ===================== */
const guide = (over = {}) => ({
  title: "Export for web", category: "photography", topics: ["Exporting and delivering images"], status: "published", instructorUid: "inst", instructorName: "Ines",
  video: null, body: "Long edge 2048 px.", resources: [], thumb: null, durationMinutes: 2,
  createdAt: new Date(1), createdBy: "admin", updatedAt: new Date(1), updatedBy: "admin", ...over,
});
const pathDoc = (over = {}) => ({
  title: "Short-Form Content", purpose: "Idea → posted", category: "", topics: [], status: "published", instructorUid: "inst", instructorName: "Ines", cover: null,
  items: [{ id: "a", type: "guide", guideId: "gpub", required: true, label: "Plan" }, { id: "b", type: "lesson", courseId: "pub", lessonId: "l1", required: true, label: "Film" }],
  createdAt: new Date(1), createdBy: "admin", updatedAt: new Date(1), updatedBy: "admin", ...over,
});

test("guides: published readable by approved members; drafts only by editors; category enum accepts legacy ids", async () => {
  await seed("guides", "gpub", guide());
  await seed("guides", "gdraft", guide({ status: "draft" }));
  await assertSucceeds(getDoc(doc(as("member"), "guides", "gpub")));
  await assertFails(getDoc(doc(as("pending"), "guides", "gpub")));
  await assertFails(getDoc(doc(as("member"), "guides", "gdraft")));
  await assertSucceeds(getDoc(doc(as("inst"), "guides", "gdraft")));
  await assertSucceeds(getDoc(doc(as("admin"), "guides", "gdraft")));
  await assertSucceeds(getDocs(query(collection(as("member"), "guides"), where("status", "==", "published"))));
  await assertFails(getDocs(collection(as("member"), "guides")));
  const fresh = (over) => guide({ status: "draft", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over });
  await assertSucceeds(setDoc(doc(as("admin"), "guides", "g1"), fresh()));
  await assertSucceeds(setDoc(doc(as("admin"), "guides", "g2"), fresh({ category: "social-media" })), "legacy id still accepted on write");
  await assertFails(setDoc(doc(as("admin"), "guides", "g3"), fresh({ category: "reels" })), "not a category");
  await assertFails(setDoc(doc(as("admin"), "guides", "g4"), fresh({ status: "published" })), "born as draft only");
  await assertSucceeds(setDoc(doc(as("inst"), "guides", "g5"), fresh({ createdBy: "inst", updatedBy: "inst" })), "Academy editors create guides");
  await assertFails(setDoc(doc(as("exinst"), "guides", "g5b"), fresh({ createdBy: "exinst", updatedBy: "exinst" })));
  await assertFails(setDoc(doc(as("admin"), "guides", "g6"), fresh({ quiz: { mode: "required" } })), "guides have no quiz field");
  await assertSucceeds(updateDoc(doc(as("inst"), "guides", "gdraft"), { status: "published", publishedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: "inst" }));
  await assertFails(updateDoc(doc(as("member"), "guides", "gpub"), { body: "x", updatedAt: serverTimestamp(), updatedBy: "member" }));
  await assertFails(updateDoc(doc(as("exinst"), "guides", "gpub"), { body: "x", updatedAt: serverTimestamp(), updatedBy: "exinst" }));
  await assertFails(deleteDoc(doc(as("admin"), "guides", "gpub")), "never delete a published guide");
  await assertSucceeds(deleteDoc(doc(as("admin"), "guides", "g1")));
});

test("guide discussion: same boundary as lessons (real role, own edits, editor moderation, drafts closed)", async () => {
  await seed("guides", "gpub", guide());
  await seed("guides", "gdraft", guide({ status: "draft" }));
  const col = (uid, g = "gpub") => collection(as(uid), `guides/${g}/comments`);
  await assertSucceeds(addDoc(col("member"), comment("member")));
  await assertFails(addDoc(col("member"), comment("member", { role: "instructor" })));
  await assertSucceeds(addDoc(col("inst"), comment("inst", { role: "moderator" })));
  await assertFails(addDoc(col("member", "gdraft"), comment("member")));
  await seed("guides/gpub/comments", "c1", { uid: "member", name: "Mel", role: "learner", txt: "hi", parentId: null, pinned: false, createdAt: new Date(1) });
  await assertSucceeds(updateDoc(doc(as("member"), "guides/gpub/comments", "c1"), { txt: "edited", editedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("member"), "guides/gpub/comments", "c1"), { txt: "x", pinned: true, editedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as("inst"), "guides/gpub/comments", "c1"), { txt: "edited", pinned: true, editedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(as("other"), "guides/gpub/comments", "c1")));
  await assertSucceeds(deleteDoc(doc(as("member"), "guides/gpub/comments", "c1")));
});

test("guide reviews: the learner's own self-report; not on drafts; leaders read any", async () => {
  await seed("guides", "gpub", guide());
  await seed("guides", "gdraft", guide({ status: "draft" }));
  const rev = (uid, g, over = {}) => ({ uid, guideId: g, reviewed: true, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over });
  await assertSucceeds(setDoc(doc(as("member"), "learnerProgress/member/guideReviews", "gpub"), rev("member", "gpub")));
  await assertSucceeds(setDoc(doc(as("member"), "learnerProgress/member/guideReviews", "gpub"), { uid: "member", guideId: "gpub", reviewed: false, updatedAt: serverTimestamp() }, { merge: true }), "un-review");
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/guideReviews", "gdraft"), rev("member", "gdraft")), "draft");
  await assertFails(setDoc(doc(as("member"), "learnerProgress/other/guideReviews", "gpub"), rev("other", "gpub")), "someone else's record");
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/guideReviews", "gpub"), rev("member", "gpub", { score: 100 })), "no assessment fields");
  await assertFails(setDoc(doc(as("pending"), "learnerProgress/pending/guideReviews", "gpub"), rev("pending", "gpub")));
  await assertSucceeds(getDoc(doc(as("lead"), "learnerProgress/member/guideReviews", "gpub")));
  await assertFails(getDoc(doc(as("other"), "learnerProgress/member/guideReviews", "gpub")));
  await assertSucceeds(getDocs(query(collectionGroup(as("lead"), "guideReviews"), where("guideId", "==", "gpub"))));
  await assertFails(getDocs(query(collectionGroup(as("member"), "guideReviews"), where("guideId", "==", "gpub"))));
  await assertFails(deleteDoc(doc(as("member"), "learnerProgress/member/guideReviews", "gpub")));
});

test("paths: visibility + editing mirror courses; a published path never opens the draft content it references", async () => {
  await seed("guides", "gpub", guide());
  await seed("paths", "ppub", pathDoc({ items: [{ id: "a", type: "guide", guideId: "gpub", required: true }, { id: "d", type: "lesson", courseId: "draft", lessonId: "l1", required: true, label: "Draft step" }] }));
  await seed("paths", "pdraft", pathDoc({ status: "draft" }));
  await assertSucceeds(getDoc(doc(as("member"), "paths", "ppub")));
  await assertFails(getDoc(doc(as("member"), "paths", "pdraft")));
  await assertSucceeds(getDoc(doc(as("inst"), "paths", "pdraft")));
  await assertFails(getDoc(doc(as("pending"), "paths", "ppub")));
  await assertFails(getDocs(collection(as("member"), "paths")));
  await assertSucceeds(getDocs(query(collection(as("member"), "paths"), where("status", "==", "published"))));
  // the referenced draft course + lesson stay closed to the learner even though the path is published
  await assertFails(getDoc(doc(as("member"), "courses", "draft")));
  await assertFails(getDoc(doc(as("member"), "courses/draft/lessons", "l1")));
  const fresh = (over) => pathDoc({ status: "draft", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over });
  await assertSucceeds(setDoc(doc(as("admin"), "paths", "p1"), fresh()));
  await assertSucceeds(setDoc(doc(as("inst"), "paths", "p2"), fresh({ createdBy: "inst", updatedBy: "inst" })), "Academy editors create paths");
  await assertFails(setDoc(doc(as("admin"), "paths", "p3"), fresh({ status: "published" })));
  await assertFails(setDoc(doc(as("admin"), "paths", "p4"), fresh({ category: "reels" })));
  await assertFails(setDoc(doc(as("admin"), "paths", "p5"), fresh({ lessons: [] })), "paths carry references only — no copied content fields");
  await assertSucceeds(updateDoc(doc(as("inst"), "paths", "pdraft"), { status: "published", publishedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: "inst" }));
  await assertFails(updateDoc(doc(as("member"), "paths", "ppub"), { title: "x", updatedAt: serverTimestamp(), updatedBy: "member" }));
  await assertFails(updateDoc(doc(as("exinst"), "paths", "ppub"), { title: "x", updatedAt: serverTimestamp(), updatedBy: "exinst" }));
  await assertFails(deleteDoc(doc(as("admin"), "paths", "ppub")));
  await assertSucceeds(deleteDoc(doc(as("admin"), "paths", "p1")));
});

test("path bookkeeping: learner-owned, no completion fields, not on drafts; leaders read", async () => {
  await seed("paths", "ppub", pathDoc());
  await seed("paths", "pdraft", pathDoc({ status: "draft" }));
  const pp = (uid, p, over = {}) => ({ uid, pathId: p, startedAt: serverTimestamp(), lastItemKey: "guide:gpub", lastViewedAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over });
  await assertSucceeds(setDoc(doc(as("member"), "learnerProgress/member/pathProgress", "ppub"), pp("member", "ppub")));
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/pathProgress", "pdraft"), pp("member", "pdraft")));
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/pathProgress", "ppub"), pp("member", "ppub", { completed: true })), "no completion flag — it's derived");
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/pathProgress", "ppub"), pp("member", "ppub", { earned: { a: 1 } })));
  await assertFails(setDoc(doc(as("other"), "learnerProgress/member/pathProgress", "ppub"), pp("member", "ppub")));
  await assertSucceeds(getDoc(doc(as("lead"), "learnerProgress/member/pathProgress", "ppub")));
  await assertFails(getDoc(doc(as("other"), "learnerProgress/member/pathProgress", "ppub")));
  await assertSucceeds(getDocs(query(collectionGroup(as("admin"), "pathProgress"), where("pathId", "==", "ppub"))));
  await assertFails(getDocs(query(collectionGroup(as("member"), "pathProgress"), where("pathId", "==", "ppub"))));
});

test("leader cross-course reads used by the path progress view: `in` queries allowed for leaders only", async () => {
  await seed("learnerProgress/member/courseProgress", "pub", { uid: "member", courseId: "pub", updatedAt: new Date(1), lessons: {}, earned: {} });
  await assertSucceeds(getDocs(query(collectionGroup(as("lead"), "courseProgress"), where("courseId", "in", ["pub", "draft"]))));
  await assertFails(getDocs(query(collectionGroup(as("member"), "courseProgress"), where("courseId", "in", ["pub", "draft"]))));
});

test("courses: topics are bounded and category writes accept the new ids", async () => {
  await assertSucceeds(updateDoc(doc(as("admin"), "courses", "pub"), { category: "filmmaking", topics: ["Instagram Reels", "CapCut"], updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertSucceeds(updateDoc(doc(as("admin"), "courses", "pub"), { category: "heart-of-serving", updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertFails(updateDoc(doc(as("admin"), "courses", "pub"), { topics: Array.from({ length: 13 }, (_, i) => `t${i}`), updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertFails(updateDoc(doc(as("admin"), "courses", "pub"), { topics: "not-a-list", updatedAt: serverTimestamp(), updatedBy: "admin" }));
});

/* ===================== v3: category artwork, intro flag, lesson kinds, preview video ===================== */
test("academySettings/categories: only the fixed category ids may carry artwork; admin-only; names can't be stored", async () => {
  const ok = { art: { filmmaking: { path: "academy/categoryArt/filmmaking/v1.jpg" } }, updatedAt: serverTimestamp(), updatedBy: "admin" };
  await assertSucceeds(setDoc(doc(as("admin"), "academySettings", "categories"), ok));
  await assertSucceeds(getDoc(doc(as("member"), "academySettings", "categories")));
  await assertFails(getDoc(doc(as("pending"), "academySettings", "categories")));
  await assertFails(setDoc(doc(as("inst"), "academySettings", "categories"), { ...ok, updatedBy: "inst" }));
  await assertFails(setDoc(doc(as("admin"), "academySettings", "categories"), { ...ok, art: { reels: { path: "academy/categoryArt/reels/v1.jpg" } } }), "unknown category id");
  await assertFails(setDoc(doc(as("admin"), "academySettings", "categories"), { ...ok, names: { filmmaking: "Video" } }), "no renaming via settings");
  await assertFails(setDoc(doc(as("admin"), "academySettings", "categories"), { ...ok, art: { filmmaking: { path: "../evil" } } }));
});

test("intro (Start here) watched flag: the learner's own, bool only; leaders read", async () => {
  const d = { uid: "member", watched: true, watchedAt: serverTimestamp(), updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(as("member"), "learnerProgress/member/intro", "purposeVideo"), d));
  await assertFails(setDoc(doc(as("member"), "learnerProgress/other/intro", "purposeVideo"), { ...d, uid: "other" }));
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/intro", "purposeVideo"), { ...d, watched: "yes" }));
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/intro", "purposeVideo"), { ...d, score: 1 }));
  await assertFails(setDoc(doc(as("pending"), "learnerProgress/pending/intro", "purposeVideo"), { ...d, uid: "pending" }));
  await assertSucceeds(getDoc(doc(as("lead"), "learnerProgress/member/intro", "purposeVideo")));
  await assertFails(getDoc(doc(as("other"), "learnerProgress/member/intro", "purposeVideo")));
});

test("lessons carry a content kind from the fixed set; courses may carry an explicit preview video", async () => {
  for (const kind of ["video", "written", "exercise", "resource"])
    await assertSucceeds(setDoc(doc(as("inst"), "courses/pub/lessons", `k-${kind}`), lesson({ kind, video: kind === "video" ? { provider: "youtube", id: "dQw4w9WgXcQ" } : null, updatedAt: serverTimestamp() })));
  await assertFails(setDoc(doc(as("inst"), "courses/pub/lessons", "k-bad"), lesson({ kind: "trailer", updatedAt: serverTimestamp() })));
  await assertSucceeds(updateDoc(doc(as("admin"), "courses", "pub"), { previewVideo: { provider: "vimeo", id: "123456" }, updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertFails(updateDoc(doc(as("admin"), "courses", "pub"), { previewVideo: { provider: "youtube", id: "x", embedUrl: "javascript:1" }, updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertSucceeds(updateDoc(doc(as("admin"), "courses", "pub"), { previewVideo: null, updatedAt: serverTimestamp(), updatedBy: "admin" }));
});

test("reordering: an editor rewrites `modules` only; lesson docs, comments and attempts are untouched and still readable at their ids", async () => {
  await seed("courses/pub/lessons", "l2", lesson({ title: "L2" }));
  await seed("courses/pub/lessons/l1/comments", "c1", { uid: "member", name: "Mel", role: "learner", txt: "hi", parentId: null, pinned: false, createdAt: new Date(1) });
  await seed("quizAttempts/member/attempts", "a1", { uid: "member", courseId: "pub", lessonId: "l1", passed: true, percent: 100, createdAt: new Date(1) });
  await assertSucceeds(updateDoc(doc(as("inst"), "courses", "pub"), { modules: [{ id: "m1", title: "", lessonIds: ["l2", "l1"] }], updatedAt: serverTimestamp(), updatedBy: "inst" }));
  await assertFails(updateDoc(doc(as("member"), "courses", "pub"), { modules: [{ id: "m1", title: "", lessonIds: ["l1", "l2"] }], updatedAt: serverTimestamp(), updatedBy: "member" }));
  await assertSucceeds(getDoc(doc(as("member"), "courses/pub/lessons", "l1")));
  await assertSucceeds(getDoc(doc(as("member"), "courses/pub/lessons/l1/comments", "c1")));
  await assertSucceeds(getDoc(doc(as("member"), "quizAttempts/member/attempts", "a1")));
});


/* ===================== v4: category + topic records, hidden categories, editor role ===================== */
const catRec = (over = {}) => ({ name: "Lighting & Sound", short: "", description: "d", order: 9, hidden: false, cover: null, createdAt: serverTimestamp(), createdBy: "admin", updatedAt: serverTimestamp(), updatedBy: "admin", ...over });

test("category records: admins create/rename/describe/reorder/delete; ids are slugs; strict fields; everyone approved reads", async () => {
  await assertSucceeds(setDoc(doc(as("admin"), "academyCategories", "lighting-and-sound"), catRec()));
  await assertFails(setDoc(doc(as("admin"), "academyCategories", "Bad Id!"), catRec()), "id format");
  await assertFails(setDoc(doc(as("inst"), "academyCategories", "x"), catRec({ createdBy: "inst", updatedBy: "inst" })), "editors don't manage categories");
  await assertFails(setDoc(doc(as("member"), "academyCategories", "y"), catRec({ createdBy: "member", updatedBy: "member" })));
  await assertFails(setDoc(doc(as("admin"), "academyCategories", "z"), catRec({ name: "" })), "name required");
  await assertFails(setDoc(doc(as("admin"), "academyCategories", "z2"), catRec({ cover: { path: "../x" } })), "cover must be an academy/ ref");
  await assertFails(setDoc(doc(as("admin"), "academyCategories", "z3"), catRec({ color: "red" })), "strict keys");
  // rename keeps the id (associations untouched)
  await assertSucceeds(updateDoc(doc(as("admin"), "academyCategories", "filmmaking"), { name: "Film & Video", updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertSucceeds(getDoc(doc(as("member"), "courses", "pub")), "courses still resolve after a rename");
  await assertFails(updateDoc(doc(as("admin"), "academyCategories", "filmmaking"), { createdAt: new Date(5), updatedAt: serverTimestamp(), updatedBy: "admin" }), "creation stamp is immutable");
  await assertSucceeds(getDoc(doc(as("member"), "academyCategories", "filmmaking")));
  await assertFails(getDoc(doc(as("pending"), "academyCategories", "filmmaking")));
  await assertFails(deleteDoc(doc(as("inst"), "academyCategories", "filmmaking")));
  await assertSucceeds(deleteDoc(doc(as("admin"), "academyCategories", "lighting-and-sound")));
  // a new category record is immediately valid for content
  await assertSucceeds(setDoc(doc(as("admin"), "academyCategories", "audio"), catRec({ name: "Audio" })));
  await assertSucceeds(updateDoc(doc(as("admin"), "courses", "pub"), { category: "audio", updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertFails(updateDoc(doc(as("admin"), "courses", "pub"), { category: "never-created", updatedAt: serverTimestamp(), updatedBy: "admin" }), "content can't point at a missing category");
});

test("hiding a category hides its PUBLISHED courses, lessons, comments and quiz progress from learners — editors keep access; restoring brings them back", async () => {
  await seed("academySettings", "categoryIndex", { hidden: ["photography"], updatedAt: new Date(1), updatedBy: "admin" });
  await seed("courses/pub/lessons/l1/comments", "c1", { uid: "member", name: "Mel", role: "learner", txt: "hi", parentId: null, pinned: false, createdAt: new Date(1) });
  await assertFails(getDoc(doc(as("member"), "courses", "pub")), "direct route");
  await assertFails(getDoc(doc(as("member"), "courses/pub/lessons", "l1")));
  await assertFails(getDoc(doc(as("member"), "courses/pub/lessons/l1/comments", "c1")));
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/courseProgress", "pub"), { uid: "member", courseId: "pub", startedAt: serverTimestamp(), updatedAt: serverTimestamp(), lessons: {} }));
  await assertFails(getDocs(query(collection(as("member"), "courses"), where("status", "==", "published"), where("category", "in", ["photography"]))), "listing the hidden category");
  await assertSucceeds(getDocs(query(collection(as("member"), "courses"), where("status", "==", "published"), where("category", "in", ["filmmaking", "graphic-design"]))), "listing visible ones");
  await assertSucceeds(getDoc(doc(as("inst"), "courses", "pub")), "editors still see it");
  await assertSucceeds(getDoc(doc(as("admin"), "courses/pub/lessons", "l1")));
  // the course's own status is untouched; restoring the category restores access
  await seed("academySettings", "categoryIndex", { hidden: [], updatedAt: new Date(2), updatedBy: "admin" });
  await assertSucceeds(getDoc(doc(as("member"), "courses", "pub")));
  await assertFails(getDoc(doc(as("member"), "courses", "draft")), "restoring a category never publishes drafts");
});

test("categoryIndex: admin-only write, approved read", async () => {
  const d = { hidden: ["photography"], updatedAt: serverTimestamp(), updatedBy: "admin" };
  await assertSucceeds(setDoc(doc(as("admin"), "academySettings", "categoryIndex"), d));
  await assertFails(setDoc(doc(as("inst"), "academySettings", "categoryIndex"), { ...d, updatedBy: "inst" }));
  await assertFails(setDoc(doc(as("member"), "academySettings", "categoryIndex"), { hidden: [], updatedAt: serverTimestamp(), updatedBy: "member" }), "a learner can't un-hide");
  await assertSucceeds(getDoc(doc(as("member"), "academySettings", "categoryIndex")));
});

test("topic records: editors create, admins rename/hide/delete, learners read only", async () => {
  const t = (over = {}) => ({ name: "Colour grading", description: "", hidden: false, createdAt: serverTimestamp(), createdBy: "inst", updatedAt: serverTimestamp(), updatedBy: "inst", ...over });
  await assertSucceeds(setDoc(doc(as("inst"), "academyTopics", "colour-grading"), t()));
  await assertFails(setDoc(doc(as("member"), "academyTopics", "x"), t({ createdBy: "member", updatedBy: "member" })));
  await assertFails(setDoc(doc(as("inst"), "academyTopics", "Bad Id"), t()));
  await assertFails(setDoc(doc(as("inst"), "academyTopics", "y"), t({ name: "" })));
  await assertFails(updateDoc(doc(as("inst"), "academyTopics", "colour-grading"), { name: "Grading", updatedAt: serverTimestamp(), updatedBy: "inst" }), "renames are admin-only");
  await assertSucceeds(updateDoc(doc(as("admin"), "academyTopics", "colour-grading"), { name: "Colour grading & LUTs", hidden: true, updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertSucceeds(getDoc(doc(as("member"), "academyTopics", "colour-grading")));
  await assertFails(deleteDoc(doc(as("inst"), "academyTopics", "colour-grading")));
  await assertSucceeds(deleteDoc(doc(as("admin"), "academyTopics", "colour-grading")));
  // content carries topicIds (bounded)
  await assertSucceeds(updateDoc(doc(as("inst"), "courses", "pub"), { topicIds: ["colour-grading"], updatedAt: serverTimestamp(), updatedBy: "inst" }));
  await assertFails(updateDoc(doc(as("inst"), "courses", "pub"), { topicIds: Array.from({ length: 13 }, (_, i) => `t${i}`), updatedAt: serverTimestamp(), updatedBy: "inst" }));
});

test("the Academy-editor role can't be self-granted at registration, and members can't edit their own profile into it", async () => {
  await assertFails(setDoc(doc(as("newbie"), "users", "newbie"), { name: "N", role: "member", status: "pending", academyEditor: true }));
  await assertSucceeds(setDoc(doc(as("newbie2"), "users", "newbie2"), { name: "N", role: "member", status: "pending" }));
  await assertFails(updateDoc(doc(as("member"), "users", "member"), { academyEditor: true }));
});

test("lessons: thumbnail mode + provider metadata are validated (https-only provider thumbnail, bounded fields)", async () => {
  const meta = { title: "T", author: "A", authorUrl: "https://www.youtube.com/@a", thumbnailUrl: "https://i.ytimg.com/vi/x/hqdefault.jpg", sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", fetchedAt: 1 };
  await assertSucceeds(setDoc(doc(as("inst"), "courses/pub/lessons", "m1"), lesson({ videoMeta: meta, thumbMode: "source", updatedAt: serverTimestamp() })));
  await assertSucceeds(setDoc(doc(as("inst"), "courses/pub/lessons", "m2"), lesson({ thumbMode: "custom", thumb: { path: "academy/lessonThumbs/pub/m2/v1.jpg" }, updatedAt: serverTimestamp() })));
  await assertFails(setDoc(doc(as("inst"), "courses/pub/lessons", "m3"), lesson({ thumbMode: "auto", updatedAt: serverTimestamp() })));
  await assertFails(setDoc(doc(as("inst"), "courses/pub/lessons", "m4"), lesson({ videoMeta: { ...meta, thumbnailUrl: "javascript:alert(1)" }, updatedAt: serverTimestamp() })));
  await assertFails(setDoc(doc(as("inst"), "courses/pub/lessons", "m5"), lesson({ videoMeta: { ...meta, html: "<iframe>" }, updatedAt: serverTimestamp() })), "no provider HTML stored");
});

test("permanent course delete: progress + attempts can be cleaned up by an admin only once the course is gone", async () => {
  await seed("learnerProgress/member/courseProgress", "draft", { uid: "member", courseId: "draft", updatedAt: new Date(1), lessons: {}, earned: { l1: {} } });
  await seed("quizAttempts/member/attempts", "a9", { uid: "member", courseId: "draft", lessonId: "l1", passed: true, percent: 100, createdAt: new Date(1) });
  await assertFails(deleteDoc(doc(as("admin"), "learnerProgress/member/courseProgress", "draft")), "course still exists");
  await assertFails(deleteDoc(doc(as("admin"), "quizAttempts/member/attempts", "a9")), "course still exists");
  await assertSucceeds(deleteDoc(doc(as("admin"), "courses", "draft")));
  await assertFails(deleteDoc(doc(as("inst"), "learnerProgress/member/courseProgress", "draft")), "editors can't delete learner records");
  await assertFails(deleteDoc(doc(as("member"), "learnerProgress/member/courseProgress", "draft")), "a learner can't wipe their own record either");
  await assertSucceeds(deleteDoc(doc(as("admin"), "learnerProgress/member/courseProgress", "draft")));
  await assertSucceeds(deleteDoc(doc(as("admin"), "quizAttempts/member/attempts", "a9")));
});

/* ===================== v5: deletion clean-up record, path completion date ===================== */
test("pendingCleanup: admins read/write it; members and Academy editors can't even read it", async () => {
  const d = { courses: { c9: { title: "Gone", images: ["academy/covers/c9/v1.jpg"], at: 1 } }, updatedAt: serverTimestamp(), updatedBy: "admin" };
  await assertSucceeds(setDoc(doc(as("admin"), "academySettings", "pendingCleanup"), d));
  await assertSucceeds(getDoc(doc(as("admin"), "academySettings", "pendingCleanup")));
  await assertFails(getDoc(doc(as("member"), "academySettings", "pendingCleanup")), "the generic settings read rule excludes it");
  await assertFails(getDoc(doc(as("inst"), "academySettings", "pendingCleanup")));
  await assertFails(setDoc(doc(as("inst"), "academySettings", "pendingCleanup"), { ...d, updatedBy: "inst" }));
  await assertFails(setDoc(doc(as("admin"), "academySettings", "pendingCleanup"), { ...d, extra: 1 }), "strict keys");
});

test("path completion date: the learner records it on their own doc for a visible path only", async () => {
  await seed("paths", "ppub", pathDoc());
  await seed("paths", "pdraft", pathDoc({ status: "draft" }));
  const pp = (uid, p) => ({ uid, pathId: p, completedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  await assertSucceeds(setDoc(doc(as("member"), "learnerProgress/member/pathProgress", "ppub"), pp("member", "ppub"), { merge: true }));
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/pathProgress", "pdraft"), pp("member", "pdraft"), { merge: true }));
  await assertFails(setDoc(doc(as("member"), "learnerProgress/other/pathProgress", "ppub"), pp("other", "ppub"), { merge: true }));
  await assertSucceeds(getDoc(doc(as("lead"), "learnerProgress/member/pathProgress", "ppub")));
});

/* ===================================================================
   v6 — course DRAFTS (private working copy) + Publish
   =================================================================== */
const draftHead = (over = {}) => ({
  title: "New course", category: "photography", level: "beginner", about: "", outcomes: [], requirements: [], cover: null, previewVideo: null,
  topicIds: [], topics: [], modules: [{ id: "m1", title: "", lessonIds: ["d1"] }], rev: 1, publishedRev: 0,
  createdAt: serverTimestamp(), createdBy: "inst", updatedAt: serverTimestamp(), updatedBy: "inst", ...over,
});
const draftLesson = (over = {}) => ({
  title: "Intro", moduleId: "m1", kind: "video", video: { provider: "youtube", id: "dQw4w9WgXcQ" },
  videoMeta: { id: "dQw4w9WgXcQ", title: "T", author: "", authorUrl: "", thumbnailUrl: "", sourceUrl: "", fetchedAt: 1, durationSec: 212 },
  thumbMode: "source", description: "", resources: [{ label: "Doc", url: "https://example.com/a.pdf", fileType: "PDF", restricted: true }], thumb: null, bonus: false, durationMinutes: 0,
  quiz: { mode: "required", passMark: 70, retryLimit: 0, questions: [{ id: "q1", prompt: "?", multi: false, options: [{ id: "a", text: "A" }, { id: "b", text: "B" }] }] },
  quizKey: { answers: { q1: ["a"] }, explanations: {} }, createdAtMs: 1, updatedAt: serverTimestamp(), ...over,
});
const { writeBatch, runTransaction } = await import("firebase/firestore");

test("drafts: only Academy editors create/read them (learners, pending users and ex-editors can't see answer keys or unpublished work)", async () => {
  const db = as("inst");
  const b = writeBatch(db);
  b.set(doc(db, "courseDrafts", "c1"), draftHead());
  b.set(doc(db, "courseDrafts/c1/lessons", "d1"), draftLesson());
  await assertSucceeds(b.commit());
  for (const u of ["member", "lead", "pending", "exinst", "exadmin"]) {
    await assertFails(getDoc(doc(as(u), "courseDrafts", "c1")));
    await assertFails(getDoc(doc(as(u), "courseDrafts/c1/lessons", "d1")));
  }
  await assertSucceeds(getDoc(doc(as("admin"), "courseDrafts/c1/lessons", "d1")));
  await assertFails(setDoc(doc(as("member"), "courseDrafts", "c2"), draftHead({ createdBy: "member", updatedBy: "member" })));
  // a new draft must start at rev 1 with honest stamps
  await assertFails(setDoc(doc(as("inst"), "courseDrafts", "c3"), draftHead({ rev: 5 })));
  await assertFails(setDoc(doc(as("inst"), "courseDrafts", "c4"), draftHead({ createdBy: "admin" })));
});

test("drafts: every save bumps rev by exactly one — a stale editor's write is rejected (concurrent edits are detected)", async () => {
  await assertSucceeds(setDoc(doc(as("inst"), "courseDrafts", "c1"), draftHead({ modules: [] })));
  await assertSucceeds(updateDoc(doc(as("admin"), "courseDrafts", "c1"), { title: "Admin edit", rev: 2, updatedAt: serverTimestamp(), updatedBy: "admin" }));
  // the editor still thinks rev is 1 → writes rev 2 again → denied
  await assertFails(updateDoc(doc(as("inst"), "courseDrafts", "c1"), { title: "Stale edit", rev: 2, updatedAt: serverTimestamp(), updatedBy: "inst" }));
  await assertFails(updateDoc(doc(as("inst"), "courseDrafts", "c1"), { title: "Skip", rev: 9, updatedAt: serverTimestamp(), updatedBy: "inst" }));
  await assertFails(updateDoc(doc(as("inst"), "courseDrafts", "c1"), { createdBy: "admin", rev: 3, updatedAt: serverTimestamp(), updatedBy: "inst" }), "creation stamp is immutable");
  await assertSucceeds(updateDoc(doc(as("inst"), "courseDrafts", "c1"), { title: "Fresh edit", rev: 3, updatedAt: serverTimestamp(), updatedBy: "inst" }));
  // the transaction the app uses: read rev, write rev+1
  const idb = as("inst");
  await assertSucceeds(runTransaction(idb, async (tx) => {
    const s = await tx.get(doc(idb, "courseDrafts", "c1"));
    tx.update(s.ref, { about: "x", rev: s.data().rev + 1, updatedAt: serverTimestamp(), updatedBy: "inst" });
  }));
});

test("draft lessons change only together with a rev bump; unknown fields and bad metadata are refused", async () => {
  const db = as("inst");
  await assertSucceeds(setDoc(doc(db, "courseDrafts", "c1"), draftHead({ modules: [] })));
  await assertFails(setDoc(doc(db, "courseDrafts/c1/lessons", "d1"), draftLesson()));          // no head bump
  const ok = writeBatch(db);
  ok.update(doc(db, "courseDrafts", "c1"), { rev: 2, updatedAt: serverTimestamp(), updatedBy: "inst" });
  ok.set(doc(db, "courseDrafts/c1/lessons", "d1"), draftLesson());
  await assertSucceeds(ok.commit());
  for (const bad of [{ status: "published" }, { videoMeta: { durationSec: -4 } }, { videoMeta: { isLive: "yes" } }, { kind: "submission" }]) {
    const b = writeBatch(db);
    b.update(doc(db, "courseDrafts", "c1"), { rev: 3, updatedAt: serverTimestamp(), updatedBy: "inst" });
    b.set(doc(db, "courseDrafts/c1/lessons", "d2"), draftLesson(bad));
    await assertFails(b.commit());
  }
  const del = writeBatch(db);
  del.update(doc(db, "courseDrafts", "c1"), { rev: 3, updatedAt: serverTimestamp(), updatedBy: "inst" });
  del.delete(doc(db, "courseDrafts/c1/lessons", "d1"));
  await assertSucceeds(del.commit());
});

test("discarding a draft: editors only while never published; admins always (permanent delete)", async () => {
  await assertSucceeds(setDoc(doc(as("inst"), "courseDrafts", "neverpub"), draftHead({ modules: [] })));
  await assertFails(deleteDoc(doc(as("member"), "courseDrafts", "neverpub")));
  await assertSucceeds(deleteDoc(doc(as("inst"), "courseDrafts", "neverpub")));
  await seed("courseDrafts", "pub", { ...draftHead({ modules: [] }), rev: 4, publishedRev: 3, createdAt: new Date(1), updatedAt: new Date(1) });
  await assertFails(deleteDoc(doc(as("inst"), "courseDrafts", "pub")));
  await assertSucceeds(deleteDoc(doc(as("admin"), "courseDrafts", "pub")));
});

/* The exact writes publishCourseDraft makes, in one transaction. */
async function publishTx(uid, cid, { first, lessonIds, removeIds = [] }) {
  const db = as(uid);
  return runTransaction(db, async (tx) => {
    const head = await tx.get(doc(db, "courseDrafts", cid));
    const live = await tx.get(doc(db, "courses", cid));
    const now = serverTimestamp();
    const shaped = { title: "Published title", category: "photography", level: "beginner", topics: [], topicIds: [], about: "", outcomes: [], requirements: [],
      modules: [{ id: "m1", title: "", lessonIds }], cover: null, previewVideo: null, lessonCount: lessonIds.length, requiredLessonCount: lessonIds.length,
      requiredQuizLessonIds: lessonIds, bonusLessonIds: [], durationMinutes: 0, status: "published", updatedAt: now, updatedBy: uid };
    if (first) tx.set(doc(db, "courses", cid), { ...shaped, createdAt: now, createdBy: uid, publishedAt: now });
    else tx.update(doc(db, "courses", cid), shaped);
    for (const id of lessonIds) {
      const { quizKey, ...l } = draftLesson();
      tx.set(doc(db, `courses/${cid}/lessons`, id), { ...l, updatedAt: now });
      tx.set(doc(db, `courses/${cid}/quizKeys`, id), { ...quizKey, updatedAt: now });
    }
    for (const id of removeIds) { tx.delete(doc(db, `courses/${cid}/lessons`, id)); tx.delete(doc(db, `courses/${cid}/quizKeys`, id)); }
    const rev = head.data().rev + 1;
    tx.update(doc(db, "courseDrafts", cid), { rev, publishedRev: rev, updatedAt: now, updatedBy: uid });
    return { rev, existed: live.exists() };
  });
}

test("first Publish creates the live course + lessons + answer keys in one transaction; learners then see it, never the key", async () => {
  const db = as("inst");
  const b = writeBatch(db);
  b.set(doc(db, "courseDrafts", "fresh"), draftHead());
  b.set(doc(db, "courseDrafts/fresh/lessons", "d1"), draftLesson());
  await b.commit();
  await assertFails(getDoc(doc(as("member"), "courses", "fresh")));
  const r = await assertSucceeds(publishTx("inst", "fresh", { first: true, lessonIds: ["d1"] }));
  assert.equal(r.rev, 2);
  await assertSucceeds(getDoc(doc(as("member"), "courses", "fresh")));
  await assertSucceeds(getDoc(doc(as("member"), "courses/fresh/lessons", "d1")));
  await assertFails(getDoc(doc(as("member"), "courses/fresh/quizKeys", "d1")));
  const head = (await getDoc(doc(as("inst"), "courseDrafts", "fresh"))).data();
  assert.deepEqual([head.rev, head.publishedRev], [2, 2]);
  // a learner can't publish, and nobody can publish over a draft that moved on
  await assertFails(publishTx("member", "fresh", { first: false, lessonIds: ["d1"] }));
});

test("Publish changes: the same lesson ids are updated in place, so progress, comments and attempts stay attached; removed lessons go", async () => {
  // 'pub' is a published course with lesson l1 (see beforeEach); a learner has progress + a comment on it
  await seed("learnerProgress/member/courseProgress", "pub", { courseId: "pub", lessons: { l1: { videoWatched: true } }, updatedAt: new Date(1) });
  await seed("courses/pub/lessons/l1/comments", "c1", { authorUid: "member", text: "Great", createdAt: new Date(1) });
  await seed("courses/pub/lessons", "l2", lesson({ title: "Old lesson" }));
  await seed("courseDrafts", "pub", { ...draftHead({ modules: [{ id: "m1", title: "", lessonIds: ["l1"] }] }), rev: 5, publishedRev: 3, createdAt: new Date(1), updatedAt: new Date(1) });
  await assertSucceeds(publishTx("inst", "pub", { first: false, lessonIds: ["l1"], removeIds: ["l2"] }));
  const l1 = await getDoc(doc(as("member"), "courses/pub/lessons", "l1"));
  assert.equal(l1.exists(), true);
  assert.equal((await getDoc(doc(as("member"), "courses/pub/lessons/l1/comments", "c1"))).data().text, "Great");
  assert.equal((await getDoc(doc(as("member"), "learnerProgress/member/courseProgress", "pub"))).data().lessons.l1.videoWatched, true);
  assert.equal((await getDoc(doc(as("inst"), "courses/pub/lessons", "l2"))).exists(), false);
  assert.equal((await getDoc(doc(as("member"), "courses", "pub"))).data().title, "Published title");
});

test("saving a draft never changes what learners see until Publish", async () => {
  await seed("courseDrafts", "pub", { ...draftHead({ title: "Draft title", modules: [{ id: "m1", title: "", lessonIds: ["l1"] }] }), rev: 3, publishedRev: 3, createdAt: new Date(1), updatedAt: new Date(1) });
  await assertSucceeds(updateDoc(doc(as("inst"), "courseDrafts", "pub"), { title: "Unpublished rename", rev: 4, updatedAt: serverTimestamp(), updatedBy: "inst" }));
  assert.equal((await getDoc(doc(as("member"), "courses", "pub"))).data().title, "Lighting");
  await assertFails(getDoc(doc(as("member"), "courseDrafts", "pub")));
});

test("category drafts: admins create a hidden record + index entry in one batch with a course order; editors can't create categories", async () => {
  const mk = (db, uid) => {
    const b = writeBatch(db);
    b.set(doc(db, "academyCategories", "lighting-ab12"), { name: "Lighting", short: "", description: "", order: 6, hidden: true, cover: null, courseOrder: [], createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid });
    b.set(doc(db, "academySettings", "categoryIndex"), { hidden: ["lighting-ab12"], updatedAt: serverTimestamp(), updatedBy: uid });
    return b.commit();
  };
  await assertFails(mk(as("inst"), "inst"));
  await assertSucceeds(mk(as("admin"), "admin"));
  await assertSucceeds(updateDoc(doc(as("admin"), "academyCategories", "lighting-ab12"), { courseOrder: ["pub", "draft"], updatedAt: serverTimestamp(), updatedBy: "admin" }));
  await assertFails(updateDoc(doc(as("inst"), "academyCategories", "lighting-ab12"), { courseOrder: ["draft", "pub"], updatedAt: serverTimestamp(), updatedBy: "inst" }));
  await assertFails(updateDoc(doc(as("admin"), "academyCategories", "lighting-ab12"), { courseOrder: "pub", updatedAt: serverTimestamp(), updatedBy: "admin" }));
});

test("image-reference check: editors may query ALL lessons (live + draft) by thumb path; learners may not", async () => {
  const { collectionGroup: cg, query: q, where: w, getDocs: gd } = await import("firebase/firestore");
  await seed("courses/pub/lessons", "l9", lesson({ thumb: { path: "academy/covers/other/shared.jpg" } }));
  await seed("courseDrafts", "d1", { ...draftHead({ modules: [] }), createdAt: new Date(1), updatedAt: new Date(1) });
  await seed("courseDrafts/d1/lessons", "x", { ...draftLesson({ thumb: { path: "academy/covers/other/shared.jpg" } }), updatedAt: new Date(1) });
  const run = (uid) => gd(q(cg(as(uid), "lessons"), w("thumb.path", "==", "academy/covers/other/shared.jpg")));
  const r = await assertSucceeds(run("inst"));
  assert.equal(r.size, 2, "finds the live AND the draft lesson");
  await assertSucceeds(run("admin"));
  for (const u of ["member", "lead", "pending", "exinst"]) await assertFails(run(u));
});

test("Markdown format version: courses, lessons and drafts accept mdVersion 1 or 2 (or none), nothing else", async () => {
  await assertSucceeds(updateDoc(doc(as("inst"), "courses", "pub"), { mdVersion: 2, updatedAt: serverTimestamp(), updatedBy: "inst" }));
  await assertFails(updateDoc(doc(as("inst"), "courses", "pub"), { mdVersion: 3, updatedAt: serverTimestamp(), updatedBy: "inst" }));
  await assertFails(updateDoc(doc(as("inst"), "courses", "pub"), { mdVersion: "2", updatedAt: serverTimestamp(), updatedBy: "inst" }));
  await assertSucceeds(updateDoc(doc(as("inst"), "courses/pub/lessons", "l1"), { mdVersion: 2, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("inst"), "courses/pub/lessons", "l1"), { mdVersion: 9, updatedAt: serverTimestamp() }));
  const db = as("inst");
  const b = writeBatch(db);
  b.set(doc(db, "courseDrafts", "v2c"), draftHead({ mdVersion: 2 }));
  b.set(doc(db, "courseDrafts/v2c/lessons", "d1"), draftLesson({ mdVersion: 2 }));
  await assertSucceeds(b.commit());
  const bad = writeBatch(db);
  bad.update(doc(db, "courseDrafts", "v2c"), { rev: 2, mdVersion: 0, updatedAt: serverTimestamp(), updatedBy: "inst" });
  await assertFails(bad.commit());
});
