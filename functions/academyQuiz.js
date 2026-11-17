/* IFC Creative Academy — submitQuizAttempt (callable).

   Grades a lesson quiz SERVER-SIDE. The client sends { courseId, lessonId,
   answers: { [questionId]: [optionId, …] } } and gets back the scored attempt
   with explanations. The answer key (courses/{id}/quizKeys/{lessonId}) is read
   here with the Admin SDK and never leaves the server except as per-question
   correct/incorrect + the correct option ids AFTER an attempt.

   Writes (all server-authored — firestore.rules deny these from clients):
     quizAttempts/{uid}/attempts/{attemptId}           the attempt
     learnerProgress/{uid}/courseProgress/{courseId}   earned[lessonId] when a
                                                       REQUIRED quiz is passed
   A PRACTICE quiz records the attempt but never earns completion. */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db, FieldValue } = require("./lib");
const S = require("./academyScoring");
const P = require("./academyProgression");

const submitQuizAttempt = onCall({ memory: "256MiB", timeoutSeconds: 30 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const uid = req.auth.uid;
  const courseId = String((req.data && req.data.courseId) || "");
  const lessonId = String((req.data && req.data.lessonId) || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(courseId) || !/^[A-Za-z0-9_-]{1,64}$/.test(lessonId))
    throw new HttpsError("invalid-argument", "Course or lesson id is missing.");

  const [profSnap, courseSnap, lessonSnap, keySnap, idxSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("courses").doc(courseId).get(),
    db.collection("courses").doc(courseId).collection("lessons").doc(lessonId).get(),
    db.collection("courses").doc(courseId).collection("quizKeys").doc(lessonId).get(),
    db.collection("academySettings").doc("categoryIndex").get(),
  ]);
  const profile = profSnap.exists ? { uid, ...profSnap.data() } : null;
  const course = courseSnap.exists ? courseSnap.data() : null;
  const lesson = lessonSnap.exists ? lessonSnap.data() : null;
  const hidden = idxSnap.exists ? (idxSnap.data().hidden || []) : [];
  const pre = S.attemptPrecondition(profile, course, lesson, hidden);
  if (pre) throw new HttpsError(pre[0], pre[1]);
  if (!keySnap.exists) throw new HttpsError("failed-precondition", "This quiz has no answer key yet. Ask the instructor to finish setting it up.");

  const v = S.validateAnswers(lesson.quiz, req.data && req.data.answers);
  if (!v.ok) throw new HttpsError(v.code, v.message);

  // Submission identity: the client sends one id per attempt and REUSES it when
  // it retries an uncertain request (timeout, dropped connection), so a retry
  // returns the original result instead of consuming a second attempt.
  const submissionId = String((req.data && req.data.submissionId) || "");
  if (submissionId && !/^[A-Za-z0-9_-]{8,64}$/.test(submissionId)) throw new HttpsError("invalid-argument", "Bad submission id.");
  const mode = S.quizMode(lesson);
  const attemptsRef = db.collection("quizAttempts").doc(uid).collection("attempts");
  const attemptRef = submissionId ? attemptsRef.doc(submissionId) : attemptsRef.doc();
  const progressRef = db.collection("learnerProgress").doc(uid).collection("courseProgress").doc(courseId);
  const allLessons = (await db.collection("courses").doc(courseId).collection("lessons").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const scored = S.scoreAttempt(lesson.quiz, keySnap.data(), v.answers);

  // One transaction: replay check, prerequisites, attempt allowance (counted
  // INSIDE the transaction), attempt + progress writes. Every submission also
  // writes the progress doc, so concurrent submissions serialise and can't
  // exceed the allowance.
  const runTx = () => db.runTransaction(async (tx) => {
    const prior = await tx.get(attemptRef);
    if (prior.exists) {
      const a = prior.data();
      if (a.courseId !== courseId || a.lessonId !== lessonId) throw new HttpsError("already-exists", "That submission id was already used.");
      return { replay: a };
    }
    const progSnap = await tx.get(progressRef);
    const progress = progSnap.exists ? progSnap.data() : null;
    // Prerequisites (v6.5): the quiz's lesson must be open — same rule as the UI.
    const locked = P.lockedMessage(course, allLessons, progress, lessonId);
    if (locked) throw new HttpsError("failed-precondition", locked);
    const used = (await tx.get(attemptsRef.where("courseId", "==", courseId).where("lessonId", "==", lessonId))).size;
    const extra = Number(progress && progress.attemptGrants && progress.attemptGrants[lessonId] && progress.attemptGrants[lessonId].extra) || 0;
    const allowed = P.attemptAllowance(lesson.quiz, extra);
    if (allowed && used >= allowed) throw new HttpsError("resource-exhausted", "You've used all the attempts for this quiz.");
    const now = FieldValue.serverTimestamp();
    const earnNow = mode === "required" && scored.passed;
    tx.set(attemptRef, S.buildAttempt({ uid, courseId, lessonId, mode, answers: v.answers, scored, now }));
    // Merge ONLY server fields so the learner's own client-writable fields
    // (playback, view data) are untouched. A pass never removes an earlier one.
    const patch = { uid, courseId, updatedAt: now, ...P.progressStamp(course, allLessons, progress, now) };
    if (earnNow) patch.earned = { [lessonId]: { at: now, attemptId: attemptRef.id, percent: scored.percent } };
    if (!progress || !progress.startedAt) patch.startedAt = now;
    tx.set(progressRef, patch, { merge: true });
    return { earnNow, used: used + 1, allowed };
  });
  // A concurrent duplicate (same submission id) can make this transaction lose
  // (production: retried; the emulator: "invalid or closed"). If the attempt
  // landed, answer with its result instead of an error; otherwise say plainly
  // that nothing was recorded and resubmitting is safe.
  let out;
  try { out = await runTx(); }
  catch (e) {
    if (e instanceof HttpsError) throw e;
    const landed = submissionId ? await attemptRef.get() : null;
    if (landed && landed.exists && landed.data().courseId === courseId && landed.data().lessonId === lessonId) out = { replay: landed.data() };
    else throw new HttpsError("aborted", "Your answers weren't recorded. Submit again. It won't use an extra attempt.");
  }
  if (out.replay) {
    const a = out.replay;
    return { ...S.attemptResponse(attemptRef.id, { score: a.score, total: a.total, percent: a.percent, passMark: a.passMark, passed: a.passed, results: a.results || [] }, a.mode, a.mode === "required" && a.passed), replayed: true };
  }
  return { ...S.attemptResponse(attemptRef.id, scored, mode, out.earnNow), attemptsUsed: out.used, attemptsAllowed: out.allowed };
});

module.exports = { submitQuizAttempt };
