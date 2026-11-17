/* Progression rules (server) + parity with the client rules.
   Run: node --test functions/academyProgression.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const P = require("./academyProgression");
const S = require("./academyScoring");

const quiz = { mode: "required", passMark: 70, questions: [{ id: "q", options: [{ id: "a" }, { id: "b" }] }] };
const practice = { mode: "practice", passMark: 70, questions: [{ id: "q", options: [{ id: "a" }, { id: "b" }] }] };
const course = { modules: [{ id: "m1", lessonIds: ["read", "vid", "bonus", "quiz", "drive", "opt", "adv"] }] };
const lessons = [
  { id: "read", title: "Read" },
  { id: "vid", title: "Video", video: { provider: "youtube", id: "x" } },
  { id: "bonus", title: "Bonus", bonus: true },
  { id: "quiz", title: "Quiz", quiz },
  { id: "drive", title: "Drive video", video: { provider: "gdrive", id: "y" } },
  { id: "opt", title: "Practice quiz", quiz: practice },
  { id: "adv", title: "Advanced", prerequisites: ["quiz", "read"] },
];
const prog = (lessonsDone = {}, earned = {}, extra = {}) => ({ lessons: lessonsDone, earned, ...extra });
const acc = (progress, ls = lessons, c = course) => Object.fromEntries(P.lessonAccess(c, ls, progress).map((a) => [a.id, a.accessible]));
const allDone = prog({ read: { manualDone: true }, vid: { videoWatched: true }, drive: { manualDone: true }, opt: { manualDone: true }, adv: { manualDone: true } }, { quiz: { at: 1 } });

test("being required never locks anything; only explicit prerequisites do", () => {
  assert.deepEqual(acc(null), { read: true, vid: true, bonus: true, quiz: true, drive: true, opt: true, adv: false });
  assert.equal(P.lessonAccess(course, lessons, null).find((a) => a.id === "adv").missingIds.join(), "quiz,read");
});
test("a required quiz unlocks its dependants only when PASSED; a failed quiz blocks nothing unrelated", () => {
  assert.equal(acc(prog({ read: { manualDone: true }, quiz: { manualDone: true } })).adv, false, "manual flag on a required-quiz lesson doesn't count");
  assert.equal(acc(prog({ read: { manualDone: true } }, { quiz: { at: 1 } })).adv, true);
  const failed = acc(prog({}, {}));
  assert.equal(failed.drive && failed.vid && failed.read, true, "unrelated lessons stay open");
});
test("broken prerequisite data is never satisfied (self, missing, later lesson, not a list); other lessons unaffected", () => {
  const ls = [{ id: "a", prerequisites: ["a"] }, { id: "b", prerequisites: ["zzz"] }, { id: "c", prerequisites: ["d"] }, { id: "d" }, { id: "e", prerequisites: "d" }];
  const c = { modules: [{ id: "m", lessonIds: ["a", "b", "c", "d", "e"] }] };
  assert.deepEqual(acc(null, ls, c), { a: false, b: false, c: false, d: true, e: false });
  assert.equal(P.lockedMessage(c, ls, null, "c"), P.BROKEN_MESSAGE);
  assert.equal(P.completeLessonDecision({ course: c, lessons: ls, progress: null, lessonId: "c", how: "manual", done: true })[1], P.BROKEN_MESSAGE, "completion refused, not granted");
  assert.equal(acc({ lessons: { c: { manualDone: true } } }, ls, c).c, true, "an earlier completion stays");
});
test("earlier-lesson rule + verdict helpers", () => {
  const ordered = [{ id: "a", title: "A" }, { id: "b", title: "B", prerequisites: ["a"] }, { id: "c", title: "C", prerequisites: ["a", "b"] }];
  assert.deepEqual(P.validatePrerequisites(ordered), []);
  assert.deepEqual(P.validatePrerequisites([...ordered.slice(0, 2), { id: "c", title: "C", prerequisites: ["d"] }, { id: "d", title: "D" }]).map((i) => i.kind), ["order"]);
  assert.deepEqual(P.prerequisiteMapOf(ordered), { b: ["a"], c: ["a", "b"] });
  assert.deepEqual(P.normalizeModules([{ id: "m", title: "x".repeat(130), lessonIds: ["a"], extra: 1 }]), [{ id: "m", title: "x".repeat(120), lessonIds: ["a"] }]);
});
test("validatePrerequisites (server copy) catches self / duplicate / missing / cycle / optional-required", () => {
  const k = (ls) => P.validatePrerequisites(ls).map((i) => i.kind).sort();
  assert.deepEqual(k(lessons), []);
  assert.deepEqual(k([{ id: "a", title: "A", prerequisites: ["a"] }]), ["self"]);
  assert.deepEqual(k([{ id: "a", title: "A" }, { id: "b", title: "B", prerequisites: ["a", "a"] }]), ["duplicate"]);
  assert.deepEqual(k([{ id: "a", title: "A", prerequisites: ["elsewhere"] }]), ["missing"]);
  assert.deepEqual(k([{ id: "a", title: "A", prerequisites: ["c"] }, { id: "b", title: "B", prerequisites: ["a"] }, { id: "c", title: "C", prerequisites: ["b"] }]), ["cycle", "order"], "a loop always includes a later lesson");
  assert.deepEqual(k([{ id: "o", title: "O", bonus: true }, { id: "r", title: "R", prerequisites: ["o"] }]), ["optional-prerequisite"]);
});
test("completion type: tracked videos can't be self-marked; Drive (untracked) and text can; required quizzes only by passing", () => {
  assert.deepEqual(P.completionPrecondition(lessons[1], "manual")[0], "failed-precondition");
  assert.equal(P.completionPrecondition(lessons[1], "video"), null);
  assert.equal(P.completionPrecondition(lessons[4], "manual"), null);
  assert.equal(P.completionPrecondition(lessons[4], "video")[0], "failed-precondition");
  assert.equal(P.completionPrecondition(lessons[0], "manual"), null);
  assert.equal(P.completionPrecondition(lessons[3], "manual")[1], "Pass the quiz to complete this lesson.");
  const odd = { id: "odd", title: "Odd", video: { provider: "weird", id: "z" } };
  assert.match(P.completionPrecondition(odd, "manual")[1], /Report it/);
});
test("completeLesson decision: locked → 'Complete “X” to unlock this lesson.'; un-marking only self-reports", () => {
  assert.equal(P.completeLessonDecision({ course, lessons, progress: prog({ read: { manualDone: true } }), lessonId: "adv", how: "manual", done: true })[1], "Complete “Quiz” to unlock this lesson.");
  assert.equal(P.completeLessonDecision({ course, lessons, progress: null, lessonId: "adv", how: "manual", done: true })[1], "Complete “Quiz” and “Read” to unlock this lesson.");
  assert.equal(P.completeLessonDecision({ course, lessons, progress: null, lessonId: "drive", how: "manual", done: true }), null, "required but no prerequisites → open");
  assert.equal(P.completeLessonDecision({ course, lessons, progress: null, lessonId: "vid", how: "video", done: false })[0], "invalid-argument");
  assert.equal(P.completeLessonDecision({ course, lessons, progress: null, lessonId: "nope", how: "manual", done: true })[0], "not-found");
});
test("finish: any order, optional extras don't block, idempotent; legacy completions are kept (no celebration)", () => {
  assert.match(P.finishDecision({ course, lessons, progress: prog() }).error[1], /required lessons are still incomplete/);
  const ready = { ...allDone, progressModel: 2 };
  assert.deepEqual(P.finishDecision({ course, lessons, progress: ready }), { finish: true, required: 6 });
  assert.deepEqual(P.finishDecision({ course, lessons, progress: { ...ready, finishedAt: { toMillis: () => 5 } } }), { already: true });
  assert.deepEqual(P.finishDecision({ course, lessons, progress: allDone }), { already: true, legacy: true, required: 6 }, "no marker + all done = completed earlier");
  assert.ok(P.finishDecision({ course: { modules: [] }, lessons: [], progress: null }).error);
});
test("progressStamp: marks every server write; converts a legacy completion into a recorded one the first time", () => {
  assert.deepEqual(P.progressStamp(course, lessons, prog(), "NOW"), { progressModel: 2 });
  assert.deepEqual(P.progressStamp(course, lessons, allDone, "NOW"), { progressModel: 2, finishedAt: "NOW", finishedVia: "legacy", finishedRequired: 6 });
  assert.deepEqual(P.progressStamp(course, lessons, { ...allDone, progressModel: 2 }, "NOW"), { progressModel: 2 }, "a v6.5 doc is never auto-finished");
});
test("attempt allowance: limit + staff grants; 0 = unlimited", () => {
  assert.equal(P.attemptAllowance({ retryLimit: 0 }, 5), 0);
  assert.equal(P.attemptAllowance({ retryLimit: 3 }), 3);
  assert.equal(P.attemptAllowance({ retryLimit: 3 }, 2), 5);
});
test("multiple-select scoring is exact match: all correct and nothing else; selecting everything never passes", () => {
  const q = { mode: "required", passMark: 70, questions: [{ id: "b1", multi: true, options: [{ id: "p" }, { id: "q" }, { id: "r" }] }, { id: "b2", options: [{ id: "s" }, { id: "t" }] }] };
  const key = { answers: { b1: ["p", "r"], b2: ["t"] } };
  const score = (a) => S.scoreAttempt(q, key, S.validateAnswers(q, a).answers);
  assert.equal(score({ b1: ["r", "p"], b2: ["t"] }).percent, 100, "order doesn't matter");
  assert.equal(score({ b1: ["p"], b2: ["t"] }).results[0].correct, false, "a missed correct choice → incorrect");
  assert.equal(score({ b1: ["p", "q", "r"], b2: ["t"] }).results[0].correct, false, "an extra wrong choice → incorrect");
  assert.equal(score({ b1: ["p", "q", "r"], b2: ["t"] }).passed, false, "selecting every option doesn't pass");
  assert.deepEqual(score({ b1: ["p"], b2: ["t"] }).results[0].selected, ["p"], "the graded selection is what's shown back");
  assert.equal(S.validateAnswers(q, { b1: ["p"], b2: ["s", "t"] }).ok, false, "single-answer questions take one choice");
});

test("PARITY: the client rules (src/academyProgress.js) and the server rules agree", async () => {
  const C = await import("../src/academyProgress.js");
  const cases = [null, prog(), prog({ read: { manualDone: true } }), prog({ read: { manualDone: true }, bonus: { manualDone: true } }),
    prog({ read: { manualDone: true }, vid: { videoWatched: true } }, { quiz: { at: 1 } }), allDone, { ...allDone, progressModel: 2 },
    prog({ vid: { videoWatched: true }, quiz: { manualDone: true } })];
  const graphs = [lessons, [{ id: "a", prerequisites: ["b"] }, { id: "b", prerequisites: ["a"] }, { id: "c", prerequisites: ["a", "a", "zz"] }, { id: "d", prerequisites: "x" }],
    [{ id: "x" }, { id: "y", prerequisites: ["x"] }, { id: "z", bonus: true, prerequisites: ["y"] }]];
  for (const ls of graphs) {
    const c = { modules: [{ id: "m", lessonIds: ls.map((l) => l.id) }] };
    for (const p of cases) {
      const server = P.lessonAccess(c, ls, p).map((a) => [a.id, a.accessible, a.completed, a.broken, a.missingIds.join()]);
      const client = C.lessonAccess(c, ls, p).map((a) => [a.id, a.accessible, a.completed, a.broken, a.missing.map((m) => m.id).join()]);
      assert.deepEqual(client, server, JSON.stringify(p));
      assert.equal(C.readyToFinish(c, ls, p).ready, P.readyToFinish(c, ls, p).ready);
    }
    assert.deepEqual(C.validatePrerequisites(ls).map((i) => i.kind + i.lessonId), P.validatePrerequisites(ls).map((i) => i.kind + i.lessonId));
  }
});

test("attemptStatusRows: only limited quizzes; requests first, then out-of-attempts; names + counts only", () => {
  const ls = [{ id: "q", title: "Quiz", quiz: { ...quiz, retryLimit: 2 } }, { id: "free", title: "Free", quiz: { ...quiz, retryLimit: 0 } }];
  const attempts = [{ uid: "u1", lessonId: "q" }, { uid: "u1", lessonId: "q" }, { uid: "u2", lessonId: "q" }, { uid: "u3", lessonId: "free" }];
  const rows = P.attemptStatusRows({ lessons: ls, attempts, namesByUid: { u1: "Ann", u2: "Ben", u4: "Cy" },
    progressByUid: { u2: { earned: { q: { at: 1 } } }, u4: { attemptRequests: { q: { at: 5 } }, attemptGrants: { q: { extra: 1, history: [{ byName: "Ed", at: 3, count: 1 }] } } } } });
  assert.deepEqual(rows.map((r) => [r.name, r.used, r.allowed, r.exhausted, r.passed, r.requestedAt]), [["Cy", 0, 3, false, false, 5], ["Ann", 2, 2, true, false, null], ["Ben", 1, 2, false, true, null]]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["allowed", "exhausted", "extra", "lastGrant", "lessonId", "lessonTitle", "name", "passed", "requestedAt", "uid", "used"], "no other learner data");
  assert.equal(rows.some((r) => r.lessonId === "free"), false, "unlimited quizzes aren't listed");
});

/* ---- v6.8 publish content check (server-authoritative) ---- */
const vid = (over = {}) => ({ id: "v", title: "Video", kind: "video", video: { provider: "youtube", id: "dQw4w9WgXcQ" }, quiz: { mode: "none", questions: [] }, ...over });
const quizL = (q, answers, over = {}) => ({ id: "q", title: "Quiz", kind: "written", quiz: { mode: "required", passMark: 70, retryLimit: 0, questions: [q] }, quizKey: { answers, explanations: {} }, ...over });
const Q = (over = {}) => ({ id: "x", prompt: "Which?", multi: false, options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], ...over });

test("publish check: video lessons need a SUPPORTED link (format only — no provider call)", () => {
  assert.deepEqual(P.publishContentIssues([vid()]), []);
  assert.match(P.publishContentIssues([vid({ video: null })])[0].message, /“Video” needs a video link/);
  for (const bad of [{ provider: "youtube", id: "short" }, { provider: "evil", id: "dQw4w9WgXcQ" }, { provider: "vimeo", id: "123456789", hash: "zz" }, { provider: "gdrive", id: "x" }])
    assert.equal(P.publishContentIssues([vid({ video: bad })])[0].kind, "video", JSON.stringify(bad));
  for (const ok of [{ provider: "vimeo", id: "123456789", hash: "abcdef12" }, { provider: "gdrive", id: "1AbCdEfGhIjKlMnOpQrStUvWxYz" }])
    assert.deepEqual(P.publishContentIssues([vid({ video: ok })]), [], JSON.stringify(ok));
  assert.deepEqual(P.publishContentIssues([{ id: "w", title: "Text", kind: "written", video: null, quiz: { mode: "none" } }]), [], "non-video lessons need no link");
});

test("publish check: single-answer = exactly one, multi = at least one, answers must point at real options", () => {
  assert.deepEqual(P.publishContentIssues([quizL(Q(), { x: ["a"] })]), []);
  assert.match(P.publishContentIssues([quizL(Q(), {})])[0].message, /no correct answer marked/);
  assert.match(P.publishContentIssues([quizL(Q(), { x: ["a", "b"] })])[0].message, /allows one correct answer but has 2 marked/);
  assert.match(P.publishContentIssues([quizL(Q(), { x: ["gone"] })])[0].message, /no correct answer marked/, "a dangling reference doesn't count");
  assert.deepEqual(P.publishContentIssues([quizL(Q({ multi: true }), { x: ["a", "b"] })]), []);
  assert.match(P.publishContentIssues([quizL(Q({ multi: true }), { x: [] })])[0].message, /no correct answer/);
  assert.match(P.publishContentIssues([quizL(Q({ prompt: " " }), { x: ["a"] })])[0].message, /no question text/);
  assert.match(P.publishContentIssues([quizL(Q({ options: [{ id: "a", text: "A" }] }), { x: ["a"] })])[0].message, /at least two answer options/);
  assert.deepEqual(P.publishContentIssues([quizL(Q(), {}, { quiz: { mode: "required", questions: [] } })]), [], "an empty quiz is no quiz");
  assert.deepEqual(P.publishContentIssues([quizL(Q(), {}, { quiz: { mode: "none", questions: [Q()] } })]), [], "a removed quiz isn't checked");
});

test("publish record: exactly the shape the client publishes (questions trimmed to limits, answers filtered to real options, no key without a quiz)", () => {
  const long = Q({ prompt: "p".repeat(1200), options: Array.from({ length: 9 }, (_, i) => ({ id: "o" + i, text: "t".repeat(400) })) });
  const r = P.publishRecord([quizL(long, { x: ["o1", "missing"] }), vid()]);
  assert.equal(r.lessonChecks.q.questions[0].prompt.length, 1000);
  assert.equal(r.lessonChecks.q.questions[0].options.length, 8);
  assert.equal(r.lessonChecks.q.questions[0].options[0].text.length, 300);
  assert.deepEqual(r.answerKeys.q, { x: ["o1"] });
  assert.deepEqual(r.lessonChecks.v, { kind: "video", video: { provider: "youtube", id: "dQw4w9WgXcQ" }, mode: "none", questions: [] });
  assert.equal(r.answerKeys.v, undefined, "no quiz → no published key");
  assert.equal(JSON.stringify(r).includes("undefined"), false);
  // a damaged question (no id) stores null, never undefined (Firestore rejects undefined)
  const dmg = P.publishRecord([quizL(Q({ id: undefined }), {})]);
  assert.equal(dmg.lessonChecks.q.questions[0].id, null);
});

test("PARITY (v6.8): the browser's publishIssues flags the same quiz/video problems as the server", async () => {
  const C = await import("../src/academyProgress.js");
  const course = { title: "T", category: "photography", level: "beginner", cover: { path: "p" } };
  const cases = [vid(), vid({ video: null }), vid({ video: { provider: "youtube", id: "bad" } }), vid({ video: { provider: "vimeo", id: "123456789", hash: "zz" } }),
    quizL(Q(), { x: ["a"] }), quizL(Q(), {}), quizL(Q(), { x: ["a", "b"] }), quizL(Q(), { x: ["gone"] }), quizL(Q({ multi: true }), { x: ["a", "b"] }), quizL(Q({ multi: true }), {})];
  for (const l of cases) {
    const server = P.publishContentIssues([l]).length > 0;
    const client = C.publishIssues({ ...course, modules: [{ id: "m", lessonIds: [l.id] }] }, [l], ["photography"]).some((i) => i.item === l.id);
    assert.equal(client, server, JSON.stringify(l));
  }
});
