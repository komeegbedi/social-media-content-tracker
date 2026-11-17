/* IFC Creative Academy — the authoring WORKSPACE (one connected, full-page flow).

     Academy (categories)  →  Category (details, cover, its courses)  →
     Course (outline + selected item editor)  →  Preview  →  Publish

   Routes (src/nav.js): /learn/manage, /learn/manage/category/:id|new,
   /learn/manage/course/:id|new (?item=…&category=…), /learn/manage/more.

   • Creating and editing use the same screens; nothing needs "save, then
     reopen". New categories become private drafts the moment they have a name
     (or need an id for a cover); new courses are written only once they have
     something in them.
   • Courses autosave to a private DRAFT (courseDrafts/*). Learners keep seeing
     the published version until "Publish changes" (see academyDrafts.js).
   • Ordering is drag-and-drop (handles, insertion line, edge auto-scroll, touch,
     keyboard) with Undo and a "Move to position…" fallback.
   • Permissions are the existing ones: categories (create, rename, cover,
     order, hide, delete) are admin-only; Academy editors author courses. */
import { SearchPicker } from "./academyPicker.jsx";
import { CategoryDeleteDialog } from "./academyCategoryDelete.jsx";
import { GuideWorkspace } from "./AcademyGuideWorkspace.jsx";
import { guideRow, guidePublishIssues } from "./academyGuides.js";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRightIcon, ChevronLeftIcon, EyeIcon, PlusIcon, TrashIcon, EllipsisHorizontalIcon, PlayIcon, DocumentTextIcon,
  LinkIcon, PencilSquareIcon, Cog6ToothIcon, ExclamationTriangleIcon, CheckCircleIcon, EyeSlashIcon, ArrowUturnLeftIcon,
  ArchiveBoxIcon, BookOpenIcon, ArrowPathIcon, ArrowsUpDownIcon, XMarkIcon, ChevronDownIcon, ClipboardDocumentCheckIcon,
  InformationCircleIcon, CloudArrowUpIcon, NoSymbolIcon,
} from "@heroicons/react/24/outline";
import { BusyButton, Skeleton } from "./loading.jsx";
import { useMediaQuery } from "./overlay.jsx";
import { Toggle } from "./controls.jsx";
import { ConfirmDialog } from "./App.jsx";
import { useBlocker, useNavigate } from "react-router-dom";
import { learnManagePath, learnPreviewPath, learnPath, learnCategoryPath, learnPreviewCategoryPath } from "./nav.js";
import {
  ACADEMY_LEVELS, LESSON_KINDS, lessonKindMeta, mergeCategories, categoryIn, isAcademyAdmin, isAcademyEditor,
  publishBlockers, publishIssues, flatLessons, orderedCurriculum, toMs, newId, normalizeCategory, DEFAULT_PASS_MARK, quizMode,
  prerequisitesOf, validatePrerequisites, dependentsOf, MAX_PREREQUISITES, eligiblePrerequisites,
} from "./academyProgress.js";
import { parseVideoLink, videoFromRecord, videoRecord, VIDEO_PROVIDERS } from "./academyVideo.js";
import { blankCourse, hasUnpublishedChanges, courseRuntime, formatRuntime, formatClock } from "./academyDrafts.js";
import { moveId, outlineRows, moveLessonInOutline, moveLessonToModule, insertLesson, removeLesson, orderCourses, lessonPosition, moveModule, moduleIndexFromSlot, outlineSpan, outlineCanDrop } from "./academyOrder.js";
import {
  useCategoryRecords, useCategoryIndex, useCategoryArt, useCourses, useCourseDrafts, createCategoryDraft, newCategoryId,
  updateCategory, setCategoryHidden, reorderCategories, setCategoryCourseOrder, createDefaultCategories, deleteImage,
  newCourseId, newLessonId, publishCourseDraft, discardNeverPublishedDraft, deleteCourseHard, setCourseStatus,
  usePendingCleanup, pathsUsingCourse, coursesRecommending, fetchVideoMetadata, loadCourseWorkspace,
  useGuides, useGuideDrafts, setCategoryGuideOrder, loadGuideWorkspace, publishGuideDraft,
} from "./academyData.js";
import { categoryCourseGroups, readinessOf, runCategoryPublish, outcomeSummary } from "./academyBulkPublish.js";
import { useUploadsInFlight, uploadsInFlight, waitForUploads } from "./academyUploads.js";
import { isOfflineError } from "./useOnline.js";
import {
  Field, CategorySelect, TopicsField, ImagePicker, ThumbnailChoice, ManageGuides, ManagePaths,
  ManageTopics, CoverThumb, AcademyEditorScope, RequiredTag,
} from "./AcademyManage.jsx";
import { CategoryArt, StoredImage, VideoThumb, AppLink } from "./academyShared.jsx";
import { VideoPreview } from "./academyVideoPreview.jsx";
import { SortableList, DragHandle } from "./academySortable.jsx";
import { useUndo, useReorder, recordMove, sameData } from "./academyUndo.jsx";
import { AnchoredMenu, MenuButton } from "./academyMenu.jsx";
import { useOnline, requireOnline } from "./useOnline.js";
import {
  useCourseDraft, SaveStatus, RichTextField, LinkList, QuizEditor, AddContentMenu, ContentChoices, SmallDialog, MoveDialog,
  PublishCheckCtx, usePublishErr, saveErrorText,
} from "./academyWorkspaceParts.jsx";

/* ---------------------------------------------------------------- shared ---- */
export function Crumbs({ items, R }) {
  return (
    <nav className="ac-crumbs ac-wscrumbs" aria-label="Breadcrumb">
      <ol>{items.map((it, i) => (
        <li key={i}>
          {it.to ? <button type="button" className="ac-link inline" onClick={() => R.navigate(it.to)}>{it.label}</button> : <span aria-current="page">{it.label}</span>}
          {i < items.length - 1 && <ChevronRightIcon className="hi hi-xs" aria-hidden="true" />}
        </li>))}</ol>
    </nav>
  );
}
const KIND_ICON = { video: PlayIcon, written: DocumentTextIcon, resource: LinkIcon, exercise: PencilSquareIcon };
/* A confirmation carried in navigation state (e.g. after a delete): shown on
   arrival at the destination until dismissed. */
export function Flash({ R }) {
  const msg = R.location?.state?.flash || "";
  if (!msg) return null;
  return (
    <div className="ac-wsnote ac-ok ac-flash" role="status">
      <CheckCircleIcon className="hi hi-sm" aria-hidden="true" /><span>{msg}</span>
      <button type="button" className="ac-link" onClick={() => R.navigate({ pathname: R.location.pathname, search: R.location.search }, { replace: true, state: null })}>Dismiss</button>
    </div>
  );
}
export function useTaxonomy() {
  const recs = useCategoryRecords();
  const idx = useCategoryIndex();
  return useMemo(() => {
    const categories = mergeCategories(recs.docs).map((c) => (idx.hidden.includes(c.id) ? { ...c, hidden: true } : c));
    return { categories, records: recs.docs, hidden: idx.hidden, loaded: recs.loaded && idx.loaded, bootstrap: recs.loaded && recs.docs.length === 0 };
  }, [recs.docs, recs.loaded, idx.hidden, idx.loaded]);
}
/* Live courses + private drafts, merged by id, with an authoring status. */
function useAllCourses(me) {
  const { courses, loaded } = useCourses(me);
  const drafts = useCourseDrafts(me);
  return useMemo(() => {
    const byId = new Map();
    for (const c of courses) byId.set(c.id, { id: c.id, live: c, draft: null });
    for (const d of drafts.docs) byId.set(d.id, { ...(byId.get(d.id) || { id: d.id, live: null }), draft: d });
    const list = [...byId.values()].map((x) => {
      const src = x.draft || x.live;
      const st = !x.live || x.live.status === "draft" ? "draft" : x.live.status;
      return { id: x.id, title: (x.draft ? x.draft.title : x.live.title) || "Untitled course", liveTitle: x.live ? (x.live.title || "Untitled course") : "", category: normalizeCategory((x.draft ? x.draft.category : x.live.category) || ""),
        liveCategory: x.live ? normalizeCategory(x.live.category || "") : "", cover: src.cover, status: st, changes: !!x.draft && x.live?.status === "published" && hasUnpublishedChanges(x.draft),
        lessons: (src.modules || []).reduce((n, m) => n + (m.lessonIds || []).length, 0), createdAtMs: toMs(src.createdAt),
        // learner order uses the PUBLISHED level/date, so mirror that here
        level: (x.live || src).level, publishedAtMs: x.live ? toMs(x.live.publishedAt) : 0 };
    });
    return { list, loaded: loaded && drafts.loaded };
  }, [courses, loaded, drafts.docs, drafts.loaded]);
}
/* Tips & resources (live + private drafts), as rows for category management. */
function useAllGuides(me) {
  const { guides, loaded } = useGuides(me);
  const drafts = useGuideDrafts(me);
  return useMemo(() => {
    const byId = new Map();
    for (const g of guides) byId.set(g.id, { live: g, draft: null });
    for (const d of drafts.docs) byId.set(d.id, { ...(byId.get(d.id) || { live: null }), draft: d });
    return { list: [...byId.entries()].map(([id, x]) => guideRow(id, x.live, x.draft)), loaded: loaded && drafts.loaded };
  }, [guides, loaded, drafts.docs, drafts.loaded]);
}
function GuideStatus({ g }) {
  return <>
    {(g.status === "published" || g.status === "published-edits") && <span className="ac-pill ok">Published</span>}
    {(g.status === "draft-only" || g.status === "unpublished") && <span className="ac-pill">Draft</span>}
    {g.status === "archived" && <span className="ac-pill">Archived</span>}
    {g.status === "published-edits" && <span className="ac-pill accent">Unpublished changes</span>}
  </>;
}
function CourseStatus({ c }) {
  return <>
    {c.status === "published" && <span className="ac-pill ok">Published</span>}
    {c.status === "draft" && <span className="ac-pill">Draft</span>}
    {c.status === "archived" && <span className="ac-pill">Hidden (archived)</span>}
    {c.changes && <span className="ac-pill accent">Unpublished changes</span>}
  </>;
}

/* Ordering status for lists whose order is LIVE (categories, courses in a
   category): it applies immediately, so say so — and say when it didn't. */
function OrderNote({ order, what }) {
  const st = order.state;
  const online = useOnline();
  if (st.phase === "saving" && !online) return <span className="ac-ordernote warn" role="status"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />You're offline, so the new order isn't saved yet. Learners still see the old order. Keep this tab open until you reconnect.</span>;
  if (st.phase === "saving") return <span className="ac-ordernote" role="status"><ArrowPathIcon className="hi hi-xs ac-spin" aria-hidden="true" />Saving order…</span>;
  if (st.phase === "error") return (
    <span className="ac-ordernote err" role="alert"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />Couldn't save the new order{st.message ? ` (${st.message})` : ""}. The list shows the saved order.
      <button type="button" className="ac-link" onClick={() => order.retry().catch(() => {})}>Try again</button></span>
  );
  return <span className="ac-ordernote">Drag <span aria-hidden="true">≡</span> to reorder {what}. Learners see the new order straight away.</span>;
}

/* Leaving the course workspace while an edit is still waiting to save: a link
   or breadcrumb saves it NOW, then continues (no prompt); Back continues and
   the draft store saves on unmount (it always did). When the edit CAN'T be
   saved (offline, conflict, error) — where it used to be lost silently — ask
   before discarding. Moving between items of this course (?item=) and the
   new → id hand-over never block. (Closing the tab is covered by beforeunload
   in useCourseDraft.) */
const UNSAVED = ["pending", "saving", "error", "conflict", "offline"];
export function useWorkspaceLeaveGuard(cid, save, store, { isHere = null, what = "course" } = {}) {
  const navigate = useNavigate();
  const unsaved = UNSAVED.includes(save.state);
  const pending = useRef(null);
  const leaving = useRef(false);
  const blocker = useBlocker(useCallback(({ nextLocation, historyAction }) => {
    const p = nextLocation.pathname;
    const here = isHere ? isHere(p) : (p === `/learn/manage/course/${cid}` || p === "/learn/manage/course/new");
    // A pending save never blocks Back (the draft store saves on unmount, and a
    // Back can't be replayed exactly); links/breadcrumbs save first, then go.
    // A save that CAN'T happen (offline/conflict/error) always asks.
    const cantSave = ["error", "conflict", "offline"].includes(save.state);
    const block = unsaved && !here && !leaving.current && (cantSave || historyAction !== "POP");
    if (block) pending.current = { action: historyAction, to: nextLocation };
    return block;
  }, [unsaved, cid, save.state, isHere]));
  const [ask, setAsk] = useState(false);
  const go = useCallback(() => {
    const p = pending.current; pending.current = null; setAsk(false);
    leaving.current = true;
    if (blocker.state === "blocked") blocker.reset();
    if (!p) { leaving.current = false; return; }
    if (p.action === "POP") navigate(-1);
    else navigate({ pathname: p.to.pathname, search: p.to.search }, { replace: p.action === "REPLACE" });
  }, [blocker, navigate]);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (save.state === "pending") { store.flushNow(); return; }       // save right away…
    if (save.state === "saving") return;                               // …wait for it…
    if (!UNSAVED.includes(save.state)) { go(); return; }              // …saved: carry on
    setAsk(true);                                                      // can't save: ask
  }, [blocker.state, save.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const stay = () => { pending.current = null; setAsk(false); if (blocker.state === "blocked") blocker.reset(); };
  const why = save.state === "offline" ? "You're offline, so your latest edits are only in this tab. Stay and they'll save when you reconnect."
    : save.state === "conflict" ? `Someone else saved this ${what} while you were editing, so your latest edits weren't saved.`
    : `Your latest edits couldn't be saved${saveErrorText(save.message) ? ` (${saveErrorText(save.message)})` : ""}.`;
  const dialog = ask ? (
    <ConfirmDialog tone="warning" icon="warning" title="Leave without saving your latest edits?"
      body={`${why} If you leave now, they'll be lost.`}
      cancelLabel="Keep editing" confirmLabel="Leave without saving" onConfirm={go} onClose={stay} />
  ) : null;
  // after a deliberate exit (e.g. the record was deleted) nothing is left to save
  const release = useCallback(() => { leaving.current = true; }, []);
  return { leaving: blocker.state === "blocked" && !ask, dialog, release };
}

/* ================================================================ router ==== */
export default function AcademyWorkspace({ me, users, nav, R }) {
  if (!isAcademyEditor(me)) {
    // e.g. an old edit link followed by a learner: offer the course itself
    const cid = nav.manage?.view === "course" && nav.manage.id !== "new" ? nav.manage.id : null;
    const lid = cid && nav.manage.item && nav.manage.item !== "details" ? nav.manage.item : null;
    return (
      <div className="sb-page"><div className="sb-empty">
        <p>The Academy workspace is for Academy editors.</p>
        <button type="button" className="sb-btn compact" onClick={() => R.navigate(cid ? learnPath(cid, lid) : "/learn")}>{cid ? (lid ? "Open the lesson" : "Open the course") : "Go to Learn"}</button>
      </div></div>
    );
  }
  const ws = nav.manage || { view: "home" };
  return <WorkspaceRoutes me={me} users={users} ws={ws} R={R} />;
}
/* A "new" screen that gets its real id (first save → URL replaced) must stay
   MOUNTED: remounting would drop keystrokes typed during the round trip and
   move focus. `born` remembers which real ids were created by which "new"
   screen so the React key doesn't change. */
function WorkspaceRoutes({ me, users, ws, R }) {
  const born = useRef({});
  const gen = useRef({});                                 // a fresh "new" screen each time one is opened
  const prev = useRef({});
  const kindNow = ws.view === "category" ? "cat" : ws.view === "course" ? "course" : ws.view === "guide" ? "guide" : null;
  if (kindNow) {
    if (ws.id === "new" && prev.current[kindNow] && prev.current[kindNow] !== "new") gen.current[kindNow] = (gen.current[kindNow] || 0) + 1;
    prev.current[kindNow] = ws.id;
  }
  const keyFor = (kind, id, extra = "") => (id === "new" ? `${kind}:new:${extra}:${gen.current[kind] || 0}` : born.current[`${kind}:${id}`] || `${kind}:${id}`);
  const adopt = (kind, from) => (realId) => { born.current[`${kind}:${realId}`] = from; };
  const catKey = ws.view === "category" ? keyFor("cat", ws.id) : "";
  const courseKey = ws.view === "course" ? keyFor("course", ws.id, ws.category) : "";
  const guideKey = ws.view === "guide" ? keyFor("guide", ws.id, ws.category) : "";
  return (
    <AcademyEditorScope me={me}>
      {ws.view === "home" && <WorkspaceHome me={me} R={R} />}
      {ws.view === "more" && <MorePage me={me} users={users} R={R} />}
      {ws.view === "category" && <CategoryWorkspace key={catKey} me={me} id={ws.id} R={R} onCreated={adopt("cat", catKey)} />}
      {ws.view === "guide" && <GuideWorkspace key={guideKey} me={me} id={ws.id} categoryParam={ws.category} pathCtx={ws.path || ""} R={R} onCreated={adopt("guide", guideKey)} />}
      {ws.view === "course" && <CourseWorkspace key={courseKey} me={me} id={ws.id} categoryParam={ws.category} item={ws.item} focus={ws.focus} pathCtx={ws.path || ""} R={R} onCreated={adopt("course", courseKey)} />}
    </AcademyEditorScope>
  );
}

/* =========================================================== Academy home === */
function WorkspaceHome({ me, R }) {
  const admin = isAcademyAdmin(me);
  const tax = useTaxonomy();
  const art = useCategoryArt();
  const { list: courses, loaded } = useAllCourses(me);
  const undo = useUndo();
  const pending = usePendingCleanup(admin);
  const [retrying, setRetrying] = useState(null);
  const observed = useMemo(() => tax.categories.map((c) => c.id), [tax.categories]);
  const observedRef = useRef(observed); observedRef.current = observed;
  const order = useReorder(observed, (ids) => reorderCategories(me, ids));
  const cats = order.shown.map((id) => tax.categories.find((c) => c.id === id)).filter(Boolean);
  const countFor = (id) => courses.filter((c) => c.category === id).length;
  const onMove = (id, slot) => {
    const before = cats.map((c) => c.id);
    recordMove({ before, after: moveId(before, id, slot), label: cats.find((c) => c.id === id)?.label, save: order.save, current: () => observedRef.current, undo });
  };
  const pendingList = Object.entries(pending.data?.courses || {});
  return (
    <div className="sb-page ac-ws">
      <Crumbs R={R} items={[{ label: "Learn", to: "/learn" }, { label: "Academy workspace" }]} />
      <Flash R={R} />
      <div className="ac-wshead">
        <div><h1 className="ac-h1">Academy workspace</h1><p className="sb-sub">Open a category, then a course, to add videos and materials. Course edits stay a private draft until you publish them; category changes and ordering apply straight away.</p></div>
        <div className="ac-actions">
          {admin && !tax.bootstrap && <button type="button" className="sb-btn compact" onClick={() => R.navigate(learnManagePath({ view: "category", id: "new" }))}><PlusIcon className="hi hi-sm" aria-hidden="true" /><span>New category</span></button>}
        </div>
      </div>
      {pendingList.length > 0 && (
        <div className="ac-blockers" role="status"><b>Unfinished clean-up after deleting {pendingList.length === 1 ? "a course" : `${pendingList.length} courses`}.</b>
          <ul>{pendingList.map(([id, e]) => <li key={id}><ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" />{e.title || "Deleted course"}
            <BusyButton className="sb-btn quiet compact" busy={retrying === id} onClick={async () => { setRetrying(id); try { await deleteCourseHard(me, id, e); } catch {} setRetrying(null); }}>Retry clean-up</BusyButton></li>)}</ul></div>
      )}
      {!tax.loaded ? <Skeleton lines={5} />
        : tax.bootstrap ? (
          <div className="sb-empty">{admin ? <><p>Learners currently see the six starter categories. Create them to start organising courses.</p>
            <BusyButton className="sb-btn compact" onClick={() => createDefaultCategories(me)}>Create the starter categories</BusyButton></> : "An admin needs to set up the categories first."}</div>
        ) : (
          <section aria-labelledby="ws-cats-h">
            <div className="sb-shead"><h2 id="ws-cats-h" className="ac-h2">Categories</h2>
              {admin && <OrderNote order={order} what="categories" />}</div>
            <SortableList className="ac-wslist" items={cats} getLabel={(c) => c.label} canDrag={() => admin} disabled={!admin} onMove={onMove}
              renderItem={(c, { handle }) => (
                <div className={"ac-wsrow" + (c.hidden ? " is-hidden" : "")}>
                  {admin && <DragHandle handle={handle} />}
                  <div className="ac-mthumb ac-mthumb-cat"><CategoryArt category={c} imageRef={c.cover || art.data?.art?.[c.id]} /></div>
                  <button type="button" className="ac-wsrowmain" onClick={() => R.navigate(learnManagePath({ view: "category", id: c.id }))}>
                    <span className="ac-mtitle">{c.label}{c.hidden && <span className="ac-pill warn">Not visible</span>}</span>
                    <span className="ac-cardsub">{loaded ? `${countFor(c.id)} course${countFor(c.id) === 1 ? "" : "s"}` : "…"}{c.description ? ` · ${c.description}` : ""}</span>
                  </button>
                  <ChevronRightIcon className="hi hi-sm ac-chev" aria-hidden="true" />
                </div>
              )} />
          </section>
        )}
      {undo.node}
      <section className="ac-secondary" aria-label="Other Academy tools">
        <button type="button" className="ac-link" onClick={() => R.navigate(learnManagePath({ view: "more" }))}><BookOpenIcon className="hi hi-sm" aria-hidden="true" />Tips & resources, learning paths & topics</button>
        <button type="button" className="ac-link" onClick={() => R.navigate("/learn")}><EyeIcon className="hi hi-sm" aria-hidden="true" />View the Academy as a learner</button>
      </section>
    </div>
  );
}

/* ====================================================== category workspace === */
function CategoryWorkspace({ me, id: routeIdProp, R, onCreated }) {
  const [routeId] = useState(routeIdProp);               // "new" stays "new" for this screen's life
  const admin = isAcademyAdmin(me);
  const tax = useTaxonomy();
  const art = useCategoryArt();
  const { list: allCourses, loaded } = useAllCourses(me);
  const [id, setId] = useState(routeId === "new" ? null : routeId);
  const rec = id ? tax.records.find((r) => r.id === id) : null;
  const cat = id ? categoryIn(tax.categories, id) : null;
  const [f, setF] = useState(null);
  const [save, setSave] = useState({ state: "idle" });
  const [confirm, setConfirm] = useState(null);
  const undo = useUndo();
  const timer = useRef(0);
  const creating = useRef(null);
  const fRef = useRef(f); fRef.current = f;
  const idRef = useRef(routeId === "new" ? null : routeId);         // the id as soon as it exists (the leave guard reads it synchronously)
  const online = useOnline();
  useEffect(() => {
    if (f) return;
    if (routeId === "new") setF({ name: "", description: "", short: "" });
    else if (rec) setF({ name: rec.name || "", description: rec.description || "", short: rec.short || "" });
  }, [rec, routeId, f]);

  // Create the record (private, hidden) once — on a name, a cover, or "Add course".
  const ensure = useCallback(async () => {
    if (id) return id;
    if (creating.current) return creating.current;
    const name = (fRef.current?.name || "").trim();
    const newId = newCategoryId(name || "category");
    creating.current = createCategoryDraft(me, newId, { name: name || "Untitled category", description: fRef.current?.description || "", short: fRef.current?.short || "", order: tax.categories.length }, tax.hidden)
      .then(() => { idRef.current = newId; onCreated?.(newId); setId(newId); R.replace(learnManagePath({ view: "category", id: newId })); return newId; })
      .finally(() => { creating.current = null; });
    return creating.current;
  }, [id, me, tax.categories.length, tax.hidden, R]);

  const persist = useCallback(async () => {
    const cur = fRef.current; if (!cur) return;
    if (!id && !cur.name.trim()) { setSave({ state: "idle" }); return; }       // nothing to keep yet
    setSave({ state: "saving" });
    try {
      const cid = await ensure();
      await updateCategory(me, cid, { name: cur.name.trim() || "Untitled category", description: cur.description, short: cur.short.trim() });
      setSave({ state: "saved" });
    } catch (e) { setSave({ state: "error", message: e?.message || "Couldn't save." }); }
  }, [ensure, id, me]);
  const set = (patch) => { setF((x) => ({ ...x, ...patch })); setSave({ state: "pending" }); clearTimeout(timer.current); timer.current = setTimeout(() => { timer.current = 0; persist(); }, 700); };
  const persistRef = useRef(persist); persistRef.current = persist;
  // leaving with an edit still waiting for its save delay saves it (never dropped)
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); timer.current = 0; persistRef.current(); } }, []);
  const flushNow = useCallback(() => { clearTimeout(timer.current); timer.current = 0; return persist(); }, [persist]);
  // closing the tab / leaving the page entirely with unsaved category edits: the browser warns
  useEffect(() => {
    const h = (e) => { if (["pending", "saving", "error"].includes(save.state)) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [save.state]);
  const isHere = useCallback((p) => p === "/learn/manage/category/new" || (!!idRef.current && p === `/learn/manage/category/${idRef.current}`), []);
  // offline, a save can't finish: treat it as "can't save" so leaving asks instead of waiting
  const guardSave = !online && ["pending", "saving"].includes(save.state) ? { ...save, state: "offline" } : save;
  const leaveGuard = useWorkspaceLeaveGuard(id || "new", guardSave, { flushNow }, { isHere, what: "category" });

  const courses = useMemo(() => orderCourses(allCourses.filter((c) => c.category === id || c.liveCategory === id), rec?.courseOrder || []), [allCourses, id, rec?.courseOrder]);
  const observedOrder = useMemo(() => courses.map((c) => c.id), [courses]);
  const observedRef = useRef(observedOrder); observedRef.current = observedOrder;
  const order = useReorder(observedOrder, (ids) => setCategoryCourseOrder(me, id, ids));
  const shown = order.shown.map((x) => courses.find((c) => c.id === x)).filter(Boolean);
  const onMoveCourse = (cid, slot) => {
    const before = shown.map((c) => c.id);
    recordMove({ before, after: moveId(before, cid, slot), label: shown.find((c) => c.id === cid)?.title, save: order.save, current: () => observedRef.current, undo });
  };
  const { list: allGuides, loaded: gLoaded } = useAllGuides(me);
  const guidesHere = useMemo(() => {
    const order = rec?.guideOrder || []; const pos = (x) => { const i = order.indexOf(x); return i < 0 ? Infinity : i; };
    return allGuides.filter((g) => g.category === id || g.liveCategory === id).sort((a, b) => pos(a.id) - pos(b.id) || a.title.localeCompare(b.title));
  }, [allGuides, id, rec?.guideOrder]);
  const observedGuides = useMemo(() => guidesHere.map((g) => g.id), [guidesHere]);
  const observedGuidesRef = useRef(observedGuides); observedGuidesRef.current = observedGuides;
  const gorder = useReorder(observedGuides, (ids) => setCategoryGuideOrder(me, id, ids));
  const gshown = gorder.shown.map((x) => guidesHere.find((g) => g.id === x)).filter(Boolean);
  const [moveGuide, setMoveGuide] = useState(null);
  const onMoveGuide = (gid, slot) => {
    const before = gshown.map((g) => g.id);
    recordMove({ before, after: moveId(before, gid, slot), label: gshown.find((g) => g.id === gid)?.title, save: gorder.save, current: () => observedGuidesRef.current, undo });
  };
  const addGuide = async () => {
    try { const cid = id || await ensure(); R.navigate(learnManagePath({ view: "guide", id: "new", category: cid })); }
    catch (e) { setSave({ state: "error", message: e?.message || "Couldn't create the category." }); }
  };
  const addCourse = async () => {
    try { const cid = id || await ensure(); R.navigate(learnManagePath({ view: "course", category: cid })); }
    catch (e) { setSave({ state: "error", message: e?.message || "Couldn't create the category." }); }
  };

  if (routeId !== "new" && tax.loaded && !rec && !cat) return <div className="sb-page"><Crumbs R={R} items={[{ label: "Academy", to: "/learn/manage" }, { label: "Not found" }]} /><div className="sb-empty"><p>This category doesn't exist any more. It may have been deleted.</p><AppLink className="sb-btn compact" to="/learn/manage" navigate={R.navigate}>Go to Academy management</AppLink></div></div>;
  if (!f || (routeId !== "new" && !tax.loaded)) return <div className="sb-page"><Skeleton lines={6} /></div>;
  const hidden = id ? (rec?.hidden === true || tax.hidden.includes(id)) : true;
  const label = (f.name || "").trim() || (routeId === "new" ? "New category" : cat?.label || "Category");
  return (
    <div className="sb-page ac-ws">
      <Crumbs R={R} items={[{ label: "Academy", to: "/learn/manage" }, { label }]} />
      <Flash R={R} />
      {rec?.deleting && (
        <div className="ac-wsnote ac-blockers" role="status">
          <ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" />
          <span><b>Deleting “{label}” isn't finished.</b> Nothing new can be added to or published in this category until it's finished or stopped.</span>
          {admin && <span className="ac-wsnoteacts"><button type="button" className="ac-link" onClick={() => setConfirm("delete")}>Finish or stop…</button></span>}
        </div>
      )}
      <div className="ac-wshead">
        <div className="ac-wstitle">
          {admin && <h1 className="ac-h1 ac-wsh1">{label}</h1>}
          <span className={"ac-pill " + (hidden ? "warn" : "ok")}>{hidden ? (id ? "Hidden from learners" : "New. Hidden from learners until you show it") : "Visible to learners"}</span>
          {admin && <span className="ac-wssave"><CatSaveStatus save={save} onRetry={persist} live={!hidden} /></span>}
        </div>
        <div className="ac-actions ac-wsbaractions">
          {(() => {
            const back = !id || hidden
              ? { label: "Back to Academy", to: "/learn", note: !id ? "This category hasn't been created yet." : "This category is hidden, so learners can't open it yet." }
              : { label: "Back to category", to: learnCategoryPath(id), note: "" };
            return <>
              <AppLink className="sb-btn ghost compact ac-backbtn" to={back.to} navigate={R.navigate} aria-describedby={back.note ? "ac-catback-note" : undefined} title={back.note || undefined}>
                <ArrowUturnLeftIcon className="hi hi-sm" aria-hidden="true" /><span>{back.label}</span>
              </AppLink>
              {back.note && <span id="ac-catback-note" className="sb-vh">{back.note}</span>}
            </>;
          })()}
          {id && <AppLink className="sb-btn ghost compact" to={learnPreviewCategoryPath(id)} navigate={R.navigate}
            title={hidden ? "See how learners will see this category once it's visible. It stays hidden." : "See this category as learners see it."}><EyeIcon className="hi hi-sm" aria-hidden="true" /><span>Preview category</span></AppLink>}
          {admin && id && hidden && <button type="button" className="sb-btn compact" onClick={() => setConfirm("restore")}><EyeIcon className="hi hi-sm" aria-hidden="true" /><span>Make visible…</span></button>}
          {admin && id && (
            <MenuButton label="More category actions" align="end" renderTrigger={({ ref, toggle, props }) => (
              <button ref={ref} type="button" className="sb-btn ghost compact ac-iconsq" onClick={toggle} aria-label="More category actions" {...props}><EllipsisHorizontalIcon className="hi hi-sm" aria-hidden="true" /></button>
            )}>
              {(close) => <>
                {!hidden && (() => { const any = courses.some((c) => c.status === "draft" || c.changes) || guidesHere.some((g) => g.status !== "published" && g.status !== "archived"); return <button type="button" role="menuitem" className="ac-menuitem" disabled={!any} onClick={() => { close({ refocus: true }); setConfirm("publishmany"); }}><CheckCircleIcon className="hi hi-sm" aria-hidden="true" /><span><b>Publish content…</b><span className="ac-cardsub">{any ? "Choose courses or tips & resources to publish" : "No drafts or unpublished changes"}</span></span></button>; })()}
                {!hidden && <button type="button" role="menuitem" className="ac-menuitem" onClick={() => { close({ refocus: true }); setConfirm("hide"); }}><EyeSlashIcon className="hi hi-sm" aria-hidden="true" /><span><b>Hide category…</b><span className="ac-cardsub">Learners stop seeing it and its courses</span></span></button>}
                {hidden && <div className="ac-menuhead">Hidden from learners</div>}
                <div role="separator" className="ac-menusep" />
                <button type="button" role="menuitem" className="ac-menuitem danger" onClick={() => { close({ refocus: true }); setConfirm("delete"); }}><TrashIcon className="hi hi-sm" aria-hidden="true" /><span><b>Delete category…</b><span className="ac-cardsub">Then choose to move or delete its courses</span></span></button>
              </>}
            </MenuButton>
          )}
        </div>
      </div>
      <div className="ac-catws">
        <div className="ac-catwsform">
          {admin ? (
            <>
              <Field id="cw-name" label="Category name" required><input id="cw-name" value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} placeholder="e.g. Lighting" autoFocus={routeId === "new"} /></Field>
              <Field id="cw-desc" label="Short description (optional)" hint="Shown under the category on the Learn page."><textarea id="cw-desc" rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={300} /></Field>
              <details className="ac-details"><summary>Additional details</summary>
                <Field id="cw-short" label="Short name (optional)" hint="Used where space is tight, like filter chips."><input id="cw-short" value={f.short} onChange={(e) => set({ short: e.target.value })} maxLength={30} /></Field>
                {id && <span className="ac-cardsub">Web address: /learn/category/{id} (doesn't change when you rename)</span>}
              </details>
            </>
          ) : (
            <><h1 className="ac-h1">{cat?.label}</h1><p className="sb-sub">{cat?.description}</p><p className="ac-note">Only admins can change categories. You can add and edit courses here.</p></>
          )}
        </div>
        <div className="ac-catwscover">
          {admin ? (
            <ImagePicker kind="catCover" label="Cover (3:4)" optional compact value={rec?.cover || null} categoryId={id || undefined}
              ensureTarget={async () => ({ categoryId: await ensure() })}
              onChange={async (ref, old) => {
                const cid = await ensure();
                await updateCategory(me, cid, { cover: ref });
                if (old?.path && old.path.startsWith("academy/catCovers/")) { try { await deleteImage(old.path); } catch {} }
              }} />
          ) : <CategoryArt category={cat || { id: "x", label: "" }} imageRef={rec?.cover || art.data?.art?.[id]} />}
        </div>
      </div>

      <section aria-labelledby="cw-courses-h" className="ac-wssection">
        <div className="sb-shead"><h2 id="cw-courses-h" className="ac-h2">Courses</h2>
          <BusyButton className="sb-btn compact" busyLabel="Opening…" onClick={addCourse}><PlusIcon className="hi hi-sm" aria-hidden="true" /><span>Add course</span></BusyButton></div>
        {admin && id && courses.length > 1 && <p className="ac-cardsub ac-ordernoterow"><OrderNote order={order} what="courses" /></p>}
        {!loaded ? <Skeleton lines={3} /> : courses.length === 0 ? <div className="sb-empty">No courses in this category yet.</div> : (
          <SortableList className="ac-wslist" items={shown} getLabel={(c) => c.title} canDrag={() => admin && !!id} onMove={onMoveCourse}
            renderItem={(c, { handle }) => (
              <div className="ac-wsrow">
                {admin && <DragHandle handle={handle} />}
                <CoverThumb imageRef={c.cover} />
                <button type="button" className="ac-wsrowmain" onClick={() => R.navigate(learnManagePath({ view: "course", id: c.id }))}>
                  <span className="ac-mtitle">{c.title}<CourseStatus c={c} /></span>
                  <span className="ac-cardsub">{c.lessons} item{c.lessons === 1 ? "" : "s"}{c.liveCategory && c.category !== c.liveCategory ? " · moving to another category when published" : ""}</span>
                </button>
                <ChevronRightIcon className="hi hi-sm ac-chev" aria-hidden="true" />
              </div>
            )} />
        )}
      </section>
      <section aria-labelledby="cw-guides-h" className="ac-wssection">
        <div className="sb-shead"><h2 id="cw-guides-h" className="ac-h2">Tips & resources</h2>
          <BusyButton className="sb-btn compact" busyLabel="Opening…" onClick={addGuide}><PlusIcon className="hi hi-sm" aria-hidden="true" /><span>Add tip or resource</span></BusyButton></div>
        {admin && id && guidesHere.length > 1 && <p className="ac-cardsub ac-ordernoterow"><OrderNote order={gorder} what="tips & resources" /></p>}
        {!gLoaded ? <Skeleton lines={2} /> : guidesHere.length === 0
          ? <div className="sb-empty">No tips or resources in this category yet. <button type="button" className="ac-link" onClick={addGuide}>Add tip or resource</button></div>
          : (
            <SortableList className="ac-wslist" items={gshown} getLabel={(g) => g.title} canDrag={() => admin && !!id} onMove={onMoveGuide}
              renderItem={(g, { handle }) => (
                <div className="ac-wsrow">
                  {admin && <DragHandle handle={handle} />}
                  <VideoThumb item={g} className="ac-wsthumb16" placeholder={<DocumentTextIcon className="hi" aria-hidden="true" />} />
                  <button type="button" className="ac-wsrowmain" onClick={() => R.navigate(learnManagePath({ view: "guide", id: g.id }))} aria-label={`Edit ${g.title}`}>
                    <span className="ac-mtitle">{g.title}<GuideStatus g={g} /></span>
                    <span className="ac-cardsub">{g.kind === "video" ? "Video resource" : "Written resource"}{g.liveCategory && g.category !== g.liveCategory ? " · moving to another category when published" : ""}</span>
                  </button>
                  {admin && guidesHere.length > 1 && <button type="button" className="sb-btn ghost compact" onClick={() => setMoveGuide(g.id)} aria-label={`Move ${g.title} to a position`}><ArrowsUpDownIcon className="hi hi-sm" aria-hidden="true" /></button>}
                  <ChevronRightIcon className="hi hi-sm ac-chev" aria-hidden="true" />
                </div>
              )} />
          )}
      </section>
      {moveGuide && (() => {
        const idx = gshown.findIndex((g) => g.id === moveGuide);
        return <MoveDialog title={`Move “${gshown[idx]?.title}”`} count={gshown.length} current={idx}
          onMove={(index) => { const before = gshown.map((g) => g.id); const after = before.filter((x) => x !== moveGuide); after.splice(index, 0, moveGuide);
            recordMove({ before, after, label: gshown[idx]?.title, save: gorder.save, current: () => observedGuidesRef.current, undo }); }}
          onClose={() => setMoveGuide(null)} />;
      })()}
      {undo.node}
      {confirm === "hide" && <ConfirmDialog title={`Hide “${label}”?`} tone="warning" danger={false} confirmLabel="Hide category"
        body="Learners will no longer see this category or anything in it, including published courses. Each course keeps its own state, so making the category visible again restores what was published."
        onConfirm={() => { requireOnline(); return setCategoryHidden(me, id, true, tax.hidden); }} onClose={() => setConfirm(null)} />}
      {confirm === "restore" && <ShowCategoryDialog me={me} catId={id} label={label} mode="show" R={R} onClose={() => setConfirm(null)} />}
      {confirm === "publishmany" && <ShowCategoryDialog me={me} catId={id} label={label} mode="publish" R={R} onClose={() => setConfirm(null)} />}
      {confirm === "delete" && <CategoryDeleteDialog me={me} catId={id} label={label} categories={tax.categories} R={R}
        onClose={() => { setConfirm(null); requestAnimationFrame(() => document.querySelector('[aria-label="More category actions"]')?.focus()); }}
        onDone={(flash) => { leaveGuard.release(); R.navigate("/learn/manage", { replace: true, state: { flash } }); }} />}
      {leaveGuard.dialog}
    </div>
  );
}
function CatSaveStatus({ save, onRetry, live }) {
  const online = useOnline();
  if (save.state === "pending") return <span className="ac-savestate muted">Unsaved changes…</span>;
  if ((save.state === "saving" || save.state === "pending") && !online) return <span className="ac-savestate warn" role="status"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />You're offline, so this isn't saved yet. Keep this tab open until you reconnect.</span>;
  if (save.state === "saving") return <span className="ac-savestate muted" role="status"><ArrowPathIcon className="hi hi-xs ac-spin" aria-hidden="true" />Saving…</span>;
  if (save.state === "saved") return <span className="ac-savestate ok" role="status"><CheckCircleIcon className="hi hi-xs" aria-hidden="true" />{live ? "Saved. Learners see this now." : "Saved"}</span>;
  if (save.state === "error") return <span className="ac-savestate err" role="alert"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />Couldn't save{save.message ? `: ${save.message.replace(/\.$/, "")}` : ""}. Your text is still here. <button type="button" className="ac-link" onClick={onRetry}>Retry</button></span>;
  return <span className="ac-savestate muted">{live ? "Changes here apply straight away" : "Changes save automatically"}</span>;
}

/* ======================================================== course workspace === */
const emptyLesson = (kind, moduleId) => ({
  mdVersion: 2,                                           // new text: Markdown format 2 (escapes)
  title: "", moduleId, kind, video: null, videoMeta: null, thumbMode: "source", description: "", resources: [], thumb: null, bonus: false,
  durationMinutes: 0, quiz: { mode: "none", passMark: DEFAULT_PASS_MARK, retryLimit: 0, questions: [] }, quizKey: { answers: {}, explanations: {} },
});
const lessonTitle = (l) => (l?.title || "").trim() || (l?.kind === "video" ? "Untitled video" : l?.kind === "resource" ? "Untitled resource" : l?.kind === "exercise" ? "Untitled exercise" : "Untitled lesson");

/* Sticky header + outline that adapt to the REAL header height (wrapping,
   banners, text zoom) and the real scroll viewport, instead of fixed offsets. */
function useStickyMetrics(rootRef, barRef, ready) {
  useLayoutEffect(() => {
    const root = rootRef.current, bar = barRef.current;
    if (!root || !bar || typeof ResizeObserver === "undefined") return undefined;
    let port = root.parentElement;
    for (let n = root.parentElement; n; n = n.parentElement) { const st = getComputedStyle(n); if (/(auto|scroll)/.test(st.overflowY)) { port = n; break; } }
    let raf = 0;
    const apply = () => {
      raf = 0;
      root.style.setProperty("--ac-bar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
      // focused/scrolled-to fields land BELOW the sticky header, never under it
      if (port) port.style.scrollPaddingTop = getComputedStyle(bar).position === "sticky" ? `${Math.ceil(bar.getBoundingClientRect().height) + 16}px` : "";
      const portRect = port ? port.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const visibleBottom = Math.min(portRect.bottom, window.innerHeight);
      root.style.setProperty("--ac-port-h", `${Math.floor(visibleBottom - Math.max(0, portRect.top))}px`);
      // The outline's height = what's left below where it is RIGHT NOW (before it
      // sticks it sits lower), so its Add footer is always on screen.
      const outline = root.querySelector(".ac-outline");
      if (outline) root.style.setProperty("--ac-outline-max", `${Math.max(320, Math.floor(visibleBottom - outline.getBoundingClientRect().top - 16))}px`);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
    apply();
    const ro = new ResizeObserver(schedule);
    ro.observe(bar); if (port) ro.observe(port);
    window.addEventListener("resize", schedule);
    port?.addEventListener("scroll", schedule, { passive: true });
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener("resize", schedule); port?.removeEventListener("scroll", schedule); if (port) port.style.scrollPaddingTop = ""; };
  }, [rootRef, barRef, ready]);   // re-run once the workspace has rendered (not the loading skeleton)
}

/* Where "fix this" moves focus (selectors tried in order; the first present wins). */
const FOCUS_TARGETS = {
  prior: () => ["#cd-prior-search", "#cd-prior-h"], cover: (cid) => [`#ac-img-cover-${cid}`],
  title: () => ["#cd-title"], category: () => ["#cd-cat"],
};
function fixTargets(i, cid) {
  if (i.item === "details") return ({ title: ["#cd-title"], category: ["#cd-cat"], level: ["#cd-level"], cover: [`#ac-img-cover-${cid}`], outline: [".ac-outadd .ac-addbtn", ".ac-outadd button"] })[i.field] || [];
  const lid = i.item;
  if (i.field === "title") return [`#ls-title-${lid}`];
  if (i.field === "video") return [`#ls-url-${lid}`];
  if (i.field === "quiz") return [`#qz-${lid}-qm`];
  if (i.field === "prerequisites") return [`#ls-acc-${lid}`];
  const qm = String(i.field).match(/^(q|qo|qa):(.+)$/);
  if (qm) return qm[1] === "qa" ? [`input[name="qz-${lid}-c-${qm[2]}"]`, `#qz-${lid}-q-${qm[2]}`] : qm[1] === "qo" ? [`#qz-${lid}-q-${qm[2]}-opts input[type=text]`, `#qz-${lid}-q-${qm[2]}`] : [`#qz-${lid}-q-${qm[2]}`];
  return [];
}
const KIND_GROUP = { missing: "Required information", quiz: "Quiz set-up", prerequisite: "Lesson order and prerequisites" };
/* "N items need attention before publishing" — a compact checklist that stays
   discoverable (collapsed, never dismissed) until the issues are fixed. Each
   item names the field and moves focus to it. Missing information is a calm
   checklist; quiz/prerequisite problems are marked as needing a fix. */
export function Readiness({ issues, attempted, open, setOpen, onFix }) {
  if (!issues.length) return null;
  const n = issues.length;
  const groups = ["missing", "quiz", "prerequisite"].map((k) => [k, issues.filter((i) => i.kind === k)]).filter(([, l]) => l.length);
  return (
    <div className={"ac-readiness" + (attempted ? " attempted" : "")}>
      <button type="button" className="ac-readysum" aria-expanded={open} aria-controls="ac-readylist" onClick={() => setOpen(!open)}>
        <ClipboardDocumentCheckIcon className="hi hi-sm" aria-hidden="true" />
        <span><b>{n === 1 ? "1 item needs attention" : `${n} items need attention`}</b> before publishing{attempted ? ". Nothing was published." : ""}</span>
        <ChevronDownIcon className={"hi hi-xs ac-readychev" + (open ? " open" : "")} aria-hidden="true" />
      </button>
      {open && (
        <div id="ac-readylist" className="ac-readylist">
          {groups.map(([k, list]) => (
            <section key={k} aria-label={KIND_GROUP[k]}>
              {groups.length > 1 && <h3 className="ac-readyh">{KIND_GROUP[k]}</h3>}
              <ul>
                {list.map((i) => (
                  <li key={i.key} className={"kind-" + i.kind}>
                    {i.kind === "missing" ? <span className="ac-readydot" aria-hidden="true" /> : <ExclamationTriangleIcon className="hi hi-xs ac-readywarn" aria-hidden="true" />}
                    <span className="ac-readytext"><b>{i.label}</b><span>{i.message}</span></span>
                    <button type="button" className="sb-btn ghost compact" onClick={() => onFix(i)} aria-label={`${i.fix}: ${i.label}`}>{i.fix}</button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/* Where "Back" leaves the editor for — the normal learner page, as the signed-in
   editor (their own progress and permissions; nothing is published, completed
   or restarted). Only pages that exist: a never-published course has no course
   page, a lesson added since the last publish has no lesson page, an archived
   course isn't on Learn. `note` says why when we can't go to the obvious place. */
export function backDestination({ cid, item, liveCourse, liveLessons = [], category = null, pathCtx = "" }) {
  const status = liveCourse ? liveCourse.status : "never";
  const opts = { path: pathCtx || null };
  if (status === "published") {
    const lessonLive = item && item !== "details" && liveLessons.some((l) => l.id === item);
    if (lessonLive) return { label: "Back to lesson", to: learnPath(cid, item, opts), note: "" };
    return { label: "Back to course", to: learnPath(cid, null, opts),
      note: item && item !== "details" ? "This lesson hasn't been published yet, so this opens the course page." : "" };
  }
  const note = status === "archived" ? "This course is archived, so it doesn't appear on Learn." : "This course hasn't been published yet, so it doesn't have a course page.";
  if (category && !category.hidden) return { label: "Back to category", aria: `Back to ${category.label}`, to: learnCategoryPath(category.id), note };
  return { label: "Back to Academy", to: "/learn", note };
}

function CourseWorkspace({ me, id: routeIdProp, categoryParam, item, focus = "", pathCtx = "", R, onCreated }) {
  const [routeId] = useState(routeIdProp);               // "new" stays "new" for this screen's life
  const admin = isAcademyAdmin(me);
  const narrow = useMediaQuery("(max-width: 899px)");
  const tax = useTaxonomy();
  const provisional = useMemo(() => (routeId === "new" ? newCourseId() : routeId), [routeId]);
  const cid = provisional;
  const store = useCourseDraft(cid, me, {
    blank: routeId === "new" ? blankCourse(normalizeCategory(categoryParam || "")) : null,
    onFirstSave: () => { if (routeId === "new") { onCreated?.(cid); R.replace(learnManagePath({ view: "course", id: cid, item: itemRef.current })); } },
  });
  const itemRef = useRef(item); itemRef.current = item;
  const { status, model, save } = store;
  const leaveGuard = useWorkspaceLeaveGuard(cid, save, store);
  const undo = useUndo();
  const online = useOnline();
  const [dialog, setDialog] = useState(null);             // { kind: "move"|"movesection"|"bulk"|"keepmine", ... }
  const [publish, setPublish] = useState({ state: "idle" });
  const outlineScroll = useRef(0);
  const autoTitles = useRef({});                          // lesson id → last auto-filled title
  const rootRef = useRef(null), barRef = useRef(null);
  useStickyMetrics(rootRef, barRef, status === "ready");
  // publish readiness: errors show per field only once touched or after a publish attempt
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState(() => new Set());
  const [readyOpen, setReadyOpen] = useState(false);
  const [focusReq, setFocusReq] = useState(() => (focus && FOCUS_TARGETS[focus] ? { sel: FOCUS_TARGETS[focus](cid), n: 1 } : null));
  const uploading = useUploadsInFlight();
  const publishing = useRef(false);
  // move focus to a field (after the pane it lives in has rendered)
  useEffect(() => {
    if (!focusReq || !focusReq.sel.length || status !== "ready") return undefined;
    let tries = 0, raf = 0;
    const go = () => {
      const el = focusReq.sel.map((q) => document.querySelector(q)).find(Boolean);
      if (el) {
        // centre the CONTROL (a hidden file input → its picker), then keep it clear of
        // a fixed bottom bar (the mobile tab bar); the sticky header is handled by scroll-padding
        // Scroll ONLY the app's content pane (scrollIntoView would also scroll the
        // document and shift the whole shell, tab bar included), centring the
        // control in the part of the pane not covered by the sticky header.
        const target = el.type === "file" ? (el.closest(".ac-imgpick") || el) : el;
        const port = rootRef.current?.closest(".sb-content");
        if (port) {
          const pr = port.getBoundingClientRect(), tr = target.getBoundingClientRect();
          const padTop = parseFloat(getComputedStyle(port).scrollPaddingTop) || 0;
          port.scrollTop += (tr.top + tr.height / 2) - (pr.top + padTop + (pr.height - padTop) / 2);
        } else target.scrollIntoView({ block: "center" });
        el.focus({ preventScroll: true });
        return;
      }
      if (tries++ < 40) raf = requestAnimationFrame(go);
    };
    raf = requestAnimationFrame(go);
    return () => cancelAnimationFrame(raf);
  }, [focusReq, status, item]);

  const select = (next) => {
    if (narrow) { const el = document.querySelector(".sb-content"); if (el) outlineScroll.current = el.scrollTop; }
    R.navigate(learnManagePath({ view: "course", id: model?.draftExists || routeId !== "new" ? cid : "new", item: next, category: routeId === "new" && !model?.draftExists ? categoryParam : "", path: pathCtx }));
  };
  // Mobile: returning to the outline restores where the author was.
  useEffect(() => { if (narrow && !item) { const el = document.querySelector(".sb-content"); if (el) requestAnimationFrame(() => { el.scrollTop = outlineScroll.current; }); } }, [item, narrow]);

  if (status === "loading") return <div className="sb-page"><Skeleton lines={8} /></div>;
  if (status === "missing") return <div className="sb-page"><Crumbs R={R} items={[{ label: "Academy", to: "/learn/manage" }, { label: "Not found" }]} /><div className="sb-empty"><p>This course doesn't exist any more. It may have been deleted.</p><AppLink className="sb-btn compact" to="/learn/manage" navigate={R.navigate}>Go to Academy management</AppLink></div></div>;
  if (status === "error") return <div className="sb-page"><div className="sb-empty" role="alert">{save.message || "Couldn't load this course."} <button type="button" className="ac-link" onClick={store.reloadFromServer}>Try again</button></div></div>;

  const { course, lessons, head, liveCourse } = model;
  const modules = course.modules && course.modules.length ? course.modules : [{ id: "m1", title: "", lessonIds: [] }];
  const showHeaders = modules.length > 1;
  const rows = outlineRows(modules, { showHeaders }).map((r) => ({ ...r, lesson: r.type === "lesson" ? lessons[r.id] : null })).filter((r) => r.type === "module" || r.lesson);
  const cat = categoryIn(tax.categories, course.category);
  const liveStatus = !liveCourse ? "never" : liveCourse.status;
  const changes = model.draftExists && liveCourse?.status === "published" && head.rev > head.publishedRev;
  const ordered = flatLessons({ modules }, Object.entries(lessons).map(([id, l]) => ({ id, ...l })));
  // prerequisite problems, recomputed on every change (drags included) — flagged
  // straight away; Publish stays blocked until they're resolved
  const prereqIssues = validatePrerequisites(ordered);
  const issueLessons = new Set(prereqIssues.map((i) => i.lessonId));
  const orderIssues = prereqIssues.filter((i) => i.kind === "order");
  const runtime = courseRuntime(ordered);
  const issues = publishIssues(course, ordered, tax.bootstrap ? null : tax.records.map((r) => r.id));
  const catHidden = !!cat && !!cat.hidden;
  const liveCat = liveCourse ? categoryIn(tax.categories, liveCourse.category) : null;
  const liveHidden = liveStatus === "published" && !!liveCat && !!liveCat.hidden;
  const selected = item && item !== "details" ? lessons[item] : null;
  const busySaving = ["pending", "saving"].includes(save.state);
  const currentModules = () => { const m = store.getModel()?.course?.modules; return m && m.length ? m : [{ id: "m1", title: "", lessonIds: [] }]; };

  /* One undoable outline change (lesson or section move). */
  const changeOutline = (after, label, message) => recordMove({
    before: modules, after, label, message, same: sameData, undo,
    save: (m) => store.setModules(m), current: currentModules,
  });
  const onOutlineMove = (rowId, slot) => {
    const row = rows.find((r) => r.id === rowId); if (!row) return;
    if (row.type === "module") changeOutline(moveModule(modules, row.moduleId, moduleIndexFromSlot(rows, row.moduleId, slot)), row.title || "Section", `Moved section “${row.title || "Untitled section"}”.`);
    else changeOutline(moveLessonInOutline(modules, rowId, slot, { showHeaders }), lessonTitle(row.lesson));
  };

  const addContent = (kind, afterId = null) => {
    if (kind === "bulk") { setDialog({ kind: "bulk", afterId }); return; }
    const lid = newLessonId();
    const target = afterId ? null : modules[modules.length - 1].id;
    const host = afterId ? modules.find((m) => (m.lessonIds || []).includes(afterId))?.id : target;
    const next = insertLesson(modules, lid, { afterId, moduleId: target });
    store.addLesson(lid, emptyLesson(kind, host || modules[0].id), next);
    select(lid);
  };
  const addVideos = (cands, afterId = null) => {
    let mods = modules; const ids = [];
    let after = afterId;
    for (const c of cands) {
      const lid = newLessonId(); ids.push(lid);
      mods = insertLesson(mods, lid, { afterId: after, moduleId: mods[mods.length - 1].id });
      after = lid;
      store.addLesson(lid, { ...emptyLesson("video", mods.find((m) => m.lessonIds.includes(lid)).id), title: c.meta?.title || "", video: videoRecord(c.parsed), videoMeta: c.meta ? { ...c.meta, id: c.parsed.id } : null }, mods);
    }
    if (ids[0]) select(ids[0]);
  };
  /* Removing a lesson other lessons depend on: explain which, and only go
     ahead when the author explicitly removes those prerequisite links too
     (never silently — a dangling link would be refused at publish). */
  const removeLessonNow = (lid, { unlink = false } = {}) => {
    const deps = dependentsOf(ordered, lid);
    if (deps.length && !unlink) { setDialog({ kind: "deps", id: lid, deps: deps.map((d) => d.id) }); return; }
    const before = modules, lesson = lessons[lid];
    const links = deps.map((d) => ({ id: d.id, prerequisites: prerequisitesOf(d) }));
    for (const d of links) store.updateLesson(d.id, { prerequisites: d.prerequisites.filter((p) => p !== lid) });
    const after = removeLesson(modules, lid);
    store.deleteLesson(lid, after);
    if (item === lid) select("details");
    undo.offer({
      message: `Removed “${lessonTitle(lesson)}”${links.length ? ` and its prerequisite link${links.length === 1 ? "" : "s"}` : ""}.`, doneMessage: `Restored “${lessonTitle(lesson)}”.`,
      undo: async () => {
        if (store.getModel()?.lessons?.[lid] || !sameData(currentModules(), after)) throw Object.assign(new Error("The outline changed after this removal, so it can't be undone safely."), { code: "stale" });
        store.addLesson(lid, lesson, before);
        for (const d of links) if (store.getModel()?.lessons?.[d.id]) store.updateLesson(d.id, { prerequisites: d.prerequisites });
      },
    });
  };
  /* Fixes offered for prerequisite problems — always the author's explicit choice. */
  const moveBelow = (lid, afterId) => {
    const mods = currentModules();
    changeOutline(insertLesson(removeLesson(mods, lid), lid, { afterId }), lessonTitle(lessons[lid]), `Moved “${lessonTitle(lessons[lid])}” below “${lessonTitle(lessons[afterId])}”.`);
  };
  const dropPrereq = (lid, prereqId) => {
    const cur = prerequisitesOf(store.getModel()?.lessons?.[lid]);
    store.updateLesson(lid, { prerequisites: cur.filter((p) => p !== prereqId) });
  };
  const prereqFixes = { moveBelow, dropPrereq, makeRequired: (id) => store.updateLesson(id, { bonus: false }), open: (id) => select(id) };
  const removeSection = (moduleId) => {
    const i = modules.findIndex((m) => m.id === moduleId); if (i < 0) return;
    const moved = modules[i].lessonIds || [];
    const rest = modules.filter((_, k) => k !== i).map((m) => ({ ...m, lessonIds: [...(m.lessonIds || [])] }));
    let after;
    if (!rest.length) after = [{ id: "m1", title: "", lessonIds: moved }];
    else { const t = Math.max(0, i - 1); after = rest.map((m, k) => (k === t ? { ...m, lessonIds: [...m.lessonIds, ...moved] } : m)); }
    changeOutline(after, modules[i].title || "Section", `Removed section “${modules[i].title || "Untitled section"}”${moved.length ? ` (its ${moved.length} item${moved.length === 1 ? "" : "s"} moved to the previous section)` : ""}.`);
  };
  const onFix = (i) => {
    const target = i.item === "details" ? "details" : i.item;
    if (i.field === "outline" && narrow) R.navigate(learnManagePath({ view: "course", id: cid }));
    else if ((item || "details") !== target) select(target);
    const sel = fixTargets(i, cid);
    const ctl = (sel.find((x) => /^#[\w-]+$/.test(x)) || "").slice(1);
    if (ctl) setTouched((t) => new Set(t).add(ctl));
    setFocusReq({ sel, n: Date.now() });
  };
  /* Publish: unresolved readiness items → show them (nothing sent). A hidden
     category → ask first (publishing alone won't make it visible). */
  const startPublish = () => {
    if (publishing.current || publish.state === "busy") return;
    if (issues.length) { setAttempted(true); setReadyOpen(true); setPublish({ state: "idle" }); return; }
    if (catHidden) { setDialog({ kind: "hiddencat" }); return; }
    doPublish();
  };
  const doPublish = async ({ showCategory = false } = {}) => {
    if (publishing.current) return;                       // double clicks / repeated Enter
    publishing.current = true;
    setPublish({ state: "busy" });
    try {
      requireOnline();
      // uploads first (a cover still uploading isn't "missing"), then any pending edits
      if (uploadsInFlight()) { setPublish({ state: "busy", waiting: "upload" }); await waitForUploads(); setPublish({ state: "busy" }); }
      const rev = await store.settle({ force: true });
      const res = await store.runPublish(() => publishCourseDraft(me, cid, rev, { showCategory }));
      setPublish({ state: "done", first: res.firstPublish, already: !!res.already, categoryShown: !!res.categoryShown, leftovers: res.leftovers });
      setAttempted(false);
      await store.refreshLive();
    } catch (e) {
      if (e?.code === "conflict") store.reloadFromServer();
      const kind = e?.code === "conflict" ? "conflict" : e?.code === "blocked" ? "blocked" : e?.code === "uploading" ? "uploading"
        : isOfflineError(e) ? "network" : (e?.code === "permission-denied" || /permission/i.test(e?.message || "")) ? "permission" : "error";
      if (kind === "blocked") { setAttempted(true); setReadyOpen(true); }
      setPublish({ state: "error", kind, blockers: e?.blockers, showCategory,
        message: kind === "conflict" ? "Someone else changed this course just now. We've loaded their version. Check it, then publish again."
          : kind === "network" ? "Couldn't connect, so nothing was published. Check your connection and try again. Trying again won't publish twice."
          : kind === "permission" ? (showCategory ? "You don't have permission to show this category, so nothing was published." : "You don't have permission to publish this course.")
          : e?.message || "Couldn't publish." });
    } finally { publishing.current = false; }
  };
  const openPreview = async () => {
    try { await store.settle(); R.navigate(learnPreviewPath(cid, item && item !== "details" ? item : null, { path: pathCtx })); }
    catch (e) { setPublish({ state: "error", message: e?.message }); }
  };
  const idleText = model.draftExists ? (changes ? "Draft saved. Learners will see these changes after you publish." : liveCourse ? "Draft saved" : "Draft saved. Learners can't see this course until you publish it.") : liveCourse ? "No unpublished changes" : "Not saved yet. Start typing to create a draft.";

  const header = (
    <header className="ac-wsbar" ref={barRef}>
      <Crumbs R={R} items={[{ label: "Academy", to: "/learn/manage" }, cat ? { label: cat.label, to: learnManagePath({ view: "category", id: cat.id }) } : { label: "No category" }, { label: (course.title || "").trim() || "New course", to: narrow && item ? learnManagePath({ view: "course", id: cid }) : null }]} />
      <div className="ac-wsbarrow">
        <div className="ac-wsbartitle">
          <h1 className="ac-wscoursename">{(course.title || "").trim() || "New course"}</h1>
          <span className="ac-wspills">
            {liveStatus === "published" ? <span className="ac-pill ok">Published</span> : liveStatus === "archived" ? <span className="ac-pill">Hidden (archived)</span> : <span className="ac-pill">Draft</span>}
            {changes && <span className="ac-pill accent">Unpublished changes</span>}
          </span>
          <SaveStatus save={save} onRetry={store.flushNow} onReload={store.reloadFromServer} onOverwrite={() => setDialog({ kind: "keepmine" })} idleText={idleText} />
        </div>
        <div className="ac-actions ac-wsbaractions">
          {(() => {
            const back = backDestination({ cid, item, liveCourse, liveLessons: model.liveLessons || [], category: cat, pathCtx });
            return <>
              <AppLink className="sb-btn ghost compact ac-backbtn" to={back.to} navigate={R.navigate} aria-label={back.aria || back.label} aria-describedby={back.note ? "ac-back-note" : undefined} title={back.note || undefined}>
                <ArrowUturnLeftIcon className="hi hi-sm" aria-hidden="true" /><span>{back.label}</span>
              </AppLink>
              {back.note && <span id="ac-back-note" className="sb-vh">{back.note}</span>}
            </>;
          })()}
          <button type="button" className="sb-btn ghost compact" disabled={!online || (!model.draftExists && !liveCourse)} title={!online ? "Previewing needs a connection." : "See your unpublished changes as learners will. Nothing is published."} onClick={openPreview}><EyeIcon className="hi hi-sm" aria-hidden="true" /><span>Preview draft</span></button>
          <BusyButton className="sb-btn compact" busy={publish.state === "busy"} busyLabel={publish.waiting === "upload" ? "Waiting for upload…" : "Publishing…"}
            disabled={!online || save.state === "conflict" || save.state === "offline" || (liveStatus === "published" && !changes && !busySaving) || (liveStatus === "never" && !model.draftExists && !busySaving)}
            title={!online || save.state === "offline" ? "Publishing needs a connection" : undefined}
            onClick={startPublish}>{liveStatus === "published" ? "Publish changes" : "Publish"}</BusyButton>
          <CourseMenu me={me} admin={admin} cid={cid} model={model} liveStatus={liveStatus} R={R} onDone={() => store.reloadFromServer()}
            backTo={cat && tax.records.some((r) => r.id === cat.id) ? learnManagePath({ view: "category", id: cat.id }) : "/learn/manage"} onLeaving={leaveGuard.release} />
        </div>
      </div>
      {!online && <div className="ac-blockers ac-wsnote" role="status"><b>You're offline.</b> Edits are kept in this tab and save when you reconnect. Publishing and preview need a connection.</div>}
      {(liveStatus !== "published" || changes || issues.length > 0) && <Readiness issues={issues} attempted={attempted} open={readyOpen} setOpen={setReadyOpen} onFix={onFix} />}
      {uploading > 0 && publish.state !== "busy" && <div className="ac-wsnote ac-note-info" role="status"><CloudArrowUpIcon className="hi hi-sm" aria-hidden="true" /><span>An image is uploading. Publishing waits for it to finish.</span></div>}
      {publish.state === "done" && (() => {
        const visible = publish.categoryShown || !(cat && cat.hidden);
        return (
          <div className={"ac-wsnote " + (visible ? "ac-ok" : "ac-note-info")} role="status">
            {visible ? <CheckCircleIcon className="hi hi-sm" aria-hidden="true" /> : <EyeSlashIcon className="hi hi-sm" aria-hidden="true" />}
            <span>{!visible ? <>Course published. Its category “{cat?.label}” is still hidden, so learners can't see it yet.{!admin && " An admin can show the category."}</>
              : publish.already ? "This version was already published, so learners already see it."
              : publish.first || publish.categoryShown ? "Course published and visible to learners." : "Changes published. Learners now see this version."}</span>
            <span className="ac-wsnoteacts">
              <AppLink className="ac-link" to={learnPath(cid)} navigate={R.navigate}>View course</AppLink>
              {!visible && admin && cat && <AppLink className="ac-link" to={learnManagePath({ view: "category", id: cat.id })} navigate={R.navigate}>Manage category</AppLink>}
              <button type="button" className="ac-link" onClick={() => setPublish({ state: "idle" })}>Dismiss</button>
            </span>
          </div>
        );
      })()}
      {publish.state !== "done" && liveHidden && (
        <div className="ac-wsnote ac-note-info" role="status"><EyeSlashIcon className="hi hi-sm" aria-hidden="true" />
          <span>Published, but its category “{liveCat.label}” is hidden, so learners can't see this course.{!admin && " An admin needs to show the category."}</span>
          {admin && <span className="ac-wsnoteacts"><button type="button" className="ac-link" onClick={() => setDialog({ kind: "showcat", catId: liveCat.id, label: liveCat.label })}>Show category…</button></span>}
        </div>
      )}
      {publish.state === "error" && publish.kind !== "blocked" && (
        <div className={"ac-wsnote " + (publish.kind === "conflict" ? "ac-blockers" : "ac-note-err")} role="alert">
          {publish.kind === "network" ? <ArrowPathIcon className="hi hi-sm" aria-hidden="true" /> : publish.kind === "permission" ? <NoSymbolIcon className="hi hi-sm" aria-hidden="true" /> : <ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" />}
          <span><b>Not published.</b> {publish.message}</span>
          <span className="ac-wsnoteacts">
            {(publish.kind === "network" || publish.kind === "error" || publish.kind === "uploading") && <button type="button" className="ac-link" onClick={() => doPublish({ showCategory: publish.showCategory })}>Try again</button>}
            <button type="button" className="ac-link" onClick={() => setPublish({ state: "idle" })}>Dismiss</button>
          </span>
        </div>
      )}
      {publish.state === "error" && publish.kind === "blocked" && !issues.length && publish.blockers && (
        <div className="ac-blockers ac-wsnote" role="alert"><b>Not published.</b> The server found problems to fix first:
          <ul>{publish.blockers.map((b, i) => <li key={i}><ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" />{b}</li>)}</ul>
          <button type="button" className="ac-link" onClick={() => setPublish({ state: "idle" })}>Dismiss</button></div>
      )}
    </header>
  );

  const outline = (
    <aside className="ac-outline" aria-label="Course outline">
      <div className="ac-outscroll">
        <button type="button" className={"ac-outrow ac-outdetails" + (!selected ? " on" : "")} aria-current={!selected ? "true" : undefined} onClick={() => select("details")}>
          <Cog6ToothIcon className="hi hi-sm" aria-hidden="true" /><span>Course details</span>
          {issues.some((i) => i.item === "details") && <ExclamationTriangleIcon className="hi hi-xs ac-warnicon" aria-label="Needs attention before publishing" />}
        </button>
        <div className="ac-outmeta ac-cardsub">
          {ordered.length} item{ordered.length === 1 ? "" : "s"}
          {runtime.measured > 0 && <> · {runtime.partial ? "at least " : ""}{formatRuntime(runtime.videoSec)} of video</>}
        </div>
        {orderIssues.length > 0 && (
          <div className="ac-prereqnotice" role="status">
            <p><ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" /> <b>{orderIssues.length === 1 ? "A prerequisite now comes after the lesson that needs it." : `${orderIssues.length} prerequisites now come after the lessons that need them.`}</b> Fix {orderIssues.length === 1 ? "it" : "them"} before publishing. Learners aren't affected until you publish.</p>
            <ul>
              {orderIssues.slice(0, 4).map((i, k) => (
                <li key={k}><button type="button" className="ac-linkbtn" onClick={() => select(i.lessonId)}>“{lessonTitle(lessons[i.lessonId])}” needs “{lessonTitle(lessons[i.prereqId])}”</button></li>
              ))}
            </ul>
          </div>
        )}
        {rows.length === 0 && <p className="ac-cardsub ac-outempty">No lessons yet. Add a video or other material to start.</p>}
        <SortableList className="ac-outlist" items={rows}
          getLabel={(r) => r.type === "module" ? `section ${r.title || "Untitled section"}` : lessonTitle(r.lesson)}
          canDrag={(r) => r.type === "lesson" || showHeaders}
          spanOf={(r, i, all) => outlineSpan(all, i)}
          canDropAt={(r, slot, rest) => outlineCanDrop(r, slot, rest)}
          positionLabel={(r, slot, slots) => r.type === "module" ? `section position ${slots.indexOf(slot) + 1} of ${slots.length}` : `position ${slots.indexOf(slot) + 1} of ${slots.length}`}
          onMove={onOutlineMove}
          renderItem={(r, { handle }) => r.type === "module" ? (
            <SectionRow r={r} modules={modules} handle={handle}
              onRename={(t) => store.setModules(modules.map((m) => m.id === r.moduleId ? { ...m, title: t } : m))}
              onMoveTo={() => setDialog({ kind: "movesection", id: r.moduleId })}
              onRemove={() => removeSection(r.moduleId)} />
          ) : (
            <div className={"ac-outrow ac-outlesson" + (item === r.id ? " on" : "")}>
              <DragHandle handle={handle} />
              <button type="button" className="ac-outmain" aria-current={item === r.id ? "true" : undefined} onClick={() => select(r.id)}>
                {(() => { const I = KIND_ICON[r.lesson.kind] || DocumentTextIcon; return <I className="hi hi-sm ac-kindicon" aria-hidden="true" />; })()}
                <span className="ac-outtext">
                  <span className="ac-outtitle">{lessonTitle(r.lesson)}</span>
                  <OutlineSub lesson={r.lesson} problem={issueLessons.has(r.id)} />
                </span>
              </button>
              <LessonMenu title={lessonTitle(r.lesson)}
                onAddBelow={(kind) => addContent(kind, r.id)}
                onMove={() => setDialog({ kind: "move", id: r.id })}
                onDelete={() => removeLessonNow(r.id)} />
            </div>
          )} />
      </div>
      <div className="ac-outadd">
        <AddContentMenu onPick={(k) => addContent(k)} label="Add content" />
        <button type="button" className="sb-btn ghost compact ac-addsection" onClick={() => store.setModules([...modules, { id: newId(), title: "", lessonIds: [] }])}><PlusIcon className="hi hi-sm" aria-hidden="true" /><span>Add section</span></button>
      </div>
    </aside>
  );

  const pubCheck = { issues, attempted, touched };
  const markTouched = (e) => { const id = e.target && e.target.id; if (id && !touched.has(id)) setTouched((t) => new Set(t).add(id)); };
  const editor = (
    <main className="ac-wseditor" aria-label={selected ? `Edit ${lessonTitle(selected)}` : "Course details"} onBlurCapture={markTouched}>
      {narrow && <button type="button" className="ac-back" onClick={() => R.navigate(learnManagePath({ view: "course", id: cid }))}><ChevronLeftIcon className="hi hi-sm" aria-hidden="true" />Course outline</button>}
      {selected
        ? <LessonPane key={item} lid={item} lesson={selected} cid={cid} store={store} autoTitles={autoTitles} onDelete={() => removeLessonNow(item)} ordered={ordered} onOpenLesson={select} issues={prereqIssues} fixes={prereqFixes} />
        : <CourseDetailsPane course={course} cid={cid} store={store} tax={tax} me={me} />}
    </main>
  );
  const editorWithChecks = <PublishCheckCtx.Provider value={pubCheck}>{editor}</PublishCheckCtx.Provider>;

  return (
    <div className="sb-page ac-ws ac-coursews" ref={rootRef}>
      {header}
      {narrow ? (item ? editorWithChecks : outline) : <div className="ac-wsgrid">{outline}{editorWithChecks}</div>}
      {undo.node}
      {dialog?.kind === "move" && (() => {
        const host = modules.find((m) => m.lessonIds.includes(dialog.id));
        const within = host ? host.lessonIds.indexOf(dialog.id) : 0;
        const pos = lessonPosition(modules, dialog.id);
        return <MoveDialog title={`Move “${lessonTitle(lessons[dialog.id])}”`} count={pos.count} current={showHeaders ? within : pos.index}
          sections={showHeaders ? modules.map((m) => ({ id: m.id, title: m.title, count: m.lessonIds.length })) : null} currentSection={host?.id}
          onMove={(index, sec) => {
            const after = showHeaders
              ? moveLessonToModule(modules, dialog.id, sec || host.id, index)
              : moveLessonToModule(modules, dialog.id, modules[0].id, index);
            changeOutline(after, lessonTitle(lessons[dialog.id]));
          }} onClose={() => setDialog(null)} />;
      })()}
      {dialog?.kind === "movesection" && (() => {
        const idx = modules.findIndex((m) => m.id === dialog.id);
        const m = modules[idx];
        return <MoveDialog title={`Move section “${m?.title || `Section ${idx + 1}`}”`} unit="section" count={modules.length} current={idx}
          onMove={(index) => changeOutline(moveModule(modules, dialog.id, index), m?.title || "Section", `Moved section “${m?.title || "Untitled section"}”.`)} onClose={() => setDialog(null)} />;
      })()}
      {dialog?.kind === "bulk" && <BulkVideoDialog existing={Object.values(lessons).map((l) => l.video?.id).filter(Boolean)} onAdd={(c) => { addVideos(c, dialog.afterId); setDialog(null); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === "deps" && (() => {
        const target = lessons[dialog.id];
        const names = dialog.deps.map((id) => `“${lessonTitle(lessons[id])}”`);
        return <ConfirmDialog title={`“${lessonTitle(target)}” is a prerequisite`} tone="warning" danger={false} confirmLabel="Remove the links and the lesson"
          body={`${names.join(", ")} ${names.length === 1 ? "requires" : "require"} it before learners can open ${names.length === 1 ? "it" : "them"}. Removing it also removes it from ${names.length === 1 ? "that lesson's" : "those lessons'"} prerequisites, so ${names.length === 1 ? "that lesson opens" : "they open"} without it. To keep a requirement, cancel and choose a different prerequisite first.`}
          onConfirm={async () => { removeLessonNow(dialog.id, { unlink: true }); }} onClose={() => setDialog(null)} />;
      })()}
      {dialog?.kind === "hiddencat" && <PublishHiddenCategoryDialog me={me} admin={admin} cid={cid} cat={cat} courseTitle={(course.title || "").trim() || "this course"}
        onPublish={(showCategory) => { setDialog(null); doPublish({ showCategory }); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === "showcat" && <ShowCategoryDialog me={me} catId={dialog.catId} label={dialog.label} mode="show" R={R} onClose={() => setDialog(null)} />}
      {leaveGuard.dialog}
      {leaveGuard.leaving && <div className="sb-vh" role="status">Saving your changes before leaving…</div>}
      {dialog?.kind === "keepmine" && <ConfirmDialog title="Replace their changes with yours?" tone="warning" danger={false} confirmLabel="Replace with my version"
        body="Someone else saved this course while you were editing. Keeping your version overwrites the changes they made since you opened it. To keep both, load their version and redo your edits instead."
        onConfirm={async () => { await store.overwriteRemote(); }} onClose={() => setDialog(null)} />}
    </div>
  );
}

/* Publishing a valid course whose category is HIDDEN. Admins choose: publish
   and show the category (one atomic step), or publish only. Editors without
   category rights publish only — told it stays hidden until an admin shows it. */
function PublishHiddenCategoryDialog({ me, admin, cid, cat, courseTitle, onPublish, onClose }) {
  const { list, loaded: cl } = useAllCourses(me);
  const { list: gl, loaded: glo } = useAllGuides(me);
  const loaded = cl && glo;
  const others = useMemo(() => [
    ...categoryCourseGroups(list, cat.id).visible.filter((c) => c.id !== cid).map((c) => ({ ...c, what: "Course" })),
    ...gl.filter((g) => (g.status === "published" || g.status === "published-edits") && g.liveCategory === cat.id).map((g) => ({ ...g, what: "Tip or resource" })),
  ], [list, gl, cat.id, cid]);
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return (
    <SmallDialog title={`Publish “${courseTitle}”?`} onClose={onClose} actions={<>
      <button ref={cancelRef} type="button" className="sb-btn ghost compact" onClick={onClose}>Cancel</button>
      {admin ? <>
        <button type="button" className="sb-btn ghost compact" onClick={() => onPublish(false)}>Publish course only</button>
        <button type="button" className="sb-btn compact" onClick={() => onPublish(true)} disabled={!loaded}>Publish course and show category</button>
      </> : <button type="button" className="sb-btn compact" onClick={() => onPublish(false)}>Publish course</button>}
    </>}>
      <div className="ac-dlgbody">
        <p><b>This course is in a hidden category (“{cat.label}”).</b> Publishing it alone won't make it visible to learners.</p>
        {admin ? (
          <>
            {!loaded ? <p className="ac-cardsub">Checking which courses are in “{cat.label}”…</p> : others.length === 0
              ? <p className="ac-cardsub">If you also show the category, only this course becomes visible. Nothing else in “{cat.label}” is published.</p>
              : <><p className="ac-cardsub">If you also show the category, {others.length === 1 ? "1 other published item" : `${others.length} other published items`} in “{cat.label}” will become visible too. Drafts, and unpublished changes to published content, stay private.</p>
                <details className="ac-details"><summary>See {others.length === 1 ? "the item" : `the ${others.length} items`} that will become visible</summary>
                  <ul className="ac-dlglist">{others.map((c) => <li key={c.id}>{c.what}: {c.liveTitle || c.title}</li>)}</ul></details></>}
          </>
        ) : <p className="ac-cardsub">You can publish “{courseTitle}” now, but learners won't see it until an admin shows “{cat.label}”. Nothing else changes.</p>}
      </div>
    </SmallDialog>
  );
}

/* What confirming will do, in plain words (no revision numbers: the exact
   saved versions shown here are re-checked just before anything changes). */
function planText({ mode, label, titles }) {
  const list = (t) => (t.length <= 1 ? t.map((x) => `“${x}”`).join("") : `${t.slice(0, -1).map((x) => `“${x}”`).join(", ")} and “${t[t.length - 1]}”`);
  if (mode === "show" && !titles.length) return `Show “${label}” to learners. No courses will be published.`;
  if (mode === "show") return `Publish the latest saved ${titles.length === 1 ? "version" : "versions"} of ${list(titles)}, then show “${label}” to learners. The category is shown only if every selected course publishes.`;
  if (!titles.length) return "Nothing yet. Select the courses you want to publish.";
  return `Publish the latest saved ${titles.length === 1 ? "version" : "versions"} of ${list(titles)}. “${label}” stays visible.`;
}
const READINESS_LABEL = { never: "Never published", edits: "Published, with unpublished changes" };
/* Show a hidden category (and optionally publish chosen courses with it), or —
   when it's already visible — publish chosen courses. Nothing is preselected.
   Each chosen course is checked with the same rules as Publish, pinned to the
   revision shown here, re-checked just before applying, and published one by
   one; the category is shown LAST and only if every chosen course published. */
function ShowCategoryDialog({ me, catId, label, mode = "show", R, onClose }) {
  const tax = useTaxonomy();
  const { list, loaded: cLoaded } = useAllCourses(me);
  const { list: allGuides, loaded: gLoaded } = useAllGuides(me);
  const loaded = cLoaded && gLoaded;
  const groups = useMemo(() => categoryCourseGroups(list, catId), [list, catId]);
  // tips & resources, grouped the same way (their own records + drafts)
  const ggroups = useMemo(() => ({
    visible: allGuides.filter((g) => (g.status === "published" || g.status === "published-edits") && g.liveCategory === catId),
    never: allGuides.filter((g) => (g.status === "draft-only" || g.status === "unpublished") && g.category === catId),
    edits: allGuides.filter((g) => g.status === "published-edits" && g.category === catId),
    archived: allGuides.filter((g) => g.status === "archived" && g.liveCategory === catId),
  }), [allGuides, catId]);
  const cands = useMemo(() => [
    ...groups.never.map((c) => ({ ...c, type: "course", kind: "never" })), ...groups.edits.map((c) => ({ ...c, type: "course", kind: "edits" })),
    ...ggroups.never.map((g) => ({ ...g, type: "guide", kind: "never" })), ...ggroups.edits.map((g) => ({ ...g, type: "guide", kind: "edits" })),
  ], [groups, ggroups]);
  const typeOf = (id) => cands.find((c) => c.id === id)?.type || "course";
  const categoryIds = useMemo(() => (tax.bootstrap ? null : tax.records.map((r) => r.id)), [tax.bootstrap, tax.records]);
  const [ready, setReady] = useState({});
  const [sel, setSel] = useState([]);
  const [phase, setPhase] = useState("review");             // review | running | result
  const [progress, setProgress] = useState({});
  const [result, setResult] = useState(null);
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  const check = useCallback(async (ids) => {
    if (!ids.length) return;
    setReady((r) => ({ ...r, ...Object.fromEntries(ids.map((id) => [id, { loading: true }])) }));
    await Promise.all(ids.map(async (id) => {
      try { const r = await readinessFor(typeOf(id), id); setReady((x) => ({ ...x, [id]: r })); }
      catch { setReady((x) => ({ ...x, [id]: { error: true } })); }
    }));
  }, [categoryIds, cands]); // eslint-disable-line react-hooks/exhaustive-deps
  /* the same checks as each item's own Publish, pinned to its draft revision */
  const readinessFor = async (type, id) => {
    if (type === "course") return readinessOf(await loadCourseWorkspace(id), categoryIds);
    const w = await loadGuideWorkspace(id);
    if (!w.draftExists) return { rev: null, issues: [{ label: "Open it in the editor and save once" }], ready: false };
    const issues = guidePublishIssues(w.guide, categoryIds);
    return { rev: w.head.rev, issues, ready: issues.length === 0 };
  };
  const candKey = cands.map((c) => c.id).join();
  useEffect(() => { if (loaded && tax.loaded) check(cands.map((c) => c.id)); }, [loaded, tax.loaded, candKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const readyIds = cands.filter((c) => ready[c.id]?.ready).map((c) => c.id);
  const toggle = (id) => setSel((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const close = () => { if (phase !== "running") onClose(); };

  const run = async (show, ids) => {
    if (busy.current) return;                               // double clicks
    busy.current = true; setNotice("");
    try {
      requireOnline();
      const items = ids.map((id) => ({ id, type: typeOf(id), title: cands.find((c) => c.id === id)?.title || "Untitled", rev: ready[id]?.rev }));
      // re-check right before applying: the exact reviewed revision, still ready
      const fresh = await Promise.all(items.map(async (it) => ({ it, r: await readinessFor(it.type, it.id) })));
      const changed = fresh.filter(({ it, r }) => r.rev !== it.rev || !r.ready);
      if (changed.length) {
        setReady((x) => ({ ...x, ...Object.fromEntries(fresh.map(({ it, r }) => [it.id, r])) }));
        setSel((x) => x.filter((id) => !changed.some((c) => c.it.id === id)));
        setNotice(`${changed.map((c) => `“${c.it.title}”`).join(", ")} changed after you opened this list, so nothing was published${mode === "show" ? " or shown" : ""}. Check ${changed.length === 1 ? "it" : "them"} below, then confirm again.`);
        return;
      }
      setPhase("running"); setProgress({});
      const res = await runCategoryPublish({
        items, show,
        publish: (id, rev, it) => (it && it.type === "guide" ? publishGuideDraft(me, id, rev) : publishCourseDraft(me, id, rev)),
        showCategory: () => setCategoryHidden(me, catId, false),
        onProgress: (id, st) => setProgress((p) => ({ ...p, [id]: st })),
      });
      setResult({ ...res, show }); setPhase("result");
    } catch (e) {
      setNotice(isOfflineError(e) ? "You're offline or the connection dropped, so nothing changed. Reconnect, then try again." : e?.message || "Something went wrong, so nothing changed. Please try again.");
      setPhase("review");
    } finally { busy.current = false; }
  };
  const showNow = async () => {
    if (busy.current) return; busy.current = true;
    try { requireOnline(); await setCategoryHidden(me, catId, false); setResult((r) => ({ ...r, category: "shown" })); }
    catch (e) { setResult((r) => ({ ...r, category: "failed", categoryError: e?.message })); }
    finally { busy.current = false; }
  };
  const retryFailed = () => {
    const ids = result.results.filter((r) => !r.ok).map((r) => r.id);
    setSel(ids); setResult(null); setPhase("review"); check(ids);
  };
  const editLink = (id) => <AppLink className="ac-link" to={learnManagePath({ view: typeOf(id) === "guide" ? "guide" : "course", id })} navigate={(to) => { onClose(); R.navigate(to); }}>{typeOf(id) === "guide" ? "Edit resource" : "Edit course"}</AppLink>;

  let body, actions;
  if (phase === "result" && result) {
    body = (
      <div className="ac-dlgbody" role="status">
        <p><b>{outcomeSummary(result, { wasHidden: mode === "show" })}</b></p>
        {result.results.length > 0 && (
          <ul className="ac-pubresults">
            {result.results.map((r) => (
              <li key={r.id} className={r.ok ? "ok" : "fail"}>
                {r.ok ? <CheckCircleIcon className="hi hi-sm" aria-hidden="true" /> : <ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" />}
                <span><b>{r.title}</b>: {r.ok ? (r.already ? "this version was already published." : "published.") : r.message}</span>
                {!r.ok && editLink(r.id)}
              </li>
            ))}
          </ul>
        )}
        {result.category === "held" && <p className="ac-cardsub">“{label}” is still hidden so learners don't see an incomplete set. Try {result.results.filter((r) => !r.ok).length === 1 ? "the item that didn't publish" : "the items that didn't publish"} again, or show the category anyway.</p>}
        {result.category === "failed" && <p className="ac-fielderr">{result.categoryError || "Showing the category failed."} What was published stays published.</p>}
        {mode === "publish" && result.results.some((r) => !r.ok) && <p className="ac-cardsub">Nothing was hidden or unpublished. Content that was already visible stays visible.</p>}
      </div>
    );
    actions = <>
      {result.results.some((r) => !r.ok) && <button type="button" className="sb-btn ghost compact" onClick={retryFailed}>Retry failed</button>}
      {(result.category === "held" || result.category === "failed") && <button type="button" className="sb-btn ghost compact" onClick={showNow}>Show category now</button>}
      <button type="button" className="sb-btn compact" onClick={onClose}>Done</button>
    </>;
  } else {
    const running = phase === "running";
    body = (
      <div className="ac-dlgbody">
        {!loaded ? <Skeleton lines={3} /> : <>
          {mode === "show" && (
            <section className="ac-dlgsec">
              <h3 className="ac-h3">{groups.visible.length + ggroups.visible.length === 0 ? "Already published: none" : `Already published (${groups.visible.length + ggroups.visible.length} will become visible)`}</h3>
              {groups.visible.length + ggroups.visible.length > 0 ? <ul className="ac-dlglist">
                {groups.visible.map((c) => <li key={c.id}>Course: {c.liveTitle || c.title}{c.changes ? <span className="ac-cardsub"> (learners see the published version; its unpublished changes stay private)</span> : null}</li>)}
                {ggroups.visible.map((g) => <li key={g.id}>Tip or resource: {g.title}{g.changes ? <span className="ac-cardsub"> (learners see the published version; its unpublished changes stay private)</span> : null}</li>)}
              </ul> : <p className="ac-cardsub">Nothing here is published yet. Learners will see an empty category unless you publish something below.</p>}
            </section>
          )}
          <section className="ac-dlgsec">
            <h3 className="ac-h3">{mode === "show" ? "Also publish (optional)" : "Content you can publish"}</h3>
            {cands.length === 0 ? <p className="ac-cardsub">No drafts or unpublished edits in this category.</p> : (
              <>
                <p className="ac-cardsub">Nothing is selected for you. Choose what's ready, or{" "}
                  <button type="button" className="ac-link inline" disabled={!readyIds.length || running} onClick={() => setSel(readyIds)}>select all ready ({readyIds.length})</button>.</p>
                {["course", "guide"].filter((t) => cands.some((c) => c.type === t)).map((t) => (
                <React.Fragment key={t}>
                <h4 className="ac-pubgroup">{t === "course" ? "Courses" : "Tips & resources"}</h4>
                <ul className="ac-pubpick">
                  {cands.filter((c) => c.type === t).map((c) => {
                    const r = ready[c.id] || { loading: true };
                    const st = progress[c.id];
                    return (
                      <li key={c.id} className={r.ready ? "" : "notready"}>
                        <label className="ac-pubrow">
                          <input type="checkbox" checked={sel.includes(c.id)} disabled={!r.ready || running} onChange={() => toggle(c.id)} aria-describedby={`pub-${c.id}-st`} />
                          <span className="ac-pubtitle"><b>{c.title}</b><span className="ac-cardsub">{READINESS_LABEL[c.kind]}</span></span>
                        </label>
                        <span id={`pub-${c.id}-st`} className="ac-pubstate">
                          {st === "publishing" ? "Publishing…" : st === "done" ? "Published" : st === "failed" ? "Failed"
                            : r.loading ? "Checking…" : r.error ? "Couldn't check" : r.ready ? <span className="ac-ok-text">Ready</span>
                            : <>{r.issues.length} item{r.issues.length === 1 ? "" : "s"} to fix: {r.issues.slice(0, 2).map((i) => i.label).join(", ")}{r.issues.length > 2 ? "…" : ""}</>}
                        </span>
                        {!r.ready && !r.loading && editLink(c.id)}
                      </li>
                    );
                  })}
                </ul>
                </React.Fragment>))}
                {groups.edits.length + ggroups.edits.length > 0 && <p className="ac-cardsub">If you don't select published content with unpublished changes, learners keep seeing its current published version.</p>}
              </>
            )}
          </section>
          {groups.archived.length + ggroups.archived.length > 0 && (
            <section className="ac-dlgsec"><h3 className="ac-h3">Archived (these stay hidden)</h3>
              <ul className="ac-dlglist">{[...groups.archived, ...ggroups.archived].map((c) => <li key={c.id}>{c.title} <span className="ac-cardsub">(to publish it again, restore it from its menu first)</span></li>)}</ul></section>
          )}
          <p className="ac-dlgplan" role="status"><b>When you confirm:</b>{" "}
            {planText({ mode, label, titles: sel.map((id) => cands.find((c) => c.id === id)?.title || "Untitled") })}</p>
          {notice && <p className="ac-fielderr" role="alert">{notice}</p>}
        </>}
      </div>
    );
    actions = <>
      <button ref={cancelRef} type="button" className="sb-btn ghost compact" onClick={close} disabled={running}>Cancel</button>
      {mode === "show" && <button type="button" className="sb-btn ghost compact" disabled={running || !loaded} onClick={() => run(true, [])}>Show category only</button>}
      <BusyButton className="sb-btn compact" busy={running} busyLabel="Publishing…" disabled={!sel.length || !loaded}
        onClick={() => run(mode === "show", sel)}>{mode === "show" ? `Publish ${sel.length || ""} selected and show category`.replace("  ", " ") : `Publish ${sel.length || ""} selected`.replace("  ", " ")}</BusyButton>
    </>;
  }
  return <SmallDialog title={mode === "show" ? `Show “${label}” to learners` : `Publish content in “${label}”`} onClose={close} actions={actions}>{body}</SmallDialog>;
}

function OutlineSub({ lesson, problem = false }) {
  const bits = [];
  if (lesson.video) { if (lesson.videoMeta?.isLive) bits.push("Live"); else if (lesson.videoMeta?.durationSec) bits.push(formatClock(lesson.videoMeta.durationSec)); }
  else if (lesson.durationMinutes > 0) bits.push(`~${lesson.durationMinutes} min`);
  if (lesson.bonus) bits.push("Optional");
  const pre = prerequisitesOf(lesson).length;
  if (pre) bits.push(pre === 1 ? "Needs 1 lesson first" : `Needs ${pre} lessons first`);
  return <span className="ac-outsub"><span className="sb-vh">{lessonKindMeta(lesson).label}{bits.length ? ", " : ""}</span>{bits.join(" · ")}{problem && <span className="ac-outwarn"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />Prerequisite problem</span>}</span>;
}

function SectionRow({ r, modules, handle, onRename, onMoveTo, onRemove }) {
  const [t, setT] = useState(r.title || "");
  useEffect(() => setT(r.title || ""), [r.title]);
  const i = modules.findIndex((m) => m.id === r.moduleId);
  const count = modules[i]?.lessonIds?.length || 0;
  return (
    <div className="ac-outsection">
      <DragHandle handle={handle} />
      <label htmlFor={`sec-${r.moduleId}`} className="sb-vh">Section name</label>
      <input id={`sec-${r.moduleId}`} value={t} placeholder={`Section ${i + 1}`} onChange={(e) => setT(e.target.value)} onBlur={() => t !== (r.title || "") && onRename(t)} maxLength={120} />
      <span className="ac-outseccount" aria-hidden="true">{count}</span>
      <MenuButton label={`Section actions: ${r.title || `Section ${i + 1}`}`} align="end" renderTrigger={({ ref, toggle, props }) => (
        <button ref={ref} type="button" className="ac-iconbtn" onClick={toggle} aria-label={`Section actions: ${r.title || `Section ${i + 1}`}`} {...props}><EllipsisHorizontalIcon className="hi hi-sm" aria-hidden="true" /></button>
      )}>
        {(close) => <>
          <button type="button" role="menuitem" className="ac-menuitem" onClick={() => { close({ refocus: true }); onMoveTo(); }}><ArrowsUpDownIcon className="hi hi-sm" aria-hidden="true" /><span><b>Move to position…</b></span></button>
          <button type="button" role="menuitem" className="ac-menuitem danger" onClick={() => { close(); onRemove(); }}><TrashIcon className="hi hi-sm" aria-hidden="true" /><span><b>Remove section</b><span className="ac-cardsub">{count ? "Its items move to the previous section" : "It's empty"}</span></span></button>
        </>}
      </MenuButton>
    </div>
  );
}

/* Item actions. "Add content below…" swaps the same anchored menu to the five
   content types, so the new item lands exactly below this one. */
function LessonMenu({ title, onAddBelow, onMove, onDelete }) {
  const [step, setStep] = useState("actions");
  return (
    <MenuButton label={step === "add" ? `Add content below “${title}”` : `Actions for “${title}”`} align="end" onOpenChange={(o) => { if (!o) setStep("actions"); }}
      renderTrigger={({ ref, toggle, props }) => (
        <button ref={ref} type="button" className="ac-iconbtn" onClick={toggle} aria-label={`Actions for “${title}”`} {...props}><EllipsisHorizontalIcon className="hi hi-sm" aria-hidden="true" /></button>
      )}>
      {(close) => step === "add" ? (
        <>
          <div className="ac-menuhead" aria-hidden="true">Add below “{title}”</div>
          <ContentChoices onPick={(k) => { close(); setStep("actions"); onAddBelow(k); }} />
        </>
      ) : (
        <>
          <button type="button" role="menuitem" className="ac-menuitem" onClick={(e) => { setStep("add"); requestAnimationFrame(() => e.currentTarget?.closest?.('[role="menu"]')?.querySelector('[role="menuitem"]')?.focus()); }}><PlusIcon className="hi hi-sm" aria-hidden="true" /><span><b>Add content below…</b></span></button>
          <button type="button" role="menuitem" className="ac-menuitem" onClick={() => { close({ refocus: true }); onMove(); }}><ArrowsUpDownIcon className="hi hi-sm" aria-hidden="true" /><span><b>Move to position…</b></span></button>
          <button type="button" role="menuitem" className="ac-menuitem danger" onClick={() => { close(); onDelete(); }}><TrashIcon className="hi hi-sm" aria-hidden="true" /><span><b>Remove</b><span className="ac-cardsub">You can undo this straight after</span></span></button>
        </>
      )}
    </MenuButton>
  );
}

/* The course ⋯ menu. Delete course sits below a divider, apart from Unpublish
   and Archive (which keep the course):
   * never published → any Academy editor can delete it (its draft goes);
   * otherwise → admins only (the rules enforce it), and never while
     published (unpublish first — the same rule the server applies).
   After a delete: the course's category in the workspace (captured BEFORE
   deleting), else /learn/manage; the deleted editor route is replaced. */
function CourseMenu({ me, admin, cid, model, liveStatus, R, onDone, backTo = "/learn/manage", onLeaving }) {
  const [confirm, setConfirm] = useState(null);
  const online = useOnline();
  // impact check before a permanent delete (server reads only); Delete stays disabled until it succeeds
  const [refs, setRefs] = useState(null);
  const [checkTry, setCheckTry] = useState(0);
  useEffect(() => {
    if (confirm !== "delete") return undefined;
    let live = true; setRefs(null);
    Promise.all([pathsUsingCourse(cid).catch(() => null), coursesRecommending(cid).catch(() => null)]).then(([paths, recs]) => { if (live) setRefs({ paths, recs }); });
    return () => { live = false; };
  }, [confirm, cid, checkTry]);
  const refsFailed = !!refs && (refs.paths == null || refs.recs == null);
  const lessons = Object.keys(model.lessons).length;
  const title = (model.course.title || "").trim() || "Untitled course";
  const pick = (close, what) => () => { close({ refocus: true }); setConfirm(what); };
  const refocus = () => requestAnimationFrame(() => document.querySelector('[aria-label="More course actions"]')?.focus());
  const closeDialog = () => { setConfirm(null); refocus(); };
  const leave = (flash) => { onLeaving?.(); R.navigate(backTo, { replace: true, state: { flash } }); };
  const neverPublished = liveStatus === "never";
  const deleteState = neverPublished ? (model.draftExists ? "ok" : "none")
    : !admin ? "admins" : liveStatus === "published" ? "published" : "ok";
  const list = (xs) => xs.map((x) => `“${x.title}”`).join(", ");
  return (
    <>
      <MenuButton label="More course actions" align="end" renderTrigger={({ ref, toggle, props }) => (
        <button ref={ref} type="button" className="sb-btn ghost compact ac-iconsq" onClick={toggle} aria-label="More course actions" {...props}><EllipsisHorizontalIcon className="hi hi-sm" aria-hidden="true" /></button>
      )}>
        {(close) => <>
          {liveStatus !== "never" && liveStatus !== "draft" && <button type="button" role="menuitem" className="ac-menuitem" onClick={() => { close(); R.navigate(learnPath(cid)); }}><EyeIcon className="hi hi-sm" aria-hidden="true" /><span><b>View published version</b></span></button>}
          {liveStatus === "published" && <button type="button" role="menuitem" className="ac-menuitem" onClick={pick(close, "unpublish")}><EyeSlashIcon className="hi hi-sm" aria-hidden="true" /><span><b>Unpublish…</b><span className="ac-cardsub">Learners stop seeing it. Progress is kept.</span></span></button>}
          {liveStatus === "published" && <button type="button" role="menuitem" className="ac-menuitem" onClick={pick(close, "archive")}><ArchiveBoxIcon className="hi hi-sm" aria-hidden="true" /><span><b>Archive…</b><span className="ac-cardsub">Hidden and kept for later</span></span></button>}
          {liveStatus === "archived" && <button type="button" role="menuitem" className="ac-menuitem" disabled={!online} onClick={async () => { close({ refocus: true }); await setCourseStatus(me, cid, "draft"); onDone(); }}><ArrowUturnLeftIcon className="hi hi-sm" aria-hidden="true" /><span><b>Restore to draft</b><span className="ac-cardsub">{online ? "Still hidden from learners until you publish" : "Needs a connection"}</span></span></button>}
          {deleteState === "none" && <div className="ac-menuhead">Nothing to manage yet. This course hasn't been saved.</div>}
          {deleteState !== "none" && <>
            <div role="separator" className="ac-menusep" />
            <button type="button" role="menuitem" className="ac-menuitem danger" disabled={deleteState !== "ok"} onClick={pick(close, neverPublished ? "discard" : "delete")}>
              <TrashIcon className="hi hi-sm" aria-hidden="true" />
              <span><b>Delete course…</b><span className="ac-cardsub">{deleteState === "published" ? "Unpublish it first. A published course can't be deleted."
                : deleteState === "admins" ? "Only admins can delete a course. You can unpublish or archive it."
                : neverPublished ? "It was never published, so no learner has seen it" : "Permanently removes it"}</span></span>
            </button>
          </>}
        </>}
      </MenuButton>
      {confirm === "unpublish" && <ConfirmDialog title={`Unpublish “${title}”?`} tone="warning" danger={false} confirmLabel="Unpublish" body="Learners stop seeing this course straight away. Their progress is kept, and you can publish it again at any time." onConfirm={async () => { requireOnline(); await setCourseStatus(me, cid, "draft"); onDone(); }} onClose={closeDialog} />}
      {confirm === "archive" && <ConfirmDialog title={`Archive “${title}”?`} tone="warning" danger={false} confirmLabel="Archive course" body="Learners stop seeing this course, and their progress is kept. To publish it again later, restore it to a draft first." onConfirm={async () => { requireOnline(); await setCourseStatus(me, cid, "archived"); onDone(); }} onClose={closeDialog} />}
      {confirm === "discard" && <ConfirmDialog title={`Delete “${title}”?`} confirmLabel="Delete course" busyLabel="Deleting…"
        body={`“${title}” was never published, so no learner has seen it. Its draft, its ${lessons} item${lessons === 1 ? "" : "s"} and the images uploaded for it are deleted. This can't be undone.`}
        onConfirm={async () => { requireOnline(); await discardNeverPublishedDraft(cid); leave(`Deleted the course “${title}”.`); }} onClose={closeDialog} />}
      {confirm === "delete" && <ConfirmDialog title={`Delete “${title}” permanently?`} confirmLabel="Delete course" busyLabel="Deleting…"
        confirmDisabled={!refs || refsFailed} blockedReason={!refs ? "Available once the check finishes." : refsFailed ? "Available after the check succeeds." : ""}
        retry={refsFailed ? { label: "Retry", onClick: () => setCheckTry((n) => n + 1) } : null}
        body={`“${title}” and its ${lessons} item${lessons === 1 ? "" : "s"} will be removed. This can't be undone.`}
        consequences={[
          "Its lessons, quizzes, discussions and draft are deleted, along with images uploaded only for this course. Images used elsewhere are kept. Videos stay on YouTube, Vimeo or Google Drive.",
          "Everyone's progress and quiz results for this course are deleted.",
          !refs ? "Checking where this course is used…"
            : refs.paths == null ? "Couldn't check which learning paths use this course. Nothing has been deleted."
            : refs.paths.length ? `${refs.paths.length} learning path${refs.paths.length === 1 ? " uses" : "s use"} it (${list(refs.paths)}). That step will show as unavailable until the path is updated.` : "No learning paths use this course.",
          !refs ? null : refs.recs == null ? "Couldn't check which courses recommend it. Nothing has been deleted."
            : refs.recs.length ? `${refs.recs.length} course${refs.recs.length === 1 ? " recommends" : "s recommend"} it as prior knowledge (${list(refs.recs)}). Learners stop seeing it there, and editors are asked to update the list.` : "No courses recommend it as prior knowledge.",
        ].filter(Boolean)}
        onConfirm={async () => {
          requireOnline();
          const report = await deleteCourseHard(me, cid);
          leave(report.pendingCleared ? `Deleted the course “${title}”.`
            : `Deleted the course “${title}”. Some clean-up (old images or progress records) is still pending. You can retry it from the Academy workspace page.`);
        }} onClose={closeDialog} />}
    </>
  );
}

/* ------------------------------------------------------- course details ---- */
function CourseDetailsPane({ course, cid, store, tax, me }) {
  const up = store.updateCourse;
  const err = usePublishErr("details");
  const [previewUrl, setPreviewUrl] = useState(course.previewVideo ? (videoFromRecord(course.previewVideo)?.url || "") : "");
  const pv = previewUrl.trim() ? parseVideoLink(previewUrl) : null;
  return (
    <div className="ac-pane">
      <h2 className="ac-h2">Course details</h2>
      <div className="ac-edgrid">
        <div>
          <Field id="cd-title" label="Title" required error={err("title", "cd-title")}><input id="cd-title" value={course.title || ""} onChange={(e) => up({ title: e.target.value })} maxLength={120} placeholder="e.g. Lighting Fundamentals" autoFocus={!course.title} /></Field>
          <RichTextField id="cd-about" label="About this course (optional)" value={course.about} format={course.mdVersion || 1} onChange={(v, fmt) => up({ about: v, mdVersion: fmt })} rows={6} placeholder="What will people learn, and who is it for?" />
          <div className="ac-row2">
            <div className={"sb-field" + (err("category", "cd-cat") ? " has-err" : "")}><label htmlFor="cd-cat">Category<RequiredTag /></label><CategorySelect id="cd-cat" value={course.category} onChange={(v) => up({ category: v })} />
              {err("category", "cd-cat") && <div className="ac-fielderr" id="cd-cat-err">{err("category", "cd-cat")}</div>}
              <div className="ac-hint">Moving a published course takes effect when you publish.</div></div>
            <Field id="cd-level" label="Level" required error={err("level", "cd-level")}><select id="cd-level" value={course.level || "beginner"} onChange={(e) => up({ level: e.target.value })}>{ACADEMY_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select></Field>
          </div>
          <Field id="cd-out" label="What learners will be able to do (optional)" hint="One per line."><textarea id="cd-out" rows={3} value={(course.outcomes || []).join("\n")} onChange={(e) => up({ outcomes: e.target.value.split("\n") })} /></Field>
          <PriorKnowledgeField cid={cid} value={course.priorKnowledge} onChange={(v) => up({ priorKnowledge: v })} me={me} tax={tax} />
          <details className="ac-details"><summary>Additional details</summary>
            <Field id="cd-req" label="Before starting (optional)" hint="One per line, for example gear, accounts or other courses."><textarea id="cd-req" rows={3} value={(course.requirements || []).join("\n")} onChange={(e) => up({ requirements: e.target.value.split("\n") })} /></Field>
            <Field id="cd-prev" label="Preview / trailer video (optional)" hint="Shown on the course page. The first lesson is never used as a trailer automatically.">
              <input id="cd-prev" type="url" inputMode="url" value={previewUrl} placeholder="https://youtu.be/…" onChange={(e) => { setPreviewUrl(e.target.value); const p = e.target.value.trim() ? parseVideoLink(e.target.value) : null; if (!e.target.value.trim()) up({ previewVideo: null }); else if (p?.ok) up({ previewVideo: videoRecord(p) }); }} />
              {pv && !pv.ok && <div className="ac-err" role="alert">{pv.reason}</div>}
            </Field>
            <TopicsField id="cd-topics" value={course.topicIds || []} onChange={(v) => up({ topicIds: v })} legacy={course.topics || []} onLegacyChange={(v) => up({ topics: v })} category={course.category} />
          </details>
        </div>
        <div>
          <ImagePicker kind="cover" label="Cover (3:4)" compact value={course.cover} courseId={cid} ensureTarget={store.ensureSaved} required error={err("cover", `ac-img-cover-${cid}`)}
            onChange={(ref, old) => { up({ cover: ref }); if (old?.path) store.imageReplaced(old.path); }} />
        </div>
      </div>
    </div>
  );
}

/* Recommended prior knowledge: other courses (any category) this one assumes
   some familiarity with, plus an optional note. Advisory only — it never locks
   the course, never counts toward progress. Stored as stable course ids; the
   course itself and duplicates can't be picked. References learners can't see
   (draft, archived, hidden category, deleted) are flagged here. */
export function PriorKnowledgeField({ cid, value, onChange, me, tax }) {
  const { courses, loaded, error } = useCourses(me);
  const pk = { courseIds: (value && value.courseIds) || [], note: (value && value.note) || "" };
  const byId = new Map(courses.map((c) => [c.id, c]));
  const set = (patch) => onChange({ ...pk, ...patch });
  const cands = courses.filter((c) => c.id !== cid && !pk.courseIds.includes(c.id) && c.status !== "archived");
  const chosen = pk.courseIds.map((x) => byId.get(x)).filter(Boolean);
  const remove = (id) => { set({ courseIds: pk.courseIds.filter((x) => x !== id) }); requestAnimationFrame(() => document.getElementById("cd-prior-search")?.focus()); };
  const why = (c) => {
    if (!c) return loaded ? "This course no longer exists, so learners won't see it. Remove it from the list." : "";
    const cat = categoryIn(tax.categories, c.category);
    if (c.status !== "published") return `${c.status === "archived" ? "Archived" : "Not published"}. Learners won't see this course until it's published.`;
    if (cat && cat.hidden) return "Its category is hidden, so learners won't see this course.";
    return "";
  };
  return (
    <section className="ac-access ac-prior" aria-labelledby="cd-prior-h">
      <h3 id="cd-prior-h" className="ac-h3">Recommended prior knowledge <span className="ac-cardsub">(optional)</span></h3>
      <p className="ac-fieldhint" id="cd-prior-hint">Courses that cover what this one assumes. It's a recommendation only: learners can always start this course, and these never count toward its progress.</p>
      {pk.courseIds.length > 0 && (
        <ul className="ac-priorlist" aria-label="Recommended courses">
          {pk.courseIds.map((id) => {
            const c = byId.get(id); const w = why(c);
            return (
              <li key={id} className={w ? "warn" : ""}>
                <span className="ac-priortitle"><b>{c ? c.title : "Removed course"}</b>{c && <span className="ac-cardsub"> · {categoryIn(tax.categories, c.category)?.label || "No category"}</span>}</span>
                {w && <span className="ac-priorwarn"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />{w}</span>}
                <button type="button" className="ac-chipx" aria-label={`Remove ${c ? c.title : "removed course"} from recommended prior knowledge`} onClick={() => remove(id)}><XMarkIcon className="hi hi-xs" aria-hidden="true" /><span className="ac-chipxlabel" aria-hidden="true">Remove</span></button>
              </li>
            );
          })}
        </ul>
      )}
      {pk.courseIds.length < 10 ? (
        <div className="sb-field ac-prereqpick">
          <label htmlFor="cd-prior-search" className="sb-vh">Add a recommended course</label>
          <SearchPicker id="cd-prior-search" label="Add a recommended course. Search all courses" placeholder="Search courses to recommend" describedBy="cd-prior-hint"
            listLabel="Courses you can recommend" items={cands} getText={(c) => c.title || "Untitled course"} selected={chosen}
            loading={!loaded} error={error ? "Couldn't load courses. Check your connection." : ""}
            emptyText="No other courses to recommend yet." noMatchText="No course matches."
            selectedText={(c) => `“${c.title}” is already recommended.`}
            onPick={(c) => set({ courseIds: [...pk.courseIds, c.id] })}
            renderItem={(c) => <><span className="ac-pickname">{c.title || "Untitled course"}</span><span className="ac-cardsub">{categoryIn(tax.categories, c.category)?.label || "No category"}{c.status !== "published" ? " · not published" : ""}</span></>} />
        </div>
      ) : <p className="ac-fieldhint">That's the maximum of 10 recommended courses.</p>}
      <div className="sb-field"><label htmlFor="cd-prior-note">Note for learners (optional)</label>
        <textarea id="cd-prior-note" rows={2} maxLength={300} value={pk.note} onChange={(e) => set({ note: e.target.value })} placeholder="e.g. You should be comfortable navigating Resolve and understanding basic exposure." /></div>
    </section>
  );
}

/* ------------------------------------------------------- lesson / material -- */
/* Required-to-finish + prerequisites, edited in the lesson itself. Only lessons
   EARLIER in the curriculum can be chosen (so no loops are possible). They're
   stored as stable lesson ids, so renaming never changes them; moving lessons
   can put a prerequisite after its lesson — that's flagged here and in the
   outline, with explicit fixes, and blocks Publish. */
export function CompletionAccess({ lid, lesson, ordered, up, onOpenLesson, issues = [], fixes = {} }) {
  const chosen = prerequisitesOf(lesson);
  const byId = new Map(ordered.map((l) => [l.id, l]));
  const pos = new Map(ordered.map((l, i) => [l.id, i + 1]));
  const required = lesson.bonus !== true;
  const earlier = eligiblePrerequisites(ordered, lid);
  const first = earlier.length === 0;
  const mine = issues.filter((i) => i.lessonId === lid);
  // one move fixes every order problem: below the LAST of its prerequisites
  const lastPre = chosen.filter((id) => pos.has(id)).sort((a, b) => pos.get(b) - pos.get(a))[0];
  const firstOrder = mine.findIndex((i) => i.kind === "order");
  const cands = earlier.filter((l) => !chosen.includes(l.id));
  const set = (list) => up({ prerequisites: list });
  const pickId = `ls-pre-search-${lid}`;
  const removePre = (id) => { set(chosen.filter((x) => x !== id)); requestAnimationFrame(() => document.getElementById(pickId)?.focus()); };
  const hintId = `ls-pre-hint-${lid}`;
  const t = (id) => `“${lessonTitle(byId.get(id))}”`;
  return (
    <section className="ac-access" aria-labelledby={`ls-acc-${lid}`}>
      <h3 id={`ls-acc-${lid}`} className="ac-h3" tabIndex={-1}>Completion and access</h3>
      <Toggle label="Required to finish course" v={required} on={() => up({ bonus: required })} describedBy={`ls-req-${lid}`} />
      <p id={`ls-req-${lid}`} className="ac-fieldhint">{required ? "Learners must complete this lesson before they can finish the course. It doesn't lock any other lesson." : "Optional. Learners can skip this lesson, and it never stops anyone finishing the course."}</p>
      <div className="ac-prereqs">
        <span className="ac-fieldlabel" id={`ls-pre-${lid}`}>Prerequisites</span>
        <p id={hintId} className="ac-fieldhint">{first && !chosen.length ? "This is the first lesson. No earlier lessons are available." : <>Choose earlier lessons learners must complete first. All selected lessons must be completed before this one opens.</>}</p>
        {chosen.length === 0
          ? <p className="ac-prereq-none">None. Learners can open this lesson directly.</p>
          : (
            <ul className="ac-prereqchips" aria-labelledby={`ls-pre-${lid}`}>
              {chosen.map((id) => {
                const l = byId.get(id);
                const bad = !l || (pos.get(id) || 0) >= (pos.get(lid) || 0);
                return (
                  <li key={id} className={bad ? "missing" : ""}>
                    {l ? <button type="button" className="ac-chiplink" onClick={() => onOpenLesson && onOpenLesson(id)} title="Open this lesson">{pos.get(id)}. {lessonTitle(l)}{l.bonus === true ? " · optional" : ""}{bad ? " · comes after this lesson" : ""}</button> : <span>Removed lesson</span>}
                    <button type="button" className="ac-chipx" aria-label={`Remove prerequisite ${l ? lessonTitle(l) : "(removed lesson)"}`} onClick={() => removePre(id)}><XMarkIcon className="hi hi-xs" aria-hidden="true" /></button>
                  </li>
                );
              })}
            </ul>
          )}
        {!first && chosen.length < MAX_PREREQUISITES && (
          <div className="sb-field ac-prereqpick">
            <SearchPicker id={pickId} label="Add a prerequisite. Search earlier lessons" placeholder="Search earlier lessons to add a prerequisite" describedBy={hintId}
              listLabel="Earlier lessons you can add" items={cands} getText={(l) => `${pos.get(l.id)}. ${lessonTitle(l)}`}
              selected={chosen.map((id) => byId.get(id)).filter(Boolean)} selectedText={(l) => `“${lessonTitle(l)}” is already a prerequisite.`}
              emptyText="Every earlier lesson is already selected." noMatchText="No earlier lesson matches."
              onPick={(l) => set([...chosen, l.id])}
              renderItem={(l) => <><span className="ac-pickname">{pos.get(l.id)}. {lessonTitle(l)}</span><span className="ac-cardsub">{l.bonus === true ? "Optional" : "Required"}</span></>} />
          </div>
        )}
      </div>
      {mine.map((i, k) => (
        <div key={k} className="ac-prereqissue" role="alert">
          <p>{i.message}</p>
          <div className="ac-actions">
            {i.kind === "order" && k === firstOrder && fixes.moveBelow && lastPre && <button type="button" className="sb-btn ghost compact" onClick={() => fixes.moveBelow(lid, lastPre)}>Move this lesson below {t(lastPre)}</button>}
            {(i.kind === "order" || i.kind === "missing") && <button type="button" className="sb-btn ghost compact" onClick={() => set(chosen.filter((x) => x !== i.prereqId))}>Remove {i.kind === "missing" ? "the missing lesson" : t(i.prereqId)} from prerequisites</button>}
            {i.kind === "optional-prerequisite" && fixes.makeRequired && <button type="button" className="sb-btn ghost compact" onClick={() => fixes.makeRequired(i.prereqId)}>Make {t(i.prereqId)} required</button>}
            {i.kind === "optional-prerequisite" && chosen.includes(i.prereqId) && <button type="button" className="sb-btn ghost compact" onClick={() => set(chosen.filter((x) => x !== i.prereqId))}>Remove {t(i.prereqId)} from prerequisites</button>}
          </div>
        </div>
      ))}
    </section>
  );
}

function LessonPane({ lid, lesson, cid, store, autoTitles, onDelete, ordered = [], onOpenLesson, issues = [], fixes = {} }) {
  const up = (patch) => store.updateLesson(lid, patch);
  const err = usePublishErr(lid);
  const kind = lesson.kind || (lesson.video ? "video" : "written");
  const [url, setUrl] = useState(lesson.video ? (videoFromRecord(lesson.video)?.url || "") : "");
  const parsed = url.trim() ? parseVideoLink(url) : null;
  const meta = lesson.videoMeta;
  const setVideoUrl = (v) => {
    setUrl(v);
    const p = v.trim() ? parseVideoLink(v) : null;
    if (!v.trim()) up({ video: null, videoMeta: null });
    else if (p?.ok && (!lesson.video || lesson.video.id !== p.id || lesson.video.provider !== p.provider)) up({ video: videoRecord(p), videoMeta: null });
  };
  // Use the provider's title only as a SUGGESTION: fill an empty title, or replace
  // a title we auto-filled earlier (never one the author typed).
  const onMeta = useCallback((m) => {
    const cur = store.getModel().lessons[lid] || {};
    const patch = { videoMeta: m };
    const t = (cur.title || "").trim();
    if (m?.title && (!t || t === autoTitles.current[lid])) { patch.title = m.title.slice(0, 120); autoTitles.current[lid] = patch.title; }
    store.updateLesson(lid, patch);
  }, [lid]); // eslint-disable-line react-hooks/exhaustive-deps
  const titleLabel = { video: "Title", written: "Lesson title", resource: "Title", exercise: "Exercise title" }[kind];
  const f = { thumb: lesson.thumb, thumbMode: lesson.thumbMode, videoMeta: lesson.videoMeta };
  return (
    <div className="ac-pane">
      <div className="ac-panehead">
        <span className="ac-pill">{lessonKindMeta({ kind }).label}</span>
        <button type="button" className="sb-btn ghost subtle-danger compact" onClick={onDelete}><TrashIcon className="hi hi-sm" aria-hidden="true" /><span>Remove</span></button>
      </div>
      {kind === "video" && (
        <>
          <Field id={`ls-url-${lid}`} label="Video link" required error={parsed && !parsed.ok ? "" : err("video", `ls-url-${lid}`)} hint="YouTube, Vimeo or Google Drive. The video stays on its own site.">
            <input id={`ls-url-${lid}`} type="url" inputMode="url" value={url} onChange={(e) => setVideoUrl(e.target.value)} placeholder="Paste a video link" autoFocus={!url} />
            {parsed && !parsed.ok && <div className="ac-err" role="alert">{parsed.reason}</div>}
          </Field>
          <VideoPreview parsed={parsed?.ok ? parsed : null} meta={meta} onMeta={onMeta} />
        </>
      )}
      <Field id={`ls-title-${lid}`} label={titleLabel} required error={err("title", `ls-title-${lid}`)} hint={kind === "video" && autoTitles.current[lid] && autoTitles.current[lid] === lesson.title ? "Filled in from the video. You can change it." : ""}>
        <input id={`ls-title-${lid}`} value={lesson.title || ""} onChange={(e) => { autoTitles.current[lid] = null; up({ title: e.target.value }); }} maxLength={120} autoFocus={kind !== "video" && kind !== "resource" && !lesson.title} />
      </Field>
      {kind === "resource" && (
        <LinkList id={`ls-res-${lid}`} autoFocus={!(lesson.resources || []).length} label="Resources to review (optional)" hint="Paste a link; its name and type fill in automatically. Learners mark these as reviewed."
          items={lesson.resources || []} onChange={(v) => { const patch = { resources: v }; if (!(lesson.title || "").trim() && v[0]?.label) patch.title = v[0].label; up(patch); }} emptyText="Paste the first link below." />
      )}
      <RichTextField id={`ls-desc-${lid}`} label={kind === "exercise" ? "Instructions (optional)" : kind === "written" ? "Lesson text (optional)" : kind === "resource" ? "Why these matter (optional)" : "Description (optional)"}
        value={lesson.description} format={lesson.mdVersion || 1} onChange={(v, fmt) => up({ description: v, mdVersion: fmt })} rows={kind === "written" ? 12 : 6} />
      {kind !== "resource" && (
        <LinkList id={`ls-sup-${lid}`} label={kind === "exercise" ? "Supporting resources (optional)" : "Supporting links (optional)"} hint="Reference links shown with this item. Adding one never adds a required step."
          items={lesson.resources || []} onChange={(v) => up({ resources: v })} />
      )}
      {kind === "video" && <ThumbnailChoice f={f} set={(p) => up(p)} parsed={parsed?.ok ? parsed : null} picker={{ kind: "thumb", courseId: cid, lessonId: lid }} ensureTarget={store.ensureSaved}
        uploaded={{ current: { add: () => {} } }} toDelete={{ current: { add: (p) => store.imageReplaced(p) } }} />}
      {kind !== "video" && (
        <Field id={`ls-est-${lid}`} label="Estimated time (minutes, optional)" hint="Reading or working time. It's shown separately from video length.">
          <input id={`ls-est-${lid}`} type="number" min="0" inputMode="numeric" value={lesson.durationMinutes || ""} onChange={(e) => up({ durationMinutes: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
        </Field>
      )}
      <h3 className="ac-h3">Quiz <span className="ac-optional">(optional)</span></h3>
      <QuizEditor idBase={`qz-${lid}`} quiz={lesson.quiz} quizKey={lesson.quizKey} onChange={(quiz, quizKey) => up({ quiz, quizKey })} err={err} />
      <CompletionAccess lid={lid} lesson={lesson} ordered={ordered} up={up} onOpenLesson={onOpenLesson} issues={issues} fixes={fixes} />
      <details className="ac-details"><summary>Additional details</summary>
        <Field id={`ls-kind-${lid}`} label="Content type"><select id={`ls-kind-${lid}`} value={kind} onChange={(e) => up({ kind: e.target.value })}>{LESSON_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></Field>
      </details>
    </div>
  );
}

/* --------------------------------------------------- add multiple videos ---- */
export function BulkVideoDialog({ existing = [], onAdd, onClose, fetcher = fetchVideoMetadata }) {
  const [text, setText] = useState("");
  const [cands, setCands] = useState([]);
  const run = useRef(0);
  const review = async () => {
    const mine = ++run.current;
    const seen = new Set(existing.map(String));
    const list = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 50).map((line, i) => {
      const p = parseVideoLink(line);
      if (!p.ok) return { key: "l" + i, line, status: "invalid", reason: p.reason };
      const k = `${p.provider}:${p.id}`;
      if (seen.has(p.id) || seen.has(k)) return { key: "l" + i, line, status: "duplicate", reason: "Already in this course or listed above." };
      seen.add(p.id);
      return { key: "l" + i, line, status: "valid", parsed: p, meta: null, loading: p.provider !== "gdrive" };
    });
    setCands(list);
    for (const c of list) {
      if (c.status !== "valid" || !c.loading) continue;
      let m = null; try { m = await fetcher(c.parsed); } catch {}
      if (run.current !== mine) return;
      setCands((xs) => xs.map((x) => x.key === c.key ? { ...x, loading: false, meta: m?.available ? { title: m.title, author: m.author, authorUrl: m.authorUrl, thumbnailUrl: m.thumbnailUrl, sourceUrl: m.sourceUrl, fetchedAt: Date.now(), ...(m.durationSec ? { durationSec: m.durationSec } : {}) } : null } : x));
    }
  };
  const valid = cands.filter((c) => c.status === "valid");
  return (
    <SmallDialog title="Add multiple videos" onClose={onClose} actions={<>
      <button type="button" className="sb-btn quiet compact" onClick={onClose}>Cancel</button>
      {cands.length === 0 ? <button type="button" className="sb-btn compact" disabled={!text.trim()} onClick={review}>Review links</button>
        : <button type="button" className="sb-btn compact" disabled={!valid.length} onClick={() => onAdd(valid)}>Add {valid.length} video{valid.length === 1 ? "" : "s"}</button>}</>}>
      {cands.length === 0 ? (
        <Field id="bulk-text" label="Video links, one per line" hint="YouTube, Vimeo or Google Drive. Playlists aren't imported.">
          <textarea id="bulk-text" rows={8} value={text} onChange={(e) => setText(e.target.value)} autoFocus placeholder={"https://youtu.be/…\nhttps://vimeo.com/…"} />
        </Field>
      ) : (
        <>
          <SortableList className="ac-bulklist" items={cands.map((c) => ({ ...c, id: c.key }))} getLabel={(c) => c.meta?.title || c.line} canDrag={(c) => c.status === "valid"}
            onMove={(key, to) => { const ids = moveId(cands.map((c) => c.key), key, to); setCands(ids.map((k) => cands.find((c) => c.key === k))); }}
            renderItem={(c, { handle }) => (
              <div className={"ac-bulkrow " + c.status}>
                <DragHandle handle={handle} />
                <span className="ac-bulkmain"><b>{c.status === "valid" ? (c.meta?.title || (c.loading ? "Looking up…" : "Untitled video")) : c.line}</b>
                  <span className="ac-cardsub">{c.status === "valid" ? `${VIDEO_PROVIDERS[c.parsed.provider].label}${c.meta?.author ? ` · ${c.meta.author}` : ""}` : c.reason}</span></span>
                <button type="button" className="ac-iconbtn" aria-label={`Remove ${c.meta?.title || c.line}`} onClick={() => setCands((xs) => xs.filter((x) => x.key !== c.key))}><TrashIcon className="hi hi-xs" aria-hidden="true" /></button>
              </div>
            )} />
          <button type="button" className="ac-link" onClick={() => setCands([])}>Edit the list</button>
        </>
      )}
    </SmallDialog>
  );
}

/* ============================================================ more page ===== */
function MorePage({ me, users, R }) {
  const admin = isAcademyAdmin(me);
  const [tab, setTab] = useState("guides");
  return (
    <div className="sb-page ac-ws">
      <Crumbs R={R} items={[{ label: "Academy", to: "/learn/manage" }, { label: "Tips & resources, paths & topics" }]} />
      <h1 className="ac-h1">Tips & resources, learning paths & topics</h1>
      <p className="sb-sub">Optional extras alongside the main Categories → Courses → Content structure.</p>
      <div className="sb-seg ac-edtabs" role="group" aria-label="Tool">
        {[["guides", "Tips & resources"], ["paths", "Learning paths"], ...(admin ? [["topics", "Topics"]] : [])].map(([id, l]) => (
          <button key={id} type="button" className={"sb-segbtn" + (tab === id ? " on" : "")} aria-pressed={tab === id} onClick={() => setTab(id)}>{l}</button>))}
      </div>
      {tab === "guides" && <ManageGuides me={me} users={users} />}
      {tab === "paths" && <ManagePaths me={me} users={users} />}
      {tab === "topics" && admin && <ManageTopics me={me} />}
    </div>
  );
}
