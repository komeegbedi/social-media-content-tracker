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
  CameraIcon, FilmIcon, PaintBrushIcon, MegaphoneIcon, UserGroupIcon, HeartIcon, ArrowPathIcon, ClipboardDocumentCheckIcon, LinkIcon,
} from "@heroicons/react/24/outline";
import { CheckCircleIcon as CheckCircleSolid, MapPinIcon as MapPinSolid } from "@heroicons/react/24/solid";
import { learnPath, learnGuidePath, learnPathwayPath, learnCategoryPath, learnBrowsePath, learnManagePath, learnPreviewPath } from "./nav.js";
import { loadYouTubeApi } from "./youtubeApi.js";
import { recommendations, recentlyPublished, categoryCounts, continueTargets } from "./academyRecommend.js";
import { orderCourses } from "./academyOrder.js";
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
  isAcademyEditor,
} from "./academyProgress.js";
import { videoFromRecord, PROVIDER_ORIGINS, shouldPersistPosition, resumePosition, videoWatchedFromEvent } from "./academyVideo.js";
import { parseMarkdown, parseInlines } from "./academyMarkdown.js";
import {
  useCourses, useCourse, useLessons, usePurposeVideo, useProgress, useAllProgress, useAttempts, useComments,
  useLeaderProgress, useLeaderAttempts, useImageUrl, recordLessonView, startCourse, savePlayback, markVideoWatched,
  setManualDone, submitQuiz, addComment, editComment, deleteComment, pinComment,
  useGuides, usePaths, useGuide, usePathDoc, useManyDocs, useAllGuideReviews, useGuideReview, setGuideReviewed,
  useAllPathProgress, usePathProgressDoc, recordPathView, recordPathCompleted, useLeaderGuideReviews, useLeaderPathProgress,
  useLeaderCourseProgressIn, useLeaderGuideReviewsIn, useCategoryArt, useIntroState, setIntroWatched,
  useCategoryRecords, useCategoryIndex, useTopicRecords, loadCourseWorkspace,
} from "./academyData.js";
import { PurposeVideoEditor, GuideEditor, PathEditor, AcademyEditorScope } from "./AcademyManage.jsx";
import AcademyWorkspace from "./AcademyWorkspace.jsx";
import { courseRuntime, formatRuntime, formatClock } from "./academyDrafts.js";
import { StoredImage, CategoryArt, VideoThumb, Markdown, SafeText, renderInlines } from "./academyShared.jsx";
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
      <ArrowLeftIcon className="hi hi-sm" aria-hidden="true" /> {label}
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
const DEFAULT_TAX = (() => { const categories = mergeCategories([]); return { categories, visible: categories, hidden: [], topicsById: {}, loaded: true }; })();
export const useTax = () => React.useContext(TaxCtx) || DEFAULT_TAX;
function useTaxonomy() {
  const recs = useCategoryRecords();
  const idx = useCategoryIndex();
  const topics = useTopicRecords();
  return useMemo(() => {
    const categories = mergeCategories(recs.docs).map((c) => (idx.hidden.includes(c.id) ? { ...c, hidden: true } : c));
    const hidden = [...new Set([...idx.hidden, ...categories.filter((c) => c.hidden).map((c) => c.id)])];
    return { categories, visible: categories.filter((c) => !c.hidden), hidden, topicsById: topics.byId, loaded: recs.loaded && idx.loaded && topics.loaded };
  }, [recs.docs, recs.loaded, idx.hidden, idx.loaded, topics.byId, topics.loaded]);
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
      <AcademyEditorScope me={props.me}><AcademyRoutes {...props} /></AcademyEditorScope>
    </TaxCtx.Provider>
  );
}
function AcademyRoutes({ me, users, isAdmin, nav, R }) {
  if (nav.manage) return <AcademyWorkspace me={me} users={users} nav={nav} R={R} />;
  if (nav.preview && nav.courseId) return <DraftPreview me={me} users={users} courseId={nav.courseId} lessonId={nav.lessonId} R={R} />;
  if (nav.courseId && nav.lessonId) return <LessonView me={me} users={users} isAdmin={isAdmin} courseId={nav.courseId} lessonId={nav.lessonId} R={R} />;
  if (nav.courseId) return <CourseOverview me={me} users={users} isAdmin={isAdmin} courseId={nav.courseId} R={R} />;
  if (nav.guideId) return <GuideView me={me} users={users} isAdmin={isAdmin} guideId={nav.guideId} R={R} />;
  if (nav.pathId) return <PathView me={me} users={users} isAdmin={isAdmin} pathId={nav.pathId} R={R} />;
  if (nav.categoryId) return <CategoryPage me={me} users={users} isAdmin={isAdmin} categoryId={nav.categoryId} R={R} />;
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

/* Portrait 3:4 poster, the same shape as course covers; name, short
   description and the learner-visible course count sit below the artwork. */
export function CategoryCard({ category, count, imageRef, onOpen }) {
  return (
    <div className="ac-catcard" role="listitem">
      <button type="button" className="ac-catbtn" onClick={onOpen} aria-label={`${category.label} — ${count} course${count === 1 ? "" : "s"}`}>
        <CategoryArt category={category} imageRef={imageRef} />
        <span className="ac-catbody">
          <span className="ac-cattitle">{category.label}</span>
          <span className="ac-catdesc">{category.purpose}</span>
          <span className="ac-catcount">{count} course{count === 1 ? "" : "s"}</span>
        </span>
      </button>
    </div>
  );
}

/* Lesson docs for the "continue" rows only (one per started course, ≤ 3). */
function useContinueLessons(courses, progressByCourse) {
  const targets = useMemo(() => continueTargets(courses, progressByCourse), [courses, progressByCourse]);
  const refs = useMemo(() => targets.filter((t) => t.nextLessonId).map((t) => `courses/${t.course.id}/lessons/${t.nextLessonId}`), [targets]);
  const docs = useManyDocs(refs);
  const lessonsById = useMemo(() => {
    const m = {};
    for (const [path, d] of Object.entries(docs.byPath)) { const x = path.match(/^courses\/([^/]+)\/lessons\/([^/]+)$/); if (x && d) m[`${x[1]}/${x[2]}`] = d; }
    return m;
  }, [docs.byPath]);
  return { lessonsById, loaded: docs.loaded };
}

function LearnHome({ me, users, isAdmin, R }) {
  const { courses, loaded: cLoaded, error: cErr } = useCourses(me);
  const { guides, loaded: gLoaded } = useGuides(me);
  const { paths } = usePaths(me);
  const purpose = usePurposeVideo();
  const art = useCategoryArt();
  const intro = useIntroState(me.id);
  const progress = useAllProgress(me.id);
  const [q, setQ] = useState("");
  const [showPurpose, setShowPurpose] = useState(false);
  const [editPurpose, setEditPurpose] = useState(false);
  const [busyIntro, setBusyIntro] = useState(false);
  const tax = useTax();
  const loaded = cLoaded && gLoaded && tax.loaded;
  const purposeVideo = purpose.data?.video ? videoFromRecord(purpose.data.video) : null;
  const introWatched = intro.data?.watched === true;
  const pubCourses = useMemo(() => learnerVisible(courses, tax.hidden), [courses, tax.hidden]);
  const pubGuides = useMemo(() => learnerVisible(guides, tax.hidden), [guides, tax.hidden]);
  const counts = useMemo(() => categoryCounts(me, pubCourses, tax.hidden), [me, pubCourses, tax.hidden]);
  const { lessonsById } = useContinueLessons(pubCourses, progress.byCourse);
  const recs = useMemo(() => recommendations({ me, courses: pubCourses, progressByCourse: progress.byCourse, lessonsById, max: 4, categories: tax.categories }), [me, pubCourses, progress.byCourse, lessonsById, tax.categories]);
  const recent = useMemo(() => {
    const suggested = new Set(recs.map((r) => r.course.id));
    return recentlyPublished({ me, courses: pubCourses, guides: pubGuides, limit: 10, hidden: tax.hidden })
      .filter((x) => !(x.item.format === "course" && suggested.has(x.item.id))).slice(0, 5);
  }, [me, pubCourses, pubGuides, tax.hidden, recs]);
  const publishedPaths = paths.filter((p) => p.status === "published").length;
  // The featured "Start here" category is referenced by its STABLE id; a hidden or
  // deleted record simply drops the "More from…" link (no broken route).
  const introCat = categoryIn(tax.categories, INTRO_CATEGORY_ID);
  const introCatVisible = !!introCat && !introCat.hidden;
  const editor = isAcademyEditor(me);
  const showStart = !!purposeVideo || introCatVisible || isAdmin;
  const search = (e) => { e.preventDefault(); if (q.trim()) R.navigate(learnBrowsePath({ q: q.trim() })); };
  const markIntro = async (watched) => { setBusyIntro(true); try { await setIntroWatched(me.id, watched); } catch {} finally { setBusyIntro(false); } };

  return (
    <div className="sb-page ac-home">
      <div className="ac-homehead">
        <div>
          <div className="sb-mlabel">Learn</div>
          <h1 className="ac-h1">Creative Academy</h1>
        </div>
        <div className="ac-headtools">
          <form className="ac-search ac-homesearch" onSubmit={search} role="search">
            <MagnifyingGlassIcon className="hi hi-sm" aria-hidden="true" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the Academy" aria-label="Search the Academy" />
          </form>
          {editor && <button type="button" className="sb-btn ghost compact ac-managebtn" onClick={() => R.navigate("/learn/manage")}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Manage</button>}
        </div>
      </div>

      {/* A — compact introduction */}
      {showStart && <section className={"ac-start" + (introWatched && !showPurpose ? " done" : "")} aria-labelledby="ac-start-h">
        <div className="ac-startcard">
          <div className="ac-startmedia">
            {showPurpose && purposeVideo
              ? <VideoPlayer video={purposeVideo} title={purpose.data?.title || "The Heart Behind the Creative"} onEnded={() => { if (!introWatched) markIntro(true); }} />
              : (
                <button type="button" className="ac-purpose-play" onClick={() => setShowPurpose(true)} disabled={!purposeVideo}
                  aria-label={purposeVideo ? `${introWatched ? "Watch again" : "Watch"}: ${purpose.data?.title || "The Heart Behind the Creative"}` : "No introduction video yet"}>
                  <StoredImage imageRef={purpose.data?.thumb} alt="" ratio="16 / 9" placeholder={<PlayIcon className="hi" aria-hidden="true" />} />
                  {purposeVideo && <span className="ac-playbadge" aria-hidden="true"><PlayIcon className="hi" /></span>}
                </button>
              )}
          </div>
          <div className="ac-startbody">
            <div className="sb-mlabel" id="ac-start-h">Start here{introWatched && <span className="ac-done" style={{ marginInlineStart: 8 }}><CheckCircleSolid className="hi hi-xs" aria-hidden="true" />Watched</span>}</div>
            <h2 className="ac-h2">{purpose.data?.title || "The Heart Behind the Creative"}</h2>
            {!(introWatched && !showPurpose) && (purpose.data?.intro || introCat?.purpose) && <p className="ac-purpose-intro">{purpose.data?.intro || introCat?.purpose}</p>}
            <div className="ac-actions">
              {purposeVideo && !showPurpose && <button type="button" className={"sb-btn compact" + (introWatched ? " ghost" : "")} onClick={() => setShowPurpose(true)}>{introWatched ? <ArrowPathIcon className="hi hi-sm" aria-hidden="true" /> : <PlayIcon className="hi hi-sm" aria-hidden="true" />}{introWatched ? "Watch again" : "Watch introduction"}</button>}
              {introCatVisible && <button type="button" className="sb-btn quiet compact" onClick={() => R.navigate(learnCategoryPath(introCat.id))}><HeartIcon className="hi hi-sm" aria-hidden="true" />More from {introCat.label}</button>}
              {purposeVideo && !introWatched && purposeVideo.capabilities && !purposeVideo.capabilities.tracksEnded && <BusyButton className="sb-btn quiet compact" busy={busyIntro} onClick={() => markIntro(true)}>Mark as watched</BusyButton>}
              {isAdmin && <button type="button" className="sb-btn quiet compact" onClick={() => setEditPurpose(true)}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />{purpose.data ? "Edit intro" : "Set up intro"}</button>}
            </div>
          </div>
        </div>
      </section>}
      {editPurpose && <PurposeVideoEditor me={me} current={purpose.data} onClose={() => setEditPurpose(false)} />}

      {/* B — explore categories (primary browsing) */}
      <section aria-labelledby="ac-cats-h">
        <div className="sb-shead">
          <h2 id="ac-cats-h" className="ac-h2">Explore categories</h2>
          <button type="button" className="ac-link" onClick={() => R.navigate(learnBrowsePath({ format: "course" }))}>Browse all courses<ChevronRightIcon className="hi hi-xs" aria-hidden="true" /></button>
        </div>
        {!loaded ? <div className="ac-catgrid" aria-busy="true">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="ac-catcard"><div className="ac-catart sb-skel" style={{ aspectRatio: "3 / 4" }} /></div>)}</div>
          : cErr ? <div className="sb-empty" role="alert">Couldn't load the Academy. Check your connection and try again.</div>
          : tax.visible.length === 0 ? <div className="sb-empty">No categories yet.{isAdmin && <> Create one in <b>Admin → Academy → Categories</b>.</>}</div>
          : (
            <div className="ac-catgrid" role="list">
              {tax.visible.map((c) => <CategoryCard key={c.id} category={c} count={counts[c.id] || 0} imageRef={c.cover || art.data?.art?.[c.id]} onOpen={() => R.navigate(learnCategoryPath(c.id))} />)}
            </div>
          )}
      </section>

      {/* C — for you */}
      {loaded && recs.length > 0 && (
        <section aria-labelledby="ac-foryou-h">
          <div className="sb-shead"><h2 id="ac-foryou-h" className="ac-h2">For you</h2></div>
          <div className="ac-recs" role="list">
            {recs.map((r) => {
              const lesson = r.kind === "continue" ? r.lesson : null;
              const href = r.kind === "continue" && r.lessonId ? learnPath(r.course.id, r.lessonId) : learnPath(r.course.id);
              return (
                <div key={r.course.id} className="ac-rec" role="listitem">
                  <button type="button" className={"ac-recbtn" + (lesson && lesson.video ? " is-video" : "")} onClick={() => R.navigate(href)}>
                    {lesson && lesson.video
                      ? <VideoThumb item={lesson} className="ac-recvideo" placeholder={<PlayIcon className="hi" aria-hidden="true" />} />
                      : <StoredImage imageRef={r.course.cover} alt="" className="ac-reccover" ratio="3 / 4" />}
                    <span className="ac-recbody">
                      <span className="ac-recreason">{r.reason}</span>
                      <span className="ac-rectitle">{lesson ? lesson.title : r.course.title}</span>
                      <span className="ac-cardsub">{lesson ? <>{lessonKindMeta(lesson).label} · in <b className="ac-recparent">{r.course.title}</b></> : `Course · ${categoryShortIn(tax.categories, r.course.category)}${r.course.level ? ` · ${levelLabel(r.course.level)}` : ""}`}</span>
                      {r.summary && <ProgressBar percent={r.summary.percent} compact label={`${r.course.title}: ${r.summary.percent}% complete`} />}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* D — recently added */}
      {loaded && recent.length > 0 && (
        <section aria-labelledby="ac-recent-h">
          <div className="sb-shead">
            <h2 id="ac-recent-h" className="ac-h2">Recently added</h2>
            <button type="button" className="ac-link" onClick={() => R.navigate(learnBrowsePath({ sort: "recent" }))}>View all<ChevronRightIcon className="hi hi-xs" aria-hidden="true" /></button>
          </div>
          <div className="ac-recent" role="list">
            {recent.map(({ item, publishedMs }) => (
              <button type="button" key={item.format + item.id} className="ac-recentrow" role="listitem" onClick={() => R.navigate(item.format === "guide" ? learnGuidePath(item.id) : learnPath(item.id))}>
                <span className="ac-fmt">{item.format === "guide" ? <DocumentTextIcon className="hi hi-xs" aria-hidden="true" /> : <AcademicCapIcon className="hi hi-xs" aria-hidden="true" />}{item.format === "guide" ? "Quick guide" : "Course"}</span>
                <span className="ac-recenttitle">{item.title}</span>
                <span className="ac-cardsub">{categoryShortIn(tax.categories, item.category)} · {formatDateTime(publishedMs)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="ac-secondary" aria-label="More ways to learn">
        <button type="button" className="ac-link" onClick={() => R.navigate(learnBrowsePath({ format: "path" }))}><MapIcon className="hi hi-sm" aria-hidden="true" />Learning paths{loaded ? ` · ${publishedPaths}` : ""}</button>
        <button type="button" className="ac-link" onClick={() => R.navigate(learnBrowsePath({ format: "guide" }))}><DocumentTextIcon className="hi hi-sm" aria-hidden="true" />All quick guides</button>
        <button type="button" className="ac-link" onClick={() => R.navigate(learnBrowsePath({}))}><BookOpenIcon className="hi hi-sm" aria-hidden="true" />Browse everything</button>
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
            {it.to ? <button type="button" className="ac-link inline" onClick={() => R.navigate(it.to)}>{it.label}</button> : <span aria-current="page">{it.label}</span>}
            {i < items.length - 1 && <ChevronRightIcon className="hi hi-xs" aria-hidden="true" />}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function CategoryPage({ me, users, isAdmin, categoryId, R }) {
  const tax = useTax();
  const canonical = normalizeCategory(categoryId);
  const record = categoryIn(tax.categories, categoryId);
  const editor = isAcademyEditor(me);
  // Hidden categories are unavailable to learners (rules hide their courses too);
  // editors can still open them, with a clear "Hidden" label.
  const category = record && (!record.hidden || editor) ? record : null;
  // Legacy ids (e.g. /learn/category/videography) land on the canonical page.
  useEffect(() => { if (category && canonical !== categoryId) R.replace(learnCategoryPath(canonical)); }, [category, canonical, categoryId]); // eslint-disable-line react-hooks/exhaustive-deps
  const { courses, loaded, error } = useCourses(me);
  const { guides, loaded: gLoaded } = useGuides(me);
  const progress = useAllProgress(me.id);
  const art = useCategoryArt();
  useEffect(() => { if (category) document.title = `${category.label} · Learn · IFC Creatives Board`; }, [category]);
  if (!tax.loaded) return <div className="sb-page"><Skeleton lines={6} /></div>;
  if (!category) return <NotAvailable R={R} what="category" />;
  // Same ordering function as the workspace's drag-and-drop list.
  const list = orderCourses(courses.filter((c) => c.status === "published" && normalizeCategory(c.category) === category.id), category.courseOrder || []);
  const drafts = courses.filter((c) => c.status !== "published" && normalizeCategory(c.category) === category.id && canEditContent(me, c));
  const tips = guides.filter((g) => g.status === "published" && normalizeCategory(g.category) === category.id);
  const cont = continueTargets(list, progress.byCourse, 1)[0] || null;
  return (
    <div className="sb-page ac-catpage">
      <Breadcrumb R={R} items={[{ label: "Learn", to: "/learn" }, { label: category.label }]} />
      <div className="ac-cathead">
        <CategoryArt category={category} imageRef={category.cover || art.data?.art?.[category.id]} className="ac-catheadart" />
        <div>
          {category.hidden && <span className="ac-pill warn">Hidden from learners</span>}
          <div className="ac-titlerow"><h1 className="ac-h1">{category.label}</h1>
            {editor && !category.bootstrap && <button type="button" className="sb-btn ghost compact" onClick={() => R.navigate(learnManagePath({ view: "category", id: category.id }))}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />{isAdmin ? "Manage category" : "Add or edit courses"}</button>}</div>
          <p className="sb-sub" style={{ marginBottom: 6 }}>{category.purpose}</p>
          <div className="ac-cardsub">{loaded ? `${list.length} published course${list.length === 1 ? "" : "s"}` : "…"}</div>
        </div>
      </div>
      {cont && (
        <section aria-labelledby="ac-catcont-h" className="ac-catcont">
          <h2 id="ac-catcont-h" className="sb-vh">Continue your course</h2>
          <button type="button" className="ac-contcard" onClick={() => R.navigate(cont.nextLessonId ? learnPath(cont.course.id, cont.nextLessonId) : learnPath(cont.course.id))}>
            <StoredImage imageRef={cont.course.cover} alt="" className="ac-contcover" ratio="3 / 4" />
            <span className="ac-contbody">
              <span className="ac-contcat">Continue your course</span>
              <span className="ac-conttitle">{cont.course.title}</span>
              <ProgressBar percent={cont.summary.percent} compact label={`${cont.course.title}: ${cont.summary.percent}% complete`} />
              <span className="ac-contmeta">{cont.summary.done} of {cont.summary.total} lessons · {cont.summary.percent}%</span>
            </span>
          </button>
        </section>
      )}
      <section aria-labelledby="ac-catcourses-h">
        <div className="sb-shead"><h2 id="ac-catcourses-h" className="ac-h2">Courses</h2></div>
        {!loaded ? <CourseGridSkeleton />
          : error ? <div className="sb-empty" role="alert">Couldn't load courses. Check your connection and try again.</div>
          : list.length === 0 ? <div className="sb-empty">No published courses in {category.label} yet.{editor && !category.bootstrap && <> <button type="button" className="ac-link" onClick={() => R.navigate(learnManagePath({ view: "course", category: category.id }))}>Create a course</button></>}</div>
          : <div className="ac-grid" role="list">{list.map((c) => <CourseCard key={c.id} course={c} progress={progress.byCourse[c.id]} onOpen={() => R.navigate(learnPath(c.id))} />)}</div>}
      </section>
      {drafts.length > 0 && (
        <section aria-labelledby="ac-catdrafts-h">
          <div className="sb-shead"><h2 id="ac-catdrafts-h" className="ac-h2">Drafts</h2><span className="sb-tag">Visible to Academy editors only</span></div>
          <div className="ac-grid" role="list">{drafts.map((c) => <CourseCard key={c.id} course={c} onOpen={() => R.navigate(learnManagePath({ view: "course", id: c.id }))} />)}</div>
        </section>
      )}
      {gLoaded && tips.length > 0 && (
        <section aria-labelledby="ac-tips-h" className="ac-tips">
          <div className="sb-shead"><h2 id="ac-tips-h" className="ac-h2">Tips & resources</h2><span className="ac-cardsub">Quick guides for {category.label}</span></div>
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
function BrowsePage({ me, isAdmin, browse, R }) {
  const { courses, loaded: cLoaded, error: cErr } = useCourses(me);
  const { guides, loaded: gLoaded } = useGuides(me);
  const { paths, loaded: pLoaded } = usePaths(me);
  const progress = useAllProgress(me.id);
  const reviews = useAllGuideReviews(me.id);
  const pathProg = useAllPathProgress(me.id);
  const [q, setQ] = useState(browse.q || "");
  useEffect(() => { setQ(browse.q || ""); }, [browse.q]);
  const set = (patch) => R.navigate(learnBrowsePath({ ...browse, ...patch }), { replace: true });
  const tax = useTax();
  const loaded = cLoaded && gLoaded && pLoaded && tax.loaded;
  // Search text includes topic NAMES (renames apply; hidden topics don't match).
  const all = useMemo(() => learnerVisible([...courses, ...guides, ...paths], tax.hidden)
    .map((x) => ({ ...x, topics: topicNamesFor(x, tax.topicsById) })), [courses, guides, paths, tax.hidden, tax.topicsById]);
  const topic = browse.topic ? tax.topicsById[browse.topic] : null;
  const topicOk = !!topic && !topic.hidden;
  let list = useMemo(() => {
    const base = filterCourses(all, { q: browse.q, category: browse.category, format: browse.format });
    if (!browse.topic) return base;
    if (!topicOk) return [];
    return base.filter((x) => hasTopic(x, topic));
  }, [all, browse.q, browse.category, browse.format, browse.topic, topicOk, topic]);
  if (browse.sort === "recent") list = [...list].sort((a, b) => toMs(b.publishedAt) - toMs(a.publishedAt));
  const open = (item) => R.navigate(item.format === "guide" ? learnGuidePath(item.id) : item.format === "path" ? learnPathwayPath(item.id) : learnPath(item.id));
  const title = browse.topic ? (topicOk ? `Topic: ${topic.name}` : "Topic") : browse.sort === "recent" ? "Recently added" : browse.format === "path" ? "Learning paths" : browse.format === "guide" ? "Quick guides" : browse.format === "course" ? "All courses" : "Browse";
  return (
    <div className="sb-page ac-home">
      <Breadcrumb R={R} items={[{ label: "Learn", to: "/learn" }, { label: title }]} />
      <h1 className="ac-h1">{title}</h1>
      <div className="ac-filters">
        <form className="ac-search" role="search" onSubmit={(e) => { e.preventDefault(); set({ q: q.trim() }); }}>
          <MagnifyingGlassIcon className="hi hi-sm" aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => { if (q.trim() !== (browse.q || "")) set({ q: q.trim() }); }} placeholder="Search courses, guides, paths, topics" aria-label="Search" />
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
      {browse.topic && <div className="ac-topicfilter">{topicOk ? <>Showing items tagged <b>{topic.name}</b>{topic.description ? ` — ${topic.description}` : ""}.</> : "This topic isn't available."} <button type="button" className="ac-link" onClick={() => set({ topic: "" })}>Clear topic</button></div>}
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
              ? <GuideCard key={"g" + c.id} guide={c} review={reviews.byGuide[c.id]} onOpen={() => open(c)} />
              : c.format === "path"
                ? <PathCard key={"p" + c.id} path={c} started={!!pathProg.byPath[c.id]} onOpen={() => open(c)} />
                : <CourseCard key={"c" + c.id} course={c} progress={progress.byCourse[c.id]} onOpen={() => open(c)} showFormat />)}
          </div>
        )}
      <p className="ac-note">Search covers courses, quick guides and learning paths (titles, topics and descriptions). Individual lessons open from their course.</p>
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
export function CourseCard({ course, progress, onOpen, showFormat = false }) {
  const tax = useTax();
  const summary = estimateProgress(course, progress);
  const status = course.status !== "published" ? course.status : null;
  return (
    <div className="ac-card" role="listitem">
      <button type="button" className="ac-cardbtn" onClick={onOpen} aria-label={`${course.title}${showFormat ? " (course)" : ""}${summary.completed ? " (completed)" : ""}`}>
        <StoredImage imageRef={course.cover} alt="" className="ac-cover" ratio="3 / 4" />
        <span className="ac-cardbody">
          <span className="ac-cardmeta">
            {showFormat && <span className="ac-fmt"><AcademicCapIcon className="hi hi-xs" aria-hidden="true" />Course</span>}
            <span className="ac-cat">{categoryShortIn(tax.categories, course.category)}</span>
            {status && <Pill tone={status === "draft" ? "warn" : ""}>{status}</Pill>}
          </span>
          <span className="ac-cardtitle">{course.title}</span>
          <span className="ac-cardsub">{levelLabel(course.level)}{course.lessonCount ? ` · ${course.lessonCount} lesson${course.lessonCount === 1 ? "" : "s"}` : ""}</span>
          {summary.completed
            ? <span className="ac-done"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />Completed</span>
            : summary.started
              ? <><ProgressBar percent={summary.percent} compact label={`${course.title}: ${summary.percent}% complete`} /><span className="ac-cardsub">{summary.percent}% complete</span></>
              : null}
        </span>
      </button>
    </div>
  );
}

/* Quick guide: landscape thumbnail (optional), no progress bar — only the
   learner's own "Reviewed" flag. */
export function GuideCard({ guide, review, onOpen }) {
  const tax = useTax();
  const status = guide.status !== "published" ? guide.status : null;
  const reviewed = guideReviewed(review);
  const video = guide.video ? videoFromRecord(guide.video) : null;
  return (
    <div className="ac-card ac-card-guide" role="listitem">
      <button type="button" className="ac-cardbtn" onClick={onOpen} aria-label={`${guide.title} (quick guide)${reviewed ? " (reviewed)" : ""}`}>
        <VideoThumb item={guide} className="ac-guidethumb" placeholder={video ? <PlayIcon className="hi" aria-hidden="true" /> : <DocumentTextIcon className="hi" aria-hidden="true" />} />
        <span className="ac-cardbody">
          <span className="ac-cardmeta">
            <span className="ac-fmt"><DocumentTextIcon className="hi hi-xs" aria-hidden="true" />Quick guide</span>
            <span className="ac-cat">{categoryShortIn(tax.categories, guide.category)}</span>
            {status && <Pill tone={status === "draft" ? "warn" : ""}>{status}</Pill>}
          </span>
          <span className="ac-cardtitle">{guide.title}</span>
          <span className="ac-cardsub">{video ? `Video${guide.durationMinutes ? ` · ${formatDuration(guide.durationMinutes)}` : ""}` : "Text guide"}{guide.body ? " · with notes" : ""}</span>
          {reviewed && <span className="ac-done"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />Reviewed</span>}
        </span>
      </button>
    </div>
  );
}

/* Learning path: portrait cover like a course; the step count stands in for a
   lesson count. Percent lives on the path page (it needs the referenced docs). */
export function PathCard({ path, started = false, onOpen }) {
  const tax = useTax();
  const status = path.status !== "published" ? path.status : null;
  const n = (path.items || []).length;
  return (
    <div className="ac-card" role="listitem">
      <button type="button" className="ac-cardbtn" onClick={onOpen} aria-label={`${path.title} (learning path)`}>
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
      </button>
    </div>
  );
}

/* ===================================================================
   Course overview
   =================================================================== */
function CourseOverview({ me, users, isAdmin, courseId, R }) {
  const tax = useTax();
  const course = useCourse(courseId);
  const visible = !!course.data && canViewCourse(me, course.data, tax.hidden);
  const lessons = useLessons(courseId, visible);
  const progress = useProgress(me.id, courseId);

  useEffect(() => {
    if (course.data?.title) document.title = `${course.data.title} · Learn · IFC Creatives Board`;
  }, [course.data?.title]);

  if (!course.loaded || (visible && !lessons.loaded) || !progress.loaded) return <div className="sb-page"><BackLink to="/learn" label="Creative Academy" R={R} /><Skeleton lines={6} /></div>;
  if (!visible) return <NotAvailable R={R} />;
  return <CourseOverviewBody me={me} users={users} R={R} c={course.data} lessons={lessons.docs} progress={progress.data} courseId={courseId}
    editor={canEditCourse(me, course.data)} leader={canViewLearnerProgress(me)} />;
}

/* What a course costs in time: measured video runtime (never a guess) kept
   separate from authors' reading / exercise estimates. */
function RuntimeFacts({ course, lessons }) {
  const rt = courseRuntime(flatLessons(course, lessons));
  const out = [];
  if (rt.measured > 0) out.push(<span key="v" title={rt.partial ? `${rt.measured} of ${rt.videos - rt.live} videos have a known length` : undefined}>{rt.partial ? "At least " : ""}{formatRuntime(rt.videoSec)} of video</span>);
  if (rt.otherMin > 0) out.push(<span key="o">~{formatDuration(rt.otherMin)} reading &amp; exercises</span>);
  if (!out.length && course.durationMinutes > 0) out.push(<span key="d">{formatDuration(course.durationMinutes)}</span>);
  return out;
}

/* The course page itself. `preview` = rendering the private draft. */
function CourseOverviewBody({ me, users, R, c, lessons: lessonDocs, progress: progressData, courseId, editor, leader, preview = false }) {
  const tax = useTax();
  const curriculum = orderedCurriculum(c, lessonDocs);
  const summary = courseProgress(c, lessonDocs, preview ? null : progressData);
  const resumeId = preview ? (flatLessons(c, lessonDocs)[0]?.id || null) : resumeLessonId(c, lessonDocs, progressData);
  const lessonHref = (id) => (preview ? learnPreviewPath(courseId, id) : learnPath(courseId, id));
  const start = async () => {
    if (!resumeId) return;
    if (!preview && !summary.started) { try { await startCourse(me.id, courseId, !!progressData); } catch {} }
    R.navigate(lessonHref(resumeId));
  };

  const trailer = c.previewVideo ? videoFromRecord(c.previewVideo) : null;
  return (
    <div className="sb-page ac-course">
      {preview && <PreviewBanner courseId={courseId} R={R} />}
      <Breadcrumb R={R} items={[{ label: "Learn", to: "/learn" }, { label: categoryNameIn(tax.categories, c.category), to: categoryIn(tax.categories, c.category) && (!categoryIn(tax.categories, c.category).hidden || isAcademyEditor(me)) ? learnCategoryPath(normalizeCategory(c.category)) : null }, { label: c.title }]} />
      <div className="ac-coursehead">
        <StoredImage imageRef={c.cover} alt="" className="ac-coursecover" ratio="3 / 4" />
        <div className="ac-coursemeta">
          <div className="ac-cardmeta">
            <span className="ac-cat">{categoryNameIn(tax.categories, c.category)}</span>
            <Pill>{levelLabel(c.level)}</Pill>
            {!preview && c.status !== "published" && <Pill tone="warn">{c.status}</Pill>}
          </div>
          <h1 className="ac-h1">{c.title}</h1>
          <TopicChips item={c} R={R} />
          <div className="ac-facts">
            <span>{summary.total + summary.bonusTotal} lesson{summary.total + summary.bonusTotal === 1 ? "" : "s"}</span>
            <RuntimeFacts course={c} lessons={lessonDocs} />
            {summary.bonusTotal > 0 && <span>{summary.bonusTotal} bonus</span>}
          </div>
          <div className="ac-actions">
            <BusyButton className="sb-btn compact" onClick={start} disabled={!resumeId}>
              <PlayIcon className="hi hi-sm" aria-hidden="true" />{preview ? "Start course" : summary.completed ? "Review course" : summary.started ? "Resume" : "Start course"}
            </BusyButton>
            {editor && !preview && <button type="button" className="sb-btn ghost compact" onClick={() => R.navigate(learnManagePath({ view: "course", id: courseId }))}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Edit course</button>}
          </div>
          {!preview && summary.started && (
            <div className="ac-summary">
              <ProgressBar percent={summary.percent} label={`${c.title}: ${summary.percent}% complete`} />
              <span className="ac-cardsub">{summary.completed ? "Completed — nice work." : `${summary.done} of ${summary.total} required lesson${summary.total === 1 ? "" : "s"} complete · ${summary.percent}%`}</span>
            </div>
          )}
        </div>
      </div>

      <div className="ac-coursebody">
        <div className="ac-coursemain">
          {trailer && <section aria-labelledby="ac-prev-h"><h2 id="ac-prev-h" className="sb-vh">Course preview</h2><VideoPlayer video={trailer} title={`${c.title} — preview`} /></section>}
          {c.about && <section aria-labelledby="ac-about-h"><h2 id="ac-about-h" className="ac-h2">About this course</h2><Markdown src={c.about} version={c.mdVersion} /></section>}
          {c.outcomes?.length > 0 && (
            <section aria-labelledby="ac-out-h"><h2 id="ac-out-h" className="ac-h2">What you'll learn</h2>
              <ul className="ac-outcomes">{c.outcomes.map((o, i) => <li key={i}><CheckCircleIcon className="hi hi-sm" aria-hidden="true" />{o}</li>)}</ul></section>
          )}
          {c.requirements?.length > 0 && (
            <section aria-labelledby="ac-req-h"><h2 id="ac-req-h" className="ac-h2">Before you start</h2>
              <ul className="ac-plainlist">{c.requirements.map((o, i) => <li key={i}>{o}</li>)}</ul></section>
          )}
          <section aria-labelledby="ac-cur-h">
            <h2 id="ac-cur-h" className="ac-h2">Curriculum</h2>
            {curriculum.length === 0 && <div className="sb-empty">No lessons yet.</div>}
            <Curriculum curriculum={curriculum} progress={preview ? null : progressData} currentId={null} onOpen={(id) => R.navigate(lessonHref(id))} />
          </section>
          {!preview && leader && <LeaderProgress course={c} lessons={lessonDocs} users={users} />}
        </div>
      </div>
    </div>
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

/* Ordered modules → lessons with completed / current / upcoming state. */
function Curriculum({ curriculum, progress, currentId, onOpen, compact = false }) {
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
              const current = l.id === currentId;
              const cls = "ac-lesson" + (st.completed ? " done" : "") + (current ? " current" : "");
              return (
                <li key={l.id}>
                  <button type="button" className={cls} onClick={() => onOpen(l.id)} aria-current={current ? "page" : undefined}>
                    <span className="ac-lessonidx" aria-hidden="true">{st.completed ? <CheckCircleSolid className="hi hi-sm" /> : n}</span>
                    <span className="ac-lessontxt">
                      <span className="ac-lessontitle">{l.title || "Untitled lesson"}</span>
                      <span className="ac-lessonsub">
                        {st.completed ? "Completed" : current ? "Current" : st.viewed ? "In progress" : "Upcoming"}
                        {" · " + lessonKindMeta(l).label}
                        {l.bonus && " · Bonus"}
                        {st.quizRequired && " · Quiz required"}
                        {l.durationMinutes > 0 && ` · ${formatDuration(l.durationMinutes)}`}
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

/* Leaders (admin / department lead): who has started this course and how far
   they are. Learners never see this. */
function LeaderProgress({ course, lessons, users }) {
  const [open, setOpen] = useState(false);
  const rows = useLeaderProgress(course.id, open);
  const attempts = useLeaderAttempts(course.id, open);
  const byUid = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const attemptsBy = useMemo(() => {
    const m = new Map();
    for (const a of attempts.docs) m.set(a.uid, (m.get(a.uid) || 0) + 1);
    return m;
  }, [attempts.docs]);
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
                const u = byUid.get(p.uid);
                return (
                  <tr key={p.uid}>
                    <td>{u?.name || "Former member"}</td>
                    <td><div className="ac-tdprog"><ProgressBar percent={s.percent} compact label={`${u?.name || "Learner"}: ${s.percent}%`} /><span>{s.done}/{s.total}{s.completed ? " ✓" : ""}</span></div></td>
                    <td>{attemptsBy.get(p.uid) || 0}</td>
                    <td>{p.lastViewedAt ? formatDateTime(toMs(p.lastViewedAt)) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}
      <p className="ac-note">Completing a course is a learning milestone, not approval to serve — scheduling still goes through the team leads.</p>
    </section>
  );
}

/* ===================================================================
   Lesson
   =================================================================== */
function LessonView({ me, users, isAdmin, courseId, lessonId, R }) {
  const tax = useTax();
  const course = useCourse(courseId);
  const visible = !!course.data && canViewCourse(me, course.data, tax.hidden);
  const lessons = useLessons(courseId, visible);
  const progress = useProgress(me.id, courseId);
  const lesson = lessons.docs.find((l) => l.id === lessonId);
  const ready = course.loaded && lessons.loaded && progress.loaded;

  // Record the visit once per lesson (lastLessonId drives "Resume").
  const recorded = useRef(null);
  useEffect(() => {
    if (!ready || !visible || !lesson || recorded.current === lessonId) return;
    recorded.current = lessonId;
    recordLessonView(me.id, courseId, lessonId, !!progress.data).catch(() => {});
  }, [ready, visible, lesson, lessonId, me.id, courseId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (lesson?.title) document.title = `${lesson.title} · Learn · IFC Creatives Board`; }, [lesson?.title]);

  if (!ready) return <div className="sb-page"><Skeleton lines={8} /></div>;
  if (!visible) return <NotAvailable R={R} />;
  return <LessonBody me={me} users={users} R={R} c={course.data} lessons={lessons.docs} progress={progress.data} courseId={courseId} lessonId={lessonId} editor={canEditCourse(me, course.data)} />;
}

/* The lesson page. `preview` = rendering the private draft: nothing is
   recorded, the quiz isn't graded and the discussion is hidden. */
function LessonBody({ me, users, R, c, lessons: lessonDocs, progress: progressData, courseId, lessonId, preview = false, editor = false }) {
  const [playing, setPlaying] = useState(false);
  const desktop = useMediaQuery("(min-width: 1000px)");
  const [showCur, setShowCur] = useState(false);
  const [playerFailed, setPlayerFailed] = useState(false);
  useEffect(() => { setShowCur(false); setPlayerFailed(false); setPlaying(false); }, [lessonId]);
  const lesson = lessonDocs.find((l) => l.id === lessonId);
  const courseHref = preview ? learnPreviewPath(courseId) : learnPath(courseId);
  if (!lesson) {
    return <div className="sb-page">{preview && <PreviewBanner courseId={courseId} R={R} />}<BackLink to={courseHref} label={c.title} R={R} /><div className="sb-empty">That lesson isn't in this course any more.</div></div>;
  }
  const progress = { data: preview ? null : progressData };
  const lessons = { docs: lessonDocs };
  const curriculum = orderedCurriculum(c, lessons.docs);
  const st = lessonState(lesson, progress.data);
  const nb = lessonNeighbours(c, lessons.docs, lessonId);
  const video = lesson.video ? videoFromRecord(lesson.video) : null;
  const mode = quizMode(lesson);
  const go = (id) => R.navigate(preview ? learnPreviewPath(courseId, id) : learnPath(courseId, id));

  const main = (
    <div className="ac-lessonmain">
      {preview && <PreviewBanner courseId={courseId} lessonId={lessonId} R={R} />}
      <BackLink to={courseHref} label={c.title} R={R} />
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
            onEnded={preview ? undefined : () => { if (!st.videoWatched) markVideoWatched(me.id, courseId, lessonId).catch(() => {}); }}
            onFailed={() => setPlayerFailed(true)} />
        )}
        {!lesson.video && lesson.thumb && <div className="ac-novideo"><StoredImage imageRef={lesson.thumb} alt="" ratio="16 / 9" /></div>}
      </div>
      <div className="ac-lessonhead">
        <div className="ac-cardmeta"><span className="ac-cat">Lesson {nb.index + 1} of {nb.count}</span><Pill>{lessonKindMeta(lesson).label}</Pill>{lesson.bonus && <Pill>Bonus</Pill>}{lesson.video ? (lesson.videoMeta?.isLive ? <span className="ac-cardsub">Live</span> : lesson.videoMeta?.durationSec > 0 && <span className="ac-cardsub">{formatClock(lesson.videoMeta.durationSec)}</span>) : lesson.durationMinutes > 0 && <span className="ac-cardsub">{formatDuration(lesson.durationMinutes)}</span>}</div>
        <div className="ac-titlerow"><h1 className="ac-h1">{lesson.title}</h1>
          {editor && !preview && <button type="button" className="sb-btn ghost compact" onClick={() => R.navigate(learnManagePath({ view: "course", id: courseId, item: lessonId }))}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Edit</button>}</div>
        {preview ? <p className="ac-note">Preview — learners mark this item complete here. Nothing is recorded while previewing.</p>
          : <CompletionStrip lesson={lesson} state={st} video={video} playerFailed={playerFailed} me={me} courseId={courseId} lessonId={lessonId} />}
      </div>

      {lesson.description && <section aria-labelledby="ac-desc-h"><h2 id="ac-desc-h" className="sb-vh">About this lesson</h2><Markdown src={lesson.description} version={lesson.mdVersion} /></section>}

      {lesson.resources?.length > 0 && (
        <section aria-labelledby="ac-res-h">
          <h2 id="ac-res-h" className="ac-h2">Resources</h2>
          <ul className="ac-resources">
            {lesson.resources.map((r, i) => /^https?:\/\//i.test(r.url) && (
              <li key={i}><a href={r.url} target="_blank" rel="noopener noreferrer nofollow"><ArrowTopRightOnSquareIcon className="hi hi-sm" aria-hidden="true" />{r.label || r.url}</a></li>
            ))}
          </ul>
        </section>
      )}

      {mode !== "none" && <QuizPanel key={lessonId} lesson={lesson} courseId={courseId} me={me} state={st} {...(preview ? { submit: previewSubmit, attemptsHook: noAttempts } : {})} />}

      <nav className="ac-pager" aria-label="Lesson navigation">
        <button type="button" className="sb-btn ghost compact" disabled={!nb.prev} onClick={() => nb.prev && go(nb.prev.id)}><ArrowLeftIcon className="hi hi-sm" aria-hidden="true" />{nb.prev ? nb.prev.title : "Previous"}</button>
        <button type="button" className="sb-btn compact" disabled={!nb.next} onClick={() => nb.next && go(nb.next.id)}>{nb.next ? nb.next.title : "Next"}<ChevronRightIcon className="hi hi-sm" aria-hidden="true" /></button>
      </nav>

      {!preview && <Discussion me={me} ownerDoc={c} scope={{ courseId, lessonId }} users={users} />}
    </div>
  );

  const side = (
    <aside className="ac-side" aria-label="Course curriculum">
      {desktop
        ? <><div className="ac-sidehead"><span className="sb-mlabel">Curriculum</span><span className="ac-cardsub">{courseProgress(c, lessons.docs, progress.data).percent}%</span></div>
            <Curriculum curriculum={curriculum} progress={progress.data} currentId={lessonId} onOpen={go} compact /></>
        : <>
            <button type="button" className="ac-sidetoggle" aria-expanded={showCur} onClick={() => setShowCur((s) => !s)}>
              <span>Curriculum · {nb.index + 1} of {nb.count}</span><ChevronDownIcon className={"hi hi-sm" + (showCur ? " ac-flip" : "")} aria-hidden="true" />
            </button>
            {showCur && <Curriculum curriculum={curriculum} progress={progress.data} currentId={lessonId} onOpen={go} compact />}
          </>}
    </aside>
  );

  return <div className={"sb-page ac-lessonpage" + (desktop ? " desktop" : "")}>{desktop ? <>{main}{side}</> : <>{side}{main}</>}</div>;
}

function UnsupportedVideo() {
  return <div className="ac-videomsg" role="status"><ExclamationTriangleIcon className="hi" aria-hidden="true" /><p>This lesson's video link isn't supported. An Academy editor needs to update the link.</p></div>;
}

/* The explicit completion state + manual control. Never implies that opening or
   seeking the video counted as watching it. */
function CompletionStrip({ lesson, state: st, video, playerFailed = false, me, courseId, lessonId }) {
  const [busy, setBusy] = useState(false);
  // Auto-tracking is only trusted while the embedded player actually works; if
  // it failed (private / not embeddable), the learner can still finish manually.
  const autoTracks = !!video?.capabilities.tracksEnded && !playerFailed;
  const kind = lessonKindMeta(lesson);
  const toggleManual = async () => {
    setBusy(true);
    try { await setManualDone(me.id, courseId, lessonId, !st.manualDone); } finally { setBusy(false); }
  };
  return (
    <div className="ac-complete" aria-live="polite">
      {st.completed
        ? <span className="ac-done"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />{kind.id === "exercise" ? "Exercise complete" : kind.id === "resource" ? "Resources reviewed" : "Lesson complete"}{st.earned ? " · quiz passed" : st.videoWatched ? " · video watched" : st.manualDone ? ` · marked ${kind.doneVerb} by you` : ""}</span>
        : (
          <>
            {video && (st.videoWatched
              ? <span className="ac-done"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />Video watched</span>
              : <span className="ac-cardsub">{autoTracks ? "Watch to the end to complete the video" : playerFailed ? "Watch it on the provider's site, then mark it done below" : `${video.capabilities.label} doesn't report playback — mark it done below when you've watched it`}</span>)}
            {!video && <span className="ac-cardsub">{kind.id === "exercise" ? "Work through the exercise, then mark it complete." : kind.id === "resource" ? "Open the resources below, then mark them reviewed." : "When you've read this lesson, mark it as read."}</span>}
            {st.quizRequired && <span className="ac-cardsub">· Pass the quiz to complete this lesson</span>}
          </>
        )}
      {!st.quizRequired && (!video || !autoTracks || st.manualDone) && (
        <BusyButton className="sb-btn quiet compact" busy={busy} onClick={toggleManual} aria-pressed={st.manualDone}>
          {st.manualDone ? `Unmark ${kind.doneVerb}` : kind.doneLabel}
        </BusyButton>
      )}
      {st.manualDone && !st.quizRequired && <span className="ac-note" style={{ margin: 0, flexBasis: "100%" }}>Self-reported — a note that you've been through it, not an assessment.</span>}
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
  useEffect(() => {
    if (video.provider !== "vimeo") return;
    const origins = PROVIDER_ORIGINS.vimeo;
    const post = (method, value) => { try { frameRef.current?.contentWindow?.postMessage(JSON.stringify(value === undefined ? { method } : { method, value }), origins[0]); } catch {} };
    const onMsg = (e) => {
      if (!origins.includes(e.origin) || e.source !== frameRef.current?.contentWindow) return;
      let d; try { d = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { return; }
      if (!d || typeof d !== "object") return;
      if (d.event === "ready") {
        post("addEventListener", "timeupdate"); post("addEventListener", "ended");
        const start = resumePosition(resumeSec, durationHint);
        if (start) post("setCurrentTime", start);
      } else if (d.event === "timeupdate" && d.data) tick(Number(d.data.seconds) || 0, Number(d.data.duration) || 0, false);
      else if (d.event === "ended") { const dur = Number(d.data?.duration) || durationHint || 0; tick(dur, dur, true); }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [video.provider, video.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = `${title || "Video"} (${video.capabilities.label})`;
  return (
    <div className="ac-player">
      {failed
        ? <div className="ac-videomsg" role="status"><ExclamationTriangleIcon className="hi" aria-hidden="true" /><p>This video can't be played here — it may be private or not embeddable. <a href={video.url} target="_blank" rel="noopener noreferrer">Open on {video.capabilities.label}</a>.</p></div>
        : video.provider === "youtube"
          ? <div className="ac-frame"><div ref={hostRef} title={label} /></div>
          : <div className="ac-frame"><iframe ref={frameRef} src={autoplay && video.provider === "vimeo" ? video.embedUrl + "&autoplay=1" : video.embedUrl} title={label} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /></div>}
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
export function QuizPanel({ lesson, courseId, me, state: st, submit = submitQuiz, attemptsHook = useAttempts }) {
  const quiz = lesson.quiz;
  const mode = quizMode(lesson);
  const attempts = attemptsHook(me.id, courseId, lesson.id);
  const [answers, setAnswers] = useState({});
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [failMsg, setFailMsg] = useState("");
  const sorted = useMemo(() => [...attempts.docs].sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt)), [attempts.docs]);
  const best = sorted.reduce((m, a) => Math.max(m, a.percent || 0), 0);
  const passedBefore = sorted.some((a) => a.passed);
  const gate = canAttemptQuiz(quiz, sorted.length);

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
    const v = validateQuizAnswers(quiz, answers);
    if (!v.ok) { setErrors(Object.fromEntries(v.errors.map((x) => [x.qId, x.message]))); return; }
    setBusy(true); setFailMsg("");
    try { setResult(await submit(courseId, lesson.id, v.answers)); }
    catch (err) { setFailMsg(err?.message || "Couldn't submit the quiz. Try again."); }
    finally { setBusy(false); }
  };
  const retry = () => { setResult(null); setAnswers({}); setErrors({}); };

  return (
    <section className="ac-quiz" aria-labelledby="ac-quiz-h">
      <div className="sb-shead">
        <h2 id="ac-quiz-h" className="ac-h2">{mode === "required" ? "Quiz" : "Practice quiz"}</h2>
        <span className="ac-cardsub">{mode === "required" ? `Pass mark ${quiz.passMark || 70}% · required to complete this lesson` : "Optional · doesn't affect completion"}</span>
      </div>
      {attempts.loaded && sorted.length > 0 && !result && (
        <p className="ac-note">{sorted.length} attempt{sorted.length === 1 ? "" : "s"} so far · best {best}%{passedBefore ? " · passed" : ""}{gate.remaining != null ? ` · ${gate.remaining} left` : ""}</p>
      )}
      {result ? (
        <div className="ac-quizresult" role="status">
          <div className={"ac-score " + (result.passed ? "pass" : "fail")}>
            {result.passed ? <CheckCircleSolid className="hi" aria-hidden="true" /> : <XMarkIcon className="hi" aria-hidden="true" />}
            <div><b>{result.passed ? "Passed" : "Not yet"}</b> · {result.score} of {result.total} correct ({result.percent}%){mode === "required" ? ` · pass mark ${result.passMark}%` : ""}</div>
          </div>
          <ol className="ac-review">
            {quiz.questions.map((q, i) => {
              const r = result.results.find((x) => x.qId === q.id) || {};
              return (
                <li key={q.id} className={r.correct ? "ok" : "bad"}>
                  <div className="ac-qprompt">{i + 1}. {q.prompt}</div>
                  <ul className="ac-opts">
                    {q.options.map((o) => {
                      const chosen = (r.selected || []).includes(o.id), right = (r.correctOptions || []).includes(o.id);
                      return <li key={o.id} className={(right ? "right" : "") + (chosen ? " chosen" : "")}>{o.text}{right && <span className="ac-tag">correct</span>}{chosen && !right && <span className="ac-tag">your answer</span>}</li>;
                    })}
                  </ul>
                  {r.explanation && <p className="ac-explain">{r.explanation}</p>}
                </li>
              );
            })}
          </ol>
          {(!result.passed || mode === "practice") && canAttemptQuiz(quiz, sorted.length).ok && <button type="button" className="sb-btn ghost compact" onClick={retry}>Try again</button>}
        </div>
      ) : !gate.ok ? (
        <div className="sb-empty">You've used all {quiz.retryLimit} attempts for this quiz.{passedBefore ? " You passed." : " No attempts remain."}</div>
      ) : (
        <form onSubmit={onSubmit} className="ac-quizform" noValidate>
          <ol className="ac-questions">
            {quiz.questions.map((q, i) => (
              <li key={q.id}>
                <fieldset className="ac-q" aria-describedby={errors[q.id] ? `ac-qerr-${q.id}` : undefined}>
                  <legend className="ac-qprompt">{i + 1}. {q.prompt}{q.multi && <span className="ac-cardsub"> (choose all that apply)</span>}</legend>
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
          <BusyButton type="submit" className="sb-btn compact" busy={busy} busyLabel="Checking…">Submit answers</BusyButton>
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

function Discussion({ me, ownerDoc, scope, users }) {
  const comments = useComments(scope);
  const editor = canEditCourse(me, ownerDoc);
  const [txt, setTxt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const threads = useMemo(() => {
    const top = comments.docs.filter((c) => !c.parentId);
    const replies = new Map();
    for (const c of comments.docs) if (c.parentId) replies.set(c.parentId, [...(replies.get(c.parentId) || []), c]);
    const byTime = (a, b) => toMs(a.createdAt) - toMs(b.createdAt);
    top.sort((a, b) => (b.pinned === true) - (a.pinned === true) || byTime(a, b));
    for (const r of replies.values()) r.sort(byTime);
    return top.map((c) => ({ c, replies: replies.get(c.id) || [] }));
  }, [comments.docs]);

  const post = async (e) => {
    e.preventDefault();
    if (!txt.trim()) return;
    setBusy(true); setErr("");
    try { await addComment(scope, me, ownerDoc, txt); setTxt(""); }
    catch (x) { setErr(x?.message || "Couldn't post your comment."); }
    finally { setBusy(false); }
  };

  return (
    <section className="ac-discuss" aria-labelledby="ac-disc-h">
      <div className="sb-shead"><h2 id="ac-disc-h" className="ac-h2"><ChatBubbleLeftRightIcon className="hi hi-sm" aria-hidden="true" />Discussion</h2><span className="ac-cardsub">{comments.docs.length || "No"} comment{comments.docs.length === 1 ? "" : "s"}</span></div>
      <form className="ac-compose" onSubmit={post}>
        <label htmlFor="ac-newcomment" className="sb-vh">Ask a question or share a thought</label>
        <textarea id="ac-newcomment" value={txt} onChange={(e) => setTxt(e.target.value)} rows={3} maxLength={2000} placeholder="Ask a question or share a thought…" />
        <div className="ac-actions">
          <BusyButton type="submit" className="sb-btn compact" busy={busy} disabled={!txt.trim()}>Post</BusyButton>
          {err && <span className="ac-err" role="alert">{err}</span>}
        </div>
      </form>
      {!comments.loaded ? <Skeleton lines={3} />
        : threads.length === 0 ? <div className="sb-empty">No comments yet — be the first to ask.</div>
        : (
          <ul className="ac-threads">
            {threads.map(({ c, replies }) => (
              <li key={c.id}>
                <Comment c={c} me={me} editor={editor} scope={scope} ownerDoc={ownerDoc} canReply />
                {replies.length > 0 && <ul className="ac-replies">{replies.map((r) => <li key={r.id}><Comment c={r} me={me} editor={editor} scope={scope} ownerDoc={ownerDoc} /></li>)}</ul>}
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

function Comment({ c, me, editor, scope, ownerDoc, canReply = false }) {
  const [mode, setMode] = useState(null);   // "edit" | "reply" | null
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const own = c.uid === me.id;
  const run = async (fn) => { setBusy(true); try { await fn(); setMode(null); setVal(""); } catch {} finally { setBusy(false); } };
  return (
    <article className={"ac-comment" + (c.pinned ? " pinned" : "")} aria-label={`Comment by ${c.name || "member"}`}>
      <div className="ac-chead">
        <span className="sb-av" aria-hidden="true">{initials(c.name || "?")}</span>
        <b>{c.name || "Member"}</b>
        {ROLE_LABEL[c.role] && <Pill tone="accent">{ROLE_LABEL[c.role]}</Pill>}
        {c.pinned && <span className="ac-pinned"><MapPinSolid className="hi hi-sm" aria-hidden="true" />Pinned</span>}
        <span className="ac-cardsub">{c.createdAt ? formatDateTime(toMs(c.createdAt)) : "Just now"}{c.editedAt ? " · edited" : ""}</span>
      </div>
      {mode === "edit"
        ? <form className="ac-compose" onSubmit={(e) => { e.preventDefault(); if (val.trim()) run(() => editComment(scope, c.id, val)); }}>
            <label htmlFor={`ac-edit-${c.id}`} className="sb-vh">Edit comment</label>
            <textarea id={`ac-edit-${c.id}`} value={val} onChange={(e) => setVal(e.target.value)} rows={3} maxLength={2000} />
            <div className="ac-actions"><BusyButton type="submit" className="sb-btn compact" busy={busy}>Save</BusyButton><button type="button" className="sb-btn quiet compact" onClick={() => setMode(null)}>Cancel</button></div>
          </form>
        : <p className="ac-ctext"><SafeText text={c.txt} /></p>}
      <div className="ac-cactions">
        {canReply && <button type="button" className="ac-link" onClick={() => { setMode(mode === "reply" ? null : "reply"); setVal(""); }}>Reply</button>}
        {own && mode !== "edit" && <button type="button" className="ac-link" onClick={() => { setMode("edit"); setVal(c.txt); }}>Edit</button>}
        {(own || editor) && <button type="button" className="ac-link danger" onClick={() => { if (window.confirm("Delete this comment?")) run(() => deleteComment(scope, c.id)); }}>Delete</button>}
        {editor && canReply && <button type="button" className="ac-link" onClick={() => run(() => pinComment(scope, c.id, !c.pinned, c.txt))}>{c.pinned ? "Unpin" : "Pin"}</button>}
      </div>
      {mode === "reply" && (
        <form className="ac-compose ac-replyform" onSubmit={(e) => { e.preventDefault(); if (val.trim()) run(() => addComment(scope, me, ownerDoc, val, c.id)); }}>
          <label htmlFor={`ac-reply-${c.id}`} className="sb-vh">Reply</label>
          <textarea id={`ac-reply-${c.id}`} value={val} onChange={(e) => setVal(e.target.value)} rows={2} maxLength={2000} placeholder="Write a reply…" />
          <div className="ac-actions"><BusyButton type="submit" className="sb-btn compact" busy={busy} disabled={!val.trim()}>Reply</BusyButton><button type="button" className="sb-btn quiet compact" onClick={() => setMode(null)}>Cancel</button></div>
        </form>
      )}
    </article>
  );
}

/* ===================================================================
   Quick guide
   =================================================================== */
function GuideView({ me, users, isAdmin, guideId, R }) {
  const tax = useTax();
  const guide = useGuide(guideId);
  const visible = !!guide.data && canViewContent(me, guide.data, tax.hidden);
  const review = useGuideReview(me.id, guideId);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (guide.data?.title) document.title = `${guide.data.title} · Learn · IFC Creatives Board`; }, [guide.data?.title]);
  if (!guide.loaded || !review.loaded) return <div className="sb-page"><BackLink to="/learn" label="Creative Academy" R={R} /><Skeleton lines={6} /></div>;
  if (!visible) return <NotAvailable R={R} what="guide" />;
  const g = guide.data;
  const video = g.video ? videoFromRecord(g.video) : null;
  const reviewed = guideReviewed(review.data);
  const editor = canEditContent(me, g);
  const leader = canViewLearnerProgress(me);
  const toggle = async () => { setBusy(true); try { await setGuideReviewed(me.id, guideId, !reviewed); } finally { setBusy(false); } };
  return (
    <div className="sb-page ac-guide">
      <BackLink to="/learn" label="Creative Academy" R={R} />
      <div className="ac-guidemain">
        <div className="ac-cardmeta">
          <span className="ac-fmt"><DocumentTextIcon className="hi hi-xs" aria-hidden="true" />Quick guide</span>
          <span className="ac-cat">{categoryNameIn(tax.categories, g.category)}</span>
          {g.status !== "published" && <Pill tone="warn">{g.status}</Pill>}
          {g.durationMinutes > 0 && <span className="ac-cardsub">{formatDuration(g.durationMinutes)}</span>}
        </div>
        <h1 className="ac-h1">{g.title}</h1>
        <TopicChips item={g} R={R} />

        {g.video && !video && <UnsupportedVideo />}
        {video && <VideoPlayer key={guideId} video={video} title={g.title} meta={g.videoMeta} />}
        {!video && g.thumb && <StoredImage imageRef={g.thumb} alt="" ratio="16 / 9" />}

        {g.body && <Markdown src={g.body} />}
        {g.resources?.length > 0 && (
          <section aria-labelledby="ac-gres-h">
            <h2 id="ac-gres-h" className="ac-h2">Resources</h2>
            <ul className="ac-resources">
              {g.resources.map((r, i) => /^https?:\/\//i.test(r.url) && (
                <li key={i}><a href={r.url} target="_blank" rel="noopener noreferrer nofollow"><ArrowTopRightOnSquareIcon className="hi hi-sm" aria-hidden="true" />{r.label || r.url}</a></li>
              ))}
            </ul>
          </section>
        )}

        <div className="ac-complete ac-reviewbox" aria-live="polite">
          {reviewed
            ? <span className="ac-done"><CheckCircleSolid className="hi hi-sm" aria-hidden="true" />You marked this guide as reviewed{review.data?.reviewedAt ? ` · ${formatDateTime(toMs(review.data.reviewedAt))}` : ""}</span>
            : <span className="ac-cardsub">When you've read or watched this guide, mark it as reviewed so it shows in your learning record.</span>}
          <BusyButton className={"sb-btn compact" + (reviewed ? " quiet" : "")} busy={busy} onClick={toggle} aria-pressed={reviewed}>{reviewed ? "Unmark reviewed" : "Mark as reviewed"}</BusyButton>
          <span className="ac-note" style={{ margin: 0, flexBasis: "100%" }}>“Reviewed” is your own note that you've been through this guide — it isn't an assessment of skill.</span>
        </div>
        <div className="ac-actions">
          {editor && <button type="button" className="sb-btn ghost compact" onClick={() => setEditing(true)}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Edit guide</button>}
        </div>

        <Discussion me={me} ownerDoc={g} scope={{ guideId }} users={users} />
        {leader && <GuideReviewers guide={g} users={users} />}
      </div>
      {editing && <GuideEditor me={me} users={users} guideId={guideId} onClose={() => setEditing(false)} />}
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
const ITEM_LABEL = { course: "Course", lesson: "Lesson", guide: "Quick guide" };

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
  const hrefFor = (it) => it.type === "course" ? learnPath(it.courseId) : it.type === "lesson" ? learnPath(it.courseId, it.lessonId) : learnGuidePath(it.guideId);
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
                {summary.completed ? "Completed — every required step is done."
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
              return (
                <li key={it.key || i}>
                  {it.available ? (
                    <button type="button" className={"ac-lesson ac-step" + (it.completed ? " done" : "") + (isNext ? " current" : "")} onClick={() => openItem(it)} aria-current={isNext ? "step" : undefined}>
                      <span className="ac-lessonidx" aria-hidden="true">{it.completed ? <CheckCircleSolid className="hi hi-sm" /> : i + 1}</span>
                      <span className="ac-lessontxt">
                        <span className="ac-lessontitle">{it.title}</span>
                        <span className="ac-lessonsub"><Icon className="hi hi-xs" aria-hidden="true" /> {ITEM_LABEL[it.type]}{it.subtitle && it.subtitle !== it.title ? ` · ${it.subtitle}` : ""}{!it.required ? " · Optional" : ""}{it.completed ? (it.type === "guide" ? " · Reviewed" : " · Completed") : isNext ? " · Up next" : it.started ? " · In progress" : ""}{it.type === "course" && it.started && !it.completed ? ` · ${it.percent}%` : ""}</span>
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
          <p className="ac-note">Progress here is the same progress you earn on the courses, lessons and guides themselves — finishing a step anywhere counts everywhere.</p>
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
                <td>{l.lastViewedAt ? formatDateTime(toMs(l.lastViewedAt)) : "—"}</td>
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
  const tax = useTax();
  const chips = topicChips(item, tax.topicsById);
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
const previewSubmit = async () => { throw new Error("Preview — quizzes aren't graded here. Publish to let learners take it."); };
function PreviewBanner({ courseId, lessonId, R }) {
  return (
    <div className="ac-previewbar" role="status">
      <EyeIcon className="hi hi-sm" aria-hidden="true" /><span><b>Draft preview.</b> This is what learners will see after you publish. Nothing here is recorded.</span>
      <button type="button" className="sb-btn compact" onClick={() => R.navigate(learnManagePath({ view: "course", id: courseId, item: lessonId || "" }))}>Back to editing</button>
    </div>
  );
}
function DraftPreview({ me, users, courseId, lessonId, R }) {
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
    ? <LessonBody me={me} users={users} R={R} c={c} lessons={docs} progress={null} courseId={courseId} lessonId={lessonId} preview />
    : <CourseOverviewBody me={me} users={users} R={R} c={c} lessons={docs} progress={null} courseId={courseId} editor={false} leader={false} preview />;
}
