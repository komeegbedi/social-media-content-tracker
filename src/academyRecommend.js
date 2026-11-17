/* IFC Creative Academy — home-screen selection logic (pure, deterministic).

   No AI, no external tracking: everything here is computed from data the app
   already records — the learner's own progress docs, their team department(s),
   and published content. Every suggestion carries an honest `reason` string
   the UI shows verbatim. Nothing here implies a skill or qualification.

   Inputs are the lists the home screen already holds (published courses the
   learner can see, their progress map) plus — for "continue" rows — the single
   lesson doc that the course's module order says comes next. */
import {
  canViewContent, normalizeCategory, estimateProgress, nextLessonIdFromModules,
  DEPARTMENT_CATEGORY, INTRO_CATEGORY_ID, ONBOARDING_SEQUENCE, toMs, mergeCategories, categoryIn,
} from "./academyProgress.js";

/* Which lesson docs the home screen must fetch to describe "continue" rows:
   one per started, unfinished course (most recent first, bounded). */
export function continueTargets(courses, progressByCourse, limit = 3) {
  return (courses || [])
    .filter((c) => c.status === "published" && progressByCourse[c.id] && (progressByCourse[c.id].startedAt || progressByCourse[c.id].lastLessonId))
    .map((c) => ({ course: c, progress: progressByCourse[c.id], summary: estimateProgress(c, progressByCourse[c.id]), lastViewedMs: toMs(progressByCourse[c.id].lastViewedAt) }))
    // finished courses drop out; "ready to finish" ones (all required lessons
    // done, Finish course not pressed yet) stay so the learner can finish them
    // (a legacy completion — all done, never touched by a v6.5 server write — is finished too)
    .filter((e) => !e.progress.finishedAt && !(e.summary.completed && !e.progress.progressModel))
    .map((e) => ({ ...e, ready: e.summary.completed }))
    .sort((a, b) => b.lastViewedMs - a.lastViewedMs)
    .slice(0, limit)
    .map((e) => ({ ...e, nextLessonId: nextLessonIdFromModules(e.course, e.progress) }));
}

/* The learner's departments → categories (de-duplicated, known ones only). */
export function departmentCategories(me) {
  const deps = Array.isArray(me?.departments) ? me.departments : me?.department ? [me.department] : [];
  return [...new Set(deps.map((d) => DEPARTMENT_CATEGORY[d]).filter(Boolean))];
}
const levelRank = { beginner: 0, intermediate: 1, advanced: 2 };
const byLevelThenNewest = (a, b) => (levelRank[a.level] ?? 1) - (levelRank[b.level] ?? 1) || toMs(b.publishedAt) - toMs(a.publishedAt);

/* recommendations({ me, courses, progressByCourse, lessonsById, max })
     -> [{ kind: "continue"|"course", course, lesson?, reason, summary? }]
   Rules, in order, until `max` (2–4) is reached, never repeating a course:
     1. Continue — the next unfinished lesson of each started course
        ("Continue learning" / "Because you started <course>").
     2. Department — beginner-first published courses in the learner's team
        category that they haven't started ("For the <team> team").
     3. New-learner fallback — not-started courses from the onboarding
        categories, beginner first ("Recommended for new members").
     4. Neutral fallback — any other not-started published course, beginner
        first ("Popular with the team" is NOT claimed; reason is "Explore").
   Completed courses are only offered when nothing else exists, labelled "Review". */
export function recommendations({ me, courses = [], progressByCourse = {}, lessonsById = {}, max = 4, categories = mergeCategories([]) }) {
  const out = [];
  const used = new Set();
  // Learner-visible only: published, and filed under a category that exists and isn't hidden.
  const visible = courses.filter((c) => c.status === "published" && canViewContent(me, c) && !!categoryIn(categories, c.category) && !categoryIn(categories, c.category).hidden);
  const nameOf = (id) => (categoryIn(categories, id) || {}).label || "";
  const push = (rec) => { if (out.length < max && !used.has(rec.course.id)) { used.add(rec.course.id); out.push(rec); } };

  for (const e of continueTargets(visible, progressByCourse)) {
    const lesson = e.nextLessonId ? lessonsById[`${e.course.id}/${e.nextLessonId}`] || null : null;
    const first = !e.progress.lastLessonId;
    push({ kind: "continue", course: e.course, lesson: e.ready ? null : lesson, lessonId: e.ready ? null : e.nextLessonId, summary: e.summary, ready: e.ready,
      reason: e.ready ? "Ready to finish" : first ? `Because you started ${e.course.title}` : "Continue learning" });
  }
  const notStarted = (c) => !progressByCourse[c.id] || !(progressByCourse[c.id].startedAt || progressByCourse[c.id].lastLessonId);
  for (const catId of departmentCategories(me)) {
    if (!categoryIn(categories, catId) || categoryIn(categories, catId).hidden) continue;
    for (const c of visible.filter((x) => normalizeCategory(x.category) === catId && notStarted(x)).sort(byLevelThenNewest))
      push({ kind: "course", course: c, reason: `For the ${nameOf(catId).toLowerCase()} team` });
  }
  if (out.length < Math.min(2, max)) {
    for (const catId of ONBOARDING_SEQUENCE) {
      for (const c of visible.filter((x) => normalizeCategory(x.category) === catId && notStarted(x)).sort(byLevelThenNewest))
        push({ kind: "course", course: c, reason: catId === INTRO_CATEGORY_ID ? "Recommended for new members" : `Start with ${nameOf(catId)}` });
    }
  }
  if (out.length < Math.min(2, max)) {
    for (const c of visible.filter(notStarted).sort(byLevelThenNewest)) push({ kind: "course", course: c, reason: "Explore" });
  }
  if (out.length === 0) {
    for (const c of visible.filter((x) => estimateProgress(x, progressByCourse[x.id]).completed).sort((a, b) => toMs(progressByCourse[b.id]?.lastViewedAt) - toMs(progressByCourse[a.id]?.lastViewedAt)))
      push({ kind: "review", course: c, reason: "Completed · review any time" });
  }
  return out.slice(0, max);
}

/* Recently published courses + quick guides (publication date, NOT updatedAt),
   visible to this learner, newest first. Lessons are deliberately not scanned
   here (that would load every curriculum); a course republished after edits
   keeps its original publishedAt. */
export function recentlyPublished({ me, courses = [], guides = [], limit = 6, now = Date.now(), maxAgeDays = 0, hidden = [] }) {
  const items = [...courses.map((c) => ({ ...c, format: "course" })), ...guides.map((g) => ({ ...g, format: "guide" }))]
    .filter((x) => x.status === "published" && x.publishedAt && canViewContent(me, x) && !hidden.includes(normalizeCategory(x.category)))
    .map((x) => ({ item: x, publishedMs: toMs(x.publishedAt) }))
    .filter((x) => x.publishedMs > 0 && (!maxAgeDays || now - x.publishedMs <= maxAgeDays * 86400000))
    .sort((a, b) => b.publishedMs - a.publishedMs);
  return items.slice(0, limit);
}

/* Published-course counts per category for the five+1 cards — computed from the
   courses THIS learner can see (drafts a non-editor can't read never arrive). */
export function categoryCounts(me, courses = [], hidden = []) {
  const counts = {};
  for (const c of courses) {
    if (c.status !== "published" || !canViewContent(me, c) || hidden.includes(normalizeCategory(c.category))) continue;
    const id = normalizeCategory(c.category);
    counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}
