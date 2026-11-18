/* IFC Creative Academy — the "Learn" screen (lazy chunk).

   Three views, all driven by the URL (src/nav.js):
     /learn                                   LearnHome   — purpose video, continue
                                                            learning, catalogue
     /learn/course/:courseId                  CourseOverview
     /learn/course/:courseId/lesson/:lessonId LessonView  — player, description,
                                                            resources, quiz, discussion
   Data access lives in academyData.js; rules in academyProgress.js. Authoring
   is the full-page WORKSPACE in AcademyWorkspace.jsx (/learn/manage/…), reached
   from Learn → Manage, Admin → Academy and the Edit buttons on content pages.
   /learn/preview/… renders the course's private DRAFT through the same course
   and lesson components learners use (no progress writes, quiz not graded). */
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  ArrowLeftIcon, PlayIcon, CheckCircleIcon, ChevronRightIcon, ChevronDownIcon, MagnifyingGlassIcon,
  ArrowTopRightOnSquareIcon, PencilSquareIcon, LockClosedIcon, ChatBubbleLeftRightIcon, XMarkIcon,
  ExclamationTriangleIcon, EyeIcon, AcademicCapIcon, BookOpenIcon, DocumentTextIcon, MapIcon, SparklesIcon,
  CameraIcon, FilmIcon, PaintBrushIcon, MegaphoneIcon, UserGroupIcon, ArrowPathIcon, ClipboardDocumentCheckIcon, LinkIcon,
} from "@heroicons/react/24/outline";
import { CheckCircleIcon as CheckCircleSolid } from "@heroicons/react/24/solid";
import { learnPath, learnGuidePath, learnPathwayPath, learnCategoryPath, learnBrowsePath, learnManagePath, learnPreviewPath } from "./nav.js";
import { loadYouTubeApi } from "./youtubeApi.js";
import { recommendations, recentlyPublished, categoryCounts, continueTargets } from "./academyRecommend.js";
import { HRow } from "./academyRow.jsx";
import { orderCourses } from "./academyOrder.js";
import { pathContextFor, nextCourseSuggestion } from "./academyCompletion.js";
import { burstConfetti } from "./academyConfetti.js";
import { reportIssue } from "./logging";
import { useOnline, requireOnline, isOfflineError } from "./useOnline.js";
import { initials } from "./data";
import { BusyButton, Skeleton } from "./loading.jsx";
import { useMediaQuery } from "./overlay.jsx";
import { formatDateTime } from "./dateFormat.js";
import {
  ACADEMY_CATEGORIES, ONBOARDING_SEQUENCE, CONTENT_FORMATS, categoryById,
  categoryLabel, categoryShort, formatLabel, levelLabel, orderedCurriculum, flatLessons, lessonState, courseProgress,
  resumeLessonId, lessonNeighbours, continueLearning, continueLearningCombined, estimateProgress, filterCourses,
  validateQuizAnswers, canAttemptQuiz, canEditCourse, canEditContent, canViewLearnerProgress, canViewCourse,
  canViewContent, quizMode, formatDuration, toMs, guideReviewed, resolvePathItems, pathProgress, nextPathItem,
  normalizeCategory, lessonKind, lessonKindMeta, LESSON_KINDS, nextLessonIdFromModules,
  mergeCategories, categoryIn, categoryNameIn, categoryShortIn, INTRO_CATEGORY_ID, topicChips, topicNamesFor, hasTopic,
  isAcademyEditor, lessonAccess, accessFor, actionableFor, courseStatus, isRequiredLesson, lessonOpenFromModules, newId,
} from "./academyProgress.js";
import { videoFromRecord, PROVIDER_ORIGINS, shouldPersistPosition, resumePosition, videoWatchedFromEvent, vimeoEventKind, vimeoProvesPlayback, VIMEO_SLOW_MS } from "./academyVideo.js";
import { parseMarkdown, parseInlines } from "./academyMarkdown.js";
import { categoryReadState } from "./academyBootstrap.js";
import {
  useCourses, useCourse, useLessons, usePurposeVideo, useProgress, useAllProgress, useAttempts, useComments,
  useLeaderProgress, useLeaderAttempts, useImageUrl, recordLessonView, startCourse, savePlayback, markVideoWatched,
  setManualDone, finishCourse, submitQuiz, grantQuizAttempts, quizAttemptStatus, requestQuizAttempt, addComment, editComment, deleteComment, pinComment,
  useGuides, usePaths, useGuide, usePathDoc, useManyDocs, useSharedDocs, useAllGuideReviews, useGuideReview, setGuideReviewed,
  useAllPathProgress, usePathProgressDoc, recordPathView, recordPathCompleted, useLeaderGuideReviews, useLeaderPathProgress,
  useLeaderCourseProgressIn, useLeaderGuideReviewsIn, useCategoryArt, useIntroState, setIntroWatched,
  useCategoryRecords, useCategoryIndex, useTopicRecords, retryCategoryReads, loadCourseWorkspace, useCourseDrafts, useGuideDrafts, loadGuideWorkspace,
} from "./academyData.js";
/* Editing code is its own chunk (round 7): learners never download the
   workspace or the editors. Each editor is wrapped in the editor scope it needs. */
const AcademyWorkspace = React.lazy(() => import("./AcademyWorkspace.jsx"));
const PurposeVideoEditor = React.lazy(() => import("./AcademyManage.jsx").then((m) => ({ default: (p) => <m.AcademyEditorScope me={p.me}><m.PurposeVideoEditor {...p} /></m.AcademyEditorScope> })));
const PathEditor = React.lazy(() => import("./AcademyManage.jsx").then((m) => ({ default: (p) => <m.AcademyEditorScope me={p.me}><m.PathEditor {...p} /></m.AcademyEditorScope> })));
import { ConfirmDialog } from "./App.jsx";
import { courseTimeFacts, formatClock } from "./academyDrafts.js";
import { StoredImage, CategoryArt, VideoThumb, Markdown, SafeText, renderInlines, PushPinIcon, AppLink } from "./academyShared.jsx";
export { StoredImage, CategoryArt, Markdown, SafeText, renderInlines };

/* ===================================================================
   Shared bits
   =================================================================== */


export function ProgressBar({ percent, label, compact = false }) {
  const p = Math.max(0, Math.min(100, Math.round(percent || 0)));
  return (
    <div className={"ac-progress" + (compact ? " compact" : "")} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p} aria-label={label || "Progress"}>
      <span className="ac-progress-fill" style={{ width: `${p}%` }} />
    </div>
  );
}

const Pill = ({ children, tone = "" }) => <span className={"ac-pill " + tone}>{children}</span>;

function BackLink({ to, label, R }) {
  return (
    <button type="button" className="ac-back" onClick={() => R.navigate(to)}>
      <ArrowLeftIcon className="hi hi-sm" aria-hidden="true" /><span className="ac-back-label">{label}</span>
    </button>
  );
}

/* ===================================================================
   Root
   =================================================================== */
/* Editable taxonomy (category + topic RECORDS, hidden index), loaded once for
   the whole Learn screen. Components read it through useTax(); without a
   provider (tests) the bootstrap defaults apply. */
const TaxCtx = React.createContext(null);
const DEFAULT_TAX = (() => { const categories = mergeCategories([]); return { categories, visible: categories, hidden: [], loaded: true }; })();
export const useTax = () => React.useContext(TaxCtx) || DEFAULT_TAX;
/* Categories + the hidden-category index: what every Academy page needs before
   it may show (or query) content. `loaded` means exactly these two — topics are
   NOT part of it, so they can never hold up the categories. */
function useTaxonomy() {
  const recs = useCategoryRecords();
  const idx = useCategoryIndex();
  return useMemo(() => {
    const categories = mergeCategories(recs.docs).map((c) => (idx.hidden.includes(c.id) ? { ...c, hidden: true } : c));
    const hidden = [...new Set([...idx.hidden, ...categories.filter((c) => c.hidden).map((c) => c.id)])];
    // A FAILED read is an error, never "no records" (which shows the starter set).
    const state = categoryReadState(recs, idx);
    return { categories, visible: categories.filter((c) => !c.hidden), hidden, loaded: state === "ready" || state === "empty", error: state === "error" };
  }, [recs, idx]);
}
/* Topic records, read only where topics are shown or filtered (Browse, topic
   chips) through the shared subscription; the landing page never waits for them. */
function useTopicsById() {
  const t = useTopicRecords();
  return { topicsById: t.byId, topicsLoaded: t.loaded };
}
/* What a learner may see on discovery surfaces (home, browse, counts,
   recommendations): published + filed under a visible category. Editors get
   the same learner view there; their drafts/hidden items appear only in the
   explicit "Drafts" sections and admin lists. */
const learnerVisible = (items, hidden) => (items || []).filter((x) => x.status === "published" && (x.format === "path" || !hidden.includes(normalizeCategory(x.category))));

export default function Academy(props) {
  const tax = useTaxonomy();
  return (
    <TaxCtx.Provider value={tax}>
      <React.Suspense fallback={<div className="sb-page" aria-busy="true"><Skeleton lines={6} /></div>}><AcademyRoutes {...props} /></React.Suspense>
    </TaxCtx.Provider>
  );
}
function AcademyRoutes({ me, users, isAdmin, nav, R }) {
  if (nav.manage) return <AcademyWorkspace me={me} users={users} nav={nav} R={R} />;
  if (nav.preview && nav.guideId) return <GuidePreview me={me} guideId={nav.guideId} pathCtx={nav.pathCtx} R={R} />;
  if (nav.preview && nav.categoryId) return <CategoryPage me={me} users={users} isAdmin={isAdmin} categoryId={nav.categoryId} R={R} preview />;
  if (nav.preview && nav.courseId) return <DraftPreview me={me} users={users} courseId={nav.courseId} lessonId={nav.lessonId} pathCtx={nav.pathCtx} R={R} />;
  // nav.pathCtx: the learning path the learner came from (?path=), if any.
  if (nav.courseId && nav.lessonId) return <LessonView me={me} users={users} isAdmin={isAdmin} courseId={nav.courseId} lessonId={nav.lessonId} pathCtx={nav.pathCtx} R={R} />;
  if (nav.courseId) return <CourseOverview me={me} users={users} isAdmin={isAdmin} courseId={nav.courseId} pathCtx={nav.pathCtx} R={R} />;
  if (nav.guideId) return <GuideView me={me} users={users} isAdmin={isAdmin} guideId={nav.guideId} R={R} />;
  if (nav.pathId) return <PathView me={me} users={users} isAdmin={isAdmin} pathId={nav.pathId} R={R} />;
  if (nav.categoryId) return <CategoryPage me={me} users={users} isAdmin={isAdmin} categoryId={nav.categoryId} R={R} />;
  if (nav.browse && nav.browse.view === "categories") return <AllCategories me={me} R={R} />;
  if (nav.browse) return <BrowsePage me={me} isAdmin={isAdmin} browse={nav.browse} R={R} />;
  return <LearnHome me={me} users={users} isAdmin={isAdmin} R={R} />;
}

/* ===================================================================
   Learn home
   =================================================================== */
/* Build a lookup of the lesson docs that in-progress paths reference, so their
   next step / percent is accurate on the home screen (bounded: started paths only). */
function usePathContext(paths, me, courses, guides, progressByCourse, reviewsByGuide) {
  const lessonPaths = useMemo(() => {
    const set = new Set();
    for (const p of paths) for (const it of p.items || []) if (it.type === "lesson" && it.courseId && it.lessonId) set.add(`courses/${it.courseId}/lessons/${it.lessonId}`);
    return [...set].sort();
  }, [paths]);
  const lessonDocs = useManyDocs(lessonPaths);
  return useMemo(() => {
    const ctx = { me, courses: {}, guides: {}, lessons: {}, progressByCourse, reviews: reviewsByGuide, hidden: [] };
    for (const c of courses) ctx.courses[c.id] = c;
    for (const g of guides) ctx.guides[g.id] = g;
    for (const [path, d] of Object.entries(lessonDocs.byPath)) { const m = path.match(/^courses\/([^/]+)\/lessons\/([^/]+)$/); if (m) ctx.lessons[`${m[1]}/${m[2]}`] = d; }
    return { ctx, loaded: lessonDocs.loaded };
  }, [me, courses, guides, lessonDocs, progressByCourse, reviewsByGuide]);
}

/* A card's clickable surface: a real link when it has a destination (so it
   opens in a new tab, shows its address, works with Back), else a button. */
function CardTarget({ href, navigate, onOpen, className, children, ...rest }) {
  if (href && navigate) return <AppLink to={href} navigate={navigate} className={className} {...rest}>{children}</AppLink>;
  return <button type="button" className={className} onClick={onOpen} {...rest}>{children}</button>;
}

/* Portrait 3:4 poster, the same shape as course covers; name, short
   description and the learner-visible course count sit below the artwork. */
export function CategoryCard({ category, count, imageRef, onOpen, href, navigate }) {
  return (
    <div className="ac-catcard" role="listitem">
      <CardTarget href={href} navigate={navigate} onOpen={onOpen} className="ac-catbtn" aria-label={count == null ? category.label : `${category.label}, ${count} course${count === 1 ? "" : "s"}`}>
        <CategoryArt category={category} imageRef={imageRef} />
        <span className="ac-catbody">
          <span className="ac-cattitle">{category.label}</span>
          <span className="ac-catdesc">{category.purpose}</span>
          {/* the count arrives with the course list; its line is reserved meanwhile */}
          <span className={"ac-catcount" + (count == null ? " pending" : "")}>{count == null ? "\u00a0" : `${count} course${count === 1 ? "" : "s"}`}</span>
        </span>
      </CardTarget>
    </div>
  );
}

/* Lesson docs for the "continue" rows only (one per started course, ≤ 3). */
function useContinueLessons(courses, progressByCourse) {
  const targets = useMemo(() => continueTargets(courses, progressByCourse), [courses, progressByCourse]);
  const refs = useMemo(() => targets.filter((t) => t.nextLessonId).map((t) => `courses/${t.course.id}/lessons/${t.nextLessonId}`), [targets]);
  // shared + lingering: returning to Learn shows the Continue card at once
  const docs = useSharedDocs(refs);
  const lessonsById = useMemo(() => {
    const m = {};
    for (const [path, d] of Object.entries(docs.byPath)) { const x = path.match(/^courses\/([^/]+)\/lessons\/([^/]+)$/); if (x && d) m[`${x[1]}/${x[2]}`] = d; }
    return m;
  }, [docs.byPath]);
  return { lessonsById, loaded: docs.loaded };
}

/* The introduction's summary: three lines, with "Show more" when it's longer
   (the essential instructions are never cut off without a way to read them). */
function IntroSummary({ text }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const ref = useRef(null);
  // "Show more" appears only when the text is actually cut off (re-checked when
  // the width or text size changes)
  React.useLayoutEffect(() => {
    const el = ref.current; if (!el || open) return undefined;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(check) : null;
    ro && ro.observe(el);
    return () => ro && ro.disconnect();
  }, [text, open]);
  return (
    <>
      <p ref={ref} className={"ac-start2-sum" + (open ? " open" : "")} id="ac-start2-sum">{text}</p>
      {long && <button type="button" className="ac-linkbtn ac-start2-more" aria-expanded={open} aria-controls="ac-start2-sum" onClick={() => setOpen((v) => !v)}>{open ? "Show less" : "Show more"}</button>}
    </>
  );
}

function LearnHome({ me, users, isAdmin, R }) {
  const tax = useTax();
  // The landing page is learner-facing: editors read the same published +
  // visible lists as learners here (drafts and hidden items live in Manage).
  const { courses, loaded: cLoaded, error: cErr } = useCourses(me, { learnerView: true });
  const { guides, loaded: gLoaded } = useGuides(me, { learnerView: true });
  // only feeds the "Learning paths · N" link: started once the categories are known,
  // so it never competes with what the first screen needs
  const { paths, loaded: pathsLoaded, error: pathsError } = usePaths(tax.loaded ? me : null, { learnerView: true });
  const purpose = usePurposeVideo();
  const art = useCategoryArt();
  const intro = useIntroState(me.id);
  const progress = useAllProgress(me.id);
  const [q, setQ] = useState("");
  const [showPurpose, setShowPurpose] = useState(false);
  const [editPurpose, setEditPurpose] = useState(false);
  const [busyIntro, setBusyIntro] = useState(false);
  // Each section renders as soon as ITS data is ready (round 7): categories need
  // only the taxonomy; counts, Continue and For you need courses + progress;
  // Recently added also needs resources.
  const coursesReady = cLoaded && tax.loaded;
  const loaded = coursesReady && gLoaded;
  const purposeVideo = purpose.data?.video ? videoFromRecord(purpose.data.video) : null;
  const introWatched = intro.data?.watched === true;
  const pubCourses = useMemo(() => learnerVisible(courses, tax.hidden), [courses, tax.hidden]);
  const pubGuides = useMemo(() => learnerVisible(guides, tax.hidden), [guides, tax.hidden]);
  const counts = useMemo(() => categoryCounts(me, pubCourses, tax.hidden), [me, pubCourses, tax.hidden]);
  const { lessonsById, loaded: contLessonsLoaded } = useContinueLessons(pubCourses, progress.byCourse);
  // History is KNOWN only when it loaded without an error: a failed read is not
  // an empty history (no suggestions are computed from it, and it says so).
  const progressKnown = progress.loaded && !progress.error;
  const recsReady = coursesReady && progressKnown && contLessonsLoaded;
  // The Continue placeholder needs positive evidence: a started course that
  // isn't finished. A new learner (or unknown history) never sees one.
  const resumable = progressKnown && progress.docs.some((p) => (p.startedAt || p.lastLessonId) && !p.finishedAt);
  const mayContinue = resumable && !recsReady;
  const noCourses = coursesReady && !cErr && pubCourses.length === 0;
  const recs = useMemo(() => recommendations({ me, courses: pubCourses, progressByCourse: progress.byCourse, lessonsById, max: 4, categories: tax.categories }), [me, pubCourses, progress.byCourse, lessonsById, tax.categories]);
  // A returning learner gets ONE compact Continue shortcut at the top; the same
  // course is not repeated in the For you row below.
  const cont = recs.find((r) => r.kind === "continue") || null;
  const rowRecs = cont ? recs.filter((r) => r.course.id !== cont.course.id) : recs;
  const recent = useMemo(() => {
    const suggested = new Set(recs.map((r) => r.course.id));
    return recentlyPublished({ me, courses: pubCourses, guides: pubGuides, limit: 10, hidden: tax.hidden })
      .filter((x) => !(x.item.format === "course" && suggested.has(x.item.id))).slice(0, 5);
  }, [me, pubCourses, pubGuides, tax.hidden, recs]);
  const publishedPaths = paths.filter((p) => p.status === "published").length;
  // a failed read is not "0 paths": the count shows only when the query succeeded
  const pathsKnown = tax.loaded && pathsLoaded && !pathsError;
  // The featured "Start here" category is referenced by its STABLE id; a hidden or
  // deleted record simply drops the "More from…" link (no broken route).
  const introCat = categoryIn(tax.categories, INTRO_CATEGORY_ID);
  const introCatVisible = !!introCat && !introCat.hidden;
  const editor = isAcademyEditor(me);
  const showStart = !!purposeVideo || introCatVisible || isAdmin;
  const search = (e) => { e.preventDefault(); if (q.trim()) R.navigate(learnBrowsePath({ q: q.trim() })); };
  const [introErr, setIntroErr] = useState("");
  const markIntro = async (watched) => {
    setBusyIntro(true); setIntroErr("");
    try { requireOnline(); await setIntroWatched(me.id, watched); }
    catch (e) { setIntroErr(isOfflineError(e) ? "You're offline, so this wasn't saved. Try again when you're back online." : "Couldn't save that. Please try again."); }
    finally { setBusyIntro(false); }
  };

  const introTitle = purpose.data?.title || "The Heart Behind the Creative";
  const introSummary = purpose.data?.intro || introCat?.purpose || "";
  const introDone = introWatched && !showPurpose;
  const contHref = cont ? (cont.lessonId && !cont.ready ? learnPath(cont.course.id, cont.lessonId) : learnPath(cont.course.id)) : null;
  const contPct = cont && cont.summary ? Math.round(cont.summary.percent || 0) : 0;

  return (
    <div className="sb-page ac-home">
      <div className="ac-homehead">
        <div className="ac-hometitle">
          <div>
            <div className="sb-mlabel">Learn</div>
            <h1 className="ac-h1">Creative Academy</h1>
          </div>
          {editor && <button type="button" className="sb-btn ghost compact ac-managebtn" onClick={() => R.navigate("/learn/manage")}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Manage</button>}
        </div>
        <form className="ac-search ac-homesearch" onSubmit={search} role="search">
          <MagnifyingGlassIcon className="hi hi-sm" aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the Academy" aria-label="Search the Academy" />
        </form>
      </div>

      {/* Continue learning — one compact shortcut for a returning learner */}
      {progress.loaded && progress.error && <p className="ac-note ac-historynote" role="status">Your learning history couldn't load right now, so Continue and suggestions are hidden. Your progress is safe.</p>}
      {mayContinue && <div className="ac-continue ac-continue-skel" aria-hidden="true"><span className="ac-continue-cover sb-skel" /><span className="ac-continue-body"><span className="sb-skel ac-skelline" /><span className="sb-skel ac-skelline short" /></span></div>}
      {recsReady && cont && (
        <AppLink className="ac-continue" to={contHref} navigate={R.navigate} aria-label={`Continue learning: ${cont.lesson ? `${cont.lesson.title}, in ${cont.course.title}` : cont.course.title}`}>
          {cont.lesson && cont.lesson.video
            ? <VideoThumb item={cont.lesson} className="ac-continue-thumb" placeholder={<PlayIcon className="hi" aria-hidden="true" />} />
            : <StoredImage imageRef={cont.course.cover} alt="" className="ac-continue-cover" ratio="3 / 4" />}
          <span className="ac-continue-body">
            <span className="ac-recreason">{cont.ready ? "Ready to finish" : "Continue learning"}</span>
            <span className="ac-rectitle">{cont.lesson ? cont.lesson.title : cont.course.title}</span>
            {cont.lesson && <span className="ac-cardsub">in {cont.course.title}</span>}
            {contPct > 0 && <ProgressBar percent={contPct} compact label={`${cont.course.title}: ${contPct}% complete`} />}
          </span>
          <span className="ac-continue-go" aria-hidden="true"><PlayIcon className="hi hi-sm" />{cont.ready ? "Finish" : "Resume"}</span>
        </AppLink>
      )}

      {/* A — compact introduction (the purpose video stays; never a gate) */}
      {showStart && <section className={"ac-start2" + (introDone ? " is-done" : "") + (showPurpose ? " is-playing" : "")} aria-labelledby="ac-start-h">
        {showPurpose && purposeVideo && (
          <div className="ac-start2-player"><VideoPlayer video={purposeVideo} title={introTitle} onEnded={() => { if (!introWatched) markIntro(true); }} /></div>
        )}
        {introDone ? (
          <div className="ac-start2-done">
            <CheckCircleSolid className="hi hi-sm ac-start2-check" aria-hidden="true" />
            <span className="ac-start2-donetxt"><span id="ac-start-h" className="ac-start2-title">{introTitle}</span><span className="ac-cardsub">You've watched the introduction.</span></span>
            {purposeVideo && <button type="button" className="sb-btn ghost compact" onClick={() => setShowPurpose(true)}><ArrowPathIcon className="hi hi-sm" aria-hidden="true" />Watch again</button>}
          </div>
        ) : !showPurpose ? (
          <div className="ac-start2-row">
            <button type="button" className="ac-purpose-play ac-start2-thumb" onClick={() => setShowPurpose(true)} disabled={!purposeVideo}
              aria-label={purposeVideo ? `Watch: ${introTitle}` : "No introduction video yet"}>
              <StoredImage imageRef={purpose.data?.thumb} alt="" ratio="16 / 9" placeholder={<PlayIcon className="hi" aria-hidden="true" />} />
              {purposeVideo && <span className="ac-playbadge sm" aria-hidden="true"><PlayIcon className="hi" /></span>}
            </button>
            <div className="ac-start2-text">
              <div className="sb-mlabel">Start here</div>
              <h2 id="ac-start-h" className="ac-start2-title">{introTitle}</h2>
              {introSummary && <IntroSummary text={introSummary} />}
            </div>
          </div>
        ) : (
          <h2 id="ac-start-h" className="ac-start2-title ac-start2-playtitle">{introTitle}</h2>
        )}
        <div className="ac-actions ac-start2-actions">
          {purposeVideo && !showPurpose && !introDone && <button type="button" className="sb-btn compact" onClick={() => setShowPurpose(true)}><PlayIcon className="hi hi-sm" aria-hidden="true" />Watch introduction</button>}
          {purposeVideo && !introWatched && purposeVideo.capabilities && !purposeVideo.capabilities.tracksEnded && <BusyButton className="sb-btn ghost compact" busy={busyIntro} onClick={() => markIntro(true)}>Mark as watched</BusyButton>}
          {introCatVisible && <AppLink className="ac-link ac-start2-cat" to={learnCategoryPath(introCat.id)} navigate={R.navigate} aria-label={`Explore the ${introCat.label} category`}>Explore {introCat.short || introCat.label}<ChevronRightIcon className="hi hi-xs" aria-hidden="true" /></AppLink>}
          {isAdmin && <button type="button" className="ac-link ac-start2-edit" onClick={() => setEditPurpose(true)}><PencilSquareIcon className="hi hi-xs" aria-hidden="true" />{purpose.data ? "Edit intro" : "Set up intro"}</button>}
          {introErr && <span className="ac-err" role="alert">{introErr}</span>}
        </div>
      </section>}
      {editPurpose && <PurposeVideoEditor me={me} current={purpose.data} onClose={() => setEditPurpose(false)} />}

      {/* B — explore categories: a swipeable row on phones/tablets, a grid on desktop */}
      {tax.error ? (
        <section aria-labelledby="ac-cats-h"><h2 id="ac-cats-h" className="ac-h2">Explore categories</h2>
          <div className="sb-empty" role="alert"><p>Couldn't load the Academy's categories. Check your connection, then try again.</p>
            <button type="button" className="sb-btn compact" onClick={retryCategoryReads}>Try again</button></div></section>
      ) : !tax.loaded ? (
        <section aria-labelledby="ac-cats-h" className="ac-hsection">
          <div className="sb-shead"><h2 id="ac-cats-h" className="ac-h2">Explore categories</h2></div>
          <div className="ac-hrow ac-hrow-gridwide" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="ac-catcard"><div className="ac-catart sb-skel" style={{ aspectRatio: "3 / 4" }} /></div>)}</div>
        </section>
      ) : tax.visible.length === 0 ? (
        <section aria-labelledby="ac-cats-h"><h2 id="ac-cats-h" className="ac-h2">Explore categories</h2><div className="sb-empty">No categories yet.{isAdmin && <> Create one in <b>Learn → Manage</b>.</>}</div></section>
      ) : (
        <HRow id="ac-cats-h" title="Explore categories" noun="category" wide="grid"
          viewAll={<AppLink className="ac-link" to={learnBrowsePath({ view: "categories" })} navigate={R.navigate} aria-label="View all categories">View all<ChevronRightIcon className="hi hi-xs" aria-hidden="true" /></AppLink>}>
          {tax.visible.map((c) => <CategoryCard key={c.id} category={c} count={coursesReady && !cErr ? counts[c.id] || 0 : null} imageRef={c.cover || art.data?.art?.[c.id]} href={learnCategoryPath(c.id)} navigate={R.navigate} />)}
        </HRow>
      )}
      {cErr && <div className="sb-empty" role="alert">Couldn't load the Academy's courses. Check your connection and try again.</div>}
      {/* An Academy with categories but nothing published yet: say so once the
          (empty) course list is confirmed, instead of leaving speculative space */}
      {noCourses && tax.visible.length > 0 && (
        <p className="ac-note ac-emptynote" role="status">
          {editor ? <>No courses are published yet. <AppLink className="ac-link inline" to="/learn/manage" navigate={R.navigate}>Create one in Manage</AppLink>.</> : "No courses are published yet. New courses will appear in these categories."}
        </p>
      )}

      {/* C — for you: course cards (3:4 covers) in a row; the Continue course above isn't repeated */}
      {recsReady && rowRecs.length > 0 && (
        <HRow id="ac-foryou-h" title="For you" noun="suggestion" wide="grid">
          {rowRecs.map((r) => {
            const href = r.kind === "continue" && r.lessonId && !r.ready ? learnPath(r.course.id, r.lessonId) : learnPath(r.course.id);
            const pct = r.summary ? Math.round(r.summary.percent || 0) : 0;
            return (
              <div key={r.course.id} className="ac-rowcard" role="listitem">
                <AppLink className="ac-rowcardbtn" to={href} navigate={R.navigate}>
                  <StoredImage imageRef={r.course.cover} alt="" className="ac-rowcover" ratio="3 / 4" />
                  <span className="ac-rowbody">
                    <span className="ac-recreason">{r.reason}</span>
                    <span className="ac-rectitle">{r.course.title}</span>
                    <span className="ac-cardsub">{categoryShortIn(tax.categories, r.course.category)}{r.course.level ? ` · ${levelLabel(r.course.level)}` : ""}</span>
                    {pct > 0 && <ProgressBar percent={pct} compact label={`${r.course.title}: ${pct}% complete`} />}
                  </span>
                </AppLink>
              </div>
            );
          })}
        </HRow>
      )}

      {/* D — recently added */}
      {loaded && recent.length > 0 && (
        <section aria-labelledby="ac-recent-h">
          <div className="sb-shead">
            <h2 id="ac-recent-h" className="ac-h2">Recently added</h2>
            <AppLink className="ac-link" to={learnBrowsePath({ sort: "recent" })} navigate={R.navigate}>View all<ChevronRightIcon className="hi hi-xs" aria-hidden="true" /></AppLink>
          </div>
          <div className="ac-recent" role="list">
            {recent.map(({ item, publishedMs }) => (
              <div key={item.format + item.id} role="listitem">
                <AppLink className="ac-recentrow" to={item.format === "guide" ? learnGuidePath(item.id) : learnPath(item.id)} navigate={R.navigate}>
                  <span className="ac-fmt">{item.format === "guide" ? <DocumentTextIcon className="hi hi-xs" aria-hidden="true" /> : <AcademicCapIcon className="hi hi-xs" aria-hidden="true" />}{item.format === "guide" ? "Resource" : "Course"}</span>
                  <span className="ac-recenttitle">{item.title}</span>
                  <span className="ac-cardsub">{categoryShortIn(tax.categories, item.category)} · {formatDateTime(publishedMs)}</span>
                </AppLink>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="ac-secondary" aria-label="More ways to learn">
        <AppLink className="ac-link" to={learnBrowsePath({ format: "course" })} navigate={R.navigate}><AcademicCapIcon className="hi hi-sm" aria-hidden="true" />Browse all courses</AppLink>
        <AppLink className="ac-link" to={learnBrowsePath({ format: "path" })} navigate={R.navigate}><MapIcon className="hi hi-sm" aria-hidden="true" />Learning paths{pathsKnown ? ` · ${publishedPaths}` : ""}</AppLink>
        <AppLink className="ac-link" to={learnBrowsePath({ format: "guide" })} navigate={R.navigate}><DocumentTextIcon className="hi hi-sm" aria-hidden="true" />All tips & resources</AppLink>
        <AppLink className="ac-link" to={learnBrowsePath({})} navigate={R.navigate}><BookOpenIcon className="hi hi-sm" aria-hidden="true" />Browse everything</AppLink>
      </section>
    </div>
  );
}

/* ===================================================================
   Category page — Learn → <Category>
   =================================================================== */
function Breadcrumb({ items, R }) {
  return (
    <nav className="ac-crumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((it, i) => (
          <li key={i}>
            {it.to ? <AppLink to={it.to} navigate={R.navigate} className="ac-link inline">{it.label}</AppLink> : <span aria-current={i === items.length - 1 ? "page" : undefined}>{it.label}</span>}
            {i < items.length - 1 && <ChevronRightIcon className="hi hi-xs" aria-hidden="true" />}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/* preview: the category exactly as learners get it (published courses in the
   saved order, cover, description, empty state) — for Academy editors only,
   even while the category is hidden. Category details save straight to the
   category (there are no category drafts), so this previews the SAVED values;
   previewing never shows the category or publishes anything. */
function CategoryPage({ me, users, isAdmin, categoryId, R, preview = false }) {
  const tax = useTax();
  const canonical = normalizeCategory(categoryId);
  const record = categoryIn(tax.categories, categoryId);
  const editor = isAcademyEditor(me);
  // Hidden categories are unavailable to learners (rules hide their courses too);
  // editors can still open them, with a clear "Hidden" label.
  const category = record && (!record.hidden || editor) && (!preview || editor) ? record : null;
  // Legacy ids (e.g. /learn/category/videography) land on the canonical page.
  useEffect(() => { if (category && canonical !== categoryId && !preview) R.replace(learnCategoryPath(canonical)); }, [category, canonical, categoryId]); // eslint-disable-line react-hooks/exhaustive-deps
  const { courses, loaded, error } = useCourses(me);
  const { guides, loaded: gLoaded } = useGuides(me);
  const progress = useAllProgress(me.id);
  const art = useCategoryArt();
  useEffect(() => { if (category) document.title = `${preview ? "Preview · " : ""}${category.label} · Learn · IFC Creatives Board`; }, [category, preview]);
  // never-published courses/resources exist only as private drafts (editors only).
  // Hooks stay ABOVE the early returns (they'd change the hook order once the taxonomy loads).
  const draftDocs = useCourseDrafts(preview ? me : null);
  const guideDraftDocs = useGuideDrafts(preview ? me : null);
  if (!tax.loaded) return <div className="sb-page"><Skeleton lines={6} /></div>;
  if (!category) return <NotAvailable R={R} what="category" />;
  // Same ordering function as the workspace's drag-and-drop list.
  const list = orderCourses(courses.filter((c) => c.status === "published" && normalizeCategory(c.category) === category.id), category.courseOrder || []);
  const drafts = courses.filter((c) => c.status !== "published" && normalizeCategory(c.category) === category.id && canEditContent(me, c));
  // Tips & resources in the category's saved order (then by title)
  const gpos = (x) => { const i = (category.guideOrder || []).indexOf(x); return i < 0 ? Infinity : i; };
  const tips = guides.filter((g) => g.status === "published" && normalizeCategory(g.category) === category.id).sort((a, b) => gpos(a.id) - gpos(b.id) || String(a.title).localeCompare(String(b.title)));
  const cont = preview ? null : continueTargets(list, progress.byCourse, 1)[0] || null;
  const unpublished = new Set([
    ...courses.filter((c) => c.status !== "published" && normalizeCategory(c.category) === category.id).map((c) => c.id),
    ...(draftDocs.docs || []).filter((d) => normalizeCategory(d.category || "") === category.id && !courses.some((c) => c.id === d.id && c.status === "published")).map((d) => d.id),
  ]).size;
  const unpublishedTips = new Set([
    ...guides.filter((g) => g.status !== "published" && normalizeCategory(g.category) === category.id).map((g) => g.id),
    ...(guideDraftDocs.docs || []).filter((d) => normalizeCategory(d.category || "") === category.id && !guides.some((g) => g.id === d.id && g.status === "published")).map((d) => d.id),
  ]).size;
  return (
    <div className="sb-page ac-catpage">
      {preview && (
        <div className="ac-previewbar" role="status">
          <EyeIcon className="hi hi-sm" aria-hidden="true" />
          <span><b>Category preview.</b> {category.hidden ? `“${category.label}” is hidden, so learners can't see it yet. This is how it will look once you show it.` : `This is how learners see “${category.label}” now.`} Only published courses and tips & resources appear{unpublished + unpublishedTips ? `. Not shown: ${[unpublished ? `${unpublished} unpublished course${unpublished === 1 ? "" : "s"}` : "", unpublishedTips ? `${unpublishedTips} unpublished tip${unpublishedTips === 1 ? "" : "s"} or resource${unpublishedTips === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}` : ""}.</span>
          <button type="button" className="sb-btn compact" onClick={() => R.navigate(learnManagePath({ view: "category", id: category.id }))}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Back to editing</button>
        </div>
      )}
      <Breadcrumb R={R} items={[{ label: "Learn", to: preview ? null : "/learn" }, { label: category.label }]} />
      {/* Phones: a small portrait cover beside the title and count, the
          description below at full width (round 7); desktop keeps a larger cover. */}
      <div className="ac-cathead">
        <CategoryArt category={category} imageRef={category.cover || art.data?.art?.[category.id]} className="ac-catheadart" eager />
        <div className="ac-catheadmeta">
          {category.hidden && !preview && <span className="ac-pill warn">Hidden from learners</span>}
          <h1 className="ac-h1">{category.label}</h1>
          <div className="ac-cardsub ac-catheadcount">{loaded && gLoaded ? `${list.length} course${list.length === 1 ? "" : "s"}${tips.length ? ` · ${tips.length} tip${tips.length === 1 ? "" : "s"} & resource${tips.length === 1 ? "" : "s"}` : ""}` : "\u00a0"}</div>
          {editor && !preview && !category.bootstrap && <button type="button" className="ac-link ac-editlink" onClick={() => R.navigate(learnManagePath({ view: "category", id: category.id }))}><PencilSquareIcon className="hi hi-xs" aria-hidden="true" />{isAdmin ? "Manage category" : "Add or edit courses"}</button>}
        </div>
        {category.purpose && <p className="ac-catpurpose">{category.purpose}</p>}
      </div>
      {cont && (
        <section aria-labelledby="ac-catcont-h" className="ac-catcont">
          <h2 id="ac-catcont-h" className="sb-vh">Continue your course</h2>
          <AppLink className="ac-contcard" navigate={R.navigate} to={cont.nextLessonId && !cont.ready ? learnPath(cont.course.id, cont.nextLessonId) : learnPath(cont.course.id)}>
            <StoredImage imageRef={cont.course.cover} alt="" className="ac-contcover" ratio="3 / 4" />
            <span className="ac-contbody">
              <span className="ac-contcat">{cont.ready ? "Ready to finish" : "Continue your course"}</span>
              <span className="ac-conttitle">{cont.course.title}</span>
              {cont.summary.percent > 0 && <ProgressBar percent={cont.summary.percent} compact label={`${cont.course.title}: ${cont.summary.percent}% complete`} />}
              <span className="ac-contmeta">{cont.ready ? "All required lessons are complete. Finish your course." : cont.summary.done > 0 ? `${cont.summary.done} of ${cont.summary.total} lessons · ${cont.summary.percent}%` : "Started. Pick up where you left off."}</span>
            </span>
          </AppLink>
        </section>
      )}
      <section aria-labelledby="ac-catcourses-h">
        <div className="sb-shead"><h2 id="ac-catcourses-h" className="ac-h2">Courses</h2></div>
        {!loaded ? <CourseGridSkeleton />
          : error ? <div className="sb-empty" role="alert">Couldn't load courses. Check your connection and try again.</div>
          : list.length === 0 ? <div className="sb-empty">No published courses in {category.label} yet.{editor && !preview && !category.bootstrap && <> <button type="button" className="ac-link" onClick={() => R.navigate(learnManagePath({ view: "course", category: category.id }))}>Create a course</button></>}</div>
          : <div className="ac-grid" role="list">{list.map((c) => <CourseCard key={c.id} course={c} progress={preview ? null : progress.byCourse[c.id]} href={learnPath(c.id)} navigate={R.navigate} hideCategory />)}</div>}
      </section>
      {drafts.length > 0 && !preview && (
        <section aria-labelledby="ac-catdrafts-h">
          <div className="sb-shead"><h2 id="ac-catdrafts-h" className="ac-h2">Drafts</h2><span className="sb-tag">Visible to Academy editors only</span></div>
          <div className="ac-grid" role="list">{drafts.map((c) => <CourseCard key={c.id} course={c} href={learnManagePath({ view: "course", id: c.id })} navigate={R.navigate} />)}</div>
        </section>
      )}
      {gLoaded && tips.length > 0 && (
        <section aria-labelledby="ac-tips-h" className="ac-tips">
          <div className="sb-shead"><h2 id="ac-tips-h" className="ac-h2">Tips & resources</h2><span className="ac-cardsub">Short help for {category.label}</span></div>
          <ul className="ac-tiplist">
            {tips.map((g) => (
              <li key={g.id}><button type="button" className="ac-tiprow" onClick={() => R.navigate(learnGuidePath(g.id))}>
                <DocumentTextIcon className="hi hi-sm" aria-hidden="true" /><span className="ac-tiptitle">{g.title}</span><span className="ac-cardsub">{g.video ? "Video" : "Text"}{g.durationMinutes ? ` · ${formatDuration(g.durationMinutes)}` : ""}</span><ChevronRightIcon className="hi hi-xs ac-chev" aria-hidden="true" />
              </button></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ===================================================================
   Browse — the full listing with format / category filters, search, sort
   =================================================================== */
/* Learn → All categories (/learn/browse?view=categories): every visible category
   as the same cards the Learn page shows, in a grid. */
function AllCategories({ me, R }) {
  const { courses, loaded: cLoaded, error: cErr } = useCourses(me);
  const tax = useTax();
  const art = useCategoryArt();
  const loaded = cLoaded && tax.loaded;
  const pubCourses = useMemo(() => learnerVisible(courses, tax.hidden), [courses, tax.hidden]);
  const counts = useMemo(() => categoryCounts(me, pubCourses, tax.hidden), [me, pubCourses, tax.hidden]);
  return (
    <div className="sb-page ac-home">
      <Breadcrumb R={R} items={[{ label: "Learn", to: "/learn" }, { label: "All categories" }]} />
      <h1 className="ac-h1">All categories</h1>
      {!loaded ? (
        <div className="ac-catgrid" aria-busy="true" aria-label="Loading categories">{[0, 1, 2, 3].map((i) => <div key={i} className="ac-catcard"><div className="ac-catart sb-skel" style={{ aspectRatio: "3 / 4" }} /></div>)}</div>
      ) : cErr ? <div className="sb-empty" role="alert">Couldn't load the Academy. Check your connection and try again.</div>
        : tax.visible.length === 0 ? <div className="sb-empty">No categories yet.</div>
        : (
          <div className="ac-catgrid" role="list" aria-label="Categories">
            {tax.visible.map((c) => <CategoryCard key={c.id} category={c} count={counts[c.id] || 0} imageRef={c.cover || art.data?.art?.[c.id]} href={learnCategoryPath(c.id)} navigate={R.navigate} />)}
          </div>
        )}
      <section className="ac-secondary" aria-label="More ways to learn">
        <AppLink className="ac-link" to={learnBrowsePath({ format: "course" })} navigate={R.navigate}><AcademicCapIcon className="hi hi-sm" aria-hidden="true" />Browse all courses</AppLink>
        <AppLink className="ac-link" to={learnBrowsePath({})} navigate={R.navigate}><BookOpenIcon className="hi hi-sm" aria-hidden="true" />Browse everything</AppLink>
      </section>
    </div>
  );
}

function BrowsePage({ me, isAdmin, browse, R }) {
  // learner-facing: editors get the same published + visible lists as learners
  const { courses, loaded: cLoaded, error: cErr } = useCourses(me, { learnerView: true });
  const { guides, loaded: gLoaded } = useGuides(me, { learnerView: true });
  const { paths, loaded: pLoaded } = usePaths(me, { learnerView: true });
  const { topicsById, topicsLoaded } = useTopicsById();
  const progress = useAllProgress(me.id);
  const reviews = useAllGuideReviews(me.id);
  const pathProg = useAllPathProgress(me.id);
  const [q, setQ] = useState(browse.q || "");
  useEffect(() => { setQ(browse.q || ""); }, [browse.q]);
  const set = (patch) => R.navigate(learnBrowsePath({ ...browse, ...patch }), { replace: true });
  const tax = useTax();
  const loaded = cLoaded && gLoaded && pLoaded && tax.loaded && topicsLoaded;
  // Search text includes topic NAMES (renames apply; hidden topics don't match).
  const all = useMemo(() => learnerVisible([...courses, ...guides, ...paths], tax.hidden)
    .map((x) => ({ ...x, topics: topicNamesFor(x, topicsById) })), [courses, guides, paths, tax.hidden, topicsById]);
  const topic = browse.topic ? topicsById[browse.topic] : null;
  const topicOk = !!topic && !topic.hidden;
  let list = useMemo(() => {
    const base = filterCourses(all, { q: browse.q, category: browse.category, format: browse.format, categories: tax.categories });
    if (!browse.topic) return base;
    if (!topicOk) return [];
    return base.filter((x) => hasTopic(x, topic));
  }, [all, browse.q, browse.category, browse.format, browse.topic, topicOk, topic]);
  if (browse.sort === "recent") list = [...list].sort((a, b) => toMs(b.publishedAt) - toMs(a.publishedAt));
  const hrefOf = (item) => (item.format === "guide" ? learnGuidePath(item.id) : item.format === "path" ? learnPathwayPath(item.id) : learnPath(item.id));
  const title = browse.topic ? (topicOk ? `Topic: ${topic.name}` : "Topic") : browse.sort === "recent" ? "Recently added" : browse.format === "path" ? "Learning paths" : browse.format === "guide" ? "Tips & resources" : browse.format === "course" ? "All courses" : "Browse";
  return (
    <div className="sb-page ac-home">
      <Breadcrumb R={R} items={[{ label: "Learn", to: "/learn" }, { label: title }]} />
      <h1 className="ac-h1">{title}</h1>
      <div className="ac-filters">
        <form className="ac-search" role="search" onSubmit={(e) => { e.preventDefault(); set({ q: q.trim() }); }}>
          <MagnifyingGlassIcon className="hi hi-sm" aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => { if (q.trim() !== (browse.q || "")) set({ q: q.trim() }); }} placeholder="Search courses, resources, paths, topics" aria-label="Search" />
        </form>
        <div className="sb-seg ac-fmts" role="group" aria-label="Format">
          <button type="button" className={"sb-segbtn" + (!browse.format ? " on" : "")} aria-pressed={!browse.format} onClick={() => set({ format: "" })}>All formats</button>
          {CONTENT_FORMATS.map((f) => <button type="button" key={f.id} className={"sb-segbtn" + (browse.format === f.id ? " on" : "")} aria-pressed={browse.format === f.id} onClick={() => set({ format: f.id })}>{f.plural}</button>)}
        </div>
      </div>
      <div className="sb-seg ac-cats" role="group" aria-label="Category">
        <button type="button" className={"sb-segbtn" + (!browse.category ? " on" : "")} aria-pressed={!browse.category} onClick={() => set({ category: "" })}>All categories</button>
        {tax.visible.map((c) => <button type="button" key={c.id} className={"sb-segbtn" + (normalizeCategory(browse.category) === c.id ? " on" : "")} aria-pressed={normalizeCategory(browse.category) === c.id} onClick={() => set({ category: c.id })}>{c.short || c.label}</button>)}
      </div>
      {browse.topic && <div className="ac-topicfilter">{topicOk ? <>Showing items tagged <b>{topic.name}</b>{topic.description ? `: ${topic.description}` : ""}.</> : "This topic isn't available."} <button type="button" className="ac-link" onClick={() => set({ topic: "" })}>Clear topic</button></div>}
      <div className="ac-sortrow">
        <span className="ac-cardsub">{loaded ? `${list.length} result${list.length === 1 ? "" : "s"}` : ""}</span>
        <label className="ac-cardsub">Sort <select className="sb-select" value={browse.sort || ""} onChange={(e) => set({ sort: e.target.value })} aria-label="Sort results"><option value="">Relevance</option><option value="recent">Recently added</option></select></label>
      </div>
      {!loaded ? <CourseGridSkeleton />
        : cErr ? <div className="sb-empty" role="alert">Couldn't load the library.</div>
        : list.length === 0 ? <div className="sb-empty">Nothing matches {browse.q ? <>“{browse.q}”</> : "those filters"}.</div>
        : (
          <div className="ac-grid" role="list">
            {list.map((c) => c.format === "guide"
              ? <GuideCard key={"g" + c.id} guide={c} review={reviews.byGuide[c.id]} href={hrefOf(c)} navigate={R.navigate} />
              : c.format === "path"
                ? <PathCard key={"p" + c.id} path={c} started={!!pathProg.byPath[c.id]} href={hrefOf(c)} navigate={R.navigate} />
                : <CourseCard key={"c" + c.id} course={c} progress={progress.byCourse[c.id]} href={hrefOf(c)} navigate={R.navigate} showFormat />)}
          </div>
        )}
      <p className="ac-note">Search covers courses, tips & resources and learning paths (titles, topics and descriptions). Individual lessons open from their course.</p>
    </div>
  );
}

function CourseGridSkeleton() {
  return (
    <div className="ac-grid" aria-busy="true" aria-label="Loading courses">
      {[0, 1, 2, 3].map((i) => <div key={i} className="ac-card"><div className="ac-img sb-skel" style={{ aspectRatio: "3 / 4" }} /><Skeleton lines={2} /></div>)}
    </div>
  );
}

/* Portrait 3:4 cover card. The cover is finished artwork; NOTHING is drawn over
   it — title, category, level, lesson count and progress sit below. */
export function CourseCard({ course, progress, onOpen, href, navigate, showFormat = false, hideCategory = false }) {
  const tax = useTax();
  const summary = estimateProgress(course, progress);
  // finished (recorded) — or completed before Finish course existed (legacy)
  const finished = !!progress?.finishedAt || (!!progress && !progress.progressModel && summary.completed);
  const status = course.status !== "published" ? course.status : null;
  return (
    <div className="ac-card" role="listitem">
      <CardTarget href={href} navigate={navigate} onOpen={onOpen} className="ac-cardbtn" aria-label={`${course.title}${showFormat ? " (course)" : ""}${finished ? " (completed)" : summary.completed ? " (ready to finish)" : ""}`}>
        <StoredImage imageRef={course.cover} alt="" className="ac-cover" ratio="3 / 4" />
        <span className="ac-cardbody">
          <span className="ac-cardmeta">
            {showFormat && <span className="ac-fmt"><AcademicCapIcon className="hi hi-xs" aria-hidden="true" />Course</span>}
            {!hideCategory && <span className="ac-cat">{categoryShortIn(tax.categories, course.category)}</span>}
            {status && <Pill tone={status === "draft" ? "warn" : ""}>{status}</Pill>}
          </span>
          <span className="ac-cardtitle">{course.title}</span>
          <span className="ac-cardsub">{levelLabel(course.level)}{course.lessonCount ? ` · ${course.lessonCount} lesson${course.lessonCount === 1 ? "" : "s"}` : ""}</span>
          {finished
            ? <span className="ac-done"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />Completed</span>
            : summary.completed
            ? <><ProgressBar percent={100} compact label={`${course.title}: ready to finish`} /><span className="ac-ready">Ready to finish</span></>
            : summary.started && summary.percent > 0
              ? <><ProgressBar percent={summary.percent} compact label={`${course.title}: ${summary.percent}% complete`} /><span className="ac-cardsub">{summary.percent}% complete</span></>
              /* started (Start pressed or a lesson opened) but nothing completed yet:
                 still resumable, so say so, without an empty bar */
              : summary.started ? <span className="ac-cardsub ac-inprogress">In progress</span>
              : null}
        </span>
      </CardTarget>
    </div>
  );
}

/* Quick guide: landscape thumbnail (optional), no progress bar — only the
   learner's own "Reviewed" flag. */
export function GuideCard({ guide, review, onOpen, href, navigate }) {
  const tax = useTax();
  const status = guide.status !== "published" ? guide.status : null;
  const reviewed = guideReviewed(review);
  const video = guide.video ? videoFromRecord(guide.video) : null;
  return (
    <div className="ac-card ac-card-guide" role="listitem">
      <CardTarget href={href} navigate={navigate} onOpen={onOpen} className="ac-cardbtn" aria-label={`${guide.title} (resource)${reviewed ? " (reviewed)" : ""}`}>
        <VideoThumb item={guide} className="ac-guidethumb" placeholder={video ? <PlayIcon className="hi" aria-hidden="true" /> : <DocumentTextIcon className="hi" aria-hidden="true" />} />
        <span className="ac-cardbody">
          <span className="ac-cardmeta">
            <span className="ac-fmt"><DocumentTextIcon className="hi hi-xs" aria-hidden="true" />{guide.video ? "Video resource" : "Written resource"}</span>
            <span className="ac-cat">{categoryShortIn(tax.categories, guide.category)}</span>
            {status && <Pill tone={status === "draft" ? "warn" : ""}>{status}</Pill>}
          </span>
          <span className="ac-cardtitle">{guide.title}</span>
          <span className="ac-cardsub">{video ? `Video${guide.durationMinutes ? ` · ${formatDuration(guide.durationMinutes)}` : ""}` : "Text guide"}{guide.body ? " · with notes" : ""}</span>
          {reviewed && <span className="ac-done"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />Reviewed</span>}
        </span>
      </CardTarget>
    </div>
  );
}

/* Learning path: portrait cover like a course; the step count stands in for a
   lesson count. Percent lives on the path page (it needs the referenced docs). */
export function PathCard({ path, started = false, onOpen, href, navigate }) {
  const tax = useTax();
  const status = path.status !== "published" ? path.status : null;
  const n = (path.items || []).length;
  return (
    <div className="ac-card" role="listitem">
      <CardTarget href={href} navigate={navigate} onOpen={onOpen} className="ac-cardbtn" aria-label={`${path.title} (learning path)`}>
        <StoredImage imageRef={path.cover} alt="" className="ac-cover" ratio="3 / 4" placeholder={<MapIcon className="hi" aria-hidden="true" />} />
        <span className="ac-cardbody">
          <span className="ac-cardmeta">
            <span className="ac-fmt"><MapIcon className="hi hi-xs" aria-hidden="true" />Learning path</span>
            {path.category && <span className="ac-cat">{categoryShortIn(tax.categories, path.category)}</span>}
            {status && <Pill tone={status === "draft" ? "warn" : ""}>{status}</Pill>}
          </span>
          <span className="ac-cardtitle">{path.title}</span>
          <span className="ac-cardsub">{n} step{n === 1 ? "" : "s"}{started ? " · in progress" : ""}</span>
        </span>
      </CardTarget>
    </div>
  );
}

/* ===================================================================
   Course overview
   =================================================================== */
function CourseOverview({ me, users, isAdmin, courseId, pathCtx = null, R }) {
  const tax = useTax();
  const course = useCourse(courseId);
  const visible = !!course.data && canViewCourse(me, course.data, tax.hidden);
  const lessons = useLessons(courseId, visible);
  const progress = useProgress(me.id, courseId);

  useEffect(() => {
    if (course.data?.title) document.title = `${course.data.title} · Learn · IFC Creatives Board`;
  }, [course.data?.title]);

  if (!course.loaded || !tax.loaded) return <div className="sb-page" aria-busy="true"><BackLink to="/learn" label="Creative Academy" R={R} /><Skeleton lines={6} /></div>;
  if (!visible) return <NotAvailable R={R} />;
  // The course record is here: show its title and cover now; lessons and the
  // learner's progress fill in below as they arrive.
  if (!lessons.loaded || !progress.loaded) return <CourseHeadPending c={course.data} R={R} />;
  return <CourseOverviewBody me={me} users={users} R={R} c={course.data} lessons={lessons.docs} progress={progress.data} courseId={courseId} pathCtx={pathCtx}
    editor={canEditCourse(me, course.data)} leader={canViewLearnerProgress(me)} />;
}

function CourseHeadPending({ c, R }) {
  const tax = useTax();
  return (
    <div className="sb-page ac-course" aria-busy="true">
      <Breadcrumb R={R} items={[{ label: "Learn", to: "/learn" }, { label: categoryNameIn(tax.categories, c.category) }, { label: c.title }]} />
      <div className="ac-coursehead">
        <StoredImage imageRef={c.cover} alt="" className="ac-coursecover" ratio="3 / 4" eager />
        <div className="ac-coursemeta">
          <div className="ac-cardmeta"><span className="ac-cat">{categoryNameIn(tax.categories, c.category)}</span><Pill>{levelLabel(c.level)}</Pill></div>
          <h1 className="ac-h1">{c.title}</h1>
        </div>
        <div className="ac-coursewide"><Skeleton lines={4} /></div>
      </div>
    </div>
  );
}

/* The course's optional preview video: a labelled poster until the learner
   chooses to play it (no provider player or its scripts load before that). */
function CoursePreviewVideo({ c, video }) {
  const [play, setPlay] = useState(false);
  return (
    <section aria-labelledby="ac-prev-h" className="ac-previewvid">
      <h2 id="ac-prev-h" className="ac-h2">Course preview <span className="ac-cardsub">Optional video</span></h2>
      {play
        ? <VideoPlayer video={video} title={`${c.title}: preview video`} autoplay />
        : (
          <button type="button" className="ac-poster ac-previewposter" onClick={() => setPlay(true)} aria-label={`Play the course preview video${video.capabilities?.label ? ` (${video.capabilities.label})` : ""}`}>
            <span className="ac-img ac-img-empty" style={{ aspectRatio: "16 / 9" }} aria-hidden="true"><PlayIcon className="hi" /></span>
            <span className="ac-previewposter-label">Play preview{video.capabilities?.label ? ` · ${video.capabilities.label}` : ""}</span>
          </button>
        )}
    </section>
  );
}

/* What a course costs in time: measured video runtime (never a guess) kept
   separate from authors' reading / exercise estimates. */
function RuntimeFacts({ course, lessons }) {
  const f = courseTimeFacts(flatLessons(course, lessons), formatDuration);
  const out = f.required.map((t, i) => <span key={"r" + i}>{t}</span>);
  if (!out.length && course.durationMinutes > 0) out.push(<span key="d">{formatDuration(course.durationMinutes)}</span>);
  if (f.bonus) out.push(<span key="b">{f.bonus}</span>);
  return out;
}

/* The course page itself. `preview` = rendering the private draft. */
export function CourseOverviewBody({ me, users, R, c, lessons: lessonDocs, progress: progressData, courseId, editor, leader, preview = false, pathCtx = null }) {
  const tax = useTax();
  const online = useOnline();
  const curriculum = orderedCurriculum(c, lessonDocs);
  const summary = courseProgress(c, lessonDocs, preview ? null : progressData);
  const access = preview ? null : lessonAccess(c, lessonDocs, progressData);
  const status = preview ? "not-started" : courseStatus(summary, progressData);
  const finish = useFinishCourse(courseId);
  const celebrating = !preview && finish.result && finish.result.already === false;
  const resumeId = preview ? (flatLessons(c, lessonDocs)[0]?.id || null) : resumeLessonId(c, lessonDocs, progressData);
  const lessonHref = (id) => (preview ? learnPreviewPath(courseId, id, { path: pathCtx }) : learnPath(courseId, id, { path: pathCtx }));
  const start = async () => {
    if (!resumeId) return;
    if (!preview && !summary.started) { try { await startCourse(me.id, courseId, !!progressData); } catch {} }
    R.navigate(lessonHref(resumeId));
  };

  const trailer = c.previewVideo ? videoFromRecord(c.previewVideo) : null;
  return (
    <div className="sb-page ac-course">
      {preview && <PreviewBanner courseId={courseId} pathCtx={pathCtx} R={R} />}
      <Breadcrumb R={R} items={[{ label: "Learn", to: "/learn" }, { label: categoryNameIn(tax.categories, c.category), to: categoryIn(tax.categories, c.category) && (!categoryIn(tax.categories, c.category).hidden || isAcademyEditor(me)) ? learnCategoryPath(normalizeCategory(c.category)) : null }, { label: c.title }]} />
      {/* Compact summary beside the cover; actions, progress and the longer
          facts use the full width below it (round 7). */}
      <div className="ac-coursehead">
        <StoredImage imageRef={c.cover} alt="" className="ac-coursecover" ratio="3 / 4" eager />
        <div className="ac-coursemeta">
          <div className="ac-cardmeta">
            <span className="ac-cat">{categoryNameIn(tax.categories, c.category)}</span>
            <Pill>{levelLabel(c.level)}</Pill>
            {!preview && c.status !== "published" && <Pill tone="warn">{c.status}</Pill>}
          </div>
          <h1 className="ac-h1">{c.title}</h1>
          <div className="ac-cardsub ac-lessoncount">{summary.total} lesson{summary.total === 1 ? "" : "s"}{summary.bonusTotal > 0 ? ` + ${summary.bonusTotal} bonus` : ""}</div>
        </div>
      <div className="ac-coursewide">
          <TopicChips item={c} R={R} />
          <div className="ac-facts" aria-label="Time">
            <RuntimeFacts course={c} lessons={lessonDocs} />
          </div>
          <div className="ac-actions">
            {status === "ready" && !celebrating ? (
              /* one primary action: finish; reviewing lessons is secondary */
              <>
                <BusyButton className="sb-btn compact" busy={finish.busy} busyLabel="Finishing…" onClick={finish.run}><CheckCircleIcon className="hi hi-sm" aria-hidden="true" />Finish course</BusyButton>
                <BusyButton className="sb-btn ghost compact" onClick={start} disabled={!resumeId}><span>Review lessons</span></BusyButton>
              </>
            ) : (
              <BusyButton className={"sb-btn compact" + (status === "completed" || celebrating ? " ghost" : "")} onClick={start} disabled={!resumeId}>
                <PlayIcon className="hi hi-sm" aria-hidden="true" />{preview ? "Start course" : status === "completed" || celebrating ? "Review course" : summary.started ? "Resume" : "Start course"}
              </BusyButton>
            )}
            {curriculum.length > 0 && <a className="ac-link ac-viewlessons" href="#ac-cur-h" onClick={(e) => { e.preventDefault(); document.getElementById("ac-cur-h")?.scrollIntoView({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); document.getElementById("ac-cur-h")?.focus({ preventScroll: true }); }}>View lessons<ChevronDownIcon className="hi hi-xs" aria-hidden="true" /></a>}
            {editor && !preview && <button type="button" className="ac-link ac-editlink" onClick={() => R.navigate(learnManagePath({ view: "course", id: courseId, path: pathCtx || "" }))}><PencilSquareIcon className="hi hi-xs" aria-hidden="true" />Edit course</button>}
          </div>
          {!preview && (summary.started || status !== "not-started") && (
            <div className="ac-summary">
              {status === "completed"
                ? <span className="ac-done"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />Completed{toMs(progressData?.finishedAt) ? ` on ${longDate(toMs(progressData.finishedAt))}` : ""}</span>
                : summary.percent > 0 ? <ProgressBar percent={summary.percent} label={`${c.title}: ${summary.percent}% complete`} /> : null}
              <span className="ac-cardsub">{status === "completed" ? `${Number(progressData?.finishedRequired) || summary.total} required lessons${summary.bonusTotal ? ` · ${summary.bonusDone} of ${summary.bonusTotal} bonus` : ""}`
                : status === "ready" ? "All required lessons are complete. You're ready to finish."
                : summary.done > 0 ? `${summary.done} of ${summary.total} required lesson${summary.total === 1 ? "" : "s"} complete · ${summary.percent}%`
                : "You've started this course. No lessons completed yet."}</span>
              {status === "ready" && !online && !finish.err && <span className="ac-cardsub">You're offline. Reconnect to finish your course.</span>}
              {finish.err && <span className="ac-err" role="alert">{finish.err}</span>}
            </div>
          )}
      </div>
      </div>

      <div className="ac-coursebody">
        <div className="ac-coursemain">
          {celebrating && <CourseCelebration me={me} R={R} c={c} finishedAt={finish.result.finishedAt} required={finish.result.required ?? summary.total} pathCtx={pathCtx} />}
          {trailer && <CoursePreviewVideo c={c} video={trailer} />}
          {c.about && <section aria-labelledby="ac-about-h"><h2 id="ac-about-h" className="ac-h2">About this course</h2><Markdown src={c.about} version={c.mdVersion} /></section>}
          {!preview && <PriorKnowledge me={me} c={c} editor={editor} R={R} />}
          {preview && c.priorKnowledge?.courseIds?.length > 0 && <p className="ac-note">Draft preview. Learners also see the recommended prior knowledge you chose, limited to courses they can open.</p>}
          {c.outcomes?.length > 0 && (
            <section aria-labelledby="ac-out-h"><h2 id="ac-out-h" className="ac-h2">What you'll learn</h2>
              <ul className="ac-outcomes">{c.outcomes.map((o, i) => <li key={i}><CheckCircleIcon className="hi hi-sm" aria-hidden="true" />{o}</li>)}</ul></section>
          )}
          {c.requirements?.length > 0 && (
            <section aria-labelledby="ac-req-h"><h2 id="ac-req-h" className="ac-h2">Before you start</h2>
              <ul className="ac-plainlist">{c.requirements.map((o, i) => <li key={i}>{o}</li>)}</ul></section>
          )}
          {editor && access && access.some((a) => a.broken) && (
            <div className="ac-editorflag" role="status">
              <ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" />
              <span>Editors: {access.filter((a) => a.broken).map((a) => `“${a.lesson.title}”`).join(", ")} {access.filter((a) => a.broken).length === 1 ? "has" : "have"} broken prerequisites, so learners can't open {access.filter((a) => a.broken).length === 1 ? "it" : "them"}. <button type="button" className="ac-linkbtn" onClick={() => R.navigate(learnManagePath({ view: "course", id: courseId }))}>Fix in the workspace</button>, then publish.</span>
            </div>
          )}
          <section aria-labelledby="ac-cur-h">
            <h2 id="ac-cur-h" className="ac-h2" tabIndex={-1}>Curriculum</h2>
            {curriculum.length === 0 && <div className="sb-empty">No lessons yet.</div>}
            {access && access.some((a) => !a.accessible) && <p className="ac-note" style={{ marginTop: 0 }}>Some lessons build on others and unlock once you've completed what they need. Everything else is open, and the order shown is only a suggestion.</p>}
            <Curriculum curriculum={curriculum} progress={preview ? null : progressData} access={access} currentId={null} onOpen={(id) => R.navigate(lessonHref(id))} />
          </section>
          {!preview && editor && <QuizAttemptsPanel course={c} />}
          {!preview && leader && <LeaderProgress me={me} course={c} lessons={lessonDocs} users={users} />}
        </div>
      </div>
    </div>
  );
}

/* Recommended prior knowledge — guidance ONLY: never locks this course, never
   disables Start, never counts toward progress, never enrols anyone. Shows only
   courses this learner may open (published, visible category); anything else
   is left out without revealing its title. Editors are told when references
   are unavailable to learners. */
export function PriorKnowledge({ me, c, editor = false, R }) {
  const tax = useTax();
  const ids = useMemo(() => [...new Set((c.priorKnowledge?.courseIds || []).map(String))].filter((id) => id && id !== c.id), [c.priorKnowledge, c.id]);
  const refs = useMemo(() => ids.map((id) => `courses/${id}`), [ids]);
  const docs = useManyDocs(refs);
  const progress = useAllProgress(me.id);
  const note = String(c.priorKnowledge?.note || "").trim();
  if (!ids.length && !note) return null;
  if (!docs.loaded) return null;
  const visible = ids.map((id) => docs.byPath[`courses/${id}`]).filter((d) => d && d.status === "published" && canViewCourse(me, d, tax.hidden)
    && !(categoryIn(tax.categories, d.category)?.hidden));
  const unavailable = ids.length - visible.length;
  if (!visible.length && !note && !(editor && unavailable)) return null;
  const doneOf = (d) => { const p = progress.byCourse[d.id]; const e = estimateProgress(d, p); return !!p && (!!p.finishedAt || (e.completed && !p.progressModel)); };
  return (
    <section className="ac-prior-learn" aria-labelledby="ac-prior-h">
      <h2 id="ac-prior-h" className="ac-h2">Recommended prior knowledge</h2>
      <p className="ac-cardsub">This course assumes some familiarity with the topics below. If you already have that knowledge, you can start straight away.</p>
      {visible.length > 0 && (
        <ul className="ac-priorcards" aria-label="Recommended courses">
          {visible.map((d) => {
            const done = doneOf(d);
            return (
              <li key={d.id}>
                <AppLink className="ac-priorcard" to={learnPath(d.id)} navigate={R.navigate} aria-label={`View course: ${d.title}${done ? " (completed)" : ""}`}>
                  <StoredImage imageRef={d.cover} alt="" className="ac-priorcover" ratio="3 / 4" placeholder={<AcademicCapIcon className="hi" aria-hidden="true" />} />
                  <span className="ac-priorbody">
                    <span className="ac-cat">{categoryShortIn(tax.categories, d.category)}</span>
                    <span className="ac-priorctitle">{d.title}</span>
                    {done && <span className="ac-done"><CheckCircleSolid className="hi hi-xs" aria-hidden="true" />Completed</span>}
                    <span className="ac-priorview" aria-hidden="true">View course<ChevronRightIcon className="hi hi-xs" /></span>
                  </span>
                </AppLink>
              </li>
            );
          })}
        </ul>
      )}
      {note && <p className="ac-priornote">{note}</p>}
      {editor && unavailable > 0 && (
        <p className="ac-editorflag compact">
          <ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />
          <span>{unavailable} recommended course{unavailable === 1 ? " isn't" : "s aren't"} available to learners.</span>
          <AppLink className="ac-link" to={learnManagePath({ view: "course", id: c.id, item: "details", focus: "prior" })} navigate={R.navigate}>Review recommendations</AppLink>
        </p>
      )}
    </section>
  );
}

function NotAvailable({ R, what = "course" }) {
  return (
    <div className="sb-page">
      <BackLink to="/learn" label="Creative Academy" R={R} />
      <div className="sb-empty"><LockClosedIcon className="hi" aria-hidden="true" /><p>This {what} isn't available. It may be unpublished, archived or removed.</p></div>
    </div>
  );
}

/* Ordered modules → lessons with completed / current / upcoming / locked state.
   `access` (lessonAccess) is null in the draft preview — nothing is locked there. */
function Curriculum({ curriculum, progress, access = null, currentId, onOpen, compact = false }) {
  let n = 0;
  return (
    <div className={"ac-curriculum" + (compact ? " compact" : "")}>
      {curriculum.map((m) => (
        <div key={m.id} className="ac-module">
          {m.title && <div className="ac-modtitle">{m.title}</div>}
          <ol className="ac-lessons">
            {m.lessons.map((l) => {
              n += 1;
              const st = lessonState(l, progress);
              const a = access ? accessFor(access, l.id) : null;
              const locked = !!a && !a.accessible;
              const current = l.id === currentId;
              const meta = <>
                {" · " + lessonKindMeta(l).label}
                {l.bonus && " · Optional"}
                {st.quizRequired && " · Quiz required"}
                {l.durationMinutes > 0 && ` · ${formatDuration(l.durationMinutes)}`}
              </>;
              if (locked) {
                return (
                  <li key={l.id}>
                    <div className={"ac-lesson locked" + (current ? " current" : "")} aria-current={current ? "page" : undefined}>
                      <span className="ac-lessonidx" aria-hidden="true"><LockClosedIcon className="hi hi-xs" /></span>
                      <span className="ac-lessontxt">
                        <span className="ac-lessontitle">{l.title || "Untitled lesson"}<span className="sb-vh"> (locked)</span></span>
                        <span className="ac-lessonsub">{a.broken ? "Unavailable · its setup needs fixing" : a.missing.length > 1 ? `Locked · ${a.missing.length} lessons to complete first` : `Locked · complete “${a.blockedBy?.title || "its prerequisite"}” first`}{meta}</span>
                      </span>
                    </div>
                  </li>
                );
              }
              const cls = "ac-lesson" + (st.completed ? " done" : "") + (current ? " current" : "");
              return (
                <li key={l.id}>
                  <button type="button" className={cls} onClick={() => onOpen(l.id)} aria-current={current ? "page" : undefined}>
                    <span className="ac-lessonidx" aria-hidden="true">{st.completed ? <CheckCircleSolid className="hi hi-sm" /> : n}</span>
                    <span className="ac-lessontxt">
                      <span className="ac-lessontitle">{l.title || "Untitled lesson"}</span>
                      <span className="ac-lessonsub">
                        {st.completed ? "Completed" : current ? "Current" : st.viewed ? "In progress" : a ? "Open" : "Upcoming"}{meta}
                      </span>
                    </span>
                    <ChevronRightIcon className="hi hi-sm ac-chev" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
}

/* A learning-path step's link, always carrying the path context. A lesson step
   whose prerequisites aren't met still opens that lesson: its locked view says
   what unlocks it and links to the prerequisite (context kept) — a path never
   bypasses prerequisites. */
function pathStepHref(it, pathId) {
  if (it.type === "lesson") return learnPath(it.courseId, it.lessonId, { path: pathId });
  return it.type === "course" ? learnPath(it.courseId, null, { path: pathId }) : learnGuidePath(it.guideId);
}

/* Leaders (admin / department lead): who has started this course and how far
   they are, with each learner's attempts on limited quizzes. Academy editors
   can give a learner more attempts here (server-checked; attempt history and
   scores are kept; who granted and when is recorded). Learners never see this. */
function LeaderProgress({ me, course, lessons, users }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const rows = useLeaderProgress(course.id, open);
  const attempts = useLeaderAttempts(course.id, open);
  const byUid = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const attemptsBy = useMemo(() => {
    const m = new Map();
    for (const a of attempts.docs) {
      m.set(a.uid, (m.get(a.uid) || 0) + 1);
      const k = `${a.uid}/${a.lessonId}`; m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [attempts.docs]);
  const quizLessons = flatLessons(course, lessons).filter((l) => quizMode(l) !== "none");
  return (
    <section className="ac-leader" aria-labelledby="ac-leader-h">
      <div className="sb-shead">
        <h2 id="ac-leader-h" className="ac-h2">Learner progress</h2>
        <button type="button" className="sb-btn quiet compact" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"}</button>
      </div>
      {open && (
        !rows.loaded ? <Skeleton lines={3} />
        : rows.error ? <div className="sb-empty" role="alert">Couldn't load learner progress.</div>
        : rows.docs.length === 0 ? <div className="sb-empty">Nobody has started this course yet.</div>
        : (
          <table className="ac-table">
            <thead><tr><th scope="col">Learner</th><th scope="col">Progress</th><th scope="col">Quiz attempts</th><th scope="col">Last active</th></tr></thead>
            <tbody>
              {rows.docs.map((p) => {
                const s = courseProgress(course, lessons, p);
                const status = courseStatus(s, p);
                const u = byUid.get(p.uid);
                const isOpen = expanded === p.uid;
                return (
                  <React.Fragment key={p.uid}>
                    <tr>
                      <td>{u?.name || "Former member"}</td>
                      <td><div className="ac-tdprog"><ProgressBar percent={s.percent} compact label={`${u?.name || "Learner"}: ${s.percent}%`} /><span>{s.done}/{s.total}{status === "completed" ? " ✓ completed" : status === "ready" ? " · ready to finish" : ""}</span></div></td>
                      <td>{attemptsBy.get(p.uid) || 0}{quizLessons.length > 0 && <> · <button type="button" className="ac-linkbtn" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : p.uid)}>{isOpen ? "Hide details" : "Details"}</button></>}</td>
                      <td>{p.lastViewedAt ? formatDateTime(toMs(p.lastViewedAt)) : "Not yet"}</td>
                    </tr>
                    {isOpen && (
                      <tr className="ac-leaderdetail"><td colSpan={4}>
                        <ul className="ac-attemptlist">
                          {quizLessons.map((l) => <AttemptRow key={l.id} lesson={l} course={course} progress={p} used={attemptsBy.get(`${p.uid}/${l.id}`) || 0} name={u?.name || "This learner"} staff={false} />)}
                        </ul>
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )
      )}
      <p className="ac-note">Completing a course is a learning milestone, not approval to serve. Team leads still handle scheduling.</p>
    </section>
  );
}

/* Academy editors (whether or not they're leads): attempts on this course's
   LIMITED quizzes, with "Give 1 more attempt". Uses the scoped server view
   (quizAttemptStatus) — names and attempt counts for this course only, nothing
   else about learners or teams. Requests from learners show first. */
function QuizAttemptsPanel({ course }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState({ loading: false, err: "", data: null });
  const [rowState, setRowState] = useState({});
  const load = useCallback(async () => {
    setSt((x) => ({ ...x, loading: true, err: "" }));
    try { requireOnline(); setSt({ loading: false, err: "", data: await quizAttemptStatus(course.id) }); }
    catch (e) { setSt({ loading: false, err: isOfflineError(e) ? "You're offline. Reconnect to see quiz attempts." : "Couldn't load quiz attempts.", data: null }); }
  }, [course.id]);
  useEffect(() => { if (open) load(); }, [open, load]);
  const give = async (r) => {
    const k = `${r.uid}/${r.lessonId}`;
    setRowState((s) => ({ ...s, [k]: { busy: true } }));
    try {
      requireOnline();
      const res = await grantQuizAttempts(r.uid, course.id, r.lessonId, 1);
      setRowState((s) => ({ ...s, [k]: { msg: `${r.name} now has ${res.allowed} attempts.` } }));
      await load();
    } catch (e) {
      setRowState((s) => ({ ...s, [k]: { err: isOfflineError(e) ? "You're offline, so nothing changed." : (e?.message && e.message.length < 140 ? e.message : "Couldn't give another attempt.") } }));
    }
  };
  const rows = st.data?.rows || [];
  return (
    <section className="ac-leader" aria-labelledby="ac-qa-h">
      <div className="sb-shead">
        <h2 id="ac-qa-h" className="ac-h2">Quiz attempts</h2>
        <button type="button" className="sb-btn quiet compact" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"}</button>
      </div>
      {open && (
        st.loading && !st.data ? <Skeleton lines={3} />
        : st.err ? <div className="sb-empty" role="alert">{st.err} <button type="button" className="ac-linkbtn" onClick={load}>Try again</button></div>
        : !st.data?.quizzes?.length ? <div className="sb-empty">This course has no quizzes with an attempt limit.</div>
        : rows.length === 0 ? <div className="sb-empty">No one has used attempts on this course's limited quizzes yet.</div>
        : (
          <ul className="ac-attemptlist ac-qalist">
            {rows.map((r) => {
              const k = `${r.uid}/${r.lessonId}`; const rs = rowState[k] || {};
              return (
                <li key={k} className={r.requestedAt && !r.passed ? "asked" : ""}>
                  <span><b>{r.name}</b> · {r.lessonTitle}</span>
                  <span className="ac-cardsub">{r.used} of {r.allowed} attempts used{r.extra ? ` (incl. ${r.extra} extra)` : ""}{r.passed ? " · passed" : r.exhausted ? " · out of attempts" : ""}{r.requestedAt && !r.passed ? ` · asked for another attempt ${formatDateTime(r.requestedAt)}` : ""}{r.lastGrant ? ` · last extra attempt from ${r.lastGrant.byName || "Academy staff"}${r.lastGrant.at ? ` on ${formatDateTime(r.lastGrant.at)}` : ""}` : ""}</span>
                  {!r.passed && <BusyButton className="sb-btn ghost compact" busy={!!rs.busy} busyLabel="Giving…" onClick={() => give(r)}>Give 1 more attempt</BusyButton>}
                  {rs.msg && <span className="ac-done" role="status">{rs.msg}</span>}
                  {rs.err && <span className="ac-err" role="alert">{rs.err}</span>}
                </li>
              );
            })}
          </ul>
        )
      )}
      <p className="ac-note">Shows only attempts on this course's limited quizzes. Extra attempts keep the learner's history and scores, and record who gave them.</p>
    </section>
  );
}

function AttemptRow({ lesson, course, progress, used, name, staff }) {
  const [state, setState] = useState({ busy: false, msg: "", err: "" });
  const grant = progress.attemptGrants?.[lesson.id];
  const extra = Number(grant?.extra) || 0;
  const gate = canAttemptQuiz(lesson.quiz, used, extra);
  const passed = !!progress.earned?.[lesson.id];
  const last = Array.isArray(grant?.history) && grant.history.length ? grant.history[grant.history.length - 1] : null;
  const give = async () => {
    setState({ busy: true, msg: "", err: "" });
    try {
      requireOnline();
      const r = await grantQuizAttempts(progress.uid, course.id, lesson.id, 1);
      setState({ busy: false, msg: `${name} now has ${r.allowed} attempts in total.`, err: "" });
    } catch (e) {
      setState({ busy: false, msg: "", err: isOfflineError(e) ? "You're offline, so nothing changed." : (e?.message && e.message.length < 140 ? e.message : "Couldn't give another attempt. Please try again.") });
    }
  };
  return (
    <li>
      <span><b>{lesson.title}</b> <span className="ac-cardsub">{quizMode(lesson) === "required" ? "required quiz" : "practice quiz"}</span></span>
      <span className="ac-cardsub">{gate.allowed == null ? `${used} attempt${used === 1 ? "" : "s"} · unlimited` : `${used} of ${gate.allowed} attempts used${extra ? ` (incl. ${extra} extra)` : ""}`}{passed ? " · passed" : ""}{last ? ` · last extra attempt given by ${last.byName || "Academy staff"}${last.at ? ` on ${formatDateTime(toMs(last.at))}` : ""}` : ""}</span>
      {staff && gate.allowed != null && !passed && (
        <BusyButton className="sb-btn ghost compact" busy={state.busy} busyLabel="Giving…" onClick={give}>Give 1 more attempt</BusyButton>
      )}
      {state.msg && <span className="ac-done" role="status">{state.msg}</span>}
      {state.err && <span className="ac-err" role="alert">{state.err}</span>}
    </li>
  );
}

/* ===================================================================
   Lesson
   =================================================================== */
function LessonView({ me, users, isAdmin, courseId, lessonId, pathCtx = null, R }) {
  const tax = useTax();
  const course = useCourse(courseId);
  const visible = !!course.data && canViewCourse(me, course.data, tax.hidden);
  const lessons = useLessons(courseId, visible);
  const progress = useProgress(me.id, courseId);
  const lesson = lessons.docs.find((l) => l.id === lessonId);
  const ready = course.loaded && lessons.loaded && progress.loaded;
  // A locked lesson (an earlier required one isn't complete) isn't a visit.
  const open = ready && visible && !!lesson && (accessFor(lessonAccess(course.data, lessons.docs, progress.data), lessonId)?.accessible ?? true);

  // Record the visit once per lesson (lastLessonId drives "Resume").
  const recorded = useRef(null);
  useEffect(() => {
    if (!open || recorded.current === lessonId) return;
    recorded.current = lessonId;
    recordLessonView(me.id, courseId, lessonId, !!progress.data).catch(() => {});
  }, [open, lessonId, me.id, courseId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (lesson?.title) document.title = `${lesson.title} · Learn · IFC Creatives Board`; }, [lesson?.title]);

  if (!ready) return <div className="sb-page"><Skeleton lines={8} /></div>;
  if (!visible) return <NotAvailable R={R} />;
  return <LessonBody me={me} users={users} R={R} c={course.data} lessons={lessons.docs} progress={progress.data} courseId={courseId} lessonId={lessonId} pathCtx={pathCtx} editor={canEditCourse(me, course.data)} />;
}

/* How THIS lesson is completed (drives the completion area and the Next reason):
     quiz         — a required quiz: passing it (server-graded) is the only way
     watch        — a video on a provider that reports playback: watch to the end
     unavailable  — that video can't play (unsupported link / player failed):
                    a blocker to report, never a manual bypass
     manual-video — a video on a provider that can't report playback (Drive):
                    the learner marks it watched
     manual       — no video: written / exercise / resource, marked complete */
function completionMethod(lesson, video, playerFailed) {
  if (quizMode(lesson) === "required") return "quiz";
  if (lesson.video && !video) return "unavailable";
  if (video && video.capabilities.tracksEnded) return playerFailed ? "unavailable" : "watch";
  if (video) return "manual-video";
  return "manual";
}
const COMPLETE_COPY = {
  written: { action: "Complete lesson", hint: "Finished reading? Mark this lesson complete.", done: "Lesson completed" },
  video: { action: "Complete lesson", hint: "Finished this lesson? Mark it complete.", done: "Lesson completed" },
  exercise: { action: "Complete exercise", hint: "Done the exercise? Mark it complete. This records that you did it. It isn't graded.", done: "Exercise completed" },
  resource: { action: "Mark as reviewed", hint: "Looked through the resources? Mark them reviewed. This records that you've seen them. It isn't an assessment.", done: "Resources reviewed" },
};
const DRIVE_COPY = { action: "Mark as watched", done: "Lesson completed" };

/* Self-reported / video completion → the completeLesson callable (the server
   checks the order). `phase`: idle → saving (call in flight) → confirming (call
   succeeded; waiting for the server-written flag to arrive in the progress
   snapshot) → idle. The UI only says "completed" once that flag is here. */
function useLessonCompletion(me, courseId, lessonId, st) {
  const [s, setS] = useState({ phase: "idle", err: "", how: null, done: null });
  const token = useRef(0);
  useEffect(() => { token.current += 1; setS({ phase: "idle", err: "", how: null, done: null }); }, [lessonId]);
  const arrived = s.phase === "confirming" && !!st && (s.how === "video" ? st.videoWatched : st.manualDone === s.done);
  useEffect(() => { if (arrived) setS({ phase: "idle", err: "", how: null, done: null }); }, [arrived]);
  const run = async (done = true, how = "manual") => {
    if (s.phase !== "idle") return;
    const t = token.current;
    setS({ phase: "saving", err: "", how, done });
    try {
      requireOnline();
      await (how === "video" ? markVideoWatched(me.id, courseId, lessonId) : setManualDone(me.id, courseId, lessonId, done));
      if (t === token.current) setS((x) => ({ ...x, phase: "confirming" }));
    } catch (e) {
      if (t !== token.current) return;
      const msg = isOfflineError(e) ? "You're offline, so nothing was saved. Reconnect, then try again."
        : e?.message && e.message.length < 140 && /^functions\/(failed-precondition|permission-denied|not-found)/.test(e?.code || "") ? e.message
        : "Couldn't save your progress. Please try again.";
      setS({ phase: "idle", err: msg, how, done: null });
    }
  };
  return { ...s, busy: s.phase !== "idle", run };
}

/* Finish course → the finishCourse callable (server-verified, idempotent).
   `result` is what THIS tab's call returned: { already:false } means this click
   recorded the finish (celebrate); { already:true } means it was already
   finished (another tab / device) — no celebration. Cleared on navigation, so a
   refresh or revisit never replays the celebration. */
function useFinishCourse(courseId, resetKey = null) {
  const [s, setS] = useState({ busy: false, err: "", result: null });
  const inflight = useRef(false);
  useEffect(() => { setS({ busy: false, err: "", result: null }); }, [courseId, resetKey]);
  const run = useCallback(async () => {
    if (inflight.current) return;                      // double-click: one call
    inflight.current = true;
    setS({ busy: true, err: "", result: null });
    try {
      requireOnline();
      const r = await finishCourse(courseId);
      setS({ busy: false, err: "", result: r || { already: true } });
    } catch (e) {
      const msg = isOfflineError(e) ? "You're offline, so your course wasn't finished. Reconnect, then try again."
        : e?.code === "functions/failed-precondition" && e?.message ? `${e.message} Complete ${/ is still/.test(e.message) ? "it" : "them"}, then finish the course.`
        : "Couldn't finish the course right now, and nothing changed. Please try again.";
      setS({ busy: false, err: msg, result: null });
    } finally { inflight.current = false; }
  }, [courseId]);
  return { ...s, run };
}

const longDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "");

/* The lesson page. `preview` = rendering the private draft: nothing is
   recorded, nothing is locked, the quiz isn't graded and the discussion is
   hidden. */
export function LessonBody({ me, users, R, c, lessons: lessonDocs, progress: progressData, courseId, lessonId, preview = false, editor = false, pathCtx = null }) {
  const [playing, setPlaying] = useState(false);
  const desktop = useMediaQuery("(min-width: 1000px)");
  const [showCur, setShowCur] = useState(false);
  const [playerFailed, setPlayerFailed] = useState(false);
  useEffect(() => { setShowCur(false); setPlayerFailed(false); setPlaying(false); }, [lessonId]);
  const progress = preview ? null : progressData;
  const lesson = lessonDocs.find((l) => l.id === lessonId);
  const st = lesson ? lessonState(lesson, progress) : null;
  // Completed DURING this visit → the full confirmation; a lesson that was
  // already complete on arrival gets only the small status (no repeat celebration).
  const doneOnArrival = useRef(null);
  if (doneOnArrival.current?.id !== lessonId && st) doneOnArrival.current = { id: lessonId, done: !!st.completed };
  const freshDone = !!st?.completed && doneOnArrival.current?.done === false;
  const completion = useLessonCompletion(me, courseId, lessonId, st);
  const finish = useFinishCourse(courseId, lessonId);
  // learning-path context travels with every in-course navigation
  const courseHref = preview ? learnPreviewPath(courseId, null, { path: pathCtx }) : learnPath(courseId, null, { path: pathCtx });
  const go = (id) => R.navigate(preview ? learnPreviewPath(courseId, id) : learnPath(courseId, id, { path: pathCtx }));
  if (!lesson) {
    return <div className="sb-page">{preview && <PreviewBanner courseId={courseId} pathCtx={pathCtx} R={R} />}<BackLink to={courseHref} label={c.title} R={R} /><div className="sb-empty">That lesson isn't in this course any more.</div></div>;
  }
  const access = preview ? null : lessonAccess(c, lessonDocs, progress);
  const here = access ? accessFor(access, lessonId) : null;
  const curriculum = orderedCurriculum(c, lessonDocs);
  const nb = lessonNeighbours(c, lessonDocs, lessonId);
  const summary = courseProgress(c, lessonDocs, progress);

  // Desktop: the curriculum sits beside the lesson. Phones: ONE compact row at
  // the top (back to the course + the lesson list), the player right below.
  const side = desktop ? (
    <aside className="ac-side" aria-label="Course curriculum">
      <div className="ac-sidehead"><span className="sb-mlabel">Curriculum</span><span className="ac-cardsub">{summary.percent}%</span></div>
      <Curriculum curriculum={curriculum} progress={progress} access={access} currentId={lessonId} onOpen={go} compact />
    </aside>
  ) : (
    <div className="ac-lessonnav">
      <div className="ac-lessonnav-row">
        <BackLink to={courseHref} label={c.title} R={R} />
        <button type="button" className="ac-sidetoggle" aria-expanded={showCur} aria-controls="ac-lessonlist" onClick={() => setShowCur((v) => !v)}
          aria-label={`Course lessons, lesson ${nb.index + 1} of ${nb.count}`}>
          <span>Lessons <span className="ac-sidetoggle-n">{nb.index + 1}/{nb.count}</span></span><ChevronDownIcon className={"hi hi-sm" + (showCur ? " ac-flip" : "")} aria-hidden="true" />
        </button>
      </div>
      {showCur && <aside id="ac-lessonlist" className="ac-side" aria-label="Course curriculum"><Curriculum curriculum={curriculum} progress={progress} access={access} currentId={lessonId} onOpen={go} compact /></aside>}
    </div>
  );
  const page = (main) => <div className={"sb-page ac-lessonpage" + (desktop ? " desktop" : "")}>{desktop ? <>{main}{side}</> : <>{side}{main}</>}</div>;

  // Locked (direct URL, refresh, back/forward, an old link): explain, offer the
  // way forward, and render none of the lesson's content.
  if (here && !here.accessible) {
    return page(<LockedLesson c={c} lesson={lesson} here={here} access={access} index={nb.index} count={nb.count} courseHref={courseHref} editor={editor} courseId={courseId} lessonId={lessonId} go={go} R={R} />);
  }

  const video = lesson.video ? videoFromRecord(lesson.video) : null;
  const mode = quizMode(lesson);
  const method = completionMethod(lesson, video, playerFailed);
  const required = isRequiredLesson(lesson);

  // Next follows the displayed order. It's enabled when that lesson's
  // prerequisites are met (confirmed progress — completion flags are
  // server-written, so nothing unlocks optimistically); otherwise it says
  // exactly what unlocks it and offers a route, never a dead end.
  const nextA = nb.next && access ? accessFor(access, nb.next.id) : null;
  const nextOpen = preview || !nb.next || !!nextA?.accessible;
  let nextReason = null, nextRoute = null, nextAlt = null;
  if (nb.next && !preview && !nextOpen) {
    const missing = nextA?.missing || [];
    if (completion.busy) nextReason = "Saving your progress…";
    else if (nextA?.broken) nextReason = "The next lesson isn't available right now because its setup needs fixing.";
    else if (missing.length === 1 && missing[0].id === lessonId) {
      nextReason = method === "quiz" ? "Pass the quiz to unlock the next lesson."
        : method === "watch" ? "Watch the video to the end to unlock the next lesson."
        : method === "unavailable" ? (playerFailed ? "This lesson's video didn't play here, so the next lesson can't unlock yet." : "This lesson's video isn't available, so the next lesson can't unlock yet.")
        : "Complete this lesson to unlock the next one.";
    } else {
      const names = missing.map((m) => (m.id === lessonId ? "this lesson" : `“${m.title || "an earlier lesson"}”`));
      nextReason = `Complete ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]} to unlock the next lesson.`;
      const r = actionableFor(access, nb.next.id);
      if (r && r.id !== lessonId) nextRoute = r;
    }
    // another lesson the learner can open right now (keeps the flow going)
    const alt = access.find((a) => a.accessible && !a.completed && a.id !== lessonId && a.id !== nb.next.id && a.id !== nextRoute?.id);
    if (alt) nextAlt = alt.lesson;
  }
  // Does completing THIS lesson unlock the next one? Only when the next lesson
  // lists it as a prerequisite (explicit prerequisites only; no implied order).
  const unlocksNext = !!nb.next && !preview && !nextOpen && !!nextA?.missing?.some((m) => m.id === lessonId);
  const status = courseStatus(summary, progress);
  // Finish course (or the finished state) owns the primary action; Next goes quiet
  const finishFirst = !preview && (status === "ready" || status === "completed" || !!finish.result);

  const main = (
    <div className="ac-lessonmain">
      {preview && <PreviewBanner courseId={courseId} lessonId={lessonId} pathCtx={pathCtx} R={R} />}
      {desktop && <BackLink to={courseHref} label={c.title} R={R} />}
      <div className="ac-lessonplayer">
        {lesson.video && !video && <UnsupportedVideo />}
        {video && !playing && (
          /* Pre-play poster: the lesson's chosen thumbnail (custom upload or the
             provider's own artwork). Once playing, the provider player may show its own. */
          <button type="button" className="ac-poster" onClick={() => setPlaying(true)} aria-label={`Play video: ${lesson.title}${st.positionSec > 5 ? " (resumes where you left off)" : ""}`}>
            <VideoThumb item={{ ...lesson, video }} placeholder={<PlayIcon className="hi" aria-hidden="true" />} />
            <span className="ac-playbadge" aria-hidden="true"><PlayIcon className="hi" /></span>
          </button>
        )}
        {video && playing && (
          <VideoPlayer key={lessonId} video={video} title={lesson.title} autoplay meta={lesson.videoMeta}
            resumeSec={st.positionSec} durationHint={st.durationSec}
            onProgress={preview ? undefined : (pos, dur) => savePlayback(me.id, courseId, lessonId, { positionSec: pos, durationSec: dur }).catch(() => {})}
            onEnded={preview ? undefined : () => { if (!st.videoWatched && method === "watch") completion.run(true, "video"); }}
            onFailed={(v) => setPlayerFailed(v !== false)} />
        )}
        {!lesson.video && lesson.thumb && <div className="ac-novideo"><StoredImage imageRef={lesson.thumb} alt="" ratio="16 / 9" /></div>}
      </div>
      <div className="ac-lessonhead">
        <div className="ac-cardmeta"><span className="ac-cat">Lesson {nb.index + 1} of {nb.count}</span><Pill>{lessonKindMeta(lesson).label}</Pill>{lesson.bonus && <Pill>Optional</Pill>}{lesson.video ? (lesson.videoMeta?.isLive ? <span className="ac-cardsub">Live</span> : lesson.videoMeta?.durationSec > 0 && <span className="ac-cardsub">{formatClock(lesson.videoMeta.durationSec)}</span>) : lesson.durationMinutes > 0 && <span className="ac-cardsub">{formatDuration(lesson.durationMinutes)}</span>}</div>
        <div className="ac-titlerow"><h1 className="ac-h1">{lesson.title}</h1>
          {editor && !preview && <button type="button" className="sb-btn ghost compact" onClick={() => R.navigate(learnManagePath({ view: "course", id: courseId, item: lessonId, path: pathCtx || "" }))} aria-label={`Edit lesson ${lesson?.title || ""}`.trim()}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Edit lesson</button>}</div>
        {!preview && <LessonStatus st={st} required={required} />}
      </div>

      {lesson.description && <section aria-labelledby="ac-desc-h"><h2 id="ac-desc-h" className="sb-vh">About this lesson</h2><Markdown src={lesson.description} version={lesson.mdVersion} /></section>}

      {lesson.resources?.length > 0 && (
        <section aria-labelledby="ac-res-h">
          <h2 id="ac-res-h" className="ac-h2">Resources</h2>
          <ul className="ac-resources">
            {lesson.resources.map((r, i) => /^https?:\/\//i.test(r.url) && (
              <li key={i}><a className="ac-resrow" href={r.url} target="_blank" rel="noopener noreferrer nofollow">
                <span className="ac-restext"><span className="ac-restitle">{r.label || hostOf(r.url)}</span><span className="ac-ressite">{hostOf(r.url)}</span></span>
                <ArrowTopRightOnSquareIcon className="hi hi-sm" aria-hidden="true" /><span className="sb-vh"> (opens in a new tab)</span>
              </a></li>
            ))}
          </ul>
        </section>
      )}

      {mode !== "none" && <QuizPanel key={lessonId} lesson={lesson} courseId={courseId} me={me} state={st} courseTitle={c.title} extraAttempts={Number(progress?.attemptGrants?.[lessonId]?.extra) || 0} requestedAt={progress?.attemptRequests?.[lessonId]?.at || null} {...(preview ? { submit: previewSubmit, attemptsHook: noAttempts } : {})} />}

      <CompletionArea c={c} lesson={lesson} st={st} method={method} video={video} playerFailed={playerFailed} required={required} completion={completion} preview={preview} quiet={finishFirst} fresh={freshDone} unlocksNext={unlocksNext} hasNext={!!nb.next} />

      {!preview && (
        <CourseEnd me={me} R={R} c={c} lessons={lessonDocs} progress={progress} access={access} summary={summary} status={status} pathCtx={pathCtx}
          finish={finish} saving={completion.busy} isLast={!nb.next} lessonId={lessonId} go={go} />
      )}

      <nav className="ac-pager" aria-label="Lesson navigation">
        {nb.prev
          ? <button type="button" className="sb-btn ghost compact ac-pagerbtn" onClick={() => go(nb.prev.id)}><ArrowLeftIcon className="hi hi-sm" aria-hidden="true" /><span className="ac-pagerlbl"><span>Previous</span><span className="ac-pagersub">{nb.prev.title}</span></span></button>
          : <span />}
        {nb.next && (
          <div className="ac-pagernext">
            <button type="button" className={"sb-btn compact ac-pagerbtn next" + (finishFirst ? " ghost" : "")} disabled={!nextOpen}
              aria-describedby={nextReason ? "ac-next-why" : undefined} onClick={() => go(nb.next.id)}>
              <span className="ac-pagerlbl"><span>Next lesson</span><span className="ac-pagersub">{nb.next.title}{nb.next.bonus ? " · Optional" : ""}</span></span>
              {!nextOpen && !completion.busy ? <LockClosedIcon className="hi hi-sm" aria-hidden="true" /> : <ChevronRightIcon className="hi hi-sm" aria-hidden="true" />}
            </button>
            {nextReason && <p id="ac-next-why" className="ac-pagerwhy" aria-live="polite">{nextReason}</p>}
            {(nextRoute || nextAlt) && !completion.busy && (
              <p className="ac-pagerroute">
                {nextRoute && <button type="button" className="ac-linkbtn" onClick={() => go(nextRoute.id)}>Go to “{nextRoute.title}”</button>}
                {nextAlt && <>{nextRoute ? " · " : ""}<button type="button" className="ac-linkbtn" onClick={() => go(nextAlt.id)}>Or open “{nextAlt.title}”</button></>}
              </p>
            )}
          </div>
        )}
        {!nb.next && preview && <button type="button" className="sb-btn ghost compact" onClick={() => R.navigate(learnPreviewPath(courseId))}><span>Back to the course</span></button>}
      </nav>

      {!preview && <Discussion me={me} ownerDoc={c} scope={{ courseId, lessonId }} users={users} />}
    </div>
  );
  return page(main);
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

function UnsupportedVideo() {
  return <div className="ac-videomsg" role="status"><ExclamationTriangleIcon className="hi" aria-hidden="true" /><p>This lesson's video link isn't supported. An Academy editor needs to update the link.</p></div>;
}

/* Status near the heading: a compact state only (the instructions and the
   action live in the completion area, so nothing is said twice). */
function LessonStatus({ st, required }) {
  if (st.completed) return <p className="ac-lessonstatus done"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />Completed</p>;
  if (!required) return <p className="ac-lessonstatus">Optional lesson</p>;
  return null;
}

/* The completion area: after the lesson content (and quiz), before Discussion.
   One clear next action per state; "completed" only once the server-written
   flag has arrived. */
function CompletionArea({ c, lesson, st, method, video, playerFailed = false, required, completion, preview = false, quiet = false, fresh = true, unlocksNext = false, hasNext = false }) {
  const online = useOnline();
  const kind = lessonKind(lesson);
  // What finishing this lesson does, from the real prerequisites: it unlocks
  // the next lesson only when that lesson requires this one.
  const effect = unlocksNext ? " It unlocks the next lesson." : "";
  const base = method === "manual-video" ? { ...DRIVE_COPY, hint: `${video?.capabilities.label || "This provider"} doesn't report playback, so mark this lesson watched once you've seen the whole video.` } : (COMPLETE_COPY[kind] || COMPLETE_COPY.written);
  const copy = { ...base, hint: `${base.hint}${effect}` };
  const optional = !required ? <p className="ac-cardsub">Optional. You can skip this lesson. It doesn't count toward finishing the course.</p> : null;
  if (preview) {
    return (
      <section className="ac-completion is-preview" aria-label="Lesson completion">
        <p className="ac-note" style={{ margin: 0 }}>Draft preview. Learners complete this lesson here ({method === "quiz" ? "by passing the quiz" : method === "watch" ? "by watching the video to the end" : method === "unavailable" ? "once the video link works" : `with “${copy.action}”`}). Lessons that list it as a prerequisite open once it's complete. Nothing is recorded or locked while previewing.</p>
      </section>
    );
  }
  const saving = completion.busy;
  const status = (
    <>
      {completion.phase === "confirming" && <p className="ac-savestate muted" role="status">Saving your progress…</p>}
      {completion.err && <p className="ac-err" role="alert">{completion.err}</p>}
    </>
  );
  if (st.completed) {
    const how = method === "quiz" ? "You passed the quiz." : st.videoWatched ? "You watched the video to the end."
      : st.manualDone ? "You marked this complete. It records that you've been through it. It isn't an assessment." : "";
    const undo = st.manualDone && !st.videoWatched && (method === "manual" || method === "manual-video");
    // Already complete when the learner arrived: the status near the title says
    // so; only the undo link (when there is one) remains here.
    if (!fresh) {
      return undo || completion.phase === "confirming" || completion.err ? (
        <section className="ac-completion is-quiet" aria-label="Lesson completion">
          {undo && <button type="button" className="ac-linkbtn" onClick={() => completion.run(false)} disabled={saving}>{saving ? "Saving…" : "Mark as not complete"}</button>}
          {status}
        </section>
      ) : null;
    }
    return (
      <section className="ac-completion is-done" aria-labelledby="ac-completion-h">
        <h2 id="ac-completion-h" className="ac-completion-title"><CheckCircleSolid className="hi" aria-hidden="true" />{(method === "manual" || method === "manual-video" ? copy : COMPLETE_COPY.written).done}</h2>
        {how && <p className="ac-cardsub">{how}</p>}
        {undo && (
          <button type="button" className="ac-linkbtn" onClick={() => completion.run(false)} disabled={saving}>{saving ? "Saving…" : "Mark as not complete"}</button>
        )}
        {status}
      </section>
    );
  }
  if (method === "quiz") {
    return (
      <section className="ac-completion" aria-labelledby="ac-completion-h">
        <h2 id="ac-completion-h" className="ac-completion-title">Pass the quiz to complete this lesson</h2>
        <p className="ac-cardsub">{required ? `Your answers are graded when you submit them.${unlocksNext ? " Passing unlocks the next lesson." : ""}` : "Passing the quiz completes this optional lesson."}</p>
        {optional}
      </section>
    );
  }
  if (method === "watch") {
    const dur = st.durationSec || lesson.videoMeta?.durationSec || 0;
    const pos = Math.min(st.positionSec, dur || st.positionSec);
    const pct = dur > 0 ? Math.round((pos / dur) * 100) : 0;
    return (
      <section className="ac-completion" aria-labelledby="ac-completion-h">
        <h2 id="ac-completion-h" className="ac-completion-title">Watch the video to the end to complete this lesson</h2>
        {dur > 0 && pos > 0
          ? <div className="ac-watchbar"><ProgressBar percent={pct} compact label={`Video position: ${formatClock(pos)} of ${formatClock(dur)}`} /><span className="ac-cardsub">You're at {formatClock(pos)} of {formatClock(dur)}</span></div>
          : <p className="ac-cardsub">{video.capabilities.label} tells us when the video ends, so this lesson completes on its own.{unlocksNext ? " That unlocks the next lesson." : ""}</p>}
        {optional}
        {completion.err && completion.how === "video" && (
          <BusyButton className="sb-btn compact" busy={saving} busyLabel="Saving…" onClick={() => completion.run(true, "video")}>Try again</BusyButton>
        )}
        {status}
      </section>
    );
  }
  if (method === "unavailable") {
    return (
      <section className="ac-completion is-blocked" aria-labelledby="ac-completion-h">
        <h2 id="ac-completion-h" className="ac-completion-title"><ExclamationTriangleIcon className="hi" aria-hidden="true" />This lesson can't be completed yet</h2>
        {playerFailed && video
          /* The provider's player reported an error. Watching on the provider's
             own site is fine for the learner, but can't confirm completion here. */
          ? <p className="ac-cardsub">The video didn't play here. {video.provider === "vimeo" ? "Try again above, or watch" : "You can watch"} it on {video.capabilities.label}, but watching it there can't mark this lesson complete in the Academy: completion needs the video to finish here. If it keeps failing, report it so an Academy editor can check the video. Your progress so far is safe.</p>
          : <p className="ac-cardsub">Its video can't be played here, and completing it needs the video. Report it so an Academy editor can fix the link. Your progress so far is safe.</p>}
        <ReportUnavailable c={c} lesson={lesson} />
      </section>
    );
  }
  // manual / manual-video
  return (
    <section className="ac-completion" aria-labelledby="ac-completion-h">
      <h2 id="ac-completion-h" className="sb-vh">Complete this lesson</h2>
      <div className="ac-completion-row">
        <BusyButton className={"sb-btn" + (quiet ? " ghost" : "")} busy={saving} busyLabel="Saving…" onClick={() => completion.run(true)}>
          <CheckCircleIcon className="hi hi-sm" aria-hidden="true" />{copy.action}
        </BusyButton>
        <p className="ac-completion-hint">{copy.hint}</p>
      </div>
      {!online && !completion.err && <p className="ac-cardsub">You're offline. Reconnect to record your progress.</p>}
      {optional}
      {status}
    </section>
  );
}

/* Report an unplayable lesson video through the app's existing issue reports
   (Admin → Reports). One click; the report names the course and lesson. */
function ReportUnavailable({ c, lesson }) {
  const [state, setState] = useState("idle");          // idle | sending | sent | error
  const send = async () => {
    setState("sending");
    const ok = await reportIssue({ note: `Academy: the video in “${lesson.title}” (course “${c.title}”) can't be played. [course ${c.id} · lesson ${lesson.id}]`, action: "academy content unavailable" });
    setState(ok ? "sent" : "error");
  };
  if (state === "sent") return <p className="ac-done" role="status"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />Thanks for reporting it. An Academy editor will take a look.</p>;
  return (
    <div className="ac-completion-row">
      <BusyButton className="sb-btn compact" busy={state === "sending"} busyLabel="Sending…" onClick={send}>Report this problem</BusyButton>
      {state === "error" && <p className="ac-err" role="alert">Couldn't send the report. Please try again.</p>}
    </div>
  );
}

/* A lesson the learner can't open yet (direct URL, refresh, back/forward, a
   learning-path link): what unlocks it — one prerequisite as a sentence,
   several as a checklist — and a route to the next actionable step. Renders
   none of the lesson's content. Editors get the preview, which records nothing. */
function LockedLesson({ c, lesson, here, access, index, count, courseHref, editor, courseId, lessonId, go, R }) {
  const headRef = useRef(null);
  useEffect(() => { headRef.current?.focus({ preventScroll: true }); }, [lessonId]);
  const missing = here.missing || [];
  const route = actionableFor(access, lessonId);
  if (here.broken) return <BrokenLesson c={c} lesson={lesson} index={index} count={count} courseHref={courseHref} editor={editor} courseId={courseId} lessonId={lessonId} headRef={headRef} R={R} />;
  return (
    <div className="ac-lessonmain">
      <BackLink to={courseHref} label={c.title} R={R} />
      <section className="ac-locked" aria-labelledby="ac-locked-h">
        <span className="ac-lockedmark" aria-hidden="true"><LockClosedIcon className="hi" /></span>
        <span className="ac-cat">Lesson {index + 1} of {count}</span>
        <h1 id="ac-locked-h" className="ac-h1" tabIndex={-1} ref={headRef}>{lesson.title}</h1>
        {here.prerequisites.length === 1
          ? <p className="ac-locked-why">Complete <b>{missing[0]?.title || "the lesson before it"}</b> to unlock this lesson.</p>
          : (
            <>
              <p className="ac-locked-why">Complete these lessons to unlock this one:</p>
              <ul className="ac-prereqcheck">
                {here.prerequisites.map((p) => {
                  const pa = accessFor(access, p.id);
                  return (
                    <li key={p.id} className={pa?.completed ? "done" : ""}>
                      {pa?.completed
                        ? <><CheckCircleSolid className="hi hi-sm" aria-hidden="true" /><span>{p.title}</span><span className="ac-cardsub">Completed</span></>
                        : pa?.accessible
                          ? <><span className="ac-checkdot" aria-hidden="true" /><button type="button" className="ac-linkbtn" onClick={() => go(p.id)}>{p.title}</button><span className="ac-cardsub">To do</span></>
                          : <><LockClosedIcon className="hi hi-sm" aria-hidden="true" /><span>{p.title}</span><span className="ac-cardsub">Locked. Complete “{pa?.missing?.[0]?.title || "its prerequisite"}” first.</span></>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        <p className="ac-cardsub">This lesson builds on {here.prerequisites.length === 1 ? "that one" : "those"}. Other lessons in this course that don't depend on it stay open, and lessons you've completed are always open for review.</p>
        <div className="ac-actions">
          {route && <button type="button" className="sb-btn compact" onClick={() => go(route.id)}><span>Go to “{route.title}”</span><ChevronRightIcon className="hi hi-sm" aria-hidden="true" /></button>}
          <button type="button" className={"sb-btn compact" + (route ? " ghost" : "")} onClick={() => R.navigate(courseHref)}><span>Course overview</span></button>
        </div>
        {editor && (
          <p className="ac-note">You can edit this course. This is the learner view, so prerequisites apply to you too. To look at any lesson without recording progress, <button type="button" className="ac-linkbtn" onClick={() => R.navigate(learnPreviewPath(courseId, lessonId))}>open it in the preview</button>.</p>
        )}
      </section>
    </div>
  );
}

/* A lesson whose published prerequisite data is broken (only possible if it
   was changed outside the publish flow). Never treated as satisfied: it can't
   be opened or completed until fixed — honest, recoverable, reported. */
function BrokenLesson({ c, lesson, index, count, courseHref, editor, courseId, lessonId, headRef, R }) {
  const [sent, setSent] = useState("idle");
  const report = async () => {
    setSent("sending");
    const ok = await reportIssue({ note: `Academy: lesson “${lesson.title}” in “${c.title}” has broken prerequisites. [course ${courseId} · lesson ${lessonId}]`, action: "academy prerequisite problem" });
    setSent(ok ? "sent" : "error");
  };
  return (
    <div className="ac-lessonmain">
      <BackLink to={courseHref} label={c.title} R={R} />
      <section className="ac-locked is-broken" aria-labelledby="ac-locked-h">
        <span className="ac-lockedmark" aria-hidden="true"><ExclamationTriangleIcon className="hi" /></span>
        <span className="ac-cat">Lesson {index + 1} of {count}</span>
        <h1 id="ac-locked-h" className="ac-h1" tabIndex={-1} ref={headRef}>{lesson.title}</h1>
        <p className="ac-locked-why">This lesson isn't available right now.</p>
        <p className="ac-cardsub">Its prerequisites are set up incorrectly, so it can't be opened or completed until an Academy editor fixes them. Other lessons in this course aren't affected, and your progress is safe.</p>
        <div className="ac-actions">
          {sent === "sent"
            ? <p className="ac-done" role="status"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />Thanks for reporting it.</p>
            : <BusyButton className="sb-btn compact" busy={sent === "sending"} busyLabel="Sending…" onClick={report}>Report this problem</BusyButton>}
          <button type="button" className="sb-btn ghost compact" onClick={() => R.navigate(courseHref)}><span>Course overview</span></button>
        </div>
        {sent === "error" && <p className="ac-err" role="alert">Couldn't send the report. Please try again.</p>}
        {editor && <p className="ac-note">Editors: fix this lesson's prerequisites in the <button type="button" className="ac-linkbtn" onClick={() => R.navigate(learnManagePath({ view: "course", id: courseId, item: lessonId }))}>course workspace</button>, then publish.</p>}
      </section>
    </div>
  );
}

/* ---- end of course ------------------------------------------------------
   completed (finishedAt)     → the celebration, if THIS tab's Finish click
                                recorded it; otherwise a calm completed panel
                                (on the last / final required lesson)
   ready (requirements done)  → Finish course, on every lesson page
   otherwise, on the last lesson → the way to what's left (never a dead end) */
function CourseEnd({ me, R, c, lessons, progress, access, summary, status, finish, saving, isLast, lessonId, go, pathCtx = null }) {
  const all = flatLessons(c, lessons);
  const lastRequiredId = [...all].reverse().find(isRequiredLesson)?.id || null;
  if (finish.result && finish.result.already === false) {
    return <CourseCelebration me={me} R={R} c={c} finishedAt={finish.result.finishedAt} required={finish.result.required ?? summary.total} pathCtx={pathCtx} />;
  }
  if (status === "completed" || finish.result?.already) {          // finished — here, in another tab, or on another device
    if (!(isLast || lessonId === lastRequiredId || finish.result)) return null;
    return <CourseCompletedPanel me={me} R={R} c={c} progress={progress} summary={summary} pathCtx={pathCtx} already={!!finish.result?.already} />;
  }
  if (status === "ready") {
    const bonus = (access || []).find((a) => !a.required && !a.completed && a.accessible && a.id !== lessonId);
    return <FinishCard finish={finish} saving={saving} bonus={bonus ? bonus.lesson : null} go={go} />;
  }
  if (!isLast) return null;
  const left = (access || []).filter((a) => a.required && !a.completed);
  if (!left.length) return null;
  const first = left.find((a) => a.accessible) || accessFor(access, actionableFor(access, left[0].id)?.id) || left[0];
  const st = lessonState(first.lesson, progress);
  const finishQuiz = () => {
    const q = document.querySelector(".ac-quiz");
    q?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    q?.querySelector("input,button")?.focus({ preventScroll: true });
  };
  return (
    <div className="ac-courseend ac-remaining">
      <p><b>Almost there.</b> {left.length === 1 ? "One required lesson is" : `${left.length} required lessons are`} still open before you can finish this course.</p>
      {first.id === lessonId
        ? (st.quizRequired && !st.earned ? <button type="button" className="sb-btn compact" onClick={finishQuiz}><span>Finish quiz</span></button> : <span className="ac-cardsub">Complete this lesson above to finish the course.</span>)
        : <button type="button" className="sb-btn compact" onClick={() => go(first.id)}><span>{left.length === 1 ? `Go to “${first.lesson.title}”` : "Continue remaining lessons"}</span><ChevronRightIcon className="hi hi-sm" aria-hidden="true" /></button>}
    </div>
  );
}

/* Every required lesson is done: the one primary action is Finish course. */
function FinishCard({ finish, saving = false, bonus = null, go, compact = false }) {
  const online = useOnline();
  return (
    <section className={"ac-courseend ac-finish" + (compact ? " compact" : "")} aria-labelledby="ac-finish-h">
      <div className="ac-finishhead">
        <span className="ac-finishmark" aria-hidden="true"><AcademicCapIcon className="hi" /></span>
        <div>
          <h2 id="ac-finish-h" className="ac-h2">All required lessons are complete. You're ready to finish.</h2>
          <p>All required lessons are complete. Finish your course to celebrate your progress.</p>
        </div>
      </div>
      <div className="ac-actions">
        <BusyButton className="sb-btn" busy={finish.busy} busyLabel="Finishing…" disabled={saving || finish.busy} onClick={finish.run}>
          <CheckCircleIcon className="hi hi-sm" aria-hidden="true" />Finish course
        </BusyButton>
        {bonus && go && <button type="button" className="sb-btn ghost compact" onClick={() => go(bonus.id)}><span>Explore bonus lessons</span></button>}
      </div>
      {saving && <p className="ac-savestate muted" role="status">Saving your progress…</p>}
      {!online && !finish.err && <p className="ac-cardsub">You're offline. Reconnect to finish your course.</p>}
      {finish.err && <p className="ac-err" role="alert">{finish.err}</p>}
    </section>
  );
}

/* The moment of finishing — shown only in the tab whose Finish click the server
   confirmed. Moves focus to the heading and announces it; confetti is one short
   burst inside the panel (none under reduced motion); nothing replays later. */
function CourseCelebration({ me, R, c, finishedAt, required, pathCtx = null }) {
  const reduce = useMediaQuery("(prefers-reduced-motion: reduce)");
  const headRef = useRef(null);
  const canvasRef = useRef(null);
  const [live, setLive] = useState("");
  useEffect(() => {
    headRef.current?.focus({ preventScroll: true });
    headRef.current?.closest("section")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    const t = setTimeout(() => setLive(`Course completed. You've completed ${c.title}.`), 150);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => (reduce ? undefined : burstConfetti(canvasRef.current)), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className={"ac-courseend ac-celebrate" + (reduce ? " is-static" : "")} aria-labelledby="ac-cel-h">
      {!reduce && <canvas ref={canvasRef} className="ac-confetti" aria-hidden="true" />}
      <span className="sb-vh" role="status">{live}</span>
      <div className="ac-celebrate-hero">
        <svg className="ac-emblem" viewBox="0 0 72 72" aria-hidden="true" focusable="false">
          <circle className="ac-emblem-ring" cx="36" cy="36" r="32" />
          <path className="ac-emblem-check" d="M22 37.5 L32 47 L51 27" />
        </svg>
        <h2 id="ac-cel-h" className="ac-celebrate-title" tabIndex={-1} ref={headRef}>You did it!</h2>
        <p className="ac-celebrate-lead">You've completed <b>{c.title}</b>.</p>
        <p className="ac-celebrate-warm">That's real progress. Take what you've learned into your next project.</p>
        <dl className="ac-celebrate-facts">
          <div><dt>Required lessons</dt><dd>{required}</dd></div>
          <div><dt>Completed</dt><dd>{longDate(finishedAt)}</dd></div>
        </dl>
      </div>
      <KeepGrowing me={me} R={R} c={c} pathCtx={pathCtx} />
    </section>
  );
}

/* Revisits: a calm, persistent record of the finish. */
function CourseCompletedPanel({ me, R, c, progress, summary, pathCtx = null, already = false }) {
  const when = toMs(progress?.finishedAt);
  const n = Number(progress?.finishedRequired) || summary.total;
  return (
    <section className="ac-courseend ac-complete-panel" aria-labelledby="ac-done-h">
      <div className="ac-donehead">
        <span className="ac-donemark" aria-hidden="true"><CheckCircleSolid className="hi" /></span>
        <div>
          <h2 id="ac-done-h" className="ac-h2">Course completed</h2>
          <p>You finished <b>{c.title}</b>{when ? ` on ${longDate(when)}` : ""}.</p>
          <p className="ac-cardsub">{n} required lesson{n === 1 ? "" : "s"}{summary.bonusTotal ? ` · ${summary.bonusDone} of ${summary.bonusTotal} bonus` : ""}{already ? " · already finished (in another tab or on another device)" : ""}</p>
        </div>
      </div>
      <KeepGrowing me={me} R={R} c={c} pathCtx={pathCtx} />
    </section>
  );
}

/* Where to go after finishing, in priority order:
     1. the next step of the learning path the learner EXPLICITLY came from
        (?path=, validated) — never one guessed from started paths;
     2. the next accessible, unfinished course in this category's order;
     3. the existing recommendations;
     4. otherwise navigation only (never an empty card).
   The space is reserved while it loads (no layout jump); a failed load just
   leaves the navigation. */
function KeepGrowing({ me, R, c, pathCtx = null }) {
  const tax = useTax();
  const { courses, loaded: coursesLoaded, error: coursesError } = useCourses(me);
  const allProgress = useAllProgress(me.id);
  const { paths, loaded: pathsLoaded, error: pathsError } = usePaths(me);
  const reviews = useAllGuideReviews(me.id);
  const path = useMemo(() => pathContextFor({ pathId: pathCtx, paths, courseId: c.id, me, hidden: tax.hidden }), [pathCtx, paths, c.id, me, tax.hidden]);
  const resolved = useResolvedPath(path, me, allProgress.byCourse, reviews.byGuide);
  const pathNext = useMemo(() => {
    if (!path || !resolved.loaded) return null;
    const items = resolvePathItems(path, resolved.ctx);
    return items.find((i) => i.available && i.required && !i.completed) || items.find((i) => i.available && !i.completed) || null;
  }, [path, resolved]);
  const suggestion = useMemo(() => (pathNext ? null : nextCourseSuggestion({ me, current: c, courses, categories: tax.categories, progressByCourse: allProgress.byCourse })),
    [pathNext, me, c, courses, tax.categories, allProgress.byCourse]);
  const failed = !!(coursesError || pathsError || allProgress.error);
  const ready = failed || (coursesLoaded && pathsLoaded && allProgress.loaded && reviews.loaded && (!path || resolved.loaded));
  const cat = categoryIn(tax.categories, c.category);
  const startedOf = (course) => estimateProgress(course, allProgress.byCourse[course.id]).started;
  return (
    <div className="ac-keepgrowing">
      <h3 className="sb-mlabel ac-keephead">Keep growing</h3>
      {!ready ? (
        <div className="ac-donenext ac-donenext-wait" aria-hidden="true"><Skeleton lines={2} /></div>
      ) : failed ? null : pathNext ? (
        <div className="ac-donenext">
          <span className="ac-cardsub">Next in your learning path · {path.title}</span>
          <button type="button" className="ac-donecard" onClick={() => R.navigate(pathStepHref(pathNext, path.id, allProgress.byCourse))}>
            {pathNext.doc?.cover ? <StoredImage imageRef={pathNext.doc.cover} alt="" className="ac-donecover" ratio="3 / 4" /> : pathNext.course?.cover ? <StoredImage imageRef={pathNext.course.cover} alt="" className="ac-donecover" ratio="3 / 4" /> : null}
            <span><b>{pathNext.title}</b><span className="ac-cardsub">{pathNext.subtitle && pathNext.subtitle !== pathNext.title ? pathNext.subtitle : ITEM_LABEL[pathNext.type]}</span></span>
            <span className="sb-btn compact ac-donecta" aria-hidden="true">Continue learning path</span>
          </button>
        </div>
      ) : suggestion ? (
        <div className="ac-donenext">
          <span className="ac-cardsub">{suggestion.reason}</span>
          <button type="button" className="ac-donecard" onClick={() => R.navigate(learnPath(suggestion.course.id))}>
            <StoredImage imageRef={suggestion.course.cover} alt="" className="ac-donecover" ratio="3 / 4" />
            <span><b>{suggestion.course.title}</b><span className="ac-cardsub">{levelLabel(suggestion.course.level)}{startedOf(suggestion.course) ? " · in progress" : ""}</span></span>
            <span className="sb-btn compact ac-donecta" aria-hidden="true">{startedOf(suggestion.course) ? "Continue learning" : "Start course"}</span>
          </button>
        </div>
      ) : null}
      <div className="ac-actions ac-donelinks">
        {path && !pathNext && ready && <button type="button" className="sb-btn ghost compact" onClick={() => R.navigate(learnPathwayPath(path.id))}><span>Back to the learning path</span></button>}
        <button type="button" className="sb-btn ghost compact" onClick={() => R.navigate(cat && !cat.hidden ? learnCategoryPath(cat.id) : learnBrowsePath({}))}><span>Back to courses</span></button>
        <button type="button" className="sb-btn ghost compact" onClick={() => R.navigate("/learn")}><span>Explore the Academy</span></button>
      </div>
    </div>
  );
}

/* ===================================================================
   Video player (links only; provider embeds built from validated ids)
   =================================================================== */
export function VideoPlayer({ video, title, resumeSec = 0, durationHint = 0, onProgress, onEnded, onFailed, autoplay = false, meta = null }) {
  const hostRef = useRef(null);
  const frameRef = useRef(null);
  const [failed, setFailedState] = useState(false);
  const saved = useRef({ sec: null, at: null });
  const endedOnce = useRef(false);
  const cb = useRef({ onProgress, onEnded, onFailed });
  cb.current = { onProgress, onEnded, onFailed };
  const setFailed = useCallback((v) => { setFailedState(v); if (v && cb.current.onFailed) cb.current.onFailed(); }, []);

  const tick = useCallback((pos, dur, ended) => {
    if (!endedOnce.current && videoWatchedFromEvent({ ended, positionSec: pos, durationSec: dur })) {
      endedOnce.current = true;
      cb.current.onEnded && cb.current.onEnded();
    }
    const now = Date.now();
    if (cb.current.onProgress && shouldPersistPosition({ positionSec: pos, durationSec: dur, lastSavedSec: saved.current.sec, lastSavedAt: saved.current.at, now })) {
      saved.current = { sec: pos, at: now };
      cb.current.onProgress(pos, dur);
    }
  }, []);

  // ---- YouTube: IFrame Player API ----
  useEffect(() => {
    if (video.provider !== "youtube" || !hostRef.current) return;
    let player = null, timer = null, cancelled = false;
    // YT.Player REPLACES the element it's given with an iframe, so hand it a
    // child we create here — React keeps owning hostRef's div.
    const host = hostRef.current;
    const mount = document.createElement("div");
    host.appendChild(mount);
    loadYouTubeApi().then((YT) => {
      if (cancelled) return;
      if (!YT) { setFailed(true); return; }
      const start = resumePosition(resumeSec, durationHint);
      player = new YT.Player(mount, {
        host: "https://www.youtube-nocookie.com", videoId: video.id,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1, start, origin: window.location.origin, autoplay: autoplay ? 1 : 0 },
        events: {
          onError: () => setFailed(true),
          onStateChange: (e) => {
            const dur = player.getDuration ? player.getDuration() : 0;
            if (e.data === YT.PlayerState.ENDED) tick(dur, dur, true);
            if (e.data === YT.PlayerState.PLAYING && !timer) {
              timer = setInterval(() => { try { tick(player.getCurrentTime(), player.getDuration(), false); } catch {} }, 1000);
            } else if (e.data !== YT.PlayerState.PLAYING && timer) { clearInterval(timer); timer = null; }
          },
        },
      });
    });
    return () => {
      cancelled = true; if (timer) clearInterval(timer);
      try { player && player.destroy && player.destroy(); } catch {}
      try { host.replaceChildren(); } catch {}
    };
  }, [video.provider, video.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Vimeo: postMessage player API ----
  // phase: loading → ready/playing; "slow" = no `ready` after VIMEO_SLOW_MS
  // (neutral guidance, never "unavailable"); "failed" = Vimeo's own error
  // event (see vimeoEventKind). Retry remounts the embed (`attempt`); a failure
  // is cleared only by real playback from the new embed, never by `ready`.
  const [vm, setVm] = useState({ phase: "loading", attempt: 0, autoplayBlocked: false });
  const vmFailed = useRef(false);
  useEffect(() => {
    if (video.provider !== "vimeo") return undefined;
    const t = setTimeout(() => setVm((x) => (x.phase === "loading" ? { ...x, phase: "slow" } : x)), VIMEO_SLOW_MS);
    return () => clearTimeout(t);
  }, [video.provider, vm.attempt]);
  useEffect(() => {
    if (video.provider !== "vimeo") return;
    const origins = PROVIDER_ORIGINS.vimeo;
    const post = (method, value) => { try { frameRef.current?.contentWindow?.postMessage(JSON.stringify(value === undefined ? { method } : { method, value }), origins[0]); } catch {} };
    const onMsg = (e) => {
      if (!origins.includes(e.origin) || !frameRef.current || e.source !== frameRef.current.contentWindow) return;
      let d; try { d = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { return; }
      const kind = vimeoEventKind(d);
      if (!kind) return;
      if (kind === "failure") {
        vmFailed.current = true;
        setVm((x) => ({ ...x, phase: "failed", autoplayBlocked: false }));
        if (cb.current.onFailed) cb.current.onFailed(true);
        return;
      }
      if (kind === "autoplay-blocked") { setVm((x) => (x.phase === "failed" ? x : { ...x, autoplayBlocked: true })); return; }
      if (kind === "method-error") return;
      if (kind === "play-requested") { setVm((x) => (x.autoplayBlocked ? { ...x, autoplayBlocked: false } : x)); return; }
      if (kind === "ready") {
        setVm((x) => (x.phase === "loading" || x.phase === "slow" ? { ...x, phase: "ready" } : x));
        post("addEventListener", "timeupdate"); post("addEventListener", "ended");
        post("addEventListener", "play"); post("addEventListener", "playing"); post("addEventListener", "error");
        const start = resumePosition(resumeSec, durationHint);
        if (start) post("setCurrentTime", start);
        return;
      }
      if (vimeoProvesPlayback(kind)) {
        setVm((x) => ({ ...x, phase: "playing", autoplayBlocked: false }));
        if (vmFailed.current) { vmFailed.current = false; if (cb.current.onFailed) cb.current.onFailed(false); }
      }
      if (kind === "time") tick(Number(d.data.seconds) || 0, Number(d.data.duration) || 0, false);
      else if (kind === "ended") { const dur = Number(d.data?.duration) || durationHint || 0; tick(dur, dur, true); }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [video.provider, video.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const retryVimeo = () => setVm((x) => ({ phase: "loading", attempt: x.attempt + 1, autoplayBlocked: false }));

  const label = `${title || "Video"} (${video.capabilities.label})`;
  return (
    <div className="ac-player">
      {failed
        ? <div className="ac-videomsg" role="status"><ExclamationTriangleIcon className="hi" aria-hidden="true" /><p>This video can't be played here. It may be private or not allowed to play on other sites. <a href={video.url} target="_blank" rel="noopener noreferrer">Open on {video.capabilities.label}</a>.</p></div>
        : video.provider === "youtube"
          ? <div className="ac-frame"><div ref={hostRef} title={label} /></div>
          : video.provider === "vimeo" && vm.phase === "failed"
            ? <div className="ac-videomsg" role="status" data-vimeo="failed"><ExclamationTriangleIcon className="hi" aria-hidden="true" /><div><p>Vimeo reported a problem playing this video, so it can't play here right now.</p><button type="button" className="sb-btn compact" onClick={retryVimeo}><ArrowPathIcon className="hi hi-sm" aria-hidden="true" />Try again</button></div></div>
            : <div className="ac-frame"><iframe key={vm.attempt} ref={frameRef} src={autoplay && video.provider === "vimeo" ? video.embedUrl + "&autoplay=1" : video.embedUrl} title={label} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /></div>}
      {video.provider === "vimeo" && vm.phase === "slow" && (
        <div className="ac-videonote" role="status" data-vimeo="slow"><p className="ac-cardsub">The video is taking longer than usual to load. You can keep waiting, try again, or open it on Vimeo.</p><button type="button" className="sb-btn ghost compact" onClick={retryVimeo}><ArrowPathIcon className="hi hi-sm" aria-hidden="true" />Try again</button></div>
      )}
      {video.provider === "vimeo" && vm.autoplayBlocked && vm.phase !== "failed" && <p className="ac-cardsub ac-videonote" role="status" data-vimeo="autoplay">Press play in the video to start it.</p>}
      <div className="ac-playerfoot">
        {meta && (meta.title || meta.author) && (
          /* External creator attribution — the course curator is never presented as the video's creator. */
          <span className="ac-cardsub ac-attrib">Video{meta.title ? <>: <i>{meta.title}</i></> : ""}{meta.author ? <> by {meta.authorUrl ? <a href={meta.authorUrl} target="_blank" rel="noopener noreferrer">{meta.author}</a> : meta.author}</> : ""}</span>
        )}
        <a className="ac-ext" href={video.url} target="_blank" rel="noopener noreferrer"><ArrowTopRightOnSquareIcon className="hi hi-sm" aria-hidden="true" />Open original on {video.capabilities.label}</a>
        {!video.capabilities.tracksProgress && <span className="ac-cardsub">Playback position isn't saved for {video.capabilities.label} videos.</span>}
      </div>
    </div>
  );
}

/* ===================================================================
   Quiz (learner side — grading happens on the server)
   =================================================================== */
/* Quiz. Multiple-answer questions use checkboxes ("Select all correct
   answers"), single-answer ones radio buttons. Grading is server-side and
   exact-match (no partial credit: every correct option and nothing else).
   Each attempt has a submission id that is REUSED if an uncertain request is
   retried, so a network hiccup or a double submit never uses two attempts.
   Attempts: "Unlimited attempts" or "Attempt 2 of 3" (the quiz's limit plus any
   extra attempts staff granted). Nothing is shown as passed until the server
   graded it. */
export function QuizPanel({ lesson, courseId, me, state: st, extraAttempts = 0, courseTitle = "", requestedAt = null, submit = submitQuiz, attemptsHook = useAttempts, request = requestQuizAttempt }) {
  const quiz = lesson.quiz;
  const mode = quizMode(lesson);
  const attempts = attemptsHook(me.id, courseId, lesson.id);
  const [answers, setAnswers] = useState({});
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [failMsg, setFailMsg] = useState("");
  const [asked, setAsked] = useState("idle");          // idle | sending | sent | error
  const subId = useRef(null);
  if (!subId.current) subId.current = newId() + newId();
  const sorted = useMemo(() => [...attempts.docs].sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt)), [attempts.docs]);
  const best = sorted.reduce((m, a) => Math.max(m, a.percent || 0), 0);
  const passedBefore = sorted.some((a) => a.passed) || (mode === "required" && st?.earned);
  const gate = canAttemptQuiz(quiz, sorted.length, extraAttempts);
  // A submission whose response was lost (timeout, dropped connection) may
  // still have been recorded: the attempt doc is keyed by our submission id, so
  // when it shows up in the live list we show ITS result.
  const landed = !result && sorted.find((a) => a.id === subId.current);
  const shown = result || (landed ? { score: landed.score, total: landed.total, percent: landed.percent, passMark: landed.passMark, passed: landed.passed, mode: landed.mode, results: landed.results || [], replayed: true } : null);
  // the attempt just submitted may not be in the live list yet
  const used = Math.max(sorted.length, result?.attemptsUsed || 0);
  const after = canAttemptQuiz(quiz, used, extraAttempts);

  const choose = (q, optId) => {
    setAnswers((a) => {
      const cur = a[q.id] || [];
      const next = q.multi ? (cur.includes(optId) ? cur.filter((o) => o !== optId) : [...cur, optId]) : [optId];
      return { ...a, [q.id]: next };
    });
    setErrors((e) => ({ ...e, [q.id]: undefined }));
  };
  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;                                  // a second submit while one is in flight does nothing
    const v = validateQuizAnswers(quiz, answers);
    if (!v.ok) { setErrors(Object.fromEntries(v.errors.map((x) => [x.qId, x.message]))); return; }
    setBusy(true); setFailMsg("");
    try { setResult(await submit(courseId, lesson.id, v.answers, subId.current)); }
    catch (err) {
      // keep the SAME submission id: if the first request actually reached the
      // server, retrying returns that result instead of using another attempt
      setFailMsg(isOfflineError(err) ? "You're offline, so your answers weren't submitted. They're still selected. Submit again when you reconnect. It won't use an extra attempt."
        : err?.code === "functions/resource-exhausted" ? "You've used all your attempts for this quiz."
        // only explain refusals the server phrased for people; anything else (a
        // lost response, a timeout, "internal") gets the safe-to-retry message
        : /^functions\/(failed-precondition|permission-denied|not-found|invalid-argument|already-exists)$/.test(err?.code || "") && err?.message && err.message.length < 160 ? err.message
        : "We couldn't confirm your answers were received. They're still selected, so submit again. It won't use an extra attempt.");
    } finally { setBusy(false); }
  };
  const retry = () => { subId.current = newId() + newId(); setResult(null); setAnswers({}); setErrors({}); setFailMsg(""); };
  const askForAttempt = async () => {
    setAsked("sending");
    try { requireOnline(); await request(courseId, lesson.id); setAsked("sent"); }
    catch { setAsked("error"); }
  };
  const attemptLine = gate.allowed == null ? "Unlimited attempts" : gate.ok ? `Attempt ${sorted.length + 1} of ${gate.allowed}` : `All ${gate.allowed} attempts used`;
  const recovery = (
    <div className="ac-quizrecover">
      <p>{mode === "required" ? "This lesson can't be completed without a pass, so anything that depends on it stays locked." : "This practice quiz doesn't affect your progress."} An Academy editor can give you another attempt. It will appear here as soon as they do.</p>
      {mode === "required" && (asked === "sent" || requestedAt
        ? <p className="ac-done" role="status"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />Request sent. Academy editors will see it on this course's page.</p>
        : <><BusyButton className="sb-btn compact" busy={asked === "sending"} busyLabel="Sending…" onClick={askForAttempt}>Ask for another attempt</BusyButton>
            {asked === "error" && <p className="ac-err" role="alert">Couldn't send the request. Check your connection and try again.</p>}</>)}
    </div>
  );

  return (
    <section className="ac-quiz" aria-labelledby="ac-quiz-h">
      <div className="sb-shead">
        <h2 id="ac-quiz-h" className="ac-h2">{mode === "required" ? "Quiz" : "Practice quiz"}</h2>
        <span className="ac-cardsub">{mode === "required" ? `Pass mark ${quiz.passMark || 70}% · required to complete this lesson` : "Optional · doesn't affect completion"}</span>
      </div>
      {attempts.loaded && !shown && (
        <p className="ac-note ac-attemptline">{attemptLine}{sorted.length ? ` · best so far ${best}%` : ""}{passedBefore ? " · you've passed this quiz" : ""}</p>
      )}
      {shown ? (
        <div className="ac-quizresult" role="status">
          <div className={"ac-score " + (shown.passed ? "pass" : "fail")}>
            {shown.passed ? <CheckCircleSolid className="hi" aria-hidden="true" /> : <XMarkIcon className="hi" aria-hidden="true" />}
            <div><b>{shown.passed ? "Passed" : "Not yet"}</b> · {shown.score} of {shown.total} correct ({shown.percent}%){mode === "required" ? ` · pass mark ${shown.passMark}%` : ""}</div>
          </div>
          {shown.replayed && <p className="ac-note">Your answers were received before the connection dropped, so this is their result. It used one attempt.</p>}
          {mode === "required" && <p className="ac-quizoutcome">{shown.passed ? "This lesson is complete." : passedBefore ? "You passed this quiz earlier, so the lesson stays complete." : after.ok ? `You need ${shown.passMark}% to pass. Review the answers below, then try again${after.remaining != null ? ` (${after.remaining} attempt${after.remaining === 1 ? "" : "s"} left)` : ""}.` : "That was your last attempt."}</p>}
          {(!shown.passed || mode === "practice") && after.ok && (
            <div className="ac-quizretry"><button type="button" className="sb-btn compact" onClick={retry}><ArrowPathIcon className="hi hi-sm" aria-hidden="true" />Try again</button></div>
          )}
          {!shown.passed && !passedBefore && !after.ok && recovery}
          <ol className="ac-review">
            {quiz.questions.map((q, i) => {
              const r = shown.results.find((x) => x.qId === q.id) || {};
              return (
                <li key={q.id} className={r.correct ? "ok" : "bad"}>
                  <div className="ac-qprompt">{i + 1}. {q.prompt} <span className={"ac-qverdict " + (r.correct ? "ok" : "bad")}>{r.correct ? "Correct" : "Incorrect"}</span></div>
                  <ul className="ac-opts">
                    {q.options.map((o) => {
                      const chosen = (r.selected || []).includes(o.id), right = (r.correctOptions || []).includes(o.id);
                      const kind = chosen && right ? "hit" : chosen ? "wrong" : right ? "missed" : "";
                      return (
                        <li key={o.id} className={"ac-opt-" + (kind || "plain")}>
                          <span className="ac-optmark" aria-hidden="true">{kind === "hit" ? "✓" : kind === "wrong" ? "✗" : kind === "missed" ? "!" : ""}</span>
                          <span>{o.text}</span>
                          {kind === "hit" && <span className="ac-tag ok">Your answer · correct</span>}
                          {kind === "wrong" && <span className="ac-tag bad">Your answer · incorrect</span>}
                          {kind === "missed" && <span className="ac-tag missed">Correct answer · not selected</span>}
                        </li>
                      );
                    })}
                  </ul>
                  {r.explanation && <p className="ac-explain">{r.explanation}</p>}
                </li>
              );
            })}
          </ol>
        </div>
      ) : !gate.ok ? (
        <div className="ac-quizexhausted">
          <p><b>You've used all {gate.allowed} attempts for this quiz.</b>{passedBefore ? " You passed, so this lesson is complete." : ""}</p>
          {!passedBefore && recovery}
        </div>
      ) : (
        <form onSubmit={onSubmit} className="ac-quizform" noValidate>
          <ol className="ac-questions">
            {quiz.questions.map((q, i) => (
              <li key={q.id}>
                <fieldset className="ac-q" aria-describedby={errors[q.id] ? `ac-qerr-${q.id}` : undefined}>
                  <legend className="ac-qprompt">{i + 1}. {q.prompt}<span className="ac-qhow">{q.multi ? "Select all correct answers." : "Select one answer."}</span></legend>
                  {q.options.map((o) => {
                    const on = (answers[q.id] || []).includes(o.id);
                    const id = `ac-${q.id}-${o.id}`;
                    return (
                      <label key={o.id} htmlFor={id} className={"ac-opt" + (on ? " on" : "")}>
                        <input id={id} type={q.multi ? "checkbox" : "radio"} name={`q-${q.id}`} checked={on} onChange={() => choose(q, o.id)} />
                        <span>{o.text}</span>
                      </label>
                    );
                  })}
                  {errors[q.id] && <div id={`ac-qerr-${q.id}`} className="ac-err" role="alert">{errors[q.id]}</div>}
                </fieldset>
              </li>
            ))}
          </ol>
          {failMsg && <div className="ac-err" role="alert">{failMsg}</div>}
          <BusyButton type="submit" className="sb-btn compact" busy={busy} busyLabel="Submitting…">Submit answers</BusyButton>
        </form>
      )}
    </section>
  );
}

/* ===================================================================
   Discussion — comments + one level of threaded replies
   =================================================================== */
/* Discussion badges: role at the time of posting, verified by rules. Older
   comments stamped "instructor" read as Moderator — courses no longer have instructors. */
const ROLE_LABEL = { admin: "Admin", moderator: "Moderator", instructor: "Moderator" };

/* Discussion. Feedback is the visible change itself (the posted comment, the
   updated text, the moved/pinned badge) plus a short polite status line for
   things that leave no trace (deleted, pinned/unpinned). Errors stay next to
   the control they belong to and keep the text the person typed. */
function Discussion({ me, ownerDoc, scope, users }) {
  const comments = useComments(scope);
  const editor = canEditCourse(me, ownerDoc);
  const [txt, setTxt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("");
  const [confirmDel, setConfirmDel] = useState(null);   // { c, replyCount, excerpt }
  const statusTimer = useRef(0);
  const headRef = useRef(null);
  const say = (m) => { clearTimeout(statusTimer.current); setStatus(m); statusTimer.current = setTimeout(() => setStatus(""), 5000); };
  useEffect(() => () => clearTimeout(statusTimer.current), []);
  const threads = useMemo(() => {
    const byTime = (a, b) => toMs(a.createdAt) - toMs(b.createdAt);
    const top = comments.docs.filter((c) => !c.parentId);
    const topIds = new Set(top.map((c) => c.id));
    const replies = new Map();
    for (const c of comments.docs) if (c.parentId) replies.set(c.parentId, [...(replies.get(c.parentId) || []), c]);
    for (const r of replies.values()) r.sort(byTime);
    top.sort((a, b) => (b.pinned === true) - (a.pinned === true) || byTime(a, b));
    const out = top.map((c) => ({ key: c.id, c, replies: replies.get(c.id) || [] }));
    // Replies whose comment was deleted stay visible under a placeholder
    // (deleting a comment never silently hides its thread).
    for (const [pid, rs] of replies) if (!topIds.has(pid)) out.push({ key: "gone:" + pid, c: null, replies: rs, at: toMs(rs[0].createdAt) });
    return out.sort((a, b) => (a.c?.pinned === true ? 0 : 1) - (b.c?.pinned === true ? 0 : 1) || (a.c ? toMs(a.c.createdAt) : a.at) - (b.c ? toMs(b.c.createdAt) : b.at));
  }, [comments.docs]);
  const replyCount = (id) => comments.docs.filter((x) => x.parentId === id).length;

  const post = async (e) => {
    e.preventDefault();
    if (!txt.trim() || busy) return;
    setBusy(true); setErr("");
    try { requireOnline(); await addComment(scope, me, ownerDoc, txt); setTxt(""); }
    catch (x) { setErr(isOfflineError(x) ? "You're offline, so your comment wasn't posted. It's still here. Post it when you reconnect." : "Couldn't post your comment. It's still here, so please try again."); }
    finally { setBusy(false); }
  };
  const askDelete = (c) => setConfirmDel({ c, replyCount: c.parentId ? 0 : replyCount(c.id), excerpt: String(c.txt || "").slice(0, 120) });
  const doDelete = async () => {
    const { c } = confirmDel;
    requireOnline();
    // where focus goes afterwards: the next comment, else the previous, else the heading
    const arts = [...document.querySelectorAll(".ac-discuss article.ac-comment")];
    const me_ = arts.find((a) => a.dataset.commentId === c.id);
    const i = arts.indexOf(me_);
    const nextId = (arts[i + 1] || arts[i - 1])?.dataset.commentId || null;
    let res;
    try { res = await deleteComment(scope, c.id); }
    catch { throw new Error("Couldn't delete the comment. It's still there. Please try again."); }
    say(res.alreadyGone ? "That comment had already been deleted." : "Comment deleted.");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const t = nextId && document.querySelector(`.ac-discuss article[data-comment-id="${nextId}"]`);
      (t || headRef.current)?.focus({ preventScroll: false });
    }));
  };

  return (
    <section className="ac-discuss" aria-labelledby="ac-disc-h">
      <div className="sb-shead"><h2 id="ac-disc-h" className="ac-h2" tabIndex={-1} ref={headRef}><ChatBubbleLeftRightIcon className="hi hi-sm" aria-hidden="true" />Discussion</h2>{comments.docs.length > 0 && <span className="ac-cardsub">{comments.docs.length} comment{comments.docs.length === 1 ? "" : "s"}</span>}</div>
      <p className="ac-discstatus" role="status" aria-live="polite">{status}</p>
      <form className="ac-compose" onSubmit={post}>
        <label htmlFor="ac-newcomment" className="sb-vh">Ask a question or share a thought</label>
        <textarea id="ac-newcomment" value={txt} onChange={(e) => { setTxt(e.target.value); if (err) setErr(""); }} rows={3} maxLength={2000} placeholder="Ask a question or share a thought…" />
        <div className="ac-actions">
          <BusyButton type="submit" className="sb-btn compact" busy={busy} busyLabel="Posting…" disabled={!txt.trim()}>Post</BusyButton>
          {err && <span className="ac-err" role="alert">{err}</span>}
        </div>
      </form>
      {!comments.loaded ? <Skeleton lines={3} />
        : threads.length === 0 ? <p className="ac-cardsub ac-disc-empty">No comments yet. Be the first to ask a question.</p>
        : (
          <ul className="ac-threads">
            {threads.map(({ key, c, replies }) => (
              <li key={key}>
                {c ? <Comment c={c} me={me} editor={editor} scope={scope} ownerDoc={ownerDoc} canReply onDelete={askDelete} say={say} />
                  : <div className="ac-comment ac-comment-gone"><span className="ac-cardsub">Comment deleted</span></div>}
                {replies.length > 0 && <ul className="ac-replies">{replies.map((r) => <li key={r.id}><Comment c={r} me={me} editor={editor} scope={scope} ownerDoc={ownerDoc} onDelete={askDelete} say={say} /></li>)}</ul>}
              </li>
            ))}
          </ul>
        )}
      {confirmDel && (
        <ConfirmDialog title="Delete comment?" confirmLabel="Delete comment" busyLabel="Deleting…" tone="danger"
          body={confirmDel.c.uid === me.id ? "Your comment will be removed from this discussion for everyone. This can't be undone." : `${confirmDel.c.name || "This member"}'s comment will be removed from this discussion for everyone. This can't be undone.`}
          consequences={[`“${confirmDel.excerpt}${(confirmDel.c.txt || "").length > 120 ? "…" : ""}”`,
            ...(confirmDel.replyCount ? [`${confirmDel.replyCount === 1 ? "Its reply stays" : `Its ${confirmDel.replyCount} replies stay`} visible, under a “Comment deleted” note.`] : [])]}
          onConfirm={doDelete} onClose={() => setConfirmDel(null)} />
      )}
    </section>
  );
}

function Comment({ c, me, editor, scope, ownerDoc, canReply = false, onDelete, say }) {
  const [mode, setMode] = useState(null);   // "edit" | "reply" | null
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(null);   // null | "save" | "reply" | "pin"
  const [err, setErr] = useState("");
  const own = c.uid === me.id;
  const run = async (kind, fn, okMsg) => {
    if (busy) return;
    setBusy(kind); setErr("");
    try { requireOnline(); await fn(); setMode(null); setVal(""); if (okMsg) say(okMsg); }
    catch (e) { setErr(isOfflineError(e) ? "You're offline, so nothing was saved. Your text is still here. Try again when you reconnect." : kind === "pin" ? "Couldn't change the pin. Please try again." : "Couldn't save. Your text is still here, so please try again."); }
    finally { setBusy(null); }
  };
  return (
    <article className={"ac-comment" + (c.pinned ? " pinned" : "")} aria-label={`Comment by ${c.name || "member"}`} tabIndex={-1} data-comment-id={c.id}>
      <div className="ac-chead">
        <span className="sb-av" aria-hidden="true">{initials(c.name || "?")}</span>
        <b>{c.name || "Member"}</b>
        {ROLE_LABEL[c.role] && <Pill tone="accent">{ROLE_LABEL[c.role]}</Pill>}
        {c.pinned && <span className="ac-pinned"><PushPinIcon solid className="hi hi-sm" aria-hidden="true" />Pinned</span>}
        <span className="ac-cardsub">{c.createdAt ? formatDateTime(toMs(c.createdAt)) : "Just now"}{c.editedAt ? " · edited" : ""}</span>
      </div>
      {mode === "edit"
        ? <form className="ac-compose" onSubmit={(e) => { e.preventDefault(); if (val.trim()) run("save", () => editComment(scope, c.id, val)); }}>
            <label htmlFor={`ac-edit-${c.id}`} className="sb-vh">Edit comment</label>
            <textarea id={`ac-edit-${c.id}`} value={val} onChange={(e) => setVal(e.target.value)} rows={3} maxLength={2000} autoFocus />
            <div className="ac-actions"><BusyButton type="submit" className="sb-btn compact" busy={busy === "save"} busyLabel="Saving…" disabled={!val.trim()}>Save</BusyButton><button type="button" className="sb-btn ghost compact" onClick={() => { setMode(null); setErr(""); }}>Cancel</button></div>
          </form>
        : <p className="ac-ctext"><SafeText text={c.txt} /></p>}
      <div className="ac-cactions">
        {canReply && <button type="button" className="ac-link" onClick={() => { setMode(mode === "reply" ? null : "reply"); setVal(""); setErr(""); }}>Reply</button>}
        {own && mode !== "edit" && <button type="button" className="ac-link" onClick={() => { setMode("edit"); setVal(c.txt); setErr(""); }}>Edit</button>}
        {(own || editor) && <button type="button" className="ac-link danger" onClick={() => onDelete(c)}>Delete</button>}
        {editor && canReply && (
          <button type="button" className="ac-link ac-pinbtn" disabled={busy === "pin"} aria-busy={busy === "pin" || undefined}
            onClick={() => run("pin", () => pinComment(scope, c.id, !c.pinned), c.pinned ? "Comment unpinned." : "Comment pinned to the top.")}>
            <PushPinIcon solid={!c.pinned} className="hi hi-xs" aria-hidden="true" />
            {busy === "pin" ? (c.pinned ? "Unpinning…" : "Pinning…") : c.pinned ? "Unpin comment" : "Pin comment"}
          </button>
        )}
      </div>
      {err && <p className="ac-err" role="alert">{err}</p>}
      {mode === "reply" && (
        <form className="ac-compose ac-replyform" onSubmit={(e) => { e.preventDefault(); if (val.trim()) run("reply", () => addComment(scope, me, ownerDoc, val, c.id)); }}>
          <label htmlFor={`ac-reply-${c.id}`} className="sb-vh">Reply</label>
          <textarea id={`ac-reply-${c.id}`} value={val} onChange={(e) => setVal(e.target.value)} rows={2} maxLength={2000} placeholder="Write a reply…" autoFocus />
          <div className="ac-actions"><BusyButton type="submit" className="sb-btn compact" busy={busy === "reply"} busyLabel="Posting…" disabled={!val.trim()}>Reply</BusyButton><button type="button" className="sb-btn ghost compact" onClick={() => { setMode(null); setErr(""); }}>Cancel</button></div>
        </form>
      )}
    </article>
  );
}

/* ===================================================================
   Quick guide
   =================================================================== */
/* What a learner sees of a tip/resource (published page and draft preview). */
function GuideBody({ g, tax, R }) {
  const video = g.video ? videoFromRecord(g.video) : null;
  const length = video ? (g.videoMeta?.durationSec > 0 ? formatClock(g.videoMeta.durationSec) : "") : g.durationMinutes > 0 ? `About ${formatDuration(g.durationMinutes)} to read` : "";
  return <>
    <div className="ac-cardmeta">
      <span className="ac-fmt">{video ? <PlayIcon className="hi hi-xs" aria-hidden="true" /> : <DocumentTextIcon className="hi hi-xs" aria-hidden="true" />}{video ? "Video resource" : "Written resource"}</span>
      <span className="ac-cat">{categoryNameIn(tax.categories, g.category)}</span>
      {length && <span className="ac-cardsub">{length}</span>}
    </div>
    <h1 className="ac-h1">{g.title}</h1>
    <TopicChips item={g} R={R} />
    {g.video && !video && <UnsupportedVideo />}
    {video && <VideoPlayer key={g.id || "preview"} video={video} title={g.title} meta={g.videoMeta} />}
    {!video && g.thumb && <StoredImage imageRef={g.thumb} alt="" ratio="16 / 9" />}
    {g.body && <Markdown src={g.body} version={g.mdVersion || 1} />}
    {g.resources?.length > 0 && (
      <section aria-labelledby="ac-gres-h">
        <h2 id="ac-gres-h" className="ac-h2">Links</h2>
        <ul className="ac-resources">
          {g.resources.map((r, i) => /^https?:\/\//i.test(r.url) && (
            <li key={i}><a href={r.url} target="_blank" rel="noopener noreferrer nofollow"><ArrowTopRightOnSquareIcon className="hi hi-sm" aria-hidden="true" />{r.label || r.url}</a></li>
          ))}
        </ul>
      </section>
    )}
  </>;
}

function GuideView({ me, users, isAdmin, guideId, R }) {
  const tax = useTax();
  const guide = useGuide(guideId);
  const visible = !!guide.data && canViewContent(me, guide.data, tax.hidden);
  const review = useGuideReview(me.id, guideId);
  const [busy, setBusy] = useState(false);
  const [toggleErr, setToggleErr] = useState("");
  useEffect(() => { if (guide.data?.title) document.title = `${guide.data.title} · Learn · IFC Creatives Board`; }, [guide.data?.title]);
  if (!guide.loaded || !review.loaded) return <div className="sb-page"><BackLink to="/learn" label="Creative Academy" R={R} /><Skeleton lines={6} /></div>;
  if (!visible) return <NotAvailable R={R} what="resource" />;
  const g = { id: guideId, ...guide.data };
  const reviewed = guideReviewed(review.data);
  const editor = canEditContent(me, g);
  const leader = canViewLearnerProgress(me);
  const catRec = categoryIn(tax.categories, g.category);
  const toggle = async () => {
    setBusy(true); setToggleErr("");
    try { requireOnline(); await setGuideReviewed(me.id, guideId, !reviewed); }
    catch (e) { setToggleErr(isOfflineError(e) ? "You're offline, so nothing was saved. Try again when you reconnect." : "Couldn't save that. Please try again."); }
    finally { setBusy(false); }
  };
  return (
    <div className="sb-page ac-guide">
      <Breadcrumb R={R} items={[{ label: "Learn", to: "/learn" }, catRec && (!catRec.hidden || isAcademyEditor(me)) ? { label: catRec.label, to: learnCategoryPath(catRec.id) } : { label: "Tips & resources" }, { label: g.title }]} />
      <div className="ac-guidemain">
        {g.status !== "published" && <Pill tone="warn">{g.status}</Pill>}
        <GuideBody g={g} tax={tax} R={R} />
        <div className="ac-complete ac-reviewbox" aria-live="polite">
          {reviewed
            ? <span className="ac-done"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />You marked this as reviewed{review.data?.reviewedAt ? ` · ${formatDateTime(toMs(review.data.reviewedAt))}` : ""}</span>
            : <span className="ac-cardsub">When you've read or watched this, mark it as reviewed so it shows in your learning record.</span>}
          <BusyButton className={"sb-btn compact" + (reviewed ? " quiet" : "")} busy={busy} busyLabel="Saving…" onClick={toggle} aria-pressed={reviewed}>{reviewed ? "Unmark reviewed" : "Mark as reviewed"}</BusyButton>
          {toggleErr && <span className="ac-err" role="alert">{toggleErr}</span>}
          <span className="ac-note" style={{ margin: 0, flexBasis: "100%" }}>“Reviewed” is your own note that you've been through this. It isn't an assessment of skill.</span>
        </div>
        <div className="ac-actions">
          {editor && <button type="button" className="sb-btn ghost compact" onClick={() => R.navigate(learnManagePath({ view: "guide", id: guideId }))}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Edit resource</button>}
        </div>
        <Discussion me={me} ownerDoc={g} scope={{ guideId }} users={users} />
        {leader && <GuideReviewers guide={g} users={users} />}
      </div>
    </div>
  );
}

/* /learn/preview/guide/:id — the DRAFT as learners will see it (editors only;
   drafts are editor-readable only). Nothing is recorded: no review, no discussion. */
function GuidePreview({ me, guideId, pathCtx = null, R }) {
  const tax = useTax();
  const [state, setState] = useState({ loaded: false });
  useEffect(() => {
    let live = true;
    if (!isAcademyEditor(me)) { setState({ loaded: true, denied: true }); return undefined; }
    loadGuideWorkspace(guideId).then((w) => { if (live) setState({ loaded: true, w }); }).catch((e) => { if (live) setState({ loaded: true, error: e?.message || "Couldn't load the draft." }); });
    return () => { live = false; };
  }, [guideId, me]);
  if (!state.loaded) return <div className="sb-page"><Skeleton lines={8} /></div>;
  if (state.denied) return <NotAvailable R={R} what="page" />;
  if (state.error || !state.w?.guide) return <div className="sb-page"><div className="sb-empty" role="alert">{state.error || "There's no draft of this resource to preview."}</div></div>;
  return (
    <div className="sb-page ac-guide">
      <div className="ac-previewbar" role="status">
        <EyeIcon className="hi hi-sm" aria-hidden="true" /><span><b>Draft preview.</b> This is how learners will see your changes after you publish. Nothing you do here is saved to anyone's progress.</span>
        <button type="button" className="sb-btn compact" onClick={() => R.navigate(learnManagePath({ view: "guide", id: guideId, path: pathCtx || "" }))}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Back to editing</button>
      </div>
      <div className="ac-guidemain"><GuideBody g={{ id: guideId, ...state.w.guide }} tax={tax} R={R} /></div>
    </div>
  );
}

function GuideReviewers({ guide, users }) {
  const [open, setOpen] = useState(false);
  const rows = useLeaderGuideReviews(guide.id, open);
  const byUid = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const reviewed = rows.docs.filter((r) => r.reviewed === true);
  return (
    <section className="ac-leader" aria-labelledby="ac-grev-h">
      <div className="sb-shead">
        <h2 id="ac-grev-h" className="ac-h2">Who has reviewed this</h2>
        <button type="button" className="sb-btn quiet compact" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"}</button>
      </div>
      {open && (!rows.loaded ? <Skeleton lines={2} />
        : rows.error ? <div className="sb-empty" role="alert">Couldn't load this list.</div>
        : reviewed.length === 0 ? <div className="sb-empty">Nobody has marked this guide as reviewed yet.</div>
        : <ul className="ac-plainlist">{reviewed.map((r) => <li key={r.uid}>{byUid.get(r.uid)?.name || "Former member"}{r.reviewedAt ? <span className="ac-cardsub"> · {formatDateTime(toMs(r.reviewedAt))}</span> : null}</li>)}</ul>)}
      <p className="ac-note">Self-reported by each learner. A review is not a skill assessment and differs from course or path completion.</p>
    </section>
  );
}

/* ===================================================================
   Learning path
   =================================================================== */
const ITEM_ICON = { course: AcademicCapIcon, lesson: PlayIcon, guide: DocumentTextIcon };
const ITEM_LABEL = { course: "Course", lesson: "Lesson", guide: "Resource" };

/* Every doc a path references, keyed for resolvePathItems. */
function useResolvedPath(path, me, progressByCourse, reviewsByGuide) {
  const hiddenIds = useTax().hidden;
  const refs = useMemo(() => {
    const set = new Set();
    for (const it of (path && path.items) || []) {
      if (it.type === "course" && it.courseId) set.add(`courses/${it.courseId}`);
      if (it.type === "lesson" && it.courseId && it.lessonId) { set.add(`courses/${it.courseId}`); set.add(`courses/${it.courseId}/lessons/${it.lessonId}`); }
      if (it.type === "guide" && it.guideId) set.add(`guides/${it.guideId}`);
    }
    return [...set].sort();
  }, [path]);
  const docs = useManyDocs(refs);
  const ctx = useMemo(() => {
    const c = { me, courses: {}, lessons: {}, guides: {}, progressByCourse, reviews: reviewsByGuide, hidden: hiddenIds };
    for (const [p, d] of Object.entries(docs.byPath)) {
      let m;
      if ((m = p.match(/^courses\/([^/]+)$/))) c.courses[m[1]] = d;
      else if ((m = p.match(/^courses\/([^/]+)\/lessons\/([^/]+)$/))) c.lessons[`${m[1]}/${m[2]}`] = d;
      else if ((m = p.match(/^guides\/([^/]+)$/))) c.guides[m[1]] = d;
    }
    return c;
  }, [docs.byPath, me, progressByCourse, reviewsByGuide, hiddenIds]);
  return { ctx, loaded: docs.loaded };
}

function PathView({ me, users, isAdmin, pathId, R }) {
  const tax = useTax();
  const path = usePathDoc(pathId);
  const visible = !!path.data && canViewContent(me, path.data);
  const progress = useAllProgress(me.id);
  const reviews = useAllGuideReviews(me.id);
  const mine = usePathProgressDoc(me.id, pathId);
  const { ctx, loaded: refsLoaded } = useResolvedPath(visible ? path.data : null, me, progress.byCourse, reviews.byGuide);
  const [editing, setEditing] = useState(false);
  // Remember a GENUINE completion (every required step reachable and done) on
  // the learner's own doc, so later path edits can't erase that history.
  const liveDone = useMemo(() => (visible && refsLoaded && path.data ? pathProgress(resolvePathItems(path.data, ctx)).completed : false), [visible, refsLoaded, path.data, ctx]);
  useEffect(() => {
    if (liveDone && mine.loaded && !mine.data?.completedAt) recordPathCompleted(me.id, pathId, !!mine.data).catch(() => {});
  }, [liveDone, mine.loaded, mine.data?.completedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (path.data?.title) document.title = `${path.data.title} · Learn · IFC Creatives Board`; }, [path.data?.title]);
  const ready = path.loaded && progress.loaded && reviews.loaded && mine.loaded && (!visible || refsLoaded);
  if (!ready) return <div className="sb-page"><BackLink to="/learn" label="Creative Academy" R={R} /><Skeleton lines={6} /></div>;
  if (!visible) return <NotAvailable R={R} what="learning path" />;
  const p = path.data;
  const resolved = resolvePathItems(p, ctx);
  const summary = pathProgress(resolved);
  const next = nextPathItem(resolved);
  const editor = canEditContent(me, p);
  const leader = canViewLearnerProgress(me);
  // Courses/lessons opened from here carry ?path= so the course can offer
  // "Continue learning path" when it's finished.
  const hrefFor = (it) => pathStepHref(it, pathId, progress.byCourse);
  const openItem = async (it) => {
    try { await recordPathView(me.id, pathId, it.key, !!mine.data); } catch {}
    R.navigate(hrefFor(it));
  };
  return (
    <div className="sb-page ac-course ac-pathpage">
      <BackLink to="/learn" label="Creative Academy" R={R} />
      <div className="ac-coursehead">
        <StoredImage imageRef={p.cover} alt="" className="ac-coursecover" ratio="3 / 4" placeholder={<MapIcon className="hi" aria-hidden="true" />} />
        <div className="ac-coursemeta">
          <div className="ac-cardmeta">
            <span className="ac-fmt"><MapIcon className="hi hi-xs" aria-hidden="true" />Learning path</span>
            {p.category && <span className="ac-cat">{categoryNameIn(tax.categories, p.category)}</span>}
            {p.status !== "published" && <Pill tone="warn">{p.status}</Pill>}
          </div>
          <h1 className="ac-h1">{p.title}</h1>
          {p.purpose && <p className="ac-purpose-intro">{p.purpose}</p>}
          <TopicChips item={p} R={R} />
          <div className="ac-facts">
            <span>{summary.total} required step{summary.total === 1 ? "" : "s"}</span>
            {summary.optionalTotal > 0 && <span>{summary.optionalTotal} optional</span>}
            {summary.unavailable > 0 && <span className="ac-warn">{summary.unavailable} currently unavailable</span>}
          </div>
          <div className="ac-actions">
            <BusyButton className="sb-btn compact" onClick={() => next && openItem(next)} disabled={!next}>
              <PlayIcon className="hi hi-sm" aria-hidden="true" />{summary.completed ? "Review path" : summary.started ? "Continue" : "Start path"}
            </BusyButton>
            {editor && <button type="button" className="sb-btn ghost compact" onClick={() => setEditing(true)}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Edit path</button>}
          </div>
          {(summary.started || summary.completed || mine.data?.completedAt) && (
            <div className="ac-summary">
              <ProgressBar percent={summary.percent} label={`${p.title}: ${summary.percent}% complete`} />
              <span className="ac-cardsub">
                {summary.completed ? "Completed. Every required step is done."
                  : `${summary.done} of ${summary.total} required steps · ${summary.percent}%${summary.unavailable ? ` · ${summary.unavailable} unavailable` : ""}`}
              </span>
              {summary.blocked && (
                <p className="ac-pathnote" role="status"><ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" />
                  {summary.unavailable === 1 ? "1 required step is" : `${summary.unavailable} required steps are`} unavailable (removed, unpublished or hidden), so this path can't be completed until {summary.unavailable === 1 ? "it's" : "they're"} back or the path is updated.</p>
              )}
              {mine.data?.completedAt && !summary.completed && (
                <p className="ac-pathnote">You completed this path on {formatDateTime(toMs(mine.data.completedAt))}. It has changed since.</p>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="ac-coursebody"><div className="ac-coursemain">
        <section aria-labelledby="ac-steps-h">
          <h2 id="ac-steps-h" className="ac-h2">The journey</h2>
          {resolved.length === 0 && <div className="sb-empty">No steps yet.</div>}
          <ol className="ac-steps">
            {resolved.map((it, i) => {
              const Icon = ITEM_ICON[it.type] || DocumentTextIcon;
              const isNext = next && next.key === it.key;
              const locked = it.available && it.type === "lesson" && !it.completed && it.course && !lessonOpenFromModules(it.course, progress.byCourse[it.courseId], it.lessonId);
              return (
                <li key={it.key || i}>
                  {it.available ? (
                    <button type="button" className={"ac-lesson ac-step" + (it.completed ? " done" : "") + (isNext ? " current" : "")} onClick={() => openItem(it)} aria-current={isNext ? "step" : undefined}>
                      <span className="ac-lessonidx" aria-hidden="true">{it.completed ? <CheckCircleSolid className="hi hi-sm" /> : locked ? <LockClosedIcon className="hi hi-xs" /> : i + 1}</span>
                      <span className="ac-lessontxt">
                        <span className="ac-lessontitle">{it.title}{locked && <span className="sb-vh"> (locked)</span>}</span>
                        <span className="ac-lessonsub"><Icon className="hi hi-xs" aria-hidden="true" /> {ITEM_LABEL[it.type]}{locked ? " · Locked until other lessons in its course are complete" : ""}{it.subtitle && it.subtitle !== it.title ? ` · ${it.subtitle}` : ""}{!it.required ? " · Optional" : ""}{it.completed ? (it.type === "guide" ? " · Reviewed" : " · Completed") : isNext ? " · Up next" : it.started ? " · In progress" : ""}{it.type === "course" && it.started && !it.completed ? ` · ${it.percent}%` : ""}</span>
                      </span>
                      <ChevronRightIcon className="hi hi-sm ac-chev" aria-hidden="true" />
                    </button>
                  ) : (
                    <div className="ac-lesson ac-step unavailable" aria-disabled="true">
                      <span className="ac-lessonidx" aria-hidden="true"><LockClosedIcon className="hi hi-xs" /></span>
                      <span className="ac-lessontxt">
                        <span className="ac-lessontitle">{it.label || "Unavailable step"}</span>
                        <span className="ac-lessonsub">{ITEM_LABEL[it.type]} · not available right now (unpublished, archived or removed){!it.required ? " · Optional" : ""}</span>
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="ac-note">Progress here is the same progress you earn on the courses, lessons and guides themselves, so finishing a step anywhere counts everywhere.</p>
        </section>
        {leader && <PathLeaderProgress path={p} ctx={ctx} users={users} />}
      </div></div>
      {editing && <PathEditor me={me} users={users} pathId={pathId} onClose={() => setEditing(false)} />}
    </div>
  );
}

/* Leaders: who started this path and how far each learner is — computed with
   the SAME resolver, using each learner's course progress + guide reviews. */
function PathLeaderProgress({ path, ctx, users }) {
  const [open, setOpen] = useState(false);
  const rows = useLeaderPathProgress(path.id, open);
  const courseIds = useMemo(() => [...new Set((path.items || []).filter((i) => i.courseId).map((i) => i.courseId))], [path.items]);
  const guideIds = useMemo(() => [...new Set((path.items || []).filter((i) => i.type === "guide").map((i) => i.guideId))], [path.items]);
  const cp = useLeaderCourseProgressIn(courseIds, open);
  const gr = useLeaderGuideReviewsIn(guideIds, open);
  const byUid = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const learners = useMemo(() => rows.docs.map((r) => {
    const progressByCourse = {}; const reviews = {};
    for (const d of cp.docs) if (d.uid === r.uid) progressByCourse[d.courseId] = d;
    for (const d of gr.docs) if (d.uid === r.uid) reviews[d.guideId] = d;
    const s = pathProgress(resolvePathItems(path, { ...ctx, progressByCourse, reviews }));
    return { uid: r.uid, lastViewedAt: r.lastViewedAt, s };
  }), [rows.docs, cp.docs, gr.docs, path, ctx]);
  return (
    <section className="ac-leader" aria-labelledby="ac-pleader-h">
      <div className="sb-shead">
        <h2 id="ac-pleader-h" className="ac-h2">Learner progress</h2>
        <button type="button" className="sb-btn quiet compact" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"}</button>
      </div>
      {open && (!(rows.loaded && cp.loaded && gr.loaded) ? <Skeleton lines={3} />
        : rows.error || cp.error || gr.error ? <div className="sb-empty" role="alert">Couldn't load learner progress.</div>
        : learners.length === 0 ? <div className="sb-empty">Nobody has started this path yet.</div>
        : (
          <table className="ac-table">
            <thead><tr><th scope="col">Learner</th><th scope="col">Path progress</th><th scope="col">Last active</th></tr></thead>
            <tbody>{learners.map((l) => (
              <tr key={l.uid}>
                <td>{byUid.get(l.uid)?.name || "Former member"}</td>
                <td><div className="ac-tdprog"><ProgressBar percent={l.s.percent} compact label={`${byUid.get(l.uid)?.name || "Learner"}: ${l.s.percent}%`} /><span>{l.s.done}/{l.s.total}{l.s.completed ? " ✓" : ""}</span></div></td>
                <td>{l.lastViewedAt ? formatDateTime(toMs(l.lastViewedAt)) : "Not yet"}</td>
              </tr>))}</tbody>
          </table>
        ))}
      <p className="ac-note">Path completion counts courses and lessons completed plus guides the learner marked as reviewed (self-reported). It is a learning milestone, not approval to serve.</p>
    </section>
  );
}

/* Topic chips — record topics open the topic filter by stable id (so a rename
   never breaks the link); legacy free-text tags fall back to a text search.
   Hidden topics aren't shown. */
function TopicChips({ item, R }) {
  const { topicsById, topicsLoaded } = useTopicsById();
  const chips = topicsLoaded ? topicChips(item, topicsById) : [];
  if (!chips.length) return null;
  return (
    <div className="ac-topics" aria-label="Topics">
      {chips.map((t) => <button type="button" key={t.id || "t:" + t.name} className="sb-tag ac-tagbtn" onClick={() => R.navigate(t.id ? learnBrowsePath({ topic: t.id }) : learnBrowsePath({ q: t.name }))}>{t.name}</button>)}
    </div>
  );
}

/* /learn/preview/course/:id[/lesson/:lid] — the course's current DRAFT, shown
   through the learner components. Editors only (drafts are editor-readable
   only, enforced by the rules). Loaded once per visit; "Refresh" re-reads. */
const noAttempts = () => ({ docs: [], loaded: true });
const previewSubmit = async () => { throw new Error("This is a draft preview, so quizzes aren't graded here. Publish the course to let learners take the quiz."); };
function PreviewBanner({ courseId, lessonId, pathCtx = null, R }) {
  return (
    <div className="ac-previewbar" role="status">
      <EyeIcon className="hi hi-sm" aria-hidden="true" /><span><b>Draft preview.</b> This is how learners will see your changes after you publish. Nothing you do here is saved to anyone's progress.</span>
      <button type="button" className="sb-btn compact" onClick={() => R.navigate(learnManagePath({ view: "course", id: courseId, item: lessonId || "", path: pathCtx || "" }))}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Back to editing</button>
    </div>
  );
}
function DraftPreview({ me, users, courseId, lessonId, pathCtx = null, R }) {
  const [state, setState] = useState({ loaded: false });
  useEffect(() => {
    let live = true;
    if (!isAcademyEditor(me)) { setState({ loaded: true, denied: true }); return undefined; }
    loadCourseWorkspace(courseId).then((w) => { if (live) setState({ loaded: true, w }); }).catch((e) => { if (live) setState({ loaded: true, error: e?.message || "Couldn't load the draft." }); });
    return () => { live = false; };
  }, [courseId, me]);
  useEffect(() => { document.title = `Preview · ${state.w?.course?.title || "Course"} · IFC Creatives Board`; }, [state.w?.course?.title]);
  if (!state.loaded) return <div className="sb-page"><Skeleton lines={8} /></div>;
  if (state.denied) return <NotAvailable R={R} what="page" />;
  if (state.error || !state.w?.course) return <div className="sb-page"><div className="sb-empty" role="alert">{state.error || "There's no draft of this course to preview."}</div></div>;
  const { course, lessons } = state.w;
  const c = { id: courseId, ...course, status: "published" };
  const docs = Object.entries(lessons).map(([id, l]) => ({ id, ...l }));
  return lessonId
    ? <LessonBody me={me} users={users} R={R} c={c} lessons={docs} progress={null} courseId={courseId} lessonId={lessonId} pathCtx={pathCtx} preview />
    : <CourseOverviewBody me={me} users={users} R={R} c={c} lessons={docs} progress={null} courseId={courseId} pathCtx={pathCtx} editor={false} leader={false} preview />;
}
