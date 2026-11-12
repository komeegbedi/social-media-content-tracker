/* IFC Creative Academy — shared authoring pieces (admins + Academy editors).
   v6: the primary authoring flow lives in AcademyWorkspace.jsx (one connected
   full-page workspace). This file keeps the reusable parts — image picker,
   thumbnail choice, topic picker, category select, quick-guide / learning-path
   editors (secondary), topics management and confirmation dialogs.

   Used by: AcademyWorkspace.jsx (primary authoring), the Learn page (intro
   video, guide/path edit buttons) and /learn/manage/more (secondary tools). */
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  XMarkIcon, PlusIcon, TrashIcon, ChevronUpIcon, ChevronDownIcon, PhotoIcon, CheckCircleIcon,
  ExclamationTriangleIcon, EyeIcon, PencilSquareIcon, Bars3Icon, EyeSlashIcon, ArrowTopRightOnSquareIcon, ArrowPathIcon,
} from "@heroicons/react/24/outline";
import { Portal } from "./overlay.jsx";
import { BusyButton, Skeleton } from "./loading.jsx";
import { Toggle } from "./controls.jsx";
import { ConfirmDialog } from "./App.jsx";
import { learnPath } from "./nav.js";
import { formatDateTime } from "./dateFormat.js";
import {
  ACADEMY_CATEGORIES, ACADEMY_LEVELS, CONTENT_FORMATS, categoryById, categoryLabel, categoryShort, levelLabel,
  mergeCategories, categoryIn, categoryNameIn, INTRO_CATEGORY_ID, nameKey, topicNamesFor, matchTopicIds,
  orderedCurriculum, publishBlockers, guidePublishBlockers, pathPublishBlockers, validatePathItems, pathItemKey,
  canEditCourse, canEditContent, isAcademyAdmin, newId, quizMode, toMs, DEFAULT_PASS_MARK, normalizeTopics, normalizeCategory,
  LESSON_KINDS, lessonKind, lessonKindMeta,
} from "./academyProgress.js";
import { parseVideoLink, videoFromRecord, VIDEO_PROVIDERS } from "./academyVideo.js";
import { MARKDOWN_HELP, isSafeHref } from "./academyMarkdown.js";
import { validateImageFile, defaultCrop, cropFromControls, imagePath, processImage, imageDimensions, IMAGE_KINDS } from "./academyImage.js";
import {
  useCourses, useCourse, useLessons, useImageUrl, createCourse, updateCourse, setCourseStatus, setContentStatus, deleteCourseHard,
  saveLesson, deleteLesson, getQuizKey, uploadImage, deleteImage, savePurposeVideo,
  useGuides, usePaths, useGuide, usePathDoc, useManyDocs, createGuide, updateGuide, deleteGuideHard, createPath, updatePath, deletePathHard,
  useCategoryRecords, useTopicRecords, useCategoryIndex, useCategoryArt, createCategory, updateCategory, setCategoryHidden, reorderCategories,
  createDefaultCategories, categoryReferences, reassignAndDeleteCategory, createTopic, updateTopic, topicReferences, deleteTopic,
  usePendingCleanup, pathsUsingCourse,
  fetchVideoMetadata,
} from "./academyData.js";
import { CategoryArt, VideoThumb, sourceThumbUrl, isLandscapeRef } from "./academyShared.jsx";
import { VideoPreview } from "./academyVideoPreview.jsx";
import { learnGuidePath, learnPathwayPath } from "./nav.js";

export const Sheet = ({ title, onClose, children, wide = false, foot }) => {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
      <div className="sb-scrim" onMouseDown={onClose}>
        <div className={"sb-sheet ac-sheet" + (wide ? " wide" : "")} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
          <div className="hd"><b className="sb-serif" style={{ fontSize: 18 }}>{title}</b>
            <button type="button" className="sb-x" onClick={onClose} aria-label="Close"><XMarkIcon className="hi" aria-hidden="true" /></button></div>
          <div className="bd">{children}</div>
          {foot && <div className="ac-sheetfoot">{foot}</div>}
        </div>
      </div>
    </Portal>
  );
};

export const Field = ({ id, label, hint, children }) => (
  <div className="sb-field">
    <label htmlFor={id}>{label}</label>
    {children}
    {hint && <div className="ac-hint">{hint}</div>}
  </div>
);
const linesToList = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);

/* Category <select> — the six categories from academyProgress.js. A legacy id on
   an older doc is shown normalised (and written back normalised on save). */
/* Category <select> over the editable RECORDS (hidden ones are offered too —
   an editor may file content under a hidden category; learners won't see it). */
export const CategorySelect = ({ id, value, onChange, allowNone = false }) => {
  const recs = useCategoryRecords();
  const list = mergeCategories(recs.docs);
  const v = normalizeCategory(value) || "";
  return (
    <select id={id} value={v} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allowNone ? "No primary category" : "Choose…"}</option>
      {list.map((c) => <option key={c.id} value={c.id}>{c.label}{c.hidden ? " (hidden)" : ""}</option>)}
      {v && !list.some((c) => c.id === v) && <option value={v}>{v} (missing category)</option>}
    </select>
  );
};
/* Topic picker over RECORDS: chips for the selected ids, a search box with
   suggestions (hidden topics excluded from new assignment), and inline create
   (slug id, duplicate names refused). Legacy free-text `topics` on an older doc
   are shown as "(legacy)" chips until they're matched or removed. */
export function TopicsField({ id, value, onChange, legacy = [], onLegacyChange, category }) {
  const topics = useTopicRecords();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const me = useMeForTopics();
  const selected = (value || []).map((tid) => topics.byId[tid]).filter(Boolean);
  const cat = categoryById(category);
  // Compact: matches appear only while typing (no wall of suggestion chips).
  const suggestions = !q.trim() ? [] : Object.values(topics.byId).filter((t) => !t.hidden && !(value || []).includes(t.id) && nameKey(t.name).includes(nameKey(q)))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 6);
  const catSuggest = [];
  const add = (tid) => { onChange([...new Set([...(value || []), tid])]); setQ(""); };
  const create = async (name) => {
    setBusy(true); setErr("");
    try { const tid = await createTopic(me, { name }, topics.byId); add(tid); }
    catch (x) { setErr(x?.message || "Couldn't create the topic."); }
    finally { setBusy(false); }
  };
  const exact = Object.values(topics.byId).find((t) => nameKey(t.name) === nameKey(q));
  return (
    <div className="sb-field">
      <label htmlFor={id}>Topics (optional)</label>
      <div className="ac-topics">
        {selected.map((t) => <span key={t.id} className={"sb-tag ac-topicchip" + (t.hidden ? " hidden" : "")}>{t.name}{t.hidden ? " (hidden)" : ""}<button type="button" aria-label={`Remove topic ${t.name}`} onClick={() => onChange((value || []).filter((x) => x !== t.id))}>×</button></span>)}
        {legacy.map((n) => <span key={"l" + n} className="sb-tag ac-topicchip legacy">{n} <em>(legacy tag)</em>
          {topics.byId && Object.values(topics.byId).some((t) => nameKey(t.name) === nameKey(n))
            ? <button type="button" onClick={() => { const t = Object.values(topics.byId).find((x) => nameKey(x.name) === nameKey(n)); add(t.id); onLegacyChange?.(legacy.filter((x) => x !== n)); }}>link</button>
            : <button type="button" disabled={busy} onClick={async () => { await create(n); onLegacyChange?.(legacy.filter((x) => x !== n)); }}>create</button>}
          <button type="button" aria-label={`Remove legacy tag ${n}`} onClick={() => onLegacyChange?.(legacy.filter((x) => x !== n))}>×</button></span>)}
      </div>
      <input id={id} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search or add a topic" autoComplete="off"
        onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) { e.preventDefault(); exact ? (exact.hidden ? setErr(`“${exact.name}” is hidden — restore it under Topics first.`) : add(exact.id)) : create(q.trim()); } }} />
      <div className="ac-hint">Help people find this by subject. Software, platforms and techniques belong here rather than as categories. Press Enter to add.</div>
      {err && <div className="ac-err" role="alert">{err}</div>}
      {(suggestions.length > 0 || (q.trim() && !exact) || catSuggest.length > 0) && (
        <div className="ac-topicsugg" role="group" aria-label="Topic suggestions">
          {suggestions.map((t) => <button type="button" key={t.id} className="sb-tag ac-tagbtn" onClick={() => add(t.id)}>+ {t.name}</button>)}
          {q.trim() && !exact && <button type="button" className="sb-tag ac-tagbtn create" disabled={busy} onClick={() => create(q.trim())}>Create “{q.trim()}”</button>}
          {!q.trim() && catSuggest.slice(0, 6).map((n) => <button type="button" key={n} className="sb-tag ac-tagbtn" disabled={busy} onClick={() => create(n)}>+ {n}</button>)}
        </div>
      )}
    </div>
  );
}
/* The editors already have `me` in scope; TopicsField is nested deep, so the
   current user is provided through a tiny context set by AcademyManage/editors. */
const MeContext = React.createContext(null);
const useMeForTopics = () => React.useContext(MeContext);
/* Wrap editors opened outside Admin → Academy (e.g. "Edit course" on a course page). */
export const AcademyEditorScope = ({ me, children }) => <MeContext.Provider value={me}>{children}</MeContext.Provider>;
const topicsToText = (list) => (list || []).join(", ");   // legacy free-text tags
export const StatusPill = ({ status }) => <span className={"ac-pill " + (status === "published" ? "ok" : status === "draft" ? "warn" : "")}>{status}</span>;

function StatusFilter({ items, filter, setFilter }) {
  const counts = { draft: 0, published: 0, archived: 0 };
  for (const c of items) counts[c.status] = (counts[c.status] || 0) + 1;
  return (
    <div className="sb-seg" role="group" aria-label="Filter by status">
      {[["all", `All · ${items.length}`], ["published", `Published · ${counts.published}`], ["draft", `Drafts · ${counts.draft}`], ["archived", `Archived · ${counts.archived}`]].map(([id, label]) => (
        <button type="button" key={id} className={"sb-segbtn" + (filter === id ? " on" : "")} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
      ))}
    </div>
  );
}

export function ManageGuides({ me, users }) {
  const { guides, loaded, error } = useGuides(me);
  const [filter, setFilter] = useState("all");
  const [editId, setEditId] = useState(null);   // "new" | id
  const navigate = useNavigate();
  const list = guides.filter((c) => filter === "all" || c.status === filter);
  return (
    <div>
      <div className="sb-shead">
        <div><h2 className="ac-h2">Quick guides</h2><p className="sb-sub" style={{ marginBottom: 0 }}>Short, standalone help someone can open mid-assignment — a video with notes, or a written guide.</p></div>
        <button type="button" className="sb-btn compact" onClick={() => setEditId("new")}><PlusIcon className="hi hi-sm" aria-hidden="true" />New guide</button>
      </div>
      <StatusFilter items={guides} filter={filter} setFilter={setFilter} />
      {!loaded ? <Skeleton lines={4} />
        : error ? <div className="sb-empty" role="alert">Couldn't load guides.</div>
        : list.length === 0 ? <div className="sb-empty">{guides.length ? "No guides with that status." : "No quick guides yet."}</div>
        : (
          <ul className="ac-mlist">
            {list.map((g) => (
              <li key={g.id} className="ac-mrow">
                <div className="ac-mthumb wide"><VideoThumb item={g} /></div>
                <div className="ac-mmain">
                  <div className="ac-mtitle">{g.title || "Untitled guide"} <StatusPill status={g.status} /></div>
                  <div className="ac-cardsub">{categoryLabel(g.category)} · {g.video ? VIDEO_PROVIDERS[g.video.provider]?.label || "video" : "text only"}{g.updatedAt ? ` · updated ${formatDateTime(toMs(g.updatedAt))}` : ""}</div>
                </div>
                <div className="ac-mactions">
                  <button type="button" className="sb-btn ghost compact" onClick={() => navigate(learnGuidePath(g.id))}><EyeIcon className="hi hi-sm" aria-hidden="true" />Preview</button>
                  <button type="button" className="sb-btn compact" onClick={() => setEditId(g.id)}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Edit</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      {editId && <GuideEditor me={me} users={users} guideId={editId === "new" ? null : editId} onClose={() => setEditId(null)} />}
    </div>
  );
}

export function ManagePaths({ me, users }) {
  const { paths, loaded, error } = usePaths(me);
  const [filter, setFilter] = useState("all");
  const [editId, setEditId] = useState(null);
  const navigate = useNavigate();
  const list = paths.filter((c) => filter === "all" || c.status === filter);
  return (
    <div>
      <div className="sb-shead">
        <div><h2 className="ac-h2">Learning paths</h2><p className="sb-sub" style={{ marginBottom: 0 }}>An ordered journey through existing courses, lessons and guides, built around a role or goal. Progress made in a path also counts in the original course or guide.</p></div>
        <button type="button" className="sb-btn compact" onClick={() => setEditId("new")}><PlusIcon className="hi hi-sm" aria-hidden="true" />New path</button>
      </div>
      <StatusFilter items={paths} filter={filter} setFilter={setFilter} />
      {!loaded ? <Skeleton lines={4} />
        : error ? <div className="sb-empty" role="alert">Couldn't load paths.</div>
        : list.length === 0 ? <div className="sb-empty">{paths.length ? "No paths with that status." : "No learning paths yet."}</div>
        : (
          <ul className="ac-mlist">
            {list.map((p) => (
              <li key={p.id} className="ac-mrow">
                <CoverThumb imageRef={p.cover} />
                <div className="ac-mmain">
                  <div className="ac-mtitle">{p.title || "Untitled path"} <StatusPill status={p.status} /></div>
                  <div className="ac-cardsub">{(p.items || []).length} step{(p.items || []).length === 1 ? "" : "s"}{p.category ? ` · ${categoryLabel(p.category)}` : ""}{p.updatedAt ? ` · updated ${formatDateTime(toMs(p.updatedAt))}` : ""}</div>
                </div>
                <div className="ac-mactions">
                  <button type="button" className="sb-btn ghost compact" onClick={() => navigate(learnPathwayPath(p.id))}><EyeIcon className="hi hi-sm" aria-hidden="true" />Preview</button>
                  <button type="button" className="sb-btn compact" onClick={() => setEditId(p.id)}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Edit</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      {editId && <PathEditor me={me} users={users} pathId={editId === "new" ? null : editId} onClose={() => setEditId(null)} />}
    </div>
  );
}

/* Delete flow: shows what references the category and requires a destination
   (or an empty category). Content is moved, never deleted. */
export function DeleteCategoryDialog({ me, cat, others, hidden, onClose }) {
  const [refs, setRefs] = useState(null);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { categoryReferences(cat.id).then(setRefs).catch(() => setRefs({ courses: [], guides: [], paths: [], error: true })); }, [cat.id]);
  const total = refs ? refs.courses.length + refs.guides.length + refs.paths.length : 0;
  const go = async () => {
    setBusy(true); setErr("");
    try { await reassignAndDeleteCategory(me, cat.id, to || null, hidden); onClose(); }
    catch (x) { setErr(x?.message || "Couldn't delete."); setBusy(false); }
  };
  return (
    <Sheet title={`Delete “${cat.label}”`} onClose={onClose}>
      {!refs ? <Skeleton lines={3} /> : (
        <>
          {refs.error && <div className="ac-err" role="alert">Couldn't check what uses this category. Try again.</div>}
          {total === 0
            ? <p className="sb-sub">Nothing references this category. Deleting it removes the record and its cover only.</p>
            : (
              <>
                <p className="sb-sub">This category is used by <b>{refs.courses.length}</b> course{refs.courses.length === 1 ? "" : "s"}, <b>{refs.guides.length}</b> quick guide{refs.guides.length === 1 ? "" : "s"} and <b>{refs.paths.length}</b> learning path{refs.paths.length === 1 ? "" : "s"}. Choose where to move them — nothing is deleted.</p>
                <ul className="ac-plainlist">{[...refs.courses, ...refs.guides, ...refs.paths].slice(0, 12).map((x) => <li key={x.id}>{x.title} <span className="ac-cardsub">({x.status})</span></li>)}{total > 12 && <li className="ac-cardsub">…and {total - 12} more</li>}</ul>
                <Field id="cat-moveto" label="Move everything to">
                  <select id="cat-moveto" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose a category…</option>{others.map((c) => <option key={c.id} value={c.id}>{c.label}{c.hidden ? " (hidden)" : ""}</option>)}</select>
                </Field>
              </>
            )}
          {cat.intro && <p className="ac-note">This is the featured “Start here” category. After deleting it the introduction video stays on the home page; its “More from…” link disappears.</p>}
          {err && <div className="ac-err" role="alert">{err}</div>}
          <div className="ac-actions">
            <BusyButton className="sb-btn danger compact" busy={busy} disabled={total > 0 && !to} onClick={go}>{total ? `Move ${total} item${total === 1 ? "" : "s"} and delete` : "Delete category"}</BusyButton>
            <button type="button" className="sb-btn quiet compact" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/* ===================================================================
   Topics — editable records
   =================================================================== */
export function ManageTopics({ me }) {
  const topics = useTopicRecords();
  const [editing, setEditing] = useState(null);
  const [del, setDel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const list = [...topics.docs].sort((a, b) => (a.hidden === true) - (b.hidden === true) || a.name.localeCompare(b.name));
  const run = async (fn) => { setBusy(true); setErr(""); try { await fn(); } catch (x) { setErr(x?.message || "Something went wrong."); } finally { setBusy(false); } };
  return (
    <div>
      <div className="sb-shead">
        <div><h2 className="ac-h2">Topics</h2><p className="sb-sub" style={{ marginBottom: 0 }}>Tags that help people find courses, guides and paths. Renaming a topic updates it everywhere. Hiding a topic removes it from what learners see without untagging anything, so restoring it brings it straight back.</p></div>
        <button type="button" className="sb-btn compact" onClick={() => setEditing("new")}><PlusIcon className="hi hi-sm" aria-hidden="true" />New topic</button>
      </div>
      {err && <div className="ac-err" role="alert">{err}</div>}
      {!topics.loaded ? <Skeleton lines={3} /> : list.length === 0 ? <div className="sb-empty">No topics yet. Editors can also create topics while tagging content.</div> : (
        <ul className="ac-mlist">
          {list.map((t) => (
            <li key={t.id} className={"ac-mrow ac-topicrow" + (t.hidden ? " is-hidden" : "")}>
              <div className="ac-mmain">
                <div className="ac-mtitle">{t.name}{t.hidden && <span className="ac-pill warn">Hidden</span>}</div>
                {t.description && <div className="ac-cardsub ac-clamp2">{t.description}</div>}
              </div>
              <div className="ac-mactions">
                <button type="button" className="sb-btn ghost compact" onClick={() => setEditing(t)}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Edit</button>
                <BusyButton className="sb-btn quiet compact" busy={busy} onClick={() => run(() => updateTopic(me, t.id, { hidden: !t.hidden }))}>{t.hidden ? "Restore" : "Hide"}</BusyButton>
                <button type="button" className="sb-btn ghost subtle-danger compact" onClick={() => setDel(t)}><TrashIcon className="hi hi-sm" aria-hidden="true" />Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && <TopicEditor me={me} record={editing === "new" ? null : editing} byId={topics.byId} onClose={() => setEditing(null)} />}
      {del && <DeleteTopicDialog me={me} topic={del} others={list.filter((t) => t.id !== del.id && !t.hidden)} onClose={() => setDel(null)} />}
    </div>
  );
}
function TopicEditor({ me, record, byId, onClose }) {
  const [f, setF] = useState({ name: record?.name || "", description: record?.description || "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async (e) => {
    e.preventDefault();
    const dup = Object.values(byId).find((t) => nameKey(t.name) === nameKey(f.name) && t.id !== record?.id);
    if (!f.name.trim()) { setErr("Give the topic a name."); return; }
    if (dup) { setErr(`“${dup.name}” already exists.`); return; }
    setBusy(true); setErr("");
    try { if (record) await updateTopic(me, record.id, { name: f.name.trim(), description: f.description }); else await createTopic(me, f, byId); onClose(); }
    catch (x) { setErr(x?.message || "Couldn't save."); setBusy(false); }
  };
  return (
    <Sheet title={record ? `Edit topic: ${record.name}` : "New topic"} onClose={onClose}>
      <form onSubmit={save}>
        <Field id="tp-name" label="Name" hint={record ? "The new name shows everywhere this topic is used." : ""}><input id="tp-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} autoFocus /></Field>
        <Field id="tp-desc" label="Description (optional)"><textarea id="tp-desc" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={300} /></Field>
        {err && <div className="ac-err" role="alert">{err}</div>}
        <div className="ac-actions"><BusyButton type="submit" className="sb-btn compact" busy={busy}>{record ? "Save" : "Create"}</BusyButton><button type="button" className="sb-btn quiet compact" onClick={onClose}>Cancel</button></div>
      </form>
    </Sheet>
  );
}
function DeleteTopicDialog({ me, topic, others, onClose }) {
  const [refs, setRefs] = useState(null);
  const [mode, setMode] = useState("remove");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { topicReferences(topic).then(setRefs).catch(() => setRefs([])); }, [topic]);
  const go = async () => {
    setBusy(true); setErr("");
    try { await deleteTopic(me, topic, { reassignTo: mode === "reassign" ? to : null }); onClose(); }
    catch (x) { setErr(x?.message || "Couldn't delete."); setBusy(false); }
  };
  return (
    <Sheet title={`Delete topic “${topic.name}”`} onClose={onClose}>
      {!refs ? <Skeleton lines={2} /> : (
        <>
          <p className="sb-sub">{refs.length ? <>Used by <b>{refs.length}</b> item{refs.length === 1 ? "" : "s"}. Courses and lessons are never deleted — only the tag changes.</> : "Nothing uses this topic."}</p>
          {refs.length > 0 && <ul className="ac-plainlist">{refs.slice(0, 10).map((r) => <li key={r.coll + r.id}>{r.title} <span className="ac-cardsub">({r.coll.slice(0, -1)})</span></li>)}{refs.length > 10 && <li className="ac-cardsub">…and {refs.length - 10} more</li>}</ul>}
          {refs.length > 0 && (
            <div className="sb-field" role="radiogroup" aria-label="What happens to the associations">
              <label className="ac-opt"><input type="radio" name="tp-del" checked={mode === "remove"} onChange={() => setMode("remove")} /><span>Remove the topic from these items</span></label>
              <label className="ac-opt"><input type="radio" name="tp-del" checked={mode === "reassign"} onChange={() => setMode("reassign")} /><span>Replace it with another topic</span></label>
              {mode === "reassign" && <select className="sb-select" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Replacement topic"><option value="">Choose a topic…</option>{others.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
            </div>
          )}
          {err && <div className="ac-err" role="alert">{err}</div>}
          <div className="ac-actions">
            <BusyButton className="sb-btn danger compact" busy={busy} disabled={mode === "reassign" && !to} onClick={go}>Delete topic</BusyButton>
            <button type="button" className="sb-btn quiet compact" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

export function CoverThumb({ imageRef, wide = false }) {
  const { url } = useImageUrl(imageRef);
  const cls = "ac-mthumb" + (wide ? " wide" : "");
  return url ? <img className={cls} src={url} alt="" /> : <div className={cls + " ac-img-empty"}><PhotoIcon className="hi" aria-hidden="true" /></div>;
}

/* ===================================================================
   Lesson editor
   =================================================================== */
export const blankQuestion = () => ({ id: newId(), prompt: "", multi: false, options: [{ id: newId(), text: "" }, { id: newId(), text: "" }], correct: [], explanation: "" });

/* ===================================================================
   Image picker: choose → preview + crop → process → upload
   =================================================================== */
export function ImagePicker({ kind, label, value, courseId, lessonId, guideId, pathId, categoryId, onChange, ensureTarget, compact = false }) {
  const spec = IMAGE_KINDS[kind];
  const current = useImageUrl(value);
  const [file, setFile] = useState(null);
  const [src, setSrc] = useState(null);
  const [dims, setDims] = useState(null);
  const [ctl, setCtl] = useState({ scale: 1, cx: 0.5, cy: 0.5 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const inputId = `ac-img-${kind}-${lessonId || courseId || guideId || pathId || categoryId || "x"}`;
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const pick = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    setErr("");
    const v = validateImageFile(f);
    if (!v.ok) { setErr(v.reason); return; }
    try {
      const d = await imageDimensions(f);
      if (d.width < 300 || d.height < 300) { setErr("That image is too small — use at least 600 px on the short side."); return; }
      setFile(f); setDims(d); setCtl({ scale: 1, cx: 0.5, cy: 0.5 }); setSrc(URL.createObjectURL(f));
    } catch { setErr("Couldn't read that image."); }
  };
  const crop = dims ? cropFromControls(dims.width, dims.height, spec.ratio, ctl) : null;
  const use = async () => {
    setBusy(true); setErr("");
    try {
      const out = await processImage(file, kind, crop || defaultCrop(dims.width, dims.height, spec.ratio));
      // Storage rules need the owning record to exist — the workspace creates
      // its private draft first, so uploads work before any manual save.
      const target = ensureTarget ? await ensureTarget() : {};
      const path = imagePath(kind, { courseId, lessonId, guideId, pathId, categoryId, ...target });
      const meta = await uploadImage(path, out.blob, out.contentType);
      onChange({ path, version: path.split("/").pop().replace(/\.jpg$/, ""), contentType: out.contentType, bytes: meta.bytes, w: out.width, h: out.height }, value);
      setFile(null); setDims(null); if (src) URL.revokeObjectURL(src); setSrc(null);
    } catch (x) {
      // Network / chunk-load / storage errors → plain words; keep the chosen image so "Use this image" can be retried.
      const net = !navigator.onLine || /fetch|network|offline|timeout|dynamically imported|retry-limit|storage\/(unknown|retry)/i.test(`${x?.code || ""} ${x?.message || ""}`);
      setErr(net ? "Couldn't upload the image — the connection dropped or is too slow. Your text is safe; press “Use this image” to try again."
        : x?.code === "storage/unauthorized" ? "You don't have permission to upload images here."
        : x?.message || "Upload failed. Check your connection and try again.");
    }
    finally { setBusy(false); }
  };
  const previewStyle = crop && dims ? {
    aspectRatio: `${spec.width} / ${spec.height}`,
    backgroundImage: `url(${src})`,
    backgroundSize: `${(dims.width / crop.w) * 100}% auto`,
    backgroundPosition: `${(crop.x / Math.max(1, dims.width - crop.w)) * 100}% ${(crop.y / Math.max(1, dims.height - crop.h)) * 100}%`,
  } : null;

  return (
    <div className={"ac-imgpick" + (compact ? " is-compact" : "")}>
      <span className="ac-fieldlabel">{label}</span>
      {!file && (
        <div className="ac-imgcur" style={{ aspectRatio: `${spec.width} / ${spec.height}` }}>
          {current.url ? <img src={current.url} alt={`Current ${spec.label.toLowerCase()}`} /> : <div className="ac-img-empty"><PhotoIcon className="hi" aria-hidden="true" /><span>No image yet</span></div>}
        </div>
      )}
      {file && previewStyle && (
        <div className="ac-cropper">
          <div className="ac-croppreview" style={previewStyle} role="img" aria-label="Crop preview" />
          <label className="ac-slider"><span>Zoom</span><input type="range" min="0.2" max="1" step="0.01" value={ctl.scale} onChange={(e) => setCtl({ ...ctl, scale: Number(e.target.value) })} aria-label="Zoom" /></label>
          <label className="ac-slider"><span>Horizontal</span><input type="range" min="0" max="1" step="0.01" value={ctl.cx} onChange={(e) => setCtl({ ...ctl, cx: Number(e.target.value) })} aria-label="Horizontal position" /></label>
          <label className="ac-slider"><span>Vertical</span><input type="range" min="0" max="1" step="0.01" value={ctl.cy} onChange={(e) => setCtl({ ...ctl, cy: Number(e.target.value) })} aria-label="Vertical position" /></label>
          <div className="ac-actions">
            <BusyButton className="sb-btn compact" busy={busy} busyLabel="Uploading…" onClick={use}>Use this image</BusyButton>
            <button type="button" className="sb-btn quiet compact" onClick={() => { setFile(null); setDims(null); }}>Cancel</button>
          </div>
        </div>
      )}
      <div className="ac-actions">
        <label htmlFor={inputId} className="sb-btn ghost compact ac-filebtn"><PhotoIcon className="hi hi-sm" aria-hidden="true" /><span>{value ? "Replace image" : "Choose image"}</span></label>
        <input id={inputId} type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} className="sb-vh" />
        {value && !file && <button type="button" className="sb-btn ghost compact" onClick={() => onChange(null, value)}><span>Remove</span></button>}
      </div>
      {/* Size/compression details are implementation detail: kept in the tooltip only. */}
      <div className="ac-hint" title={`Resized to ${spec.width}×${spec.height} and compressed to roughly 100–250 KB.`}>JPEG, PNG or WebP, up to 5 MB.</div>
      {err && <div className="ac-err" role="alert">{err}</div>}
    </div>
  );
}

/* ===================================================================
   Purpose video (Learn home)
   =================================================================== */
export function PurposeVideoEditor({ me, current, onClose }) {
  const [f, setF] = useState({ title: current?.title || "The Heart Behind the Creative", intro: current?.intro || "", videoUrl: current?.video ? (videoFromRecord(current.video)?.url || "") : "", thumb: current?.thumb || null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const uploaded = useRef(new Set());
  const toDelete = useRef(new Set());
  const parsed = useMemo(() => f.videoUrl.trim() ? parseVideoLink(f.videoUrl) : null, [f.videoUrl]);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const close = async () => { for (const p of uploaded.current) { try { await deleteImage(p); } catch {} } onClose(); };
  const save = async (e) => {
    e.preventDefault();
    if (f.videoUrl.trim() && !parsed?.ok) { setErr(parsed.reason); return; }
    setBusy(true); setErr("");
    try {
      await savePurposeVideo(me, { title: f.title, intro: f.intro, video: parsed?.ok ? parsed : null, thumb: f.thumb });
      for (const p of toDelete.current) { try { await deleteImage(p); } catch {} }
      uploaded.current.clear(); onClose();
    } catch (x) { setErr(x?.message || "Couldn't save."); setBusy(false); }
  };
  return (
    <Sheet title="Purpose video" onClose={close}>
      <form onSubmit={save}>
        <Field id="pv-title" label="Title"><input id="pv-title" value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={120} /></Field>
        <Field id="pv-intro" label="Short intro"><textarea id="pv-intro" rows={3} value={f.intro} onChange={(e) => set({ intro: e.target.value })} maxLength={4000} /></Field>
        <Field id="pv-video" label="Video link" hint="YouTube, Vimeo or Google Drive.">
          <input id="pv-video" type="url" inputMode="url" value={f.videoUrl} onChange={(e) => set({ videoUrl: e.target.value })} />
          {parsed && (parsed.ok ? <div className="ac-ok"><CheckCircleIcon className="hi hi-sm" aria-hidden="true" />{parsed.capabilities.label}</div> : <div className="ac-err" role="alert">{parsed.reason}</div>)}
        </Field>
        <ImagePicker kind="purpose" label="Thumbnail (16:9)" value={f.thumb} onChange={(ref, old) => { set({ thumb: ref }); if (ref) uploaded.current.add(ref.path); if (old?.path) toDelete.current.add(old.path); }} />
        {err && <div className="ac-err" role="alert">{err}</div>}
        <div className="ac-actions"><BusyButton type="submit" className="sb-btn compact" busy={busy}>Save</BusyButton><button type="button" className="sb-btn quiet compact" onClick={close}>Cancel</button></div>
      </form>
    </Sheet>
  );
}

/* ===================================================================
   Quick guide editor
   =================================================================== */
export function GuideEditor({ me, users, guideId, onClose }) {
  const guide = useGuide(guideId);
  const [f, setF] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const uploaded = useRef(new Set());
  const toDelete = useRef(new Set());
  const navigate = useNavigate();
  const admin = isAcademyAdmin(me);
  const isNew = !guideId;
  useEffect(() => {
    if (f) return;
    if (isNew) setF({ title: "", category: "", topicIds: [], legacyTopics: [], videoUrl: "", videoMeta: null, thumbMode: "source", body: "", resources: [{ label: "", url: "" }], thumb: null, durationMinutes: "" });
    else if (guide.data) setF({
      title: guide.data.title || "", category: guide.data.category || "", topicIds: guide.data.topicIds || [], legacyTopics: guide.data.topics || [],
      videoUrl: guide.data.video ? (videoFromRecord(guide.data.video)?.url || "") : "", videoMeta: guide.data.videoMeta || null, thumbMode: guide.data.thumb && (guide.data.thumbMode === "custom" || guide.data.thumbMode == null) ? "custom" : "source", body: guide.data.body || "",
      resources: guide.data.resources?.length ? guide.data.resources : [{ label: "", url: "" }], thumb: guide.data.thumb || null, durationMinutes: guide.data.durationMinutes || "",
    });
  }, [guide.data, f, isNew, me.id]);
  const parsed = useMemo(() => f?.videoUrl?.trim() ? parseVideoLink(f.videoUrl) : null, [f?.videoUrl]);
  const set = (p) => { setF((x) => ({ ...x, ...p })); setDirty(true); };
  const close = async () => { for (const p of uploaded.current) { try { await deleteImage(p); } catch {} } uploaded.current.clear(); onClose(); };
  const payload = () => ({ ...f, topics: f.legacyTopics, video: parsed?.ok ? parsed : null, videoMeta: parsed?.ok && f.videoMeta && f.videoMeta.id === parsed.id ? f.videoMeta : null, resources: f.resources.filter((r) => r.url.trim()) });
  const validate = () => {
    if (!f.title.trim()) return "Add a title.";
    if (!categoryById(f.category)) return "Choose a category.";
    if (f.videoUrl.trim() && !parsed?.ok) return parsed?.reason || "Check the video link.";
    for (const r of f.resources) if (r.url && !isSafeHref(r.url)) return "Resource links must start with https://.";
    return "";
  };
  const save = async () => {
    const v = validate(); if (v) { setErr(v); return null; }
    setBusy(true); setErr("");
    try {
      let id = guideId;
      if (isNew) {
        // A new guide is created as a draft FIRST so its thumbnail can be uploaded
        // under a real id (storage.rules check the guide doc); then edited in place.
        id = await createGuide(me, payload());
      } else await updateGuide(me, id, payload());
      for (const p of toDelete.current) { try { await deleteImage(p); } catch {} }
      toDelete.current.clear(); uploaded.current.clear(); setDirty(false);
      return id;
    } catch (x) { setErr(x?.message || "Couldn't save."); return null; }
    finally { setBusy(false); }
  };
  const [createdId, setCreatedId] = useState(null);
  const effectiveId = guideId || createdId;
  const saveClick = async () => { const id = await save(); if (id && isNew && !createdId) setCreatedId(id); };
  const status = async (next) => {
    const id = dirty || isNew ? await save() : effectiveId;
    if (!id) return;
    setBusy(true); setErr("");
    try { await setContentStatus("guides", me, id, next); if (isNew) setCreatedId(id); } catch (x) { setErr(x?.message || "Couldn't change the status."); }
    finally { setBusy(false); }
  };
  const current = useGuide(createdId);   // after a create, follow the real doc
  const g = guideId ? guide.data : current.data;

  if (!f || (!isNew && !guide.loaded)) return <Sheet title="Quick guide" onClose={onClose} wide><Skeleton lines={6} /></Sheet>;
  if (!isNew && (!guide.data || !canEditContent(me, guide.data))) return <Sheet title="Quick guide" onClose={onClose}><div className="sb-empty">You can't edit this guide.</div></Sheet>;
  const blockers = guidePublishBlockers({ ...f, video: parsed?.ok ? parsed : null });
  const foot = (
    <>
      {g && admin && g.status !== "published" && <button type="button" className="sb-btn ghost subtle-danger compact" onClick={() => setConfirmDel(true)}><TrashIcon className="hi hi-sm" aria-hidden="true" />Delete</button>}
      <span style={{ flex: 1 }} />
      <span className="ac-cardsub">{isNew && !createdId ? "Not saved yet" : dirty ? "Unsaved changes" : "All changes saved"}</span>
      {err && <span className="ac-err" role="alert">{err}</span>}
      <button type="button" className="sb-btn quiet compact" onClick={close}>Close</button>
      <BusyButton className="sb-btn compact" busy={busy} onClick={saveClick} disabled={!dirty && !(isNew && !createdId)}>{isNew && !createdId ? "Save draft" : "Save"}</BusyButton>
    </>
  );
  return (
    <Sheet title={isNew ? "New quick guide" : `Edit: ${g?.title || "guide"}`} onClose={close} wide foot={foot}>
      <div className="ac-edgrid">
        <div>
          <Field id="ge-title" label="Title"><input id="ge-title" value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={120} autoFocus /></Field>
          <Field id="ge-cat" label="Category"><CategorySelect id="ge-cat" value={f.category} onChange={(v) => set({ category: v })} /></Field>
          <TopicsField id="ge-topics" value={f.topicIds} onChange={(v) => set({ topicIds: v })} legacy={f.legacyTopics} onLegacyChange={(v) => set({ legacyTopics: v })} category={f.category} />
          <Field id="ge-video" label="Video link (optional)" hint="YouTube, Vimeo or Google Drive. Leave empty for a text-only guide.">
            <input id="ge-video" type="url" inputMode="url" value={f.videoUrl} onChange={(e) => set({ videoUrl: e.target.value })} placeholder="https://youtu.be/…" />
            {parsed && (parsed.ok ? <div className="ac-ok"><CheckCircleIcon className="hi hi-sm" aria-hidden="true" />{parsed.capabilities.label}</div> : <div className="ac-err" role="alert">{parsed.reason}</div>)}
          </Field>
          <VideoPreview parsed={parsed} meta={f.videoMeta} onMeta={(m) => set({ videoMeta: m })} />
          <Field id="ge-body" label="Guide text" hint={MARKDOWN_HELP}><textarea id="ge-body" rows={10} value={f.body} onChange={(e) => set({ body: e.target.value })} maxLength={20000} /></Field>
        </div>
        <div>
          <div className="sb-field">
            <span className="ac-fieldlabel" id="ge-res-lbl">Resource links</span>
            <div role="group" aria-labelledby="ge-res-lbl">
              {f.resources.map((r, i) => (
                <div key={i} className="ac-resrow">
                  <label htmlFor={`ge-rl-${i}`} className="sb-vh">Resource label</label>
                  <input id={`ge-rl-${i}`} placeholder="Label" value={r.label} onChange={(e) => set({ resources: f.resources.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} />
                  <label htmlFor={`ge-ru-${i}`} className="sb-vh">Resource URL</label>
                  <input id={`ge-ru-${i}`} type="url" inputMode="url" placeholder="https://…" value={r.url} onChange={(e) => set({ resources: f.resources.map((x, j) => j === i ? { ...x, url: e.target.value } : x) })} />
                  <button type="button" className="sb-btn quiet compact" aria-label="Remove resource" onClick={() => set({ resources: f.resources.filter((_, j) => j !== i) })}><XMarkIcon className="hi hi-sm" aria-hidden="true" /></button>
                </div>
              ))}
              <button type="button" className="sb-btn quiet compact" onClick={() => set({ resources: [...f.resources, { label: "", url: "" }] })}><PlusIcon className="hi hi-sm" aria-hidden="true" />Add link</button>
            </div>
          </div>
          <Field id="ge-dur" label="Duration (minutes, optional)"><input id="ge-dur" type="number" min="0" inputMode="numeric" value={f.durationMinutes} onChange={(e) => set({ durationMinutes: e.target.value })} /></Field>
          {effectiveId
            ? <ThumbnailChoice f={f} set={set} parsed={parsed} uploaded={uploaded} toDelete={toDelete} picker={{ kind: "guideThumb", guideId: effectiveId }} />
            : <div className="ac-hint">Save the draft once to add a custom thumbnail.</div>}
          <h3 className="ac-h3">Publish</h3>
          <div className="ac-statusrow"><StatusPill status={g?.status || "draft"} /></div>
          {(g?.status || "draft") !== "published" && (blockers.length
            ? <div className="ac-blockers"><b>Before publishing:</b><ul>{blockers.map((b, i) => <li key={i}><ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" />{b}</li>)}</ul></div>
            : <p className="ac-ok"><CheckCircleIcon className="hi hi-sm" aria-hidden="true" />Ready to publish.</p>)}
          <div className="ac-actions">
            {effectiveId && <button type="button" className="sb-btn ghost compact" onClick={() => { close(); navigate(learnGuidePath(effectiveId)); }}><EyeIcon className="hi hi-sm" aria-hidden="true" />Preview</button>}
            {(g?.status || "draft") !== "published" && <BusyButton className="sb-btn compact" busy={busy} disabled={blockers.length > 0} onClick={() => status("published")}>Publish</BusyButton>}
            {g?.status === "published" && <BusyButton className="sb-btn ghost compact" busy={busy} onClick={() => status("draft")}>Unpublish</BusyButton>}
            {g && g.status !== "archived" && <BusyButton className="sb-btn quiet compact" busy={busy} onClick={() => status("archived")}>Archive</BusyButton>}
            {g?.status === "archived" && <BusyButton className="sb-btn quiet compact" busy={busy} onClick={() => status("draft")}>Restore to draft</BusyButton>}
          </div>
        </div>
      </div>
      {confirmDel && g && <ConfirmDialog title="Delete this guide permanently?" body={`“${g.title}” and its discussion will be removed. Learners' “reviewed” records are kept but no longer shown.`} confirmLabel="Delete guide" onConfirm={async () => { await deleteGuideHard(effectiveId); onClose(); }} onClose={() => setConfirmDel(false)} />}
    </Sheet>
  );
}

/* ===================================================================
   Learning path editor
   =================================================================== */
export function PathEditor({ me, users, pathId, onClose }) {
  const path = usePathDoc(pathId);
  const { courses } = useCourses(me);
  const { guides } = useGuides(me);
  const [f, setF] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [createdId, setCreatedId] = useState(null);
  const [picker, setPicker] = useState(null);   // { type, courseId? }
  const uploaded = useRef(new Set());
  const toDelete = useRef(new Set());
  const navigate = useNavigate();
  const admin = isAcademyAdmin(me);
  const isNew = !pathId;
  const effectiveId = pathId || createdId;
  const current = usePathDoc(createdId);
  const p = pathId ? path.data : current.data;
  useEffect(() => {
    if (f) return;
    if (isNew) setF({ title: "", purpose: "", category: "", topicIds: [], legacyTopics: [], cover: null, items: [] });
    else if (path.data) setF({ title: path.data.title || "", purpose: path.data.purpose || "", category: path.data.category || "", topicIds: path.data.topicIds || [], legacyTopics: path.data.topics || [], cover: path.data.cover || null, items: path.data.items || [] });
  }, [path.data, f, isNew, me.id]);
  // Lesson titles for lesson items (editor can read any referenced course it can see).
  const lessonRefs = useMemo(() => [...new Set((f?.items || []).filter((i) => i.type === "lesson").map((i) => `courses/${i.courseId}/lessons/${i.lessonId}`))].sort(), [f?.items]);
  const lessonDocs = useManyDocs(lessonRefs);
  const set = (patch) => { setF((x) => ({ ...x, ...patch })); setDirty(true); };
  const close = async () => { for (const x of uploaded.current) { try { await deleteImage(x); } catch {} } uploaded.current.clear(); onClose(); };
  const payload = () => ({ ...f, topics: f.legacyTopics });
  const save = async () => {
    if (!f.title.trim()) { setErr("Add a title."); return null; }
    const errs = validatePathItems(f.items); if (errs.length) { setErr(errs[0]); return null; }
    setBusy(true); setErr("");
    try {
      let id = pathId || createdId;
      if (!id) id = await createPath(me, payload()); else await updatePath(me, id, payload());
      for (const x of toDelete.current) { try { await deleteImage(x); } catch {} }
      toDelete.current.clear(); uploaded.current.clear(); setDirty(false);
      if (!pathId && !createdId) setCreatedId(id);
      return id;
    } catch (x) { setErr(x?.message || "Couldn't save."); return null; }
    finally { setBusy(false); }
  };
  const status = async (next) => {
    const id = dirty || !effectiveId ? await save() : effectiveId;
    if (!id) return;
    setBusy(true); setErr("");
    try { await setContentStatus("paths", me, id, next); } catch (x) { setErr(x?.message || "Couldn't change the status."); }
    finally { setBusy(false); }
  };
  const move = (i, d) => { const a = [...f.items]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; set({ items: a }); };
  const setItem = (i, patch) => set({ items: f.items.map((x, j) => j === i ? { ...x, ...patch } : x) });
  const addItem = (it) => {
    const next = [...f.items, { id: newId(), required: true, label: "", ...it }];
    const errs = validatePathItems(next);
    if (errs.length) { setErr(errs[errs.length - 1]); return; }
    setErr(""); set({ items: next }); setPicker(null);
  };

  if (!f || (!isNew && !path.loaded)) return <Sheet title="Learning path" onClose={onClose} wide><Skeleton lines={6} /></Sheet>;
  if (!isNew && (!path.data || !canEditContent(me, path.data))) return <Sheet title="Learning path" onClose={onClose}><div className="sb-empty">You can't edit this path.</div></Sheet>;
  const blockers = pathPublishBlockers(f);
  const itemErrors = validatePathItems(f.items);
  const describe = (it) => {
    if (it.type === "course") { const c = courses.find((x) => x.id === it.courseId); return c ? `${c.title}${c.status !== "published" ? ` (${c.status})` : ""}` : "Course not found / not visible to you"; }
    if (it.type === "lesson") { const c = courses.find((x) => x.id === it.courseId); const l = lessonDocs.byPath[`courses/${it.courseId}/lessons/${it.lessonId}`]; return l ? `${l.title} · ${c?.title || "course"}${c && c.status !== "published" ? ` (${c.status})` : ""}` : lessonDocs.loaded ? "Lesson not found" : "…"; }
    const g = guides.find((x) => x.id === it.guideId); return g ? `${g.title}${g.status !== "published" ? ` (${g.status})` : ""}` : "Guide not found / not visible to you";
  };
  const foot = (
    <>
      {p && admin && p.status !== "published" && <button type="button" className="sb-btn ghost subtle-danger compact" onClick={() => setConfirmDel(true)}><TrashIcon className="hi hi-sm" aria-hidden="true" />Delete</button>}
      <span style={{ flex: 1 }} />
      <span className="ac-cardsub">{!effectiveId ? "Not saved yet" : dirty ? "Unsaved changes" : "All changes saved"}</span>
      {err && <span className="ac-err" role="alert">{err}</span>}
      <button type="button" className="sb-btn quiet compact" onClick={close}>Close</button>
      <BusyButton className="sb-btn compact" busy={busy} onClick={save} disabled={!dirty && !!effectiveId}>{!effectiveId ? "Save draft" : "Save"}</BusyButton>
    </>
  );
  return (
    <Sheet title={isNew ? "New learning path" : `Edit: ${p?.title || "path"}`} onClose={close} wide foot={foot}>
      <div className="ac-edgrid">
        <div>
          <Field id="pe-title" label="Title"><input id="pe-title" value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={120} autoFocus /></Field>
          <Field id="pe-purpose" label="Purpose" hint="Who is this for and what will they be able to do? Shown under the title."><textarea id="pe-purpose" rows={3} value={f.purpose} onChange={(e) => set({ purpose: e.target.value })} maxLength={4000} /></Field>
          <Field id="pe-cat" label="Primary category (optional)"><CategorySelect id="pe-cat" value={f.category} onChange={(v) => set({ category: v })} allowNone /></Field>
          <TopicsField id="pe-topics" value={f.topicIds} onChange={(v) => set({ topicIds: v })} legacy={f.legacyTopics} onLegacyChange={(v) => set({ legacyTopics: v })} category={f.category} />

          <h3 className="ac-h3">Steps</h3>
          {f.items.length === 0 && <div className="sb-empty">No steps yet. Add a course, a single lesson, or a quick guide.</div>}
          <ol className="ac-edlessons ac-edsteps">
            {f.items.map((it, i) => (
              <li key={it.id || i} className="ac-edstep">
                <div className="ac-edlesson">
                  <span className="ac-edidx" aria-hidden="true">{i + 1}</span>
                  <span className="ac-edltitle"><b>{it.type === "course" ? "Course" : it.type === "lesson" ? "Lesson" : "Guide"}</b> <span className="ac-cardsub">{describe(it)}</span></span>
                  <button type="button" className="sb-btn quiet compact" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move step up"><ChevronUpIcon className="hi hi-sm" aria-hidden="true" /></button>
                  <button type="button" className="sb-btn quiet compact" onClick={() => move(i, 1)} disabled={i === f.items.length - 1} aria-label="Move step down"><ChevronDownIcon className="hi hi-sm" aria-hidden="true" /></button>
                  <button type="button" className="sb-btn quiet compact" onClick={() => set({ items: f.items.filter((_, j) => j !== i) })} aria-label="Remove step"><TrashIcon className="hi hi-sm" aria-hidden="true" /></button>
                </div>
                <div className="ac-edsteprow">
                  <label htmlFor={`pe-lbl-${it.id}`} className="sb-vh">Step label</label>
                  <input id={`pe-lbl-${it.id}`} placeholder="Step label shown to learners (optional, e.g. “Plan the message”)" value={it.label || ""} onChange={(e) => setItem(i, { label: e.target.value })} maxLength={120} />
                  <Toggle label="Required" v={it.required !== false} on={() => setItem(i, { required: !(it.required !== false) })} />
                </div>
              </li>
            ))}
          </ol>
          {itemErrors.length > 0 && <div className="ac-err" role="alert">{itemErrors[0]}</div>}
          <div className="ac-actions">
            <button type="button" className="sb-btn ghost compact" onClick={() => setPicker({ type: "course" })}><PlusIcon className="hi hi-sm" aria-hidden="true" />Add course</button>
            <button type="button" className="sb-btn ghost compact" onClick={() => setPicker({ type: "lesson" })}><PlusIcon className="hi hi-sm" aria-hidden="true" />Add lesson</button>
            <button type="button" className="sb-btn ghost compact" onClick={() => setPicker({ type: "guide" })}><PlusIcon className="hi hi-sm" aria-hidden="true" />Add guide</button>
          </div>
          {picker && <ItemPicker type={picker.type} courses={courses} guides={guides} onPick={addItem} onClose={() => setPicker(null)} />}
          <p className="ac-note">Steps open the original course, lesson or guide, so progress counts in both places. Unpublished or hidden steps show to learners as unavailable — and a required one stops the path being completed until it's back.</p>
        </div>
        <div>
          {effectiveId
            ? <ImagePicker kind="pathCover" label="Cover (optional, portrait 3:4)" value={f.cover} pathId={effectiveId}
                onChange={(ref, old) => { set({ cover: ref }); if (ref) uploaded.current.add(ref.path); if (old?.path) toDelete.current.add(old.path); }} />
            : <div className="ac-hint">Save the draft once to add a cover.</div>}
          <h3 className="ac-h3">Publish</h3>
          <div className="ac-statusrow"><StatusPill status={p?.status || "draft"} /></div>
          {(p?.status || "draft") !== "published" && (blockers.length
            ? <div className="ac-blockers"><b>Before publishing:</b><ul>{blockers.map((b, i) => <li key={i}><ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" />{b}</li>)}</ul></div>
            : <p className="ac-ok"><CheckCircleIcon className="hi hi-sm" aria-hidden="true" />Ready to publish.</p>)}
          <div className="ac-actions">
            {effectiveId && <button type="button" className="sb-btn ghost compact" onClick={() => { close(); navigate(learnPathwayPath(effectiveId)); }}><EyeIcon className="hi hi-sm" aria-hidden="true" />Preview</button>}
            {(p?.status || "draft") !== "published" && <BusyButton className="sb-btn compact" busy={busy} disabled={blockers.length > 0} onClick={() => status("published")}>Publish</BusyButton>}
            {p?.status === "published" && <BusyButton className="sb-btn ghost compact" busy={busy} onClick={() => status("draft")}>Unpublish</BusyButton>}
            {p && p.status !== "archived" && <BusyButton className="sb-btn quiet compact" busy={busy} onClick={() => status("archived")}>Archive</BusyButton>}
            {p?.status === "archived" && <BusyButton className="sb-btn quiet compact" busy={busy} onClick={() => status("draft")}>Restore to draft</BusyButton>}
          </div>
          <p className="ac-note">Editing a path never resets anyone's progress — completion is read from the referenced content.</p>
        </div>
      </div>
      {confirmDel && p && <ConfirmDialog title="Delete this path permanently?" body={`“${p.title}” will be removed. The courses, lessons and guides it points to are untouched.`} confirmLabel="Delete path" onConfirm={async () => { await deletePathHard(effectiveId); onClose(); }} onClose={() => setConfirmDel(false)} />}
    </Sheet>
  );
}

/* Pick a course / lesson / guide the editor can see. */
function ItemPicker({ type, courses, guides, onPick, onClose }) {
  const [courseId, setCourseId] = useState("");
  const lessons = useLessons(type === "lesson" ? courseId : null, type === "lesson" && !!courseId);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const match = (t) => !needle || String(t || "").toLowerCase().includes(needle);
  return (
    <div className="ac-picker" role="group" aria-label={`Add ${type}`}>
      <div className="ac-pickerhead">
        <label className="ac-search"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${type === "guide" ? "guides" : "courses"}`} aria-label="Search" /></label>
        <button type="button" className="sb-btn quiet compact" onClick={onClose}>Cancel</button>
      </div>
      {type === "course" && <ul className="ac-pickerlist">{courses.filter((c) => match(c.title)).map((c) => <li key={c.id}><button type="button" className="ac-pickrow" onClick={() => onPick({ type: "course", courseId: c.id })}>{c.title} <span className="ac-cardsub">{categoryShort(c.category)}{c.status !== "published" ? ` · ${c.status}` : ""}</span></button></li>)}</ul>}
      {type === "guide" && <ul className="ac-pickerlist">{guides.filter((g) => match(g.title)).map((g) => <li key={g.id}><button type="button" className="ac-pickrow" onClick={() => onPick({ type: "guide", guideId: g.id })}>{g.title} <span className="ac-cardsub">{categoryShort(g.category)}{g.status !== "published" ? ` · ${g.status}` : ""}</span></button></li>)}</ul>}
      {type === "lesson" && (
        <>
          <label htmlFor="pe-pick-course" className="sb-vh">Course</label>
          <select id="pe-pick-course" className="sb-select" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            <option value="">Choose a course…</option>
            {courses.filter((c) => match(c.title)).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          {courseId && (!lessons.loaded ? <Skeleton lines={2} /> : lessons.docs.length === 0 ? <div className="sb-empty">That course has no lessons.</div>
            : <ul className="ac-pickerlist">{orderedCurriculum(courses.find((c) => c.id === courseId) || {}, lessons.docs).flatMap((m) => m.lessons).map((l) => <li key={l.id}><button type="button" className="ac-pickrow" onClick={() => onPick({ type: "lesson", courseId, lessonId: l.id })}>{l.title}</button></li>)}</ul>)}
        </>
      )}
    </div>
  );
}

/* ===================================================================
   Video preview (provider metadata) + thumbnail choice
   =================================================================== */
/* A) source thumbnail (default when available)  B) custom upload (16:9 crop).
   The custom image is app-owned; the source one is provider-hosted and never
   copied or deleted. The old custom image is only removed after a save. */
export function ThumbnailChoice({ f, set, parsed, uploaded, toDelete, picker, ensureTarget }) {
  const hasSource = !!(parsed?.ok && sourceThumbUrl(parsed, f.videoMeta));
  const mode = f.thumbMode === "custom" && f.thumb ? "custom" : "source";
  const previewItem = { video: parsed?.ok ? parsed : null, videoMeta: f.videoMeta, thumb: f.thumb, thumbMode: mode };
  return (
    <div className="sb-field">
      <span className="ac-fieldlabel">Thumbnail (16:9)</span>
      <div className="ac-thumbchoice" role="radiogroup" aria-label="Thumbnail source">
        <label className={"ac-opt" + (mode === "source" ? " on" : "")}><input type="radio" name={`thumbmode-${picker.lessonId || picker.guideId || "x"}`} checked={mode === "source"} onChange={() => set({ thumbMode: "source" })} /><span>Use source thumbnail{hasSource ? "" : " (none available — a placeholder is shown)"}</span></label>
        <label className={"ac-opt" + (mode === "custom" ? " on" : "")}><input type="radio" name={`thumbmode-${picker.lessonId || picker.guideId || "x"}`} checked={mode === "custom"} disabled={!f.thumb} onChange={() => set({ thumbMode: "custom" })} /><span>Upload custom thumbnail{!f.thumb ? " (upload one below first)" : ""}</span></label>
      </div>
      <div className="ac-thumbprev"><VideoThumb item={previewItem} /></div>
      <ImagePicker kind={picker.kind} label="Custom thumbnail" value={f.thumb} courseId={picker.courseId} lessonId={picker.lessonId} guideId={picker.guideId} ensureTarget={ensureTarget}
        onChange={(ref, old) => { set({ thumb: ref, thumbMode: ref ? "custom" : "source" }); if (ref) uploaded?.current?.add(ref.path); if (old?.path) toDelete?.current?.add(old.path); }} />
      <div className="ac-hint">Controls this lesson's cards and the pre-play image in the app. The embedded provider player shows its own artwork once playing.</div>
    </div>
  );
}
