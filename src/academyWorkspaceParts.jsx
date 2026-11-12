/* IFC Creative Academy — building blocks for the authoring workspace:
   the course draft store (autosave + conflict detection), save status, the
   formatted text field, link cards, quiz editor, Add content menu, and the
   "Move to position" dialog. Kept apart from AcademyWorkspace.jsx so each
   piece stays small and testable. */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  PlusIcon, TrashIcon, XMarkIcon, LinkIcon, PlayIcon, DocumentTextIcon, ClipboardDocumentCheckIcon, PencilSquareIcon,
  ArrowTopRightOnSquareIcon, LockClosedIcon, QueueListIcon, CheckCircleIcon, ExclamationTriangleIcon, ArrowPathIcon,
} from "@heroicons/react/24/outline";
import { Toggle } from "./controls.jsx";
import { BusyButton } from "./loading.jsx";
import { Portal } from "./overlay.jsx";
import { Markdown } from "./academyShared.jsx";
import { MenuButton } from "./academyMenu.jsx";
import { isSafeHref, MARKDOWN_HELP, MARKDOWN_HELP_V2, MD_LEGACY, MD_CURRENT } from "./academyMarkdown.js";
import { markdownToHtml, htmlToMarkdown, canEditVisually } from "./academyRichText.js";
import { newId, DEFAULT_PASS_MARK } from "./academyProgress.js";
import { isMeaningfulCourse } from "./academyDrafts.js";
import { isOnline, isOfflineError } from "./useOnline.js";
import { normalizeLinkInput, isValidResourceUrl, newLink, applyLinkMeta, sourceLabel } from "./academyLinks.js";
import { loadCourseWorkspace, saveCourseDraft, cleanupDraftImages, fetchLinkMetadata, useDraftHead } from "./academyData.js";

/* =====================================================================
   Course draft store
   ===================================================================== */
const SAVE_DELAY = 800;
/* useCourseDraft(cid, me, { blank }) → {
     status: "loading" | "ready" | "missing" | "error",
     model: { course, lessons, head:{rev,publishedRev}, draftExists, liveCourse, liveLessons },
     save: { state: "idle"|"pending"|"saving"|"saved"|"error"|"conflict", message },
     updateCourse, updateLesson, addLesson, deleteLesson, setModules, imageReplaced,
     flushNow, ensureSaved, reloadFromServer, overwriteRemote, setLive }
   Nothing is written until the course is meaningful (title, cover, text or a
   lesson) — opening a blank "new course" screen creates no record. */
export function useCourseDraft(cid, me, { blank = null, onFirstSave } = {}) {
  const [status, setStatus] = useState("loading");
  const [model, setModel] = useState(null);
  const [save, setSave] = useState({ state: "idle", message: "" });
  const m = useRef(null);                                   // latest model (for async flush)
  const dirty = useRef({ course: false, lessons: new Set(), deleted: new Set(), writeAll: false });
  const images = useRef(new Set());                         // replaced uploads awaiting clean-up
  const timer = useRef(0);
  const saving = useRef(false);
  const again = useRef(false);
  const remoteRev = useRef(0);
  const onFirst = useRef(onFirstSave); onFirst.current = onFirstSave;
  const meRef = useRef(me); meRef.current = me;

  const commit = (next) => { m.current = next; setModel(next); };
  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const r = await loadCourseWorkspace(cid);
      if (!r.course && !blank) { setStatus("missing"); return; }
      const course = r.course || blank;
      commit({ course, lessons: r.lessons || {}, head: r.head, draftExists: r.draftExists, liveCourse: r.liveCourse, liveLessons: r.liveLessons });
      dirty.current = { course: false, lessons: new Set(), deleted: new Set(), writeAll: !r.draftExists };
      setSave({ state: "idle", message: "" });
      setStatus("ready");
    } catch (e) { setStatus("error"); setSave({ state: "error", message: e?.message || "Couldn't load this course." }); }
  }, [cid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); return () => clearTimeout(timer.current); }, [load]);

  const flush = useCallback(async ({ force = false } = {}) => {
    clearTimeout(timer.current);
    const cur = m.current; if (!cur) return null;
    const d = dirty.current;
    const anyDirty = d.course || d.lessons.size || d.deleted.size || (d.writeAll && cur.draftExists === false && force);
    if (!anyDirty && cur.draftExists) { setSave((s) => (s.state === "pending" ? { state: "saved", message: "" } : s)); return cur.head.rev; }
    if (!cur.draftExists && !force && !isMeaningfulCourse(cur.course, cur.lessons)) { setSave({ state: "idle", message: "" }); return null; }
    if (saving.current) { again.current = true; return null; }
    saving.current = true;
    const snap = { course: d.course, lessons: new Set(d.lessons), deleted: new Set(d.deleted), writeAll: d.writeAll || !cur.draftExists };
    dirty.current = { course: false, lessons: new Set(), deleted: new Set(), writeAll: false };
    setSave({ state: "saving", message: "" });
    try {
      const rev = await saveCourseDraft(meRef.current, cid, { course: cur.course, lessons: cur.lessons, dirtyLessonIds: [...snap.lessons], deletedLessonIds: [...snap.deleted], baseRev: cur.head.rev, writeAll: snap.writeAll });
      const wasNew = !cur.draftExists;
      const after = { ...m.current, head: { ...m.current.head, rev }, draftExists: true };
      commit(after);
      saving.current = false;
      const stillDirty = dirty.current.course || dirty.current.lessons.size || dirty.current.deleted.size;
      setSave({ state: stillDirty ? "pending" : "saved", message: "" });
      if (wasNew && onFirst.current) onFirst.current();
      if (images.current.size) { const cands = [...images.current]; images.current.clear(); cleanupDraftImages(cid, cands, after).catch(() => {}); }
      if (remoteRev.current > rev) setSave({ state: "conflict", message: "Someone else saved changes to this course while you were editing." });
      if (again.current || stillDirty) { again.current = false; timer.current = setTimeout(() => flush(), 150); }
      return rev;
    } catch (e) {
      saving.current = false;
      // put the unsaved work back — nothing typed is ever lost
      dirty.current.course = dirty.current.course || snap.course;
      snap.lessons.forEach((x) => dirty.current.lessons.add(x));
      snap.deleted.forEach((x) => dirty.current.deleted.add(x));
      dirty.current.writeAll = dirty.current.writeAll || snap.writeAll;
      if (e?.code === "conflict") setSave({ state: "conflict", message: e.message });
      // Draft saves are transactions, which can't be queued offline: say so, keep
      // the edits, and save automatically when the connection comes back.
      else if (isOfflineError(e)) setSave({ state: "offline", message: "" });
      else setSave({ state: "error", message: e?.code === "permission-denied" ? "You don't have permission to save this course." : (e?.message || "Couldn't save.") });
      return null;
    }
  }, [cid]);   // stable: `me` is read through a ref, so a new profile object never re-creates flush
  const schedule = () => { setSave((s) => (s.state === "conflict" || (s.state === "offline" && !isOnline()) ? s : { state: "pending", message: "" })); clearTimeout(timer.current); timer.current = setTimeout(() => { if (isOnline()) flush(); else setSave((s) => (s.state === "conflict" ? s : { state: "offline", message: "" })); }, SAVE_DELAY); };

  // Another editor/tab saved this draft → stop and ask (never silently overwrite).
  const head = useDraftHead(cid, status === "ready");
  useEffect(() => {
    const r = Number(head.data?.rev || 0);
    remoteRev.current = r;
    if (!m.current || saving.current) return;
    if (r > Number(m.current.head.rev || 0)) setSave({ state: "conflict", message: "Someone else saved changes to this course while you were editing." });
  }, [head.data?.rev]);

  // Leaving with unsaved work: try a last save, and ask the browser to warn.
  useEffect(() => {
    const h = (e) => { if (["pending", "saving", "error", "conflict", "offline"].includes(save.state)) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [save.state]);
  // Offline: retry when the browser reports it's back, and every 20 s meanwhile
  // (navigator.onLine can be wrong in both directions).
  useEffect(() => {
    if (save.state !== "offline") return undefined;
    const retry = () => { if (isOnline()) flush(); };
    window.addEventListener("online", retry);
    const t = setInterval(retry, 20000);
    return () => { window.removeEventListener("online", retry); clearInterval(t); };
  }, [save.state, flush]);
  // Leaving the screen with unsaved work: one last save attempt — on UNMOUNT only
  // (not whenever flush's dependencies change, which could loop while failing).
  const flushRef = useRef(flush); flushRef.current = flush;
  useEffect(() => () => { if (dirty.current.course || dirty.current.lessons.size || dirty.current.deleted.size) flushRef.current(); }, []);

  const api = useMemo(() => ({
    updateCourse: (patch) => { commit({ ...m.current, course: { ...m.current.course, ...patch } }); dirty.current.course = true; schedule(); },
    updateLesson: (id, patch) => { commit({ ...m.current, lessons: { ...m.current.lessons, [id]: { ...m.current.lessons[id], ...patch } } }); dirty.current.lessons.add(id); dirty.current.course = true; schedule(); },
    addLesson: (id, lesson, modules) => { commit({ ...m.current, course: { ...m.current.course, modules }, lessons: { ...m.current.lessons, [id]: { createdAtMs: Date.now(), ...lesson } } }); dirty.current.lessons.add(id); dirty.current.deleted.delete(id); dirty.current.course = true; schedule(); },
    deleteLesson: (id, modules) => { const lessons = { ...m.current.lessons }; const gone = lessons[id]; delete lessons[id]; commit({ ...m.current, course: { ...m.current.course, modules }, lessons }); dirty.current.lessons.delete(id); dirty.current.deleted.add(id); dirty.current.course = true; if (gone?.thumb?.path) images.current.add(gone.thumb.path); schedule(); },
    setModules: (modules) => { commit({ ...m.current, course: { ...m.current.course, modules } }); dirty.current.course = true; schedule(); },
    imageReplaced: (path) => { if (path) images.current.add(path); },
    flushNow: () => flush(),
    getModel: () => m.current,
    /* Wait for in-flight saves, then save everything still dirty. Resolves to
       the saved rev, or throws with the reason (used before Publish/Preview). */
    settle: async ({ force = false } = {}) => {
      for (let i = 0; i < 100 && saving.current; i++) await new Promise((r) => setTimeout(r, 100));
      const isDirty = () => dirty.current.course || dirty.current.lessons.size || dirty.current.deleted.size;
      for (let i = 0; i < 3 && (isDirty() || (force && !m.current.draftExists)); i++) {
        const r = await flush({ force });
        if (r == null && !saving.current) break;
        for (let j = 0; j < 100 && saving.current; j++) await new Promise((res) => setTimeout(res, 100));
      }
      if (isDirty() || (force && !m.current.draftExists)) throw new Error("Your latest changes haven't saved yet. Fix the save problem shown at the top, then try again.");
      return m.current.head.rev;
    },
    /* Re-read only the published side + head after a publish (no skeleton flash). */
    refreshLive: async () => {
      const r = await loadCourseWorkspace(cid);
      commit({ ...m.current, head: { ...m.current.head, ...r.head }, liveCourse: r.liveCourse, liveLessons: r.liveLessons, draftExists: r.draftExists || m.current.draftExists });
    },
    ensureSaved: async () => { if (!m.current.draftExists) await flush({ force: true }); if (!m.current.draftExists) throw new Error("Couldn't create the draft yet — check your connection and try again."); return { courseId: cid }; },
    reloadFromServer: () => load(),
    overwriteRemote: async () => { const r = Number(head.data?.rev || 0); commit({ ...m.current, head: { ...m.current.head, rev: r } }); dirty.current.writeAll = true; dirty.current.course = true; setSave({ state: "pending", message: "" }); await flush(); },
    afterPublish: (rev, liveCourse, liveLessons) => commit({ ...m.current, head: { rev, publishedRev: rev }, liveCourse, liveLessons }),
    /* Publishing bumps the draft's rev too. Run it as OUR write so the
       "changed elsewhere" watcher doesn't mistake it for another editor. */
    runPublish: async (fn) => {
      for (let i = 0; i < 100 && saving.current; i++) await new Promise((r) => setTimeout(r, 100));
      saving.current = true;
      try {
        const res = await fn();
        commit({ ...m.current, head: { rev: res.rev, publishedRev: res.rev }, draftExists: true });
        return res;
      } finally {
        saving.current = false;
        if (remoteRev.current > Number(m.current.head.rev || 0)) setSave({ state: "conflict", message: "Someone else saved changes to this course while you were editing." });
      }
    },
  }), [flush, load, head.data?.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  return { status, model, save, ...api };
}

/* Saving… / Saved / Couldn't save — Retry. Never "saved" while edits are pending. */
/* Course draft save state. "Draft saved" means saved to the PRIVATE draft —
   the header's Published / Unpublished changes pills say what learners see. */
export function SaveStatus({ save, onRetry, onReload, onOverwrite, idleText = "Not saved yet — start typing" }) {
  const s = save.state;
  if (s === "idle") return <span className="ac-savestate muted">{idleText}</span>;
  if (s === "pending") return <span className="ac-savestate muted" role="status">Unsaved changes…</span>;
  if (s === "saving") return <span className="ac-savestate muted" role="status"><ArrowPathIcon className="hi hi-xs ac-spin" aria-hidden="true" />Saving draft…</span>;
  if (s === "saved") return <span className="ac-savestate ok" role="status"><CheckCircleIcon className="hi hi-xs" aria-hidden="true" />Draft saved</span>;
  if (s === "offline") return (
    <span className="ac-savestate warn" role="status"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />Offline — not saved yet. Your edits are kept in this tab and save when you reconnect.
      <button type="button" className="ac-link" onClick={onRetry}>Try now</button></span>
  );
  if (s === "conflict") return (
    <span className="ac-savestate err" role="alert"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />{save.message}
      {onReload && <button type="button" className="ac-link" onClick={onReload}>Load their version</button>}
      {onOverwrite && <button type="button" className="ac-link" onClick={onOverwrite}>Keep mine…</button>}</span>
  );
  return <span className="ac-savestate err" role="alert"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />Couldn't save draft{save.message ? ` — ${save.message}` : ""}. Your edits are kept.<button type="button" className="ac-link" onClick={onRetry}>Retry</button></span>;
}
/* Formatted text: a VISUAL editor by default (bold, italic, heading, lists,
   links — no Markdown knowledge needed), stored in the same safe Markdown
   subset as before. A labelled "Markdown source" view stays available as a
   secondary option, and existing text that the visual view can't show exactly
   opens there instead of being rewritten (see academyRichText.js). */
const execOk = () => typeof document !== "undefined" && typeof document.execCommand === "function";
const TOOLS = [
  { cmd: "bold", label: "Bold", keys: "Ctrl+B", text: <b>B</b> },
  { cmd: "italic", label: "Italic", keys: "Ctrl+I", text: <i>I</i> },
  { cmd: "heading", label: "Heading", text: "Heading" },
  { cmd: "insertUnorderedList", label: "Bulleted list", text: "• List" },
  { cmd: "insertOrderedList", label: "Numbered list", text: "1. List" },
];
/* `format` is the stored text's version (1 legacy, 2 current — academyMarkdown.js).
   onChange(text, format): the visual view always writes version 2 (legacy text is
   converted only when it renders identically); the source view keeps the
   version the text already has, so its meaning never changes underneath it. */
export function RichTextField({ id, label, value, format = MD_LEGACY, onChange, rows = 8, placeholder = "", hint = "" }) {
  const fmtRef = useRef(format); fmtRef.current = format;
  const touched = useRef(false);                  // the author has edited since the last paint
  const ed = useRef(null);
  const last = useRef(value || "");
  const [mode, setMode] = useState(() => (canEditVisually(value || "", format) ? "visual" : "source"));
  const [forcedSource] = useState(() => !canEditVisually(value || "", format));
  const [empty, setEmpty] = useState(!(value || "").trim());
  const [linking, setLinking] = useState(null);    // { range }
  const [url, setUrl] = useState("");
  const [modeNote, setModeNote] = useState("");
  const lblId = `${id}-lbl`;

  const paint = (src) => { touched.current = false; if (ed.current) { ed.current.innerHTML = markdownToHtml(src, fmtRef.current) || "<p><br></p>"; setEmpty(!String(src || "").trim()); } };
  // first paint + external changes (reload, undo, another tab) — never on our own typing
  useLayoutEffect(() => { if (mode === "visual") paint(last.current); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if ((value || "") === last.current) return;
    last.current = value || "";
    if (mode === "visual") paint(last.current);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  // `edited` = the author changed something (typing, toolbar, paste, link). A
  // blur alone never writes — and never converts legacy text to version 2.
  const emit = (edited = true) => {
    if (!ed.current) return;
    if (edited) touched.current = true;
    if (!touched.current) return;                 // focus/blur without editing: write nothing
    const md = htmlToMarkdown(ed.current).slice(0, 20000);
    setEmpty(!ed.current.textContent.trim() && !ed.current.querySelector("li"));
    if (md !== last.current || (edited && fmtRef.current !== MD_CURRENT)) { last.current = md; fmtRef.current = MD_CURRENT; onChange(md, MD_CURRENT); }
  };
  const run = (cmd) => {
    if (!execOk() || !ed.current) return;
    ed.current.focus();
    try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* older engines */ }
    if (cmd === "heading") {
      const cur = String(document.queryCommandValue("formatBlock") || "").toLowerCase();
      document.execCommand("formatBlock", false, /h[1-6]/.test(cur) ? "p" : "h3");
    } else document.execCommand(cmd, false, null);
    emit();
  };
  const startLink = () => {
    const sel = window.getSelection();
    const range = sel && sel.rangeCount && ed.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    setLinking({ range }); setUrl("");
  };
  const insertLink = (e) => {
    e.preventDefault();
    const u = normalizeLinkInput(url);
    if (!isSafeHref(u) || !ed.current) return;
    ed.current.focus();
    const sel = window.getSelection();
    if (linking?.range) { sel.removeAllRanges(); sel.addRange(linking.range); }
    if (execOk() && sel && sel.rangeCount && !sel.isCollapsed) document.execCommand("createLink", false, u);
    else if (execOk()) document.execCommand("insertHTML", false, `<a href="${u.replace(/"/g, "&quot;")}">${(sourceLabel(u) || u).replace(/[<>&]/g, "")}</a>&nbsp;`);
    setLinking(null);
    emit();
  };
  const onKey = (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key.toLowerCase() === "k") { e.preventDefault(); startLink(); }
  };
  // Pasting never brings in foreign HTML — plain text only.
  const onPaste = (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (text == null || !execOk()) return;
    e.preventDefault();
    document.execCommand("insertText", false, text);
    emit();
  };
  const toVisual = () => {
    if (!canEditVisually(value || "", format)) { setModeNote("This text uses Markdown the formatted view can't show exactly, so it stays in source view to keep it unchanged."); return; }
    setModeNote(""); setMode("visual");
  };

  return (
    <div className="sb-field ac-rich">
      <div className="ac-richhead">
        <span className="ac-fieldlabel" id={lblId}>{label}</span>
        {mode === "visual"
          ? <button type="button" className="ac-link ac-richmode" onClick={() => setMode("source")}>Edit Markdown source</button>
          : <button type="button" className="ac-link ac-richmode" onClick={toVisual}>Back to formatted view</button>}
      </div>
      {mode === "visual" ? (
        <>
          <div className="ac-toolbar" role="toolbar" aria-label={`Formatting for ${label}`}>
            {TOOLS.map((t) => (
              <button key={t.cmd} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => run(t.cmd)}
                aria-label={t.keys ? `${t.label} (${t.keys})` : t.label} title={t.keys ? `${t.label} (${t.keys})` : t.label}>{t.text}</button>
            ))}
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={startLink} aria-label="Link (Ctrl+K)" title="Link (Ctrl+K)"><LinkIcon className="hi hi-xs" aria-hidden="true" />Link</button>
          </div>
          <div id={id} ref={ed} className={"ac-rte ac-md" + (empty ? " is-empty" : "")} contentEditable suppressContentEditableWarning
            role="textbox" aria-multiline="true" aria-labelledby={lblId} tabIndex={0} data-placeholder={placeholder}
            style={{ minHeight: `${Math.max(3, rows) * 1.55}em` }}
            onInput={() => emit(true)} onBlur={() => emit(false)} onKeyDown={onKey} onPaste={onPaste} />
          {linking && (
            <form className="ac-linkpop" onSubmit={insertLink} noValidate>
              <label htmlFor={`${id}-link`} className="sb-vh">Link address</label>
              <input id={`${id}-link`} autoFocus type="url" inputMode="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setLinking(null); ed.current?.focus(); } }} />
              <button type="submit" className="sb-btn compact" disabled={!isSafeHref(normalizeLinkInput(url))}>Add link</button>
              <button type="button" className="sb-btn quiet compact" onClick={() => { setLinking(null); ed.current?.focus(); }}>Cancel</button>
            </form>
          )}
        </>
      ) : (
        <>
          <textarea id={id} rows={rows} value={value || ""} placeholder={placeholder} maxLength={20000} aria-labelledby={lblId}
            onChange={(e) => { last.current = e.target.value; onChange(e.target.value, format); }} className="ac-mdsource" spellCheck />
          <div className="ac-hint">{forcedSource && !modeNote ? "Shown as Markdown source so its formatting stays exactly as written. " : ""}{format === MD_CURRENT ? MARKDOWN_HELP_V2 : MARKDOWN_HELP}</div>
        </>
      )}
      {modeNote && <div className="ac-hint" role="status">{modeNote}</div>}
      {hint && <div className="ac-hint">{hint}</div>}
    </div>
  );
}

const linkIconFor = (l) => l.restricted ? LockClosedIcon : /PDF|Word|Doc|Slides|Sheet|PowerPoint|Excel|Text/.test(l.fileType || "") ? DocumentTextIcon : LinkIcon;
export function LinkList({ id, label, hint, items = [], onChange, emptyText = "No links yet.", autoFocus = false }) {
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const [renaming, setRenaming] = useState(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState({});
  const latest = useRef(items); latest.current = items;
  // keep `latest` current between our own updates too (metadata can return
  // before React re-renders; building on a stale list would drop the new link)
  const emit = (next) => { latest.current = next; onChange(next); };
  const add = async (raw) => {
    const url = normalizeLinkInput(raw);
    if (!url) return;
    if (!isValidResourceUrl(url)) { setErr("Paste a full web address (https://…)."); return; }
    if (latest.current.some((l) => l.url === url)) { setErr("That link is already here."); return; }
    setErr(""); setInput("");
    const link = newLink(url);
    emit([...latest.current, link]);
    setLoading((x) => ({ ...x, [url]: true }));
    let meta = null;
    try { meta = await fetchLinkMetadata(url); } catch { meta = null; }
    setLoading((x) => { const n = { ...x }; delete n[url]; return n; });
    // apply only to the SAME link if it's still there, never over a custom name
    emit(latest.current.map((l) => (l.url === url ? applyLinkMeta(l, meta) : l)));
  };
  return (
    <div className="sb-field ac-links">
      <span className="ac-fieldlabel" id={`${id}-lbl`}>{label}</span>
      {hint && <div className="ac-hint" style={{ marginTop: -2, marginBottom: 6 }}>{hint}</div>}
      <ul className="ac-linklist" aria-labelledby={`${id}-lbl`}>
        {items.length === 0 && <li className="ac-cardsub">{emptyText}</li>}
        {items.map((l, i) => {
          const Icon = linkIconFor(l);
          return (
            <li key={l.url} className="ac-linkcard">
              <span className="ac-linkicon" aria-hidden="true"><Icon className="hi hi-sm" /></span>
              {renaming === i ? (
                <form className="ac-linkrename" onSubmit={(e) => { e.preventDefault(); const v = name.trim(); onChange(items.map((x, j) => j === i ? { ...x, label: v || x.label, custom: !!v || x.custom } : x)); setRenaming(null); }}>
                  <label htmlFor={`${id}-rn-${i}`} className="sb-vh">Link name</label>
                  <input id={`${id}-rn-${i}`} autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
                  <button type="submit" className="sb-btn compact">Save</button>
                  <button type="button" className="sb-btn quiet compact" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              ) : (
                <span className="ac-linkmain">
                  <a href={l.url} target="_blank" rel="noopener noreferrer" className="ac-linktitle">{l.label || l.url}</a>
                  <span className="ac-cardsub">{loading[l.url] ? "Looking up…" : [l.source || sourceLabel(l.url), l.fileType, l.restricted ? "Private link — details not available" : ""].filter(Boolean).join(" · ")}</span>
                </span>
              )}
              {renaming !== i && <span className="ac-linkactions">
                <button type="button" className="ac-link" onClick={() => { setRenaming(i); setName(l.label || ""); }} aria-label={`Rename ${l.label || "link"}`}>Rename</button>
                <button type="button" className="ac-iconbtn" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${l.label || "link"}`}><XMarkIcon className="hi hi-sm" aria-hidden="true" /></button>
              </span>}
            </li>
          );
        })}
      </ul>
      <form className="ac-linkadd" noValidate onSubmit={(e) => { e.preventDefault(); add(input); }}>
        <label htmlFor={`${id}-add`} className="sb-vh">Paste a link</label>
        <input id={`${id}-add`} type="url" inputMode="url" placeholder="Paste a link (https://…)" value={input} autoFocus={autoFocus}
          onChange={(e) => { setInput(e.target.value); setErr(""); }}
          onPaste={(e) => { const t = e.clipboardData?.getData("text"); if (t && isValidResourceUrl(t.trim())) { e.preventDefault(); add(t.trim()); } }} />
        <button type="submit" className="sb-btn quiet compact" disabled={!input.trim()}><PlusIcon className="hi hi-sm" aria-hidden="true" />Add</button>
      </form>
      {err && <div className="ac-err" role="alert">{err}</div>}
    </div>
  );
}

/* =====================================================================
   Quiz (learner-readable questions + private answer key)
   ===================================================================== */
const blankQ = () => ({ id: newId(), prompt: "", multi: false, options: [{ id: newId(), text: "" }, { id: newId(), text: "" }] });
export function QuizEditor({ idBase, quiz, quizKey, onChange }) {
  const q = quiz || { mode: "none", passMark: DEFAULT_PASS_MARK, retryLimit: 0, questions: [] };
  const key = quizKey || { answers: {}, explanations: {} };
  const setQuiz = (patch) => onChange({ ...q, ...patch }, key);
  const setKey = (patch) => onChange(q, { ...key, ...patch });
  const setQuestion = (i, patch) => setQuiz({ questions: q.questions.map((x, j) => j === i ? { ...x, ...patch } : x) });
  const correctOf = (qq) => key.answers?.[qq.id] || [];
  if (q.mode === "none") return (
    <div className="ac-quizoff"><button type="button" className="sb-btn ghost compact" onClick={() => setQuiz({ mode: "practice", questions: q.questions.length ? q.questions : [blankQ()] })}><ClipboardDocumentCheckIcon className="hi hi-sm" aria-hidden="true" />Add a quiz</button>
      <span className="ac-cardsub">Optional — a short check after the lesson.</span></div>
  );
  return (
    <div className="ac-quizedit">
      <div className="ac-row2">
        <div className="sb-field"><label htmlFor={`${idBase}-qm`}>Quiz</label>
          <select id={`${idBase}-qm`} value={q.mode} onChange={(e) => setQuiz({ mode: e.target.value })}>
            <option value="practice">Practice — doesn't affect completion</option><option value="required">Required — must pass to complete the lesson</option><option value="none">Remove quiz</option>
          </select></div>
        <div className="sb-field"><label htmlFor={`${idBase}-pm`}>Pass mark (%)</label><input id={`${idBase}-pm`} type="number" min="1" max="100" value={q.passMark} onChange={(e) => setQuiz({ passMark: e.target.value })} /></div>
      </div>
      <ol className="ac-edquestions">
        {q.questions.map((qq, i) => (
          <li key={qq.id} className="ac-edq">
            <div className="ac-edqhead">
              <label htmlFor={`${idBase}-q-${qq.id}`} className="sb-vh">Question {i + 1}</label>
              <input id={`${idBase}-q-${qq.id}`} placeholder={`Question ${i + 1}`} value={qq.prompt} onChange={(e) => setQuestion(i, { prompt: e.target.value })} maxLength={1000} />
              <button type="button" className="ac-iconbtn" aria-label={`Remove question ${i + 1}`} onClick={() => setQuiz({ questions: q.questions.filter((_, j) => j !== i) })}><TrashIcon className="hi hi-sm" aria-hidden="true" /></button>
            </div>
            <Toggle label="More than one correct answer" v={qq.multi} on={() => { setQuestion(i, { multi: !qq.multi }); if (qq.multi) setKey({ answers: { ...key.answers, [qq.id]: correctOf(qq).slice(0, 1) } }); }} />
            <div className="ac-edopts" role="group" aria-label={`Answers for question ${i + 1} — tick the correct ones`}>
              {qq.options.map((o, oi) => (
                <div key={o.id} className="ac-edopt">
                  <input type={qq.multi ? "checkbox" : "radio"} name={`${idBase}-c-${qq.id}`} checked={correctOf(qq).includes(o.id)} aria-label={`Answer ${oi + 1} is correct`}
                    onChange={() => setKey({ answers: { ...key.answers, [qq.id]: qq.multi ? (correctOf(qq).includes(o.id) ? correctOf(qq).filter((x) => x !== o.id) : [...correctOf(qq), o.id]) : [o.id] } })} />
                  <input placeholder={`Answer ${oi + 1}`} value={o.text} aria-label={`Answer ${oi + 1}`} onChange={(e) => setQuestion(i, { options: qq.options.map((x, j) => j === oi ? { ...x, text: e.target.value } : x) })} maxLength={300} />
                  <button type="button" className="ac-iconbtn" aria-label={`Remove answer ${oi + 1}`} disabled={qq.options.length <= 2} onClick={() => setQuestion(i, { options: qq.options.filter((_, j) => j !== oi) })}><XMarkIcon className="hi hi-sm" aria-hidden="true" /></button>
                </div>
              ))}
              {qq.options.length < 8 && <button type="button" className="sb-btn quiet compact" onClick={() => setQuestion(i, { options: [...qq.options, { id: newId(), text: "" }] })}><PlusIcon className="hi hi-sm" aria-hidden="true" />Add answer</button>}
            </div>
            <div className="sb-field"><label htmlFor={`${idBase}-ex-${qq.id}`}>Explanation (shown after answering)</label>
              <textarea id={`${idBase}-ex-${qq.id}`} rows={2} value={key.explanations?.[qq.id] || ""} onChange={(e) => setKey({ explanations: { ...key.explanations, [qq.id]: e.target.value } })} maxLength={2000} /></div>
          </li>
        ))}
      </ol>
      <button type="button" className="sb-btn ghost compact" onClick={() => setQuiz({ questions: [...q.questions, blankQ()] })}><PlusIcon className="hi hi-sm" aria-hidden="true" />Add question</button>
    </div>
  );
}

/* =====================================================================
   Add content menu
   ===================================================================== */
export const CONTENT_CHOICES = [
  { kind: "video", label: "Video", hint: "Paste a YouTube, Vimeo or Drive link", Icon: PlayIcon },
  { kind: "bulk", label: "Multiple videos", hint: "Paste several links, one per line", Icon: QueueListIcon },
  { kind: "written", label: "Written lesson", hint: "Formatted text with links", Icon: DocumentTextIcon },
  { kind: "resource", label: "Resource link", hint: "A document or page to review", Icon: LinkIcon },
  { kind: "exercise", label: "Exercise", hint: "Instructions to try it out", Icon: PencilSquareIcon },
];
/* The five content types as menu items (used by every Add content entry). */
export function ContentChoices({ onPick }) {
  return CONTENT_CHOICES.map((c) => (
    <button key={c.kind} type="button" role="menuitem" className="ac-menuitem" onClick={() => onPick(c.kind)}>
      <c.Icon className="hi hi-sm" aria-hidden="true" /><span><b>{c.label}</b><span className="ac-cardsub">{c.hint}</span></span>
    </button>
  ));
}
/* "Add content" button + anchored menu (portal — never clipped by the outline). */
export function AddContentMenu({ onPick, label = "Add content", className = "sb-btn ghost compact ac-addbtn" }) {
  return (
    <MenuButton label="Add content" renderTrigger={({ ref, toggle, props }) => (
      <button ref={ref} type="button" className={className} onClick={toggle} {...props}><PlusIcon className="hi hi-sm" aria-hidden="true" /><span>{label}</span></button>
    )}>
      {(close) => <ContentChoices onPick={(k) => { close(); onPick(k); }} />}
    </MenuButton>
  );
}

export function SmallDialog({ title, onClose, children, actions }) {
  useEffect(() => { const h = (e) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", h); return () => document.removeEventListener("keydown", h); }, [onClose]);
  return (
    <Portal>
      <div className="sb-scrim" onMouseDown={onClose}>
        <div className="sb-sheet ac-smalldialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
          <div className="hd"><b className="sb-serif" style={{ fontSize: 17 }}>{title}</b><button type="button" className="sb-x" onClick={onClose} aria-label="Close"><XMarkIcon className="hi" aria-hidden="true" /></button></div>
          <div className="bd">{children}</div>
          {actions && <div className="ac-sheetfoot">{actions}</div>}
        </div>
      </div>
    </Portal>
  );
}
/* "Move to position…" — the keyboard/touch-friendly secondary reorder. */
/* "Move to position…": the keyboard-free, drag-free alternative.
   sections: [{ id, title, count }] (count = items in it now). Position is
   within the chosen section (or the whole list when there are no sections). */
export function MoveDialog({ title, count, current, sections, currentSection, onMove, onClose, unit = "item" }) {
  const [pos, setPos] = useState(String(current + 1));
  const [sec, setSec] = useState(currentSection || "");
  const multi = sections && sections.length > 1;
  const target = multi ? sections.find((x) => x.id === sec) : null;
  // moving INTO another section adds a slot there
  const max = multi ? Math.max(1, (target?.count || 0) + (sec === currentSection ? 0 : 1)) : count;
  const n = Math.max(1, Math.min(max, Math.round(Number(pos) || 1)));
  return (
    <SmallDialog title={title} onClose={onClose} actions={<>
      <button type="button" className="sb-btn ghost compact" onClick={onClose}>Cancel</button>
      <button type="button" className="sb-btn compact" onClick={() => { onMove(n - 1, sec); onClose(); }}>Move</button></>}>
      {multi && (
        <div className="sb-field"><label htmlFor="mv-sec">Section</label>
          <select id="mv-sec" value={sec} onChange={(e) => { setSec(e.target.value); setPos("1"); }}>{sections.map((x, i) => <option key={x.id} value={x.id}>{x.title || `Section ${i + 1}`}</option>)}</select></div>
      )}
      <div className="sb-field"><label htmlFor="mv-pos">Position{multi ? " in section" : ""} (1–{max})</label>
        <input id="mv-pos" type="number" min="1" max={max} value={pos} onChange={(e) => setPos(e.target.value)} autoFocus />
        <div className="ac-hint">{n === 1 ? `First ${unit}` : n === max ? `Last ${unit}` : `${unit[0].toUpperCase() + unit.slice(1)} ${n} of ${max}`}</div></div>
    </SmallDialog>
  );
}
