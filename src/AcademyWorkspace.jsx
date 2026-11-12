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
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRightIcon, ChevronLeftIcon, EyeIcon, PlusIcon, TrashIcon, EllipsisHorizontalIcon, PlayIcon, DocumentTextIcon,
  LinkIcon, PencilSquareIcon, Cog6ToothIcon, ExclamationTriangleIcon, CheckCircleIcon, EyeSlashIcon, ArrowUturnLeftIcon,
  ArchiveBoxIcon, BookOpenIcon, ArrowPathIcon, ArrowsUpDownIcon,
} from "@heroicons/react/24/outline";
import { BusyButton, Skeleton } from "./loading.jsx";
import { useMediaQuery } from "./overlay.jsx";
import { Toggle } from "./controls.jsx";
import { ConfirmDialog } from "./App.jsx";
import { learnManagePath, learnPreviewPath, learnPath, learnCategoryPath } from "./nav.js";
import {
  ACADEMY_LEVELS, LESSON_KINDS, lessonKindMeta, mergeCategories, categoryIn, isAcademyAdmin, isAcademyEditor,
  publishBlockers, flatLessons, orderedCurriculum, toMs, newId, normalizeCategory, DEFAULT_PASS_MARK, quizMode,
} from "./academyProgress.js";
import { parseVideoLink, videoFromRecord, videoRecord, VIDEO_PROVIDERS } from "./academyVideo.js";
import { blankCourse, hasUnpublishedChanges, courseRuntime, formatRuntime, formatClock } from "./academyDrafts.js";
import { moveId, outlineRows, moveLessonInOutline, moveLessonToModule, insertLesson, removeLesson, orderCourses, lessonPosition, moveModule, moduleIndexFromSlot, outlineSpan, outlineCanDrop } from "./academyOrder.js";
import {
  useCategoryRecords, useCategoryIndex, useCategoryArt, useCourses, useCourseDrafts, createCategoryDraft, newCategoryId,
  updateCategory, setCategoryHidden, reorderCategories, setCategoryCourseOrder, createDefaultCategories, deleteImage,
  newCourseId, newLessonId, publishCourseDraft, discardNeverPublishedDraft, deleteCourseHard, setCourseStatus,
  usePendingCleanup, pathsUsingCourse, fetchVideoMetadata,
} from "./academyData.js";
import {
  Field, CategorySelect, TopicsField, ImagePicker, ThumbnailChoice, DeleteCategoryDialog, ManageGuides, ManagePaths,
  ManageTopics, CoverThumb, AcademyEditorScope,
} from "./AcademyManage.jsx";
import { CategoryArt, StoredImage, VideoThumb } from "./academyShared.jsx";
import { VideoPreview } from "./academyVideoPreview.jsx";
import { SortableList, DragHandle } from "./academySortable.jsx";
import { useUndo, useReorder, recordMove, sameData } from "./academyUndo.jsx";
import { AnchoredMenu, MenuButton } from "./academyMenu.jsx";
import { useOnline, requireOnline } from "./useOnline.js";
import {
  useCourseDraft, SaveStatus, RichTextField, LinkList, QuizEditor, AddContentMenu, ContentChoices, SmallDialog, MoveDialog,
} from "./academyWorkspaceParts.jsx";

/* ---------------------------------------------------------------- shared ---- */
function Crumbs({ items, R }) {
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
function useTaxonomy() {
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
      return { id: x.id, title: (x.draft ? x.draft.title : x.live.title) || "Untitled course", category: normalizeCategory((x.draft ? x.draft.category : x.live.category) || ""),
        liveCategory: x.live ? normalizeCategory(x.live.category || "") : "", cover: src.cover, status: st, changes: !!x.draft && x.live?.status === "published" && hasUnpublishedChanges(x.draft),
        lessons: (src.modules || []).reduce((n, m) => n + (m.lessonIds || []).length, 0), createdAtMs: toMs(src.createdAt),
        // learner order uses the PUBLISHED level/date, so mirror that here
        level: (x.live || src).level, publishedAtMs: x.live ? toMs(x.live.publishedAt) : 0 };
    });
    return { list, loaded: loaded && drafts.loaded };
  }, [courses, loaded, drafts.docs, drafts.loaded]);
}
function CourseStatus({ c }) {
  return <>
    {c.status === "published" && <span className="ac-pill ok">Published</span>}
    {c.status === "draft" && <span className="ac-pill warn">Draft</span>}
    {c.status === "archived" && <span className="ac-pill">Hidden (archived)</span>}
    {c.changes && <span className="ac-pill accent">Unpublished changes</span>}
  </>;
}

/* Ordering status for lists whose order is LIVE (categories, courses in a
   category): it applies immediately, so say so — and say when it didn't. */
function OrderNote({ order, what }) {
  const st = order.state;
  const online = useOnline();
  if (st.phase === "saving" && !online) return <span className="ac-ordernote warn" role="status"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />Offline — the new order is waiting to sync. Learners still see the old order until you reconnect; keep this tab open.</span>;
  if (st.phase === "saving") return <span className="ac-ordernote" role="status"><ArrowPathIcon className="hi hi-xs ac-spin" aria-hidden="true" />Saving order…</span>;
  if (st.phase === "error") return (
    <span className="ac-ordernote err" role="alert"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />Couldn't save the new order{st.message ? ` (${st.message})` : ""}. The list shows the saved order.
      <button type="button" className="ac-link" onClick={() => order.retry().catch(() => {})}>Try again</button></span>
  );
  return <span className="ac-ordernote">Drag <span aria-hidden="true">≡</span> to reorder {what}. Learners see the new order straight away.</span>;
}

/* ================================================================ router ==== */
export default function AcademyWorkspace({ me, users, nav, R }) {
  if (!isAcademyEditor(me)) return <div className="sb-page"><div className="sb-empty">The Academy workspace is for Academy editors.</div></div>;
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
  const kindNow = ws.view === "category" ? "cat" : ws.view === "course" ? "course" : null;
  if (kindNow) {
    if (ws.id === "new" && prev.current[kindNow] && prev.current[kindNow] !== "new") gen.current[kindNow] = (gen.current[kindNow] || 0) + 1;
    prev.current[kindNow] = ws.id;
  }
  const keyFor = (kind, id, extra = "") => (id === "new" ? `${kind}:new:${extra}:${gen.current[kind] || 0}` : born.current[`${kind}:${id}`] || `${kind}:${id}`);
  const adopt = (kind, from) => (realId) => { born.current[`${kind}:${realId}`] = from; };
  const catKey = ws.view === "category" ? keyFor("cat", ws.id) : "";
  const courseKey = ws.view === "course" ? keyFor("course", ws.id, ws.category) : "";
  return (
    <AcademyEditorScope me={me}>
      {ws.view === "home" && <WorkspaceHome me={me} R={R} />}
      {ws.view === "more" && <MorePage me={me} users={users} R={R} />}
      {ws.view === "category" && <CategoryWorkspace key={catKey} me={me} id={ws.id} R={R} onCreated={adopt("cat", catKey)} />}
      {ws.view === "course" && <CourseWorkspace key={courseKey} me={me} id={ws.id} categoryParam={ws.category} item={ws.item} R={R} onCreated={adopt("course", courseKey)} />}
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
        <button type="button" className="ac-link" onClick={() => R.navigate(learnManagePath({ view: "more" }))}><BookOpenIcon className="hi hi-sm" aria-hidden="true" />Quick guides, learning paths & topics</button>
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
      .then(() => { onCreated?.(newId); setId(newId); R.replace(learnManagePath({ view: "category", id: newId })); return newId; })
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
  const set = (patch) => { setF((x) => ({ ...x, ...patch })); setSave({ state: "pending" }); clearTimeout(timer.current); timer.current = setTimeout(() => persist(), 700); };
  useEffect(() => () => clearTimeout(timer.current), []);

  const courses = useMemo(() => orderCourses(allCourses.filter((c) => c.category === id || c.liveCategory === id), rec?.courseOrder || []), [allCourses, id, rec?.courseOrder]);
  const observedOrder = useMemo(() => courses.map((c) => c.id), [courses]);
  const observedRef = useRef(observedOrder); observedRef.current = observedOrder;
  const order = useReorder(observedOrder, (ids) => setCategoryCourseOrder(me, id, ids));
  const shown = order.shown.map((x) => courses.find((c) => c.id === x)).filter(Boolean);
  const onMoveCourse = (cid, slot) => {
    const before = shown.map((c) => c.id);
    recordMove({ before, after: moveId(before, cid, slot), label: shown.find((c) => c.id === cid)?.title, save: order.save, current: () => observedRef.current, undo });
  };
  const addCourse = async () => {
    try { const cid = id || await ensure(); R.navigate(learnManagePath({ view: "course", category: cid })); }
    catch (e) { setSave({ state: "error", message: e?.message || "Couldn't create the category." }); }
  };

  if (routeId !== "new" && tax.loaded && !rec && !cat) return <div className="sb-page"><Crumbs R={R} items={[{ label: "Academy", to: "/learn/manage" }, { label: "Not found" }]} /><div className="sb-empty">This category doesn't exist any more.</div></div>;
  if (!f || (routeId !== "new" && !tax.loaded)) return <div className="sb-page"><Skeleton lines={6} /></div>;
  const hidden = id ? (rec?.hidden === true || tax.hidden.includes(id)) : true;
  const label = (f.name || "").trim() || (routeId === "new" ? "New category" : cat?.label || "Category");
  return (
    <div className="sb-page ac-ws">
      <Crumbs R={R} items={[{ label: "Academy", to: "/learn/manage" }, { label }]} />
      <div className="ac-wshead">
        <div className="ac-wstitle">
          {admin && <h1 className="ac-h1 ac-wsh1">{label}</h1>}
          <span className={"ac-pill " + (hidden ? "warn" : "ok")}>{hidden ? (id ? "Hidden from learners" : "New — private until you make it visible") : "Visible to learners"}</span>
          {admin && <span className="ac-wssave"><CatSaveStatus save={save} onRetry={persist} live={!hidden} /></span>}
        </div>
        {admin && id && (
          <div className="ac-actions">
            {hidden ? <button type="button" className="sb-btn compact" onClick={() => setConfirm("restore")}><EyeIcon className="hi hi-sm" aria-hidden="true" /><span>Make visible</span></button>
              : <button type="button" className="sb-btn ghost compact" onClick={() => setConfirm("hide")}><EyeSlashIcon className="hi hi-sm" aria-hidden="true" /><span>Hide</span></button>}
            {!hidden && <button type="button" className="sb-btn ghost compact" onClick={() => R.navigate(learnCategoryPath(id))}><EyeIcon className="hi hi-sm" aria-hidden="true" /><span>View as learner</span></button>}
            <button type="button" className="sb-btn ghost subtle-danger compact" onClick={() => setConfirm("delete")}><TrashIcon className="hi hi-sm" aria-hidden="true" /><span>Delete</span></button>
          </div>
        )}
      </div>
      <div className="ac-catws">
        <div className="ac-catwsform">
          {admin ? (
            <>
              <Field id="cw-name" label="Category name"><input id="cw-name" value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} placeholder="e.g. Lighting" autoFocus={routeId === "new"} /></Field>
              <Field id="cw-desc" label="Short description" hint="Shown under the category on the Learn page."><textarea id="cw-desc" rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={300} /></Field>
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
            <ImagePicker kind="catCover" label="Cover (3:4)" compact value={rec?.cover || null} categoryId={id || undefined}
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
      {undo.node}
      {confirm === "hide" && <ConfirmDialog title={`Hide “${label}”?`} tone="warning" danger={false} confirmLabel="Hide category"
        body="Learners will no longer see this category or anything in it, including published courses. Each course keeps its own state, so making the category visible again restores what was published."
        onConfirm={() => { requireOnline(); return setCategoryHidden(me, id, true, tax.hidden); }} onClose={() => setConfirm(null)} />}
      {confirm === "restore" && <ConfirmDialog title={`Make “${label}” visible?`} tone="neutral" danger={false} confirmLabel="Make visible"
        body="The category appears on the Learn page. Only its published courses become visible; drafts stay private."
        onConfirm={() => { requireOnline(); return setCategoryHidden(me, id, false, tax.hidden); }} onClose={() => setConfirm(null)} />}
      {confirm === "delete" && <DeleteCategoryDialog me={me} cat={{ ...(cat || {}), id, label }} others={tax.categories.filter((c) => c.id !== id)} hidden={tax.hidden} onClose={() => { setConfirm(null); }} />}
    </div>
  );
}
function CatSaveStatus({ save, onRetry, live }) {
  const online = useOnline();
  if (save.state === "pending") return <span className="ac-savestate muted">Unsaved changes…</span>;
  if ((save.state === "saving" || save.state === "pending") && !online) return <span className="ac-savestate warn" role="status"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />Offline — waiting to sync. Not saved yet; keep this tab open until you reconnect.</span>;
  if (save.state === "saving") return <span className="ac-savestate muted" role="status"><ArrowPathIcon className="hi hi-xs ac-spin" aria-hidden="true" />Saving…</span>;
  if (save.state === "saved") return <span className="ac-savestate ok" role="status"><CheckCircleIcon className="hi hi-xs" aria-hidden="true" />{live ? "Saved — learners see this now" : "Saved"}</span>;
  if (save.state === "error") return <span className="ac-savestate err" role="alert"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />Couldn't save{save.message ? ` — ${save.message}` : ""}. Your text is still here. <button type="button" className="ac-link" onClick={onRetry}>Retry</button></span>;
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
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener("resize", schedule); port?.removeEventListener("scroll", schedule); };
  }, [rootRef, barRef, ready]);   // re-run once the workspace has rendered (not the loading skeleton)
}

function CourseWorkspace({ me, id: routeIdProp, categoryParam, item, R, onCreated }) {
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
  const undo = useUndo();
  const online = useOnline();
  const [dialog, setDialog] = useState(null);             // { kind: "move"|"movesection"|"bulk"|"keepmine", ... }
  const [publish, setPublish] = useState({ state: "idle" });
  const outlineScroll = useRef(0);
  const autoTitles = useRef({});                          // lesson id → last auto-filled title
  const rootRef = useRef(null), barRef = useRef(null);
  useStickyMetrics(rootRef, barRef, status === "ready");

  const select = (next) => {
    if (narrow) { const el = document.querySelector(".sb-content"); if (el) outlineScroll.current = el.scrollTop; }
    R.navigate(learnManagePath({ view: "course", id: model?.draftExists || routeId !== "new" ? cid : "new", item: next, category: routeId === "new" && !model?.draftExists ? categoryParam : "" }));
  };
  // Mobile: returning to the outline restores where the author was.
  useEffect(() => { if (narrow && !item) { const el = document.querySelector(".sb-content"); if (el) requestAnimationFrame(() => { el.scrollTop = outlineScroll.current; }); } }, [item, narrow]);

  if (status === "loading") return <div className="sb-page"><Skeleton lines={8} /></div>;
  if (status === "missing") return <div className="sb-page"><Crumbs R={R} items={[{ label: "Academy", to: "/learn/manage" }, { label: "Not found" }]} /><div className="sb-empty">This course doesn't exist any more.</div></div>;
  if (status === "error") return <div className="sb-page"><div className="sb-empty" role="alert">{save.message || "Couldn't load this course."} <button type="button" className="ac-link" onClick={store.reloadFromServer}>Try again</button></div></div>;

  const { course, lessons, head, liveCourse } = model;
  const modules = course.modules && course.modules.length ? course.modules : [{ id: "m1", title: "", lessonIds: [] }];
  const showHeaders = modules.length > 1;
  const rows = outlineRows(modules, { showHeaders }).map((r) => ({ ...r, lesson: r.type === "lesson" ? lessons[r.id] : null })).filter((r) => r.type === "module" || r.lesson);
  const cat = categoryIn(tax.categories, course.category);
  const liveStatus = !liveCourse ? "never" : liveCourse.status;
  const changes = model.draftExists && liveCourse?.status === "published" && head.rev > head.publishedRev;
  const ordered = flatLessons({ modules }, Object.entries(lessons).map(([id, l]) => ({ id, ...l })));
  const runtime = courseRuntime(ordered);
  const blockers = publishBlockers(course, ordered, tax.bootstrap ? null : tax.records.map((r) => r.id));
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
  const removeLessonNow = (lid) => {
    const before = modules, lesson = lessons[lid];
    const after = removeLesson(modules, lid);
    store.deleteLesson(lid, after);
    if (item === lid) select("details");
    undo.offer({
      message: `Removed “${lessonTitle(lesson)}”.`, doneMessage: `Restored “${lessonTitle(lesson)}”.`,
      undo: async () => {
        if (store.getModel()?.lessons?.[lid] || !sameData(currentModules(), after)) throw Object.assign(new Error("The outline changed after this removal, so it can't be undone safely."), { code: "stale" });
        store.addLesson(lid, lesson, before);
      },
    });
  };
  const removeSection = (moduleId) => {
    const i = modules.findIndex((m) => m.id === moduleId); if (i < 0) return;
    const moved = modules[i].lessonIds || [];
    const rest = modules.filter((_, k) => k !== i).map((m) => ({ ...m, lessonIds: [...(m.lessonIds || [])] }));
    let after;
    if (!rest.length) after = [{ id: "m1", title: "", lessonIds: moved }];
    else { const t = Math.max(0, i - 1); after = rest.map((m, k) => (k === t ? { ...m, lessonIds: [...m.lessonIds, ...moved] } : m)); }
    changeOutline(after, modules[i].title || "Section", `Removed section “${modules[i].title || "Untitled section"}”${moved.length ? ` (its ${moved.length} item${moved.length === 1 ? "" : "s"} moved to the previous section)` : ""}.`);
  };
  const doPublish = async () => {
    setPublish({ state: "busy" });
    try {
      requireOnline();
      const rev = await store.settle({ force: true });
      const res = await store.runPublish(() => publishCourseDraft(me, cid, rev));
      setPublish({ state: "done", first: res.firstPublish, leftovers: res.leftovers });
      await store.refreshLive();
    } catch (e) {
      if (e?.code === "conflict") store.reloadFromServer();
      setPublish({ state: "error", message: e?.code === "conflict" ? "Someone else changed this course just now — the latest version has been loaded. Check it, then publish again." : e?.message || "Couldn't publish.", blockers: e?.blockers });
    }
  };
  const openPreview = async () => {
    try { await store.settle(); R.navigate(learnPreviewPath(cid)); }
    catch (e) { setPublish({ state: "error", message: e?.message }); }
  };
  const idleText = model.draftExists ? (changes ? "Draft saved · not yet published" : "Draft saved") : liveCourse ? "No unpublished changes" : "Not saved yet — start typing";

  const header = (
    <header className="ac-wsbar" ref={barRef}>
      <Crumbs R={R} items={[{ label: "Academy", to: "/learn/manage" }, cat ? { label: cat.label, to: learnManagePath({ view: "category", id: cat.id }) } : { label: "No category" }, { label: (course.title || "").trim() || "New course", to: narrow && item ? learnManagePath({ view: "course", id: cid }) : null }]} />
      <div className="ac-wsbarrow">
        <div className="ac-wsbartitle">
          <h1 className="ac-wscoursename">{(course.title || "").trim() || "New course"}</h1>
          <span className="ac-wspills">
            {liveStatus === "published" ? <span className="ac-pill ok">Published</span> : liveStatus === "archived" ? <span className="ac-pill">Hidden (archived)</span> : <span className="ac-pill warn">Not published</span>}
            {changes && <span className="ac-pill accent">Unpublished changes</span>}
          </span>
          <SaveStatus save={save} onRetry={store.flushNow} onReload={store.reloadFromServer} onOverwrite={() => setDialog({ kind: "keepmine" })} idleText={idleText} />
        </div>
        <div className="ac-actions ac-wsbaractions">
          <button type="button" className="sb-btn ghost compact" disabled={!online || (!model.draftExists && !liveCourse)} title={!online ? "Preview needs a connection" : undefined} onClick={openPreview}><EyeIcon className="hi hi-sm" aria-hidden="true" /><span>Preview</span></button>
          <BusyButton className="sb-btn compact" busy={publish.state === "busy"} busyLabel="Publishing…"
            disabled={!online || save.state === "conflict" || save.state === "offline" || (liveStatus === "published" && !changes && !busySaving) || (liveStatus === "never" && !model.draftExists && !busySaving)}
            title={!online || save.state === "offline" ? "Publishing needs a connection" : undefined}
            onClick={doPublish}>{liveStatus === "published" ? "Publish changes" : "Publish"}</BusyButton>
          <CourseMenu me={me} admin={admin} cid={cid} model={model} liveStatus={liveStatus} R={R} onDone={() => store.reloadFromServer()} />
        </div>
      </div>
      {!online && <div className="ac-blockers ac-wsnote" role="status"><b>You're offline.</b> Edits are kept in this tab and save when you reconnect. Publishing and preview need a connection.</div>}
      {publish.state === "done" && <div className="ac-ok ac-wsnote" role="status"><CheckCircleIcon className="hi hi-sm" aria-hidden="true" /><span>{publish.first ? "Published — learners can now see this course." : "Changes published — learners now see this version."}</span><button type="button" className="ac-link" onClick={() => setPublish({ state: "idle" })}>Dismiss</button></div>}
      {publish.state === "error" && (
        <div className="ac-blockers ac-wsnote" role="alert"><b>Not published.</b> {publish.blockers ? "Before publishing:" : publish.message}
          {publish.blockers && <ul>{publish.blockers.map((b, i) => <li key={i}><ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" />{b}</li>)}</ul>}
          <button type="button" className="ac-link" onClick={() => setPublish({ state: "idle" })}>Dismiss</button></div>
      )}
    </header>
  );

  const outline = (
    <aside className="ac-outline" aria-label="Course outline">
      <div className="ac-outscroll">
        <button type="button" className={"ac-outrow ac-outdetails" + (!selected ? " on" : "")} aria-current={!selected ? "true" : undefined} onClick={() => select("details")}>
          <Cog6ToothIcon className="hi hi-sm" aria-hidden="true" /><span>Course details</span>
          {blockers.some((b) => /title|category|level|cover/i.test(b)) && <ExclamationTriangleIcon className="hi hi-xs ac-warnicon" aria-label="Needs attention" />}
        </button>
        <div className="ac-outmeta ac-cardsub">
          {ordered.length} item{ordered.length === 1 ? "" : "s"}
          {runtime.measured > 0 && <> · {runtime.partial ? "at least " : ""}{formatRuntime(runtime.videoSec)} of video</>}
        </div>
        {rows.length === 0 && <p className="ac-cardsub ac-outempty">No content yet — add a video or material to start.</p>}
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
                  <OutlineSub lesson={r.lesson} />
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

  const editor = (
    <main className="ac-wseditor" aria-label={selected ? `Edit ${lessonTitle(selected)}` : "Course details"}>
      {narrow && <button type="button" className="ac-back" onClick={() => R.navigate(learnManagePath({ view: "course", id: cid }))}><ChevronLeftIcon className="hi hi-sm" aria-hidden="true" />Course outline</button>}
      {selected
        ? <LessonPane key={item} lid={item} lesson={selected} cid={cid} store={store} autoTitles={autoTitles} onDelete={() => removeLessonNow(item)} />
        : <CourseDetailsPane course={course} cid={cid} store={store} tax={tax} me={me} />}
    </main>
  );

  return (
    <div className="sb-page ac-ws ac-coursews" ref={rootRef}>
      {header}
      {narrow ? (item ? editor : outline) : <div className="ac-wsgrid">{outline}{editor}</div>}
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
      {dialog?.kind === "keepmine" && <ConfirmDialog title="Replace their changes with yours?" tone="warning" danger={false} confirmLabel="Replace with my version"
        body="Someone else saved this course while you were editing. Keeping your version overwrites the changes they made since you opened it. To keep both, load their version and redo your edits instead."
        onConfirm={async () => { await store.overwriteRemote(); }} onClose={() => setDialog(null)} />}
    </div>
  );
}

function OutlineSub({ lesson }) {
  const bits = [];
  if (lesson.video) { if (lesson.videoMeta?.isLive) bits.push("Live"); else if (lesson.videoMeta?.durationSec) bits.push(formatClock(lesson.videoMeta.durationSec)); }
  else if (lesson.durationMinutes > 0) bits.push(`~${lesson.durationMinutes} min`);
  if (lesson.bonus) bits.push("Bonus · optional");
  return <span className="ac-outsub"><span className="sb-vh">{lessonKindMeta(lesson).label}{bits.length ? ", " : ""}</span>{bits.join(" · ")}</span>;
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

function CourseMenu({ me, admin, cid, model, liveStatus, R, onDone }) {
  const [confirm, setConfirm] = useState(null);
  const online = useOnline();
  const [paths, setPaths] = useState(null);
  useEffect(() => { if (confirm === "delete") pathsUsingCourse(cid).then(setPaths).catch(() => setPaths([])); }, [confirm, cid]);
  const lessons = Object.keys(model.lessons).length;
  const pick = (close, what) => () => { close({ refocus: true }); setConfirm(what); };
  return (
    <>
      <MenuButton label="More course actions" align="end" renderTrigger={({ ref, toggle, props }) => (
        <button ref={ref} type="button" className="sb-btn ghost compact ac-iconsq" onClick={toggle} aria-label="More course actions" {...props}><EllipsisHorizontalIcon className="hi hi-sm" aria-hidden="true" /></button>
      )}>
        {(close) => <>
          {liveStatus !== "never" && liveStatus !== "draft" && <button type="button" role="menuitem" className="ac-menuitem" onClick={() => { close(); R.navigate(learnPath(cid)); }}><EyeIcon className="hi hi-sm" aria-hidden="true" /><span><b>View published version</b></span></button>}
          {liveStatus === "published" && <button type="button" role="menuitem" className="ac-menuitem" onClick={pick(close, "unpublish")}><EyeSlashIcon className="hi hi-sm" aria-hidden="true" /><span><b>Unpublish…</b><span className="ac-cardsub">Learners stop seeing it; progress is kept</span></span></button>}
          {liveStatus === "published" && <button type="button" role="menuitem" className="ac-menuitem" onClick={pick(close, "archive")}><ArchiveBoxIcon className="hi hi-sm" aria-hidden="true" /><span><b>Hide (archive)…</b></span></button>}
          {liveStatus === "archived" && <button type="button" role="menuitem" className="ac-menuitem" disabled={!online} onClick={async () => { close({ refocus: true }); await setCourseStatus(me, cid, "draft"); onDone(); }}><ArrowUturnLeftIcon className="hi hi-sm" aria-hidden="true" /><span><b>Restore to draft</b><span className="ac-cardsub">{online ? "Still hidden from learners until you publish" : "Needs a connection"}</span></span></button>}
          {liveStatus === "never" && model.draftExists && <button type="button" role="menuitem" className="ac-menuitem danger" onClick={pick(close, "discard")}><TrashIcon className="hi hi-sm" aria-hidden="true" /><span><b>Discard this draft…</b><span className="ac-cardsub">It was never published</span></span></button>}
          {admin && liveStatus !== "published" && liveStatus !== "never" && <button type="button" role="menuitem" className="ac-menuitem danger" onClick={pick(close, "delete")}><TrashIcon className="hi hi-sm" aria-hidden="true" /><span><b>Delete permanently…</b></span></button>}
          {liveStatus === "never" && !model.draftExists && <div className="ac-menuhead">Nothing to manage yet — this course hasn't been saved.</div>}
        </>}
      </MenuButton>
      {confirm === "unpublish" && <ConfirmDialog title="Unpublish this course?" tone="warning" danger={false} confirmLabel="Unpublish" body="Learners stop seeing it straight away. Their progress is kept, and you can publish again any time." onConfirm={async () => { requireOnline(); await setCourseStatus(me, cid, "draft"); onDone(); }} onClose={() => setConfirm(null)} />}
      {confirm === "archive" && <ConfirmDialog title="Hide (archive) this course?" tone="warning" danger={false} confirmLabel="Hide course" body="Learners stop seeing it; progress is kept. Restore it to a draft later to publish again." onConfirm={async () => { requireOnline(); await setCourseStatus(me, cid, "archived"); onDone(); }} onClose={() => setConfirm(null)} />}
      {confirm === "discard" && <ConfirmDialog title="Discard this draft?" confirmLabel="Discard draft" body="This course was never published, so no learner has seen it. Its draft content and uploaded images are deleted." onConfirm={async () => { requireOnline(); await discardNeverPublishedDraft(cid); R.navigate("/learn/manage"); }} onClose={() => setConfirm(null)} />}
      {confirm === "delete" && <ConfirmDialog title="Delete this course permanently?" confirmLabel="Delete course" busyLabel="Deleting…" body={`“${model.course.title}” and its ${lessons} item${lessons === 1 ? "" : "s"} will be removed. This can't be undone.`}
        consequences={["Quizzes, discussions, the draft and images uploaded here are deleted. Videos stay on YouTube, Vimeo or Drive.", "Everyone's progress and quiz results for this course are deleted.",
          paths == null ? "Checking learning paths…" : paths.length ? `${paths.length} learning path${paths.length === 1 ? " uses" : "s use"} it (${paths.map((p) => `“${p.title}”`).join(", ")}); ${paths.length === 1 ? "its step" : "their steps"} will show as unavailable until updated.` : "No learning paths use this course."]}
        onConfirm={async () => { requireOnline(); await deleteCourseHard(me, cid); R.navigate("/learn/manage"); }} onClose={() => setConfirm(null)} />}
    </>
  );
}

/* ------------------------------------------------------- course details ---- */
function CourseDetailsPane({ course, cid, store, tax, me }) {
  const up = store.updateCourse;
  const [previewUrl, setPreviewUrl] = useState(course.previewVideo ? (videoFromRecord(course.previewVideo)?.url || "") : "");
  const pv = previewUrl.trim() ? parseVideoLink(previewUrl) : null;
  return (
    <div className="ac-pane">
      <h2 className="ac-h2">Course details</h2>
      <div className="ac-edgrid">
        <div>
          <Field id="cd-title" label="Title"><input id="cd-title" value={course.title || ""} onChange={(e) => up({ title: e.target.value })} maxLength={120} placeholder="e.g. Lighting Fundamentals" autoFocus={!course.title} /></Field>
          <RichTextField id="cd-about" label="About this course" value={course.about} format={course.mdVersion || 1} onChange={(v, fmt) => up({ about: v, mdVersion: fmt })} rows={6} placeholder="What will people learn, and who is it for?" />
          <div className="ac-row2">
            <div className="sb-field"><label htmlFor="cd-cat">Category</label><CategorySelect id="cd-cat" value={course.category} onChange={(v) => up({ category: v })} /><div className="ac-hint">Moving a published course takes effect when you publish.</div></div>
            <Field id="cd-level" label="Level"><select id="cd-level" value={course.level || "beginner"} onChange={(e) => up({ level: e.target.value })}>{ACADEMY_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select></Field>
          </div>
          <Field id="cd-out" label="What learners will be able to do (optional)" hint="One per line."><textarea id="cd-out" rows={3} value={(course.outcomes || []).join("\n")} onChange={(e) => up({ outcomes: e.target.value.split("\n") })} /></Field>
          <details className="ac-details"><summary>Additional details</summary>
            <Field id="cd-req" label="Before starting (optional)" hint="One per line — gear, accounts, other courses."><textarea id="cd-req" rows={3} value={(course.requirements || []).join("\n")} onChange={(e) => up({ requirements: e.target.value.split("\n") })} /></Field>
            <Field id="cd-prev" label="Preview / trailer video (optional)" hint="Shown on the course page. The first lesson is never used as a trailer automatically.">
              <input id="cd-prev" type="url" inputMode="url" value={previewUrl} placeholder="https://youtu.be/…" onChange={(e) => { setPreviewUrl(e.target.value); const p = e.target.value.trim() ? parseVideoLink(e.target.value) : null; if (!e.target.value.trim()) up({ previewVideo: null }); else if (p?.ok) up({ previewVideo: videoRecord(p) }); }} />
              {pv && !pv.ok && <div className="ac-err" role="alert">{pv.reason}</div>}
            </Field>
            <TopicsField id="cd-topics" value={course.topicIds || []} onChange={(v) => up({ topicIds: v })} legacy={course.topics || []} onLegacyChange={(v) => up({ topics: v })} category={course.category} />
          </details>
        </div>
        <div>
          <ImagePicker kind="cover" label="Cover (3:4)" compact value={course.cover} courseId={cid} ensureTarget={store.ensureSaved}
            onChange={(ref, old) => { up({ cover: ref }); if (old?.path) store.imageReplaced(old.path); }} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- lesson / material -- */
function LessonPane({ lid, lesson, cid, store, autoTitles, onDelete }) {
  const up = (patch) => store.updateLesson(lid, patch);
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
          <Field id={`ls-url-${lid}`} label="Video link" hint="YouTube, Vimeo or Google Drive. The video stays on its own site.">
            <input id={`ls-url-${lid}`} type="url" inputMode="url" value={url} onChange={(e) => setVideoUrl(e.target.value)} placeholder="Paste a video link" autoFocus={!url} />
            {parsed && !parsed.ok && <div className="ac-err" role="alert">{parsed.reason}</div>}
          </Field>
          <VideoPreview parsed={parsed?.ok ? parsed : null} meta={meta} onMeta={onMeta} />
        </>
      )}
      <Field id={`ls-title-${lid}`} label={titleLabel} hint={kind === "video" && autoTitles.current[lid] && autoTitles.current[lid] === lesson.title ? "Filled in from the video — edit it freely." : ""}>
        <input id={`ls-title-${lid}`} value={lesson.title || ""} onChange={(e) => { autoTitles.current[lid] = null; up({ title: e.target.value }); }} maxLength={120} autoFocus={kind !== "video" && kind !== "resource" && !lesson.title} />
      </Field>
      {kind === "resource" && (
        <LinkList id={`ls-res-${lid}`} autoFocus={!(lesson.resources || []).length} label="Resources to review" hint="Paste a link; its name and type fill in automatically. Learners mark these as reviewed."
          items={lesson.resources || []} onChange={(v) => { const patch = { resources: v }; if (!(lesson.title || "").trim() && v[0]?.label) patch.title = v[0].label; up(patch); }} emptyText="Paste the first link below." />
      )}
      <RichTextField id={`ls-desc-${lid}`} label={kind === "exercise" ? "Instructions" : kind === "written" ? "Lesson text" : kind === "resource" ? "Why these matter (optional)" : "Description (optional)"}
        value={lesson.description} format={lesson.mdVersion || 1} onChange={(v, fmt) => up({ description: v, mdVersion: fmt })} rows={kind === "written" ? 12 : 6} />
      {kind !== "resource" && (
        <LinkList id={`ls-sup-${lid}`} label={kind === "exercise" ? "Supporting resources (optional)" : "Supporting links (optional)"} hint="Reference links shown with this item. Adding one never adds a required step."
          items={lesson.resources || []} onChange={(v) => up({ resources: v })} />
      )}
      {kind === "video" && <ThumbnailChoice f={f} set={(p) => up(p)} parsed={parsed?.ok ? parsed : null} picker={{ kind: "thumb", courseId: cid, lessonId: lid }} ensureTarget={store.ensureSaved}
        uploaded={{ current: { add: () => {} } }} toDelete={{ current: { add: (p) => store.imageReplaced(p) } }} />}
      {kind !== "video" && (
        <Field id={`ls-est-${lid}`} label="Estimated time (minutes, optional)" hint="Reading or working time — shown separately from measured video time.">
          <input id={`ls-est-${lid}`} type="number" min="0" inputMode="numeric" value={lesson.durationMinutes || ""} onChange={(e) => up({ durationMinutes: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
        </Field>
      )}
      <h3 className="ac-h3">Quiz</h3>
      <QuizEditor idBase={`qz-${lid}`} quiz={lesson.quiz} quizKey={lesson.quizKey} onChange={(quiz, quizKey) => up({ quiz, quizKey })} />
      <details className="ac-details"><summary>Additional details</summary>
        <Toggle label="Bonus — doesn't count toward course progress" v={lesson.bonus === true} on={() => up({ bonus: !lesson.bonus })} />
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
        <Field id="bulk-text" label="Video links — one per line" hint="YouTube, Vimeo or Google Drive. Playlists aren't imported.">
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
      <Crumbs R={R} items={[{ label: "Academy", to: "/learn/manage" }, { label: "Quick guides, paths & topics" }]} />
      <h1 className="ac-h1">Quick guides, learning paths & topics</h1>
      <p className="sb-sub">Optional extras alongside the main Categories → Courses → Content structure.</p>
      <div className="sb-seg ac-edtabs" role="group" aria-label="Tool">
        {[["guides", "Quick guides"], ["paths", "Learning paths"], ...(admin ? [["topics", "Topics"]] : [])].map(([id, l]) => (
          <button key={id} type="button" className={"sb-segbtn" + (tab === id ? " on" : "")} aria-pressed={tab === id} onClick={() => setTab(id)}>{l}</button>))}
      </div>
      {tab === "guides" && <ManageGuides me={me} users={users} />}
      {tab === "paths" && <ManagePaths me={me} users={users} />}
      {tab === "topics" && admin && <ManageTopics me={me} />}
    </div>
  );
}
