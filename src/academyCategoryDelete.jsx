/* Delete a category — and decide what happens to everything filed under it
   (admins). Steps: choose → review → run → done | partial (retry remaining).
   Pure logic: academyCategoryDeletion.js. Server: functions/
   academyCategoryDeletion.js (lock + re-check against the review, final
   delete) and the rules (nothing can be filed under a locked category). */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircleIcon, ExclamationTriangleIcon, EyeSlashIcon, DocumentTextIcon } from "@heroicons/react/24/outline";
import { BusyButton, Skeleton } from "./loading.jsx";
import { SmallDialog } from "./academyWorkspaceParts.jsx";
import { CoverThumb } from "./AcademyManage.jsx";
import { AppLink, VideoThumb } from "./academyShared.jsx";
import { learnManagePath } from "./nav.js";
import { requireOnline, isOfflineError } from "./useOnline.js";
import {
  categoryContents, moveCourseCategory, moveGuideCategory, movePathCategory, appendCourseOrder, deleteCourseHard, deleteGuideHard, deleteImage, pathsUsingGuide,
  lockCategoryForDeletion, finalizeCategoryDeletion, cancelCategoryDeletion, pathsUsingCourse, coursesRecommending,
} from "./academyData.js";
import { buildPlan, unresolved, reviewSummary, runCategoryDeletion, doneMessage, STATUS_LABEL } from "./academyCategoryDeletion.js";

const newPlanId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const store = (catId) => `ac-catdel-${catId}`;
const loadChoices = (catId) => { try { return JSON.parse(sessionStorage.getItem(store(catId)) || "null"); } catch { return null; } };
const saveChoices = (catId, v) => { try { sessionStorage.setItem(store(catId), JSON.stringify(v)); } catch { /* private mode: choices just aren't kept */ } };
const clearChoices = (catId) => { try { sessionStorage.removeItem(store(catId)); } catch { /* ignore */ } };

export function CategoryDeleteDialog({ me, catId, label, categories, onClose, onDone, R }) {
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const saved = useMemo(() => loadChoices(catId), [catId]);
  const [mode, setMode] = useState(saved?.mode || null);
  const [sharedDest, setSharedDest] = useState(saved?.sharedDest || "");
  const [rows, setRows] = useState(saved?.rows || {});
  const [pathDest, setPathDest] = useState(saved?.pathDest || {});
  const [sel, setSel] = useState([]);
  const [step, setStep] = useState("choose");
  const [planId, setPlanId] = useState(null);
  // Impact discovery for the CURRENT review only: { token, status: "loading"|"ok"|"error", refs }.
  // Destructive confirmation stays disabled until it is "ok" for this exact review.
  const [impact, setImpact] = useState(null);
  const [reviewed, setReviewed] = useState(null);      // snapshot the admin is confirming: { token, plan, planId, data }
  const reviewSeq = useRef(0);
  const refs = impact && impact.status === "ok" ? impact.refs : null;
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState({});
  const [report, setReport] = useState(null);
  const [resumePlan, setResumePlan] = useState(null);
  const busy = useRef(false);
  const cancelRef = useRef(null);

  const others = categories.filter((c) => c.id !== catId && !c.bootstrap);
  const labelOf = (id) => `“${others.find((c) => c.id === id)?.label || id}”`;
  const hiddenDest = (id) => !!others.find((c) => c.id === id)?.hidden;

  const load = useCallback(async () => {
    setLoadErr("");
    try {
      const d = await categoryContents(catId);
      setData(d);
      // a stored plan may predate a section (e.g. a lock from before tips & resources): fill the gaps
      if (d.lock && d.lock.plan) { setResumePlan({ courses: {}, guides: {}, paths: {}, ...d.lock.plan }); setPlanId(d.lock.planId); setStep("resume"); }
      return d;
    } catch (e) { setLoadErr(isOfflineError(e) ? "You're offline. Reconnect to see what's in this category." : "Couldn't check what's in this category. Try again."); return null; }
  }, [catId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (step === "choose") saveChoices(catId, { mode, sharedDest, rows, pathDest }); }, [catId, mode, sharedDest, rows, pathDest, step]);
  useEffect(() => { cancelRef.current?.focus(); }, [step]);

  const courses = data?.courses || [], guides = data?.guides || [], paths = data?.paths || [];
  const empty = data && !courses.length && !guides.length && !paths.length;
  const plan = useMemo(() => (data ? buildPlan({ mode: empty ? "delete-all" : mode, courses, guides, paths, sharedDest, rows, pathDest }) : null),
    [data, empty, mode, courses, guides, paths, sharedDest, rows, pathDest]);
  const content = [...courses, ...guides];                          // everything that can be moved or deleted
  const todo = plan ? unresolved(plan, { courses, guides, paths }, others.map((c) => c.id)) : [];
  const summary = plan ? reviewSummary(plan, { category: `“${label}”`, courses, guides, labelOf }) : null;

  const setRow = (id, patch) => setRows((r) => ({ ...r, [id]: { ...(r[id] || {}), ...patch } }));
  const bulk = (action) => { setRows((r) => { const n = { ...r }; for (const id of sel) n[id] = { ...(n[id] || {}), action }; return n; }); };

  /* Find the learning paths / recommendations that use what's being deleted.
     Every lookup must succeed: a failed one is shown with Retry and never
     enables the destructive button. A result from an older review is ignored. */
  const discoverImpact = async (snap) => {
    setImpact({ token: snap.token, status: "loading" });
    const del = snap.data.courses.filter((c) => snap.plan.courses[c.id]?.action === "delete");
    const gdel = snap.data.guides.filter((g) => snap.plan.guides[g.id]?.action === "delete");
    try {
      const out = { paths: [], recs: [] };
      for (const g of gdel) {
        const ps = await pathsUsingGuide(g.id);
        for (const p of ps || []) out.paths.push({ path: p.title, course: g.title });
      }
      for (const c of del) {
        const [ps, rs] = await Promise.all([pathsUsingCourse(c.id), coursesRecommending(c.id)]);
        for (const p of ps || []) if (!snap.data.paths.some((x) => x.id === p.id)) out.paths.push({ path: p.title, course: c.title });
        for (const r of rs || []) if (!del.some((x) => x.id === r.id)) out.recs.push({ by: r.title, course: c.title });
      }
      if (reviewSeq.current === snap.token) setImpact({ token: snap.token, status: "ok", refs: out });
    } catch (e) {
      if (reviewSeq.current === snap.token) setImpact({ token: snap.token, status: "error", message: isOfflineError(e) ? "You're offline." : (e?.message || "") });
    }
  };
  const toReview = async () => {
    if (todo.length) return;
    const token = ++reviewSeq.current;
    const snap = { token, plan, planId: newPlanId(), data };
    setNotice(""); setPlanId(snap.planId); setReviewed(snap); setStep("review");
    await discoverImpact(snap);
  };
  const backToChoose = () => { reviewSeq.current++; setReviewed(null); setImpact(null); setStep("choose"); };
  const confirmReady = !!reviewed && !!impact && impact.token === reviewed.token && impact.status === "ok";

  const items = (src, p) => [
    ...src.courses.filter((c) => p.courses[c.id]).map((c) => ({ type: "course", id: c.id, title: c.title, draftToo: !!p.courses[c.id].draftDest })),
    ...src.guides.filter((g) => p.guides[g.id]).map((g) => ({ type: "guide", id: g.id, title: g.title, draftToo: !!(p.guides[g.id] && p.guides[g.id].draftDest) })),
    ...src.paths.filter((x) => x.id in p.paths).map((x) => ({ type: "path", id: x.id, title: x.title })),
  ];
  const execute = async (p, id, src) => {
    if (busy.current) return;                                    // double clicks
    busy.current = true; setNotice(""); setStep("running"); setProgress({});
    try {
      requireOnline();
      const expected = { courses: src.courses.map((c) => ({ id: c.id, fp: c.fp })), guides: src.guides.map((g) => ({ id: g.id, fp: g.fp })), paths: src.paths.map((x) => x.id) };
      const r = await runCategoryDeletion({
        plan: p, items: items(src, p),
        onProgress: (it, st) => setProgress((x) => ({ ...x, [`${it.type}:${it.id}`]: st })),
        ops: {
          lock: () => lockCategoryForDeletion({ categoryId: catId, planId: id, expected, plan: p }),
          deleteCourse: (cid) => deleteCourseHard(me, cid),
          deleteGuide: (gid) => deleteGuideHard(me, gid),
          move: (it, dest) => it.type === "course" ? moveCourseCategory(me, it.id, src.ids, dest, { draftToo: it.draftToo })
            : it.type === "guide" ? moveGuideCategory(me, it.id, dest, { fromIds: src.ids, draftToo: it.draftToo }) : movePathCategory(me, it.id, dest),
          appendOrder: (dest, ids) => appendCourseOrder(me, dest, ids),
          finalize: () => finalizeCategoryDeletion(catId, id),
          deleteCover: (path) => deleteImage(path),
        },
      });
      if (r.stage === "done") { clearChoices(catId); onDone(doneMessage(r, label, p)); return; }
      if (r.stage === "changed" || r.stage === "invalid") {
        const fresh = await load();
        reviewSeq.current++; setReviewed(null); setImpact(null);       // the reviewed plan is void: review again
        setStep("choose"); setPlanId(null);
        setNotice(r.changes ? `Something in “${label}” changed after you reviewed it, so nothing was deleted or moved: ${r.changes.map((c) => `${c.title ? `“${c.title}”` : `a ${c.type}`} was ${c.kind}`).join("; ")}. Check the choices below, then review again.`
          : `Nothing was changed: ${(r.problems || []).join(" ")}`);
        if (fresh) setData(fresh);
        return;
      }
      setReport(r); setStep("partial");
    } catch (e) {
      setNotice(isOfflineError(e) ? "You're offline or the connection dropped. Reconnect, then try again. Anything already done stays done." : `${e?.message || "Something went wrong."} Anything already done stays done.`);
      const fresh = await load();
      if (fresh && fresh.lock) { setReport(null); setStep("resume"); }
      else { if (fresh) setData(fresh); reviewSeq.current++; setReviewed(null); setImpact(null); setStep("choose"); }   // nothing locked: review again from fresh data
    } finally { busy.current = false; }
  };
  const retryRemaining = async () => {
    const fresh = await load();
    if (!fresh) return;
    const p = resumePlan || plan;
    await execute(p, planId, fresh);
  };
  const stopDeleting = async () => {
    if (busy.current) return; busy.current = true;
    try { requireOnline(); await cancelCategoryDeletion(catId); clearChoices(catId); onClose({ stopped: true }); }
    catch (e) { setNotice(e?.message || "Couldn't stop. Try again."); }
    finally { busy.current = false; }
  };

  /* ---------------- render ---------------- */
  const destSelect = (id, value, onChange, { allowNone = false, placeholder = "Choose a category…" } = {}) => (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled={!allowNone}>{allowNone ? "No category" : placeholder}</option>
      {others.map((c) => <option key={c.id} value={c.id}>{c.label}{c.hidden ? " (hidden)" : ""}</option>)}
    </select>
  );
  const statusChip = (c) => <span className="ac-cardsub">{STATUS_LABEL[c.status]}{c.type === "guide" ? ` · ${c.kind === "video" ? "Video" : "Written"}` : ""}</span>;
  const renderRow = (c, type) => {
    const r = rows[c.id] || {};
    return (
      <li key={c.id} className={"ac-cdrow" + (sel.includes(c.id) ? " sel" : "")}>
        <input type="checkbox" checked={sel.includes(c.id)} onChange={() => setSel((x) => (x.includes(c.id) ? x.filter((y) => y !== c.id) : [...x, c.id]))} aria-label={`Select ${c.title}`} />
        {type === "course" ? <CoverThumb imageRef={c.cover} /> : <VideoThumb item={c} className="ac-cdthumb16" placeholder={<DocumentTextIcon className="hi" aria-hidden="true" />} />}
        <span className="ac-cdtitle"><b>{c.title}</b>{statusChip(c)}
          {c.draftConflict && <span className="ac-cdhint">Its unpublished changes move it to {labelOf(type === "course" ? c.draftCategory : c.category)}.</span>}
          {c.publishedElsewhere && <span className="ac-cdhint">Published in {labelOf(c.liveCategory)}; only its unpublished changes are filed here.</span>}</span>
        <span className="ac-cdact">
          <select aria-label={`What happens to ${c.title}`} value={r.action || ""} onChange={(e) => setRow(c.id, { action: e.target.value })}>
            <option value="" disabled>Choose…</option><option value="move">Move</option><option value="delete" disabled={c.publishedElsewhere}>Delete</option>
          </select>
          {r.action === "move" && (
            <select aria-label={`Move ${c.title} to`} value={r.dest || ""} onChange={(e) => setRow(c.id, { dest: e.target.value })}>
              <option value="">{sharedDest ? `Same as above (${others.find((o) => o.id === sharedDest)?.label})` : "Choose a category…"}</option>
              {others.map((o) => <option key={o.id} value={o.id}>{o.label}{o.hidden ? " (hidden)" : ""}</option>)}
            </select>
          )}
          {r.action === "move" && c.draftConflict && <label className="ac-cdcheck"><input type="checkbox" checked={!!r.draftToo} onChange={(e) => setRow(c.id, { draftToo: e.target.checked })} /><span>Also use this category for its unpublished changes</span></label>}
        </span>
      </li>
    );
  };
  const destHint = (d) => d && hiddenDest(d) ? <span className="ac-cdhint"><EyeSlashIcon className="hi hi-xs" aria-hidden="true" />{labelOf(d)} is hidden, so learners won't see anything moved there until it's shown.</span> : null;

  let body, actions, title = `Delete “${label}”`;
  if (!data) {
    body = loadErr ? <p className="ac-fielderr" role="alert">{loadErr} <button type="button" className="ac-link" onClick={load}>Try again</button></p> : <Skeleton lines={4} />;
    actions = <button ref={cancelRef} type="button" className="sb-btn ghost compact" onClick={() => onClose()}>Cancel</button>;
  } else if (step === "resume") {
    const remaining = items(data, resumePlan || { courses: {}, guides: {}, paths: {} });
    title = `Finish deleting “${label}”?`;
    body = (
      <div className="ac-dlgbody">
        <p><b>Deleting “{label}” was started{data.lock?.byName ? ` by ${data.lock.byName}` : ""} but isn't finished.</b> {remaining.length ? `${remaining.length} item${remaining.length === 1 ? " is" : "s are"} still filed here:` : "Nothing is filed here any more."}</p>
        {remaining.length > 0 && <ul className="ac-dlglist">{remaining.map((it) => { const a = it.type === "course" ? resumePlan.courses[it.id] : it.type === "guide" ? resumePlan.guides[it.id] : null; const what = it.type === "course" ? "course" : it.type === "guide" ? "tip or resource" : "learning path"; return <li key={`${it.type}:${it.id}`}>{it.title} <span className="ac-cardsub">({what}, {a ? (a.action === "delete" ? "to delete" : `to move to ${labelOf(a.dest)}`) : resumePlan.paths[it.id] ? `to move to ${labelOf(resumePlan.paths[it.id])}` : "to have no category"})</span></li>; })}</ul>}
        <p className="ac-cardsub">While it's being deleted, nothing new can be added to or published in “{label}”. Anything already deleted can't be restored; moved content stays where it is.</p>
        {notice && <p className="ac-fielderr" role="alert">{notice}</p>}
      </div>
    );
    actions = <>
      <button ref={cancelRef} type="button" className="sb-btn ghost compact" onClick={() => onClose()}>Close for now</button>
      <button type="button" className="sb-btn ghost compact" onClick={stopDeleting}>Stop and keep the category</button>
      <BusyButton className="sb-btn danger compact" busy={false} onClick={retryRemaining}>{remaining.length ? `Finish: ${remaining.length} remaining` : "Delete the category"}</BusyButton>
    </>;
  } else if (step === "running") {
    body = (
      <div className="ac-dlgbody" role="status" aria-live="polite">
        <p><b>Working…</b> Keep this window open.</p>
        <ul className="ac-pubresults">{items(data, resumePlan || plan).map((it) => { const st = progress[`${it.type}:${it.id}`]; return <li key={`${it.type}:${it.id}`} className={st === "done" ? "ok" : st === "failed" ? "fail" : ""}><span><b>{it.title}</b>: {st === "done" ? "done" : st === "failed" ? "failed" : st === "working" ? "working…" : "waiting"}</span></li>; })}</ul>
      </div>
    );
    actions = <BusyButton className="sb-btn danger compact" busy busyLabel="Deleting…" onClick={() => {}}>Deleting…</BusyButton>;
  } else if (step === "partial" && report) {
    title = `“${label}” wasn't deleted yet`;
    const remaining = report.failed.length + ((report.remaining || []).length);
    body = (
      <div className="ac-dlgbody" role="alert">
        <p><b>Some items couldn't be handled, so “{label}” still exists.</b> Nothing new can be added to it until you finish or stop.</p>
        {report.moved.length > 0 && <><h3 className="ac-h3">Moved</h3><ul className="ac-pubresults">{report.moved.map((m) => <li key={`${m.type}:${m.id}`} className="ok"><CheckCircleIcon className="hi hi-sm" aria-hidden="true" /><span><b>{m.title}</b> to {m.dest ? <AppLink className="ac-link inline" to={learnManagePath({ view: "category", id: m.dest })} navigate={(to) => { onClose(); R.navigate(to); }}>{labelOf(m.dest)}</AppLink> : "no category"}</span></li>)}</ul></>}
        {report.deleted.length > 0 && <><h3 className="ac-h3">Permanently deleted</h3><ul className="ac-pubresults">{report.deleted.map((d) => <li key={d.id} className="ok"><CheckCircleIcon className="hi hi-sm" aria-hidden="true" /><span><b>{d.title}</b></span></li>)}</ul></>}
        <h3 className="ac-h3">Still to do ({remaining})</h3>
        <ul className="ac-pubresults">
          {report.failed.map((f) => <li key={`${f.type}:${f.id}`} className="fail"><ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" /><span><b>{f.title}</b>: {f.message}</span></li>)}
          {(report.remaining || []).map((f) => <li key={`r:${f.type}:${f.id}`} className="fail"><ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" /><span><b>{f.title}</b> is still filed here.</span></li>)}
        </ul>
        {report.cleanupPending.length > 0 && <p className="ac-cardsub">Some clean-up (old images, progress or review records) for deleted items is still pending. It doesn't affect learners.</p>}
        {report.warnings.map((w, i) => <p key={i} className="ac-cardsub">{w}</p>)}
        <p className="ac-cardsub">Retrying only handles what's left. Anything already deleted can't be restored.</p>
        {notice && <p className="ac-fielderr">{notice}</p>}
      </div>
    );
    actions = <>
      <button ref={cancelRef} type="button" className="sb-btn ghost compact" onClick={() => onClose()}>Close for now</button>
      <button type="button" className="sb-btn ghost compact" onClick={stopDeleting}>Stop and keep the category</button>
      <button type="button" className="sb-btn danger compact" onClick={retryRemaining}>Retry remaining</button>
    </>;
  } else if (step === "review") {
    const conflicts = [...courses.filter((c) => plan.courses[c.id]?.action === "move" && c.draftConflict).map((c) => ({ ...c, a: plan.courses[c.id] })),
      ...guides.filter((g) => plan.guides[g.id]?.action === "move" && g.draftConflict).map((g) => ({ ...g, a: plan.guides[g.id], draftCategory: g.category }))];
    const typeLabel = (x) => (x.type === "guide" || x.kind ? "Tip or resource" : "Course");
    body = (
      <div className="ac-dlgbody">
        <p className="ac-cdsummary"><b>{summary.sentence}</b></p>
        {Object.entries(summary.byDest).map(([d, cs]) => (
          <section key={d} className="ac-dlgsec">
            <h3 className="ac-h3">Move to {labelOf(d)} ({cs.length})</h3>
            <ul className="ac-dlglist">{cs.map((c) => <li key={c.id}>{typeLabel(c)}: {c.title} <span className="ac-cardsub">({STATUS_LABEL[c.status]})</span></li>)}</ul>
            {destHint(d)}
          </section>
        ))}
        {summary.moves.length + summary.gmoves.length > 0 && <p className="ac-cardsub">Moved content keeps everything: courses keep their lessons, quizzes, discussions, images, learner progress and completions; tips & resources keep their discussion, learners' “reviewed” records, images and drafts. Both keep their place in learning paths. Nothing is published, restored or shown because of the move: unpublished changes stay unpublished, archived content stays archived.</p>}
        {conflicts.map((c) => <p key={c.id} className="ac-cdconflict"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" />“{c.title}” has unpublished changes that move it to {others.some((o) => o.id === c.draftCategory) ? labelOf(c.draftCategory) : "another category"}. {rows[c.id]?.draftToo ? `Its draft will use ${labelOf(c.a.dest)} too.` : "That stays as it is, so publishing those changes will move it there."}</p>)}
        {summary.dels.length + summary.gdels.length > 0 && (
          <section className="ac-dlgsec">
            <h3 className="ac-h3">Permanently delete ({summary.dels.length + summary.gdels.length})</h3>
            <ul className="ac-dlglist">{[...summary.dels, ...summary.gdels.map((g) => ({ ...g, type: "guide" }))].map((c) => <li key={c.id}>{typeLabel(c)}: {c.title} <span className="ac-cardsub">({STATUS_LABEL[c.status]})</span></li>)}</ul>
            {summary.dels.length > 0 && <p className="ac-cardsub">Deleting a course removes its lessons, quizzes, discussions, draft and the images uploaded only for it, and everyone's progress and quiz results for it.</p>}
            {summary.gdels.length > 0 && <p className="ac-cardsub">Deleting a tip or resource removes its discussion, learners' “reviewed” records, its draft and the thumbnails uploaded only for it.</p>}
            <p className="ac-cardsub">Images used elsewhere are kept. Published items disappear from Learn straight away. This can't be undone.</p>
            {impact?.status === "error" ? (
              <div className="ac-cdimpacterr" role="alert">
                <p className="ac-fielderr">Couldn't check which learning paths and recommendations use these items{impact.message ? ` (${impact.message.replace(/\.$/, "")})` : ""}. Nothing has been deleted.</p>
                <button type="button" className="sb-btn compact" onClick={() => reviewed && discoverImpact(reviewed)}>Retry</button>
              </div>
            ) : !refs ? <p className="ac-cardsub" role="status">Checking where these are used…</p> : <>
              {refs.paths.map((x, i) => <p key={`p${i}`} className="ac-cardsub">The learning path “{x.path}” includes “{x.course}”. That step will show as unavailable; nothing is marked complete.</p>)}
              {refs.recs.map((x, i) => <p key={`r${i}`} className="ac-cardsub">“{x.by}” recommends “{x.course}” as prior knowledge. Learners stop seeing it there.</p>)}
            </>}
          </section>
        )}
        {paths.length > 0 && (
          <section className="ac-dlgsec">
            <h3 className="ac-h3">Learning paths filed here</h3>
            <ul className="ac-dlglist">
              {paths.map((x) => <li key={x.id}>Learning path “{x.title}”: {plan.paths[x.id] ? `move to ${labelOf(plan.paths[x.id])}` : "keep it, with no category"}</li>)}
            </ul>
          </section>
        )}
        {notice && <p className="ac-fielderr" role="alert">{notice}</p>}
      </div>
    );
    actions = <>
      <button ref={cancelRef} type="button" className="sb-btn ghost compact" onClick={backToChoose}>Back</button>
      <button type="button" className="sb-btn ghost compact" onClick={() => onClose()}>Cancel</button>
      <span className="ac-cdfinal"><BusyButton className="sb-btn danger compact" busy={false} disabled={!confirmReady} aria-describedby="cd-final-note"
          onClick={() => { if (confirmReady) execute(reviewed.plan, reviewed.planId, reviewed.data); }}>{summary.button}</BusyButton>
        <span id="cd-final-note" className="ac-cardsub">{confirmReady ? `The category “${label}” is also deleted.`
          : impact?.status === "error" ? "Available after the check succeeds. Retry above." : "Available once the check above finishes."}</span></span>
    </>;
  } else if (empty) {
    body = (
      <div className="ac-dlgbody">
        <p>“{label}” has no courses, tips & resources or learning paths, so only the category itself is deleted.</p>
        {notice && <p className="ac-fielderr" role="alert">{notice}</p>}
      </div>
    );
    actions = <>
      <button ref={cancelRef} type="button" className="sb-btn ghost compact" onClick={() => onClose()}>Cancel</button>
      <BusyButton className="sb-btn danger compact" busy={false} onClick={() => { const id = newPlanId(); setPlanId(id); execute({ courses: {}, guides: {}, paths: {} }, id, data); }}>Delete category</BusyButton>
    </>;
  } else {
    const noDest = others.length === 0;
    body = (
      <div className="ac-dlgbody">
        <p>“{label}” has {[courses.length ? `${courses.length} course${courses.length === 1 ? "" : "s"}` : "", guides.length ? `${guides.length} tip${guides.length === 1 ? "" : "s"} or resource${guides.length === 1 ? "" : "s"}` : "", paths.length ? `${paths.length} learning path${paths.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")}. Choose what happens to {content.length + paths.length === 1 ? "it" : "them"}.</p>
        {notice && <p className="ac-fielderr" role="alert">{notice}</p>}
        {content.length > 0 && (
          <fieldset className="ac-cdmodes">
            <legend className="sb-vh">What happens to the courses and tips & resources</legend>
            {[["move-all", "Move all content to another category", ""], ["delete-all", "Delete the category and its courses and tips & resources", `Permanently deletes ${[courses.length ? `${courses.length} course${courses.length === 1 ? "" : "s"}` : "", guides.length ? `${guides.length} resource${guides.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}, including published ones.`], ["each", "Choose individually", ""]].map(([v, t, sub2]) => (
              <label key={v} className={"ac-opt" + (mode === v ? " on" : "")}><input type="radio" name="cdmode" value={v} checked={mode === v} onChange={() => setMode(v)} /><span>{t}{sub2 && <span className="ac-cardsub"> {sub2}</span>}</span></label>
            ))}
          </fieldset>
        )}
        {(mode === "move-all" || mode === "each") && (
          <div className="sb-field">
            <label htmlFor="cd-dest">{mode === "each" ? "Move to (unless you choose otherwise below)" : "Move everything to"}</label>
            {noDest ? <p className="ac-fielderr">There's no other category to move content to. Create one first; your choices here are kept.</p> : destSelect("cd-dest", sharedDest, setSharedDest)}
            {destHint(sharedDest)}
          </div>
        )}
        {mode === "each" && (
          <section className="ac-dlgsec" aria-labelledby="cd-each-h">
            <h3 className="ac-h3 sb-vh" id="cd-each-h">Choose for each item</h3>
            <div className="ac-cdbulk" role="group" aria-label="Bulk actions">
              <label className="ac-cdcheck"><input type="checkbox" checked={sel.length === content.length && content.length > 0} ref={(el) => { if (el) el.indeterminate = sel.length > 0 && sel.length < content.length; }}
                onChange={(e) => setSel(e.target.checked ? content.map((c) => c.id) : [])} /><span>Select all</span></label>
              <span className="ac-cardsub" aria-live="polite">{sel.length ? `${sel.length} selected` : "None selected"}</span>
              <button type="button" className="sb-btn ghost compact" disabled={!sel.length} onClick={() => bulk("move")}>Move selected</button>
              <button type="button" className="sb-btn ghost compact" disabled={!sel.length} onClick={() => bulk("delete")}>Delete selected</button>
            </div>
            {[["Courses", courses], ["Tips & resources", guides]].filter(([, xs]) => xs.length).map(([heading, xs]) => (
              <React.Fragment key={heading}>
                <h4 className="ac-pubgroup">{heading} ({xs.length})</h4>
                <ul className="ac-cdrows">{xs.map((c) => renderRow(c, heading === "Courses" ? "course" : "guide"))}</ul>
              </React.Fragment>
            ))}
          </section>
        )}
        {(mode === "move-all" || mode === "delete-all") && content.length > 0 && (
          <details className="ac-details"><summary>See the {content.length} item{content.length === 1 ? "" : "s"}</summary>
            <ul className="ac-dlglist">{content.map((c) => <li key={c.id}>{c.type === "guide" ? "Tip or resource" : "Course"}: {c.title} <span className="ac-cardsub">({STATUS_LABEL[c.status]})</span>{c.publishedElsewhere && mode === "delete-all" ? <span className="ac-fielderr"> Published in another category, so it can't be deleted from here.</span> : null}</li>)}</ul></details>
        )}
        {paths.length > 0 && (
          <section className="ac-dlgsec" aria-labelledby="cd-other-h">
            <h3 className="ac-h3" id="cd-other-h">Learning paths filed here</h3>
            <p className="ac-cardsub">Learning paths aren't deleted here. Choose a category for each, or keep it with no category.{sharedDest && <> <button type="button" className="ac-link inline" onClick={() => setPathDest(Object.fromEntries(paths.map((x) => [x.id, sharedDest])))}>Use {labelOf(sharedDest)} for all of them</button></>}</p>
            <ul className="ac-cdrows">
              {paths.map((x) => <li key={x.id} className="ac-cdrow other"><span className="ac-cdtitle"><b>{x.title}</b><span className="ac-cardsub">Learning path</span></span><span className="ac-cdact">
                <select aria-label={`Category for ${x.title}`} value={x.id in pathDest ? (pathDest[x.id] || "__none") : ""} onChange={(e) => setPathDest((d) => ({ ...d, [x.id]: e.target.value === "__none" ? "" : e.target.value }))}>
                  <option value="" disabled>Choose…</option><option value="__none">No category (keep the path)</option>
                  {others.map((o) => <option key={o.id} value={o.id}>{o.label}{o.hidden ? " (hidden)" : ""}</option>)}
                </select></span></li>)}
            </ul>
          </section>
        )}
        {(mode || !content.length) && todo.length > 0 && <p className="ac-cardsub" role="status">{todo.length === 1 ? todo[0] : `${todo.length} items still need a choice. ${todo[0]}`}</p>}
      </div>
    );
    actions = <>
      <button ref={cancelRef} type="button" className="sb-btn ghost compact" onClick={() => onClose()}>Cancel</button>
      <button type="button" className="sb-btn compact" disabled={(!mode && content.length > 0) || todo.length > 0} onClick={toReview}>Review…</button>
    </>;
  }
  return <SmallDialog title={title} onClose={() => { if (step !== "running") onClose(); }} actions={actions}><div className="ac-catdel">{body}</div></SmallDialog>;
}
