/* IFC Creative Academy — progression-sensitive writes (callables).

   Learners can't write completion flags themselves (firestore.rules: `lessons`,
   `earned`, `finishedAt`, `progressModel`, `attemptGrants` are server-only on
   learnerProgress/{uid}/courseProgress/{courseId}). These callables are the
   only way to record them, and they enforce lesson PREREQUISITES server-side
   (academyProgression.js):

   completeLesson { courseId, lessonId, how: "manual"|"video", done }
     done=true  → the lesson's prerequisites must be complete and it must be
                  completable that way.
     done=false → un-mark a self-reported (manual) completion. A finished course
                  keeps its finishedAt (earned completion isn't erased).
   finishCourse { courseId }
     Every required lesson must be complete (any order). Idempotent: the first
     call records finishedAt (+ finishedRequired) in a transaction; later calls
     — double clicks, a second tab — get { already: true } and the original
     date. A completion earned before Finish course existed (legacy) is
     recorded without a celebration ({ already: true }).
   grantQuizAttempts { uid, courseId, lessonId, count }   (Academy staff)
     Adds attempts to one learner's limited quiz; history (who/when/how many)
     is kept on the learner's progress doc; attempt records are untouched.
   checkCoursePrerequisites { courseId, rev }              (Academy staff)
     The publish check for one DRAFT revision (name kept from v6.5). Validates
     prerequisites in curriculum order (earlier-lesson rule, missing/duplicate/
     self, optional-required) and, since v6.8, every lesson's video link format
     and quiz answer keys. Records the verdict for that revision in
     courseDraftChecks/{courseId} (editor-only): module order, prerequisite
     lists, and per lesson the exact kind/video/quiz/answer key it approved. The
     rules accept a publish only when it matches that verdict and the draft is
     still at that revision. Every publish runs it. */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db, FieldValue, Timestamp } = require("./lib");
const P = require("./academyProgression");

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UID = /^[A-Za-z0-9_-]{1,128}$/;
async function loadContext(uid, courseId) {
  const courseRef = db.collection("courses").doc(courseId);
  const [profSnap, courseSnap, lessonsSnap, idxSnap, progSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    courseRef.get(),
    courseRef.collection("lessons").get(),
    db.collection("academySettings").doc("categoryIndex").get(),
    db.collection("learnerProgress").doc(uid).collection("courseProgress").doc(courseId).get(),
  ]);
  const profile = profSnap.exists ? { uid, ...profSnap.data() } : null;
  const course = courseSnap.exists ? courseSnap.data() : null;
  const hidden = idxSnap.exists ? (idxSnap.data().hidden || []) : [];
  const pre = P.courseAccessPrecondition(profile, course, hidden);
  if (pre) throw new HttpsError(pre[0], pre[1]);
  const lessons = lessonsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { profile, course, lessons, progress: progSnap.exists ? progSnap.data() : null };
}
const progressRef = (uid, courseId) => db.collection("learnerProgress").doc(uid).collection("courseProgress").doc(courseId);
async function requireStaff(uid) {
  const snap = await db.collection("users").doc(uid).get();
  const p = snap.exists ? snap.data() : null;
  const ok = !!p && p.disabled !== true && (p.role === "admin" || (p.status === "approved" && p.academyEditor === true));
  if (!ok) throw new HttpsError("permission-denied", "Only Academy editors can do this.");
  return p;
}

const completeLesson = onCall({ memory: "256MiB", timeoutSeconds: 30 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const uid = req.auth.uid;
  const courseId = String((req.data && req.data.courseId) || "");
  const lessonId = String((req.data && req.data.lessonId) || "");
  const how = String((req.data && req.data.how) || "manual");
  const done = !(req.data && req.data.done === false);
  if (!ID.test(courseId) || !ID.test(lessonId)) throw new HttpsError("invalid-argument", "Course or lesson id is missing.");
  const ctx = await loadContext(uid, courseId);
  const why = P.completeLessonDecision({ ...ctx, lessonId, how, done });
  if (why) throw new HttpsError(why[0], why[1]);
  const now = FieldValue.serverTimestamp();
  const entry = !done ? { manualDone: false, manualDoneAt: FieldValue.delete() }
    : how === "video" ? { videoWatched: true, videoWatchedAt: now } : { manualDone: true, manualDoneAt: now };
  // stamp BEFORE this change: a legacy completion is judged on the old state
  const patch = { uid, courseId, updatedAt: now, lessons: { [lessonId]: entry }, ...P.progressStamp(ctx.course, ctx.lessons, ctx.progress, now) };
  if (!ctx.progress || !ctx.progress.startedAt) patch.startedAt = now;
  await progressRef(uid, courseId).set(patch, { merge: true });
  return { ok: true };
});

const finishCourse = onCall({ memory: "256MiB", timeoutSeconds: 30 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const uid = req.auth.uid;
  const courseId = String((req.data && req.data.courseId) || "");
  if (!ID.test(courseId)) throw new HttpsError("invalid-argument", "Course id is missing.");
  const { course, lessons } = await loadContext(uid, courseId);
  const ref = progressRef(uid, courseId);
  try {
    return await finishTx(ref, course, lessons);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    // a concurrent Finish (double click / second tab) won the race
    const snap = await ref.get();
    const at = snap.exists && snap.data().finishedAt;
    if (at) return { already: true, finishedAt: at.toMillis ? at.toMillis() : null };
    throw new HttpsError("aborted", "Couldn't finish the course just now, and nothing changed. Please try again.");
  }
});
function finishTx(ref, course, lessons) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);                     // re-read inside the transaction
    const progress = snap.exists ? snap.data() : null;
    const d = P.finishDecision({ course, lessons, progress });
    if (d.error) throw new HttpsError(d.error[0], d.error[1]);
    if (d.already && !d.legacy) return { already: true, finishedAt: progress.finishedAt.toMillis ? progress.finishedAt.toMillis() : null };
    const now = FieldValue.serverTimestamp();
    tx.set(ref, { finishedAt: now, finishedRequired: d.required, finishedVia: d.legacy ? "legacy" : "finish", progressModel: P.PROGRESS_MODEL, updatedAt: now }, { merge: true });
    return d.legacy ? { already: true, legacy: true, finishedAt: Date.now() } : { already: false, finishedAt: Date.now(), required: d.required };
  });
}

const grantQuizAttempts = onCall({ memory: "256MiB", timeoutSeconds: 30 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const staff = await requireStaff(req.auth.uid);
  const uid = String((req.data && req.data.uid) || "");
  const courseId = String((req.data && req.data.courseId) || "");
  const lessonId = String((req.data && req.data.lessonId) || "");
  const count = Math.round(Number(req.data && req.data.count) || 1);
  if (!UID.test(uid) || !ID.test(courseId) || !ID.test(lessonId)) throw new HttpsError("invalid-argument", "Learner, course or lesson is missing.");
  if (count < 1 || count > 10) throw new HttpsError("invalid-argument", "Grant between 1 and 10 attempts.");
  const [learnerSnap, lessonSnap] = await Promise.all([db.collection("users").doc(uid).get(), db.collection("courses").doc(courseId).collection("lessons").doc(lessonId).get()]);
  if (!learnerSnap.exists) throw new HttpsError("not-found", "That learner no longer exists.");
  if (!lessonSnap.exists || P.quizMode(lessonSnap.data()) === "none") throw new HttpsError("not-found", "That quiz no longer exists.");
  if (!(Number(lessonSnap.data().quiz.retryLimit) > 0)) throw new HttpsError("failed-precondition", "This quiz already allows unlimited attempts.");
  const ref = progressRef(uid, courseId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = (snap.exists && snap.data().attemptGrants && snap.data().attemptGrants[lessonId]) || { extra: 0, history: [] };
    const extra = (Number(cur.extra) || 0) + count;
    const history = [...(Array.isArray(cur.history) ? cur.history : []), { by: req.auth.uid, byName: String(staff.name || "").slice(0, 120), at: Timestamp.now(), count }].slice(-50);
    tx.set(ref, { uid, courseId, attemptGrants: { [lessonId]: { extra, history } }, attemptRequests: { [lessonId]: FieldValue.delete() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { extra, allowed: P.attemptAllowance(lessonSnap.data().quiz, extra) };
  });
});

/* Academy staff: who has used attempts on this course's LIMITED quizzes (or
   asked for more). Scoped on purpose — editors who aren't leads can't read
   learner progress in general; this returns only names and attempt counts for
   this course's limited quizzes. */
const quizAttemptStatus = onCall({ memory: "256MiB", timeoutSeconds: 30 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  await requireStaff(req.auth.uid);
  const courseId = String((req.data && req.data.courseId) || "");
  if (!ID.test(courseId)) throw new HttpsError("invalid-argument", "Course id is missing.");
  const courseRef = db.collection("courses").doc(courseId);
  const [courseSnap, lessonsSnap] = await Promise.all([courseRef.get(), courseRef.collection("lessons").get()]);
  if (!courseSnap.exists) throw new HttpsError("not-found", "That course no longer exists.");
  const lessons = lessonsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const limited = lessons.filter((l) => P.quizMode(l) !== "none" && Number(l.quiz.retryLimit) > 0);
  if (!limited.length) return { quizzes: [], rows: [] };
  const ids = new Set(limited.map((l) => l.id));
  const attempts = (await db.collectionGroup("attempts").where("courseId", "==", courseId).get()).docs
    .map((d) => d.data()).filter((a) => ids.has(a.lessonId)).map((a) => ({ uid: a.uid, lessonId: a.lessonId }));
  // learners who asked without having attempted are found via their progress docs
  const reqSnap = await db.collectionGroup("courseProgress").where("courseId", "==", courseId).get();
  const progressByUid = {};
  for (const d of reqSnap.docs) {
    const p = d.data();
    if (p && p.uid && (p.attemptRequests || p.attemptGrants || p.earned)) progressByUid[p.uid] = { attemptRequests: p.attemptRequests || null, attemptGrants: p.attemptGrants || null, earned: p.earned || null };
  }
  const uids = [...new Set([...attempts.map((a) => a.uid), ...Object.keys(progressByUid)])];
  const users = uids.length ? await db.getAll(...uids.map((u) => db.collection("users").doc(u))) : [];
  const namesByUid = Object.fromEntries(users.filter((u) => u.exists).map((u) => [u.id, String(u.data().name || "").slice(0, 120)]));
  const rows = P.attemptStatusRows({ lessons: limited, attempts, progressByUid, namesByUid });
  return { quizzes: limited.map((l) => ({ lessonId: l.id, title: l.title || "Quiz", limit: Number(l.quiz.retryLimit) })), rows };
});

/* Learner: ask for another attempt on a limited quiz they've used up. Recorded
   on their own progress doc (server-only field) so editors see it in the
   course's "Quiz attempts" panel; a grant clears it. */
const requestQuizAttempt = onCall({ memory: "256MiB", timeoutSeconds: 30 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const uid = req.auth.uid;
  const courseId = String((req.data && req.data.courseId) || "");
  const lessonId = String((req.data && req.data.lessonId) || "");
  if (!ID.test(courseId) || !ID.test(lessonId)) throw new HttpsError("invalid-argument", "Course or lesson id is missing.");
  const ctx = await loadContext(uid, courseId);
  const lesson = ctx.lessons.find((l) => l.id === lessonId);
  if (!lesson || P.quizMode(lesson) === "none" || !(Number(lesson.quiz.retryLimit) > 0)) throw new HttpsError("failed-precondition", "This quiz doesn't limit attempts.");
  if (ctx.progress && ctx.progress.earned && ctx.progress.earned[lessonId]) throw new HttpsError("failed-precondition", "You've already passed this quiz.");
  const used = (await db.collection("quizAttempts").doc(uid).collection("attempts").where("courseId", "==", courseId).where("lessonId", "==", lessonId).count().get()).data().count;
  const extra = Number(ctx.progress && ctx.progress.attemptGrants && ctx.progress.attemptGrants[lessonId] && ctx.progress.attemptGrants[lessonId].extra) || 0;
  if (used < P.attemptAllowance(lesson.quiz, extra)) throw new HttpsError("failed-precondition", "You still have attempts left.");
  await progressRef(uid, courseId).set({ uid, courseId, attemptRequests: { [lessonId]: { at: FieldValue.serverTimestamp() } }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

const checkCoursePrerequisites = onCall({ memory: "256MiB", timeoutSeconds: 30 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  await requireStaff(req.auth.uid);
  const courseId = String((req.data && req.data.courseId) || "");
  const rev = Number(req.data && req.data.rev);
  if (!ID.test(courseId) || !Number.isFinite(rev)) throw new HttpsError("invalid-argument", "Course or revision is missing.");
  const draftRef = db.collection("courseDrafts").doc(courseId);
  const [draft, lessonsSnap] = await Promise.all([draftRef.get(), draftRef.collection("lessons").get()]);
  if (!draft.exists) throw new HttpsError("not-found", "There's no draft to check.");
  if (Number(draft.data().rev) !== rev) throw new HttpsError("aborted", "The draft changed while it was being checked. Try again.");
  // exactly what publish will write: every draft lesson, in curriculum order
  // (outline order, then unlisted lessons — the same rule learners see)
  const ordered = P.orderedLessons(draft.data(), lessonsSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
  // v6.8: the whole publishable content of this revision — prerequisites, video
  // links and quiz answer keys — not only prerequisites.
  const issues = [...P.validatePrerequisites(ordered), ...P.publishContentIssues(ordered)];
  // The verdict names the module order and prerequisite lists it approved; the
  // rules accept a published course/lesson only when they match it AND the
  // draft is still at this revision — a stale verdict authorises nothing.
  await db.collection("courseDraftChecks").doc(courseId).set({
    rev, ok: issues.length === 0, issues: issues.slice(0, 50),
    modules: P.normalizeModules(draft.data().modules), prerequisiteMap: P.prerequisiteMapOf(ordered),
    // exactly what each published lesson + answer key may contain (rules compare)
    ...P.publishRecord(ordered),
    checkedAt: FieldValue.serverTimestamp(), checkedBy: req.auth.uid,
  });
  return { ok: issues.length === 0, issues };
});

module.exports = { completeLesson, finishCourse, grantQuizAttempts, quizAttemptStatus, requestQuizAttempt, checkCoursePrerequisites, loadContext };
