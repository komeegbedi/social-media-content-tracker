/* IFC Creative Academy — domain logic for courses, lessons, progress and quiz
   completion (pure, DOM/Firebase-free; mirrored by functions/academyScoring.js
   for the server side). Everything here is (data) -> value.

   ---- Data model (Firestore) ------------------------------------------------
   courses/{courseId}
     title, category, level, status: draft|published|archived, instructorUid,
     instructorName, about (markdown), outcomes[], requirements[], durationMinutes,
     cover {path, version, contentType, bytes, w, h} | null,
     modules: [{ id, title, lessonIds: [] }]        ← ORDER lives here
     lessonCount, requiredLessonCount (denormalised by the editor on save)
   courses/{courseId}/lessons/{lessonId}
     title, moduleId, video {provider,id,hash?} | null, description (markdown),
     resources: [{label,url}], thumb ref | null, bonus: bool, durationMinutes,
     quiz: { mode: none|practice|required, passMark, retryLimit, questions: [
       { id, prompt, multi, options: [{id,text}] } ] }      ← NO answers here
   courses/{courseId}/quizKeys/{lessonId}
     answers: { [qId]: [optionId] }, explanations: { [qId]: text }   ← editors only
   learnerProgress/{uid}/courseProgress/{courseId}
     uid, courseId, startedAt, lastLessonId, lastViewedAt, updatedAt,
     lessons: { [lessonId]: { positionSec, durationSec, videoWatched, videoWatchedAt,
                               manualDone, manualDoneAt, viewedAt } }   ← learner-writable
     earned: { [lessonId]: { at, attemptId, percent } }                 ← SERVER-ONLY
   quizAttempts/{uid}/attempts/{attemptId}                              ← SERVER-ONLY
     uid, courseId, lessonId, answers, score, total, percent, passed, passMark,
     mode, results[], createdAt

   ---- Completion rules (also in docs/academy.md) ------------------------------
   • A lesson whose quiz mode is REQUIRED is complete only when the learner has a
     PASSED attempt — recorded by the server in progress.earned[lessonId]. Watching
     the video is shown separately ("Video watched · Quiz required") and never
     completes the lesson on its own.
   • A lesson with NO quiz or a PRACTICE quiz is complete when the video was watched
     to the end (provider ENDED event, where the provider reports it) OR the learner
     explicitly marked it done. Opening or seeking a video never counts.
   • Course progress = completed REQUIRED lessons ÷ all required lessons. Lessons
     flagged `bonus` are excluded from both numbers.
   • Earned completions are keyed by lessonId, so editing a lesson (even its quiz)
     keeps what the learner already earned. New lessons simply appear as upcoming;
     the percentage is recomputed against the current curriculum.
   • Completing a course is a learning milestone, not approval to serve. */

/* ---- categories: THE source of truth ----------------------------------------
   Six learning categories (ids are stored on courses, guides and paths; labels,
   purposes and suggested topics are only ever read from here — never hard-coded
   in components, rules tests or fixtures). `intro` marks the category that gets
   the "Start here" treatment on the Learn home; `onboarding` is the recommended
   (not enforced) order. Topics are suggestions for the free-form topic tags. */
export const ACADEMY_CATEGORIES = [
  { id: "heart-of-serving", label: "The Heart of Serving", short: "Heart of Serving", intro: true,
    purpose: "Help everyone understand why the team exists and how to serve people well.",
    topics: ["Why we serve", "Ministry through creativity", "Teamwork and preparation", "Receiving feedback", "Representing people thoughtfully"] },
  { id: "photography", label: "Photography",
    purpose: "Teach people to capture meaningful moments and deliver consistent, usable photographs.",
    topics: ["Digital camera and phone photography", "Exposure, composition, and lighting", "Service and event coverage", "Selecting and editing photographs", "Exporting and delivering images"] },
  { id: "filmmaking", label: "Filmmaking",
    purpose: "Develop the skills to tell stories through moving images, from a short Reel to a testimony video.",
    topics: ["Digital cameras and exposure", "Cinematography, lighting, framing, and movement", "Sound and interviews", "Storyboarding and shot planning", "Video editing and colour grading", "Short-form video production"] },
  { id: "graphic-design", label: "Graphic Design",
    purpose: "Help the team communicate clearly and build a recognizable visual identity for IFC.",
    topics: ["Layout, typography, and colour", "Brand consistency", "Event artwork", "Carousels and thumbnails", "Adapting designs for different placements"] },
  { id: "social-media-storytelling", label: "Social Media & Storytelling", short: "Social & Storytelling",
    purpose: "Help the team decide what to communicate, who it serves, and how to publish it effectively.",
    topics: ["Content ideas and audience needs", "Content planning and storytelling", "Captions and hooks", "Choosing formats", "Testing posting times for our audience", "Community engagement", "Understanding results and improving future content"] },
  { id: "creating-together", label: "Creating Together",
    purpose: "Teach the practical process that turns an idea into approved, published content.",
    topics: ["Understanding briefs and taking ownership", "Coordinating shoots", "Organizing files and handing work over", "Quality checks, revisions, and approvals", "Using IFC Creatives Board"] },
];
/* v4: categories are EDITABLE RECORDS (academyCategories/{id}); the list above
   is only the bootstrap set the admin can create with one click (and what the
   app renders before any record exists). Stable ids never change on rename.
   `mergeCategories(records)` is what every screen uses. */
export const INTRO_CATEGORY_ID = "heart-of-serving";          // featured by STABLE id
export const slugId = (name) => String(name || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "category";
export const nameKey = (name) => String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
/* records: [{ id, name, description, order, hidden, cover }] from Firestore.
   With NO records (fresh project) the bootstrap defaults render; once any record
   exists the records are authoritative (a deleted default stays deleted). */
export function mergeCategories(records) {
  if (!records || !records.length) {
    return ACADEMY_CATEGORIES.map((c, i) => ({ id: c.id, name: c.label, label: c.label, short: c.short || c.label, description: c.purpose, purpose: c.purpose, topics: c.topics, order: i, hidden: false, cover: null, intro: c.id === INTRO_CATEGORY_ID, bootstrap: true }));
  }
  return [...records].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.name).localeCompare(String(b.name))).map((r) => {
    const def = ACADEMY_CATEGORIES.find((c) => c.id === r.id);
    return { ...r, label: r.name, short: r.short || (def && def.short) || r.name, purpose: r.description || "", description: r.description || "", topics: (def && def.topics) || [], hidden: r.hidden === true, intro: r.id === INTRO_CATEGORY_ID };
  });
}
export const visibleCategories = (list) => list.filter((c) => !c.hidden);
export const categoryIn = (list, id) => list.find((c) => c.id === normalizeCategory(id)) || null;
export const categoryNameIn = (list, id) => (categoryIn(list, id) || {}).label || categoryLabel(id);
export const categoryShortIn = (list, id) => { const c = categoryIn(list, id); return c ? (c.short || c.label) : categoryShort(id); };
export const defaultCategoryRecords = () => ACADEMY_CATEGORIES.map((c, i) => ({ id: c.id, name: c.label, short: c.short || c.label, description: c.purpose, order: i, hidden: false, cover: null }));

/* Topics are records too (academyTopics/{id}, id = slug at creation, name
   editable). Content carries `topicIds` (new) and may still carry legacy free-text
   `topics` (strings) until an editor re-saves it. */
export const topicNamesFor = (item, topicsById) => {
  const out = []; const seen = new Set();
  for (const id of item?.topicIds || []) { const t = topicsById[id]; if (t && !t.hidden && !seen.has(id)) { seen.add(id); out.push(t.name); } }
  for (const raw of item?.topics || []) { const k = nameKey(raw); if (!out.some((n) => nameKey(n) === k)) { const rec = Object.values(topicsById).find((t) => nameKey(t.name) === k); if (!rec) out.push(raw); else if (!rec.hidden && !seen.has(rec.id)) { seen.add(rec.id); out.push(rec.name); } } }
  return out;
};
/* Topic chips for display: [{ id?, name }] — record topics link to the topic
   filter by id; unmatched legacy strings fall back to a text search. Hidden
   topics are omitted (their association is kept on the item). */
export function topicChips(item, topicsById) {
  const out = []; const seen = new Set();
  for (const id of item?.topicIds || []) { const t = topicsById[id]; if (t && !t.hidden && !seen.has(id)) { seen.add(id); out.push({ id, name: t.name }); } }
  for (const raw of item?.topics || []) {
    const k = nameKey(raw);
    const rec = Object.values(topicsById).find((t) => nameKey(t.name) === k);
    if (rec) { if (!rec.hidden && !seen.has(rec.id)) { seen.add(rec.id); out.push({ id: rec.id, name: rec.name }); } }
    else if (!out.some((c) => nameKey(c.name) === k)) out.push({ id: null, name: raw });
  }
  return out;
}
/* Does an item carry this topic (by id, or by a legacy string matching its name)? */
export const hasTopic = (item, topic) => !!topic && ((item?.topicIds || []).includes(topic.id) || (item?.topics || []).some((t) => nameKey(t) === nameKey(topic.name)));

/* Map legacy free-text topics onto records by name (case/space-insensitive). */
export const matchTopicIds = (names, topicsById) => [...new Set((names || []).map((n) => Object.values(topicsById).find((t) => nameKey(t.name) === nameKey(n))?.id).filter(Boolean))];

/* Legacy ids from the first Academy build. Stored docs may still carry them:
   READS normalise (so nothing breaks), the editor writes the new id on the next
   save, and firestore.rules accepts both until a one-off migration is run.
   See docs/academy.md → "Category migration". */
export const LEGACY_CATEGORY_IDS = {
  videography: "filmmaking",
  "social-media": "social-media-storytelling",
};
export const ALL_CATEGORY_IDS = [...ACADEMY_CATEGORIES.map((c) => c.id), ...Object.keys(LEGACY_CATEGORY_IDS)];
export const normalizeCategory = (id) => LEGACY_CATEGORY_IDS[id] || id;
export const categoryById = (id) => ACADEMY_CATEGORIES.find((c) => c.id === normalizeCategory(id)) || null;
export const categoryLabel = (id) => (categoryById(id) || {}).label || "Uncategorised";
export const categoryShort = (id) => { const c = categoryById(id); return c ? (c.short || c.label) : "Uncategorised"; };
export const INTRO_CATEGORY = ACADEMY_CATEGORIES.find((c) => c.intro);
export const PRACTICAL_CATEGORIES = ACADEMY_CATEGORIES.filter((c) => !c.intro);
/* Recommended onboarding — guidance only, never a lock. */
export const ONBOARDING_SEQUENCE = ["heart-of-serving", "creating-together"];

/* Content formats. Courses are ordered curricula; quick guides are standalone
   help; learning paths are ordered references to existing content. */
export const CONTENT_FORMATS = [
  { id: "course", label: "Course", plural: "Courses" },
  { id: "guide",  label: "Quick guide", plural: "Quick guides" },
  { id: "path",   label: "Learning path", plural: "Learning paths" },
];
export const formatLabel = (id) => (CONTENT_FORMATS.find((f) => f.id === id) || {}).label || "";

/* Topic tags: free text, trimmed, de-duplicated (case-insensitive), bounded. */
export function normalizeTopics(list, max = 12) {
  const out = []; const seen = new Set();
  for (const raw of Array.isArray(list) ? list : String(list || "").split(/[\n,]/)) {
    const t = String(raw || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/* Curriculum item kinds. `kind` is stored on the lesson; older lessons have none
   and are read as video (if linked) or written. How each contributes to course
   completion (see lessonState): video → watched to the end or marked done;
   written / exercise / resource → the learner's explicit self-report ("Mark as
   read / complete / reviewed"); a REQUIRED quiz always overrides. None of these
   self-reports is an assessment of competence, and the UI says so. */
export const LESSON_KINDS = [
  { id: "video",    label: "Video lesson", doneLabel: "Mark lesson as done",    doneVerb: "watched" },
  { id: "written",  label: "Written lesson", doneLabel: "Mark as read",        doneVerb: "read" },
  { id: "exercise", label: "Exercise",     doneLabel: "Mark exercise complete", doneVerb: "completed" },
  { id: "resource", label: "Resource step", doneLabel: "Mark as reviewed",      doneVerb: "reviewed" },
];
export const lessonKind = (lesson) => {
  const k = lesson && lesson.kind;
  if (LESSON_KINDS.some((x) => x.id === k)) return k;
  return lesson && lesson.video ? "video" : "written";
};
export const lessonKindMeta = (lesson) => LESSON_KINDS.find((x) => x.id === lessonKind(lesson)) || LESSON_KINDS[0];

/* Team departments (src/data.js DEPARTMENTS + QA) → the Academy category that
   serves them. Used only for "For the … team" recommendations. */
export const DEPARTMENT_CATEGORY = {
  "Photography": "photography",
  "Videography": "filmmaking",
  "Graphic Design": "graphic-design",
  "Content Creation": "social-media-storytelling",
  "QA": "creating-together",
};

export const ACADEMY_LEVELS = [
  { id: "beginner",     label: "Beginner" },
  { id: "intermediate", label: "Intermediate" },
  { id: "advanced",     label: "Advanced" },
];
export const COURSE_STATUSES = ["draft", "published", "archived"];
export const QUIZ_MODES = ["none", "practice", "required"];
export const DEFAULT_PASS_MARK = 70;

export const levelLabel = (id) => (ACADEMY_LEVELS.find((l) => l.id === id) || {}).label || "";

/* ---- roles ------------------------------------------------------------------
   editor  = admin, or the course's instructor (an approved member the admin named)
   leader  = admin, or a department lead (`lead: true`) — may view learner progress */
export const isAcademyAdmin = (me) => !!me && me.role === "admin" && me.disabled !== true;
export const isApprovedLearner = (me) => !!me && me.disabled !== true && (me.status === "approved" || me.role === "admin");
/* v4 editor scope: Academy editors are a GLOBAL role — admins, plus approved
   members an admin flags `academyEditor: true`. There is no per-course owner or
   instructor any more (courses curate videos from many external creators). The
   old `instructorUid` field is ignored for permissions; it is kept readable only
   for historical docs. Ordinary learners never edit. */
export const isAcademyEditor = (me) => isApprovedLearner(me) && (isAcademyAdmin(me) || me.academyEditor === true);
export const canEditCourse = (me, _docu) => isAcademyEditor(me);
export const canEditContent = canEditCourse;
export const canViewLearnerProgress = (me) => isApprovedLearner(me) && (isAcademyAdmin(me) || me.lead === true);
/* A learner may only SEE published content whose category isn't hidden;
   editors also see drafts and hidden categories. `hiddenCategoryIds` is the
   denormalised list kept in academySettings/categoryIndex (rules read the same). */
export const canViewCourse = (me, docu, hiddenCategoryIds = []) =>
  !!docu && isApprovedLearner(me) && (canEditCourse(me, docu)
    || (docu.status === "published" && !(docu.category && hiddenCategoryIds.includes(normalizeCategory(docu.category)))));
export const canViewContent = canViewCourse;
/* Learner-visible filter for lists already restricted by rules (drafts never
   arrive for learners); hides courses of hidden categories for non-editors. */
export const visibleToLearner = (me, items, hiddenCategoryIds = []) => (items || []).filter((x) => canViewContent(me, x, hiddenCategoryIds));

/* ---- curriculum ordering ----------------------------------------------------
   The course's `modules` array is the only ordering source. Lessons not listed in
   any module (e.g. just created) are appended under an implicit "Lessons" module
   so nothing is ever orphaned in the UI. */
export function orderedCurriculum(course, lessons) {
  const byId = new Map((lessons || []).map((l) => [l.id, l]));
  const seen = new Set();
  const modules = [];
  for (const m of (course && Array.isArray(course.modules) ? course.modules : [])) {
    const items = [];
    for (const id of (m.lessonIds || [])) {
      const l = byId.get(id);
      if (l && !seen.has(id)) { items.push(l); seen.add(id); }
    }
    modules.push({ id: m.id, title: m.title || "", lessons: items });
  }
  const rest = (lessons || []).filter((l) => !seen.has(l.id)).sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
  if (rest.length) modules.push({ id: "__unsorted", title: modules.length ? "More lessons" : "", lessons: rest, implicit: true });
  return modules;
}
export const flatLessons = (course, lessons) => orderedCurriculum(course, lessons).flatMap((m) => m.lessons);

/* ---- completion ---------------------------------------------------------- */
export const quizMode = (lesson) => {
  const m = lesson && lesson.quiz && lesson.quiz.mode;
  return QUIZ_MODES.includes(m) && (lesson.quiz.questions || []).length ? m : "none";
};
export const isRequiredLesson = (lesson) => !!lesson && lesson.bonus !== true;

/* Per-lesson state for a learner. `progress` is the learnerProgress doc (or null). */
export function lessonState(lesson, progress) {
  const p = (progress && progress.lessons && progress.lessons[lesson.id]) || {};
  const earned = !!(progress && progress.earned && progress.earned[lesson.id]);
  const mode = quizMode(lesson);
  const videoWatched = p.videoWatched === true;
  const manualDone = p.manualDone === true;
  const hasVideo = !!lesson.video;
  let completed;
  if (mode === "required") completed = earned;
  else completed = videoWatched || manualDone || (!hasVideo && earned);
  return {
    completed, videoWatched, manualDone, earned, quizMode: mode,
    quizRequired: mode === "required",
    // What still stands between the learner and completion (for the UI copy).
    pending: completed ? null
      : mode === "required" ? (videoWatched || !hasVideo ? "quiz" : "video+quiz")
      : hasVideo ? "video" : "manual",
    kind: lessonKind(lesson),
    positionSec: Number(p.positionSec) || 0,
    durationSec: Number(p.durationSec) || 0,
    viewed: !!p.viewedAt,
  };
}

/* The next lesson id to continue with, from the course's stored module order +
   the progress doc alone (no lesson docs needed — used on the home screen so a
   recommendation never loads a whole curriculum). Completion per id follows the
   same rules as lessonState for what the progress doc can tell us: earned (quiz),
   videoWatched or manualDone. Returns null when nothing is outstanding. */
export function nextLessonIdFromModules(course, progress) {
  const ids = (course && Array.isArray(course.modules) ? course.modules : []).flatMap((m) => m.lessonIds || []);
  const bonus = new Set(course?.bonusLessonIds || []);
  const quiz = new Set(course?.requiredQuizLessonIds || []);
  const done = (id) => {
    const l = (progress?.lessons || {})[id] || {};
    if (quiz.has(id)) return !!(progress?.earned || {})[id];
    return l.videoWatched === true || l.manualDone === true || !!(progress?.earned || {})[id];
  };
  const last = progress?.lastLessonId;
  if (last && ids.includes(last) && !done(last)) return last;
  return ids.find((id) => !bonus.has(id) && !done(id)) || ids.find((id) => !done(id)) || null;
}

/* Course-level summary. Percent is over REQUIRED lessons only. */
export function courseProgress(course, lessons, progress) {
  const all = flatLessons(course, lessons);
  const required = all.filter(isRequiredLesson);
  const done = required.filter((l) => lessonState(l, progress).completed).length;
  const total = required.length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const started = !!progress && (!!progress.startedAt || !!progress.lastLessonId);
  return {
    total, done, percent,
    started,
    completed: total > 0 && done === total,
    bonusTotal: all.length - total,
    bonusDone: all.filter((l) => !isRequiredLesson(l) && lessonState(l, progress).completed).length,
  };
}

/* Where "Resume" should land: the last viewed lesson if it's still in the course
   and not complete, else the first incomplete required lesson, else the first
   lesson (for a completed course — revisit from the top). */
export function resumeLessonId(course, lessons, progress) {
  const all = flatLessons(course, lessons);
  if (!all.length) return null;
  const last = progress && progress.lastLessonId && all.find((l) => l.id === progress.lastLessonId);
  if (last && !lessonState(last, progress).completed) return last.id;
  const next = all.find((l) => !lessonState(l, progress).completed);
  if (next) return next.id;
  return all[0].id;
}

/* Previous / next around a lesson in the flattened order. */
export function lessonNeighbours(course, lessons, lessonId) {
  const all = flatLessons(course, lessons);
  const i = all.findIndex((l) => l.id === lessonId);
  return { prev: i > 0 ? all[i - 1] : null, next: i >= 0 && i < all.length - 1 ? all[i + 1] : null, index: i, count: all.length };
}

/* "Continue learning" strip on the Learn home: courses the learner has started
   and not finished, most recently viewed first. `progressByCourse` is a map of
   courseId -> progress doc; `lessonsByCourse` may be partial (percent falls back
   to the course's denormalised counts when lessons aren't loaded). */
export function continueLearning(courses, progressByCourse, lessonsByCourse = {}) {
  const out = [];
  for (const c of courses || []) {
    if (c.status !== "published") continue;
    const p = progressByCourse[c.id];
    if (!p || !(p.startedAt || p.lastLessonId)) continue;
    const lessons = lessonsByCourse[c.id];
    const summary = lessons ? courseProgress(c, lessons, p) : estimateProgress(c, p);
    if (summary.completed) continue;
    out.push({ course: c, progress: p, summary, lastViewedMs: toMs(p.lastViewedAt) });
  }
  return out.sort((a, b) => b.lastViewedMs - a.lastViewedMs);
}

/* Cheap estimate from denormalised counts + the progress doc alone (used in
   lists where loading every course's lessons would be wasteful). Required-quiz
   lessons are only countable from earned[]; the rest from lessons[].  The editor
   stores `requiredQuizLessonIds` on the course for exactly this purpose. */
export function estimateProgress(course, progress) {
  const total = Number(course.requiredLessonCount) || 0;
  if (!progress) return { total, done: 0, percent: 0, started: false, completed: false };
  const quizIds = new Set(course.requiredQuizLessonIds || []);
  const bonusIds = new Set(course.bonusLessonIds || []);
  const ids = new Set();
  for (const [id, l] of Object.entries(progress.lessons || {})) {
    if (bonusIds.has(id) || quizIds.has(id)) continue;
    if (l && (l.videoWatched === true || l.manualDone === true)) ids.add(id);
  }
  for (const id of Object.keys(progress.earned || {})) if (!bonusIds.has(id)) ids.add(id);
  const done = Math.min(total, ids.size);
  const percent = total ? Math.round((done / total) * 100) : 0;
  return { total, done, percent, started: !!(progress.startedAt || progress.lastLessonId), completed: total > 0 && done === total };
}

/* The denormalised counters the editor writes on every course save, so lists and
   leader views don't need a lessons listener per course. */
export function courseCounters(course, lessons) {
  const all = flatLessons(course, lessons);
  const required = all.filter(isRequiredLesson);
  return {
    lessonCount: all.length,
    requiredLessonCount: required.length,
    requiredQuizLessonIds: required.filter((l) => quizMode(l) === "required").map((l) => l.id),
    bonusLessonIds: all.filter((l) => !isRequiredLesson(l)).map((l) => l.id),
    durationMinutes: all.reduce((s, l) => s + (Number(l.durationMinutes) || 0), 0),
  };
}

/* ---- quiz (client side: shape + answer validation; scoring is server-only) --- */
export function validateQuizAnswers(quiz, answers) {
  const qs = (quiz && quiz.questions) || [];
  const errors = [];
  const clean = {};
  for (const q of qs) {
    const sel = [...new Set(Array.isArray(answers && answers[q.id]) ? answers[q.id].filter((o) => q.options.some((op) => op.id === o)) : [])];
    if (!sel.length) errors.push({ qId: q.id, message: "Choose an answer." });
    else if (!q.multi && sel.length > 1) errors.push({ qId: q.id, message: "Choose one answer." });
    clean[q.id] = sel;
  }
  return { ok: errors.length === 0, errors, answers: clean };
}

/* Retry policy: retryLimit 0/absent = unlimited. `attempts` = prior attempt count. */
export function canAttemptQuiz(quiz, attempts) {
  const limit = Number(quiz && quiz.retryLimit) || 0;
  if (!limit) return { ok: true, remaining: null };
  const remaining = Math.max(0, limit - (attempts || 0));
  return { ok: remaining > 0, remaining };
}

/* ---- catalogue search/filter ----------------------------------------------
   Works over any content doc that carries `format` ("course"|"guide"|"path"),
   `category` (legacy ids normalised) and optional `topics`. Category and
   format are independent filters; search covers title, author, category,
   level, topics and body text. */
export function filterCourses(items, { q = "", category = "", level = "", status = "", format = "" } = {}) {
  const needle = q.trim().toLowerCase();
  return (items || []).filter((c) => {
    if (format && (c.format || "course") !== format) return false;
    if (category && normalizeCategory(c.category) !== normalizeCategory(category)) return false;
    if (level && c.level !== level) return false;
    if (status && c.status !== status) return false;
    if (!needle) return true;
    const hay = [c.title, c.instructorName, categoryLabel(c.category), levelLabel(c.level), c.about, c.body, c.purpose,
      ...(c.topics || []), formatLabel(c.format || "course")].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(needle);
  });
}

/* ---- quick guides ------------------------------------------------------------
   A guide is standalone help: optional linked video + body, no curriculum, no
   quiz. "Reviewed" is a SELF-REPORTED flag the learner sets ("I've read / watched
   this") — it is never an assessment and the UI says so. */
export const guideReviewed = (review) => !!review && review.reviewed === true;

/* ---- learning paths ---------------------------------------------------------
   items: [{ id, type: "course"|"lesson"|"guide", courseId?, lessonId?, guideId?,
             required: bool, label?: string (editor note, e.g. "Plan the message") }]
   Paths only REFERENCE content; progress is derived from the source content's own
   progress, so finishing a lesson inside a path and finishing it from the course
   are the same fact. */
export const pathItemKey = (it) =>
  it.type === "course" ? `course:${it.courseId}`
  : it.type === "lesson" ? `lesson:${it.courseId}/${it.lessonId}`
  : it.type === "guide" ? `guide:${it.guideId}` : "";

/* Editor-side validation: well-formed refs, no duplicates, no overlap (a lesson
   whose whole course is also in the path would count twice). */
export function validatePathItems(items) {
  const errors = [];
  const keys = new Set();
  const courseIds = new Set((items || []).filter((i) => i.type === "course").map((i) => i.courseId));
  (items || []).forEach((it, idx) => {
    const n = idx + 1;
    const key = pathItemKey(it);
    if (!key || (it.type === "course" && !it.courseId) || (it.type === "lesson" && !(it.courseId && it.lessonId)) || (it.type === "guide" && !it.guideId))
      errors.push(`Item ${n} is incomplete.`);
    else if (keys.has(key)) errors.push(`Item ${n} is already in this path.`);
    else if (it.type === "lesson" && courseIds.has(it.courseId)) errors.push(`Item ${n} is a lesson of a course that's already in this path — keep one or the other.`);
    keys.add(key);
  });
  return errors;
}

/* Resolve each item against what the LEARNER can actually see.
   `ctx` = { courses: {id: courseDoc|null}, lessons: {"cid/lid": lessonDoc|null},
             guides: {id: guideDoc|null}, progressByCourse: {cid: doc},
             reviews: {gid: doc}, me }
   A missing / draft / archived / denied reference resolves to { available:false }
   with NO title from the private doc; the editor's own `label` (if any) is the
   only text shown. Unavailable items are never counted complete. */
export function resolvePathItems(path, ctx) {
  const out = [];
  for (const it of (path && path.items) || []) {
    const base = { ...it, key: pathItemKey(it), required: it.required !== false, available: false, completed: false, title: it.label || "", href: null };
    if (it.type === "course") {
      const c = ctx.courses[it.courseId];
      if (c && canViewContent(ctx.me, c, ctx.hidden || [])) {
        const s = estimateProgress(c, ctx.progressByCourse[it.courseId]);
        out.push({ ...base, available: true, completed: s.completed, started: s.started, percent: s.percent, title: it.label || c.title, subtitle: c.title, doc: c });
        continue;
      }
    } else if (it.type === "lesson") {
      const c = ctx.courses[it.courseId];
      const l = ctx.lessons[`${it.courseId}/${it.lessonId}`];
      if (c && l && canViewContent(ctx.me, c, ctx.hidden || [])) {
        const st = lessonState(l, ctx.progressByCourse[it.courseId]);
        out.push({ ...base, available: true, completed: st.completed, started: st.viewed, title: it.label || l.title, subtitle: `${l.title} · ${c.title}`, doc: l, course: c });
        continue;
      }
    } else if (it.type === "guide") {
      const g = ctx.guides[it.guideId];
      if (g && canViewContent(ctx.me, g, ctx.hidden || [])) {
        const done = guideReviewed(ctx.reviews[it.guideId]);
        out.push({ ...base, available: true, completed: done, started: done, title: it.label || g.title, subtitle: g.title, doc: g });
        continue;
      }
    }
    out.push(base);
  }
  return out;
}

/* Path progress over ALL required steps. A required step the learner can't
   reach (deleted, unpublished, archived, hidden) is never counted complete and
   BLOCKS path completion — the path completes only when every required step is
   available and done. `blocked` = everything reachable is done but something
   required is missing (the UI explains it). Optional steps are excluded. */
export function pathProgress(resolved) {
  const req = resolved.filter((i) => i.required);
  const avail = req.filter((i) => i.available);
  const done = avail.filter((i) => i.completed).length;
  const total = req.length;
  const unavailable = total - avail.length;
  const optional = resolved.filter((i) => !i.required);
  return {
    total, available: avail.length, done, unavailable, percent: total ? Math.round((done / total) * 100) : 0,
    completed: total > 0 && unavailable === 0 && done === total,
    blocked: unavailable > 0 && done === avail.length,
    optionalDone: optional.filter((i) => i.available && i.completed).length, optionalTotal: optional.length,
    started: resolved.some((i) => i.available && (i.started || i.completed)),
  };
}
/* Where "Continue" lands: the first required, available, incomplete item (then
   optional ones), else the first item. */
export function nextPathItem(resolved) {
  return resolved.find((i) => i.available && i.required && !i.completed)
    || resolved.find((i) => i.available && !i.completed)
    || resolved.find((i) => i.available) || null;
}

/* Continue-learning entries across courses AND paths, de-duplicated: when an
   in-progress path's next action IS a course that's also listed on its own, the
   path entry wins (one card per next action). */
export function continueLearningCombined({ courseEntries = [], pathEntries = [] }) {
  const covered = new Set();
  for (const p of pathEntries) {
    const n = p.next;
    if (n && n.type === "course") covered.add(`course:${n.courseId}`);
    if (n && n.type === "lesson") covered.add(`course:${n.courseId}`);
  }
  const out = [
    ...pathEntries.map((p) => ({ kind: "path", ...p })),
    ...courseEntries.filter((c) => !covered.has(`course:${c.course.id}`)).map((c) => ({ kind: "course", ...c })),
  ];
  return out.sort((a, b) => (b.lastViewedMs || 0) - (a.lastViewedMs || 0));
}

/* ---- editor-side validation (what must be true to PUBLISH) ------------------ */
/* `categoryIds`: the category RECORDS that exist (admins create categories, so
   the built-in six aren't the whole list). Omitted → the built-in list. */
export function publishBlockers(course, lessons, categoryIds = null) {
  const out = [];
  if (!String(course.title || "").trim()) out.push("Add a course title.");
  const cat = normalizeCategory(course.category || "");
  if (!cat || (categoryIds ? !categoryIds.includes(cat) : !categoryById(cat))) out.push("Choose a category.");
  if (!ACADEMY_LEVELS.some((l) => l.id === course.level)) out.push("Choose a level.");
  if (!course.cover || !course.cover.path) out.push("Upload a cover image.");
  const all = flatLessons(course, lessons);
  if (!all.length) out.push("Add at least one lesson.");
  for (const l of all) {
    if (!String(l.title || "").trim()) out.push("Every lesson needs a title.");
    const mode = quizMode(l);
    if (mode !== "none") {
      for (const q of l.quiz.questions || []) {
        if (!String(q.prompt || "").trim()) { out.push(`A question in “${l.title || "a lesson"}” has no prompt.`); break; }
        if ((q.options || []).length < 2) { out.push(`A question in “${l.title || "a lesson"}” needs at least two options.`); break; }
      }
    }
  }
  return [...new Set(out)];
}

/* Firestore Timestamp | Date | number | null → ms (0 when unknown). */
export function toMs(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return 0;
}

export const formatDuration = (minutes) => {
  const m = Math.round(Number(minutes) || 0);
  if (!m) return "";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
};

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* Guide / path publish checks (what must be true to publish). */
export function guidePublishBlockers(g) {
  const out = [];
  if (!String(g.title || "").trim()) out.push("Add a title.");
  if (!categoryById(g.category)) out.push("Choose a category.");
  if (!g.video && !String(g.body || "").trim()) out.push("Add a video link or some body text.");
  return out;
}
export function pathPublishBlockers(p) {
  const out = [];
  if (!String(p.title || "").trim()) out.push("Add a title.");
  if (!String(p.purpose || "").trim()) out.push("Describe the purpose of this path.");
  if (!(p.items || []).length) out.push("Add at least one item.");
  out.push(...validatePathItems(p.items));
  return [...new Set(out)];
}
