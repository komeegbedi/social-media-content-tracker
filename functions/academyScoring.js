/* IFC Creative Academy — quiz scoring + completion rules (pure, server side).

   The ONLY place a quiz is graded. Correct answers live in
   courses/{id}/quizKeys/{lessonId}, which clients can never read; the callable
   in academyQuiz.js loads them with the Admin SDK, calls these helpers, and
   writes the attempt + any earned completion. Mirrors src/academyProgress.js
   for the shared rules (quiz mode, required lessons). */

const QUIZ_MODES = ["none", "practice", "required"];
const DEFAULT_PASS_MARK = 70;

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/* Shape-check the learner's answers against the lesson's PUBLIC questions.
   Unknown question/option ids are rejected (not silently dropped) so a tampered
   payload can't be graded as "partially right". */
function validateAnswers(quiz, answers) {
  if (!quiz || !Array.isArray(quiz.questions) || !quiz.questions.length) return { ok: false, code: "failed-precondition", message: "This lesson has no quiz." };
  if (!isPlainObject(answers)) return { ok: false, code: "invalid-argument", message: "Answers are missing." };
  const clean = {};
  for (const q of quiz.questions) {
    const sel = answers[q.id];
    if (!Array.isArray(sel) || !sel.length) return { ok: false, code: "invalid-argument", message: "Answer every question." };
    const ids = [...new Set(sel.map(String))];
    if (ids.some((o) => !(q.options || []).some((op) => op.id === o))) return { ok: false, code: "invalid-argument", message: "An answer doesn't match the question." };
    if (!q.multi && ids.length > 1) return { ok: false, code: "invalid-argument", message: "Choose one answer per question." };
    clean[q.id] = ids;
  }
  const extra = Object.keys(answers).filter((k) => !quiz.questions.some((q) => q.id === k));
  if (extra.length) return { ok: false, code: "invalid-argument", message: "Unknown question in answers." };
  return { ok: true, answers: clean };
}

/* Score: a question is correct only when the selected set EQUALS the key set
   (multi-answer questions get no partial credit — simple and explainable). */
function scoreAttempt(quiz, key, answers) {
  const results = [];
  let score = 0;
  for (const q of quiz.questions) {
    const correct = [...new Set((key.answers && key.answers[q.id]) || [])].map(String).sort();
    const selected = [...(answers[q.id] || [])].map(String).sort();
    const isCorrect = correct.length > 0 && correct.length === selected.length && correct.every((c, i) => c === selected[i]);
    if (isCorrect) score += 1;
    results.push({
      qId: q.id, correct: isCorrect, selected,
      correctOptions: correct,
      explanation: String((key.explanations && key.explanations[q.id]) || ""),
    });
  }
  const total = quiz.questions.length;
  const percent = total ? Math.round((score / total) * 100) : 0;
  const passMark = clampPassMark(quiz.passMark);
  return { score, total, percent, passMark, passed: percent >= passMark, results };
}

function clampPassMark(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_PASS_MARK;
  return Math.min(100, Math.max(1, Math.round(n)));
}

function quizMode(lesson) {
  const m = lesson && lesson.quiz && lesson.quiz.mode;
  return QUIZ_MODES.includes(m) && Array.isArray(lesson.quiz.questions) && lesson.quiz.questions.length ? m : "none";
}

/* Retry policy (retryLimit 0 = unlimited). */
function attemptAllowed(quiz, priorAttempts) {
  const limit = Number(quiz && quiz.retryLimit) || 0;
  if (!limit) return { ok: true, remaining: null };
  const remaining = Math.max(0, limit - (priorAttempts || 0));
  return remaining > 0 ? { ok: true, remaining } : { ok: false, remaining: 0 };
}

/* Who may take a quiz on this course: approved learners on a PUBLISHED course
   whose category isn't hidden, and Academy editors on any status so they can
   test a draft. Returns [code, message] or null. */
function attemptPrecondition(profile, course, lesson, hiddenCategoryIds = []) {
  if (!profile) return ["permission-denied", "Your account isn't set up."];
  if (profile.disabled === true) return ["permission-denied", "This account is disabled."];
  const approved = profile.status === "approved" || profile.role === "admin";
  if (!approved) return ["permission-denied", "Your account is awaiting approval."];
  if (!course) return ["not-found", "That course no longer exists."];
  // v4: Academy editors are a global role (admin, or academyEditor on the profile).
  const editor = profile.role === "admin" || profile.academyEditor === true;
  if (course.status !== "published" && !editor) return ["permission-denied", "This course isn't published."];
  if (!editor && hiddenCategoryIds.includes(course.category)) return ["permission-denied", "This course isn't available."];
  if (!lesson) return ["not-found", "That lesson no longer exists."];
  if (quizMode(lesson) === "none") return ["failed-precondition", "This lesson has no quiz."];
  return null;
}

/* The attempt record written to quizAttempts/{uid}/attempts/{id}. Server-authored;
   the learner reads it back (own uid), leaders read it for the progress view. */
function buildAttempt({ uid, courseId, lessonId, mode, answers, scored, now }) {
  return {
    uid, courseId, lessonId, mode,
    answers, score: scored.score, total: scored.total, percent: scored.percent,
    passMark: scored.passMark, passed: scored.passed,
    results: scored.results, createdAt: now,
  };
}

/* What the callable returns to the client (the learner-readable outcome). */
function attemptResponse(attemptId, scored, mode, earnedNow) {
  return {
    attemptId, score: scored.score, total: scored.total, percent: scored.percent,
    passMark: scored.passMark, passed: scored.passed, mode,
    results: scored.results, earnedCompletion: !!earnedNow,
  };
}

module.exports = {
  QUIZ_MODES, DEFAULT_PASS_MARK,
  validateAnswers, scoreAttempt, clampPassMark, quizMode, attemptAllowed,
  attemptPrecondition, buildAttempt, attemptResponse,
};
