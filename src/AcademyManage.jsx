/* IFC Creative Academy — shared authoring pieces (admins + Academy editors).
   v6: the primary authoring flow lives in AcademyWorkspace.jsx (one connected
   full-page workspace). This file keeps the reusable parts — image picker,
   thumbnail choice, topic picker, category select, quick-guide / learning-path
   editors (secondary), topics management and confirmation dialogs.

   Used by: AcademyWorkspace.jsx (primary authoring), the Learn page (intro
   video, guide/path edit buttons) and /learn/manage/more (secondary tools). */
import { trackUpload } from "./academyUploads.js";
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
  mergeCategories, categoryIn, categoryNameIn, categoryShortIn, INTRO_CATEGORY_ID, nameKey, topicNamesFor, matchTopicIds,
  orderedCurriculum, publishBlockers, guidePublishBlockers, pathPublishBlockers, validatePathItems, pathItemKey,
  canEditCourse, canEditContent, isAcademyAdmin, newId, quizMode, toMs, DEFAULT_PASS_MARK, normalizeTopics, normalizeCategory,
  LESSON_KINDS, lessonKind, lessonKindMeta,
} from "./academyProgress.js";
import { parseVideoLink, videoFromRecord, VIDEO_PROVIDERS } from "./academyVideo.js";
import { MARKDOWN_HELP, isSafeHref } from "./academyMarkdown.js";
import { validateImageFile, defaultCrop, cropFromControls, imagePath, processImage, imageDimensions, IMAGE_KINDS } from "./academyImage.js";
import {
  useCourses, useCourse, useLessons, useImageUrl, setCourseStatus, setContentStatus, deleteCourseHard,
  uploadImage, deleteImage, savePurposeVideo,
  useGuides, usePaths, useGuide, usePathDoc, useManyDocs, useGuideDrafts, createPath, updatePath, deletePathHard,
  useCategoryRecords, useTopicRecords, useCategoryIndex, useCategoryArt, createCategory, updateCategory, setCategoryHidden, reorderCategories,
  createDefaultCategories, categoryReferences, createTopic, updateTopic, topicReferences, deleteTopic,
  usePendingCleanup, pathsUsingCourse,
  fetchVideoMetadata,
} from "./academyData.js";
import { CategoryArt, VideoThumb, sourceThumbUrl, isLandscapeRef } from "./academyShared.jsx";
import { VideoPreview } from "./academyVideoPreview.jsx";
import { learnGuidePath, learnPathwayPath, learnManagePath } from "./nav.js";
import { guideRow, pathPickerGuides } from "./academyGuides.js";
import { SearchPicker } from "./academyPicker.jsx";

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

/* "Required to publish": shown on fields Publish checks (publishIssues). Drafts
   always save without them — this never blocks saving. */
export const RequiredTag = () => <span className="ac-req">Required to publish</span>;
/* A labelled field. `required` adds the tag; `error` (shown only once the
   author has touched the field or tried to publish) and `hint` are tied to
   the control with aria-describedby, and the control gets aria-invalid. */
export const Field = ({ id, label, hint, children, required = false, error = "" }) => {
  const hintId = hint ? `${id}-hint` : undefined, errId = error ? `${id}-err` : undefined;
  const desc = [errId, hintId].filter(Boolean).join(" ");
  let wired = false;
  const kids = React.Children.map(children, (c) => {
    if (wired || !React.isValidElement(c) || c.props.id !== id) return c;
    wired = true;
    return React.cloneElement(c, { "aria-describedby": [c.props["aria-describedby"], desc].filter(Boolean).join(" ") || undefined, "aria-invalid": error ? true : c.props["aria-invalid"] });
  });
  return (
    <div className={"sb-field" + (error ? " has-err" : "")}>
      <label htmlFor={id}>{label}{required && <RequiredTag />}</label>
      {kids}
      {error && <div className="ac-fielderr" id={errId}>{error}</div>}
      {hint && <div className="ac-hint" id={hintId}>{hint}</div>}
    </div>
  );
};
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
export function TopicsField({ id, value, onChange, legacy = [], onLegacyChange }) {
  const topics = useTopicRecords();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const me = useMeForTopics();
  const selected = (value || []).map((tid) => topics.byId[tid]).filter(Boolean);
  const all = Object.values(topics.byId);
  const add = (tid) => { setErr(""); onChange([...new Set([...(value || []), tid])]); };
  const create = async (name) => {
    setBusy(true); setErr("");
    try { const tid = await createTopic(me, { name }, topics.byId); add(tid); }
    catch (x) { setErr(x?.message || "Couldn't create the topic."); }
    finally { setBusy(false); }
  };
  const exactOf = (q) => all.find((t) => nameKey(t.name) === nameKey(q));
  return (
    <div className="sb-field">
      <label htmlFor={id}>Topics (optional)</label>
      {(selected.length > 0 || legacy.length > 0) && <div className="ac-topics">
        {selected.map((t) => <span key={t.id} className={"sb-tag ac-topicchip" + (t.hidden ? " hidden" : "")}>{t.name}{t.hidden ? " (hidden)" : ""}<button type="button" aria-label={`Remove topic ${t.name}`} onClick={() => { onChange((value || []).filter((x) => x !== t.id)); requestAnimationFrame(() => document.getElementById(id)?.focus()); }}>×</button></span>)}
        {legacy.map((n) => <span key={"l" + n} className="sb-tag ac-topicchip legacy">{n} <em>(legacy tag)</em>
          {exactOf(n)
            ? <button type="button" onClick={() => { add(exactOf(n).id); onLegacyChange?.(legacy.filter((x) => x !== n)); }}>link</button>
            : <button type="button" disabled={busy} onClick={async () => { await create(n); onLegacyChange?.(legacy.filter((x) => x !== n)); }}>create</button>}
          <button type="button" aria-label={`Remove legacy tag ${n}`} onClick={() => onLegacyChange?.(legacy.filter((x) => x !== n))}>×</button></span>)}
      </div>}
      {/* the shared searchable picker: closes after a pick, on Escape, an outside click or focus leaving */}
      <SearchPicker id={id} label="Topics: search or add a topic" placeholder="Search or add a topic" describedBy={`${id}-hint`} listLabel="Topics"
        items={all.filter((t) => !t.hidden && !(value || []).includes(t.id)).sort((a, b) => a.name.localeCompare(b.name))} getText={(t) => t.name}
        selected={selected} selectedText={(t) => `“${t.name}” is already added.`} loading={!topics.loaded}
        emptyText="No topics yet. Type a name to create one." noMatchText="No topic matches."
        extraItem={(q) => { const name = q.trim(); if (!name || busy) return null; const ex = exactOf(name); return ex ? null : { id: "__create", name: `Create “${name}”`, createName: name }; }}
        onPick={(t) => { if (t.id === "__create") create(t.createName); else add(t.id); }} />
      <div className="ac-hint" id={`${id}-hint`}>Help people find this by subject. Software, platforms and techniques belong here rather than as categories.</div>
      {err && <div className="ac-err" role="alert">{err}</div>}
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

/* All Tips & resources (stored as "guides"), across categories — published,
   draft-only and archived. Editing happens in the full-page workspace. */
export function ManageGuides({ me }) {
  const { guides, loaded, error } = useGuides(me);
  const drafts = useGuideDrafts(me);
  const recs = useCategoryRecords();
  const cats = useMemo(() => mergeCategories(recs.docs), [recs.docs]);
  const [filter, setFilter] = useState("all");
  const navigate = useNavigate();
  const rows = useMemo(() => {
    const byId = new Map();
    for (const g of guides) byId.set(g.id, { live: g, draft: null });
    for (const d of drafts.docs) byId.set(d.id, { ...(byId.get(d.id) || { live: null }), draft: d });
    return [...byId.entries()].map(([id, x]) => guideRow(id, x.live, x.draft)).sort((a, b) => a.title.localeCompare(b.title));
  }, [guides, drafts.docs]);
  const statusOf = (r) => (r.status === "draft-only" || r.status === "unpublished" ? "draft" : r.status === "published-edits" ? "published" : r.status);
  const list = rows.filter((r) => filter === "all" || statusOf(r) === filter);
  return (
    <div>
      <div className="sb-shead">
        <div><h2 className="ac-h2">Tips & resources</h2><p className="sb-sub" style={{ marginBottom: 0 }}>Short, standalone help someone can open in the middle of an assignment, such as a video with notes or a written guide. Each one belongs to a category.</p></div>
        <button type="button" className="sb-btn compact" onClick={() => navigate(learnManagePath({ view: "guide", id: "new" }))}><PlusIcon className="hi hi-sm" aria-hidden="true" />Add tip or resource</button>
      </div>
      <StatusFilter items={rows.map((r) => ({ status: statusOf(r) }))} filter={filter} setFilter={setFilter} />
      {!loaded || !drafts.loaded ? <Skeleton lines={4} />
        : error ? <div className="sb-empty" role="alert">Couldn't load tips & resources.</div>
        : list.length === 0 ? <div className="sb-empty">{rows.length ? "Nothing with that status." : "No tips or resources yet."}</div>
        : (
          <ul className="ac-mlist">
            {list.map((r) => (
              <li key={r.id} className="ac-mrow">
                <div className="ac-mthumb wide"><VideoThumb item={r} /></div>
                <div className="ac-mmain">
                  <div className="ac-mtitle">{r.title} <StatusPill status={statusOf(r)} />{r.changes && <span className="ac-pill accent">Unpublished changes</span>}</div>
                  <div className="ac-cardsub">{categoryShortIn(cats, r.category)} · {r.kind === "video" ? VIDEO_PROVIDERS[r.video?.provider]?.label || "Video" : "Written"}</div>
                </div>
                <div className="ac-mactions">
                  {(r.status === "published" || r.status === "published-edits") && <button type="button" className="sb-btn ghost compact" onClick={() => navigate(learnGuidePath(r.id))}><EyeIcon className="hi hi-sm" aria-hidden="true" />View</button>}
                  <button type="button" className="sb-btn compact" onClick={() => navigate(learnManagePath({ view: "guide", id: r.id }))} aria-label={`Edit ${r.title}`}><PencilSquareIcon className="hi hi-sm" aria-hidden="true" />Edit</button>
                </div>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

export function ManagePaths({ me, users }) {
  const catRecs = useCategoryRecords();
  const cats = useMemo(() => mergeCategories(catRecs.docs), [catRecs.docs]);
  const { paths, loaded, error } = usePaths(me);
  const [filter, setFilter] = useState("all");
  const [editId, setEditId] = useState(null);
  const navigate = useNavigate();
  const list = paths.filter((c) => filter === "all" || c.status === filter);
  return (
    <div>
      <div className="sb-shead">
        <div><h2 className="ac-h2">Learning paths</h2><p className="sb-sub" style={{ marginBottom: 0 }}>An ordered journey through existing courses, lessons and tips & resources, built around a role or goal. Progress made in a path also counts in the original course or resource.</p></div>
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
                  <div className="ac-cardsub">{(p.items || []).length} step{(p.items || []).length === 1 ? "" : "s"}{p.category ? ` · ${categoryShortIn(cats, p.category)}` : ""}{p.updatedAt ? ` · updated ${formatDateTime(toMs(p.updatedAt))}` : ""}</div>
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
          <p className="sb-sub">{refs.length ? <>Used by <b>{refs.length}</b> item{refs.length === 1 ? "" : "s"}. Courses and lessons are never deleted. Only the tag changes.</> : "Nothing uses this topic."}</p>
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
export function ImagePicker({ kind, label, value, courseId, lessonId, guideId, pathId, categoryId, onChange, ensureTarget, compact = false, required = false, optional = false, error = "" }) {
  const spec = IMAGE_KINDS[kind];
  const current = useImageUrl(value);
  const [file, setFile] = useState(null);
  const [src, setSrc] = useState(null);
  const [dims, setDims] = useState(null);
  const [ctl, setCtl] = useState({ scale: 1, cx: 0.5, cy: 0.5 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // one upload attempt at a time: a newer attempt (or Cancel, or a new image)
  // makes an older one's late result irrelevant — it's ignored, never saved
  const attempt = useRef({ n: 0, ctrl: null });
  useEffect(() => () => { attempt.current.ctrl?.abort(); attempt.current.n += 1; }, []);
  const cancelUpload = () => { attempt.current.ctrl?.abort(); attempt.current.n += 1; setBusy(false); setErr("Upload cancelled. Your image is still selected."); };
  const inputId = `ac-img-${kind}-${lessonId || courseId || guideId || pathId || categoryId || "x"}`;
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const pick = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (busy) { attempt.current.ctrl?.abort(); attempt.current.n += 1; setBusy(false); }   // a new image replaces an upload in progress
    setErr("");
    const v = validateImageFile(f);
    if (!v.ok) { setErr(v.reason); return; }
    try {
      const d = await imageDimensions(f);
      if (d.width < 300 || d.height < 300) { setErr("That image is too small. Use one that's at least 600 pixels on its shorter side."); return; }
      setFile(f); setDims(d); setCtl({ scale: 1, cx: 0.5, cy: 0.5 }); setSrc(URL.createObjectURL(f));
    } catch { setErr("Couldn't read that image."); }
  };
  const crop = dims ? cropFromControls(dims.width, dims.height, spec.ratio, ctl) : null;
  const use = () => trackUpload(uploadNow());
  const uploadNow = async () => {
    const my = attempt.current.n + 1; const ctrl = new AbortController();
    attempt.current = { n: my, ctrl };
    const current = () => attempt.current.n === my;
    setBusy(true); setErr("");
    let path = null, uploaded = false;
    try {
      const out = await processImage(file, kind, crop || defaultCrop(dims.width, dims.height, spec.ratio));
      // Storage rules need the owning record to exist — the workspace creates
      // its private draft first, so uploads work before any manual save.
      const target = ensureTarget ? await ensureTarget() : {};
      if (!current()) return;
      path = imagePath(kind, { courseId, lessonId, guideId, pathId, categoryId, ...target });
      const meta = await uploadImage(path, out.blob, out.contentType, { signal: ctrl.signal });
      uploaded = true;
      // an abandoned attempt finishing late must not overwrite a newer choice
      if (!current()) { deleteImage(path).catch(() => {}); return; }
      onChange({ path, version: path.split("/").pop().replace(/\.jpg$/, ""), contentType: out.contentType, bytes: meta.bytes, w: out.width, h: out.height }, value);
      setFile(null); setDims(null); if (src) URL.revokeObjectURL(src); setSrc(null);
    } catch (x) {
      if (!current() || x?.code === "canceled") return;                    // cancelled: cancelUpload already said so
      if (uploaded && path) deleteImage(path).catch(() => {});             // uploaded but couldn't be saved: don't leave a stray file
      // plain words; the chosen (cropped) image stays so "Try again" re-sends it
      const code = `${x?.code || ""} ${x?.message || ""}`;
      setErr(/stalled|timeout/.test(code) ? "The upload stopped responding, so the image wasn't saved. Your image is still selected. Try again."
        : !navigator.onLine || /fetch|network|offline|dynamically imported|retry-limit|storage\/(unknown|retry)/i.test(code) ? "Couldn't upload the image because the connection dropped. Your image is still selected. Try again when you're back online."
        : x?.code === "storage/unauthorized" ? "You don't have permission to upload images here."
        : x?.message || "The upload failed, so the image wasn't saved. Try again.");
    }
    finally { if (current()) setBusy(false); }
  };
  const previewStyle = crop && dims ? {
    aspectRatio: `${spec.width} / ${spec.height}`,
    backgroundImage: `url(${src})`,
    backgroundSize: `${(dims.width / crop.w) * 100}% auto`,
    backgroundPosition: `${(crop.x / Math.max(1, dims.width - crop.w)) * 100}% ${(crop.y / Math.max(1, dims.height - crop.h)) * 100}%`,
  } : null;

  return (
    <div className={"ac-imgpick" + (compact ? " is-compact" : "")}>
      <span className="ac-fieldlabel" id={`${inputId}-label`}>{label}{required && <RequiredTag />}{optional && <span className="ac-optional"> (optional)</span>}</span>
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
            <BusyButton className="sb-btn compact" busy={busy} busyLabel="Uploading…" onClick={use}>{err ? "Try again" : "Use this image"}</BusyButton>
            {busy && <button type="button" className="sb-btn ghost compact" onClick={cancelUpload}>Cancel upload</button>}
            <button type="button" className="sb-btn quiet compact" onClick={() => { attempt.current.ctrl?.abort(); attempt.current.n += 1; setBusy(false); setErr(""); setFile(null); setDims(null); }}>{busy ? "Discard image" : "Cancel"}</button>
          </div>
        </div>
      )}
      <div className="ac-actions">
        <label htmlFor={inputId} id={`${inputId}-btn`} className="sb-btn ghost compact ac-filebtn"><PhotoIcon className="hi hi-sm" aria-hidden="true" /><span>{value ? "Replace image" : "Choose image"}</span></label>
        <input id={inputId} type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} className="sb-vh"
          aria-labelledby={`${inputId}-label ${inputId}-btn`} aria-describedby={error ? `${inputId}-err` : undefined} aria-invalid={error ? true : undefined} />
        {value && !file && <button type="button" className="sb-btn ghost compact" onClick={() => onChange(null, value)}><span>Remove</span></button>}
      </div>
      {/* Size/compression details are implementation detail: kept in the tooltip only. */}
      <div className="ac-hint" title={`Resized to ${spec.width}×${spec.height} and compressed to roughly 100–250 KB.`}>JPEG, PNG or WebP, up to 5 MB.</div>
      {error && !value && !file && <div className="ac-fielderr" id={`${inputId}-err`}>{error}</div>}
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
/* (v6.11) The quick-guide dialog editor was replaced by the full-page Tips &
   resources workspace (AcademyGuideWorkspace.jsx). */

/* ===================================================================
   Learning path editor
   =================================================================== */
export function PathEditor({ me, users, pathId, onClose }) {
  const path = usePathDoc(pathId);
  const { courses } = useCourses(me);
  const { guides: liveGuides } = useGuides(me);
  const guideDrafts = useGuideDrafts(me);   // editors only (rules): never-published resources live here
  const guides = useMemo(() => pathPickerGuides(liveGuides, guideDrafts.docs || []), [liveGuides, guideDrafts.docs]);
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
    const g = guides.find((x) => x.id === it.guideId); return g ? `${g.title}${g.statusLabel ? ` (${g.statusLabel})` : ""}` : "Resource not found / not visible to you";
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
          {f.items.length === 0 && <div className="sb-empty">No steps yet. Add a course, a single lesson, or a tip or resource.</div>}
          <ol className="ac-edlessons ac-edsteps">
            {f.items.map((it, i) => (
              <li key={it.id || i} className="ac-edstep">
                <div className="ac-edlesson">
                  <span className="ac-edidx" aria-hidden="true">{i + 1}</span>
                  <span className="ac-edltitle"><b>{it.type === "course" ? "Course" : it.type === "lesson" ? "Lesson" : "Tip or resource"}</b> <span className="ac-cardsub">{describe(it)}</span></span>
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
            <button type="button" className="sb-btn ghost compact" onClick={() => setPicker({ type: "guide" })}><PlusIcon className="hi hi-sm" aria-hidden="true" />Add tip or resource</button>
          </div>
          {picker && <ItemPicker type={picker.type} courses={courses} guides={guides} onPick={addItem} onClose={() => setPicker(null)} />}
          <p className="ac-note">Steps open the original course, lesson or resource, so progress counts in both places. Unpublished or hidden steps show to learners as unavailable, and a required one stops learners completing the path until it's back.</p>
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
          <p className="ac-note">Editing a path never resets anyone's progress. Completion comes from the courses, lessons and tips & resources it links to.</p>
        </div>
      </div>
      {confirmDel && p && <ConfirmDialog title="Delete this path permanently?" body={`“${p.title}” will be removed. The courses, lessons and tips & resources it points to are untouched.`} confirmLabel="Delete path" onConfirm={async () => { await deletePathHard(effectiveId); onClose(); }} onClose={() => setConfirmDel(false)} />}
    </Sheet>
  );
}

/* Pick a course / lesson / guide the editor can see. */
function ItemPicker({ type, courses, guides, onPick, onClose }) {
  const catRecs = useCategoryRecords();
  const cats = useMemo(() => mergeCategories(catRecs.docs), [catRecs.docs]);
  const [courseId, setCourseId] = useState("");
  const lessons = useLessons(type === "lesson" ? courseId : null, type === "lesson" && !!courseId);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const match = (t) => !needle || String(t || "").toLowerCase().includes(needle);
  return (
    <div className="ac-picker" role="group" aria-label={`Add ${type === "guide" ? "a tip or resource" : `a ${type}`}`}>
      <div className="ac-pickerhead">
        <label className="ac-search"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${type === "guide" ? "tips & resources" : "courses"}`} aria-label="Search" /></label>
        <button type="button" className="sb-btn quiet compact" onClick={onClose}>Cancel</button>
      </div>
      {type === "course" && <ul className="ac-pickerlist">{courses.filter((c) => match(c.title)).map((c) => <li key={c.id}><button type="button" className="ac-pickrow" onClick={() => onPick({ type: "course", courseId: c.id })}>{c.title} <span className="ac-cardsub">{categoryShortIn(cats, c.category)}{c.status !== "published" ? ` · ${c.status}` : ""}</span></button></li>)}</ul>}
      {type === "guide" && <>
        <ul className="ac-pickerlist">{guides.filter((g) => match(g.title)).map((g) => <li key={g.id}><button type="button" className="ac-pickrow" onClick={() => onPick({ type: "guide", guideId: g.id })}>{g.title} <span className="ac-cardsub">{[categoryShortIn(cats, g.category), g.statusLabel].filter(Boolean).join(" · ")}</span></button></li>)}</ul>
        {guides.some((g) => g.status !== "published") && <p className="ac-cardsub">Learners see a step as unavailable until its resource is published.</p>}
      </>}
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
        <label className={"ac-opt" + (mode === "source" ? " on" : "")}><input type="radio" name={`thumbmode-${picker.lessonId || picker.guideId || "x"}`} checked={mode === "source"} onChange={() => set({ thumbMode: "source" })} /><span>Use source thumbnail{hasSource ? "" : " (none available, so a placeholder is shown)"}</span></label>
        <label className={"ac-opt" + (mode === "custom" ? " on" : "")}><input type="radio" name={`thumbmode-${picker.lessonId || picker.guideId || "x"}`} checked={mode === "custom"} disabled={!f.thumb} onChange={() => set({ thumbMode: "custom" })} /><span>Upload custom thumbnail{!f.thumb ? " (upload one below first)" : ""}</span></label>
      </div>
      <div className="ac-thumbprev"><VideoThumb item={previewItem} /></div>
      <ImagePicker kind={picker.kind} label="Custom thumbnail" value={f.thumb} courseId={picker.courseId} lessonId={picker.lessonId} guideId={picker.guideId} ensureTarget={ensureTarget}
        onChange={(ref, old) => { set({ thumb: ref, thumbMode: ref ? "custom" : "source" }); if (ref) uploaded?.current?.add(ref.path); if (old?.path) toDelete?.current?.add(old.path); }} />
      <div className="ac-hint">{picker.guideId ? "Shown on this resource's card and, for a video, before it plays. The embedded player shows its own artwork once playing." : "Controls this lesson's cards and the pre-play image in the app. The embedded provider player shows its own artwork once playing."}</div>
    </div>
  );
}
