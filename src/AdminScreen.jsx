/* ===================================================================
   ADMIN SCREEN — lazy-loaded surface (React.lazy in App.jsx).

   This is the entire admin dashboard (overview, content triage, people/removal,
   events, issue log, CSV import). It's gated by `tab === "admin" && isAdmin`, so
   the dynamic import only runs for an admin who opens Admin — non-admins never
   download this chunk. Shared UI primitives are imported from ./App.jsx (kept in
   the main chunk, not duplicated); everything else comes from the real modules.
   =================================================================== */
import React, { useState, useEffect, useMemo, useRef } from "react";
import { db } from "./firebase";
import { collection, doc, updateDoc, addDoc, serverTimestamp } from "firebase/firestore";
import {
  ArrowUpTrayIcon, BoltIcon, CalendarDaysIcon, CheckCircleIcon, ChevronDownIcon,
  ChevronRightIcon, FunnelIcon, PlusIcon, SparklesIcon, UserGroupIcon, ViewColumnsIcon, XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  ADMIN_FILTERS, PEOPLE_FILTERS, adminHealth, adminNeedsAttention, adminReadyToMove,
  applyAdminFilter, applyPeopleFilter, daysTo, fmt, groupPeople, initials, isAvailable,
  matchTier, occurrenceContentCount, parseCSV, pendingMatches, recentActivity, reconcileNames,
  roleChips, rowToTask, searchPeople, searchTasks, sheetCsvUrl, sortTasks, statusClass,
  taskProblem, typeClass, userActiveTasks, userDepartments,
} from "./data";
import { upcomingEvents, seriesFromDoc, seriesCadenceLabel, nextOccurrences } from "./events";
import {
  Portal, ConfirmDialog, KebabMenu, Toggle, eventPrefill, fmtEventDate,
  loadPref, savePref, useUnsavedGuard, ENABLE_CSV_IMPORT,
} from "./App.jsx";

/* Shared kebab actions for an admin content card. */
const adminKebab = (t, h) => [
  { label:"Open", onClick:()=>h.open(t.id) },
  { label:"Edit", onClick:()=>h.edit(t) },
  { label:"Duplicate", onClick:()=>h.duplicate(t) },
  ...(t.status!=="Posted" ? [{ label:"Archive", onClick:()=>h.archive(t) }] : []),
  { label:"Delete", danger:true, onClick:()=>h.del(t.id, t.title) },
];

/* Admin content card — surfaces status, owner, the problem (blocker/gap) and
   due date up front so an admin can triage without opening the card. */
function AdminTaskCard({ t, h }) {
  const problem = taskProblem(t);
  const d = daysTo(t.postDate);
  const dueCls = d===null?"due-ok":d<0?"due-over":d<=2?"due-soon":"due-ok";
  const ownerLabel = t.owner==="Pending" ? (t.ownerSuggested?`Pending: ${t.ownerSuggested}`:"Pending") : (t.owner||"Unassigned");
  const canAuto = h.auto && t.status!=="Posted" && !((t.support||[]).length);
  return (
    <div className="sb-task sb-task-act" role="button" tabIndex={0}
      onClick={()=>h.open(t.id)}
      onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); h.open(t.id); } }}>
      <div className="row1"><span className="title">{t.title}</span>
        <div className="sb-row1end">
          <KebabMenu items={adminKebab(t, h)} />
        </div></div>
      <div className="sb-cardstatus">
        <span className={"sb-status "+statusClass(t.status)}><span className="pip"/>{t.status}</span>
        {t.status!=="Posted" && <span className={"sb-due "+dueCls}>Due {fmt(t.postDate)}</span>}
      </div>
      {problem && <div className="sb-problem">⚠ {problem}</div>}
      <div className="sub"><span>Owner <b>{ownerLabel}</b></span></div>
      {canAuto && <div className="sb-btnrow" style={{marginTop:8}} onClick={e=>e.stopPropagation()}>
        <button className="sb-btn gold compact" onClick={()=>h.auto(t)}><BoltIcon className="hi hi-sm" aria-hidden="true"/> Auto-assign crew</button>
      </div>}
    </div>
  );
}

/* Admin-managed recurring events. The "next occurrence" date anchors the
   pattern (its weekday / calendar day define the rule) and all future dates
   are calculated forward from it. Edits apply to FUTURE occurrences only;
   linked content tasks are never modified or deleted. */
const EVENT_FREQS = [
  ["weekly","Every N weeks (same weekday)"],
  ["monthly-day","Every N months (same calendar day)"],
  ["monthly-weekday","Every N months (nth weekday, from the date)"],
  ["monthly-last-weekday","Every N months (last weekday of month)"],
  ["monthly-last-day","Every N months (last day of month)"],
  ["yearly","Every year (same date)"],
];
function AdminEvents({ series }) {
  const [edit, setEdit] = useState(null); // null | "new" | doc
  const save = async (f) => {
    const data = { name:f.name.trim(), emoji:f.emoji.trim(), frequency:f.frequency,
      interval:Math.max(1,Number(f.interval)||1), anchorDate:f.anchorDate, endDate:f.endDate||"",
      description:f.description||"", active:f.active!==false, showOnHome:f.showOnHome!==false,
      archived:!!f.archived, updatedAt: serverTimestamp() };
    if (f.id) await updateDoc(doc(db,"eventSeries",f.id), data);
    else await addDoc(collection(db,"eventSeries"), { ...data, createdAt: serverTimestamp() });
    setEdit(null);
  };
  const toggle = (d, patch) => updateDoc(doc(db,"eventSeries",d.id), { ...patch, updatedAt: serverTimestamp() });
  const live = (series||[]).filter(d=>!d.archived);
  return (
    <div>
      <div className="sb-toolbar" style={{marginBottom:14}}>
        <button className="sb-btn compact" onClick={()=>setEdit("new")}><PlusIcon className="hi hi-sm" aria-hidden="true"/> New recurring event</button>
      </div>
      <div className="sb-sub" style={{marginTop:0}}>Built-in series (birthdays, holidays, Cross Over, Praise &amp; Testimony, Mini Vigil) stay managed in configuration. Events created here appear on Home automatically.</div>
      {live.length===0
        ? <div className="sb-empty compact">No custom recurring events yet.</div>
        : <div className="sb-list" style={{gridTemplateColumns:"1fr"}}>
            {live.map(d => {
              const sd = seriesFromDoc({ ...d, active:true });
              const next = sd ? nextOccurrences(sd.rule, new Date(), 1)[0] : null;
              return (
                <div className="sb-task" key={d.id} style={{cursor:"default"}}>
                  <div className="row1">
                    <span className="title" style={{fontSize:14.5}}>
                      {d.emoji && <span className="sb-emoji" style={{marginRight:6}}>{d.emoji}</span>}{d.name}
                      {d.active===false && <span className="sb-tag" style={{marginLeft:8}}>Paused</span>}
                    </span>
                  </div>
                  <div className="sub">
                    <span>{seriesCadenceLabel(d)}</span>
                    <span>{next ? `Next: ${fmtEventDate(next)}` : "No upcoming dates"}</span>
                  </div>
                  <div className="sb-btnrow" style={{marginTop:8}}>
                    <button className="sb-btn ghost compact" onClick={()=>setEdit(d)}>Edit</button>
                    <button className="sb-tertiary" onClick={()=>toggle(d,{active:d.active===false})}>{d.active===false?"Resume":"Pause"}</button>
                    <button className="sb-tertiary" onClick={()=>toggle(d,{archived:true})}>Archive</button>
                  </div>
                </div>
              );
            })}
          </div>}
      {edit && <EventSeriesEditor doc={edit==="new"?null:edit} onSave={save} onClose={()=>setEdit(null)} />}
    </div>
  );
}
function EventSeriesEditor({ doc: d, onSave, onClose }) {
  const [f, setF] = useState(d ? { ...d } : { name:"", emoji:"", description:"", frequency:"monthly-weekday",
    interval:1, anchorDate:"", endDate:"", active:true, showOnHome:true });
  const set=(k,v)=>setF(p=>({...p,[k]:v}));
  const valid = f.name.trim() && f.anchorDate;
  const initial = useRef(JSON.stringify(f));
  const isDirty = JSON.stringify(f) !== initial.current;
  const { requestClose, leaveGuard } = useUnsavedGuard(isDirty, onClose);
  const preview = valid ? (() => {
    const sd = seriesFromDoc({ ...f, active:true });
    return sd ? nextOccurrences(sd.rule, new Date(), 3).map(fmtEventDate) : [];
  })() : [];
  return (
    <Portal>
    <div className="sb-scrim" onClick={requestClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()} role="dialog" aria-label="Recurring event">
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>{d?"Edit recurring event":"New recurring event"}</b>
          <button className="sb-x" onClick={requestClose} aria-label="Close"><XMarkIcon className="hi" aria-hidden="true"/></button></div>
        <div className="bd">
          <div className="sb-btnrow">
            <div className="sb-field" style={{flex:1}}><label>Event name<span className="sb-req" aria-hidden="true">*</span></label>
              <input value={f.name} onChange={e=>set("name",e.target.value)} placeholder="e.g. Praise Night" /></div>
            <div className="sb-field" style={{width:90}}><label>Emoji</label>
              <input value={f.emoji} onChange={e=>set("emoji",e.target.value)} placeholder="🎤" maxLength={4} /></div>
          </div>
          <div className="sb-field"><label>Description (optional)</label>
            <input value={f.description||""} onChange={e=>set("description",e.target.value)} /></div>
          <div className="sb-btnrow">
            <div className="sb-field" style={{flex:2}}><label>Repeats</label>
              <select value={f.frequency} onChange={e=>set("frequency",e.target.value)}>
                {EVENT_FREQS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
            <div className="sb-field" style={{width:110}}><label>Every N</label>
              <input type="number" min="1" max="12" value={f.interval} onChange={e=>set("interval",e.target.value)} /></div>
          </div>
          <div className="sb-btnrow">
            <div className="sb-field" style={{flex:1}}><label>Next occurrence (anchor)<span className="sb-req" aria-hidden="true">*</span></label>
              <input type="date" value={f.anchorDate} onChange={e=>set("anchorDate",e.target.value)} /></div>
            <div className="sb-field" style={{flex:1}}><label>End date (optional)</label>
              <input type="date" value={f.endDate||""} onChange={e=>set("endDate",e.target.value)} /></div>
          </div>
          <div className="sb-sub" style={{fontSize:12}}>The pattern (weekday, day of month, nth position) comes from the anchor date; future dates are calculated from it. Changes apply to future occurrences only — linked content is never changed.</div>
          {preview.length>0 && <div className="sb-remsum sb-remcard" style={{marginBottom:10}}><div className="bd">
            <b>Next dates</b><span>{preview.join(" · ")}</span></div></div>}
          <Toggle label="Series is active" v={f.active!==false} on={()=>set("active",f.active===false)} />
          <Toggle label="Show on Home" v={f.showOnHome!==false} on={()=>set("showOnHome",f.showOnHome===false)} />
          <button className="sb-btn" style={{marginTop:12}} disabled={!valid} onClick={()=>onSave(f)}>{d?"Save changes":"Create event"}</button>
        </div>
      </div>
    </div>
    {leaveGuard}
    </Portal>
  );
}

export default function Admin({ users, tasks, teamUsers, issues, eventSeries, secReq, focusUser, onEditUser, onEditTask, onDeleteUser, onRemoveUser, onDeleteTask, onArchiveTask, onDuplicateTask, onOpenTask, onAutoAll, onAutoOne, onImport, onResolveIssue, onAssignSuggested, onNewForEvent }) {
  // Start on the requested section (deep-link / notification) so we never flash
  // "Overview" before switching — that intermediate render looked jumpy.
  const [sec, setSec] = useState(() => secReq?.sec || "overview");
  useEffect(() => { if (secReq?.sec) setSec(secReq.sec); }, [secReq]);
  const [contentFilter, setContentFilter] = useState("all");
  const pending = users.filter(u => u.status === "pending");
  const openIssues = (issues || []).filter(i => i.status !== "resolved").length;

  // Card action handlers, bundled once and threaded through the panels.
  const [confirmDel, setConfirmDel] = useState(null);
  const h = { open:onOpenTask, edit:onEditTask, archive:onArchiveTask,
              duplicate:onDuplicateTask, del:(id,title)=>setConfirmDel({id,title}), auto:onAutoOne };
  const goContent = (filter="all") => { setContentFilter(filter); setSec("content"); };

  const tabs = [
    ["overview", "Overview"],
    ["people",   pending.length>0 ? `People · ${pending.length}` : "People"],
    ["content",  "Content"],
    ["events",   "Events"],
    ...(ENABLE_CSV_IMPORT ? [["import", "Import"]] : []),
    ["issues",   openIssues>0 ? `Issues · ${openIssues}` : "Issues"],
  ];

  return (
    <div className="sb-page">
      <div className="sb-seg" style={{marginBottom:14}}>
        {tabs.map(([id,label]) => (
          <button key={id} className={"sb-segbtn"+(sec===id?" on":"")} onClick={()=>setSec(id)}>{label}</button>
        ))}
      </div>

      {sec==="overview" && <AdminOverview tasks={tasks} users={users} h={h}
        onGoContent={goContent} onGoPeople={()=>setSec("people")} onGoImport={()=>setSec("import")}
        onGoEvents={()=>setSec("events")}
        onNewContent={()=>onEditTask("new")} onAutoAll={onAutoAll} onNewForEvent={onNewForEvent}
        onEditUser={onEditUser} onDeleteUser={onDeleteUser} onAssignSuggested={onAssignSuggested} />}

      {sec==="people" && <AdminPeople users={users} tasks={tasks} focusUser={focusUser}
        onEditUser={onEditUser} onDeleteUser={onDeleteUser} onRemoveUser={onRemoveUser}
        onAssignSuggested={onAssignSuggested} />}

      {sec==="content" && <AdminContent tasks={tasks} h={h}
        filter={contentFilter} setFilter={setContentFilter}
        onNewContent={()=>onEditTask("new")} onAutoAll={onAutoAll} />}

      {sec==="events" && <AdminEvents series={eventSeries} />}
      {sec==="import" && <ImportPanel users={teamUsers} onImport={onImport} />}
      {sec==="issues" && <IssueLog issues={issues} onResolve={onResolveIssue} />}
      {confirmDel && <ConfirmDialog tone="danger"
        title="Delete this content?"
        body={`“${confirmDel.title}” will be permanently deleted.`}
        consequences={[
          "Its comments, reminder schedules, and activity history are removed too.",
          "This action cannot be undone.",
        ]}
        cancelLabel="Keep content" confirmLabel="Delete content" busyLabel="Deleting…"
        onConfirm={()=>onDeleteTask(confirmDel.id)} onClose={()=>setConfirmDel(null)} />}
    </div>
  );
}

/* Compact "New" actions menu — moves the old admin toolbar into a single
   top-right dropdown so the overview leads with information, not buttons. */
function AdminActions({ onNewContent, onNewEvent, onAutoAll, onImport }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const f = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const k = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", f); document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", f); document.removeEventListener("keydown", k); };
  }, [open]);
  return (
    <div className="sb-kebab" ref={ref}>
      <button className="sb-btn compact" onClick={()=>setOpen(o=>!o)} aria-haspopup="menu" aria-expanded={open}>
        <PlusIcon className="hi hi-sm" aria-hidden="true"/> New <ChevronDownIcon className="hi hi-sm" aria-hidden="true"/></button>
      {open && (
        <div className="sb-kebab-menu" role="menu" style={{right:0,minWidth:180}}>
          <button className="sb-kebab-item" role="menuitem" onClick={()=>{ setOpen(false); onNewContent(); }}>New content</button>
          <button className="sb-kebab-item" role="menuitem" onClick={()=>{ setOpen(false); onNewEvent(); }}>New recurring event</button>
          <button className="sb-kebab-item" role="menuitem" onClick={()=>{ setOpen(false); onAutoAll(); }}>Auto-assign crew</button>
          {ENABLE_CSV_IMPORT && <button className="sb-kebab-item" role="menuitem" onClick={()=>{ setOpen(false); onImport(); }}>Import CSV</button>}
        </div>
      )}
    </div>
  );
}

/* Overview = the LEADERSHIP dashboard: decision-first, not data-first. Reuses
   Home's hierarchy — a hero + digest that answers "what needs me right now",
   then paired widgets (Needs attention · Approvals · Upcoming · Team health ·
   Ready to publish · Activity). Same visual language as Home, leadership data. */
function AdminOverview({ tasks, users, h, onGoContent, onGoPeople, onGoImport, onGoEvents, onNewContent, onAutoAll, onEditUser, onDeleteUser, onAssignSuggested, onNewForEvent }) {
  const health = adminHealth(tasks, users);
  const attention = adminNeedsAttention(tasks);
  const pending = users.filter(u => u.status === "pending");
  const ready = adminReadyToMove(tasks);
  const activity = recentActivity(tasks, 6);
  const events = upcomingEvents(3);
  const hi = new Date().getHours();
  const greet = hi<12?"Good morning":hi<17?"Good afternoon":"Good evening";
  const pl = (n) => n===1?"":"s";

  const eventCount = (e) => occurrenceContentCount(e, tasks);
  const eventsNoContent = events.filter(e => eventCount(e)===0);
  const blockerName = tasks.filter(t => t.blockedOn && t.status!=="Posted")[0]?.blockedOn;

  // Team health from live workload — ranked people, busiest first.
  const team = users.filter(u => u.status==="approved" || u.role==="admin");
  const teamRanked = team.map(u => ({ name:u.name, n:userActiveTasks(u, tasks) })).sort((a,b)=>b.n-a.n);
  const maxLoad = Math.max(4, ...teamRanked.map(x=>x.n));
  const busy = teamRanked.filter(x => x.n>=4).length;

  const agoT = (ms) => { const m=Math.round((Date.now()-ms)/60000); if(m<1)return"just now";
    if(m<60)return m+"m ago"; const hr=Math.round(m/60); if(hr<24)return hr+"h ago"; return Math.round(hr/24)+"d ago"; };

  // Leadership digest — a morning briefing in plain language (leaders think in
  // stories, not metrics): name names, name events, phrase as sentences.
  const nc = eventsNoContent;
  const digest = [];
  if (health.blocked>0)      digest.push(`${health.blocked} project${pl(health.blocked)} ${health.blocked===1?"is":"are"} blocked${blockerName?`, waiting on ${blockerName}`:""}.`);
  if (health.overdue>0)      digest.push(`${health.overdue} item${pl(health.overdue)} ${health.overdue===1?"has":"have"} slipped past ${health.overdue===1?"its":"their"} deadline.`);
  if (health.awaitingQA>0)   digest.push(`${health.awaitingQA} piece${pl(health.awaitingQA)} ${health.awaitingQA===1?"needs":"need"} QA before going out.`);
  if (nc.length>0)           digest.push(nc.length===1 ? `${nc[0].name} still has no assigned content.` : `${nc[0].name} and ${nc.length-1} other event${pl(nc.length-1)} have no content yet.`);
  if (pending.length>0)      digest.push(`${pending.length} volunteer account${pl(pending.length)} ${pending.length===1?"is":"are"} waiting to be approved.`);
  if (health.ready>0)        digest.push(`${health.ready} piece${pl(health.ready)} ${health.ready===1?"is":"are"} ready to post.`);
  const primary = health.blocked>0 ? { label:"Review blockers", go:()=>onGoContent("blocked") }
    : health.overdue>0    ? { label:"Review overdue",   go:()=>onGoContent("overdue") }
    : pending.length>0    ? { label:"Review approvals", go:onGoPeople }
    : health.awaitingQA>0 ? { label:"See the QA queue", go:()=>onGoContent("qa") }
    : null;

  // Ranked health strip — severity order, only tinted when there's something.
  const chips = [
    { n:health.blocked,    label:"Blocked",    tone:"red",     go:()=>onGoContent("blocked") },
    { n:health.overdue,    label:"Overdue",    tone:"amber",   go:()=>onGoContent("overdue") },
    { n:health.awaitingQA, label:"Awaiting QA",tone:"blue",    go:()=>onGoContent("qa") },
    { n:pending.length,    label:"Approvals",  tone:"violet",  go:onGoPeople },
    { n:health.ready,      label:"Ready",      tone:"green",   go:()=>onGoContent("ready") },
    { n:health.unassigned, label:"Unassigned", tone:"neutral", go:()=>onGoContent("needowner") },
  ];

  return (
    <>
      <div className="sb-eyebrow">{greet}</div>
      <div className="sb-adhead">
        <div className="sb-h">Leadership overview</div>
        <AdminActions onNewContent={onNewContent} onNewEvent={onGoEvents} onAutoAll={onAutoAll} onImport={onGoImport} />
      </div>

      {/* Briefing row: the summary + project health, side by side (compact). */}
      <div className="sb-adtop">
        <div className="sb-digest">
          <div className="sb-digest-h"><SparklesIcon className="hi hi-sm" aria-hidden="true"/> Today’s summary</div>
          {digest.length===0
            ? <div className="sb-digest-clear">Everything’s on track — nothing needs you right now. 🎉</div>
            : <ul className="sb-digest-list">{digest.slice(0,4).map((d,i)=><li key={i}>{d}</li>)}</ul>}
          {primary && <button className="sb-btn compact" style={{marginTop:12,alignSelf:"flex-start"}} onClick={primary.go}>{primary.label} →</button>}
        </div>
        <div className="sb-healthcard">
          <div className="sb-digest-h">Project health</div>
          <div className="sb-healthrows">
            {chips.map((c,i)=>(
              <button key={i} className={"sb-healthrow tone-"+c.tone+(c.n>0?" active":"")} onClick={c.go}>
                <span className="hdot" aria-hidden="true"/><span className="hl">{c.label}</span><span className="hn">{c.n}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Decision grid — same language as Home. */}
      <div className="sb-adash">
        {/* Needs attention — the hero: broken/overdue/unassigned work. */}
        <section className="sb-awd wd-attn">
          <div className="sb-shead sb-shead-primary">
            <div className="sb-shead-main"><h2>Needs attention</h2>
              {attention.length>0 && <span className="sb-headcount danger">{attention.length}</span>}</div>
            {attention.length>4 && <button className="link subtle" onClick={()=>onGoContent("overdue")}>See all →</button>}
          </div>
          {attention.length===0
            ? <div className="sb-empty compact sb-empty-glad"><span className="sb-empty-emoji" aria-hidden="true">✅</span>
                <b>All clear.</b><span>Nothing is stuck right now.</span></div>
            : <div className="sb-list">{attention.slice(0,4).map(t => <AdminTaskCard key={t.id} t={t} h={h} />)}</div>}
        </section>

        {/* Approvals — accounts waiting to be let in. */}
        <section className="sb-awd">
          <div className="sb-shead"><div className="sb-shead-main"><h2>Waiting for approval</h2>
            {pending.length>0 && <span className="sb-headcount">{pending.length}</span>}</div></div>
          {pending.length===0
            ? <div className="sb-empty compact">No one is waiting to be approved.</div>
            : <div className="sb-prowlist">{pending.map(u => (
                <PendingRow key={u.id} u={u} tasks={tasks}
                  onReview={()=>onEditUser(u)} onReject={onDeleteUser} onAssignSuggested={onAssignSuggested} />
              ))}</div>}
        </section>

        {/* Upcoming — events + whether they have content yet. */}
        <section className="sb-awd">
          <div className="sb-shead"><h2>Upcoming</h2>
            <button className="link subtle" onClick={onGoEvents}>Manage →</button></div>
          {events.length===0 ? <div className="sb-empty compact">No upcoming events.</div>
            : <div className="sb-evlist">{events.map((e,i)=>{
                const n = eventCount(e);
                return (
                  <div className="sb-ev" key={i}>
                    <span className="sb-ev-ic">{e.emoji?<span className="sb-emoji" aria-hidden="true">{e.emoji}</span>:e.kind==="birthday"?<span className="sb-emoji" aria-hidden="true">🎂</span>:<CalendarDaysIcon className="hi" aria-hidden="true"/>}</span>
                    <div className="sb-ev-body">
                      <div className="sb-ev-name">{e.name}</div>
                      <div className="sb-ev-sub"><b>{e.daysAway===0?"Today":e.daysAway===1?"Tomorrow":`In ${e.daysAway} days`}</b> · {fmtEventDate(e.date)}</div>
                      <div className="sb-ev-foot">
                        <span className={"sb-ev-status"+(n>0?" ok":" sb-ev-warn")}>{n>0?`${n} planned`:"No content assigned"}</span>
                        {n===0 && onNewForEvent && <button className="sb-ev-link" onClick={()=>onNewForEvent(eventPrefill(e))}>Create →</button>}
                      </div>
                    </div>
                  </div>
                );
              })}</div>}
        </section>

        {/* Team health — the people, ranked by workload with a tiny load bar. */}
        <section className="sb-awd">
          <div className="sb-shead"><div className="sb-shead-main"><h2>Team health</h2>
            {busy>0 && <span className="sb-headcount">{busy} busy</span>}</div>
            <button className="link subtle" onClick={onGoPeople}>People →</button></div>
          <div className="sb-teamlist sb-widcard">
            {teamRanked.slice(0,5).map((m,i)=>{
              const tone = m.n>=4 ? "over" : m.n===0 ? "free" : "ok";
              const tag  = m.n>=4 ? "Overloaded" : m.n===0 ? "Available" : "Healthy";
              return (
                <button className="sb-teamrow" key={i} onClick={onGoPeople}>
                  <span className="sb-av" aria-hidden="true">{initials(m.name)}</span>
                  <span className="sb-teamrow-name">{m.name}</span>
                  <span className="sb-teambar"><i className={"t-"+tone} style={{width:`${Math.max(6,Math.min(100,(m.n/maxLoad)*100))}%`}}/></span>
                  <span className={"sb-teamrow-tag t-"+tone}>{m.n} · {tag}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Ready to publish — healthy work a nudge from done. */}
        <section className="sb-awd">
          <div className="sb-shead"><div className="sb-shead-main"><h2>Ready to post</h2>
            {ready.length>0 && <span className="sb-headcount ok">{ready.length}</span>}</div>
            {ready.length>4 && <button className="link subtle" onClick={()=>onGoContent("ready")}>See all →</button>}</div>
          {ready.length===0 ? <div className="sb-empty compact">Nothing’s ready to post yet.</div>
            : <div className="sb-list">{ready.slice(0,4).map(t => <AdminTaskCard key={t.id} t={t} h={h} />)}</div>}
        </section>

        {/* Recent activity — who did what, GitHub-style. */}
        <section className="sb-awd">
          <div className="sb-shead"><h2>Recent activity</h2></div>
          {activity.length===0 ? <div className="sb-empty compact">No activity yet.</div>
            : <div className="sb-actfeed2 sb-widcard">{activity.map((a,i)=>(
                <button className="sb-actrow2" key={i} onClick={()=>h.open(a.taskId)}>
                  <span className="sb-av sb-actrow2-av" aria-hidden="true">{initials(a.who)}
                    <span className={"sb-actrow2-dot type-"+a.type}/></span>
                  <span className="sb-actrow2-body">
                    <span className="sb-actrow2-name">{a.who}</span>
                    <span className="sb-actrow2-act">{a.verb} <span className="ct">{a.title}</span></span>
                    <span className="sb-actrow2-meta">{agoT(a.at)}</span>
                  </span>
                </button>
              ))}</div>}
        </section>
      </div>
    </>
  );
}

/* Content = the full "manage content" screen: search, admin-centric filters,
   and the complete card list (edit / archive / duplicate / delete per card). */
function AdminContent({ tasks, h, filter, setFilter, onNewContent, onAutoAll }) {
  const [q, setQ] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searching = q.trim().length > 0;
  const list = sortTasks(searching ? searchTasks(tasks, q) : applyAdminFilter(tasks, filter), "post-asc");
  const activeLabel = ADMIN_FILTERS.find(f => f.id === filter)?.label;

  return (
    <>
      <div className="sb-btnrow" style={{marginBottom:12}}>
        <button className="sb-btn compact" onClick={onNewContent}><PlusIcon className="hi hi-sm" aria-hidden="true"/> New content</button>
        <button className="sb-tertiary" onClick={onAutoAll}><BoltIcon className="hi hi-sm" aria-hidden="true"/> Auto-assign empty</button>
      </div>
      <div className="sb-field" style={{marginBottom:10}}>
        <div className="sb-inline">
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search content: title, owner, event…" />
          {searching && <button className="sb-btn ghost compact" onClick={()=>setQ("")}>Clear</button>}
        </div>
      </div>
      {!searching && <>
        <div className="sb-filterbar">
          <button className="sb-filtertoggle" onClick={()=>setFiltersOpen(o=>!o)} aria-expanded={filtersOpen}>
            <span className="ico"><FunnelIcon className="hi hi-sm" aria-hidden="true"/></span>Filters
            {filter!=="all" && <span className="sb-filteractive">{activeLabel}</span>}
            <span className={"sb-chev"+(filtersOpen?" open":"")}><ChevronRightIcon className="hi hi-sm" aria-hidden="true" /></span>
          </button>
        </div>
        {filtersOpen && <div className="sb-chiprow">
          {ADMIN_FILTERS.map(f => (
            <button key={f.id} className={"sb-fchip"+(filter===f.id?" on":"")}
              onClick={()=>{ setFilter(f.id); setFiltersOpen(false); }}>{f.label}</button>
          ))}
        </div>}
      </>}
      <div className="sb-sub" style={{margin:"8px 0 12px"}}>
        {list.length} item{list.length!==1?"s":""}{searching?` matching “${q.trim()}”`:filter!=="all"?` · ${activeLabel}`:""}
      </div>
      {list.length===0
        ? <div className="sb-empty"><div className="big"><ViewColumnsIcon className="hi hi-empty" aria-hidden="true"/></div>Nothing matches.</div>
        : <div className="sb-list">{list.map(t => <AdminTaskCard key={t.id} t={t} h={h} />)}</div>}
    </>
  );
}

/* A compact pending-approval row: identity + a single primary "Review" action.
   Reject is tucked into the kebab so the page isn't a wall of danger buttons. */
function PendingRow({ u, tasks, focus, onReview, onReject, onAssignSuggested }) {
  const [confirmReject, setConfirmReject] = useState(false);
  // Arrived from a "waiting for approval" notification (…&user=<id>): scroll this
  // exact person into view and flash them once so they're impossible to miss.
  const rowRef = useRef(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!focus || !rowRef.current) return;
    const t = setTimeout(() => {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlash(true);
      setTimeout(() => setFlash(false), 1600);
    }, 200);
    return () => clearTimeout(t);
  }, [focus]);
  return (
    <div className={"sb-prow"+(flash?" sb-flash":"")} ref={rowRef}>
      <span className="sb-av" style={{width:38,height:38,fontSize:13}}>{initials(u.name)}</span>
      <div className="sb-prow-main">
        <div className="sb-prow-name">{u.name}</div>
        <div className="sb-prow-sub">{u.email} · <span className="sb-pendtag">Pending approval</span></div>
        <AssignHint user={u} tasks={tasks} onAssign={onAssignSuggested} />
      </div>
      <button className="sb-btn green compact" onClick={onReview}>Review</button>
      <KebabMenu items={[
        { label:"Review & approve", onClick:onReview },
        { label:"Reject", danger:true, onClick:()=>setConfirmReject(true) },
      ]} />
      {confirmReject && <ConfirmDialog tone="danger"
        title={`Reject ${u.name}?`}
        body="Their pending account will be removed."
        consequences={["They can register again later if this was a mistake."]}
        cancelLabel="Keep pending" confirmLabel="Reject account" busyLabel="Rejecting…"
        onConfirm={()=>onReject(u.id)} onClose={()=>setConfirmReject(false)} />}
    </div>
  );
}

// Privacy-safe push status from the user doc summary (no token exposure).
function pushStatus(u) {
  if (u.notifPrefs && u.notifPrefs.push === false) return { label: "Push off", cls: "off" };
  const n = u.pushDeviceCount || 0;
  if (n > 0) return { label: `Push on · ${n} device${n!==1?"s":""}`, cls: "on" };
  return { label: "No active device", cls: "none" };
}

/* A team member card — identity, campus, department, permissions, and a live
   active-task count. Edit is primary; Remove lives in the kebab (safer). */
function PersonCard({ u, tasks, onEdit, onRemove }) {
  const chips = roleChips(u);
  const active = userActiveTasks(u, tasks);
  const campus = (u.location||[]).join(" · ") || "No campus";
  const dept = userDepartments(u).join(" · ") || "No department";   // #3 — multiple departments
  const available = isAvailable(u);                                 // #4
  return (
    <div className="sb-task sb-task-act" role="button" tabIndex={0}
      onClick={onEdit} onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); onEdit(); } }}>
      <div className="row1"><span className="title">{u.name}</span>
        <div className="sb-row1end">
          <KebabMenu items={[
            { label:"Edit", onClick:onEdit },
            { label:"Remove from team", danger:true, onClick:onRemove },
          ]} />
        </div></div>
      <div className="sub"><span>{u.email}</span></div>
      <div className="sub"><span>{campus} · {dept}</span></div>
      <div className="sb-prow-chips">
        {chips.map(c => <span key={c} className={"sb-rolechip rc-"+c.toLowerCase()}>{c}</span>)}
        {(() => { const ps = pushStatus(u); return <span className={"sb-pushbadge "+ps.cls}>{ps.label}</span>; })()}
        {available
          ? <span className="sb-activecount">{active} active task{active!==1?"s":""}</span>
          : <span className="sb-activecount sb-unavail">Unavailable</span>}
      </div>
    </div>
  );
}

/* People = approvals + team management: search, filters, grouped roster. */
function AdminPeople({ users, tasks, focusUser, onEditUser, onDeleteUser, onRemoveUser, onAssignSuggested }) {
  const [q, setQ] = useState("");
  const [pushFilter, setPushFilter] = useState("all");
  const [filter, setFilter] = useState("all");
  const [removing, setRemoving] = useState(null);   // user pending removal
  const searching = q.trim().length > 0;

  const pending = users.filter(u => u.status === "pending");
  const allApproved = users.filter(u => u.status === "approved" || u.role === "admin");
  let team = searching ? searchPeople(allApproved, q) : applyPeopleFilter(allApproved, filter);
  if (pushFilter !== "all") team = team.filter(u => pushFilter === "on"
    ? (u.notifPrefs?.push !== false && (u.pushDeviceCount || 0) > 0)
    : (u.notifPrefs?.push === false || !(u.pushDeviceCount || 0)));
  const groups = groupPeople(team);
  const teamTotal = team.length;
  const activeLabel = PEOPLE_FILTERS.find(f => f.id === filter)?.label;

  return (
    <>
      {/* Pending approvals — its own clear section, compact rows */}
      {pending.length>0 && <>
        <div className="sb-shead sb-shead-strong"><h2>Waiting for approval</h2><span className="sb-tag">{pending.length}</span></div>
        <div className="sb-prowlist" style={{marginBottom:18}}>
          {pending.map(u => (
            <PendingRow key={u.id} u={u} tasks={tasks} focus={u.id===focusUser}
              onReview={()=>onEditUser(u)} onReject={onDeleteUser} onAssignSuggested={onAssignSuggested} />
          ))}
        </div>
      </>}

      {/* Search + filters */}
      <div className="sb-field" style={{marginBottom:10}}>
        <div className="sb-inline">
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search people: name, email, department, role, campus…" />
          {searching && <button className="sb-btn ghost compact" onClick={()=>setQ("")}>Clear</button>}
        </div>
      </div>
      {!searching && <div className="sb-chiprow">
        {PEOPLE_FILTERS.map(f => (
          <button key={f.id} className={"sb-fchip"+(filter===f.id?" on":"")} onClick={()=>setFilter(f.id)}>{f.label}</button>
        ))}
      </div>}
      {!searching && <div className="sb-chiprow" style={{marginTop:6}} role="group" aria-label="Filter by push notifications">
        {[["all","All push"],["on","Push enabled"],["off","Push not enabled"]].map(([id,lbl]) => (
          <button key={id} className={"sb-fchip"+(pushFilter===id?" on":"")} onClick={()=>setPushFilter(id)}>{lbl}</button>
        ))}
      </div>}

      <div className="sb-sub" style={{margin:"8px 0 6px"}}>
        {teamTotal} team member{teamTotal!==1?"s":""}{searching?` matching “${q.trim()}”`:filter!=="all"?` · ${activeLabel}`:""}
      </div>

      {teamTotal===0
        ? <div className="sb-empty"><div className="big"><UserGroupIcon className="hi hi-empty" aria-hidden="true"/></div>No one matches.</div>
        : groups.map(g => (
            <div key={g.label}>
              <div className="sb-shead"><h2>{g.label}</h2><span className="sb-tag">{g.items.length}</span></div>
              <div className="sb-list">
                {g.items.map(u => (
                  <PersonCard key={u.id} u={u} tasks={tasks}
                    onEdit={()=>onEditUser(u)} onRemove={()=>setRemoving(u)} />
                ))}
              </div>
            </div>
          ))}

      {removing && (
        <RemoveUserModal user={removing} tasks={tasks} team={allApproved}
          onClose={()=>setRemoving(null)}
          onConfirm={async (opts)=>{ await onRemoveUser(removing, opts); setRemoving(null); }} />
      )}
    </>
  );
}

/* A deliberate, reversible-feeling removal flow: explains the consequence and
   lets the admin reassign the person's active work or leave it for pickup. */
function RemoveUserModal({ user, tasks, team, onClose, onConfirm }) {
  const owned = tasks.filter(t => t.owner === user.name && t.status !== "Posted");
  const others = team.filter(u => u.name !== user.name);
  const [mode, setMode] = useState("unassign");
  const [target, setTarget] = useState(others[0]?.id || ""); // uid — the stable identity the server validates
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    await onConfirm({ mode, target: mode === "reassign" ? target : undefined });
  };

  return (
    <Portal>
    <div className="sb-scrim" onMouseDown={onClose}>
      <div className="sb-sheet" onMouseDown={e=>e.stopPropagation()}>
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>Remove {user.name}?</b>
          <button className="sb-x" onClick={onClose}><XMarkIcon className="hi" aria-hidden="true" /></button></div>
        <div className="bd">
          <p className="sb-sub" style={{lineHeight:1.55}}>
            Are you sure you want to remove this user from the team? Their content will remain,
            but they'll no longer have access.
          </p>

          {owned.length>0 ? <>
            <div className="sb-field"><label>They currently own {owned.length} active task{owned.length!==1?"s":""}</label>
              <label className="sb-radio">
                <input type="radio" name="rm" checked={mode==="unassign"} onChange={()=>setMode("unassign")} />
                Keep the tasks unassigned (mark as needing an owner)
              </label>
              <label className="sb-radio">
                <input type="radio" name="rm" checked={mode==="reassign"} onChange={()=>setMode("reassign")} />
                Reassign their active tasks to:
              </label>
              {mode==="reassign" && (
                <select className="sb-select" style={{marginTop:6}} value={target} onChange={e=>setTarget(e.target.value)}>
                  {others.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              )}
            </div>
          </> : <p className="sb-sub">They don't own any active tasks.</p>}

          <div className="sb-btnrow" style={{marginTop:8}}>
            <button className="sb-btn danger" disabled={busy || (mode==="reassign" && !target)} onClick={go}>
              {busy?"Removing…":"Remove from team"}</button>
            <button className="sb-btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}

/* ===================================================================
   ISSUE LOG  (admin) — reported problems + auto-captured errors
   =================================================================== */
function IssueLog({ issues, onResolve }) {
  const [kind, setKind] = useState("all");     // all | report | error
  const [show, setShow] = useState("open");    // open | resolved | all
  const [openId, setOpenId] = useState(null);

  const tm = (ts) => {
    // Firestore Timestamp → readable; serverTimestamp may be null for a beat.
    const d = ts?.toDate ? ts.toDate() : (ts?.seconds ? new Date(ts.seconds*1000) : null);
    return d ? d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) : "just now";
  };

  const list = (issues || [])
    .filter(i => kind==="all" || i.kind===kind)
    .filter(i => show==="all" || (show==="resolved" ? i.status==="resolved" : i.status!=="resolved"))
    .sort((a,b) => (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0));

  return (
    <div>
      <div className="sb-seg" style={{marginBottom:10}}>
        {[["all","All"],["report","Reports"],["feature_request","Feature requests"],["error","Errors"]].map(([k,l])=>(
          <button key={k} className={"sb-segbtn"+(kind===k?" on":"")} onClick={()=>setKind(k)}>{l}</button>))}
      </div>
      <div className="sb-seg" style={{marginBottom:14}}>
        {[["open","Open"],["resolved","Resolved"],["all","All"]].map(([k,l])=>(
          <button key={k} className={"sb-segbtn"+(show===k?" on":"")} onClick={()=>setShow(k)}>{l}</button>))}
      </div>

      {list.length===0
        ? <div className="sb-empty"><div className="big"><CheckCircleIcon className="hi hi-empty" aria-hidden="true"/></div>Nothing here. No {show==="open"?"open ":""}issues.</div>
        : <div className="sb-list" style={{gridTemplateColumns:"1fr"}}>
            {list.map(i => {
              const expanded = openId===i.id;
              const isErr = i.kind==="error";
              return (
                <div className="sb-task" key={i.id} style={{cursor:"default"}}>
                  <div className="row1">
                    <span className="title" style={{fontSize:14}}>{i.note || i.message || "(no detail)"}</span>
                    <span className="sb-rowtags">
                      <span className={"sb-chip "+(isErr?"chip-poster":"chip-reel")}>{isErr?"Error":i.kind==="feature_request"?"Feature request":"Report"}</span>
                      {i.status==="resolved" && <span className="sb-tag">Resolved</span>}
                    </span>
                  </div>
                  <div className="sub">
                    <span><b>{i.email||i.uid||"unknown"}</b></span>
                    <span>on {i.route||"-"}</span>
                    <span>{tm(i.createdAt)}</span>
                    {i.taskId && <span>task {i.taskId}</span>}
                  </div>
                  {i.note && i.message && <div className="sub"><span style={{color:"var(--muted)"}}>{i.message}</span></div>}
                  {expanded && (
                    <div className="sb-issue-meta">
                      {i.action && <div><b>Action:</b> {i.action}</div>}
                      {i.code && <div><b>Error code:</b> {i.code}</div>}
                      {i.online!==undefined && <div><b>Network:</b> {i.online ? "online" : "offline"}</div>}
                      <div><b>Device:</b> {i.userAgent || "-"}</div>
                      <div><b>Viewport:</b> {i.viewport || "-"} · <b>URL:</b> {i.url || "-"}</div>
                      {i.stack && <pre className="sb-stack">{i.stack}</pre>}
                    </div>
                  )}
                  <div className="sb-btnrow" style={{marginTop:10}}>
                    <button className="sb-btn ghost" onClick={()=>setOpenId(expanded?null:i.id)}>
                      {expanded?"Hide details":"Details"}</button>
                    {i.status==="resolved"
                      ? <button className="sb-btn ghost" onClick={()=>onResolve(i.id,"open")}>Reopen</button>
                      : <button className="sb-btn green" onClick={()=>onResolve(i.id,"resolved")}>Mark resolved</button>}
                  </div>
                </div>
              );
            })}
          </div>}
    </div>
  );
}

/* Shows "this person may match N pending imported tasks" with a one-click
   bulk-assign — the onboarding helper for CSV-imported "Pending" work. */
function AssignHint({ user, tasks, onAssign }) {
  const n = pendingMatches(user, tasks).length;
  if (!n) return null;
  return (
    <div className="sb-assign">
      💡 Suggested match for <b>{n}</b> imported task{n!==1?"s":""} (Pending owner/crew).
      <button className="link" onClick={()=>onAssign(user)}>Assign {n===1?"it":"them"}</button>
    </div>
  );
}

/* ===================================================================
   IMPORT (CSV upload / Google Sheet link → tasks)
   =================================================================== */
function ImportPanel({ users, onImport }) {
  const [rawRows, setRawRows] = useState([]);   // parseCSV output (re-mapped as confirmations change)
  const [mappings, setMappings] = useState(() => loadPref("sb-name-mappings", {}));
  const [ignored, setIgnored] = useState(new Set());
  const [sheetUrl, setSheetUrl] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // Re-derive tasks whenever the raw rows or confirmed name-mappings change.
  const rows = useMemo(() => rawRows.map((r) => rowToTask(r, users, mappings)), [rawRows, users, mappings]);
  const reconcile = useMemo(
    () => reconcileNames(rows, users, mappings).filter((m) => !ignored.has(m.key)),
    [rows, users, mappings, ignored]);

  const confirmMatch = (key, user) => {
    const next = { ...mappings, [key]: user.name };
    setMappings(next);
    savePref("sb-name-mappings", next);   // remember for future imports
  };
  const ignoreMatch = (m) => setIgnored((s) => new Set(s).add(m.key));

  const ingest = (text) => {
    const parsed = parseCSV(text);
    setRawRows(parsed); setIgnored(new Set());
    setMsg(parsed.length ? "" : "No rows found. Check the file has a header row and at least one task.");
  };

  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMsg(""); setSheetUrl("");
    const reader = new FileReader();
    reader.onload = () => ingest(String(reader.result || ""));
    reader.readAsText(file);
    e.target.value = ""; // allow re-uploading the same file
  };

  const fetchSheet = async () => {
    if (!sheetUrl.trim()) return;
    setBusy(true); setMsg(""); setRawRows([]);
    try {
      const res = await fetch(sheetCsvUrl(sheetUrl));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ingest(await res.text());
    } catch {
      setMsg("Couldn't fetch that sheet. Make sure it's shared as “Anyone with the link can view”, then try again.");
    } finally { setBusy(false); }
  };

  const valid = rows.filter((r) => !r.error);
  const invalid = rows.filter((r) => r.error);

  const doImport = async () => {
    setBusy(true);
    try {
      await onImport(valid.map((r) => r.task));
      setMsg(`✓ Imported ${valid.length} task${valid.length!==1?"s":""}.`);
      setRawRows([]);
    } catch {
      setMsg("Import failed. Please try again.");
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="sb-help">
        <b>Bulk-create tasks</b> from a CSV file or Google Sheet.
        <ul>
          <li>Accepted columns: Title, Date to be Posted, Owner, Support Team, Status, Priority, Related Event, Notes <span style={{color:"var(--muted)"}}>(more recognised)</span>.</li>
          <li>Only <b>Title</b> is required.</li>
          <li>Owners/crew without accounts import as <b>Pending</b>, matched to them once they sign up.</li>
        </ul>
      </div>

      <div className="sb-field"><label>Upload a CSV file</label>
        <label className="sb-dropzone">
          <ArrowUpTrayIcon className="hi" aria-hidden="true"/>
          <b>Upload CSV</b>
          <span>Drag and drop a file here, or <u>browse</u></span>
          <span className="hint">CSV files only</span>
          <input type="file" accept=".csv,text/csv" onChange={onFile} />
        </label></div>

      <div className="sb-field"><label>…or paste a Google Sheet link</label>
        <div className="sb-urlrow">
          <input value={sheetUrl} placeholder="https://docs.google.com/spreadsheets/d/…"
            onChange={(e)=>setSheetUrl(e.target.value)} />
          <button className="sb-btn" disabled={busy || !sheetUrl.trim()} onClick={fetchSheet}>
            {busy ? "Fetching…" : "Fetch"}</button>
        </div>
        <div className="sb-sub" style={{marginTop:6}}>The sheet must be shared “Anyone with the link can view”.</div>
      </div>

      {msg && <div className="sb-banner" style={{marginTop:8}}>{msg}</div>}

      {reconcile.length > 0 && <>
        <div className="sb-shead" style={{marginTop:16}}><h2>Match names</h2>
          <span className="sb-tag">{reconcile.length}</span></div>
        <div className="sb-sub" style={{marginTop:-4}}>These sheet names look like existing people. Confirm to assign their tasks. Confirmed matches are remembered for next time.</div>
        <div className="sb-prowlist">
          {reconcile.map((m) => {
            // Ambiguous → never auto-pick; make the admin choose the right person.
            if (m.ambiguous) return (
              <div className="sb-prow ambig" key={m.key}>
                <div className="sb-prow-main">
                  <div className="sb-prow-name">⚠ Multiple people may match “{m.name}”</div>
                  <div className="sb-prow-sub">Please choose the correct person:</div>
                  <div className="sb-ambig-opts">
                    {m.candidates.map((c) => (
                      <button key={c.user.id} className="sb-btn ghost compact" onClick={()=>confirmMatch(m.key, c.user)}>
                        {c.user.name}
                      </button>
                    ))}
                    <button className="sb-btn ghost compact sb-skip" onClick={()=>ignoreMatch(m)}>Skip</button>
                  </div>
                </div>
              </div>
            );
            const top = m.candidates[0];
            const tier = matchTier(top.confidence);
            return (
            <div className="sb-prow" key={m.key}>
              <span className="sb-av" style={{width:34,height:34,fontSize:12}}>{initials(top.user.name)}</span>
              <div className="sb-prow-main">
                <div className="sb-prow-name">
                  {tier==="high"
                    ? <>Possible match: <b>{top.user.name}</b></>
                    : <>Maybe this is <b>{top.user.name}</b>?</>}
                </div>
                <div className="sb-prow-sub">
                  “{m.name}” · <span className={"sb-conf "+(tier==="high"?"hi":"mid")}>{Math.round(top.confidence*100)}%</span> · {top.reason}
                </div>
              </div>
              <button className="sb-btn green compact" onClick={()=>confirmMatch(m.key, top.user)}>Assign</button>
              <button className="sb-btn ghost compact" onClick={()=>ignoreMatch(m)}>Ignore</button>
            </div>
            );
          })}
        </div>
      </>}

      {rows.length > 0 && <>
        <div className="sb-shead" style={{marginTop:16}}><h2>Preview</h2>
          <span className="sb-tag">{valid.length} ready{invalid.length?` · ${invalid.length} skipped`:""}</span></div>
        <div className="sb-list">
          {rows.map((r, i) => (
            <div className="sb-task" key={i} style={{cursor:"default"}}>
              <div className="row1">
                <span className="title">{r.task?.title || "(no title)"}</span>
                {r.error
                  ? <span className="sb-chip chip-poster">Skip</span>
                  : <span className={"sb-chip "+typeClass(r.task.type)}>{r.task.type}</span>}
              </div>
              {r.error
                ? <div className="sub"><span style={{color:"var(--danger)"}}>{r.error}</span></div>
                : <>
                    <div className="sub"><span><b>{r.task.owner||"-"}</b> · {r.task.location} · {r.task.status}</span>
                      <span>{fmt(r.task.postDate)}</span></div>
                    {r.task.support?.length>0 && <div className="sub">
                      <span style={{color:"var(--muted)"}}>Crew: {r.task.support.map((s)=>s.name).join(", ")}</span></div>}
                  </>}
            </div>
          ))}
        </div>
        <button className="sb-btn" style={{marginTop:14}} disabled={busy || valid.length===0} onClick={doImport}>
          {busy ? "Importing…" : `Import ${valid.length} task${valid.length!==1?"s":""}`}</button>
      </>}
    </div>
  );
}
