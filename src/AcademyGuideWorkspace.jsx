/* Tips & resources — the full-page editor (/learn/manage/guide/:id|new), the
   same pattern as the course workspace without course concepts: a private
   draft (guideDrafts/{id}) that autosaves, Preview draft, Publish / Publish
   changes, Back to the resource (or its category / the Academy), and a ⋯ menu
   (view, unpublish, archive, restore, discard changes, delete).
   Learners keep the published version (guides/{id}) until you publish. */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUturnLeftIcon, EyeIcon, EllipsisHorizontalIcon, EyeSlashIcon, ArchiveBoxIcon, TrashIcon, CheckCircleIcon,
  ExclamationTriangleIcon, ArrowPathIcon,
} from "@heroicons/react/24/outline";
import { BusyButton, Skeleton } from "./loading.jsx";
import { ConfirmDialog } from "./App.jsx";
import { MenuButton } from "./academyMenu.jsx";
import { AppLink } from "./academyShared.jsx";
import { VideoPreview } from "./academyVideoPreview.jsx";
import { Field, CategorySelect, TopicsField, ThumbnailChoice, RequiredTag } from "./AcademyManage.jsx";
import { RichTextField, LinkList, SaveStatus, PublishCheckCtx } from "./academyWorkspaceParts.jsx";
import { Crumbs, Flash, Readiness, useWorkspaceLeaveGuard, useTaxonomy } from "./AcademyWorkspace.jsx";
import { learnManagePath, learnGuidePath, learnCategoryPath, learnPreviewGuidePath } from "./nav.js";
import { parseVideoLink, videoFromRecord, videoRecord } from "./academyVideo.js";
import { categoryIn, isAcademyAdmin, normalizeCategory } from "./academyProgress.js";
import { formatClock } from "./academyDrafts.js";
import { guidePublishIssues, guideKind, GUIDE_KIND_LABEL } from "./academyGuides.js";
import { useOnline, requireOnline, isOfflineError } from "./useOnline.js";
import { useUploadsInFlight, uploadsInFlight, waitForUploads } from "./academyUploads.js";
import {
  loadGuideWorkspace, saveGuideDraft, publishGuideDraft, discardGuideDraft, setGuideStatus, deleteGuideHard, newGuideId,
  imagesReferencedElsewhere, deleteImage, pathsUsingGuide,
} from "./academyData.js";

/* The draft store: autosave (700 ms) pinned to the loaded revision, honest
   states (pending / saving / saved / offline / conflict / error), a save on
   leaving, a browser warning when closing with unsaved edits. */
function useGuideDraft(gid, me, { blank, onFirstSave }) {
  const [status, setStatus] = useState("loading");
  const [model, setModel] = useState(null);
  const [save, setSave] = useState({ state: "idle" });
  const m = useRef(null), timer = useRef(0), inflight = useRef(null), dirty = useRef(false), replaced = useRef(new Set());
  const online = useOnline();
  const commit = (next) => { m.current = next; setModel(next); };
  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const w = await loadGuideWorkspace(gid);
      if (!w.guide && !blank) { setStatus("missing"); return; }
      dirty.current = false; commit({ ...w, guide: w.guide || blank }); setSave({ state: w.draftExists ? "saved" : "idle" }); setStatus("ready");
    } catch (e) { setSave({ state: "error", message: isOfflineError(e) ? "You're offline." : e?.message }); setStatus("error"); }
  }, [gid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const cleanup = async () => {
    const cands = [...replaced.current].filter((p) => p.startsWith(`academy/guideThumbs/${gid}/`) && p !== m.current?.guide?.thumb?.path && p !== m.current?.live?.thumb?.path);
    replaced.current.clear();
    if (!cands.length) return;
    try { const keep = await imagesReferencedElsewhere(cands, null); for (const p of cands) if (!keep.has(p)) await deleteImage(p).catch(() => {}); } catch { /* left for later */ }
  };
  const flushNow = useCallback(async () => {
    clearTimeout(timer.current); timer.current = 0;
    if (inflight.current) await inflight.current.catch(() => {});
    if (!dirty.current) return m.current?.head.rev;
    if (typeof navigator !== "undefined" && navigator.onLine === false) { setSave({ state: "offline" }); throw Object.assign(new Error("offline"), { code: "offline" }); }
    dirty.current = false; setSave({ state: "saving" });
    const p = saveGuideDraft(me, gid, m.current.guide, m.current.head.rev).then((rev) => {
      const first = !m.current.draftExists;
      commit({ ...m.current, head: { ...m.current.head, rev }, draftExists: true });
      setSave(dirty.current ? { state: "pending" } : { state: "saved" });
      if (first) onFirstSave?.();
      cleanup();
      return rev;
    }, (e) => {
      dirty.current = true;
      setSave(e?.code === "conflict" ? { state: "conflict", message: "Someone else saved changes to this resource while you were editing." } : isOfflineError(e) ? { state: "offline" } : { state: "error", message: e?.message });
      throw e;
    });
    inflight.current = p;
    try { return await p; } finally { if (inflight.current === p) inflight.current = null; }
  }, [gid, me]); // eslint-disable-line react-hooks/exhaustive-deps
  const flushRef = useRef(flushNow); flushRef.current = flushNow;
  const update = (patch) => {
    commit({ ...m.current, guide: { ...m.current.guide, ...patch } });
    dirty.current = true; setSave({ state: "pending" });
    clearTimeout(timer.current); timer.current = setTimeout(() => flushRef.current().catch(() => {}), 700);
  };
  useEffect(() => { if (online && dirty.current && save.state === "offline") flushNow().catch(() => {}); }, [online]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (dirty.current && navigator.onLine !== false) flushRef.current().catch(() => {}); }, []);
  useEffect(() => {
    const h = (e) => { if (["pending", "saving", "error", "conflict", "offline"].includes(save.state)) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h); return () => window.removeEventListener("beforeunload", h);
  }, [save.state]);
  return {
    status, model, save, update, flushNow, reload: load,
    getModel: () => m.current,
    settle: async () => { const r = await flushNow(); return r ?? m.current.head.rev; },
    ensureSaved: async () => { if (!m.current.draftExists) { dirty.current = true; await flushNow(); } return { guideId: gid }; },
    imageReplaced: (p) => { if (p) replaced.current.add(p); },
    overwriteRemote: async () => { const w = await loadGuideWorkspace(gid); commit({ ...m.current, head: w.head, draftExists: w.draftExists }); dirty.current = true; return flushNow(); },
    refreshLive: async () => { const w = await loadGuideWorkspace(gid); commit({ ...m.current, live: w.live, head: w.head, draftExists: w.draftExists }); },
    markDiscarded: () => { dirty.current = false; clearTimeout(timer.current); },
  };
}

const FIX_TARGET = { title: ["#gw-title"], category: ["#gw-cat"], video: ["#gw-url"], content: ["#gw-url", "#gw-body"], body: ["#gw-body"] };

export function GuideWorkspace({ me, id: routeId, categoryParam = "", pathCtx = "", R, onCreated }) {
  const [gid] = useState(() => (routeId === "new" ? newGuideId() : routeId));
  const admin = isAcademyAdmin(me);
  const tax = useTaxonomy();
  const online = useOnline();
  const uploading = useUploadsInFlight();
  const store = useGuideDraft(gid, me, {
    blank: routeId === "new" ? { title: "", category: normalizeCategory(categoryParam || ""), topics: [], topicIds: [], video: null, videoMeta: null, thumbMode: "source", body: "", mdVersion: 2, resources: [], thumb: null, durationMinutes: 0 } : null,
    onFirstSave: () => { if (routeId === "new") { onCreated?.(gid); R.replace(learnManagePath({ view: "guide", id: gid })); } },
  });
  const { status, model, save } = store;
  const leaveGuard = useWorkspaceLeaveGuard(gid, save, store, { isHere: (p) => p === `/learn/manage/guide/${gid}` || p === "/learn/manage/guide/new", what: "resource" });
  const [url, setUrl] = useState(null);
  const [touched, setTouched] = useState(() => new Set());
  const [attempted, setAttempted] = useState(false);
  const [readyOpen, setReadyOpen] = useState(false);
  const [publish, setPublish] = useState({ state: "idle" });
  const [dialog, setDialog] = useState(null);
  const [refs, setRefs] = useState(null);
  const autoTitle = useRef(null);
  const publishing = useRef(false);
  useEffect(() => { if (model && url === null) setUrl(model.guide.video ? (videoFromRecord(model.guide.video)?.url || "") : ""); }, [model, url]);
  // impact check before a permanent delete (server read); Delete stays disabled until it succeeds
  const [refsFailed, setRefsFailed] = useState(false);
  const [checkTry, setCheckTry] = useState(0);
  useEffect(() => {
    if (dialog !== "delete") return undefined;
    let live = true; setRefs(null); setRefsFailed(false);
    pathsUsingGuide(gid).then((r) => { if (live) setRefs(r); }).catch(() => { if (live) setRefsFailed(true); });
    return () => { live = false; };
  }, [dialog, gid, checkTry]);

  if (status === "loading" || !model) return <div className="sb-page"><Skeleton lines={8} /></div>;
  if (status === "missing") return <div className="sb-page"><Crumbs R={R} items={[{ label: "Academy", to: "/learn/manage" }, { label: "Not found" }]} /><div className="sb-empty"><p>This resource doesn't exist any more. It may have been deleted.</p><AppLink className="sb-btn compact" to="/learn/manage" navigate={R.navigate}>Go to Academy management</AppLink></div></div>;
  if (status === "error") return <div className="sb-page"><div className="sb-empty" role="alert">{save.message || "Couldn't load this resource."} <button type="button" className="ac-link" onClick={store.reload}>Try again</button></div></div>;

  const g = model.guide, live = model.live;
  const up = (patch) => store.update(patch);
  const parsed = url && url.trim() ? parseVideoLink(url) : null;
  const cat = categoryIn(tax.categories, g.category);
  const liveCat = live ? categoryIn(tax.categories, live.category) : null;
  const liveStatus = !live ? "never" : live.status;
  const changes = model.draftExists && liveStatus === "published" && model.head.rev > model.head.publishedRev;
  const categoryIds = tax.bootstrap ? null : tax.records.map((r) => r.id);
  const issues = guidePublishIssues(g, categoryIds);
  const err = (field, ctl) => { const i = issues.find((x) => x.field === field || (field === "content" && x.field === "content")); return i && (attempted || touched.has(ctl)) ? i.message : ""; };
  const title = (g.title || "").trim() || "New resource";
  const kind = guideKind(g);
  const setVideoUrl = (v) => {
    setUrl(v);
    const p = v.trim() ? parseVideoLink(v) : null;
    if (!v.trim()) up({ video: null, videoMeta: null });
    else if (p?.ok && (!g.video || g.video.id !== p.id || g.video.provider !== p.provider)) up({ video: videoRecord(p), videoMeta: null, durationMinutes: 0 });
  };
  // the provider's title is a SUGGESTION: fill an empty title or replace one we filled; never the author's own
  const onMeta = (meta) => {
    const cur = store.getModel().guide; const patch = { videoMeta: meta };
    const t = (cur.title || "").trim();
    if (meta?.title && (!t || t === autoTitle.current)) { patch.title = meta.title.slice(0, 120); autoTitle.current = patch.title; }
    up(patch);
  };
  const onFix = (i) => {
    const sel = FIX_TARGET[i.field] || [];
    setTouched((t) => new Set([...t, ...sel.map((x) => x.slice(1))]));
    requestAnimationFrame(() => { const el = sel.map((q) => document.querySelector(q)).find(Boolean); if (el) { el.scrollIntoView({ block: "center" }); el.focus({ preventScroll: true }); } });
  };
  const back = liveStatus === "published" && liveCat && !liveCat.hidden ? { label: "Back to resource", to: learnGuidePath(gid) }
    : cat && !cat.hidden ? { label: "Back to category", to: learnCategoryPath(cat.id), note: liveStatus === "never" ? "This resource hasn't been published yet, so it doesn't have a page." : "This resource isn't published, so learners can't open it." }
    : { label: "Back to Academy", to: "/learn", note: "This resource isn't available to learners yet." };
  const doPublish = async () => {
    if (publishing.current) return;
    if (issues.length) { setAttempted(true); setReadyOpen(true); return; }
    publishing.current = true; setPublish({ state: "busy" });
    try {
      requireOnline();
      if (uploadsInFlight()) { setPublish({ state: "busy", waiting: "upload" }); await waitForUploads(); setPublish({ state: "busy" }); }
      // a resource from before drafts existed (unpublished/archived, never edited
      // here) has no draft yet: create it from the record, unchanged, then publish it
      if (!store.getModel().draftExists) await store.ensureSaved();
      const rev = await store.settle();
      const res = await publishGuideDraft(me, gid, rev);
      await store.refreshLive();
      setAttempted(false);
      setPublish({ state: "done", first: res.firstPublish, already: res.already });
    } catch (e) {
      if (e?.code === "conflict") store.reload();
      setPublish({ state: "error", message: e?.code === "conflict" ? "Someone else changed this resource just now. We've loaded their version. Check it, then publish again."
        : isOfflineError(e) ? "Couldn't connect, so nothing was published. Check your connection and try again. Trying again won't publish twice."
        : e?.message || "Couldn't publish." });
    } finally { publishing.current = false; }
  };
  const busySaving = ["pending", "saving"].includes(save.state);
  const markTouched = (e) => { const id = e.target && e.target.id; if (id && !touched.has(id)) setTouched((t) => new Set(t).add(id)); };
  const visibleNow = cat && !cat.hidden;

  return (
    <div className="sb-page ac-ws ac-guidews">
      <header className="ac-wsbar">
        <Crumbs R={R} items={[{ label: "Academy", to: "/learn/manage" }, cat ? { label: cat.label, to: learnManagePath({ view: "category", id: cat.id }) } : { label: "No category" }, { label: title }]} />
        <Flash R={R} />
        <div className="ac-wsbarrow">
          <div className="ac-wsbartitle">
            <h1 className="ac-wscoursename">{title}</h1>
            <span className="ac-wspills">
              {liveStatus === "published" ? <span className="ac-pill ok">Published</span> : liveStatus === "archived" ? <span className="ac-pill">Archived</span> : <span className="ac-pill">Draft</span>}
              {changes && <span className="ac-pill accent">Unpublished changes</span>}
            </span>
            <SaveStatus save={save} onRetry={() => store.flushNow().catch(() => {})} onReload={store.reload} onOverwrite={() => setDialog("keepmine")}
              idleText={live ? "No unpublished changes" : "Not saved yet. Start typing to create a draft."} />
          </div>
          <div className="ac-actions ac-wsbaractions">
            <AppLink className="sb-btn ghost compact ac-backbtn" to={back.to} navigate={R.navigate} aria-describedby={back.note ? "gw-back-note" : undefined} title={back.note || undefined}><ArrowUturnLeftIcon className="hi hi-sm" aria-hidden="true" /><span>{back.label}</span></AppLink>
            {back.note && <span id="gw-back-note" className="sb-vh">{back.note}</span>}
            <button type="button" className="sb-btn ghost compact" disabled={!online || (!model.draftExists && !live)} title={!online ? "Previewing needs a connection." : "See your unpublished changes as learners will. Nothing is published."}
              onClick={async () => { try { await store.settle(); R.navigate(learnPreviewGuidePath(gid, { path: pathCtx })); } catch (e) { setPublish({ state: "error", message: e?.message }); } }}><EyeIcon className="hi hi-sm" aria-hidden="true" /><span>Preview draft</span></button>
            <BusyButton className="sb-btn compact" busy={publish.state === "busy"} busyLabel={publish.waiting === "upload" ? "Waiting for upload…" : "Publishing…"}
              disabled={!online || save.state === "conflict" || save.state === "offline" || (liveStatus === "published" && !changes && !busySaving) || (liveStatus === "never" && !model.draftExists && !busySaving)}
              onClick={doPublish}>{liveStatus === "published" ? "Publish changes" : "Publish"}</BusyButton>
            <MenuButton label="More resource actions" align="end" renderTrigger={({ ref, toggle, props }) => (
              <button ref={ref} type="button" className="sb-btn ghost compact ac-iconsq" onClick={toggle} aria-label="More resource actions" {...props}><EllipsisHorizontalIcon className="hi hi-sm" aria-hidden="true" /></button>
            )}>
              {(close) => <>
                {liveStatus === "published" && <button type="button" role="menuitem" className="ac-menuitem" onClick={() => { close(); R.navigate(learnGuidePath(gid)); }}><EyeIcon className="hi hi-sm" aria-hidden="true" /><span><b>View published version</b></span></button>}
                {liveStatus === "published" && <button type="button" role="menuitem" className="ac-menuitem" onClick={() => { close({ refocus: true }); setDialog("unpublish"); }}><EyeSlashIcon className="hi hi-sm" aria-hidden="true" /><span><b>Unpublish…</b><span className="ac-cardsub">Learners stop seeing it. Reviews and discussion are kept.</span></span></button>}
                {liveStatus !== "never" && liveStatus !== "archived" && <button type="button" role="menuitem" className="ac-menuitem" onClick={() => { close({ refocus: true }); setDialog("archive"); }}><ArchiveBoxIcon className="hi hi-sm" aria-hidden="true" /><span><b>Archive…</b><span className="ac-cardsub">Hidden and kept for later</span></span></button>}
                {liveStatus === "archived" && <button type="button" role="menuitem" className="ac-menuitem" onClick={async () => { close({ refocus: true }); await setGuideStatus(me, gid, "draft"); store.refreshLive(); }}><ArrowUturnLeftIcon className="hi hi-sm" aria-hidden="true" /><span><b>Restore to draft</b><span className="ac-cardsub">Still hidden until you publish</span></span></button>}
                {changes && <button type="button" role="menuitem" className="ac-menuitem" onClick={() => { close({ refocus: true }); setDialog("discard"); }}><ArrowPathIcon className="hi hi-sm" aria-hidden="true" /><span><b>Discard unpublished changes…</b><span className="ac-cardsub">Go back to the published version</span></span></button>}
                {(model.draftExists || live) && <>
                  <div role="separator" className="ac-menusep" />
                  <button type="button" role="menuitem" className="ac-menuitem danger" disabled={liveStatus === "published" || (liveStatus !== "never" && !admin)} onClick={() => { close({ refocus: true }); setDialog("delete"); }}>
                    <TrashIcon className="hi hi-sm" aria-hidden="true" /><span><b>Delete resource…</b><span className="ac-cardsub">{liveStatus === "published" ? "Unpublish it first. A published resource can't be deleted." : liveStatus !== "never" && !admin ? "Only admins can delete a resource that was published." : "Permanently removes it"}</span></span></button>
                </>}
              </>}
            </MenuButton>
          </div>
        </div>
        {(liveStatus !== "published" || changes || issues.length > 0) && <Readiness issues={issues} attempted={attempted} open={readyOpen} setOpen={setReadyOpen} onFix={onFix} />}
        {uploading > 0 && publish.state !== "busy" && <div className="ac-wsnote ac-note-info" role="status"><span>An image is uploading. Publishing waits for it to finish.</span></div>}
        {publish.state === "done" && (
          <div className={"ac-wsnote " + (visibleNow ? "ac-ok" : "ac-note-info")} role="status">
            {visibleNow ? <CheckCircleIcon className="hi hi-sm" aria-hidden="true" /> : <EyeSlashIcon className="hi hi-sm" aria-hidden="true" />}
            <span>{!visibleNow ? <>Published. Its category “{cat?.label}” is hidden, so learners can't see it yet.{!admin && " An admin can show the category."}</>
              : publish.already ? "This version was already published, so learners already see it." : publish.first ? "Published. Learners can see this resource now." : "Changes published. Learners now see this version."}</span>
            <span className="ac-wsnoteacts"><AppLink className="ac-link" to={learnGuidePath(gid)} navigate={R.navigate}>View resource</AppLink><button type="button" className="ac-link" onClick={() => setPublish({ state: "idle" })}>Dismiss</button></span>
          </div>
        )}
        {publish.state === "error" && (
          <div className="ac-wsnote ac-note-err" role="alert"><ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" /><span><b>Not published.</b> {publish.message}</span>
            <span className="ac-wsnoteacts"><button type="button" className="ac-link" onClick={() => setPublish({ state: "idle" })}>Dismiss</button></span></div>
        )}
      </header>
      <PublishCheckCtx.Provider value={{ issues: issues.map((i) => ({ ...i, item: "details" })), attempted, touched }}>
        <main className="ac-pane ac-guidepane" aria-label={`Edit ${title}`} onBlurCapture={markTouched}>
          <div className="ac-edgrid">
            <div>
              <Field id="gw-title" label="Title" required error={err("title", "gw-title")} hint={autoTitle.current && autoTitle.current === g.title ? "Filled in from the video. You can change it." : ""}>
                <input id="gw-title" value={g.title || ""} maxLength={120} autoFocus={routeId === "new"} onChange={(e) => { autoTitle.current = null; up({ title: e.target.value }); }} placeholder="e.g. Exporting for Instagram" />
              </Field>
              <div className={"sb-field" + (err("category", "gw-cat") ? " has-err" : "")}><label htmlFor="gw-cat">Category<RequiredTag /></label>
                <CategorySelect id="gw-cat" value={g.category} onChange={(v) => up({ category: v })} />
                {err("category", "gw-cat") && <div className="ac-fielderr">{err("category", "gw-cat")}</div>}
              </div>
              <p className="ac-fieldhint" id="gw-content-hint">Content: add a video link, some text, or both. One of them is required to publish.</p>
              <Field id="gw-url" label="Video link (optional)" error={parsed && !parsed.ok ? parsed.reason : err("video", "gw-url") || err("content", "gw-url")} hint="YouTube, Vimeo or Google Drive. The video stays on its own site. Leave empty for a written resource.">
                <input id="gw-url" type="url" inputMode="url" value={url || ""} placeholder="Paste a video link" onChange={(e) => setVideoUrl(e.target.value)} aria-describedby="gw-content-hint" />
              </Field>
              {parsed?.ok && <VideoPreview parsed={parsed} meta={g.videoMeta} onMeta={onMeta} />}
              <RichTextField id="gw-body" label={kind === "video" ? "Notes (optional)" : "Text"} value={g.body} format={g.mdVersion || 1} onChange={(v, fmt) => up({ body: v, mdVersion: fmt })} rows={10} />
              <LinkList id="gw-links" label="Supporting links (optional)" hint="Paste a link; its name fills in automatically, and you can rename it." items={g.resources || []} onChange={(v) => up({ resources: v })} />
              <TopicsField id="gw-topics" value={g.topicIds || []} onChange={(v) => up({ topicIds: v })} legacy={g.topics || []} onLegacyChange={(v) => up({ topics: v })} category={g.category} />
            </div>
            <div>
              <ThumbnailChoice f={{ thumb: g.thumb, thumbMode: g.thumbMode, videoMeta: g.videoMeta }} set={(p) => up(p)} parsed={parsed?.ok ? parsed : null}
                picker={{ kind: "guideThumb", guideId: gid }} ensureTarget={store.ensureSaved}
                uploaded={{ current: { add: () => {} } }} toDelete={{ current: { add: (p) => store.imageReplaced(p) } }} />
              {kind === "video"
                ? <p className="ac-fieldhint">{g.videoMeta?.durationSec > 0 ? `Video length ${formatClock(g.videoMeta.durationSec)}, measured from the video.` : "The video's length is filled in from the provider when it's available."}</p>
                : <Field id="gw-read" label="Reading time (minutes, optional)" hint="An estimate shown to learners. It isn't a measured length.">
                    <input id="gw-read" type="number" min="0" inputMode="numeric" value={g.durationMinutes || ""} onChange={(e) => up({ durationMinutes: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                  </Field>}
              <p className="ac-cardsub">{GUIDE_KIND_LABEL[kind]}. Learners mark resources as reviewed themselves. It isn't a test and doesn't count toward any course.</p>
            </div>
          </div>
        </main>
      </PublishCheckCtx.Provider>
      {leaveGuard.dialog}
      {dialog === "unpublish" && <ConfirmDialog title={`Unpublish “${title}”?`} tone="warning" danger={false} confirmLabel="Unpublish" body="Learners stop seeing this resource straight away. Their reviews and the discussion are kept, and you can publish it again at any time." onConfirm={async () => { requireOnline(); await setGuideStatus(me, gid, "draft"); await store.refreshLive(); }} onClose={() => setDialog(null)} />}
      {dialog === "archive" && <ConfirmDialog title={`Archive “${title}”?`} tone="warning" danger={false} confirmLabel="Archive" body="Learners stop seeing this resource. It's kept, with its reviews and discussion. Restore it to a draft to publish it again." onConfirm={async () => { requireOnline(); await setGuideStatus(me, gid, "archived"); await store.refreshLive(); }} onClose={() => setDialog(null)} />}
      {dialog === "discard" && <ConfirmDialog title="Discard your unpublished changes?" tone="warning" danger={false} confirmLabel="Discard changes" body={`Your saved changes to “${title}” are removed and the editor goes back to the published version. Learners aren't affected, and reviews and discussion are kept.`}
        onConfirm={async () => { requireOnline(); store.markDiscarded(); await discardGuideDraft(gid); setUrl(null); await store.reload(); }} onClose={() => setDialog(null)} />}
      {dialog === "keepmine" && <ConfirmDialog title="Replace their changes with yours?" tone="warning" danger={false} confirmLabel="Replace with my version" body="Someone else saved this resource while you were editing. Keeping your version overwrites the changes they made." onConfirm={async () => { await store.overwriteRemote(); }} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <ConfirmDialog title={`Delete “${title}” permanently?`} confirmLabel="Delete resource" busyLabel="Deleting…"
        confirmDisabled={refsFailed || refs == null}
        blockedReason={refsFailed ? "Available after the check succeeds." : refs == null ? "Available once the check finishes." : ""}
        retry={refsFailed ? { label: "Retry", onClick: () => setCheckTry((n) => n + 1) } : null}
        body={liveStatus === "never" ? `“${title}” was never published, so no learner has seen it. Its draft and the images uploaded for it are deleted. This can't be undone.` : `“${title}” will be removed. This can't be undone.`}
        consequences={[liveStatus === "never" ? null : "Its discussion and learners' “reviewed” records are deleted, along with its draft and the images uploaded only for it. Images used elsewhere are kept.",
          // a never-published resource can be a learning-path step too (editors can add it before publishing)
          refsFailed ? "Couldn't check which learning paths include it. Nothing has been deleted." : refs == null ? "Checking learning paths…" : refs.length ? `${refs.length} learning path${refs.length === 1 ? " includes" : "s include"} it (${refs.map((p) => `“${p.title}”`).join(", ")}). That step will show as unavailable; nothing is marked complete.` : "No learning paths include it."].filter(Boolean)}
        onConfirm={async () => {
          requireOnline();
          const r = await deleteGuideHard(me, gid);
          leaveGuard.release();
          const dest = cat && tax.records.some((x) => x.id === cat.id) ? learnManagePath({ view: "category", id: cat.id }) : "/learn/manage";
          R.navigate(dest, { replace: true, state: { flash: `Deleted the resource “${title}”.${r.pendingCleared ? "" : " Some image clean-up is still pending."}` } });
        }} onClose={() => setDialog(null)} />}
    </div>
  );
}
