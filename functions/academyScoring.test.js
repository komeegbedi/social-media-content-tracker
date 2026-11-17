/* IFC Creative Academy — server-side quiz scoring (pure).
   Run: node --test functions/academyScoring.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const S = require("./academyScoring");

const quiz = (over = {}) => ({
  mode: "required", passMark: 70, retryLimit: 0,
  questions: [
    { id: "q1", prompt: "Aperture?", multi: false, options: [{ id: "a", text: "f/2" }, { id: "b", text: "ISO" }] },
    { id: "q2", prompt: "Pick two", multi: true, options: [{ id: "a", text: "x" }, { id: "b", text: "y" }, { id: "c", text: "z" }] },
    { id: "q3", prompt: "Single", multi: false, options: [{ id: "a", text: "1" }, { id: "b", text: "2" }] },
  ], ...over,
});
const key = { answers: { q1: ["a"], q2: ["a", "c"], q3: ["b"] }, explanations: { q1: "Aperture is f-stop." } };

test("validateAnswers: every question answered, known options only, single means one", () => {
  assert.equal(S.validateAnswers(quiz(), { q1: ["a"], q2: ["a"], q3: ["b"] }).ok, true);
  assert.equal(S.validateAnswers(quiz(), { q1: ["a"], q2: ["a"] }).code, "invalid-argument");
  assert.equal(S.validateAnswers(quiz(), { q1: ["zz"], q2: ["a"], q3: ["b"] }).code, "invalid-argument");
  assert.equal(S.validateAnswers(quiz(), { q1: ["a", "b"], q2: ["a"], q3: ["b"] }).code, "invalid-argument");
  assert.equal(S.validateAnswers(quiz(), { q1: ["a"], q2: ["a"], q3: ["b"], bogus: ["a"] }).code, "invalid-argument");
  assert.equal(S.validateAnswers(quiz(), null).code, "invalid-argument");
  assert.equal(S.validateAnswers({ questions: [] }, {}).code, "failed-precondition");
  assert.equal(S.validateAnswers(quiz(), { q1: "a", q2: ["a"], q3: ["b"] }).ok, false, "answers must be arrays");
});

test("scoreAttempt: exact-set matching, no partial credit for multi, explanations attached", () => {
  const s = S.scoreAttempt(quiz(), key, { q1: ["a"], q2: ["a", "c"], q3: ["a"] });
  assert.equal(s.score, 2); assert.equal(s.total, 3); assert.equal(s.percent, 67); assert.equal(s.passed, false);
  assert.equal(s.results[0].explanation, "Aperture is f-stop.");
  assert.deepEqual(s.results[1].correctOptions, ["a", "c"]);
  const partial = S.scoreAttempt(quiz(), key, { q1: ["a"], q2: ["a"], q3: ["b"] });
  assert.equal(partial.results[1].correct, false, "one of two multi answers is wrong");
  assert.equal(partial.percent, 67);
  const full = S.scoreAttempt(quiz(), key, { q1: ["a"], q2: ["c", "a"], q3: ["b"] });
  assert.equal(full.percent, 100); assert.equal(full.passed, true);
  // a question missing from the key can never be "correct"
  const noKey = S.scoreAttempt(quiz(), { answers: {} }, { q1: ["a"], q2: ["a"], q3: ["b"] });
  assert.equal(noKey.score, 0);
});

test("pass mark: configurable, clamped, defaults to 70", () => {
  assert.equal(S.clampPassMark(undefined), 70);
  assert.equal(S.clampPassMark("abc"), 70);
  assert.equal(S.clampPassMark(0), 1);
  assert.equal(S.clampPassMark(150), 100);
  const lenient = S.scoreAttempt(quiz({ passMark: 50 }), key, { q1: ["a"], q2: ["a"], q3: ["b"] });
  assert.equal(lenient.passed, true);
});

test("attemptAllowed honours retryLimit (0 = unlimited)", () => {
  assert.deepEqual(S.attemptAllowed({ retryLimit: 0 }, 50), { ok: true, remaining: null });
  assert.deepEqual(S.attemptAllowed({ retryLimit: 3 }, 2), { ok: true, remaining: 1 });
  assert.deepEqual(S.attemptAllowed({ retryLimit: 3 }, 3), { ok: false, remaining: 0 });
});

test("attemptPrecondition: approved learners on published courses; editors on drafts; nothing else", () => {
  const admin = { uid: "a", role: "admin", status: "approved" };
  const member = { uid: "m", role: "member", status: "approved" };
  const inst = { uid: "i", role: "member", status: "approved", academyEditor: true };
  const pending = { uid: "p", role: "member", status: "pending" };
  const disabled = { uid: "d", role: "admin", status: "removed", disabled: true };
  const pub = { status: "published", instructorUid: "i" }, draft = { status: "draft", instructorUid: "i" };
  const lesson = { quiz: quiz() };
  assert.equal(S.attemptPrecondition(member, pub, lesson), null);
  assert.equal(S.attemptPrecondition(member, draft, lesson)[0], "permission-denied");
  assert.equal(S.attemptPrecondition(inst, draft, lesson), null);
  assert.equal(S.attemptPrecondition(admin, draft, lesson), null);
  assert.equal(S.attemptPrecondition(pending, pub, lesson)[0], "permission-denied");
  assert.equal(S.attemptPrecondition(disabled, pub, lesson)[0], "permission-denied");
  assert.equal(S.attemptPrecondition(null, pub, lesson)[0], "permission-denied");
  assert.equal(S.attemptPrecondition(member, null, lesson)[0], "not-found");
  assert.equal(S.attemptPrecondition(member, pub, null)[0], "not-found");
  assert.equal(S.attemptPrecondition(member, pub, { quiz: { mode: "none" } })[0], "failed-precondition");
  assert.equal(S.attemptPrecondition(member, pub, { quiz: { mode: "required", questions: [] } })[0], "failed-precondition");
  // hidden category: learners blocked, editors not; per-course instructorUid grants nothing any more
  assert.equal(S.attemptPrecondition(member, { status: "published", category: "x" }, lesson, ["x"])[0], "permission-denied");
  assert.equal(S.attemptPrecondition(inst, { status: "published", category: "x" }, lesson, ["x"]), null);
  assert.equal(S.attemptPrecondition({ uid: "i", role: "member", status: "approved" }, draft, lesson)[0], "permission-denied", "former instructor without the editor role");
});

test("attempt record + response shapes; practice never earns completion", () => {
  const scored = S.scoreAttempt(quiz(), key, { q1: ["a"], q2: ["a", "c"], q3: ["b"] });
  const rec = S.buildAttempt({ uid: "m", courseId: "c", lessonId: "l", mode: "required", answers: { q1: ["a"] }, scored, now: "NOW" });
  assert.equal(rec.uid, "m"); assert.equal(rec.passed, true); assert.equal(rec.createdAt, "NOW"); assert.equal(rec.results.length, 3);
  const res = S.attemptResponse("att1", scored, "practice", false);
  assert.equal(res.attemptId, "att1"); assert.equal(res.earnedCompletion, false); assert.equal(res.passed, true);
  assert.equal(S.attemptResponse("att2", scored, "required", true).earnedCompletion, true);
});
