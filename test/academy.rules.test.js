/* IFC Creative Academy — Firestore Security Rules (allowed vs denied) against
   the emulator. Proves: draft visibility, Academy-editor boundaries, quiz
   keys never readable by learners, `earned` is server-only, attempts are
   server-written, discussion permissions, settings admin-only.

   Run (self-contained):   npm run test:academy
   Or against a running emulator: node --test test/academy.rules.test.js */
import { assertThrowawayProject } from "./emulatorGuard.js";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import {
  doc, collection, collectionGroup, query, where, setDoc, getDoc, getDocs, updateDoc, deleteDoc, addDoc, serverTimestamp, deleteField,
} from "firebase/firestore";

const PROJECT_ID = assertThrowawayProject(process.env.RULES_TEST_PROJECT || ("academy-rules-" + Date.now()));
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

/* v6.8: publishing needs the server's passing check for the draft revision,
   recording exactly what each published lesson + answer key may contain.
   approve() seeds that verdict (as the callable would) for the lessons/keys a
   test is about to write, so tests of OTHER rules can still publish. */
const lessonCheck = (l) => ({ kind: l.kind ?? "video", video: l.video ?? null, mode: l.quiz?.mode ?? "none", questions: l.quiz?.questions ?? [] });
async function approve(cid, lessons = {}, { keys = {}, ...over } = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore(); const ref = doc(db, "courseDrafts", cid); const d = await getDoc(ref);
    let rev = d.exists() ? d.data().rev : 1;
    if (!d.exists()) await setDoc(ref, { rev: 1, publishedRev: 0 });
    await setDoc(doc(db, "courseDraftChecks", cid), { rev, ok: true, issues: [], modules: [], prerequisiteMap: {},
      lessonChecks: Object.fromEntries(Object.entries(lessons).map(([id, l]) => [id, lessonCheck(l)])), answerKeys: keys, ...over });
  });
}
/* The emulator address `firebase emulators:exec` exported (an isolated run on
   other ports), else the default local ports. */
const emu = (envVar, port) => { const [h, p] = String(process.env[envVar] || "").split(":"); return { host: h || "127.0.0.1", port: Number(p) || port }; };
before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), ...emu("FIRESTORE_EMULATOR_HOST", 8080) },
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
  await approve("pub", { l1: lesson() }, { keys: { l1: { q1: ["a"] } } });
  await assertSucceeds(setDoc(doc(as("inst"), "courses/pub/quizKeys", "l1"), { answers: { q1: ["a"] }, explanations: { q1: "x" }, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(as("inst"), "courses/pub/quizKeys", "l1"), { answers: {}, leak: true }), "strict keys");
  await assertFails(deleteDoc(doc(as("member"), "courses/pub/quizKeys", "l1")));
  await assertFails(deleteDoc(doc(as("inst"), "courses/pub/quizKeys", "l1")), "v6.9: an editor can't delete a published key on its own (only as part of Publish)");
  await assertSucceeds(deleteDoc(doc(as("admin"), "courses/pub/quizKeys", "l1")), "admins can (permanent course delete)");
});

test("a lesson doc may not carry an `answers` key inside quiz (keys live in quizKeys)", async () => {
  const bad = lesson({ quiz: { mode: "required", passMark: 70, retryLimit: 0, questions: [], answers: { q1: ["a"] } }, updatedAt: serverTimestamp() });
  await approve("pub", { l2: lesson() });
  await assertFails(setDoc(doc(as("admin"), "courses/pub/lessons", "l2"), bad));
  await assertSucceeds(setDoc(doc(as("admin"), "courses/pub/lessons", "l2"), lesson({ updatedAt: serverTimestamp() })));
});

/* ---- course management ---- */
test("create: Academy editors (admin or academyEditor), draft or first-publish, stamped; members and former instructors cannot", async () => {
  const fresh = (over) => course({ status: "draft", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: "admin", updatedBy: "admin", ...over });
  await assertSucceeds(setDoc(doc(as("admin"), "courses", "new1"), fresh()));
  // v6: a first Publish creates the live doc already published (editors could
  // always publish, so this adds no capability); it can never be born archived.
  await approve("new2");
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
  await approve("draft"); await approve("pub");
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
  await approve("pub", { l9: lesson(), l8: lesson() });
  await assertSucceeds(setDoc(doc(as("inst"), "courses/pub/lessons", "l9"), lesson({ updatedAt: serverTimestamp() })));
  await assertFails(setDoc(doc(as("member"), "courses/pub/lessons", "l9"), lesson({ updatedAt: serverTimestamp() })));
  await assertFails(setDoc(doc(as("inst"), "courses/pub/lessons", "l8"), lesson({ video: { provider: "evil", id: "x" }, updatedAt: serverTimestamp() })), "provider enum");
  await assertFails(setDoc(doc(as("inst"), "courses/pub/lessons", "l8"), lesson({ video: { provider: "youtube", id: "x", embedUrl: "javascript:1" }, updatedAt: serverTimestamp() })), "no stored embed urls");
  await assertFails(deleteDoc(doc(as("inst"), "courses/pub/lessons", "l1")), "v6.9: an editor can't strip a published course's lessons outside Publish");
  await assertSucceeds(deleteDoc(doc(as("admin"), "courses/pub/lessons", "l1")), "admins can (permanent course delete)");
});

/* ---- progress ---- */
const prog = (over = {}) => ({ uid: "member", courseId: "pub", startedAt: serverTimestamp(), lastLessonId: "l1", lastViewedAt: serverTimestamp(), updatedAt: serverTimestamp(), playback: { l1: { positionSec: 30, viewedAt: serverTimestamp() } }, ...over });

test("progress (v6.4): the learner writes only view/playback data; completion flags, `earned` and the finish record are server-only", async () => {
  const ref = doc(as("member"), "learnerProgress/member/courseProgress", "pub");
  await assertSucceeds(setDoc(ref, prog()));
  await assertSucceeds(setDoc(ref, { playback: { l1: { positionSec: 90, durationSec: 300 } }, lastLessonId: "l1", lastViewedAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true }), "playback position");
  await assertFails(setDoc(ref, prog({ lessons: { l1: { videoWatched: true } } }), { merge: true }), "can't self-record a watched video");
  await assertFails(setDoc(ref, prog({ lessons: { l1: { manualDone: true } } }), { merge: true }), "can't self-mark complete (the completeLesson callable checks the order)");
  await assertFails(setDoc(ref, prog({ finishedAt: serverTimestamp() }), { merge: true }), "can't self-finish (finishCourse is server-verified)");
  await assertFails(setDoc(ref, prog({ finishedRequired: 3 }), { merge: true }));
  await assertFails(setDoc(ref, prog({ playback: "x" }), { merge: true }), "playback must be a map");
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/courseProgress", "pub2"), prog({ courseId: "pub2", earned: { l1: { at: 1 } } })), "earned on create");
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/courseProgress", "pub2"), prog({ courseId: "pub2", lessons: { l1: { manualDone: true } } })), "completion flags on create");
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/courseProgress", "pub2"), prog({ courseId: "pub2", finishedAt: serverTimestamp() })), "finish on create");
  await assertFails(setDoc(ref, prog({ earned: { l1: { at: 1 } } }), { merge: true }), "earned on update");
  // a historical doc (flags written before v6.4) keeps working: unrelated merges are fine, flags can't be changed or erased
  await seed("learnerProgress/member/courseProgress", "pub", { uid: "member", courseId: "pub", updatedAt: new Date(1), lessons: { l1: { manualDone: true, positionSec: 30 } }, earned: { l1: { at: 1 } }, finishedAt: new Date(2), finishedRequired: 2 });
  await assertFails(setDoc(ref, prog({ earned: {} }), { merge: true }), "can't clear earned");
  await assertFails(setDoc(ref, prog({ earned: { l1: { at: 1 }, l2: { at: 2 } } }), { merge: true }), "can't add to earned");
  await assertFails(updateDoc(ref, { "lessons.l1.manualDone": false, updatedAt: serverTimestamp() }), "can't un-mark a historical completion directly");
  await assertFails(updateDoc(ref, { finishedAt: deleteField(), updatedAt: serverTimestamp() }), "can't erase an earned finish");
  await assertSucceeds(setDoc(ref, prog(), { merge: true }), "a merge that leaves the server fields untouched is fine");
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

test("intro video thumbnails: thumbMode + provider metadata as on lessons; older docs (no mode) stay valid; bad values refused", async () => {
  const base = { title: "Why", intro: "x", video: { provider: "youtube", id: "LZxtveAHWsM" }, thumb: null, updatedAt: serverTimestamp(), updatedBy: "admin" };
  const meta = { id: "LZxtveAHWsM", title: "T", author: "A", authorUrl: "https://www.youtube.com/@a", thumbnailUrl: "https://i.ytimg.com/vi/LZxtveAHWsM/hqdefault.jpg", sourceUrl: "https://www.youtube.com/watch?v=LZxtveAHWsM", fetchedAt: 1 };
  const custom = { path: "academy/purpose/v1.jpg", version: "v1", contentType: "image/jpeg", bytes: 1000, w: 1280, h: 720 };
  const put = (d) => setDoc(doc(as("admin"), "academySettings", "purposeVideo"), d);
  await assertSucceeds(put(base));                                                        // the previous shape still saves
  await assertSucceeds(put({ ...base, thumbMode: "source", videoMeta: meta }));
  await assertSucceeds(put({ ...base, thumbMode: "custom", thumb: custom, videoMeta: meta }));
  await assertSucceeds(put({ ...base, thumbMode: "source", thumb: custom, videoMeta: null }));  // custom kept while the source is used
  await assertFails(put({ ...base, thumbMode: "remote" }));
  await assertFails(put({ ...base, videoMeta: { ...meta, thumbnailUrl: "http://insecure/x.jpg" } }));
  await assertFails(put({ ...base, videoMeta: { ...meta, script: "x" } }));
  await assertFails(put({ ...base, thumb: { ...custom, path: "elsewhere/x.jpg" } }));
  await assertFails(setDoc(doc(as("inst"), "academySettings", "purposeVideo"), { ...base, thumbMode: "source", videoMeta: meta, updatedBy: "inst" }));
  // other settings docs gain nothing: categoryIndex keeps its own strict shape
  await assertFails(setDoc(doc(as("admin"), "academySettings", "categoryIndex"), { hidden: [], thumbMode: "source", updatedAt: serverTimestamp(), updatedBy: "admin" }));
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
  await assertFails(updateDoc(doc(as("inst"), "guides", "gdraft"), { status: "published", publishedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: "inst" }), "v6.11: publishing goes through the draft (see the v6.11 test)");
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
  await approve("pub");
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
  await approve("pub", Object.fromEntries(["video", "written", "exercise", "resource"].map((kind) => [`k-${kind}`, lesson({ kind, video: kind === "video" ? { provider: "youtube", id: "dQw4w9WgXcQ" } : null })])));
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
  await approve("pub");
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
  await assertFails(deleteDoc(doc(as("admin"), "academyCategories", "lighting-and-sound")), "v6.10: deleted by the server (finalizeCategoryDeletion) only, after its contents are resolved");
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
  await assertFails(setDoc(doc(as("member"), "learnerProgress/member/courseProgress", "pub"), { uid: "member", courseId: "pub", startedAt: serverTimestamp(), updatedAt: serverTimestamp(), playback: {} }));
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
  await approve("pub");
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
  await approve("pub", Object.fromEntries(["m1", "m2", "m3", "m4", "m5"].map((id) => [id, lesson()])));
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
async function publishTx(uid, cid, { first, lessonIds, removeIds = [], prereqs = {}, modules = null, courseOver = {} }) {
  const db = as(uid);
  return runTransaction(db, async (tx) => {
    const head = await tx.get(doc(db, "courseDrafts", cid));
    const live = await tx.get(doc(db, "courses", cid));
    const now = serverTimestamp();
    const shaped = { title: "Published title", category: "photography", level: "beginner", topics: [], topicIds: [], about: "", outcomes: [], requirements: [],
      modules: modules || [{ id: "m1", title: "", lessonIds }], cover: null, previewVideo: null, lessonCount: lessonIds.length, requiredLessonCount: lessonIds.length,
      requiredQuizLessonIds: lessonIds, bonusLessonIds: [], durationMinutes: 0, status: "published", updatedAt: now, updatedBy: uid,
      ...(Object.keys(prereqs).length ? { prerequisiteMap: prereqs } : {}), ...courseOver };
    if (first) tx.set(doc(db, "courses", cid), { ...shaped, createdAt: now, createdBy: uid, publishedAt: now });
    else tx.update(doc(db, "courses", cid), shaped);
    for (const id of lessonIds) {
      const { quizKey, ...l } = draftLesson();
      tx.set(doc(db, `courses/${cid}/lessons`, id), { ...l, ...(prereqs[id] ? { prerequisites: prereqs[id] } : {}), updatedAt: now });
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
  const { quizKey, ...live } = draftLesson();
  await approve("fresh", { d1: live }, { keys: { d1: quizKey.answers } });
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
  { const { quizKey, ...live } = draftLesson(); await approve("pub", { l1: live }, { keys: { l1: quizKey.answers } }); }
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
  await approve("pub");
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

test("pin/unpin changes only `pinned` (no editedAt, so it never shows as 'edited'); only editors may pin; text edits still stamp editedAt", async () => {
  await seed("courses/pub/lessons/l1/comments", "cm1", { uid: "member", name: "Mel", role: "learner", txt: "Hello", parentId: null, pinned: false, createdAt: new Date(1) });
  const ref = (u) => doc(as(u), "courses/pub/lessons/l1/comments", "cm1");
  await assertSucceeds(updateDoc(ref("inst"), { pinned: true }));
  const d = (await getDoc(ref("inst"))).data();
  assert.equal(d.pinned, true);
  assert.equal(d.editedAt, undefined, "pinning doesn't mark the comment edited");
  await assertFails(updateDoc(ref("member"), { pinned: false }), "authors can't pin their own comment");
  await assertFails(updateDoc(ref("other"), { pinned: false }));
  await assertFails(updateDoc(ref("inst"), { pinned: "yes" }));
  await assertFails(updateDoc(ref("inst"), { txt: "sneaky" }), "a text change without editedAt is refused");
  await assertSucceeds(updateDoc(ref("member"), { txt: "Hello again", editedAt: serverTimestamp() }));
  await assertFails(deleteDoc(ref("other")), "only the author or an editor deletes");
  await assertSucceeds(deleteDoc(ref("member")));
});

/* ---- v6.5 prerequisites + server-only progress fields ---- */
test("prerequisites: shape is checked on drafts (no self-reference, no duplicates, ≤ 20)", async () => {
  const db = as("inst");
  const b = writeBatch(db);
  b.set(doc(db, "courseDrafts", "pre"), draftHead({ modules: [{ id: "m1", title: "", lessonIds: ["d1", "d2"] }] }));
  b.set(doc(db, "courseDrafts/pre/lessons", "d1"), draftLesson());
  b.set(doc(db, "courseDrafts/pre/lessons", "d2"), draftLesson({ prerequisites: ["d1"] }));
  await assertSucceeds(b.commit());
  const edit = (prerequisites) => { const w = writeBatch(db); w.update(doc(db, "courseDrafts", "pre"), { rev: 2, updatedAt: serverTimestamp(), updatedBy: "inst" }); w.set(doc(db, "courseDrafts/pre/lessons", "d2"), draftLesson({ prerequisites })); return w.commit(); };
  await assertFails(edit(["d2"]), "self-reference");
  await assertFails(edit(["d1", "d1"]), "duplicate");
  await assertFails(edit(Array.from({ length: 21 }, (_, i) => "x" + i)), "too many");
  await assertFails(setDoc(doc(as("inst"), "courseDraftChecks", "pre"), { rev: 1, ok: true }), "only the server records a verdict");
  await assertSucceeds(getDoc(doc(as("inst"), "courseDraftChecks", "pre")));
  await assertFails(getDoc(doc(as("member"), "courseDraftChecks", "pre")));
});

const liveOf = () => { const { quizKey, ...l } = draftLesson(); return l; };
const verdict = (rev, over = {}) => ({ rev, ok: true, issues: [], modules: [{ id: "m1", title: "", lessonIds: ["d1", "d2"] }], prerequisiteMap: { d2: ["d1"] },
  lessonChecks: { d1: lessonCheck(liveOf()), d2: lessonCheck(liveOf()) }, answerKeys: { d1: { q1: ["a"] }, d2: { q1: ["a"] } }, ...over });
test("publishing prerequisites needs the server's verdict for this exact draft revision, module order and prerequisite lists", async () => {
  const db = as("inst");
  const b = writeBatch(db);
  b.set(doc(db, "courseDrafts", "fresh2"), draftHead({ modules: [{ id: "m1", title: "", lessonIds: ["d1", "d2"] }] }));
  b.set(doc(db, "courseDrafts/fresh2/lessons", "d1"), draftLesson());
  b.set(doc(db, "courseDrafts/fresh2/lessons", "d2"), draftLesson({ prerequisites: ["d1"] }));
  await b.commit();
  const opts = { first: true, lessonIds: ["d1", "d2"], prereqs: { d2: ["d1"] } };
  await assertFails(publishTx("inst", "fresh2", opts), "no verdict yet");
  await seed("courseDraftChecks", "fresh2", verdict(1, { ok: false }));
  await assertFails(publishTx("inst", "fresh2", opts), "a failing verdict");
  await seed("courseDraftChecks", "fresh2", verdict(0));
  await assertFails(publishTx("inst", "fresh2", opts), "a STALE verdict (older draft revision) authorises nothing");
  await seed("courseDraftChecks", "fresh2", verdict(1, { prerequisiteMap: { d2: [] } }));
  await assertFails(publishTx("inst", "fresh2", opts), "prerequisites that differ from what was validated");
  await seed("courseDraftChecks", "fresh2", verdict(1, { modules: [{ id: "m1", title: "", lessonIds: ["d2", "d1"] }] }));
  await assertFails(publishTx("inst", "fresh2", opts), "a module order that differs from what was validated");
  await seed("courseDraftChecks", "fresh2", verdict(1));
  await assertSucceeds(publishTx("inst", "fresh2", opts));
  assert.deepEqual((await getDoc(doc(as("member"), "courses/fresh2/lessons", "d2"))).data().prerequisites, ["d1"]);
  // the draft moves on (rev 2): reordering the live course needs a NEW verdict
  await assertFails(publishTx("inst", "fresh2", { ...opts, first: false, modules: [{ id: "m1", title: "", lessonIds: ["d2", "d1"] }] }), "reorder with the old verdict");
  // ordinary course updates that don't touch order/prerequisites need no verdict (unpublish)
  await assertSucceeds(updateDoc(doc(db, "courses", "fresh2"), { status: "draft", updatedAt: serverTimestamp(), updatedBy: "inst" }));
  // a course without prerequisites needs the (content) check too
  const b2 = writeBatch(db);
  b2.set(doc(db, "courseDrafts", "plain"), draftHead());
  b2.set(doc(db, "courseDrafts/plain/lessons", "d1"), draftLesson());
  await b2.commit();
  await assertFails(publishTx("inst", "plain", { first: true, lessonIds: ["d1"] }), "v6.8: every publish needs the check, prerequisites or not");
  await approve("plain", { d1: liveOf() }, { keys: { d1: { q1: ["a"] } } });
  await assertSucceeds(publishTx("inst", "plain", { first: true, lessonIds: ["d1"] }));
});

test("recommended prior knowledge: advisory course ids (≤ 10, unique, never itself) + a short note, on drafts and live courses", async () => {
  const db = as("inst");
  const head = (pk) => draftHead({ priorKnowledge: pk });
  await assertSucceeds(setDoc(doc(db, "courseDrafts", "pk1"), head({ courseIds: ["pub", "other"], note: "Know Resolve basics." })));
  await assertFails(setDoc(doc(db, "courseDrafts", "pk2"), head({ courseIds: ["pk2"], note: "" })), "self-reference");
  await assertFails(setDoc(doc(db, "courseDrafts", "pk3"), head({ courseIds: ["pub", "pub"], note: "" })), "duplicate");
  await assertFails(setDoc(doc(db, "courseDrafts", "pk4"), head({ courseIds: Array.from({ length: 11 }, (_, i) => "c" + i), note: "" })), "too many");
  await assertFails(setDoc(doc(db, "courseDrafts", "pk5"), head({ courseIds: [], note: "x".repeat(301) })), "note too long");
  await assertFails(setDoc(doc(db, "courseDrafts", "pk6"), head({ courseIds: [], note: "", locked: true })), "no other keys");
  await approve("pk1");
  await assertSucceeds(publishTx("inst", "pk1", { first: true, lessonIds: [], courseOver: { priorKnowledge: { courseIds: ["pub", "other"], note: "Know Resolve basics." } } }));
  await assertFails(updateDoc(doc(db, "courses", "pub"), { priorKnowledge: { courseIds: ["pub"], note: "" }, updatedAt: serverTimestamp(), updatedBy: "inst" }), "live course can't recommend itself");
});

test("progress: the v6.5 server fields (progressModel, attemptGrants, finishedVia) are server-only", async () => {
  const ref = doc(as("member"), "learnerProgress/member/courseProgress", "pub");
  await assertSucceeds(setDoc(ref, prog()));
  await assertFails(setDoc(ref, prog({ progressModel: 2 }), { merge: true }), "can't stamp the marker (it decides legacy completion)");
  await assertFails(setDoc(ref, prog({ attemptGrants: { l1: { extra: 5 } } }), { merge: true }), "can't grant yourself attempts");
  await assertFails(setDoc(ref, prog({ finishedVia: "finish" }), { merge: true }));
  await assertFails(setDoc(ref, prog({ attemptRequests: { l1: { at: 1 } } }), { merge: true }), "requests are recorded by the server (after checking attempts are used up)");
  await seed("learnerProgress/member/courseProgress", "pub", { uid: "member", courseId: "pub", updatedAt: new Date(1), progressModel: 2, attemptGrants: { l1: { extra: 1, history: [] } } });
  await assertFails(updateDoc(ref, { "attemptGrants.l1.extra": 9, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { progressModel: deleteField(), updatedAt: serverTimestamp() }), "can't remove the marker to fake a legacy completion");
  await assertSucceeds(setDoc(ref, { playback: { l1: { positionSec: 3 } }, updatedAt: serverTimestamp() }, { merge: true }), "ordinary playback writes still work");
});

test("v6.7 publish + show category in ONE write: admins succeed atomically; an editor without category rights is refused as a whole (course stays a draft, category stays hidden); editors can still publish alone", async () => {
  await seed("academyCategories", "new-cat-4x2z", { name: "Testing 123", description: "", order: 9, hidden: true, cover: null, courseOrder: [], createdAt: new Date(1), createdBy: "admin", updatedAt: new Date(1), updatedBy: "admin" });
  await seed("academySettings", "categoryIndex", { hidden: ["new-cat-4x2z"], updatedAt: new Date(1), updatedBy: "admin" });
  await seed("courses", "c1", course({ status: "draft", category: "new-cat-4x2z" }));
  await seed("courses", "c2", course({ status: "draft", category: "new-cat-4x2z" }));
  const combined = (uid, cid) => {
    const db = as(uid); const b = writeBatch(db);
    b.update(doc(db, "courses", cid), { status: "published", publishedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: uid });
    b.update(doc(db, "academyCategories", "new-cat-4x2z"), { hidden: false, updatedAt: serverTimestamp(), updatedBy: uid });
    b.set(doc(db, "academySettings", "categoryIndex"), { hidden: [], updatedAt: serverTimestamp(), updatedBy: uid });
    return b.commit();
  };
  await approve("c1"); await approve("c2");
  await assertFails(combined("inst", "c1"), "an Academy editor can't show a category — so the whole publish is refused");
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    assert.equal((await getDoc(doc(db, "courses", "c1"))).data().status, "draft", "nothing applied: course still a draft");
    assert.deepEqual((await getDoc(doc(db, "academySettings", "categoryIndex"))).data().hidden, ["new-cat-4x2z"], "category still hidden");
  });
  await assertSucceeds(updateDoc(doc(as("inst"), "courses", "c1"), { status: "published", publishedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: "inst" }), "editors still publish the course alone");
  await assertFails(getDoc(doc(as("member"), "courses", "c1")), "…but it stays invisible to learners while the category is hidden");
  await assertSucceeds(combined("admin", "c2"), "an admin publishes and shows the category in one atomic write");
  await assertSucceeds(getDoc(doc(as("member"), "courses", "c2")), "now visible to learners");
  await assertSucceeds(getDoc(doc(as("member"), "courses", "c1")), "the editor's earlier publish becomes visible with the category");
  await assertFails(combined("member", "c2"), "learners can do neither");
});

test("v6.8 a modified browser can't bypass the publish checks: lessons, answer keys and the course must match the server's passing check for this draft revision", async () => {
  const db = as("inst");
  const b = writeBatch(db);
  b.set(doc(db, "courseDrafts", "byp"), draftHead());
  b.set(doc(db, "courseDrafts/byp/lessons", "d1"), draftLesson());
  await b.commit();
  const good = liveOf();
  const now = () => serverTimestamp();
  const lessonW = (l) => setDoc(doc(db, "courses/byp/lessons", "d1"), { ...l, updatedAt: now() });
  const keyW = (answers) => setDoc(doc(db, "courses/byp/quizKeys", "d1"), { answers, explanations: {}, updatedAt: now() });
  const courseW = () => setDoc(doc(db, "courses", "byp"), course({ status: "published", createdAt: now(), createdBy: "inst", updatedAt: now(), updatedBy: "inst", publishedAt: now() }));
  // no check at all
  await assertFails(courseW(), "publishing a course without the check");
  await assertFails(lessonW(good), "publishing a lesson without the check");
  await assertFails(keyW({ q1: ["a"] }), "publishing an answer key without the check");
  // the check FAILED (e.g. a video lesson without a link, an unmarked answer)
  await approve("byp", { d1: good }, { keys: { d1: { q1: ["a"] } }, ok: false, issues: [{ lessonId: "d1", kind: "quiz", message: "Question 1 in “Intro” has no correct answer marked." }] });
  await assertFails(lessonW(good), "a failing check authorises nothing");
  await assertFails(courseW(), "…not even the course");
  // the check PASSED for what the draft holds — the browser tries to publish something else
  await approve("byp", { d1: good }, { keys: { d1: { q1: ["a"] } } });
  await assertFails(lessonW({ ...good, video: null }), "a video lesson with its link stripped");
  await assertFails(lessonW({ ...good, video: { provider: "youtube", id: "dQw4w9WgXcQ" }, kind: "written" }), "a different lesson kind");
  await assertFails(lessonW({ ...good, video: { provider: "youtube", id: "AAAAAAAAAAA" } }), "a different video");
  await assertFails(lessonW({ ...good, quiz: { ...good.quiz, questions: [{ ...good.quiz.questions[0], options: [{ id: "z", text: "Z" }, { id: "y", text: "Y" }] }] } }), "questions whose options don't match the checked answer key");
  await assertFails(keyW({}), "an empty answer key (unpassable quiz)");
  await assertFails(keyW({ q1: ["a", "b"] }), "two answers on a single-answer question");
  await assertFails(keyW({ q1: ["nope"] }), "an answer that points at no option");
  await assertFails(setDoc(doc(db, "courses/byp/lessons", "extra"), { ...good, updatedAt: now() }), "a lesson the check never saw");
  // exactly what was checked publishes
  await assertSucceeds(courseW());
  await assertSucceeds(lessonW(good));
  await assertSucceeds(keyW({ q1: ["a"] }));
  // a later draft edit (rev +1) makes the check stale
  await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), "courseDrafts", "byp"), { rev: 2 }); });
  await assertFails(lessonW({ ...good, title: "x", quiz: { ...good.quiz, passMark: 50, questions: [] } }), "stale check: quiz changes refused");
  await assertSucceeds(updateDoc(doc(db, "courses/byp/lessons", "d1"), { title: "Renamed only", updatedAt: now() }), "fields the check doesn't cover (title) aren't gated by it");
  // never retroactive: archiving / unpublishing and a category move need no check
  await assertSucceeds(updateDoc(doc(as("admin"), "courses", "byp"), { category: "filmmaking", updatedAt: now(), updatedBy: "admin" }), "category reassignment (deleting a category)");
  await assertSucceeds(updateDoc(doc(db, "courses", "byp"), { status: "archived", updatedAt: now(), updatedBy: "inst" }), "archiving");
  await assertFails(updateDoc(doc(db, "courses", "byp"), { status: "published", updatedAt: now(), updatedBy: "inst" }), "re-publishing needs a current check");
  // the check holds answer keys: editors only
  await assertFails(getDoc(doc(as("member"), "courseDraftChecks", "byp")), "learners can't read the check (it holds answer keys)");
  await assertFails(getDoc(doc(as("lead"), "courseDraftChecks", "byp")));
  await assertFails(setDoc(doc(db, "courseDraftChecks", "byp"), { rev: 2, ok: true }), "only the server writes it");
  await assertSucceeds(getDoc(doc(db, "courseDraftChecks", "byp")));
});

test("v6.9 permanent course delete is admin-only end to end: a non-admin editor running the delete steps changes nothing; published courses can't be deleted", async () => {
  await seedCourse("del1", { status: "archived" });
  await seed("courses/del1/lessons/l1/comments", "c1", { uid: "member", name: "Mel", role: "learner", txt: "hi", parentId: null, pinned: false, createdAt: new Date(1) });
  // the order deleteCourseHard uses: lessons + keys + comments, course doc LAST
  await assertFails(deleteDoc(doc(as("inst"), "courses/del1/lessons", "l1")), "editor: lesson refused");
  await assertFails(deleteDoc(doc(as("inst"), "courses/del1/quizKeys", "l1")), "editor: answer key refused");
  await assertFails(deleteDoc(doc(as("inst"), "courses", "del1")), "editor: course refused");
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    assert.ok((await getDoc(doc(db, "courses/del1/lessons", "l1"))).exists() && (await getDoc(doc(db, "courses", "del1"))).exists(), "nothing was removed");
  });
  for (const p of ["courses/del1/lessons/l1/comments/c1", "courses/del1/quizKeys/l1", "courses/del1/lessons/l1"]) await assertSucceeds(deleteDoc(doc(as("admin"), p)));
  await assertSucceeds(deleteDoc(doc(as("admin"), "courses", "del1")), "admin deletes an archived course");
  await seedCourse("del2", { status: "published" });
  await assertFails(deleteDoc(doc(as("admin"), "courses", "del2")), "never while published (unpublish first)");
  await assertFails(deleteDoc(doc(as("inst"), "academyCategories", "photography")), "category delete: admins only");
});

test("v6.10 category deletion lock: nothing can be filed under a locked category; published courses there are deletable by admins only; the lock and the record's deletion are server-only", async () => {
  await seed("academyCategories", "locked-cat", { name: "Locked", description: "", order: 9, hidden: false, cover: null, courseOrder: [], createdAt: new Date(1), createdBy: "admin", updatedAt: new Date(1), updatedBy: "admin", deleting: { planId: "p1", plan: {}, by: "admin", byName: "Ada", at: new Date(1) } });
  await seedCourse("lc1", { status: "published", category: "locked-cat" });
  await seedCourse("lc2", { status: "draft", category: "photography" });
  await seed("courseDrafts", "lc2", { ...draftHead({ category: "photography" }), rev: 3, createdAt: new Date(1), updatedAt: new Date(1) });
  await seed("guides", "lg1", guide({ category: "photography" }));
  await seed("paths", "lp1", { ...pathDoc({ category: "" }) });
  const db = as("inst");
  const now = serverTimestamp();
  await approve("lc2");
  // filing anything under it is refused
  await assertFails(updateDoc(doc(db, "courses", "lc2"), { category: "locked-cat", updatedAt: now, updatedBy: "inst" }), "moving a course in");
  await assertFails(updateDoc(doc(db, "courseDrafts", "lc2"), { category: "locked-cat", rev: 4, updatedAt: now, updatedBy: "inst" }), "moving a draft in");
  await assertFails(setDoc(doc(db, "courses", "lc3"), course({ status: "draft", category: "locked-cat", createdAt: now, createdBy: "inst", updatedAt: now, updatedBy: "inst" })), "creating a course in it");
  await assertFails(updateDoc(doc(db, "guides", "lg1"), { category: "locked-cat", updatedAt: now, updatedBy: "inst" }), "moving a guide in");
  await assertFails(updateDoc(doc(db, "paths", "lp1"), { category: "locked-cat", updatedAt: now, updatedBy: "inst" }), "moving a path in");
  await approve("lc1");
  await assertFails(updateDoc(doc(db, "courses", "lc1"), { title: "Published edit", updatedAt: now, updatedBy: "inst" }), "publishing changes to a course still in it");
  // moving OUT is allowed (that's how its contents are resolved)
  await assertSucceeds(updateDoc(doc(as("admin"), "courses", "lc1"), { category: "photography", updatedAt: now, updatedBy: "admin" }), "moving a course out");
  await assertSucceeds(updateDoc(doc(as("admin"), "courses", "lc1"), { category: "locked-cat", updatedAt: now, updatedBy: "admin" }).then(() => { throw new Error("should fail"); }, () => "ok"));
  // deleting a PUBLISHED course: only an admin, only because its category is locked
  await seedCourse("lc4", { status: "published", category: "locked-cat" });
  await assertFails(deleteDoc(doc(as("inst"), "courses", "lc4")), "an editor can't, even in a locked category");
  await assertSucceeds(deleteDoc(doc(as("admin"), "courses", "lc4")), "an admin can, inside the locked deletion");
  await seedCourse("lc5", { status: "published", category: "photography" });
  await assertFails(deleteDoc(doc(as("admin"), "courses", "lc5")), "elsewhere: still unpublish first");
  // the lock and the record's deletion are server-only
  await assertFails(updateDoc(doc(as("admin"), "academyCategories", "photography"), { deleting: { planId: "x" }, updatedAt: now, updatedBy: "admin" }), "an admin can't set the lock directly");
  await assertFails(updateDoc(doc(as("admin"), "academyCategories", "locked-cat"), { deleting: null, updatedAt: now, updatedBy: "admin" }), "…or clear it");
  await assertSucceeds(updateDoc(doc(as("admin"), "academyCategories", "locked-cat"), { name: "Locked (renamed)", updatedAt: now, updatedBy: "admin" }), "ordinary edits while locked keep working");
  await assertFails(deleteDoc(doc(as("admin"), "academyCategories", "photography")), "category records are deleted by the server only");
});

test("v6.11 Tips & resources: private drafts; published content must equal the draft being published; strict video; status/category exempt; lock; reviews clean-up", async () => {
  const db = as("inst"); const now = serverTimestamp();
  const gd = (over = {}) => ({ title: "Export tips", category: "photography", topics: [], topicIds: [], video: null, videoMeta: null, thumbMode: "source", body: "Long edge 2048 px.", resources: [], thumb: null, durationMinutes: 2, mdVersion: 2,
    rev: 1, publishedRev: 0, createdAt: now, createdBy: "inst", updatedAt: now, updatedBy: "inst", ...over });
  // drafts: editors only
  await assertSucceeds(setDoc(doc(db, "guideDrafts", "t1"), gd()));
  await assertFails(getDoc(doc(as("member"), "guideDrafts", "t1")), "learners can't read drafts");
  await assertFails(setDoc(doc(as("member"), "guideDrafts", "t2"), gd({ createdBy: "member", updatedBy: "member" })));
  await assertSucceeds(updateDoc(doc(db, "guideDrafts", "t1"), { title: "", body: "", rev: 2, updatedAt: now, updatedBy: "inst" }), "incomplete drafts save");
  await assertFails(updateDoc(doc(db, "guideDrafts", "t1"), { title: "x", rev: 2, updatedAt: now, updatedBy: "inst" }), "stale revision refused");
  await updateDoc(doc(db, "guideDrafts", "t1"), { title: "Export tips", body: "Long edge 2048 px.", rev: 3, updatedAt: now, updatedBy: "inst" });
  const live = (over = {}) => ({ title: "Export tips", category: "photography", topics: [], topicIds: [], video: null, videoMeta: null, thumbMode: "source", body: "Long edge 2048 px.", resources: [], thumb: null, durationMinutes: 2, mdVersion: 2,
    status: "published", createdAt: now, createdBy: "inst", updatedAt: now, updatedBy: "inst", publishedAt: now, ...over });
  const pub = (gid, l, rev) => { const b = writeBatch(db); b.set(doc(db, "guides", gid), l); b.update(doc(db, "guideDrafts", gid), { rev: rev + 1, publishedRev: rev + 1, updatedAt: now, updatedBy: "inst" }); return b.commit(); };
  await assertFails(setDoc(doc(db, "guides", "t1"), live()), "publishing without the draft bump");
  await assertFails(pub("t1", live({ body: "something else" }), 3), "published content differs from the draft");
  await assertSucceeds(pub("t1", live(), 3), "text-only resource publishes exactly its draft");
  await assertSucceeds(getDoc(doc(as("member"), "guides", "t1")));
  await assertFails(updateDoc(doc(db, "guides", "t1"), { body: "edited live", updatedAt: now, updatedBy: "inst" }), "no direct edits to published content");
  await assertSucceeds(updateDoc(doc(db, "guides", "t1"), { status: "draft", updatedAt: now, updatedBy: "inst" }), "unpublish: exempt");
  await assertFails(updateDoc(doc(db, "guides", "t1"), { status: "published", updatedAt: now, updatedBy: "inst" }), "re-publishing without the draft refused");
  // strict video on publish
  await setDoc(doc(db, "guideDrafts", "t3"), gd({ video: { provider: "youtube", id: "bad" }, body: "" }));
  await assertFails(pub("t3", live({ video: { provider: "youtube", id: "bad" }, body: "" }), 1), "an unsupported video id can't be published");
  await updateDoc(doc(db, "guideDrafts", "t3"), { video: { provider: "youtube", id: "dQw4w9WgXcQ" }, rev: 2, updatedAt: now, updatedBy: "inst" });
  await assertSucceeds(pub("t3", live({ video: { provider: "youtube", id: "dQw4w9WgXcQ" }, body: "" }), 2), "a valid video resource publishes");
  await setDoc(doc(db, "guideDrafts", "t4"), gd({ body: "" }));
  await assertFails(pub("t4", live({ body: "" }), 1), "no video and no text can't be published");
  // lock: no draft autosave / publish into a category being deleted
  await seed("academyCategories", "lockcat", { name: "Locked", description: "", order: 9, hidden: false, cover: null, courseOrder: [], createdAt: new Date(1), createdBy: "admin", updatedAt: new Date(1), updatedBy: "admin", deleting: { planId: "p", plan: {}, by: "admin", at: new Date(1) } });
  await assertFails(updateDoc(doc(db, "guideDrafts", "t3"), { category: "lockcat", rev: 4, updatedAt: now, updatedBy: "inst" }), "draft can't be filed under a locked category");
  await seed("guides", "tl", live({ category: "lockcat", createdAt: new Date(1), updatedAt: new Date(1), publishedAt: new Date(1) }));
  await assertFails(deleteDoc(doc(db, "guides", "tl")), "editor: no delete");
  await assertSucceeds(deleteDoc(doc(as("admin"), "guides", "tl")), "admin: a published resource can be deleted inside a locked category deletion");
  // reviews: only removable once the resource is gone
  await seed("learnerProgress/member/guideReviews", "t3", { uid: "member", guideId: "t3", reviewed: true, reviewedAt: new Date(1), updatedAt: new Date(1) });
  await assertFails(deleteDoc(doc(as("admin"), "learnerProgress/member/guideReviews", "t3")), "not while the resource exists");
  await seed("learnerProgress/member/guideReviews", "gone", { uid: "member", guideId: "gone", reviewed: true, reviewedAt: new Date(1), updatedAt: new Date(1) });
  await assertSucceeds(deleteDoc(doc(as("admin"), "learnerProgress/member/guideReviews", "gone")), "after it's deleted: admin clean-up");
  await assertFails(deleteDoc(doc(as("inst"), "learnerProgress/member/guideReviews", "gone")), "editors can't");
});

test("v6.11: a REALISTIC video resource (metadata, custom thumbnail, links, topics) publishes within the rules' expression budget — first publish AND publish changes", async () => {
  const db = as("inst"); const now = serverTimestamp();
  const META = { id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up (Official Video) (4K Remaster)", author: "Rick Astley", authorUrl: "https://www.youtube.com/@RickAstleyYT", thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", fetchedAt: 1794590591400, durationSec: 214 };
  const content = { title: "Lighting in one take", category: "photography", topics: ["Light"], topicIds: ["t-light"], video: { provider: "youtube", id: "dQw4w9WgXcQ" }, videoMeta: META, thumbMode: "custom",
    body: "Notes **here**.", resources: [{ url: "https://example.com/", label: "Example Domain", source: "example.com" }, { url: "https://example.org/a.pdf", label: "Cheat sheet", fileType: "PDF", custom: true }],
    thumb: { path: "academy/guideThumbs/rv/v1.jpg", version: "v1", contentType: "image/jpeg", bytes: 15215, w: 1280, h: 720 }, durationMinutes: 0, mdVersion: 2 };
  await assertSucceeds(setDoc(doc(db, "guideDrafts", "rv"), { ...content, rev: 1, publishedRev: 0, createdAt: now, createdBy: "inst", updatedAt: now, updatedBy: "inst" }), "draft saves");
  const pub = (rev, over = {}) => runTransaction(db, async (tx) => {
    const live = await tx.get(doc(db, "guides", "rv"));
    if (live.exists()) tx.update(doc(db, "guides", "rv"), { ...content, ...over, status: "published", updatedAt: now, updatedBy: "inst" });
    else tx.set(doc(db, "guides", "rv"), { ...content, ...over, status: "published", createdAt: now, createdBy: "inst", updatedAt: now, updatedBy: "inst", publishedAt: now });
    tx.update(doc(db, "guideDrafts", "rv"), { rev: rev + 1, publishedRev: rev + 1, updatedAt: now, updatedBy: "inst" });
  });
  await assertSucceeds(pub(1), "first publish (the same transaction the app runs)");
  await assertSucceeds(updateDoc(doc(db, "guideDrafts", "rv"), { ...content, title: "Lighting in one take (v2)", rev: 3, updatedAt: now, updatedBy: "inst" }), "private edit");
  content.title = "Lighting in one take (v2)";
  await assertSucceeds(pub(3), "Publish changes");
  // an admin publishing someone else's resource (the category review path)
  await assertSucceeds(updateDoc(doc(db, "guideDrafts", "rv"), { ...content, title: "Lighting (v3)", rev: 5, updatedAt: now, updatedBy: "inst" }));
  content.title = "Lighting (v3)";
  const adb = as("admin");
  await assertSucceeds(runTransaction(adb, async (tx) => {
    await tx.get(doc(adb, "guides", "rv"));
    tx.update(doc(adb, "guides", "rv"), { ...content, status: "published", updatedAt: now, updatedBy: "admin" });
    tx.update(doc(adb, "guideDrafts", "rv"), { rev: 6, publishedRev: 6, updatedAt: now, updatedBy: "admin" });
  }), "admin publishes an editor's draft");
});

test("v6.11: the server enforces 20,000 characters on formatted text — drafts and published — while incomplete drafts still save", async () => {
  const db = as("inst"); const now = serverTimestamp();
  const AT = "x".repeat(20000), OVER = "x".repeat(20001);
  // tips & resources: draft
  const gd = (body, rev = 1) => ({ title: "", category: "", topics: [], topicIds: [], video: null, videoMeta: null, thumbMode: "source", body, resources: [], thumb: null, durationMinutes: 0, mdVersion: 2,
    rev, publishedRev: 0, createdAt: now, createdBy: "inst", updatedAt: now, updatedBy: "inst" });
  await assertSucceeds(setDoc(doc(db, "guideDrafts", "lim"), gd("")), "an empty, incomplete draft saves");
  await assertSucceeds(updateDoc(doc(db, "guideDrafts", "lim"), { body: AT, rev: 2, updatedAt: now, updatedBy: "inst" }), "exactly 20,000 saves");
  await assertFails(updateDoc(doc(db, "guideDrafts", "lim"), { body: OVER, rev: 3, updatedAt: now, updatedBy: "inst" }), "20,001 is refused in a draft");
  // tips & resources: published (even if a draft somehow held the text, the live copy is refused)
  await env.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), "guideDrafts", "lim2"), { ...gd(OVER), title: "Long", category: "photography", createdAt: new Date(1), updatedAt: new Date(1) }));
  await assertFails(runTransaction(db, async (tx) => {
    tx.set(doc(db, "guides", "lim2"), { title: "Long", category: "photography", topics: [], topicIds: [], video: null, videoMeta: null, thumbMode: "source", body: OVER, resources: [], thumb: null, durationMinutes: 0, mdVersion: 2,
      status: "published", createdAt: now, createdBy: "inst", updatedAt: now, updatedBy: "inst", publishedAt: now });
    tx.update(doc(db, "guideDrafts", "lim2"), { rev: 2, publishedRev: 2, updatedAt: now, updatedBy: "inst" });
  }), "a published resource over 20,000 is refused");
  // courses: draft head `about` and draft lesson `description`
  await assertSucceeds(setDoc(doc(db, "courseDrafts", "lim"), draftHead({ title: "", about: "" })), "an incomplete course draft saves");
  await assertSucceeds(updateDoc(doc(db, "courseDrafts", "lim"), { about: AT, rev: 2, updatedAt: now, updatedBy: "inst" }));
  await assertFails(updateDoc(doc(db, "courseDrafts", "lim"), { about: OVER, rev: 3, updatedAt: now, updatedBy: "inst" }), "course ‘about’ over 20,000 refused");
  const withLesson = (rev, id, description) => { const b = writeBatch(db); b.update(doc(db, "courseDrafts", "lim"), { rev, updatedAt: now, updatedBy: "inst" }); b.set(doc(db, "courseDrafts/lim/lessons", id), draftLesson({ description })); return b.commit(); };
  await assertSucceeds(withLesson(3, "d1", AT), "lesson text of exactly 20,000 saves");
  await assertFails(withLesson(4, "d2", OVER), "lesson text over 20,000 refused");
});
