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

  const mode = S.quizMode(lesson);
  const attemptsRef = db.collection("quizAttempts").doc(uid).collection("attempts");
  const prior = await attemptsRef.where("courseId", "==", courseId).where("lessonId", "==", lessonId).count().get();
  const gate = S.attemptAllowed(lesson.quiz, prior.data().count);
  if (!gate.ok) throw new HttpsError("resource-exhausted", "You've used all the attempts for this quiz.");

  const scored = S.scoreAttempt(lesson.quiz, keySnap.data(), v.answers);
  const now = FieldValue.serverTimestamp();
  const attemptRef = attemptsRef.doc();
  const progressRef = db.collection("learnerProgress").doc(uid).collection("courseProgress").doc(courseId);
  const earnNow = mode === "required" && scored.passed;

  await db.runTransaction(async (tx) => {
    const prog = earnNow ? await tx.get(progressRef) : null;
    tx.set(attemptRef, S.buildAttempt({ uid, courseId, lessonId, mode, answers: v.answers, scored, now }));
    if (earnNow) {
      // Merge ONLY the earned entry (+ bookkeeping) so the learner's own
      // client-writable fields (positions, manual flags) are untouched;
      // `earned` is only ever written here.
      const started = prog.exists && prog.data().startedAt;
      const patch = {
        uid, courseId, updatedAt: now,
        earned: { [lessonId]: { at: now, attemptId: attemptRef.id, percent: scored.percent } },
      };
      const fields = ["uid", "courseId", "updatedAt", `earned.${lessonId}`];
      if (!started) { patch.startedAt = now; fields.push("startedAt"); }
      tx.set(progressRef, patch, { mergeFields: fields });
    }
  });
  return S.attemptResponse(attemptRef.id, scored, mode, earnNow);
});

module.exports = { submitQuizAttempt };
