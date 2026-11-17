/* IFC Creative Academy — course completion: what's left, and what to do next
   (pure, unit-tested). Completion itself is the established rule
   (courseProgress().completed): every REQUIRED lesson complete, required quizzes
   passed (server-earned); bonus/optional items never block it. Reaching the last
   item in the curriculum is NOT completion. */
import { flatLessons, isRequiredLesson, lessonState, estimateProgress, canViewContent, categoryIn, normalizeCategory } from "./academyProgress.js";
import { orderCourses } from "./academyOrder.js";
import { recommendations } from "./academyRecommend.js";

/* The first outstanding required lesson, in curriculum order (null when none). */
export function remainingRequirement(course, lessons, progress, currentLessonId = null) {
  const all = flatLessons(course, lessons);
  const left = all.filter((l) => isRequiredLesson(l) && !lessonState(l, progress).completed);
  if (!left.length) return null;
  // prefer one AFTER the current lesson, then wrap to earlier ones
  const idx = all.findIndex((l) => l.id === currentLessonId);
  const after = left.find((l) => all.indexOf(l) > idx);
  const lesson = after || left[0];
  const st = lessonState(lesson, progress);
  return { lesson, count: left.length, isCurrent: lesson.id === currentLessonId, needsQuiz: st.quizRequired && !st.earned };
}

/* The learning path the learner EXPLICITLY came from (?path=<id> on the
   course/lesson URL), if it's still valid: it exists in the paths this learner
   can see, they're allowed to view it, and it actually contains this course (as
   a course step or a lesson step). Anything else → null, and completion falls
   back to the next course / recommendations. Started paths are never used to
   GUESS the journey: a direct lesson visit has no path context. */
export function pathContextFor({ pathId, paths = [], courseId, me, hidden = [] }) {
  if (!pathId || !courseId) return null;
  const p = paths.find((x) => x.id === pathId);
  if (!p || !canViewContent(me, p, hidden)) return null;
  const contains = (p.items || []).some((it) => (it.type === "course" || it.type === "lesson") && it.courseId === courseId);
  return contains ? p : null;
}

/* The next course to suggest after finishing `current`:
     1. the next published, accessible, not-completed course in the SAME
        category, in the category's configured order (wrapping round);
     2. else the existing recommendation logic (excluding the same set);
     3. else null — the caller shows navigation only. */
export function nextCourseSuggestion({ me, current, courses = [], categories = [], progressByCourse = {} }) {
  const catOk = (c) => { const k = categoryIn(categories, c.category); return !!k && !k.hidden; };
  const eligible = (c) => c.id !== current.id && c.status === "published" && canViewContent(me, c) && catOk(c)
    && !estimateProgress(c, progressByCourse[c.id]).completed && !(progressByCourse[c.id] && progressByCourse[c.id].finishedAt);
  const catId = normalizeCategory(current.category);
  const cat = categoryIn(categories, catId);
  const inCat = orderCourses(courses.filter((c) => c.status === "published" && normalizeCategory(c.category) === catId || c.id === current.id), (cat && cat.courseOrder) || []);
  const i = inCat.findIndex((c) => c.id === current.id);
  const rotated = i < 0 ? inCat : [...inCat.slice(i + 1), ...inCat.slice(0, i)];
  const sameCat = rotated.find(eligible);
  if (sameCat) return { course: sameCat, reason: `Next in ${cat ? cat.label : "this category"}` };
  const recs = recommendations({ me, courses: courses.filter(eligible), progressByCourse, categories, max: 3 })
    .filter((r) => r.course && eligible(r.course) && r.kind !== "review");
  if (recs[0]) return { course: recs[0].course, reason: recs[0].reason === "Explore" ? "Another course to explore" : recs[0].reason, lessonId: recs[0].lessonId || null };
  return null;
}

/* Celebration bookkeeping: celebrate a completion we SAW happen (not one that
   was already true when the page loaded), and only once per learner+course
   (a per-device mark survives refresh; other devices load it as "already
   complete", so they never replay it). */
export const celebratedKey = (uid, courseId) => `ac-course-celebrated:${uid}:${courseId}`;
export function readCelebrated(uid, courseId) { try { return localStorage.getItem(celebratedKey(uid, courseId)) === "1"; } catch { return false; } }
export function markCelebrated(uid, courseId) { try { localStorage.setItem(celebratedKey(uid, courseId), "1"); } catch { /* private mode */ } }
