/* IFC Creative Academy — progression rules, SERVER side (pure, CommonJS).

   Mirrors src/academyProgress.js (lessonState / lessonAccess / readyToFinish /
   prerequisite validation); academyProgression.test.js runs both over the same
   cases so they can't drift.

   v6.5 — two independent ideas:
   • REQUIRED to finish the course: every lesson except optional (bonus) ones.
     Being required never locks anything.
   • PREREQUISITES: the lesson ids listed on a lesson (`prerequisites`) must all
     be complete before it opens. No prerequisites (the default, and every
     course created before v6.5) = open directly.
   • A lesson is complete when: required quiz → passed (server `earned`);
     otherwise video watched or marked done (or, without a video, an earned
     optional quiz).
   • A prerequisite must come EARLIER in the course's full curriculum order
     (across sections). The first lesson can't have any. This also rules out
     loops.
   • ACCESSIBLE = complete (always reviewable) or every prerequisite complete.
   • BROKEN prerequisite data (not a list, the lesson itself, a lesson that
     isn't in the course, or one that isn't earlier) is NOT treated as
     satisfied: the lesson can't be opened or completed until an editor fixes
     it (earned completions are kept). Publishing refuses such data
     (validatePrerequisites + checkCoursePrerequisites + rules), so this only
     happens if published data was changed outside the publish flow.
   • Ready to finish = every required lesson complete, in any order. */
const QUIZ_MODES = ["practice", "required"];
const TRACKED_PROVIDERS = ["youtube", "vimeo"];        // the player reports "ended" for these
const UNTRACKED_PROVIDERS = ["gdrive"];                // playable, but can't report playback
const MAX_PREREQUISITES = 20;
const PROGRESS_MODEL = 2;                              // stamped by every server progress write since v6.5

const quizMode = (l) => {
  const m = l && l.quiz && l.quiz.mode;
  return QUIZ_MODES.includes(m) && ((l.quiz.questions || []).length > 0) ? m : "none";
};
const isRequired = (l) => !!l && l.bonus !== true;
const prereqList = (l) => (l && Array.isArray(l.prerequisites) ? l.prerequisites.map(String) : []);

function orderedLessons(course, lessons) {
  const byId = new Map((lessons || []).map((l) => [l.id, l]));
  const seen = new Set();
  const out = [];
  for (const m of (course && Array.isArray(course.modules) ? course.modules : [])) {
    for (const id of m.lessonIds || []) { const l = byId.get(id); if (l && !seen.has(id)) { seen.add(id); out.push(l); } }
  }
  const rest = (lessons || []).filter((l) => !seen.has(l.id)).sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
  return [...out, ...rest];
}

/* Per lesson, in course order: its prerequisite ids and whether that data is
   broken (and why). Duplicates are folded (rules forbid them anyway). */
function prerequisiteStatus(ordered) {
  const pos = new Map((ordered || []).map((l, i) => [l.id, i]));
  const out = new Map();
  (ordered || []).forEach((l, i) => {
    const raw = l.prerequisites;
    if (raw != null && !Array.isArray(raw)) { out.set(l.id, { ids: [], broken: "shape" }); return; }
    const ids = [...new Set(prereqList(l))];
    let broken = null;
    for (const p of ids) {
      if (p === l.id) broken = broken || "self";
      else if (!pos.has(p)) broken = broken || "missing";
      else if (pos.get(p) > i) broken = broken || "order";
    }
    out.set(l.id, { ids, broken });
  });
  return out;
}

function lessonCompleted(l, progress) {
  const p = (progress && progress.lessons && progress.lessons[l.id]) || {};
  const earned = !!(progress && progress.earned && progress.earned[l.id]);
  if (quizMode(l) === "required") return earned;
  return p.videoWatched === true || p.manualDone === true || (!l.video && earned);
}

function lessonAccess(course, lessons, progress) {
  const all = orderedLessons(course, lessons);
  const status = prerequisiteStatus(all);
  const done = new Map(all.map((l) => [l.id, lessonCompleted(l, progress)]));
  return all.map((l) => {
    const st = status.get(l.id);
    const prerequisiteIds = st.broken ? [] : st.ids;
    const missingIds = prerequisiteIds.filter((p) => !done.get(p));
    const completed = done.get(l.id);
    return { id: l.id, required: isRequired(l), completed, broken: st.broken, accessible: completed || (!st.broken && missingIds.length === 0), prerequisiteIds, missingIds, blockedById: completed ? null : (missingIds[0] || null) };
  });
}

/* lesson id → prerequisite ids (as stored) for lessons that have any — the
   map the course doc carries and the server verdict records. */
function prerequisiteMapOf(ordered) {
  return Object.fromEntries((ordered || []).filter((l) => prereqList(l).length).map((l) => [l.id, prereqList(l)]));
}
/* Module list exactly as the publish step writes it (courseShape). */
function normalizeModules(modules) {
  return (Array.isArray(modules) ? modules : []).slice(0, 50).map((m) => ({ id: m.id, title: String(m.title || "").slice(0, 120), lessonIds: (m.lessonIds || []).slice(0, 200) }));
}

function readyToFinish(course, lessons, progress) {
  const req = orderedLessons(course, lessons).filter(isRequired);
  const done = req.filter((l) => lessonCompleted(l, progress)).length;
  return { ready: req.length > 0 && done === req.length, total: req.length, done };
}

/* Course completion earned BEFORE explicit Finish course existed: the doc was
   never written by a v6.5 server function (no `progressModel`) — and since
   v6.4 every completion flag is server-written, so all-requirements-done on
   such a doc can only have happened earlier — and every required lesson is
   complete. It's kept as completed, never shown as "ready to finish". */
function legacyCompleted(course, lessons, progress) {
  return !!progress && !progress.progressModel && !progress.finishedAt && readyToFinish(course, lessons, progress).ready;
}

/* Fields every server progress write adds: the model marker, and — the first
   time a legacy completed doc is touched — its completion record, so the
   earned completion survives later edits. */
function progressStamp(course, lessons, progress, now) {
  const out = { progressModel: PROGRESS_MODEL };
  if (legacyCompleted(course, lessons, progress)) {
    out.finishedAt = now; out.finishedVia = "legacy"; out.finishedRequired = readyToFinish(course, lessons, progress).total;
  }
  return out;
}

/* Authoring validation (editor + checkCoursePrerequisites). Works on the RAW
   prerequisite lists. Returns [{ lessonId, kind, message }]; empty = valid. */
function validatePrerequisites(lessons) {
  // `lessons` MUST be in curriculum order (orderedLessons / flatLessons)
  const list = lessons || [];
  const byId = new Map(list.map((l) => [l.id, l]));
  const pos = new Map(list.map((l, i) => [l.id, i]));
  const title = (id) => { const l = byId.get(id); return `“${(l && String(l.title || "").trim()) || "Untitled lesson"}”`; };
  const issues = [];
  for (const l of list) {
    const ps = prereqList(l);
    if (l.prerequisites != null && !Array.isArray(l.prerequisites)) issues.push({ lessonId: l.id, kind: "shape", message: `${title(l.id)} has an unreadable prerequisite list.` });
    if (ps.length > MAX_PREREQUISITES) issues.push({ lessonId: l.id, kind: "too-many", message: `${title(l.id)} has more than ${MAX_PREREQUISITES} prerequisites.` });
    if (ps.includes(l.id)) issues.push({ lessonId: l.id, kind: "self", message: `${title(l.id)} can't be its own prerequisite.` });
    if (new Set(ps).size !== ps.length) issues.push({ lessonId: l.id, kind: "duplicate", message: `${title(l.id)} lists the same prerequisite twice.` });
    for (const p of ps) if (p !== l.id && !byId.has(p)) issues.push({ lessonId: l.id, prereqId: p, kind: "missing", message: `${title(l.id)} requires a lesson that isn't in this course. Remove it from its prerequisites.` });
    for (const p of [...new Set(ps)]) if (p !== l.id && byId.has(p) && pos.get(p) > pos.get(l.id)) issues.push({ lessonId: l.id, prereqId: p, kind: "order", message: `${title(l.id)} requires ${title(p)}, which comes after it in the course. A prerequisite must be an earlier lesson. Move ${title(l.id)} below ${title(p)}, or remove ${title(p)} from its prerequisites.` });
  }
  // cycles (direct or indirect): report each cycle once
  const adj = new Map(list.map((l) => [l.id, [...new Set(prereqList(l))].filter((p) => p !== l.id && byId.has(p))]));
  const state = new Map(); const reported = new Set();
  const visit = (id, path) => {
    state.set(id, 1); path.push(id);
    for (const p of adj.get(id) || []) {
      if (state.get(p) === 1) {
        const cyc = path.slice(path.indexOf(p));
        const key = [...cyc].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({ lessonId: id, kind: "cycle", message: `These lessons depend on each other in a loop, so none of them could ever open: ${[...cyc, p].map(title).join(" → ")}. Remove one of these prerequisites.` });
        }
      } else if (!state.get(p)) visit(p, path);
    }
    path.pop(); state.set(id, 2);
  };
  for (const l of list) if (!state.get(l.id)) visit(l.id, []);
  // an optional lesson that required content depends on (directly or not)
  for (const l of list.filter(isRequired)) {
    const seen = new Set(); const stack = [...(adj.get(l.id) || [])];
    while (stack.length) {
      const x = stack.pop(); if (seen.has(x)) continue; seen.add(x);
      const xl = byId.get(x);
      if (xl && !isRequired(xl)) issues.push({ lessonId: l.id, prereqId: x, kind: "optional-prerequisite", message: `${title(x)} is optional, but required lesson ${title(l.id)} depends on it, so learners would have to complete it to finish. Make ${title(x)} required, or remove it from ${title(l.id)}'s prerequisites.` });
      for (const p of adj.get(x) || []) stack.push(p);
    }
  }
  return issues;
}

/* Lessons that list `id` as a prerequisite (for delete warnings). */
const dependentsOf = (lessons, id) => (lessons || []).filter((l) => prereqList(l).includes(id));

/* How a lesson may be completed by the learner's own action (not a quiz):
     "video"  — the player reported the end, for providers that report it;
     "manual" — a lesson without a video, or a video on a provider that can't
                report playback (labelled "Mark as watched" in the UI).
   A required-quiz lesson completes only by passing the quiz. */
function completionPrecondition(lesson, how) {
  if (!lesson) return ["not-found", "That lesson no longer exists."];
  if (quizMode(lesson) === "required") return ["failed-precondition", "Pass the quiz to complete this lesson."];
  const tracked = !!(lesson.video && TRACKED_PROVIDERS.includes(lesson.video.provider));
  const untracked = !!(lesson.video && UNTRACKED_PROVIDERS.includes(lesson.video.provider));
  if (how === "video") return lesson.video && tracked ? null : ["failed-precondition", "This lesson has no tracked video."];
  if (how === "manual") {
    if (tracked) return ["failed-precondition", "Watch the video to the end to complete this lesson."];
    // a video link nobody can play (unknown provider) is a blocker to report, not a way round
    if (lesson.video && !untracked) return ["failed-precondition", "This lesson's video can't be played. Report it so an Academy editor can fix the link."];
    return null;
  }
  return ["invalid-argument", "Unknown completion type."];
}

/* Who may record progress on a course at all (learners: published, visible). */
function courseAccessPrecondition(profile, course, hiddenCategoryIds = []) {
  if (!profile) return ["permission-denied", "Your account isn't set up."];
  if (profile.disabled === true) return ["permission-denied", "This account is disabled."];
  if (!(profile.status === "approved" || profile.role === "admin")) return ["permission-denied", "Your account is awaiting approval."];
  if (!course) return ["not-found", "That course no longer exists."];
  const editor = profile.role === "admin" || profile.academyEditor === true;
  if (course.status !== "published" && !editor) return ["permission-denied", "This course isn't published."];
  if (!editor && hiddenCategoryIds.includes(course.category)) return ["permission-denied", "This course isn't available."];
  return null;
}

/* "Complete “X” to unlock this lesson." for a locked lesson (null if open). */
const BROKEN_MESSAGE = "This lesson's prerequisites are set up incorrectly, so it can't be completed until an Academy editor fixes them.";
function lockedMessage(course, lessons, progress, lessonId) {
  const a = lessonAccess(course, lessons, progress).find((x) => x.id === lessonId);
  if (!a || a.accessible) return null;
  if (a.broken) return BROKEN_MESSAGE;
  const names = a.missingIds.map((id) => { const l = (lessons || []).find((x) => x.id === id); return `“${(l && l.title) || "an earlier lesson"}”`; });
  return names.length === 1 ? `Complete ${names[0]} to unlock this lesson.` : `Complete ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} to unlock this lesson.`;
}

/* Pure decision for completeLesson (unit-tested). Returns [code, message] or null. */
function completeLessonDecision({ course, lessons, progress, lessonId, how, done }) {
  const lesson = lessons.find((l) => l.id === lessonId);
  if (!lesson) return ["not-found", "That lesson no longer exists."];
  if (!orderedLessons(course, lessons).some((l) => l.id === lessonId)) return ["not-found", "That lesson isn't in this course."];
  if (!done) return how === "manual" ? null : ["invalid-argument", "Only a self-reported completion can be undone."];
  const pre = completionPrecondition(lesson, how);
  if (pre) return pre;
  const locked = lockedMessage(course, lessons, progress, lessonId);
  if (locked) return ["failed-precondition", locked];
  return null;
}

/* Pure decision for finishCourse (unit-tested). */
function finishDecision({ course, lessons, progress }) {
  if (progress && progress.finishedAt) return { already: true };
  if (legacyCompleted(course, lessons, progress)) return { already: true, legacy: true, required: readyToFinish(course, lessons, progress).total };
  const r = readyToFinish(course, lessons, progress);
  if (!r.ready) return { error: ["failed-precondition", r.total ? `${r.total - r.done} required lesson${r.total - r.done === 1 ? " is" : "s are"} still incomplete.` : "This course has no required lessons yet."] };
  return { finish: true, required: r.total };
}

/* Attempts allowed on a quiz: the lesson's limit (0 = unlimited) plus any
   extra attempts staff granted this learner. 0 = unlimited. */
function attemptAllowance(quiz, extra = 0) {
  const limit = Number(quiz && quiz.retryLimit) || 0;
  return limit ? limit + Math.max(0, Number(extra) || 0) : 0;
}

/* Staff view of attempts on ONE course's limited quizzes (quizAttemptStatus).
   Only what's needed to decide on another attempt: no progress, no team data.
   Rows: learners who used attempts on a limited quiz, or asked for more. */
function attemptStatusRows({ lessons, attempts, progressByUid = {}, namesByUid = {} }) {
  const limited = (lessons || []).filter((l) => quizMode(l) !== "none" && Number(l.quiz.retryLimit) > 0);
  const used = new Map();
  for (const a of attempts || []) { const k = `${a.uid}/${a.lessonId}`; used.set(k, (used.get(k) || 0) + 1); }
  const rows = [];
  const uids = new Set([...(attempts || []).map((a) => a.uid), ...Object.keys(progressByUid)]);
  for (const uid of uids) {
    const p = progressByUid[uid] || {};
    for (const l of limited) {
      const n = used.get(`${uid}/${l.id}`) || 0;
      const req = p.attemptRequests && p.attemptRequests[l.id];
      if (!n && !req) continue;
      const grant = (p.attemptGrants && p.attemptGrants[l.id]) || null;
      const extra = Number(grant && grant.extra) || 0;
      const allowed = attemptAllowance(l.quiz, extra);
      const history = grant && Array.isArray(grant.history) ? grant.history : [];
      const last = history.length ? history[history.length - 1] : null;
      const toMs = (t) => (t && t.toMillis ? t.toMillis() : (typeof t === "number" ? t : null));
      rows.push({ uid, name: namesByUid[uid] || "Former member", lessonId: l.id, lessonTitle: l.title || "Quiz", used: n, allowed, extra,
        passed: !!(p.earned && p.earned[l.id]), exhausted: n >= allowed,
        requestedAt: req ? toMs(req.at) : null, lastGrant: last ? { byName: last.byName || "", at: toMs(last.at), count: last.count } : null });
    }
  }
  const rank = (r) => (r.requestedAt && !r.passed ? 0 : r.exhausted && !r.passed ? 1 : r.passed ? 3 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || (b.requestedAt || 0) - (a.requestedAt || 0) || a.name.localeCompare(b.name));
}

/* ---- v6.8: what a published lesson must be (server-authoritative) ---------
   The publish check validates the DRAFT revision being published and records,
   per lesson, exactly what may be published: its kind, video record, quiz mode
   + questions and (editor-only verdict doc) answer keys. The rules then accept
   a published lesson / answer key / course only when it equals that record
   for the current draft revision — so a modified browser can't publish a
   video lesson without a valid link or a quiz learners can't pass.
   The shaping below mirrors the client's publish shaping (lessonShape +
   splitLessonForLive in src/) exactly; a mismatch can only REFUSE a publish
   (fail closed), never let bad content through. Format checks only — a video
   provider being unreachable never makes a link invalid. */
const VIDEO_ID = { youtube: /^[A-Za-z0-9_-]{11}$/, vimeo: /^\d{6,12}$/, gdrive: /^[A-Za-z0-9_-]{20,80}$/ };
const VIMEO_HASH = /^[a-f0-9]{6,16}$/i;
function validVideoRecord(v) {
  if (!v || typeof v !== "object") return false;
  const re = VIDEO_ID[v.provider];
  if (!re || !re.test(String(v.id || ""))) return false;
  return !v.hash || (v.provider === "vimeo" && VIMEO_HASH.test(String(v.hash)));
}
const LESSON_KINDS = ["video", "written", "exercise", "resource"];
const publishedKind = (d) => (LESSON_KINDS.includes(d.kind) ? d.kind : (d.video ? "video" : "written"));
const publishedVideo = (d) => (d.video ? { provider: d.video.provider || null, id: d.video.id || null, ...(d.video.hash ? { hash: d.video.hash } : {}) } : null);
function publishedQuiz(d) {
  const mode = (d.quiz && d.quiz.mode) || "none";
  const raw = mode === "none" ? [] : ((d.quiz && d.quiz.questions) || []);
  const questions = raw.slice(0, 30).map((q) => ({
    id: q.id || null, prompt: String(q.prompt || "").slice(0, 1000), multi: q.multi === true,
    options: (q.options || []).slice(0, 8).map((o) => ({ id: o.id || null, text: String(o.text || "").slice(0, 300) })),
  }));
  // answers only reference options that exist (as the client writes them)
  const answers = mode === "none" ? null : Object.fromEntries(raw.map((q) => [q.id, (((d.quizKey && d.quizKey.answers) || {})[q.id] || []).filter((o) => (q.options || []).some((op) => op.id === o))]));
  return { mode, questions, answers };
}
const lessonName = (l, i) => (String(l.title || "").trim() ? `“${String(l.title).trim()}”` : `Item ${i + 1}`);
/* Problems that make a lesson unpublishable: { lessonId, kind, message }.
   Same rules (and wording) as publishIssues in src/academyProgress.js. */
function publishContentIssues(ordered) {
  const out = [];
  ordered.forEach((l, i) => {
    const name = lessonName(l, i);
    const kind = publishedKind(l);
    if (kind === "video" && !l.video) out.push({ lessonId: l.id, kind: "video", message: `${name} needs a video link.` });
    else if (l.video && !validVideoRecord(l.video)) out.push({ lessonId: l.id, kind: "video", message: `${name} has a video link that isn't a supported YouTube, Vimeo or Google Drive link.` });
    const mode = (l.quiz && l.quiz.mode) || "none";
    if (!["none", "practice", "required"].includes(mode)) { out.push({ lessonId: l.id, kind: "quiz", message: `The quiz in ${name} has an unknown setting.` }); return; }
    if (quizMode(l) === "none") return;
    const { answers } = publishedQuiz(l);
    for (const [k, q] of ((l.quiz && l.quiz.questions) || []).entries()) {
      const where = `Question ${k + 1} in ${name}`;
      if (!q.id) { out.push({ lessonId: l.id, kind: "quiz", message: `${where} is damaged. Delete it and add it again.` }); break; }
      if (!String(q.prompt || "").trim()) { out.push({ lessonId: l.id, kind: "quiz", message: `${where} has no question text.` }); break; }
      if ((q.options || []).length < 2) { out.push({ lessonId: l.id, kind: "quiz", message: `${where} needs at least two answer options.` }); break; }
      const n = (answers[q.id] || []).length;
      if (n === 0) { out.push({ lessonId: l.id, kind: "quiz", message: `${where} has no correct answer marked.` }); break; }
      if (q.multi !== true && n !== 1) { out.push({ lessonId: l.id, kind: "quiz", message: `${where} allows one correct answer but has ${n} marked.` }); break; }
    }
  });
  return out;
}
/* The record the rules compare published writes against (editor-only doc). */
function publishRecord(ordered) {
  const lessonChecks = {}, answerKeys = {};
  for (const l of ordered) {
    const q = publishedQuiz(l);
    lessonChecks[l.id] = { kind: publishedKind(l), video: publishedVideo(l), mode: q.mode, questions: q.questions };
    if (q.answers) answerKeys[l.id] = q.answers;
  }
  return { lessonChecks, answerKeys };
}

module.exports = {
  attemptStatusRows,
  completeLessonDecision, finishDecision, quizMode, isRequired, orderedLessons, lessonCompleted, lessonAccess, readyToFinish,
  completionPrecondition, courseAccessPrecondition, prerequisiteStatus, prerequisiteMapOf, normalizeModules, validatePrerequisites, dependentsOf, lockedMessage, BROKEN_MESSAGE,
  legacyCompleted, progressStamp, attemptAllowance, TRACKED_PROVIDERS, MAX_PREREQUISITES, PROGRESS_MODEL,
  validVideoRecord, publishContentIssues, publishRecord, publishedQuiz,
};
