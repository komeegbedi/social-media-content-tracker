/* IFC Creative Academy — course DRAFT / PUBLISHED revision model (pure).

   Live (learner-visible) data is unchanged and stays where learners, progress,
   comments, quiz attempts and learning paths already point:
     courses/{cid}                    published course
     courses/{cid}/lessons/{lid}      published lessons (stable ids)
     courses/{cid}/quizKeys/{lid}     answer keys (editors only)

   Authors work on a private working copy (Academy editors only):
     courseDrafts/{cid}               course fields + module order + rev counters
     courseDrafts/{cid}/lessons/{lid} lesson fields + `quizKey` (answers)

   • Every draft save increments `rev` (rules enforce +1, so a stale editor's
     write is rejected → concurrent edits are detected, never silently lost).
   • `publishedRev` = the `rev` that was last published (0 = never published).
     rev > publishedRev ⇒ "Unpublished changes".
   • Publish copies draft → live in one transaction keyed by the same lesson ids,
     so progress / comments / attempts / path references are untouched. Lessons
     removed in the draft are removed from live (with their discussion).
   • A course with no draft simply has draft == live; the first edit creates the
     draft from live (lazily — opening the editor writes nothing). */
import { courseCounters, flatLessons, toMs } from "./academyProgress.js";

export const DRAFT_COURSE_FIELDS = [
  "title", "category", "level", "about", "outcomes", "requirements", "cover", "previewVideo", "topicIds", "topics", "modules", "mdVersion",
];
export const DRAFT_LESSON_FIELDS = [
  "title", "moduleId", "kind", "video", "videoMeta", "thumbMode", "description", "resources", "thumb", "bonus", "durationMinutes", "quiz", "createdAtMs", "mdVersion",
];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && obj[k] !== undefined).map((k) => [k, obj[k]]));

/* A blank course for the "new course" screen (nothing is persisted until the
   author makes a meaningful change — see isMeaningfulCourse). */
// New text is authored in Markdown format version 2 (escapes); existing records
// without `mdVersion` stay version 1 (legacy rules) until edited visually.
export const blankCourse = (category = "") => ({ mdVersion: 2, title: "", category, level: "beginner", about: "", outcomes: [], requirements: [], cover: null, previewVideo: null, topicIds: [], topics: [], modules: [{ id: "m1", title: "", lessonIds: [] }] });
export const isMeaningfulCourse = (course, lessons) =>
  !!(String(course.title || "").trim() || course.cover || String(course.about || "").trim() || Object.keys(lessons || {}).length);

/* Working copy from the live docs (first edit of a published/legacy course). */
export function draftFromLive(liveCourse, liveLessons, quizKeys = {}) {
  const fields = pick(liveCourse || {}, DRAFT_COURSE_FIELDS);
  const lessons = {};
  for (const l of liveLessons || []) lessons[l.id] = { ...pick(l, DRAFT_LESSON_FIELDS), quizKey: quizKeys[l.id] || { answers: {}, explanations: {} } };
  // The new-course template is v2; a LIVE course keeps whatever format it has
  // (none = legacy v1), or its text would be re-read under different rules.
  const { mdVersion: _templateVersion, ...base } = blankCourse(liveCourse?.category || "");
  const course = { ...base, ...fields, modules: Array.isArray(fields.modules) ? fields.modules : [] };
  return { course: normalizeOutline(course, lessons), lessons };
}

/* Make the editable outline show EVERY lesson, in exactly the order learners
   get (orderedCurriculum): lessons that no section lists (legacy courses, or
   docs written outside the outline) are appended the same way the learner
   view appends them. Without this, such lessons would be invisible in the
   workspace and dropped from the published course on the next publish. */
export function normalizeOutline(course, lessons) {
  const have = lessons || {};
  const seen = new Set();
  const mods = (Array.isArray(course?.modules) ? course.modules : []).map((m) => ({
    ...m, title: m.title || "", lessonIds: (m.lessonIds || []).filter((id) => have[id] && !seen.has(id) && seen.add(id)),
  }));
  const rest = Object.keys(have).filter((id) => !seen.has(id)).sort((a, b) => (have[a].createdAtMs || 0) - (have[b].createdAtMs || 0));
  if (!rest.length) return { ...course, modules: mods.length ? mods : [{ id: "m1", title: "", lessonIds: [] }] };
  if (!mods.length) return { ...course, modules: [{ id: "m1", title: "", lessonIds: rest }] };
  let id = "more"; for (let i = 2; mods.some((m) => m.id === id); i++) id = "more" + i;
  return { ...course, modules: [...mods, { id, title: "More lessons", lessonIds: rest }] };
}

export const hasUnpublishedChanges = (head) => !!head && Number(head.rev || 0) > Number(head.publishedRev || 0);

/* Image references (app-owned uploads) — used so clean-up never deletes an
   image still referenced by EITHER the draft or the published version. */
export function imagePathsOf(course, lessons) {
  const out = new Set();
  if (course?.cover?.path) out.add(course.cover.path);
  for (const l of Object.values(lessons || {})) if (l?.thumb?.path) out.add(l.thumb.path);
  return out;
}
/* After a draft save, which replaced uploads can go: not in the draft any more
   and not referenced by the published version. */
export function deletableAfterDraftSave(candidates, { draftPaths, livePaths }, courseId = null) {
  return [...new Set(candidates)].filter((p) => p && !draftPaths.has(p) && !livePaths.has(p) && (courseId == null || ownedByCourse(p, courseId)));
}
/* Only images in a course's OWN upload folders are ever deleted on its behalf
   (delete, publish, discard, draft clean-up) — a reference to anything else
   (copied data, imports, another course's file) is left alone. */
export const ownedByCourse = (path, courseId) => !!path && !!courseId &&
  (String(path).startsWith(`academy/covers/${courseId}/`) || String(path).startsWith(`academy/lessonThumbs/${courseId}/`));

/* Split a draft lesson into the live lesson doc + its answer key. */
export function splitLessonForLive(draftLesson) {
  const { quizKey, ...rest } = draftLesson || {};
  const mode = rest.quiz?.mode || "none";
  const questions = mode === "none" ? [] : (rest.quiz?.questions || []);
  const live = { ...rest, quiz: { mode, passMark: rest.quiz?.passMark ?? 70, retryLimit: rest.quiz?.retryLimit ?? 0, questions } };
  const key = mode === "none" ? null : {
    answers: Object.fromEntries(questions.map((q) => [q.id, ((quizKey?.answers || {})[q.id] || []).filter((o) => (q.options || []).some((op) => op.id === o))])),
    explanations: Object.fromEntries(questions.filter((q) => (quizKey?.explanations || {})[q.id]).map((q) => [q.id, String(quizKey.explanations[q.id]).slice(0, 2000)])),
  };
  return { live, key };
}

/* Everything publish must do, computed up front (pure, unit-tested):
   lesson upserts (same ids), live lessons to remove, the course record, and
   images that are no longer referenced by the new published version or the
   draft (they're deleted only AFTER the publish transaction commits). */
export function buildPublishPlan({ draftCourse, draftLessons, liveCourse, liveLessons, courseId = null }) {
  const ordered = flatLessons(draftCourse, Object.entries(draftLessons || {}).map(([id, l]) => ({ id, ...l })));
  const upserts = ordered.map((l) => { const { id, ...rest } = l; return { id, ...splitLessonForLive(rest) }; });
  const keep = new Set(upserts.map((u) => u.id));
  const removes = (liveLessons || []).map((l) => l.id).filter((id) => !keep.has(id));
  const counters = courseCounters(draftCourse, ordered);
  const course = { ...pick(draftCourse, DRAFT_COURSE_FIELDS), ...counters, status: "published" };
  const oldLive = imagePathsOf(liveCourse, Object.fromEntries((liveLessons || []).map((l) => [l.id, l])));
  const newLive = imagePathsOf(draftCourse, draftLessons);
  const imagesToDelete = [...oldLive].filter((p) => !newLive.has(p) && (courseId == null || ownedByCourse(p, courseId)));
  return { upserts, removes, course, imagesToDelete, firstPublish: !liveCourse || !toMs(liveCourse.publishedAt) };
}

/* Course runtime from MEASURED video durations only (never fabricated).
   Reading / exercise estimates are kept separate. */
export function courseRuntime(lessons) {
  let videoSec = 0, videos = 0, measured = 0, live = 0, otherMin = 0;
  for (const l of lessons || []) {
    if (l.video) {
      videos += 1;
      const d = Number(l.videoMeta?.durationSec);
      if (l.videoMeta?.isLive) live += 1;
      else if (d > 0) { videoSec += d; measured += 1; }
    } else if (Number(l.durationMinutes) > 0) otherMin += Number(l.durationMinutes);
  }
  return { videoSec, videos, measured, live, partial: measured < videos - live, otherMin };
}
export function formatRuntime(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return m ? `${m} min` : `${s} s`;
}
export const formatClock = (sec) => {
  const s = Math.round(Number(sec) || 0);
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
};
