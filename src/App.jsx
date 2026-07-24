/* IFC Creatives Board — the digital home of the IFC Creative Team.
   (Internal note: powered by StudioBoard architecture.) */
import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useContext, createContext } from "react";
import { createPortal } from "react-dom";
import {
  onAuthStateChanged, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, updateProfile, sendPasswordResetEmail,
} from "firebase/auth";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, serverTimestamp,
} from "firebase/firestore";
import { auth, db, googleProvider, functions } from "./firebase";
import { httpsCallable } from "firebase/functions";
import {
  STAGES, statusClass, roleLabel, initials, emailFor, formatContentTitle,
  fmt, daysTo, autoAssign, computeCapacity,
  parseCSV, rowToTask, sheetCsvUrl,
  PRIORITIES, priorityClass, attentionItems, matchUser, reconcileNames, matchTier,
  PHASES, statusPhase, nextStep, workflowAction,
  LINK_FIELDS, requiredLinkKeys, missingLinks, QA_STATUSES,
  activityEntry, activityLabel, isApprovalEvent,
  TYPES, typeClass, qaQueue, postQueue, pendingMatches, applyAssignment,
  personalWins, teamWins, dashboardMetrics, searchTasks, searchPeople,
  monthlyWins, recentWins, contributorWins,
  BOARD_SORTS, BOARD_FILTERS, sortTasks, groupByStatus, applyBoardFilter,
  myWorkSections,
  adminHealth, adminNeedsAttention, adminReadyToMove, recentActivity,
  taskProblem, ADMIN_FILTERS, applyAdminFilter,
  DEPARTMENTS, roleChips, userActiveTasks, PEOPLE_FILTERS, applyPeopleFilter, groupPeople,
  crewRoleLabel, pendingCrewLabel, CREW_ROLES, occurrenceContentCount, occurrenceTasks,
  DEFAULT_REMINDERS, REMINDER_CHANNELS, REMINDER_RECIPIENTS, MAX_REMINDERS, isValidEmail,
  isValidUrl, userDepartments, isAvailable, soloCrewFor, soloCrewVerb, loadSummary, crewReason, sameCrew, dateIssues, todayStr, isShootType,
  personLoad, responsibilityTier, staleFlags, orderedCrew,
} from "./data";
import { upcomingEvents, searchEvents, isoDate, seriesFromDoc, seriesCadenceLabel, nextOccurrences } from "./events";
import { useNotifications, NOTIF_META, NOTIF_FALLBACK, PREF_TYPES, effectivePrefs, timeAgo } from "./notifications";
import { pushState, enablePush, listenForeground, refreshPushToken } from "./push";
import { RELEASES, LATEST_RELEASE } from "./releases";
import {
  HomeIcon, ClockIcon, ViewColumnsIcon, ClipboardDocumentListIcon, UserGroupIcon,
  Cog6ToothIcon, BellIcon, MagnifyingGlassIcon, XMarkIcon, ChevronRightIcon,
  EllipsisHorizontalIcon, ExclamationTriangleIcon, SunIcon, MoonIcon, FunnelIcon,
  BoltIcon, PlusIcon, ArrowUpTrayIcon, CalendarDaysIcon, LightBulbIcon, SparklesIcon, EyeIcon, EyeSlashIcon,
  ChatBubbleLeftRightIcon, BellAlertIcon, ArrowRightStartOnRectangleIcon, CheckCircleIcon, ChevronDownIcon,
  InformationCircleIcon, ClipboardIcon, ArrowTopRightOnSquareIcon, CheckIcon, ClipboardDocumentIcon,
  ComputerDesktopIcon, DocumentTextIcon,
} from "@heroicons/react/24/outline";
import { setView, reportIssue, logIssue, submitFeatureRequest } from "./logging";
import { getThemePref, setThemePref, resolvedTheme, subscribeTheme } from "./theme";
import { useBlocker } from "react-router-dom";
import { useNav, useScrollRestoration } from "./navHooks.js";
import { migrate, titleFor, hasOverlay, openComposeNew, withParams, PARAM } from "./nav.js";

/* Tiny localStorage helpers for remembering small UI preferences (e.g. which
   status groups a user has collapsed). Best-effort — never throw. */
const loadPref = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
};
const savePref = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

/* Full, friendly event date — "Jan 12th, 2026". */
const ordinal = (n) => { const s = ["th","st","nd","rd"], v = n % 100; return n + (s[(v-20)%10] || s[v] || s[0]); };
const fmtEventDate = (d) => `${d.toLocaleDateString(undefined,{month:"short"})} ${ordinal(d.getDate())}, ${d.getFullYear()}`;
/* Sensible starting values when creating content for an event. */
// Prefill a new task for a specific event occurrence. We stamp the structured
// occurrence fields (not just the display name) so content links to THIS
// occurrence — a recurring event's months never get conflated.
const eventPrefill = (e) => ({
  title: e.name,
  relatedEvent: e.name,
  relatedEventSeriesId: e.eventSeriesId || "",
  relatedEventOccurrenceId: e.eventOccurrenceId || "",
  relatedEventDate: e.eventOccurrenceDate ? isoDate(e.eventOccurrenceDate) : "",
  postDate: isoDate(e.date),
});

/* A slim, dismissible beta notice — sets expectations and invites feedback.
   Dismissal is remembered so it doesn't nag returning testers. */
/* Admin actions available on any task, anywhere (card kebabs + detail sheet)
   without threading handlers through every list. Provided once near the app
   root; null for non-admins (kebabs simply don't render). */
const TaskAdminContext = createContext(null);

/* Render overlay content directly into document.body so it escapes every parent
   stacking context (transformed/animated pages, filtered/opacity ancestors) and
   always layers above the app chrome — bottom nav, FAB, header. This is the real
   fix for "modal appears under the floating nav": a big z-index alone can't win
   against a parent that traps the child in its own stacking context. */
/* Overlay host. Every dialog / bottom-sheet / drawer renders through this so it
   escapes any transformed/animated ancestor's stacking context and layers above
   the floating nav via the z-index tokens. While ANY overlay is mounted we also:
   - lock background scroll (iOS-safe: fix the body at the current offset so the
     page can't scroll behind the sheet, restoring the exact position on close), and
   - mark the app root `inert`, so the nav + FAB + page behind the backdrop are
     neither clickable nor focusable (tab order skips them) until the overlay closes.
   A reference count keeps nested/stacked overlays correct. */
let _overlayCount = 0;
let _savedScrollY = 0;
function lockBackground() {
  if (_overlayCount++ > 0) return;
  _savedScrollY = window.scrollY || window.pageYOffset || 0;
  const b = document.body;
  b.style.position = "fixed";
  b.style.top = `-${_savedScrollY}px`;
  b.style.left = "0";
  b.style.right = "0";
  b.style.width = "100%";
  document.getElementById("root")?.setAttribute("inert", "");
}
function unlockBackground() {
  if (--_overlayCount > 0) return;
  _overlayCount = 0;
  const b = document.body;
  b.style.position = "";
  b.style.top = "";
  b.style.left = "";
  b.style.right = "";
  b.style.width = "";
  document.getElementById("root")?.removeAttribute("inert");
  window.scrollTo(0, _savedScrollY);
}
function Portal({ children }) {
  useLayoutEffect(() => {
    lockBackground();
    return unlockBackground;
  }, []);
  return createPortal(children, document.body);
}

function BetaBanner({ onReport }) {
  // "open" → visible, "closing" → playing the fade+collapse, then unmount.
  const [state, setState] = useState(() => loadPref("sb-beta-dismissed", false) === true ? "gone" : "open");
  if (state === "gone") return null;
  const dismiss = () => {
    savePref("sb-beta-dismissed", true);
    setState("closing");
    setTimeout(() => setState("gone"), 200);   // matches the betaOut animation
  };
  return (
    <div className={"sb-beta" + (state === "closing" ? " closing" : "")}>
      <span className="sb-beta-tag">Beta</span>
      <span className="sb-beta-txt">Help us improve the app</span>
      <button className="sb-beta-report" onClick={onReport}>Report</button>
      <button className="sb-beta-x" onClick={dismiss} aria-label="Dismiss beta notice"><XMarkIcon className="hi hi-sm" aria-hidden="true" /></button>
    </div>
  );
}

/* Appearance preference: Match system / Light / Dark. */
const APPEARANCE_OPTIONS = [
  { key:"system", label:"Match system", help:"Automatically follow this device", Icon: ComputerDesktopIcon },
  { key:"light",  label:"Light",        help:"Always use light appearance",      Icon: SunIcon },
  { key:"dark",   label:"Dark",         help:"Always use dark appearance",       Icon: MoonIcon },
];
const appearanceOption = (p) => APPEARANCE_OPTIONS.find(o=>o.key===p) || APPEARANCE_OPTIONS[0];

/* Bottom sheet (mobile) / centred dialog (desktop) with a radio list. */
function AppearanceSheet({ current, onChoose, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
    <div className="sb-scrim" onMouseDown={onClose}>
      <div className="sb-sheet" onMouseDown={e=>e.stopPropagation()} role="dialog" aria-label="Appearance">
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>Appearance</b>
          <button className="sb-x" onClick={onClose}><XMarkIcon className="hi" aria-hidden="true" /></button></div>
        <div className="bd">
          <div className="sb-optlist" role="radiogroup" aria-label="Appearance">
            {APPEARANCE_OPTIONS.map(o => {
              const active = current === o.key;
              return (
                <button key={o.key} role="radio" aria-checked={active}
                  className={"sb-optrow"+(active?" on":"")} onClick={()=>onChoose(o.key)}>
                  <span className="sb-optrow-ic"><o.Icon className="hi" aria-hidden="true"/></span>
                  <span className="sb-optrow-txt">
                    <span className="sb-optrow-l">{o.label}</span>
                    <span className="sb-optrow-h">{o.help}</span>
                  </span>
                  {active && <CheckIcon className="hi sb-optrow-chk" aria-hidden="true"/>}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}

/* Mobile account drawer — opened from the header avatar. Pulls the profile,
   theme, report and sign-out off every screen and into one slide-up sheet. */
function ProfileDrawer({ me, isAdmin, unread = 0, pendingCount = 0, onClose, onNotifications, onNotifPrefs, onWhatsNew, onFeatureRequest, onReport, onGoTab }) {
  const [pref, setPref] = useState(getThemePref());
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  useEffect(() => subscribeTheme(() => setPref(getThemePref())), []);
  const chooseAppearance = (p) => {
    setThemePref(p); setPref(p); setAppearanceOpen(false);
    if (me?.id) updateDoc(doc(db, "users", me.id), { appearance: p }).catch(() => {}); // follows across devices
  };
  const PrefIcon = appearanceOption(pref).Icon;
  const drag = useSheetDrag(onClose);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
    <div className="sb-scrim" onMouseDown={onClose}>
      <div className="sb-drawer" onMouseDown={e=>e.stopPropagation()} style={drag.sheetStyle}>
        <div className="sb-grab" {...drag.handleProps}><span/></div>
        <div className="sb-drawer-user">
          <span className="sb-av" style={{width:46,height:46,fontSize:16}}>{initials(me.name)}</span>
          <div style={{minWidth:0}}>
            <div className="nm">{me.name}</div>
            <div className="rl">{isAdmin?"Admin":"Member"} · {me.email}</div>
          </div>
        </div>
        {/* Navigating to a screen already drops ?panel=profile (closes the
            drawer). Calling onClose() too would run a second navigation from a
            stale location and clobber the screen change — the mobile "Team/Admin
            don't work" bug. So these navigate only. */}
        {onGoTab && <button className="sb-drawer-item" onClick={()=>onGoTab("team")}>
          <span className="i"><UserGroupIcon className="hi" aria-hidden="true"/></span>Team
        </button>}
        {onGoTab && isAdmin && <button className="sb-drawer-item" onClick={()=>onGoTab("admin")}>
          <span className="i"><Cog6ToothIcon className="hi" aria-hidden="true"/></span>Admin
          {pendingCount>0 && <span className="sb-drawer-state">{pendingCount}</span>}
        </button>}
        {onNotifPrefs && <button className="sb-drawer-item" onClick={()=>{ onNotifPrefs(); onClose(); }}>
          <span className="i"><BellAlertIcon className="hi" aria-hidden="true"/></span>Notification preferences
        </button>}
        {onWhatsNew && <button className="sb-drawer-item" onClick={()=>{ onWhatsNew(); onClose(); }}>
          <span className="i"><SparkIcon/></span>What's new
          {seenRelease()!==LATEST_RELEASE && <span className="sb-newbadge">New</span>}
        </button>}
        {onFeatureRequest && <button className="sb-drawer-item" onClick={()=>{ onFeatureRequest(); onClose(); }}>
          <span className="i"><LightBulbIcon className="hi" aria-hidden="true"/></span>Submit feature request
        </button>}
        <button className="sb-drawer-item" onClick={()=>setAppearanceOpen(true)}>
          <span className="i"><PrefIcon className="hi" aria-hidden="true"/></span>Appearance
          <span className="sb-drawer-state">{appearanceOption(pref).label}</span>
        </button>
        <button className="sb-drawer-item" onClick={onNotifications}>
          <span className="i"><BellIcon className="hi" aria-hidden="true"/></span>Notifications
          {unread>0 && <span className="sb-drawer-state">{unread>9?"9+":unread}</span>}
        </button>
        <button className="sb-drawer-item" onClick={onReport}>
          <span className="i"><ExclamationTriangleIcon className="hi" aria-hidden="true"/></span>Report an issue
        </button>
        <button className="sb-drawer-item danger" onClick={()=>signOut(auth)}>
          <span className="i"><ArrowRightStartOnRectangleIcon className="hi" aria-hidden="true"/></span>Sign out
        </button>
        <div className="sb-brandfoot"><b>IFC Creatives Board</b>Built for the IFC Creative Team.</div>
      </div>
    </div>
    {appearanceOpen && <AppearanceSheet current={pref} onChoose={chooseAppearance} onClose={()=>setAppearanceOpen(false)} />}
    </Portal>
  );
}

/* Notification Center — a slide-over listing the signed-in user's
   notifications (newest first). Reads via useNotifications; docs are written
   by the backend (Slice 3), so until then this shows the empty state. */
/* "What's new" — user-facing release notes; read-state in localStorage. */
const seenRelease = () => { try { return localStorage.getItem("sb-seen-release") || ""; } catch { return ""; } };
const markReleaseSeen = () => { try { localStorage.setItem("sb-seen-release", LATEST_RELEASE); } catch {} };

function WhatsNew({ onClose }) {
  useEffect(() => { markReleaseSeen(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
    <div className="sb-scrim" onClick={onClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()} role="dialog" aria-label="What's new">
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>What's new</b>
          <button className="sb-x" onClick={onClose} aria-label="Close"><XMarkIcon className="hi" aria-hidden="true"/></button></div>
        <div className="bd">
          {RELEASES.map(r => (
            <div key={r.version} style={{marginBottom:26}}>
              <div className="sb-mlabel">v{r.version} · {r.date}</div>
              <h3 style={{fontSize:17,margin:"4px 0 10px"}}>{r.title}</h3>
              {r.items.map(([t,d]) => (
                <div className="sb-relitem" key={t}>
                  <b>{t}</b><span>{d}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
    </Portal>
  );
}

/* Feature-request form — reuses the issues pipeline (kind: feature_request). */
function FeatureRequestModal({ onClose }) {
  const [f, setF] = useState({ title:"", problem:"", beneficiary:"", link:"" });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState(false);
  const set = (k,v)=>setF(p=>({...p,[k]:v}));
  const isDirty = !done && (f.title.trim() || f.problem.trim() || f.beneficiary.trim() || f.link.trim());
  const { requestClose, leaveGuard } = useUnsavedGuard(isDirty, onClose);
  const send = async () => {
    if (busy || !f.title.trim()) return;
    setBusy(true); setErr(false);
    const ok = await submitFeatureRequest({ title:f.title, description:f.title, problem:f.problem, beneficiary:f.beneficiary, link:f.link });
    setBusy(false);
    ok ? setDone(true) : setErr(true);   // entered text is preserved on failure
  };
  return (
    <Portal>
    <div className="sb-scrim" onClick={requestClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()} role="dialog" aria-label="Submit feature request">
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>Submit feature request</b>
          <button className="sb-x" onClick={requestClose} aria-label="Close"><XMarkIcon className="hi" aria-hidden="true"/></button></div>
        <div className="bd">
          {done ? (
            <>
              <div className="sb-empty compact"><b>Thanks — we got it!</b><br/>The team reviews every request. Accepted ideas show up in "What's new".</div>
              <button className="sb-btn" style={{marginTop:14}} onClick={onClose}>Close</button>
            </>
          ) : (
            <>
              <div className="sb-field"><label>What would you like to see?<span className="sb-req" aria-hidden="true">*</span></label>
                <input value={f.title} onChange={e=>set("title",e.target.value)} placeholder="e.g. A calendar view of all content" /></div>
              <div className="sb-field"><label>What problem would this solve?</label>
                <textarea rows={3} value={f.problem} onChange={e=>set("problem",e.target.value)} /></div>
              <div className="sb-field"><label>Who would this help?</label>
                <input value={f.beneficiary} onChange={e=>set("beneficiary",e.target.value)} placeholder="e.g. Editors, the QA team, everyone" /></div>
              <div className="sb-field"><label>Additional details or example link (optional)</label>
                <input value={f.link} onChange={e=>set("link",e.target.value)} /></div>
              {err && <div className="sb-lerr">Couldn't send right now — your text is kept. Try again.</div>}
              <button className="sb-btn" style={{marginTop:8}} disabled={busy || !f.title.trim()} onClick={send}>
                {busy ? "Sending…" : "Send request"}</button>
            </>
          )}
        </div>
      </div>
    </div>
    {leaveGuard}
    </Portal>
  );
}

const NOTIF_FILTERS = [
  { id:"all",       label:"All" },
  { id:"unread",    label:"Unread" },
  { id:"assigned",  label:"Assignments", types:["assigned"] },
  { id:"reviews",   label:"Reviews",     types:["qa"] },
  { id:"reminders", label:"Reminders",   types:["reminder","overdue"] },
  { id:"changes",   label:"Changes",     types:["changes"],  more:true },
  { id:"approvals", label:"Approvals",   types:["approved","ready","account_approved"], more:true },
  { id:"system",    label:"System",      types:["leadership","mention"], more:true },
];
const NOTIF_PRIMARY = NOTIF_FILTERS.filter(f=>!f.more);
const NOTIF_MORE = NOTIF_FILTERS.filter(f=>f.more);
// Date-group the loaded page of notifications: Today / Yesterday / This week / Earlier.
function notifGroups(items) {
  const now = new Date(); const day0 = new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  const g = { "Today":[], "Yesterday":[], "This week":[], "Earlier":[] };
  items.forEach(n => {
    const ms = n.createdAt?.toMillis ? n.createdAt.toMillis() : 0;
    if (ms >= day0) g["Today"].push(n);
    else if (ms >= day0 - 86400000) g["Yesterday"].push(n);
    else if (ms >= day0 - 6*86400000) g["This week"].push(n);
    else g["Earlier"].push(n);
  });
  return Object.entries(g).filter(([,v])=>v.length);
}

function NotifCenter({ notif, isAdmin, onClose, onOpenTask, onViewEvent, onGoPeople, onGoTab, onSettings }) {
  const { items, unread, hasMore, loadMore, markRead, markAllRead } = notif;
  // Animate the drawer out before closing / navigating, so the hand-off to the
  // destination isn't a hard cut. `finish(action)` fades, then runs the action.
  const [closing, setClosing] = useState(false);
  const closeT = useRef(null);
  useEffect(() => () => clearTimeout(closeT.current), []);
  const finish = (action) => {
    if (closing) return;
    setClosing(true);
    clearTimeout(closeT.current);
    closeT.current = setTimeout(() => (action || onClose)(), 180);
  };
  const drag = useSheetDrag(onClose);
  const [flt, setFlt] = useState("all");
  const [moreOpen, setMoreOpen] = useState(false);
  const active = NOTIF_FILTERS.find(f=>f.id===flt) || NOTIF_FILTERS[0];
  const moreActive = NOTIF_MORE.some(f=>f.id===flt);
  // Lock the page behind the drawer while it is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);
  const filtered = flt==="all" ? items
    : flt==="unread" ? items.filter(n=>!n.read)
    : items.filter(n=>(active.types||[]).includes(n.type));
  const groups = notifGroups(filtered);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") finish(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, closing]);
  // Every notification must open something (#8). Prefer its task, then its
  // event, then a type-based destination, and finally Home — never a dead end.
  // The drawer fades out first, then the destination opens (smooth hand-off).
  const open = (n) => {
    if (!n.read) markRead(n.id);
    const go =
      n.taskId ? () => onOpenTask(n.taskId)
      : (n.eventOccurrenceId && onViewEvent) ? () => onViewEvent({ eventOccurrenceId: n.eventOccurrenceId, name: n.eventName || "Event", annual: false })
      : (n.type === "leadership" && isAdmin && onGoPeople) ? () => onGoPeople()
      : onGoTab ? () => onGoTab("home")
      : onClose;
    finish(go);
  };
  return (
    <Portal>
    <div className={"sb-scrim sb-scrim-right"+(closing?" closing":"")} onMouseDown={()=>finish()}>
      <div className="sb-notifpanel" onMouseDown={e=>e.stopPropagation()} role="dialog" aria-label="Notifications" style={drag.sheetStyle}>
        <div className="sb-grab" {...drag.handleProps}><span/></div>
        <div className="sb-notifhd">
          <div className="sb-notifttl">
            <b className="sb-serif" style={{fontSize:17}}>Notifications</b>
            {unread>0 && <span className="sb-unreadct">{unread} unread</span>}
          </div>
          <div className="sb-notifhd-actions">
            {unread>0 && <button className="sb-markall" onClick={markAllRead}>
              <CheckCircleIcon className="hi hi-sm" aria-hidden="true"/> Mark all read</button>}
            <button className="sb-iconbtn" onClick={()=>finish(onSettings)} aria-label="Notification settings"><Cog6ToothIcon className="hi" aria-hidden="true"/></button>
            <button className="sb-x" onClick={()=>finish()}><XMarkIcon className="hi" aria-hidden="true" /></button>
          </div>
        </div>
        <div className="sb-nfilters" role="tablist" aria-label="Filter notifications">
          <div className="sb-nfilters-scroll">
            {NOTIF_PRIMARY.map(fo => (
              <button key={fo.id} role="tab" aria-selected={flt===fo.id}
                className={"sb-fchip"+(flt===fo.id?" on":"")}
                onClick={()=>{ setFlt(fo.id); setMoreOpen(false); }}>{fo.label}</button>
            ))}
          </div>
          <div className="sb-nmore">
            <button className={"sb-fchip"+(moreActive?" on":"")} aria-haspopup="menu" aria-expanded={moreOpen}
              onClick={()=>setMoreOpen(o=>!o)}>
              {moreActive ? active.label : "More"} <ChevronDownIcon className="hi" style={{width:14,height:14}} aria-hidden="true"/>
            </button>
            {moreOpen && (
              <div className="sb-nmore-menu" role="menu">
                {NOTIF_MORE.map(fo => (
                  <button key={fo.id} role="menuitemradio" aria-checked={flt===fo.id}
                    className={flt===fo.id?"on":""}
                    onClick={()=>{ setFlt(fo.id); setMoreOpen(false); }}>{fo.label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
        {filtered.length===0
          ? <div className="sb-empty"><div className="big"><BellIcon className="hi hi-empty" aria-hidden="true"/></div>
              {items.length===0
                ? <>You're all caught up.<br/>New assignments, reviews, reminders, and approvals will appear here.</>
                : "Nothing matches this filter."}</div>
          : <div className="sb-notiflist">
              {groups.map(([label, rows]) => (
                <div key={label}>
                  <div className="sb-ngroup">{label}</div>
                  {rows.map(n => {
                    const meta = NOTIF_META[n.type] || NOTIF_FALLBACK;
                    const MetaIcon = meta.icon;
                    return (
                      <button key={n.id} className={"sb-notif"+(n.read?"":" unread")} onClick={()=>open(n)}>
                        <span className={"ic "+(meta.tint||"tint-neutral")}><MetaIcon className="hi" aria-hidden="true"/></span>
                        <span className="bd">
                          <span className="ti">{n.title}</span>
                          {n.body && <span className="bo">{n.body}</span>}
                          <span className="mt">{meta.label} · {timeAgo(n.createdAt)}</span>
                        </span>
                        <span className={"ndot top"+(n.read?" read":"")} aria-label={n.read?undefined:"Unread"} />
                      </button>
                    );
                  })}
                </div>
              ))}
              {hasMore && <div style={{textAlign:"center",padding:"6px 0 12px"}}>
                <button className="sb-btn ghost compact" onClick={loadMore}>Load more</button></div>}
            </div>}
      </div>
    </div>
    </Portal>
  );
}

/* Device push enrollment. iOS/iPadOS only allow web push once the app is added
   to the Home Screen, so we guide the user there first instead of showing a
   button that silently won't work. */
function PushControls({ me }) {
  const [state, setState] = useState("loading");
  const [busy, setBusy] = useState(false);
  const [tokenOk, setTokenOk] = useState(null); // null=unknown, true=registered, false=granted-but-no-token
  useEffect(() => {
    (async () => {
      const s = await pushState();
      setState(s);
      // Permission "granted" alone doesn't mean this device can receive push —
      // verify a live FCM token is actually registered (and refresh it).
      if (s === "granted" && me?.id) setTokenOk((await refreshPushToken(me.id)).ok);
    })();
  }, [me?.id]);
  const enable = async () => {
    setBusy(true);
    const r = await enablePush(me.id);
    setTokenOk(r.ok);
    setState(r.ok ? "granted" : (r.reason === "denied" ? "denied" : await pushState()));
    setBusy(false);
  };
  if (state === "loading") return null;
  if (state === "granted") {
    if (tokenOk === false) return (
      <div className="sb-push">
        Notifications are allowed, but this device isn't registered for delivery yet.
        <button className="sb-btn ghost" style={{marginTop:8}} disabled={busy} onClick={enable}>
          {busy ? "Registering…" : "Re-register this device"}</button>
      </div>
    );
    return <div className="sb-push ok">✓ Push is on for this device.</div>;
  }
  if (state === "ios-needs-install") return (
    <div className="sb-push">
      <b>Turn on push on your iPhone / iPad</b>
      <ol>
        <li>Tap the <b>Share</b> icon, then <b>Add to Home Screen</b>.</li>
        <li>Open IFC Creatives Board from the new app icon.</li>
        <li>Come back here and tap <b>Enable push</b>.</li>
      </ol>
    </div>
  );
  if (state === "denied") return <div className="sb-push">Notifications are blocked. Allow them for this site in your browser settings, then reload.</div>;
  if (state === "unsupported") return <div className="sb-push">This browser doesn't support push notifications.</div>;
  if (state === "not-configured") return <div className="sb-push">Push isn't set up yet — an admin needs to finish messaging configuration.</div>;
  return <button className="sb-btn ghost" disabled={busy} onClick={enable}>{busy ? "Enabling…" : <><BellAlertIcon className="hi hi-sm" aria-hidden="true"/> Enable push on this device</>}</button>;
}

/* Admin-only: the default reminder schedule applied to new content. */
function AdminReminderDefaults() {
  const [reminders, setReminders] = useState(null);
  const [hour, setHour] = useState(9);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    getDoc(doc(db, "settings", "notifications")).then((s) => {
      const d = s.exists() ? s.data() : {};
      setReminders(d.defaultReminders && d.defaultReminders.length ? d.defaultReminders : DEFAULT_REMINDERS);
      setHour(d.reminderHourLocal != null ? d.reminderHourLocal : 9);
    }).catch(() => setReminders(DEFAULT_REMINDERS));
  }, []);
  if (reminders === null) return null;
  const save = async () => {
    try { await setDoc(doc(db, "settings", "notifications"), { defaultReminders: reminders, reminderHourLocal: hour }, { merge: true }); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    catch (e) { logIssue({ kind: "error", action: "save reminder defaults", message: e.message, code: e.code }); }
  };
  return (
    <>
      <div className="sb-mlabel">Admin · default reminder schedule</div>
      <div className="sb-sub" style={{marginTop:0}}>Applied to newly created content. Reminders fire at this hour, Winnipeg time.</div>
      <div className="sb-field" style={{maxWidth:160}}>
        <label>Send hour (0–23)</label>
        <input type="number" min="0" max="23" value={hour} onChange={(e)=>setHour(Math.max(0,Math.min(23,Number(e.target.value)||0)))} />
      </div>
      <ReminderEditor reminders={reminders} onChange={setReminders} />
      <button className="sb-btn ghost" style={{marginTop:8}} onClick={save}>{saved ? "Saved ✓" : "Save default schedule"}</button>
    </>
  );
}

/* Admin-only: live email usage dashboard (reads server-managed quota docs). */
function EmailUsage() {
  const [month, setMonth] = useState(null);
  const [day, setDay] = useState(null);
  useEffect(() => {
    const mk = new Date().toISOString().slice(0, 7);   // YYYY-MM (UTC)
    const dk = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD (UTC)
    const u1 = onSnapshot(doc(db, "systemUsage", `email-${mk}`), (s) => setMonth(s.exists() ? s.data() : {}), () => setMonth({}));
    const u2 = onSnapshot(doc(db, "systemUsage", `emailDaily-${dk}`), (s) => setDay(s.exists() ? s.data() : {}), () => setDay({}));
    return () => { u1(); u2(); };
  }, []);
  if (month === null) return null;
  const limit = month.monthlyLimit || 2800;
  const sent = month.sentCount || 0, reserved = month.reservedCount || 0;
  const used = sent + reserved;
  const pct = Math.round((used / limit) * 100);
  const remaining = Math.max(0, limit - used);
  const status = pct >= 100 ? ["Paused", "var(--red)"] : pct >= 95 ? ["Critical", "var(--red)"] : pct >= 85 ? ["Approaching limit", "var(--amber)"] : ["Normal", "var(--green)"];
  const dLimit = (day && day.dailyLimit) || 250;
  const dUsed = ((day && day.sentCount) || 0) + ((day && day.reservedCount) || 0);
  return (
    <>
      <div className="sb-mlabel">Admin · email usage (this month, UTC)</div>
      <div className="sb-usage">
        <div className="bar"><span style={{width:`${Math.min(100,pct)}%`, background: status[1]}} /></div>
        <div className="row"><b>{used.toLocaleString()} of {limit.toLocaleString()}</b><span style={{color:status[1],fontWeight:700}}>{status[0]}</span></div>
        <div className="grid">
          <span>Sent: <b>{sent.toLocaleString()}</b></span>
          <span>Reserved: <b>{reserved}</b></span>
          <span>Remaining: <b>{remaining.toLocaleString()}</b></span>
          <span>Used: <b>{pct}%</b></span>
          <span>Today: <b>{dUsed} / {dLimit}</b></span>
          <span>Failed: <b>{month.failedCount || 0}</b></span>
          <span>Suppressed: <b>{month.suppressedCount || 0}</b></span>
        </div>
      </div>
    </>
  );
}

/* Admin-only: verify the Resend email pipeline by sending a test message. */
// Translate a callable error into a safe, specific message. The backend already
// returns clean, user-facing messages for known cases; only a truly unknown
// server fault ("internal", or a network/blocked call) falls back to generic.
function friendlyEmailError(e) {
  const code = (e?.code || "").replace(/^functions\//, "");
  const msg = e?.message || "";
  if (code && code !== "internal" && msg && msg.toLowerCase() !== "internal") return msg;
  return "We couldn't send the test email. The error has been logged. Please try again or check the function logs.";
}
function AdminEmailTest() {
  const [to, setTo] = useState("");
  const [err, setErr] = useState("");           // inline field-validation error
  const [result, setResult] = useState(null);   // { ok, msg }
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (busy) return;                            // prevent duplicate submissions
    const addr = to.trim();
    if (!isValidEmail(addr)) { setErr("Enter a valid email address, e.g. name@example.com."); setResult(null); return; }
    setErr(""); setResult(null); setBusy(true);
    try {
      const res = await httpsCallable(functions, "sendTestEmail")({ to: addr });
      setResult({ ok: true, msg: `Test email sent to ${res.data?.to || addr}.` });
    } catch (e) {
      // Keep the entered address so the admin can retry; never auto-close the panel.
      setResult({ ok: false, msg: friendlyEmailError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="sb-mlabel">Admin · test email</div>
      <div className="sb-field">
        <input type="email" inputMode="email" value={to} aria-invalid={!!err}
          onChange={(e)=>{ setTo(e.target.value); if(err) setErr(""); }}
          onKeyDown={(e)=>{ if(e.key==="Enter") send(); }} placeholder="recipient@example.com" />
        {err && <div className="sb-fielderr" role="alert">{err}</div>}
      </div>
      <button className="sb-btn ghost" disabled={busy || !to.trim()} onClick={send}>{busy ? "Sending…" : "Send test email"}</button>
      {result && <div className="sb-sub" role="status" style={{marginTop:8, color: result.ok ? "var(--success)" : "var(--danger)"}}>{result.msg}</div>}
    </>
  );
}

/* Per-user notification preferences. In-app is always on; push/email and the
   per-type toggles are configurable. Writes users/{uid}.notifPrefs (allowed by
   a scoped security rule). */
function NotifSettings({ me, isAdmin, onSave, onClose }) {
  const [p, setP] = useState(effectivePrefs(me));
  const setChannel = (k) => setP(s => ({ ...s, [k]: !s[k] }));
  const setType = (k) => setP(s => ({ ...s, perType: { ...s.perType, [k]: !s.perType[k] } }));
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
    <div className="sb-scrim" onClick={onClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()}>
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>Notification settings</b>
          <button className="sb-x" onClick={onClose}><XMarkIcon className="hi" aria-hidden="true" /></button></div>
        <div className="bd">
          <div className="sb-sub" style={{marginTop:0}}>Choose how and what you're notified about. In-app notifications are always on.</div>
          <div className="sb-mlabel">How you're notified</div>
          <Toggle label="Push notifications" v={p.push} on={()=>setChannel("push")} />
          {p.push && <PushControls me={me} />}
          <Toggle label="Email notifications" v={p.email} on={()=>setChannel("email")} />
          <div className="sb-mlabel">What you're notified about</div>
          {PREF_TYPES.map(t => (
            <Toggle key={t.key} label={t.label} v={p.perType[t.key]!==false} on={()=>setType(t.key)} />
          ))}
          <div className="sb-sub" style={{fontSize:12}}>Account and security messages are always sent.</div>
          <button className="sb-btn" style={{marginTop:14}} onClick={()=>{ onSave(p); onClose(); }}>Save preferences</button>
          {isAdmin && <AdminReminderDefaults />}
          {isAdmin && <EmailUsage />}
          {isAdmin && <AdminEmailTest />}
        </div>
      </div>
    </div>
    </Portal>
  );
}

/* ===================================================================
   ERROR BOUNDARY — catches render crashes, logs them, and lets the
   user send a quick report instead of seeing a blank screen.
   =================================================================== */
export class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { crashed: false, sent: false, note: "" }; }
  static getDerivedStateFromError() { return { crashed: true }; }
  componentDidCatch(error, info) {
    logIssue({
      kind: "error",
      message: error?.message || "Render crash",
      stack: `${error?.stack || ""}\n--- componentStack ---${info?.componentStack || ""}`,
      action: "react render crash",
    });
  }
  render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="sb-pending">
        <div className="box">
          <div className="sb-lwordmark"><span className="ifc">IFC</span>Creatives Board</div>
          <div className="sb-statuscard">
            <div className="ic warn"><ExclamationTriangleIcon className="hi" aria-hidden="true"/></div>
            <h1>Something went wrong</h1>
            <p>We ran into an unexpected problem. The error has already been logged.
               If you have a moment, tell us what happened and we'll investigate.</p>
            {this.state.sent ? (
              <>
                <div className="sb-statusnote" role="status">Thanks — your report was sent.</div>
                <div className="sb-btnrow">
                  <button className="sb-btn" onClick={()=>location.reload()}>Reload app</button>
                </div>
              </>
            ) : (
              <>
                <div className="sb-field">
                  <label htmlFor="sb-crash-note">What happened? (optional)</label>
                  <textarea id="sb-crash-note" rows={3} value={this.state.note}
                    placeholder="e.g. I tapped Approve on a task and the screen went blank."
                    onChange={(e)=>this.setState({ note: e.target.value })} />
                </div>
                <div className="sb-btnrow">
                  <button className="sb-btn ghost" onClick={()=>location.reload()}>Reload app</button>
                  <button className="sb-btn" onClick={async ()=>{ await reportIssue({ note: this.state.note, action: "crash report" }); this.setState({ sent: true }); }}>Send report</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
}

/* ===================================================================
   DATA LAYER — Firebase Auth + Firestore (real-time)
   =================================================================== */

// Is this failure a transient network/offline problem (vs. a real app error)?
function isNetworkError(e) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const c = (e && e.code) || "";
  const m = (e && e.message) || "";
  return /unavailable|deadline-exceeded|network|offline/i.test(c)
      || /offline|network|unavailable|failed to get document/i.test(m);
}

// Track browser connectivity so we can show an offline banner + react to it.
function useOnline() {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

function useAuthUser() {
  const [user, setUser] = useState(undefined); // undefined=loading, null=signed out
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  return user;
}

// Make sure a signed-in user has a profile doc. First sign-in → pending.
// Throws on network failure; callers must catch (no floating promises).
async function ensureProfile(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      name: user.displayName || (user.email || "").split("@")[0],
      email: user.email || "",
      role: "member",
      status: "pending",
      skills: [],
      location: [],
      deprioritize: false, limited: false, manualSchedule: false,
      createdAt: serverTimestamp(),
    });
  }
}

// Live-subscribe to the signed-in user's own profile doc. Re-renders whenever
// an admin approves them or edits their skills, etc. Returns explicit states:
//   profile: undefined (loading) | null (no doc yet) | object
//   error: null | the Firestore error (e.g. offline) — so a network failure
//          surfaces a friendly retry screen instead of looking like "no profile".
function useProfile(uid, retryKey) {
  const [state, setState] = useState({ profile: undefined, error: null });
  useEffect(() => {
    if (!uid) { setState({ profile: null, error: null }); return; }
    setState({ profile: undefined, error: null });
    return onSnapshot(doc(db, "users", uid),
      (s) => setState({ profile: s.exists() ? { id: s.id, ...s.data() } : null, error: null }),
      (err) => {
        logIssue({ kind: "error", action: "login: profile read failed",
          message: err.message, code: err.code, note: "authenticated=true (Firestore read failed)" });
        setState({ profile: undefined, error: err });
      });
  }, [uid, retryKey]);
  return state;
}

// Live-subscribe to a whole collection ("users" or "tasks"). `canRead` gates
// the subscription so we don't query before the user is allowed (Firestore
// rules would reject it). A listener error leaves the last data in place and is
// logged — it never throws or crashes the dashboard.
// Returns [docs, loaded]. `loaded` distinguishes "the first snapshot has
// arrived" (whether it had rows or not) from "still waiting" — so callers can
// tell an empty result apart from an unloaded one and never render a "nothing
// here" state during hydration. Docs are preserved across a re-subscribe
// (path/canRead change) so switching filters doesn't flash empty.
function useCollection(path, canRead) {
  const [state, setState] = useState({ docs: [], loaded: false });
  useEffect(() => {
    if (!canRead) { setState({ docs: [], loaded: true }); return; }
    setState((s) => ({ docs: s.docs, loaded: false }));
    return onSnapshot(collection(db, path),
      (snap) => setState({ docs: snap.docs.map((d) => ({ id: d.id, ...d.data() })), loaded: true }),
      (err) => { setState((s) => ({ docs: s.docs, loaded: true }));   // surface (log) the error; don't hang on loading
        logIssue({ kind: "error", action: `collection read failed: ${path}`,
          message: err.message, code: err.code }); });
  }, [path, canRead]);
  return [state.docs, state.loaded];
}


/* Unsaved-changes guard for an editable modal/sheet.
   - Installs a browser `beforeunload` warning ONLY while `isDirty` (never when
     clean) — the one native confirmation we allow, for refresh / tab-close.
   - Returns `requestClose`: use it for every in-app close affordance (scrim, ✕,
     Escape, Cancel). When dirty it opens a branded "Leave without saving?"
     confirm instead of closing; when clean it closes immediately.
   - Render {leaveGuard} once inside the modal to mount that confirm dialog. */
function useUnsavedGuard(isDirty, onClose) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!isDirty) return;                       // no listener while the form is clean
    const h = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [isDirty]);
  const requestClose = () => { if (isDirty) setLeaving(true); else onClose(); };
  const leaveGuard = leaving ? (
    <ConfirmDialog tone="warning" icon="warning"
      title="Leave without saving?"
      body="You have unsaved changes. If you leave now, your changes will be lost."
      cancelLabel="Keep editing" confirmLabel="Leave without saving"
      onConfirm={onClose} onClose={() => setLeaving(false)} />
  ) : null;
  return { requestClose, leaveGuard };
}

/* Router-aware unsaved guard for URL-backed editors (the content editor).
   Closing is now a NAVIGATION, so a single useBlocker covers every path out —
   the ✕, the scrim, drag-to-dismiss, AND Android/browser Back — while dirty.
   beforeunload separately covers refresh / tab-close. On confirm we call
   blocker.proceed(), which completes the SAME pending navigation (no duplicate
   history entry); cancel calls blocker.reset(). The caller must clear dirty
   before its post-save close so that navigation isn't itself blocked. */
function useUnsavedRouteGuard(isDirty) {
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) =>
        isDirty &&
        (currentLocation.pathname !== nextLocation.pathname ||
          currentLocation.search !== nextLocation.search),
      [isDirty]
    )
  );
  useEffect(() => {
    if (!isDirty) return;
    const h = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [isDirty]);
  // If the form goes clean (e.g. saved) while a block is pending, let it through.
  useEffect(() => {
    if (!isDirty && blocker.state === "blocked") blocker.proceed();
  }, [isDirty, blocker.state]);
  const leaveGuard = blocker.state === "blocked" ? (
    <ConfirmDialog tone="warning" icon="warning"
      title="Leave without saving?"
      body="You have unsaved changes. If you leave now, your changes will be lost."
      cancelLabel="Keep editing" confirmLabel="Leave without saving"
      onConfirm={() => blocker.proceed()} onClose={() => blocker.reset()} />
  ) : null;
  return { leaveGuard };
}

// Live subscription to a single document. undefined=loading, null=absent, object=data.
function useDoc(path, canRead) {
  const [data, setData] = useState(undefined);
  useEffect(() => {
    if (!canRead) { setData(null); return; }
    return onSnapshot(doc(db, path),
      (s) => setData(s.exists() ? { id: s.id, ...s.data() } : null),
      (err) => { logIssue({ kind: "error", action: `doc read failed: ${path}`, message: err.message, code: err.code }); setData(null); });
  }, [path, canRead]);
  return data;
}

/* ===================================================================
   ROOT
   =================================================================== */
// Shared inline icons (nav icons live in the mainNav/mgmtNav model below).
// CSV import is hidden from navigation but fully implemented.
// Flip to true to restore Admin -> Import (see README).
const ENABLE_CSV_IMPORT = false;
const SparkIcon = () => <SparklesIcon className="hi" aria-hidden="true"/>;

const Ic = {
  chat: <ChatBubbleLeftRightIcon className="hi hi-sm" aria-hidden="true" style={{verticalAlign:"-4px"}} />,
};

export default function App() {
  const user = useAuthUser();                          // Firebase Auth user (or null)
  const online = useOnline();
  const [retryKey, setRetryKey] = useState(0);         // bump to re-subscribe / re-create
  const [setupError, setSetupError] = useState(null);  // profile-creation failure (offline)
  const [slow, setSlow] = useState(false);             // profile load is taking too long
  const creating = useRef(false);
  const { profile, error: profileError } = useProfile(user?.uid, retryKey);

  // Warm the Firestore cache in PARALLEL with the profile read: the moment we're
  // authenticated, start fetching the collections Board needs so their data is
  // already local by the time Board mounts — instead of profile → then → data
  // as two sequential round-trips. Best-effort (errors ignored: e.g. a still-
  // pending user can't read eventSeries yet).
  useEffect(() => {
    if (!user?.uid) return;
    for (const c of ["tasks", "users", "eventSeries"]) getDocs(collection(db, c)).catch(() => {});
  }, [user?.uid]);

  // First sign-in: create the pending profile doc if it doesn't exist yet.
  // Properly awaited + caught so an offline failure can never become an
  // unhandled promise rejection (the original crash).
  useEffect(() => {
    if (!(user && profile === null) || creating.current) return;
    creating.current = true;
    ensureProfile(user)
      .then(() => setSetupError(null))
      .catch((e) => {
        logIssue({ kind: "error", action: "login: create profile failed",
          message: e.message, code: e.code, note: "authenticated=true (Firestore write failed)" });
        setSetupError(e);
      })
      .finally(() => { creating.current = false; });
  }, [user, profile, retryKey]);

  // If we're stuck loading for a while — whether resolving the auth session
  // (Google sign-in / token refresh) OR reading the profile — surface the retry
  // screen instead of an endless spinner. This also covers iOS "zombie
  // connection" hangs after a mid-request network drop, where the SDK can sit on
  // a dead socket for minutes.
  useEffect(() => {
    setSlow(false);
    const loading = user === undefined || (user && profile === undefined && !profileError);
    if (!loading) return;
    const t = setTimeout(() => setSlow(true), 15000);
    return () => clearTimeout(t);
  }, [user, profile, profileError, retryKey]);

  // Signing out from the error screen should drop any stale profile-setup error.
  useEffect(() => { if (!user) setSetupError(null); }, [user]);

  // A full reload re-initializes Firebase with fresh connections — the most
  // reliable way to recover a stuck Auth/Firestore channel.
  const retry = () => { try { window.location.reload(); } catch { setSetupError(null); setSlow(false); setRetryKey((k) => k + 1); } };

  // Gating ladder. The "stuck/failed" check comes first so a hung Auth or
  // Firestore connection always yields a retry screen, never an endless spinner.
  let screen;
  if (profileError || setupError || slow)
    screen = <ConnError online={online} onRetry={retry} onSignOut={() => signOut(auth)} />;
  else if (user === undefined) screen = <Loading />;
  else if (!user) screen = <Login online={online} />;
  else if (profile === undefined) screen = <Loading label="Loading your account…" />;
  else if (profile === null) screen = <Loading label="Setting up your account…" />;
  else {
    const isAdmin = profile.role === "admin";
    const approved = profile.status === "approved" || isAdmin;
    screen = approved ? <Board profile={profile} isAdmin={isAdmin} /> : <Pending profile={profile} />;
  }

  return <><OfflineBanner online={online} />{screen}</>;
}

// A small top banner that announces connectivity changes.
function OfflineBanner({ online }) {
  const [show, setShow] = useState(!online);
  const [back, setBack] = useState(false);
  const prev = useRef(online);
  useEffect(() => {
    if (!online) { setBack(false); setShow(true); }
    else if (prev.current === false) {
      setBack(true); setShow(true);
      const t = setTimeout(() => setShow(false), 3000);
      prev.current = online;
      return () => clearTimeout(t);
    }
    prev.current = online;
  }, [online]);
  if (!show) return null;
  return <div className={"sb-netbar" + (online ? " ok" : "")}>
    {online ? "✓ Back online." : "⚠ You appear to be offline."}</div>;
}

// Friendly, recoverable screen for a login-time network failure.
function ConnError({ online, onRetry, onSignOut }) {
  return (
    <div className="sb-pending">
      <div className="box">
        <div className="sb-lwordmark"><span className="ifc">IFC</span>Creatives Board</div>
        <div className="sb-statuscard">
          <div className="ic" aria-hidden="true">📡</div>
          <h1>Can't connect</h1>
          <p>Unable to connect right now. Please check your internet connection and try again.</p>
          {!online && <p>Your device is currently offline.</p>}
          <div className="sb-btnrow">
            <button className="sb-btn ghost" onClick={onSignOut}>Sign out</button>
            <button className="sb-btn" onClick={onRetry}>Try again</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Loading({ label = "Loading IFC Creatives Board…" }) {
  return <div className="sb-loading"><div><div className="sb-spin" />{label}</div></div>;
}

/* ===================================================================
   LOGIN  (email/password + register + Google)
   =================================================================== */
function Login({ online = true }) {
  useEffect(() => setView("login"), []);
  const [mode, setMode] = useState("signin"); // signin | register
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [emailErr, setEmailErr] = useState("");
  const [showPw, setShowPw] = useState(false);

  const friendly = (e) => {
    const c = (e && e.code) || "";
    if (isNetworkError(e)) return "Unable to connect right now. Please check your internet connection and try again.";
    if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found"))
      return "Email or password isn't right.";
    if (c.includes("email-already-in-use")) return "That email already has an account. Try signing in.";
    if (c.includes("weak-password")) return "Password should be at least 6 characters.";
    if (c.includes("invalid-email")) return "That doesn't look like a valid email.";
    if (c.includes("too-many-requests")) return "Too many attempts. Please wait a moment and try again.";
    if (c.includes("popup-closed")) return "Google sign-in was cancelled.";
    return "Something went wrong. Please try again.";
  };

  const doEmail = async () => {
    setErr(""); setOk(""); setEmailErr("");
    if (!isValidEmail(email)) { setEmailErr("Enter a valid email address, such as name@example.com."); return; }
    setBusy(true);
    try {
      if (mode === "register") {
        if (!name.trim()) throw { code: "name" };
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), pw);
        await updateProfile(cred.user, { displayName: name.trim() });
        await ensureProfile({ ...cred.user, displayName: name.trim() });
        setOk("Account created! An admin needs to approve you before you can see the board.");
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), pw);
      }
    } catch (e) {
      setErr(e.code === "name" ? "Please enter your name." : friendly(e));
    } finally { setBusy(false); }
  };

  const doGoogle = async () => {
    setErr(""); setOk(""); setBusy(true);
    try { await signInWithPopup(auth, googleProvider); }
    catch (e) { setErr(friendly(e)); }
    finally { setBusy(false); }
  };

  const toggleMode = () => { setMode(m=>m==="register"?"signin":"register"); setErr(""); setOk(""); setEmailErr(""); };
  const doReset = async () => {
    setErr(""); setOk("");
    if (!isValidEmail(email)) { setEmailErr("Enter your email above first, then tap reset."); return; }
    try { await sendPasswordResetEmail(auth, email.trim()); setOk("Password reset email sent. Check your inbox."); }
    catch (e) { setErr(friendly(e)); }
  };
  return (
    <div className="sb-login">
      <div className="sb-loginbox">
        <div className="sb-lbrand">
          <div className="sb-lwordmark"><span className="ifc">IFC</span>Creatives Board</div>
          <div className="sb-tagline">Plan. Create. Review. Publish.</div>
          <p>The home of the IFC Creative Team.</p>
        </div>

        <div className="sb-lcard">
          <div className="sb-lcardhd">{mode === "register" ? "Create your account" : "Welcome back"}</div>
          {err && <div className="sb-lerr">{err}</div>}
          {ok && <div className="sb-lok">{ok}</div>}

          <button className="sb-gbtn" onClick={doGoogle} disabled={busy}>
            <GoogleIcon /> Continue with Google
          </button>
          <div className="sb-ldiv">or with email</div>

          {mode === "register" && (
            <div className="sb-field"><label>Your name</label>
              <input value={name} onChange={(e)=>setName(e.target.value)} placeholder="e.g. John Smith" /></div>
          )}
          <div className="sb-field"><label>Email<span className="sb-req" aria-hidden="true">*</span></label>
            <input type="email" inputMode="email" autoComplete="username" value={email}
              aria-invalid={!!emailErr} aria-describedby={emailErr?"login-email-err":undefined}
              onChange={(e)=>{ setEmail(e.target.value); if(emailErr) setEmailErr(""); }} placeholder="you@email.com" />
            {emailErr && <div className="sb-fielderr" id="login-email-err" role="alert">{emailErr}</div>}</div>
          <div className="sb-field">
            <label>Password<span className="sb-req" aria-hidden="true">*</span>{mode!=="register" && <button type="button" className="sb-fieldlink" onClick={doReset}>Forgot?</button>}</label>
            <div className="sb-pwwrap">
              <input type={showPw?"text":"password"} autoComplete={mode==="register"?"new-password":"current-password"}
                value={pw} onChange={(e)=>setPw(e.target.value)} placeholder="••••••••"
                onKeyDown={(e)=>{ if(e.key==="Enter") doEmail(); }} />
              <button type="button" className="sb-pwtoggle" onClick={()=>setShowPw(v=>!v)} aria-label={showPw?"Hide password":"Show password"}>
                {showPw ? <EyeSlashIcon className="hi hi-sm" aria-hidden="true"/> : <EyeIcon className="hi hi-sm" aria-hidden="true"/>}</button>
            </div></div>

          <button className="sb-btn sb-lprimary" onClick={doEmail} disabled={busy}>
            {busy ? "Please wait…" : mode === "register" ? "Create account" : "Sign in"}
          </button>

          <div className="sb-lswitch">
            <span>{mode === "register" ? "Already have an account?" : "New to the creative team?"}</span>
            <button className="sb-btn ghost" type="button" onClick={toggleMode}>
              {mode === "register" ? "Sign in instead" : "Create your account"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="sb-gicon" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.2 13.3 17.6 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.2-3.9 6.7-9.6 6.7-16.6z"/>
      <path fill="#FBBC05" d="M10.4 28.3c-.5-1.4-.7-2.9-.7-4.3s.3-2.9.7-4.3l-7.8-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.4l7.8-6.1z"/>
      <path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.1-5.5c-2 1.3-4.6 2.1-8.1 2.1-6.4 0-11.8-3.8-13.6-9.3l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/>
    </svg>
  );
}

/* ===================================================================
   PENDING APPROVAL
   =================================================================== */
function Pending({ profile }) {
  useEffect(() => setView("pending"), []);
  return (
    <div className="sb-pending">
      <div className="box">
        <div className="sb-lwordmark"><span className="ifc">IFC</span>Creatives Board</div>
        <div className="sb-statuscard">
          <div className="ic" aria-hidden="true">🪪</div>
          <h1>You're on the list, {profile.name.split(" ")[0]}</h1>
          <p>Your account is waiting for an admin to approve it. Once you're in, you'll see
             every reel and poster the team is working on. Hang tight — this usually doesn't take long.</p>
          <div className="sb-btnrow">
            <button className="sb-btn ghost" onClick={()=>signOut(auth)}>Sign out</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* A light page skeleton shown briefly during tab transitions — shimmer rows
   instead of a blank flash. */
function PageSkeleton() {
  return (
    <div className="sb-page sb-pageskel" aria-hidden="true">
      <span className="sb-skel" style={{width:"38%",height:26,display:"block"}}/>
      <span className="sb-skel" style={{width:"58%",height:14,display:"block",marginTop:12}}/>
      <div className="sb-skelgrid">
        {[0,1,2,3].map(i=><span className="sb-skel" key={i} style={{height:74}}/>)}
      </div>
      {[0,1,2].map(i=><span className="sb-skel" key={i} style={{height:56,display:"block",marginTop:10}}/>)}
    </div>
  );
}

/* Drag-to-dismiss for bottom sheets: the sheet follows the finger downward from
   a grab handle, then either flings closed (enough distance or downward
   velocity) or springs back. Pointer/touch based; scrolling is unaffected
   because only the handle starts a drag. */
function useSheetDrag(onClose) {
  const [y, setY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const st = useRef(null);
  const start = (e) => {
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    st.current = { y0:cy, last:cy, t:Date.now(), lt:Date.now() };
    setDragging(true);
  };
  const move = (e) => {
    if (!st.current) return;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    st.current.last = cy; st.current.lt = Date.now();
    setY(Math.max(0, cy - st.current.y0));
  };
  const end = () => {
    if (!st.current) return;
    const dy = Math.max(0, st.current.last - st.current.y0);
    const v = dy / Math.max(1, st.current.lt - st.current.t);     // px per ms
    st.current = null; setDragging(false);
    if (dy > 110 || v > 0.55) onClose(); else setY(0);
  };
  return {
    handleProps: { onTouchStart:start, onTouchMove:move, onTouchEnd:end,
      onPointerDown:start, onPointerMove:(e)=>{ if(st.current) move(e); }, onPointerUp:end },
    sheetStyle: { transform:`translateY(${y}px)`,
      transition: dragging ? "none" : "transform .28s cubic-bezier(.32,1.32,.5,1)" },
  };
}

/* ===================================================================
   MAIN BOARD (approved users)
   =================================================================== */
function Board({ profile, isAdmin }) {
  // `users` = the active team (used for assignment, capacity, owner pickers).
  // `allUsers` = everyone incl. pending — admins only, for the approval queue.
  const [usersAll] = useCollection("users", true);
  const users = usersAll.filter(u => u.status === "approved" || u.role === "admin");
  const [allUsers] = useCollection("users", isAdmin);
  const [tasksRaw, tasksLoaded] = useCollection("tasks", true);
  // Titles always DISPLAY in Title Case, whatever the user typed. Formatting
  // here at the source means every downstream surface (cards, modal, search,
  // activity, admin, reminder summaries) inherits it. We keep the untouched
  // original on `_rawTitle` so the editor edits/saves the real value — Firestore
  // is never mutated by presentation formatting (spec #3).
  const tasks = useMemo(() => tasksRaw.map(t =>
    t.title ? { ...t, title: formatContentTitle(t.title), _rawTitle: t.title } : t), [tasksRaw]);
  const [issues] = useCollection("issues", isAdmin); // admin-only (rules)
  const notifSettings = useDoc("settings/notifications", true); // reminder defaults
  const [eventSeries] = useCollection("eventSeries", true); // admin-managed recurring events

  // ---- URL is the source of truth for navigation. Everything below is
  // DERIVED from the current route; setters are navigation actions. ----
  const R = useNav();
  const { nav } = R;
  // The visible top-level screen. On /content/:id the detail sheet renders over
  // Workflow as its natural background; a non-admin on /admin can't be here.
  const tab = nav.screen === "content" ? "board"
    : (nav.screen === "admin" && !isAdmin) ? "home"
    : nav.screen;

  // One-time migration of legacy deep links (?task=, ?tab=&sec=) to canonical
  // URLs, via replace so the legacy URL never lingers in history. Runs before
  // the redirect effect below so a legacy URL is canonicalised, not bounced.
  const migrated = useRef(false);
  const legacy = !migrated.current && migrate(R.location.pathname, R.location.search);
  useEffect(() => {
    if (migrated.current) return;
    migrated.current = true;
    if (legacy) R.replace(legacy.pathname + (legacy.search || ""));
  }, []);

  // Redirects/normalisation (replace, never a new entry): /home → /, the
  // reserved /team/:memberId → /team, unknown → /, and /admin for a non-admin.
  useEffect(() => {
    if (legacy) return;                              // migration handles this tick
    if (nav.redirect && nav.redirect !== R.location.pathname) R.replace(nav.redirect);
    else if (nav.screen === "admin" && !isAdmin) R.replace("/");
  }, [nav.redirect, nav.screen, isAdmin, R.location.pathname]);

  // Inter-page transition: a brief skeleton on top-level screen change so
  // switching feels intentional. Overlays/content don't retrigger it.
  const [navLoading, setNavLoading] = useState(false);
  const firstNav = useRef(true);
  useEffect(() => {
    if (firstNav.current) { firstNav.current = false; return; }
    if (nav.screen === "content" || hasOverlay(nav.overlay)) return;  // overlay, not a page swap
    setNavLoading(true);
    const t = setTimeout(() => setNavLoading(false), 280);
    return () => clearTimeout(t);
  }, [tab]);

  // Derived overlay/detail state (read the URL; never stored in parallel).
  const openId = nav.screen === "content" ? nav.contentId : null;
  const editTask = nav.overlay.editor
    ? (nav.overlay.editor.mode === "new" ? "new" : (nav.overlay.editor.id || "new"))
    : null;
  const editPrefill = R.location.state?.composePrefill || null;
  const boardEvent = nav.event
    ? (R.location.state?.eventOcc
        ? { id: nav.event, label: R.location.state.eventOcc.name, annual: R.location.state.eventOcc.annual, name: R.location.state.eventOcc.name }
        : { id: nav.event, label: "Event", annual: false, name: "" })
    : null;
  const searchOpen = nav.overlay.panel === "search";
  const showDrawer = nav.overlay.panel === "profile";
  const notifOpenPanel = nav.overlay.panel === "notifications";
  // Memoised so its identity changes ONLY when the section changes — otherwise
  // Admin's [secReq] effect would re-fire every render and override the user's
  // in-panel tab clicks (which stay local, non-shareable).
  const adminSecReq = useMemo(() => nav.section ? { sec: nav.section, n: nav.section } : null, [nav.section]);

  // Navigation actions used throughout Board (thin wrappers over useNav).
  const setTab = (t) => R.goScreen(t);
  const setOpenId = (id) => { if (id) R.openContent(id); else R.goBack(); };
  const setEditTask = (t) => {
    if (!t) { R.closeOverlay(); return; }
    if (t === "new") R.openComposeNew();
    else R.openComposeEdit(t.id || t);
  };
  const newForEvent = (prefill) =>
    R.navigateWithState({ pathname: R.location.pathname, search: openComposeNew(R.location.search) }, { composePrefill: prefill });
  const viewEvent = (occ) => R.setEventFilter(occ.eventOccurrenceId, occ);
  const setBoardEvent = (v) => { if (!v) R.clearEventFilter(); };
  const setAdminSecReq = (req) => R.setAdminSection(req?.sec || null);
  const goPeople = () => R.navigate({ pathname: "/admin", search: withParams("", { [PARAM.section]: "people" }) });
  const setSearchOpen = (v) => v ? R.openPanel("search") : R.closeOverlay();
  const setShowDrawer = (v) => v ? R.openPanel("profile") : R.closeOverlay();
  const setNotifOpen = (v) => v ? R.openPanel("notifications") : R.closeOverlay();
  const notifOpen = notifOpenPanel;

  // A non-URL utility sheet (admin) — stays local, never in history.
  const [editUser, setEditUser] = useState(null);
  const [showReport, setShowReport] = useState(false);

  // Stamp the active screen onto any error/report logged from here.
  useEffect(() => setView(tab), [tab]);

  // Keep the document title in sync with the route (a11y + browser history).
  useEffect(() => {
    const ct = openId ? (tasks.find(t => t.id === openId)?.title) : null;
    document.title = titleFor(nav, ct);
  }, [nav, openId, tasks]);

  // Route-aware scroll restoration for the single scroll region (.sb-content):
  // new top-level pages start at the top; returning restores the prior offset.
  useScrollRestoration(R.location, nav);

  // A11y: on a genuine PAGE navigation (pathname change, no overlay open), move
  // focus to the main region so keyboard/SR focus is never stranded on a link
  // in the page we just left. Skipped while an overlay is up — the overlay owns
  // focus (its Portal traps it and restores to the trigger on close).
  const contentRef = useRef(null);
  const focusPath = useRef(R.location.pathname);
  useEffect(() => {
    if (focusPath.current === R.location.pathname) return;   // overlay/filter change
    focusPath.current = R.location.pathname;
    if (nav.screen !== "content" && !hasOverlay(nav.overlay))
      contentRef.current?.focus({ preventScroll: true });
  }, [R.location.pathname, nav.screen]);

  // Global search shortcuts: "/" or ⌘K / Ctrl+K from anywhere (but not while
  // typing in a field, so "/" stays usable in inputs).
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); setSearchOpen(true);
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault(); setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const me = profile;
  const pendingCount = allUsers.filter(u => u.status === "pending").length;

  // Notification Center (reads my notifications; backend writes them in Slice 3).
  // `notifOpen` is derived from the URL (?panel=notifications) up top — not
  // stored here. notifSettings/whatsNew/featureReq are minor local sub-dialogs.
  const notif = useNotifications(me.id);
  const [notifSettingsOpen, setNotifSettingsOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [featureReqOpen, setFeatureReqOpen] = useState(false);
  const saveNotifPrefs = async (prefs) => {
    try { await updateDoc(doc(db, "users", me.id), { notifPrefs: prefs }); }
    catch (e) { logIssue({ kind: "error", action: "save notif prefs", message: e.message, code: e.code }); }
  };
  // Foreground push → brief toast (the bell also updates live via onSnapshot).
  const [toast, setToast] = useState(null);
  useEffect(() => {
    let unsub = () => {};
    listenForeground((payload) => {
      const n = (payload && payload.notification) || {};
      setToast(n.title || "New notification");
      setTimeout(() => setToast(null), 4000);
    }).then((u) => { unsub = u; });
    return () => unsub();
  }, []);

  // Global action-feedback banner. Shows what's happening in the background:
  //   kind "pending" → persistent "Creating…/Saving…/Deleting…" (no auto-dismiss)
  //   kind "ok"/"err" → result, auto-dismisses; may carry an action (e.g. "View").
  // Fades in on show and out before unmounting, so re-triggers don't snap.
  const [banner, setBanner] = useState(null); // { msg, kind, leaving, action }
  const bannerT = useRef(null);
  const bannerLeaveT = useRef(null);
  const showPending = (msg) => {
    clearTimeout(bannerT.current); clearTimeout(bannerLeaveT.current);
    setBanner({ msg, kind: "pending", leaving: false, action: null });
  };
  const flashBanner = (msg, kind = "ok", action = null) => {
    clearTimeout(bannerT.current);
    clearTimeout(bannerLeaveT.current);
    setBanner({ msg, kind, leaving: false, action });
    bannerT.current = setTimeout(() => {
      setBanner(b => (b ? { ...b, leaving: true } : null));
      bannerLeaveT.current = setTimeout(() => setBanner(null), 220);
    }, action ? 6000 : 4300);   // linger longer when there's something to click
  };

  // Keep this device's FCM token alive. Tokens rotate/expire and stale ones get
  // pruned server-side; re-registering silently on each load (only when the user
  // already granted permission) prevents "push stops arriving even though the UI
  // says it's on." No prompt — enabling push is still an explicit opt-in.
  useEffect(() => { if (me?.id) refreshPushToken(me.id); }, [me?.id]);

  // Apply the appearance preference saved on the profile (so it follows the user
  // across devices). localStorage already handled the pre-auth / flash-free boot;
  // this only re-applies when Firestore disagrees. Never writes back here.
  useEffect(() => {
    const p = me?.appearance;
    if ((p === "system" || p === "light" || p === "dark") && p !== getThemePref()) setThemePref(p);
  }, [me?.appearance]);

  // Navigation model (v1.1.2): outline icon at rest, solid when active.
  // Mobile bottom nav = the 4 main destinations + Profile (Team/Admin live in
  // the profile sheet); desktop sidebar shows Main + Management groups.
  // Outline icons throughout (active state = colour + soft background).
  const navIco = (Out) => <Out className="hi hi-nav" aria-hidden="true" />;
  const mainNav = [
    { id:"home",  label:"Home",    ico:()=>navIco(HomeIcon) },
    { id:"myday", label:"My Day",  ico:()=>navIco(ClockIcon) },
    { id:"board", label:"Workflow", ico:()=>navIco(ViewColumnsIcon) },
    { id:"mine",  label:"My Work", ico:()=>navIco(ClipboardDocumentListIcon) },
  ];
  const mgmtNav = [
    { id:"team", label:"Team", ico:()=>navIco(UserGroupIcon) },
    ...(isAdmin ? [{ id:"admin", label:"Admin", badge: pendingCount, ico:()=>navIco(Cog6ToothIcon) }] : []),
  ];

  // Desktop sidebar: one shared active indicator that glides between items.
  // We measure the active button's position (robust to the Management group
  // gap + the 900–1139px icon-collapse) and drive a CSS-transitioned pill —
  // same "sliding indicator" language as the mobile bottom nav, no JS animation
  // library. Runs before paint so there's no first-mount slide.
  const navRef = useRef(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const place = () => {
      const active = nav.querySelector("button.on");
      if (!active) { nav.style.setProperty("--ind-o", "0"); return; }
      nav.style.setProperty("--ind-y", active.offsetTop + "px");
      nav.style.setProperty("--ind-h", active.offsetHeight + "px");
      nav.style.setProperty("--ind-o", "1");
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [tab, isAdmin, pendingCount]);

  /* ---- task writes ---- */
  const saveTask = async (t) => {
    const creating = !t.id;
    showPending(creating ? "Creating content…" : "Saving changes…");
    try {
      let newId = t.id;
      if (t.id) {
        const { id, ...rest } = t;
        await updateDoc(doc(db, "tasks", id), { ...rest, updatedAt: serverTimestamp() });
      } else {
        const ref = await addDoc(collection(db, "tasks"), {
          ...t, comments: [], reactions: {}, activity: [activityEntry("created", me.name)],
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        });
        newId = ref.id;
      }
      setEditTask(null);
      if (creating) flashBanner("✓ Content created", "ok", { label: "View", onClick: () => setOpenId(newId) });
      else flashBanner("✓ Changes saved", "ok");
    } catch (e) {
      flashBanner("Couldn't save — please try again.", "err");
      throw e;   // let the editor keep the form open and reset its saving state
    }
  };
  // Wrap a mutation with consistent feedback: an optional "in progress" banner
  // while it runs, then a success (or error) banner.
  const withFeedback = async (p, okMsg, pendingMsg) => {
    if (pendingMsg) showPending(pendingMsg);
    try { await p; flashBanner(okMsg, "ok"); }
    catch (e) { flashBanner("Something went wrong — please try again.", "err"); throw e; }
  };

  const deleteTask = (id) => withFeedback(deleteDoc(doc(db, "tasks", id)), "✓ Content deleted", "Deleting content…");

  // Archive = move to the Posted/completed status (no separate flag in the model).
  const archiveTask = (task) => withFeedback(
    updateDoc(doc(db, "tasks", task.id), {
      status: "Posted", archivedAt: serverTimestamp(),
      activity: [...(task.activity||[]), activityEntry("posted", me.name, "Posted")],
      updatedAt: serverTimestamp(),
    }), "✓ Marked as posted", "Updating…");

  // Duplicate = fresh copy at the start of the workflow, no produced artifacts.
  const duplicateTask = (task) => {
    const { id, _rawTitle, comments, reactions, activity, createdAt, updatedAt,
            caption, postLink, links, blockedOn, ...rest } = task;
    return withFeedback(addDoc(collection(db, "tasks"), {
      ...rest, title: `Copy of ${_rawTitle ?? task.title}`, status: "Planned",
      caption: "", postLink: "", links: {}, blockedOn: "",
      comments: [], reactions: {}, activity: [activityEntry("created", me.name)],
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }), "✓ Content duplicated", "Duplicating content…");
  };
  const importTasks = (newTasks) => withFeedback(
    Promise.all(newTasks.map((t) => addDoc(collection(db, "tasks"), {
      ...t, comments: [], reactions: {}, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }))), `✓ Imported ${newTasks.length} item${newTasks.length!==1?"s":""}`, `Importing ${newTasks.length} item${newTasks.length!==1?"s":""}…`);

  // Map a destination status → the activity-timeline event type.
  const eventType = (status) => ({
    "In Progress":"started", "In Review":"qa_sent", "Approved":"approved",
    "Changes Requested":"changes_requested", "Ready to Post":"ready", "Posted":"posted",
  }[status] || "status");
  // Admin manual status override (the status segmented control).
  const setStatus = (task, status) => withFeedback(
    updateDoc(doc(db, "tasks", task.id), {
      status, ...(status === "Posted" ? { archivedAt: serverTimestamp() } : {}),
      activity: [...(task.activity||[]), activityEntry(eventType(status), me.name, status)],
      updatedAt: serverTimestamp(),
    }), `✓ Moved to ${status}`);
  // The guided workflow action (Start work / Submit for QA / Mark ready / Posted).
  // `extra` carries caption / postLink when the step requires them.
  const runWorkflow = (task, action, extra = {}) => withFeedback(
    updateDoc(doc(db, "tasks", task.id), {
      status: action.to, ...extra,
      ...(action.to === "Posted" ? { archivedAt: serverTimestamp() } : {}),
      activity: [...(task.activity||[]), activityEntry(action.kind, me.name, action.to)],
      updatedAt: serverTimestamp(),
    }), `✓ Moved to ${action.to}`);
  // QA "request changes": send back as the first-class "Changes Requested" status.
  const qaRequestChanges = (task, note) => withFeedback(
    updateDoc(doc(db, "tasks", task.id), {
      status: "Changes Requested",
      activity: [...(task.activity||[]), activityEntry("changes_requested", me.name, note)],
      updatedAt: serverTimestamp(),
    }), "✓ Changes requested");
  // Collaborative fields any approved member can set from a task's detail view.
  const setBlocked = async (id, blockedOn) =>
    updateDoc(doc(db, "tasks", id), { blockedOn, updatedAt: serverTimestamp() });
  const setLinks = async (task, links) =>
    updateDoc(doc(db, "tasks", task.id), { links, updatedAt: serverTimestamp() });
  const addComment = (task, txt) => withFeedback(
    updateDoc(doc(db, "tasks", task.id), {
      comments: [...(task.comments||[]), { who: me.name, txt, tm: Date.now() }],
      updatedAt: serverTimestamp(),
    }), "✓ Note posted");
  const toggleReact = async (task, emo) => {
    const r = { ...(task.reactions||{}) };
    const arr = new Set(r[emo] || []);
    arr.has(me.name) ? arr.delete(me.name) : arr.add(me.name);
    r[emo] = [...arr];
    await updateDoc(doc(db, "tasks", task.id), { reactions: r, updatedAt: serverTimestamp() });
  };
  const autoAll = async () => {
    const targets = tasks.filter(t => !(t.support && t.support.length) && t.status !== "Posted");
    await withFeedback(Promise.all(targets.map(t =>
      updateDoc(doc(db, "tasks", t.id), { support: autoAssign(t, users, tasks), updatedAt: serverTimestamp() }))),
      `✓ Auto-assigned crew to ${targets.length} task${targets.length!==1?"s":""}`, "Auto-assigning crew…");
  };
  const autoOne = (task) => withFeedback(
    updateDoc(doc(db, "tasks", task.id), { support: autoAssign(task, users, tasks), updatedAt: serverTimestamp() }),
    "✓ Crew auto-assigned", "Assigning crew…");

  /* ---- user writes ---- */
  const saveUser = async (u) => {
    const { id, ...rest } = u;
    await withFeedback(updateDoc(doc(db, "users", id), rest), "✓ Team member updated", "Saving…");
    setEditUser(null);
  };
  const approveUser = async (u) => {
    await withFeedback(updateDoc(doc(db, "users", u.id), { ...u, status: "approved" }), "✓ Member approved", "Approving…");
    setEditUser(null);
  };
  const removeUser = (id) => withFeedback(deleteDoc(doc(db, "users", id)), "✓ Removed from team", "Removing…");
  // Safer team removal: detach the person from their tasks first (tasks stay),
  // either reassigning owned work to someone else or marking it for reassignment.
  const removeUserWithTasks = async (user, { mode, target } = {}) => {
    const updates = [];
    for (const t of tasks) {
      const ownsActive = t.owner === user.name && t.status !== "Posted";
      const isCrew = (t.support || []).some(s => s.name === user.name);
      if (!ownsActive && !isCrew) continue;
      const patch = { updatedAt: serverTimestamp() };
      if (ownsActive) {
        patch.owner = mode === "reassign" && target ? target : "Pending";
        patch.ownerSuggested = "";
      }
      if (isCrew) patch.support = t.support.filter(s => s.name !== user.name);
      updates.push(updateDoc(doc(db, "tasks", t.id), patch));
    }
    await withFeedback((async () => {
      await Promise.all(updates);
      await deleteDoc(doc(db, "users", user.id));
    })(), "✓ Removed from team", "Removing from team…");
  };

  /* ---- bulk-assign imported "Pending" tasks to a newly-matched user ---- */
  const assignSuggested = async (user) => {
    const matches = pendingMatches(user, tasks);
    if (!matches.length) return;
    await withFeedback(Promise.all(matches.map((t) => {
      const u = applyAssignment(t, user);
      return updateDoc(doc(db, "tasks", t.id),
        { owner: u.owner, ownerSuggested: u.ownerSuggested || "", support: u.support, updatedAt: serverTimestamp() });
    })), `✓ Assigned ${matches.length} task${matches.length!==1?"s":""}`, "Assigning tasks…");
  };

  /* ---- issue log (admin triage) ---- */
  const resolveIssue = (id, status) =>
    withFeedback(updateDoc(doc(db, "issues", id), { status }), status==="resolved"?"✓ Issue resolved":"✓ Issue reopened");

  const openTask = tasks.find(t => t.id === openId);

  // Admin quick-actions available on every task card + the detail sheet.
  const taskAdmin = useMemo(() => isAdmin ? {
    onEdit: (t) => { setOpenId(null); setEditTask(t); },
    onDuplicate: (t) => duplicateTask(t),
    onArchive: (t) => archiveTask(t),
    onDelete: async (t) => { if (openId === t.id) setOpenId(null); await deleteTask(t.id); },
  } : null, [isAdmin, openId, me]);

  return (
    <TaskAdminContext.Provider value={taskAdmin}>
    <div className="sb-root">
      <div className="sb-shell">
        <aside className="sb-side">
          <div className="sb-sbrand">
            <span className="sb-brandtext"><span className="ifc">IFC</span>Creatives Board</span></div>
          <button className="sb-searchbtn" onClick={()=>setSearchOpen(true)} aria-label="Search">
            <span className="ico"><MagnifyingGlassIcon className="hi hi-sm" aria-hidden="true"/></span><span className="lbl">Search…</span><kbd className="sb-kbd">/</kbd>
          </button>
          <nav className="sb-snav" aria-label="Main" ref={navRef}>
            <span className="sb-snav-ind" aria-hidden="true" />
            {mainNav.map(n => (
              <button key={n.id} className={tab===n.id?"on":""} onClick={()=>setTab(n.id)} aria-current={tab===n.id?"page":undefined}>
                <span className="ico">{n.ico(tab===n.id)}</span><span className="lbl">{n.label}</span>
                {n.badge>0 && <span className="pill">{n.badge}</span>}
              </button>
            ))}
            <div className="sb-navgroup lbl">Management</div>
            {mgmtNav.map(n => (
              <button key={n.id} className={tab===n.id?"on":""} onClick={()=>setTab(n.id)} aria-current={tab===n.id?"page":undefined}>
                <span className="ico">{n.ico(tab===n.id)}</span><span className="lbl">{n.label}</span>
                {n.badge>0 && <span className="pill">{n.badge}</span>}
              </button>
            ))}
          </nav>
          {isAdmin && <button className="sb-newbtn" onClick={()=>setEditTask("new")} aria-label="New content">
            <PlusIcon className="hi" aria-hidden="true"/><span className="lbl">New content</span></button>}
          {/* Personal area: Notifications, then Profile, then the quiet Report link. */}
          <div className="sb-sfoot">
            <button className="sb-report" onClick={()=>setNotifOpen(true)} aria-label="Notifications">
              <span className="sb-bellwrap"><BellIcon className="hi hi-sm" aria-hidden="true"/>
                {notif.unread>0 && <span className="sb-belldot">{notif.unread>9?"9+":notif.unread}</span>}</span>
              <span className="lbl">Notifications</span>
            </button>
            {/* Profile menu holds Theme, Team/Admin, Report, Sign out */}
            <button className="sb-suser sb-suserbtn" onClick={()=>setShowDrawer(true)} aria-label="Open profile menu" title="Profile & settings">
              <span className="sb-av" style={{width:34,height:34,fontSize:12}}>{initials(me.name)}</span>
              <span className="lbl"><div className="nm">{me.name}</div><div className="rl">{isAdmin?"Admin":"Member"}</div></span>
              <ChevronRightIcon className="chev lbl" style={{width:16,height:16}} aria-hidden="true"/>
            </button>
            <button className="sb-quietlink lbl" onClick={()=>setShowReport(true)}>Report an issue</button>
          </div>
        </aside>

        <div className="sb-main">
          <header className="sb-top">
            <span className="brand"><span className="brandwm"><span className="ifc-sm">IFC</span>Creatives Board</span></span>
            <div className="sb-topactions">
              <button className="sb-hbtn" onClick={()=>setSearchOpen(true)} aria-label="Search"><MagnifyingGlassIcon className="hi" aria-hidden="true"/></button>
              <button className="sb-hbtn sb-bellbtn" onClick={()=>setNotifOpen(true)}
                aria-label={notif.unread>0?`Notifications, ${notif.unread} unread`:"Notifications"}>
                <BellIcon className="hi" aria-hidden="true"/>
                {notif.unread>0 && <span className="sb-belldot">{notif.unread>9?"9+":notif.unread}</span>}
              </button>
            </div>
          </header>

          <div className="sb-content" ref={contentRef} tabIndex={-1}>
            <BetaBanner onReport={()=>setShowReport(true)} />
            {navLoading && <PageSkeleton />}
            <div className={navLoading ? "sb-pagehide" : "sb-pageshow"}>
            {tab==="home"  && <Home tasks={tasks} tasksLoaded={tasksLoaded} users={users} me={me} goTab={setTab} isAdmin={isAdmin} onNewForEvent={newForEvent} onViewEvent={viewEvent} openTask={setOpenId} eventSeries={eventSeries} />}
            {tab==="myday" && <MyDay tasks={tasks} me={me} openTask={setOpenId} goTab={setTab} />}
            {tab==="board" && <BoardList tasks={tasks} openTask={setOpenId} me={me} isAdmin={isAdmin} eventFilter={boardEvent} onClearEventFilter={()=>setBoardEvent(null)} />}
            {tab==="mine"  && <Mine tasks={tasks} me={me} openTask={setOpenId} />}
            {tab==="team"  && <Team tasks={tasks} users={users} />}
            {tab==="admin" && isAdmin && (
              <Admin users={allUsers} tasks={tasks} teamUsers={users} issues={issues} eventSeries={eventSeries}
                secReq={adminSecReq}
                onEditUser={setEditUser} onEditTask={setEditTask}
                onDeleteUser={removeUser} onRemoveUser={removeUserWithTasks} onDeleteTask={deleteTask}
                onArchiveTask={archiveTask} onDuplicateTask={duplicateTask} onOpenTask={setOpenId}
                onAutoAll={autoAll} onAutoOne={autoOne} onImport={importTasks} onResolveIssue={resolveIssue}
                onAssignSuggested={assignSuggested} onNewForEvent={newForEvent} />
            )}
            </div>
          </div>

          <nav className="sb-nav" aria-label="Main" style={{ "--nav-i": ["home","myday","board","mine"].indexOf(tab) >= 0 ? ["home","myday","board","mine"].indexOf(tab) : 4 }}>
            <span className="sb-nav-ind" aria-hidden="true" />
            {mainNav.map(n => (
              <button key={n.id} className={"sb-navbtn"+(tab===n.id?" on":"")} onClick={()=>setTab(n.id)} aria-current={tab===n.id?"page":undefined}>
                <span className="ico">{n.ico(tab===n.id)}</span><span className="lblx">{n.label}</span>
                {n.badge>0 && <span className="pill">{n.badge}</span>}
              </button>
            ))}
            <button className={"sb-navbtn"+(["team","admin"].includes(tab)?" on":"")} onClick={()=>setShowDrawer(true)} aria-current={["team","admin"].includes(tab)?"page":undefined} aria-label="Profile and more">
              <span className="ico"><span className="sb-av sb-navav">{initials(me.name)}</span></span><span className="lblx">Profile</span>
              {isAdmin && pendingCount>0 && <span className="pill">{pendingCount}</span>}
            </button>
          </nav>
        </div>
      </div>

      {/* Admin has its own "New content" button; every other tab — Home
          included — needs the FAB, since the sidebar one is desktop-only. */}
      {isAdmin && tab!=="admin" && (
        <button className="sb-fab" onClick={()=>setEditTask("new")} aria-label="New content"><PlusIcon className="hi hi-nav" aria-hidden="true"/></button>
      )}

      {showDrawer && (
        // Path/panel-changing actions navigate directly — the new URL replaces
        // ?panel=profile in ONE entry, so no redundant close-then-navigate.
        <ProfileDrawer me={me} isAdmin={isAdmin} unread={notif.unread} pendingCount={pendingCount}
          onClose={()=>setShowDrawer(false)} onGoTab={setTab}
          onNotifications={()=>setNotifOpen(true)}
          onNotifPrefs={()=>setNotifSettingsOpen(true)}
          onWhatsNew={()=>setWhatsNewOpen(true)}
          onFeatureRequest={()=>setFeatureReqOpen(true)}
          onReport={()=>setShowReport(true)} />
      )}

      {notifOpen && (
        <NotifCenter notif={notif} isAdmin={isAdmin}
          onClose={()=>setNotifOpen(false)}
          onOpenTask={setOpenId}
          onViewEvent={viewEvent}
          onGoPeople={goPeople}
          onGoTab={setTab}
          onSettings={()=>setNotifSettingsOpen(true)} />
      )}

      {notifSettingsOpen && (
        <NotifSettings me={me} isAdmin={isAdmin} onSave={saveNotifPrefs} onClose={()=>setNotifSettingsOpen(false)} />
      )}

      {whatsNewOpen && <WhatsNew onClose={()=>setWhatsNewOpen(false)} />}
      {featureReqOpen && <FeatureRequestModal onClose={()=>setFeatureReqOpen(false)} />}

      {toast && (
        <button className="sb-toast" onClick={()=>{ setToast(null); setNotifOpen(true); }}><BellIcon className="hi hi-sm" aria-hidden="true"/> {toast}</button>
      )}

      {banner && (
        <div className={"sb-savebanner "+banner.kind+(banner.leaving?" leaving":"")} role="status" aria-live="polite">
          {banner.kind==="pending"
            ? <span className="sb-banner-spin" aria-hidden="true"/>
            : banner.kind==="err"
            ? <ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true"/>
            : <CheckCircleIcon className="hi hi-sm" aria-hidden="true"/>}
          <span className="sb-banner-msg">{banner.msg}</span>
          {banner.action && <button className="sb-banner-action"
            onClick={()=>{ const a = banner.action; setBanner(null); a.onClick(); }}>{banner.action.label}</button>}
          {banner.kind!=="pending" && <button className="sb-x" onClick={()=>setBanner(null)} aria-label="Dismiss"><XMarkIcon className="hi" aria-hidden="true"/></button>}
        </div>
      )}

      {searchOpen && (
        <GlobalSearch tasks={tasks} users={isAdmin ? allUsers : users}
          onClose={()=>setSearchOpen(false)}
          onOpenTask={setOpenId}
          goTab={setTab} />
      )}

      {openTask && (
        <TaskDetail key={openTask.id} task={openTask} me={me} isAdmin={isAdmin}
          isQA={isAdmin || !!me.qa}
          onClose={()=>setOpenId(null)}
          onStatus={(s)=>setStatus(openTask, s)}
          onAction={(action, extra)=>runWorkflow(openTask, action, extra)}
          onApprove={()=>setStatus(openTask, "Approved")}
          onLinks={(links)=>setLinks(openTask, links)}
          onRequestChanges={(note)=>qaRequestChanges(openTask, note)}
          onBlocked={(b)=>setBlocked(openTask.id, b)}
          onComment={(txt)=>addComment(openTask, txt)}
          onReact={(emo)=>toggleReact(openTask, emo)}
          onSaved={()=>flashBanner("✓ Saved just now")}
          onDuplicate={isAdmin ? async ()=>{ await duplicateTask(openTask); setOpenId(null); } : undefined}
          onArchive={isAdmin ? async ()=>{ await archiveTask(openTask); setOpenId(null); } : undefined}
          onDelete={isAdmin ? async ()=>{ await deleteTask(openTask.id); setOpenId(null); } : undefined}
          onEdit={()=>setEditTask(openTask)} />
      )}
      {editTask && (
        // editTask is "new" or a task id (from ?compose/?edit) — resolve the id
        // to the live task object here. The editor may render OVER the detail
        // (/content/:id?edit=id) as an intentional nested flow.
        <TaskEditor task={editTask==="new"?null:tasks.find(t=>t.id===editTask)} prefill={editPrefill} users={users} allTasks={tasks}
          defaultReminders={notifSettings?.defaultReminders}
          onClose={()=>setEditTask(null)}
          onSave={(t)=>saveTask(t)} onAuto={(t)=>autoAssign(t, users, tasks)} />
      )}
      {editUser && (
        <UserEditor user={editUser} onClose={()=>setEditUser(null)}
          onSave={saveUser} onApprove={approveUser} />
      )}
      {showReport && <ReportIssue onClose={()=>setShowReport(false)} />}
    </div>
    </TaskAdminContext.Provider>
  );
}

/* ===================================================================
   REPORT ISSUE  (any signed-in user can file a problem)
   =================================================================== */
function ReportIssue({ onClose }) {
  const [note, setNote] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | error
  const isDirty = !!note.trim() && state !== "sent";   // typed text not yet sent
  const { requestClose, leaveGuard } = useUnsavedGuard(isDirty, onClose);
  const send = async () => {
    setState("sending");
    const ok = await reportIssue({ note: note.trim(), action: "manual report" });
    setState(ok ? "sent" : "error");
  };
  return (
    <Portal>
    <div className="sb-scrim" onClick={requestClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()}>
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>Report an issue</b>
          <button className="sb-x" onClick={requestClose}><XMarkIcon className="hi" aria-hidden="true" /></button></div>
        <div className="bd">
          {state==="sent" ? (
            <div className="sb-empty"><div className="big"><CheckCircleIcon className="hi hi-empty" aria-hidden="true"/></div>
              Thanks. Your report was sent and we'll take a look.</div>
          ) : <>
            <div className="sb-sub" style={{marginTop:0}}>
              Tell us what went wrong or felt off. We'll automatically include your
              account, the screen you're on, and your device details.</div>
            <div className="sb-field"><label>What happened?<span className="sb-req" aria-hidden="true">*</span></label>
              <textarea rows={5} value={note} onChange={e=>setNote(e.target.value)}
                placeholder="e.g. I tried to mark a reel Approved and nothing happened." /></div>
            {state==="error" && <div className="sb-lerr">Couldn't send that. Please try again.</div>}
            <button className="sb-btn compact" disabled={!note.trim() || state==="sending"} onClick={send}>
              {state==="sending" ? "Sending…" : "Send report"}</button>
          </>}
        </div>
      </div>
    </div>
    {leaveGuard}
    </Portal>
  );
}

/* ===================================================================
   HOME (personal)
   =================================================================== */
/* Reusable KPI card — a large number over a label in a card that only "lights
   up" (subtle tint + accent number) when the value is > 0, so the eye is drawn
   to actionable metrics and calm zeros recede. The number animates on change.
   Shared card component for dashboard KPI rows (My Day today; Home/Admin/Team
   can adopt it for consistency). */
function KpiCard({ n, label, tone, onClick }) {
  const on = n > 0;
  const cls = "sb-kpi tone-" + tone + (on ? " on" : "");
  const inner = <>
    <span className="sb-kpi-n"><AnimatedNumber value={n}/></span>
    <span className="sb-kpi-l">{label}</span>
  </>;
  return onClick
    ? <button className={cls} onClick={onClick} aria-label={`${n} ${label}`}>{inner}</button>
    : <div className={cls}>{inner}</div>;
}

function MyDay({ tasks, me, openTask, goTab }) {
  // Personal slices, used for the compact "your numbers" strip.
  const mine = tasks.filter(t => t.owner===me.name || (t.support||[]).some(s=>s.name===me.name));
  const myActive = mine.filter(t => t.status!=="Posted");
  const myOverdue = myActive.filter(t => { const d=daysTo(t.postDate); return d!==null && d<0; });
  const myDueSoon = myActive.filter(t => { const d=daysTo(t.postDate); return d!==null && d>=0 && d<=2; });
  const myReview  = myActive.filter(t => t.status==="In Review");
  const myMaking  = myActive.filter(t => t.status==="Planned" || t.status==="In Progress");

  // The centrepiece: a short, ranked list of what actually needs the user now.
  const attention = attentionItems(tasks, me);

  // Role-specific queues. QA reviewers and the caption/upload team get a focused
  // dashboard instead of (well, ahead of) the contributor attention list.
  const qq = qaQueue(tasks);
  const pq = postQueue(tasks);
  const focusMsg = me.qa
    ? (qq.awaiting.length + qq.returned.length
        ? `${qq.awaiting.length + qq.returned.length} item(s) need your review.` : "Nothing needs your review right now.")
    : me.captions
    ? (pq.captions.length + pq.ready.length + pq.overdue.length
        ? `${pq.captions.length + pq.ready.length + pq.overdue.length} item(s) to caption or post.` : "Nothing approved is waiting to post.")
    : (attention.length
        ? `${attention.length} thing${attention.length!==1?"s":""} need${attention.length===1?"s":""} your attention.`
        : "You're all clear. Nothing needs you right now.");

  const myDueToday = myActive.filter(t => daysTo(t.postDate)===0);
  // KPI cards, ordered by a person's morning mental model: what am I working on,
  // what's due today, am I behind, what's waiting on someone else.
  const kpis = [
    { n:myMaking.length,   label:"Active",          tone:"blue"  },
    { n:myDueToday.length, label:"Due today",       tone:"amber" },
    { n:myOverdue.length,  label:"Overdue",         tone:"red"   },
    { n:myReview.length,   label:"Awaiting review", tone:"green" },
  ];

  return (
    <div className="sb-page">
      <div className="sb-h">My Day</div>
      <div className="sb-sub">{focusMsg}</div>

      {/* QA reviewer dashboard — "what needs my approval today?" */}
      {me.qa && <>
        <div className="sb-div"><span>For your review</span></div>
        <QueueSection title="Awaiting your approval" items={qq.awaiting} me={me} openTask={openTask} />
        <QueueSection title="Returned for changes" items={qq.returned} me={me} openTask={openTask} />
        <QueueSection title="Recently approved" items={qq.approved} me={me} openTask={openTask} />
        {qq.awaiting.length===0 && qq.returned.length===0 &&
          <div className="sb-empty"><div className="big"><CheckCircleIcon className="hi hi-empty" aria-hidden="true"/></div>No content is waiting on your review.</div>}
      </>}

      {/* Caption / upload dashboard — "what's approved and needs posting?" */}
      {me.captions && <>
        <div className="sb-div"><span>Captions &amp; posting</span></div>
        <QueueSection title="Approved: needs captions" items={pq.captions} me={me} openTask={openTask} />
        <QueueSection title="Ready to post" items={pq.ready} me={me} openTask={openTask} />
        <QueueSection title="Overdue posts" items={pq.overdue} me={me} openTask={openTask} />
        {pq.captions.length===0 && pq.ready.length===0 && pq.overdue.length===0 &&
          <div className="sb-empty"><div className="big"><CheckCircleIcon className="hi hi-empty" aria-hidden="true"/></div>Nothing approved is waiting to be posted.</div>}
      </>}

      {(me.qa || me.captions) && <div className="sb-div"><span>Your own tasks</span></div>}

      {/* Personal metrics as KPI cards (2×2 on phones, one row on desktop). */}
      <div className="sb-kpigrid">
        {kpis.map(k => (
          <KpiCard key={k.label} n={k.n} label={k.label} tone={k.tone} onClick={()=>goTab("mine")} />
        ))}
      </div>

      <div className="sb-shead sb-shead-strong"><h2>Needs your attention</h2>
        <button className="link subtle" onClick={()=>goTab("mine")}>All my work →</button></div>
      {attention.length===0
        ? <div className="sb-empty"><div className="big"><CheckCircleIcon className="hi hi-empty" aria-hidden="true"/></div>Nothing urgent. Enjoy the breather.</div>
        : <div className="sb-attnlist">{attention.map(t =>
            <AttentionItem key={t.id} t={t} onClick={()=>openTask(t.id)} />)}</div>}

    </div>
  );
}

/* A titled list of task cards for the role dashboards; renders nothing when
   the queue is empty so My Day stays focused. */
function QueueSection({ title, items, me, openTask }) {
  if (!items.length) return null;
  return (
    <>
      <div className="sb-shead"><h2>{title}</h2><span className="sb-tag">{items.length}</span></div>
      <div className="sb-list">{items.map(t => <TaskCard key={t.id} t={t} me={me} onClick={()=>openTask(t.id)} />)}</div>
    </>
  );
}

/* A single actionable row in "Needs your attention" — the task title plus the
   reason it surfaced and why it's urgent. Tighter than a full TaskCard. */
function AttentionItem({ t, onClick }) {
  const d = daysTo(t.postDate);
  // Why is this on the list? Most pressing reason wins.
  const reason = t.blockedOn ? `Waiting on ${t.blockedOn}`
    : (d!==null && d<0) ? `${Math.abs(d)}d overdue`
    : d===0 ? "Due today"
    : d===1 ? "Due tomorrow"
    : t.status==="Changes Requested" ? "Changes requested"
    : t.status==="In Review" ? "In review"
    : (d!==null) ? `Due ${fmt(t.postDate)}` : "Needs a look";
  const reasonCls = (t.blockedOn || (d!==null && d<0) || t.status==="Changes Requested") ? "due-over"
    : (d!==null && d<=2) ? "due-soon" : "due-ok";
  // Lead with the system-derived next step so the row reads as a to-do.
  const label = `${nextStep(t.status)}: ${t.title}`;
  return (
    <button className="sb-attn" onClick={onClick}>
      <span className={"sb-attn-bar "+reasonCls}/>
      <span className="sb-av sb-attn-av" aria-hidden="true">{t.owner && t.owner!=="Pending" ? initials(t.owner) : "?"}</span>
      <span className="sb-attn-main">
        <span className="sb-attn-title">{label}</span>
        <span className="sb-attn-sub">
          {t.priority==="High" && <span className={"sb-pri "+priorityClass(t.priority)}>▲ High</span>}
          <span className={"sb-due "+reasonCls}>{reason}</span>
          <span className="muted">{t.type} · {t.location==="Both"?"479+828":t.location}</span>
        </span>
      </span>
      <span className="sb-attn-chev"><ChevronRightIcon className="hi hi-sm" aria-hidden="true" /></span>
    </button>
  );
}

/* ===================================================================
   GLOBAL SEARCH — a "find anything" overlay reachable from anywhere
   (header button, "/" or ⌘K / Ctrl+K). Spans tasks (every status, incl.
   archive), people, and ministry events — never limited by board filters.
   =================================================================== */
function GlobalSearch({ tasks, users, onClose, onOpenTask, goTab }) {
  const [q, setQ] = useState("");
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const query = q.trim();
  const taskHits = query ? searchTasks(tasks, query).slice(0, 8) : [];
  const peopleHits = query ? searchPeople(users, query).slice(0, 6) : [];
  const eventHits = query ? searchEvents(query).slice(0, 5) : [];
  const nothing = query && !taskHits.length && !peopleHits.length && !eventHits.length;

  return (
    <Portal>
    <div className="sb-modal" onMouseDown={onClose}>
      <div className="sb-search" onMouseDown={e=>e.stopPropagation()}>
        <div className="sb-searchbar">
          <span className="ico"><MagnifyingGlassIcon className="hi" aria-hidden="true"/></span>
          <input ref={inputRef} value={q} onChange={e=>setQ(e.target.value)}
            placeholder="Search tasks, people, events…" />
          <kbd className="sb-kbd sb-deskonly">ESC</kbd>
          <button className="sb-searchclose" onClick={onClose} aria-label="Close search"><XMarkIcon className="hi" aria-hidden="true" /></button>
        </div>

        {!query && <div className="sb-searchhint">
          Find anything across the whole app: titles, owners &amp; crew, statuses,
          types, locations, notes, links, people and upcoming events.
        </div>}

        {nothing && <div className="sb-searchhint">No matches for “{query}”.</div>}

        <div className="sb-searchresults">
          {taskHits.length>0 && <>
            <div className="sb-searchsec">Content · {taskHits.length}</div>
            {taskHits.map(t => (
              <button key={t.id} className="sb-sresult" onClick={()=>onOpenTask(t.id)}>
                <span className="r-main">{t.title}</span>
                <span className={"sb-status "+statusClass(t.status)}><span className="pip"/>{t.status}</span>
                <span className="r-sub">{t.type} · {t.owner==="Pending"&&t.ownerSuggested?`Pending: ${t.ownerSuggested}`:t.owner}</span>
              </button>
            ))}
          </>}

          {peopleHits.length>0 && <>
            <div className="sb-searchsec">People · {peopleHits.length}</div>
            {peopleHits.map(u => (
              <button key={u.id} className="sb-sresult" onClick={()=>goTab("team")}>
                <span className="sb-av" style={{width:26,height:26,fontSize:10}}>{initials(u.name)}</span>
                <span className="r-main">{u.name}</span>
                <span className="r-sub">{u.role==="admin"?"Admin":"Member"}{u.qa?" · QA":""}{u.captions?" · Captions":""} · {u.status}</span>
              </button>
            ))}
          </>}

          {eventHits.length>0 && <>
            <div className="sb-searchsec">Events · {eventHits.length}</div>
            {eventHits.map((e,i) => (
              <button key={i} className="sb-sresult" onClick={()=>goTab("home")}>
                <span className="r-icon">{e.emoji?<span className="sb-emoji" aria-hidden="true">{e.emoji}</span>:e.kind==="birthday"?<span className="sb-emoji" aria-hidden="true">🎂</span>:<CalendarDaysIcon className="hi" aria-hidden="true"/>}</span>
                <span className="r-main">{e.name}</span>
                <span className="r-sub">{e.daysAway===0?"Today":`in ${e.daysAway} day${e.daysAway!==1?"s":""}`}</span>
              </button>
            ))}
          </>}
        </div>
      </div>
    </div>
    </Portal>
  );
}

/* ===================================================================
   BOARD LIST
   =================================================================== */
function BoardList({ tasks, openTask, me, isAdmin, eventFilter, onClearEventFilter }) {
  const [filter, setFilter] = useState("all");
  // Board (grouped cards) vs List (dense rows); the choice is remembered.
  const [view, setView] = useState(() => loadPref("sb-board-view", "board"));
  const pickView = (v) => { setView(v); savePref("sb-board-view", v); };
  const [sort, setSort] = useState("post-asc");
  const [filtersOpen, setFiltersOpen] = useState(false);  // collapsed by default → content first
  // Completed work starts collapsed; the choice is remembered across sessions.
  const [collapsed, setCollapsed] = useState(() => loadPref("sb-board-collapsed", { Posted: true }));
  const persistCollapsed = (next) => { setCollapsed(next); savePref("sb-board-collapsed", next); };
  const toggle = (status) => persistCollapsed({ ...collapsed, [status]: !collapsed[status] });
  const setAllCollapsed = (val) => { const m = {}; STAGES.forEach(s => m[s] = val); persistCollapsed(m); };

  const availableFilters = useMemo(
    () => BOARD_FILTERS.filter(f => !f.admin || isAdmin), [isAdmin]);
  // When arriving from an event's "View content", scope the board to that
  // specific occurrence (occurrence id, with a name fallback for annual events).
  const scoped = useMemo(() => {
    if (!eventFilter) return tasks;
    const occ = { eventOccurrenceId: eventFilter.id, annual: eventFilter.annual, name: eventFilter.name };
    return occurrenceTasks(occ, tasks);
  }, [tasks, eventFilter]);
  const groups = useMemo(() => {
    const filtered = applyBoardFilter(scoped, filter, me);
    return groupByStatus(sortTasks(filtered, sort));
  }, [scoped, filter, sort, me]);

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const activeFilter = BOARD_FILTERS.find(f => f.id === filter);

  return (
    <div className="sb-page">
      <div className="sb-h">Workflow</div>
      <div className="sb-sub">
        {total} piece{total!==1?"s":""} of content{filter!=="all"?` · ${activeFilter?.label}`:""},
        grouped by where each one is in the workflow.
      </div>

      {eventFilter && (
        <div className="sb-chiprow" style={{marginTop:10}}>
          <button className="sb-fchip on" onClick={onClearEventFilter}>
            <CalendarDaysIcon className="hi hi-sm" aria-hidden="true"/> {eventFilter.label} · Clear <XMarkIcon className="hi hi-sm" aria-hidden="true"/>
          </button>
        </div>
      )}

      {/* Filters — collapsed by default so content shows first */}
      <div className="sb-filterbar">
        <button className="sb-filtertoggle" onClick={()=>setFiltersOpen(o=>!o)} aria-expanded={filtersOpen}>
          <span className="ico"><FunnelIcon className="hi hi-sm" aria-hidden="true"/></span>Filters
          {filter!=="all" && <span className="sb-filteractive">{activeFilter?.label}</span>}
          <span className={"sb-chev"+(filtersOpen?" open":"")}><ChevronRightIcon className="hi hi-sm" aria-hidden="true" /></span>
        </button>
        <div className="sb-viewtoggle" role="group" aria-label="View">
          <button className={view==="board"?"on":""} onClick={()=>pickView("board")} aria-pressed={view==="board"}>
            <ViewColumnsIcon className="hi hi-sm" aria-hidden="true"/><span>Board</span></button>
          <button className={view==="list"?"on":""} onClick={()=>pickView("list")} aria-pressed={view==="list"}>
            <ClipboardDocumentListIcon className="hi hi-sm" aria-hidden="true"/><span>List</span></button>
        </div>
        <label className="sb-sortlbl">
          <select className="sb-select" value={sort} onChange={e=>setSort(e.target.value)} aria-label="Sort">
            {BOARD_SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </div>
      {filtersOpen && <div className="sb-chiprow">
        {availableFilters.map(f => (
          <button key={f.id} className={"sb-fchip"+(filter===f.id?" on":"")}
            onClick={()=>{ setFilter(f.id); setFiltersOpen(false); }}>{f.label}</button>
        ))}
      </div>}

      {/* Status groups */}
      {groups.length>1 && <div className="sb-collapserow">
        <button className="sb-collapselink" onClick={()=>setAllCollapsed(!groups.every(g=>collapsed[g.status]))}>
          {groups.every(g=>collapsed[g.status]) ? "Expand all" : "Collapse all"}
        </button>
      </div>}
      {groups.length===0
        ? <div className="sb-empty"><div className="big"><ViewColumnsIcon className="hi hi-empty" aria-hidden="true"/></div>No content matches these filters.</div>
        : groups.map(g => {
            // When a filter narrows the board to a single status group, always
            // show it open (e.g. the Archive filter shouldn't land collapsed).
            const isCollapsed = groups.length > 1 && !!collapsed[g.status];
            const archive = g.status === "Posted";
            return (
              <section className={"sb-group"+(archive?" archived":"")} key={g.status}>
                <button className="sb-grouphd" onClick={()=>toggle(g.status)} aria-expanded={!isCollapsed}>
                  <span className={"sb-chev"+(isCollapsed?"":" open")}><ChevronRightIcon className="hi hi-sm" aria-hidden="true" /></span>
                  {archive
                    ? <span className="sb-status st-archived"><span className="pip"/>Archived</span>
                    : <span className={"sb-status "+statusClass(g.status)}><span className="pip"/>{g.status}</span>}
                  <span className="sb-groupct">{g.items.length}</span>
                </button>
                {!isCollapsed && (view==="list"
                  ? <div className="sb-listrows">
                      <div className="sb-listhead" aria-hidden="true">
                        <span>Content</span><span>Status</span><span>Owner</span><span>Due</span>
                      </div>
                      {g.items.map(t => {
                        const d = daysTo(t.postDate);
                        return (
                        <button key={t.id} className="sb-listrow" onClick={()=>openTask(t.id)}>
                          <span className="t">{t.title}</span>
                          <span className={"sb-status "+statusClass(t.status)}><span className="pip"/>{t.status}</span>
                          <span className="who"><span className="sb-av" style={{width:22,height:22,fontSize:9}}>{initials(t.owner)}</span></span>
                          <span className={"due"+(d!==null&&d<0&&t.status!=="Posted"?" late":"")}>{fmt(t.postDate)}</span>
                        </button>);
                      })}
                    </div>
                  : <div className="sb-list">
                      {g.items.map(t => <TaskCard key={t.id} t={t} me={me} onClick={()=>openTask(t.id)} />)}
                    </div>
                )}
              </section>
            );
          })}
    </div>
  );
}

/* ===================================================================
   MINE
   =================================================================== */
function Mine({ tasks, me, openTask }) {
  const sections = useMemo(() => myWorkSections(tasks, me), [tasks, me]);
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  // Only the urgent buckets start expanded; the rest stay collapsed so the
  // screen opens focused. The user's expand/collapse choice is remembered.
  const [override, setOverride] = useState(() => loadPref("sb-mine-collapsed", {}));
  const openByDefault = (key) => ["overdue", "soon", "review"].includes(key);
  const isOpen = (key) => key in override ? override[key] : openByDefault(key);
  const persist = (next) => { setOverride(next); savePref("sb-mine-collapsed", next); };
  const toggle = (key) => persist({ ...override, [key]: !isOpen(key) });
  const setAll = (val) => { const m = {}; sections.forEach(s => m[s.key] = val); persist(m); };
  const allOpen = sections.length > 0 && sections.every(s => isOpen(s.key));
  // The two urgency buckets get a subtle accent so they read as "do this first".
  const accent = { overdue: " urgent", soon: " soon" };
  return (
    <div className="sb-page">
      <div className="sb-h">My work</div>
      <div className="sb-sub">
        {total===0 ? "You're all clear. Nothing assigned to you right now."
          : `${total} thing${total!==1?"s":""} with your name on ${total!==1?"them":"it"}, most urgent first.`}
      </div>

      {total===0 && <div className="sb-empty"><div className="big"><CheckCircleIcon className="hi hi-empty" aria-hidden="true"/></div>No assignments yet. Your creative work will appear here.</div>}

      {sections.length>1 && <div className="sb-collapserow">
        <button className="sb-collapselink" onClick={()=>setAll(!allOpen)}>{allOpen?"Collapse all":"Expand all"}</button>
      </div>}

      {sections.map(s => {
        const open = isOpen(s.key);
        return (
          <div key={s.key}>
            <button className={"sb-shead sb-sheadbtn"+(accent[s.key]||"")} onClick={()=>toggle(s.key)} aria-expanded={open}>
              <span className={"sb-chev"+(open?" open":"")}><ChevronRightIcon className="hi hi-sm" aria-hidden="true" /></span>
              <h2>{s.label}</h2><span className="sb-tag">{s.items.length}</span>
            </button>
            {open && <div className="sb-list">{s.items.map(t => <TaskCard key={t.id} t={t} me={me} onClick={()=>openTask(t.id)} />)}</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ===================================================================
   TEAM
   =================================================================== */
/* Bucket label + timeline order for the breakdown. */
// Timeline windows for the expanded breakdown (decision-focused wording).
const LOAD_BUCKETS = [
  ["thisWeek", "Due this week"], ["nextWeek", "Due next week"],
  ["later", "Later"], ["unscheduled", "No date"],
];

// The one status worth showing — and only when it changes the decision.
// Light/Balanced show no chip (the meter + counts already say enough).
function capacityStatus(u, load) {
  if (!isAvailable(u)) return { label: "Unavailable", tone: "neutral" };
  if (load.activePoints <= 0) return { label: "Available", tone: "green" };
  if (load.band.key === "high") return { label: "Near capacity", tone: "red" };
  if (load.band.key === "busy") return { label: "Busy", tone: "amber" };
  return null;
}
// Coarse 0–4 level for the segmented "Current load" meter (communicates an
// estimate/level, not a false-precise percentage).
const BAND_LEVEL = { unavail: 0, available: 0, light: 1, balanced: 2, busy: 3, high: 4 };
const STALE_REASON = {
  "shoot-passed-still-planned": "Shoot date passed — still Planned",
  "post-passed-not-posted": "Post date passed — not Posted",
};
// Compact due-date label for a responsibility.
function respDue(dateStr) {
  const dd = dateStr ? daysTo(dateStr) : null;
  if (dd == null) return "No date";
  if (dd < 0) return "Overdue";
  if (dd === 0) return "Due today";
  if (dd === 1) return "Due tomorrow";
  if (dd <= 6) return "Due " + new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });
  return "Due " + fmt(dateStr);
}

/* One person's capacity card, built to answer "can I safely assign more to this
   person?" It leads with deadline concentration (N due this week), demotes the
   load to a coarse band meter, and shows the dated timeline when expanded.
   Stateless re: expansion — `open`/`onToggle` come from the parent. */
function CapCard({ u, load, tasks, open, onToggle }) {
  const dept = userDepartments(u).join(" · ") || (roleChips(u)[0] || "");
  const status = capacityStatus(u, load);
  const level = BAND_LEVEL[load.band.key] ?? 0;
  const tone = load.band.tone;
  const dueThisWeek = load.buckets.thisWeek.length;
  const inProgress = load.activeCount;
  const staleCount = new Set(load.items
    .filter(i => staleFlags(tasks.find(t => t.id === i.taskId)).length > 0)
    .map(i => i.taskId)).size;
  return (
    <div className={"sb-cap"+(open?" open":"")}>
      <button className="sb-cap-hd sb-cap-toggle" onClick={onToggle} aria-expanded={open}>
        <span className="sb-av sb-cap-av" aria-hidden="true">{initials(u.name)}</span>
        <div className="sb-cap-id">
          <span className="sb-cap-name" title={u.name}>{u.name}</span>
          {dept && <span className="sb-cap-dept" title={dept}>{dept}</span>}
        </div>
        {status && <span className={"sb-wlbadge tone-"+status.tone}><i className="sb-wl-dot" aria-hidden="true"/>{status.label}</span>}
        <ChevronDownIcon className={"hi sb-cap-chev"+(open?" up":"")} aria-hidden="true"/>
      </button>

      {/* Headline: deadline concentration first; lifecycle count second (clearly
          separated so "5 due · 3 active" never reads as a contradiction). */}
      <div className="sb-cap-headline">
        {!isAvailable(u) ? <span className="sb-cap-hl-muted">Marked unavailable</span>
          : dueThisWeek > 0
          ? <><b>{dueThisWeek} due this week</b>{inProgress > 0 && <span className="sb-cap-hl-muted"> · {inProgress} active now</span>}</>
          : inProgress > 0
          ? <b>{inProgress} active now</b>
          : <span className="sb-cap-hl-muted">Available — nothing scheduled</span>}
      </div>

      <div className="sb-cap-caplabel">Current load</div>
      <div className="sb-capmeter" role="img" aria-label={`Current load: ${status ? status.label : load.band.label}`}>
        {[1,2,3,4].map(n => <i key={n} className={"sb-capseg"+(isAvailable(u) && n <= level ? " on tone-"+tone : "")}/>)}
      </div>

      {staleCount > 0 && (
        <button type="button" className="sb-cap-warn" onClick={()=>{ if(!open) onToggle(); }}>
          <ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true"/>
          <span><b>Needs attention</b> — {staleCount} status{staleCount!==1?"es":""} may be outdated</span>
          <span className="sb-cap-warn-cta">Review</span>
        </button>
      )}

      <div className="sb-cap-detailwrap" aria-hidden={!open}>
        <div className="sb-cap-detail">
          {load.items.length === 0
            ? <div className="sb-cap-empty">No production responsibilities scheduled.
                <span>{isAvailable(u) ? "Available for new work." : "Marked unavailable."}</span></div>
            : LOAD_BUCKETS.map(([key,label]) => {
                const items = load.buckets[key];
                if (!items.length) return null;
                return (
                  <div className="sb-cap-bucket" key={key}>
                    <div className="sb-cap-bucket-h">{label}</div>
                    {items.map((i) => {
                      const flags = staleFlags(tasks.find(t => t.id === i.taskId));
                      return (
                        <div className={"sb-cap-resp"+(flags.length?" stale":"")} key={i.taskId+"-"+i.role}>
                          <span className={"sb-cap-resp-dot tier-"+responsibilityTier(i.weight).toLowerCase()} aria-hidden="true"/>
                          <div className="sb-cap-resp-body">
                            <span className="sb-cap-resp-t" title={i.title}>{i.title}</span>
                            <span className="sb-cap-resp-r">{i.role==="owner"?"Owner":roleLabel(i.role)}
                              {i.weight>=4 && <span className="sb-cap-resp-tier"> · Heavy</span>}
                              <span className="sb-cap-resp-due"> · {respDue(i.date)}</span></span>
                            {flags.length>0 && <span className="sb-cap-resp-stale">{STALE_REASON[flags[0]] || "Status may be outdated"}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
        </div>
      </div>
    </div>
  );
}

function Team({ tasks, users }) {
  const rows = useMemo(() => users
    .map(u => ({ u, load: personLoad(u, tasks) }))
    .sort((a,b) => b.load.activePoints - a.load.activePoints), [users, tasks]);
  // Single-open accordion, tracked by stable user id in the parent (no per-card
  // or shared stale state) — expanding one card can never desync another.
  const [openId, setOpenId] = useState(null);
  return (
    <div className="sb-page">
      <div className="sb-h">Team load</div>
      <div className="sb-sub">See who has work concentrated around upcoming deadlines. Load reflects assigned
        production responsibilities, not task count.{" "}
        <span className="sb-infotip" tabIndex={0} role="note"
          title="Shared QA and posting work isn't assigned to individuals yet.">ⓘ</span></div>
      <div className="sb-caplist">
        {rows.map(({u,load}) => (
          <CapCard key={u.id} u={u} load={load} tasks={tasks}
            open={openId===u.id} onToggle={()=>setOpenId(id => id===u.id ? null : u.id)} />
        ))}
      </div>
    </div>
  );
}

/* ===================================================================
   WINS & METRICS — celebrate progress + give everyone visibility
   =================================================================== */
function WinCard({ n, label, tone }) {
  return (
    <div className="sb-wincard">
      <div className={"n"+(tone?` dot-${tone}`:"")}>{n}</div>
      <div className="lbl">{label}</div>
    </div>
  );
}

/* A number that counts up to its value once on mount — a small, contained bit
   of delight for the dashboard stats. Skips the animation entirely under
   prefers-reduced-motion (shows the final value immediately). */
function AnimatedNumber({ value }) {
  const reduce = typeof window !== "undefined" &&
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [n, setN] = useState(reduce ? value : 0);
  useEffect(() => {
    if (reduce) { setN(value); return; }
    let raf, start; const dur = 520;
    const tick = (ts) => {
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / dur);
      setN(Math.round(value * (1 - Math.pow(1 - p, 3))));   // easeOutCubic
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduce]);
  return <>{n}</>;
}

/* The HOME landing page — a ministry / celebration dashboard, not a task list.
   It answers: what have we accomplished, what's coming up, what should I
   celebrate, what should I be aware of? Operational work lives in My Day. */
function Home({ tasks, tasksLoaded = true, users, me, goTab, isAdmin, onNewForEvent, onViewEvent, openTask, eventSeries }) {
  const pw = personalWins(tasks, me);
  const m = dashboardMetrics(tasks, users);
  const thisM = monthlyWins(tasks, 0);
  const events = upcomingEvents(4, 15, eventSeries);
  const recents = recentWins(tasks, 4);
  const readyToPost = tasks.filter(t=>t.status==="Approved").length;
  const prepCount = events.filter(e=>e.prepNow).length;
  // "Your focus": only what needs the signed-in user, capped so Home stays calm.
  const focus = attentionItems(tasks, me).slice(0, 4);
  // Compact team progress: completed vs everything currently on the board.
  const doneCount = tasks.filter(t=>t.status==="Posted").length;
  const totalCount = tasks.length;
  const donePct = totalCount ? Math.round((doneCount/totalCount)*100) : 0;

  // ---- Desktop dashboard widgets (hidden on mobile; the phone stays focused) ----
  const myActive = tasks.filter(t => t.status!=="Posted" &&
    (t.owner===me.name || (t.support||[]).some(s=>s.name===me.name)));
  const dueSoonN = myActive.filter(t=>{ const d=daysTo(t.postDate); return d!==null && d>=0 && d<=2; }).length;
  const overdueN = myActive.filter(t=>{ const d=daysTo(t.postDate); return d!==null && d<0; }).length;
  const dueTodayN = myActive.filter(t=>daysTo(t.postDate)===0).length;
  const inReviewN = myActive.filter(t=> t.owner===me.name && t.status==="In Review").length;
  const waitingN = myActive.filter(t=> t.owner===me.name &&
    ["In Review","Approved","Ready to Post"].includes(t.status)).length;
  // Each stat carries a supporting sub-metric so the row answers "what next",
  // not just "how many". Tints stay soft; icons give each card its own read.
  const stats = [
    { label:"My tasks",          n:myActive.length, tone:"violet", icon:ClipboardDocumentListIcon,
      sub: dueTodayN>0 ? `${dueTodayN} due today` : "on track", go:()=>goTab("mine") },
    { label:"Due soon",          n:dueSoonN,        tone:"amber",  icon:ClockIcon,
      sub: overdueN>0 ? `${overdueN} overdue` : "next 2 days", go:()=>goTab("myday") },
    { label:"Waiting on others", n:waitingN,        tone:"blue",   icon:UserGroupIcon,
      sub: inReviewN>0 ? `${inReviewN} in review` : "with the crew", go:()=>goTab("mine") },
    { label:"Upcoming events",   n:events.length,   tone:"green",  icon:CalendarDaysIcon,
      sub: prepCount>0 ? `${prepCount} need prep` : "all planned", go:()=>goTab("board") },
  ];
  // My week — my dated responsibilities as an urgency-ordered agenda: Today /
  // Tomorrow / This week / Later reads faster than calendar weekday names.
  const weekBucket = (d) => d===0 ? "Today" : d===1 ? "Tomorrow" : d<=6 ? "This week" : "Later";
  const WEEK_ORDER = ["Today","Tomorrow","This week","Later"];
  const weekGroups = [];
  myActive.filter(t=>t.postDate).map(t=>({t,d:daysTo(t.postDate)}))
    .filter(x=>x.d!==null && x.d>=0 && x.d<=13).sort((a,b)=>a.d-b.d)
    .forEach(x=>{ const label=weekBucket(x.d); let g=weekGroups.find(g=>g.label===label);
      if(!g){ g={label,items:[]}; weekGroups.push(g); } g.items.push(x.t); });
  weekGroups.sort((a,b)=>WEEK_ORDER.indexOf(a.label)-WEEK_ORDER.indexOf(b.label));
  // Recent activity — reuses the admin activity aggregator. Kept short (5) so
  // it never dominates the lower dashboard; the rest lives behind "View all".
  const activityAll = recentActivity(tasks, 30);
  const activity = activityAll.slice(0, 5);
  const agoShort = (ms) => { if(!ms) return ""; const mn=Math.round((Date.now()-ms)/60000);
    if(mn<1) return "now"; if(mn<60) return mn+"m"; const h=Math.round(mn/60);
    if(h<24) return h+"h"; return Math.round(h/24)+"d"; };

  const hi = new Date().getHours();
  const greet = hi<12?"Good morning":hi<17?"Good afternoon":"Good evening";

  // A short, meaningful summary — skip zero-value lines so quiet weeks don't
  // read as "everything is 0". Two lines max: how things are going + what's next.
  const s1 = pw.thisMonth>0
    ? `You've helped complete ${pw.thisMonth} project${pw.thisMonth!==1?"s":""} this month.`
    : thisM.posted>0
    ? `The team has posted ${thisM.posted} piece${thisM.posted!==1?"s":""} of content this month.`
    : "The month is just getting started.";
  const s2 = prepCount>0
    ? `${prepCount} upcoming event${prepCount!==1?"s":""} need${prepCount===1?"s":""} content preparation.`
    : readyToPost>0
    ? `${readyToPost} piece${readyToPost!==1?"s":""} approved and ready to post.`
    : "You're all caught up. Nothing needs prep right now.";

  return (
    <div className="sb-page home">
      <div className="sb-eyebrow">{greet}</div>
      <div className="sb-h">Welcome back, {me.name.split(" ")[0]} <span className="sb-wave" aria-hidden="true">👋</span></div>
      <div className="sb-sub sb-greet">
        <span>{s1}</span>
        <span>{s2}</span>
      </div>

      {/* Below the welcome: a focused stack on mobile, a dashboard grid on
          desktop. `.sb-dash`/`.sb-wd` are display:contents on phones, so the
          mobile layout is byte-for-byte the existing one; on desktop they
          become a grid and the desktop-only widgets (wd-desktop) appear. */}
      <div className="sb-dash">

        {/* Quick stats (desktop dashboard) — glanceable, each with a next-step sub */}
        <section className="sb-wd wd-stats wd-desktop">
          <div className="sb-statgrid">
            {stats.map((s,i) => (
              <button className={"sb-stat2 tone-"+s.tone} key={i} onClick={s.go}>
                <span className="sb-stat2-ic"><s.icon className="hi" aria-hidden="true"/></span>
                <span className="sb-stat2-n"><AnimatedNumber value={s.n}/></span>
                <span className="sb-stat2-l">{s.label}</span>
                <span className="sb-stat2-sub">{s.sub}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Your focus — the primary widget: what needs YOU right now. On desktop
            it's placed top-left by the grid; in the DOM it comes first so MOBILE
            (which follows source order) leads with it, not with "Coming up".
            Three distinct states: loading (skeleton) / has-items / empty —
            the empty state never renders while tasks are still loading. */}
        <section className="sb-wd wd-focus">
          <div className="sb-shead sb-shead-primary">
            <div className="sb-shead-main">
              <h2>Your focus</h2>
              {tasksLoaded && focus.length>0 &&
                <span className="sb-headcount" aria-label={`${focus.length} focus item${focus.length!==1?"s":""}`}>{focus.length}</span>}
            </div>
            <button className="link subtle" onClick={()=>goTab("myday")}>My Day →</button>
          </div>
          {!tasksLoaded
            ? <div className="sb-attnlist sb-focus-loading" aria-busy="true" aria-label="Loading your focus">
                {[0,1,2].map(i => <div className="sb-focus-skel" key={i}><span className="sb-skel"/><span className="sb-skel sm"/></div>)}
              </div>
            : focus.length===0
            ? <div className="sb-empty compact sb-empty-glad"><span className="sb-empty-emoji" aria-hidden="true">🎉</span>
                <b>You're all caught up.</b><span>Nothing needs you right now — enjoy your {hi<12?"morning":hi<17?"afternoon":"evening"}.</span></div>
            : <div className="sb-attnlist">{focus.map(t =>
                <AttentionItem key={t.id} t={t} onClick={()=>openTask ? openTask(t.id) : goTab("myday")} />)}</div>}
        </section>

        {/* Coming up — what's on the ministry horizon */}
        <section className="sb-wd wd-events">
          {events.length>0 && <>
            <div className="sb-shead"><h2>Coming up</h2>
              <button className="link subtle" onClick={()=>goTab("board")}>See all →</button></div>
            <div className="sb-evlist">
              {events.slice(0,3).map((e,i) => {
                const n = occurrenceContentCount(e, tasks);
                const rel = e.daysAway===0 ? "Today" : e.daysAway===1 ? "Tomorrow" : `In ${e.daysAway} days`;
                const act = n===0
                  ? (isAdmin && onNewForEvent && { label:"Create", onClick:()=>onNewForEvent(eventPrefill(e)) })
                  : (onViewEvent && { label:"View", onClick:()=>onViewEvent(e) });
                return (
                <div className="sb-ev" key={e.eventOccurrenceId||i} style={{ "--d": `${i*55}ms` }}>
                  <span className="sb-ev-ic">{e.emoji?<span className="sb-emoji" aria-hidden="true">{e.emoji}</span>:e.kind==="birthday"?<span className="sb-emoji" aria-hidden="true">🎂</span>:<CalendarDaysIcon className="hi" aria-hidden="true"/>}</span>
                  <div className="sb-ev-body">
                    <div className="sb-ev-name">{e.name}</div>
                    <div className="sb-ev-sub"><b>{rel}</b> · {fmtEventDate(e.date)}</div>
                    <div className="sb-ev-foot">
                      <span className={"sb-ev-status"+(n>0?" ok":"")}>{n>0 ? `${n} planned` : "Nothing planned"}</span>
                      {act && <button className="sb-ev-link" onClick={act.onClick}>{act.label} →</button>}
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          </>}
        </section>

        {/* My week (desktop) — a quick timeline of what's ahead */}
        <section className="sb-wd wd-week wd-desktop">
          <div className="sb-shead"><h2>My week</h2></div>
          {weekGroups.length===0
            ? <div className="sb-empty compact">Nothing scheduled in the next 7 days.</div>
            : <div className="sb-week">
                {weekGroups.map((g,gi) => (
                  <div className="sb-week-day" key={gi}>
                    <div className="sb-week-lbl">{g.label}</div>
                    {g.items.map(t => (
                      <button className="sb-week-row" key={t.id} onClick={()=>openTask ? openTask(t.id) : goTab("myday")}>
                        <span className={"sb-week-dot "+statusClass(t.status)} aria-hidden="true"/>
                        <span className="sb-week-body">
                          <span className="sb-week-t">{nextStep(t.status)}</span>
                          <span className="sb-week-sub">{t.title} · {t.type}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>}
        </section>

        {/* Recent activity (desktop) — a quiet, secondary feed: action first,
            then content, then who + when. Short by design. */}
        <section className="sb-wd wd-activity wd-desktop">
          <div className="sb-shead"><h2>Recent activity</h2>
            {isAdmin && activityAll.length>5 && <button className="link subtle" onClick={()=>goTab("admin")}>View all →</button>}</div>
          {activity.length===0
            ? <div className="sb-empty compact">Nothing yet — the team's activity will show up here.</div>
            : <div className="sb-actfeed2">
                {activity.map((a,i) => (
                  <button className="sb-actrow2" key={i} onClick={()=>openTask && openTask(a.taskId)}>
                    <span className="sb-av sb-actrow2-av" aria-hidden="true">{initials(a.who)}
                      <span className={"sb-actrow2-dot type-"+a.type}/></span>
                    <span className="sb-actrow2-body">
                      <span className="sb-actrow2-name">{a.who}</span>
                      <span className="sb-actrow2-act">{a.verb} <span className="ct">{a.title}</span></span>
                      <span className="sb-actrow2-meta">{agoShort(a.at)} ago</span>
                    </span>
                  </button>
                ))}
              </div>}
        </section>

        {/* Team progress — completion at a glance + the pipeline that needs moving */}
        <section className="sb-wd wd-team">
          <div className="sb-shead"><h2>Team progress</h2></div>
          <div className="sb-progress">
            <div className="row">
              <b>{doneCount} of {totalCount} completed</b>
              <span className="pct"><AnimatedNumber value={donePct}/>%</span>
            </div>
            <div className="bar" role="progressbar" aria-valuenow={donePct} aria-valuemin={0} aria-valuemax={100}
              aria-label="Team content completion"><span className="fill" style={{width:`${donePct}%`}}/></div>
            {/* Supporting stats, not KPI boxes — a calm pipeline list… */}
            <div className="sb-statlist">
              <button className="sb-statrow" onClick={()=>goTab("board")}>
                <span className="v">{m.awaiting}</span><span className="k">Awaiting review</span></button>
              <button className="sb-statrow" onClick={()=>goTab("board")}>
                <span className="v">{readyToPost}</span><span className="k">Ready to post</span></button>
              <button className={"sb-statrow"+(m.overdue>0?" warn":"")} onClick={()=>goTab("myday")}>
                <span className="v">{m.overdue}</span><span className="k">Overdue</span></button>
            </div>
            {/* …then the wins as a right-aligned stat list under a divider. */}
            <div className="sb-statlist sb-statlist-wins">
              <div className="sb-winrow"><span className="e" aria-hidden="true">🏆</span>
                <span className="k">Posted this month</span><span className="v"><AnimatedNumber value={thisM.posted}/></span></div>
              <div className="sb-winrow"><span className="e" aria-hidden="true">🙌</span>
                <span className="k">Completed by you</span><span className="v"><AnimatedNumber value={pw.completed}/></span></div>
              <div className="sb-winrow"><span className="e" aria-hidden="true">✨</span>
                <span className="k">Contributions</span><span className="v"><AnimatedNumber value={pw.contributions}/></span></div>
            </div>
            <button className="sb-proglink" onClick={()=>goTab("board")}>View workflow →</button>
          </div>
        </section>

        {/* Recent wins (mobile keeps this; desktop shows Recent activity instead) */}
        <section className="sb-wd wd-recent wd-mobile">
          <div className="sb-shead"><h2>Recent wins</h2></div>
          {recents.length===0
            ? <div className="sb-empty">Nothing posted yet. Your first win is coming!</div>
            : <div className="sb-recent">{recents.map((r)=>(
                <div className="sb-recent-row" key={r.id}>
                  <span className="sb-recent-ic" aria-hidden="true"><CheckCircleIcon className="hi"/></span>
                  <span className="sb-recent-txt">
                    <span className="sb-recent-title">{r.title}</span>
                    <span className="sb-recent-action">{r.action}</span>
                  </span>
                </div>
              ))}</div>}
        </section>

      </div>
    </div>
  );
}

/* ===================================================================
   ADMIN
   =================================================================== */
/* A 3-dot "more actions" menu. Stops click propagation so using it never
   triggers the card's own open-on-click. Closes on outside click or Escape. */
function KebabMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="sb-kebab" ref={ref} onClick={(e)=>e.stopPropagation()}>
      <button className="sb-kebab-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded={open}
        onClick={()=>setOpen(o=>!o)}><EllipsisHorizontalIcon className="hi" aria-hidden="true"/></button>
      {open && (
        <div className="sb-kebab-menu" role="menu">
          {items.map((it, i) => (
            <button key={i} role="menuitem" className={"sb-kebab-item"+(it.danger?" danger":"")}
              onClick={()=>{ setOpen(false); it.onClick(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* Branded confirmation dialog — the app-wide replacement for window.confirm for
   both destructive actions and unsaved-changes prompts. Never colour alone:
   each tone pairs an icon with its treatment.
   - tone: "danger" (permanent deletion) | "warning" (unsaved / reversible-ish)
     | "neutral". `danger` bool kept for back-compat (true → danger tone).
   - consequences: optional string[] rendered as an explained list.
   - onConfirm may be async: while it runs, buttons disable, the confirm button
     shows a loading label, duplicate clicks are blocked, the dialog stays open,
     and a thrown error is surfaced inline (the caller's data is never lost).
   Focus starts on the SAFE (cancel) action, so Enter can't trigger deletion
   unless the user deliberately tabs to the destructive button. */
function ConfirmDialog({ title, body, consequences, confirmLabel = "Delete", cancelLabel = "Cancel",
                         tone, icon, danger = true, busyLabel, onConfirm, onClose }) {
  const t = tone || (danger ? "danger" : "neutral");
  const ic = icon || (t === "danger" ? "danger" : t === "warning" ? "warning" : "neutral");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);       // initial focus = safe action
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
  const confirm = async () => {
    if (busy) return;                                          // block duplicate submits
    try { setErr(null); setBusy(true); await onConfirm(); onClose(); }
    catch (e) { setBusy(false); setErr(e?.message || "Something went wrong. Please try again."); }
  };
  const Icon = ic === "danger" ? ExclamationTriangleIcon : ic === "warning" ? ExclamationTriangleIcon : InformationCircleIcon;
  const confirmClass = t === "danger" ? "sb-btn danger" : t === "warning" ? "sb-btn gold" : "sb-btn";
  return (
    <Portal>
    <div className="sb-scrim" onClick={() => !busy && onClose()}>
      <div className="sb-confirm" onClick={e=>e.stopPropagation()} role="alertdialog"
        aria-modal="true" aria-labelledby="sb-confirm-t" aria-describedby={body?"sb-confirm-b":undefined}>
        <div className={"sb-confirm-hd tone-"+t}>
          <span className="sb-confirm-ic" aria-hidden="true"><Icon className="hi" /></span>
          <b id="sb-confirm-t" className="sb-serif">{title}</b>
        </div>
        {body && <p id="sb-confirm-b">{body}</p>}
        {consequences && consequences.length>0 &&
          <ul className="sb-confirm-list">{consequences.map((c,i)=><li key={i}>{c}</li>)}</ul>}
        {err && <div className="sb-lerr" role="alert" style={{marginTop:12,marginBottom:0}}>{err}</div>}
        <div className="sb-btnrow" style={{marginTop:16}}>
          <button ref={cancelRef} className="sb-btn ghost" onClick={onClose} disabled={busy}>{cancelLabel}</button>
          <button className={confirmClass} onClick={confirm} disabled={busy} aria-busy={busy}>
            {busy ? (busyLabel || "Working…") : confirmLabel}</button>
        </div>
      </div>
    </div>
    </Portal>
  );
}

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

function Admin({ users, tasks, teamUsers, issues, eventSeries, secReq, onEditUser, onEditTask, onDeleteUser, onRemoveUser, onDeleteTask, onArchiveTask, onDuplicateTask, onOpenTask, onAutoAll, onAutoOne, onImport, onResolveIssue, onAssignSuggested, onNewForEvent }) {
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

      {sec==="people" && <AdminPeople users={users} tasks={tasks}
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
                <PendingRow key={u.id} u={u} tasks={tasks} onReview={()=>onEditUser(u)} onReject={onDeleteUser} onAssignSuggested={onAssignSuggested} />
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
function PendingRow({ u, tasks, onReview, onReject, onAssignSuggested }) {
  const [confirmReject, setConfirmReject] = useState(false);
  return (
    <div className="sb-prow">
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
function AdminPeople({ users, tasks, onEditUser, onDeleteUser, onRemoveUser, onAssignSuggested }) {
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
            <PendingRow key={u.id} u={u} tasks={tasks}
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
  const [target, setTarget] = useState(others[0]?.name || "");
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
                  {others.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
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

/* ===================================================================
   TASK CARD
   =================================================================== */
/* Admin quick-actions menu shown on task cards + the detail sheet. Stops click
   propagation so opening it never also opens the card. */
function TaskAdminMenu({ t, admin, className }) {
  const [confirmDel, setConfirmDel] = useState(false);
  return (
    <span className={className} onClick={e=>e.stopPropagation()}>
      <KebabMenu items={[
        { label:"Edit content", onClick:()=>admin.onEdit(t) },
        { label:"Duplicate", onClick:()=>admin.onDuplicate(t) },
        ...(t.status!=="Posted" ? [{ label:"Mark as posted", onClick:()=>admin.onArchive(t) }] : []),
        { label:"Delete content", danger:true, onClick:()=>setConfirmDel(true) },
      ]} />
      {confirmDel && <ConfirmDialog
        title={`Delete “${t.title}”?`}
        body="This permanently removes the content — its links, reminders and history. This can't be undone."
        confirmLabel="Delete content" cancelLabel="Cancel"
        onConfirm={async ()=>{ await admin.onDelete(t); }} onClose={()=>setConfirmDel(false)} />}
    </span>
  );
}
function TaskCard({ t, me, onClick }) {
  const d = daysTo(t.postDate);
  // Once a task is Posted the work is done, so we drop the due/overdue chip
  // entirely (showing "overdue" on finished content is just noise).
  const isPosted = t.status==="Posted";
  const dueCls = d===null?"due-ok":d<0?"due-over":d<=2?"due-soon":"due-ok";
  const dueTxt = d===null?"No date":d<0?`${Math.abs(d)}d overdue`:d===0?"Due today":d===1?"Due tomorrow":`Due ${fmt(t.postDate)}`;
  // De-duplicate owner + crew so the same person shows one avatar.
  const people = [{name:t.owner,owner:true}, ...(t.support||[]).map(s=>({name:s.name}))];
  const seen = new Set(); const uniquePeople = people.filter(p=>!seen.has(p.name)&&seen.add(p.name));
  // Only surface ownership when it helps you act: if you're supporting (not the
  // lead), name the lead. "Who owns it" otherwise lives in the detail screen.
  const supporting = me && t.owner!==me.name && (t.support||[]).some(s=>s.name===me.name);
  // Mobile-first card: title · status · due · next · avatars.
  const admin = useContext(TaskAdminContext);   // admin quick-actions on the card
  return (
    <div className="sb-task sb-task-act" role="button" tabIndex={0} onClick={onClick}
      onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); onClick(); } }}>
      <div className="row1">
        <span className="title">{t.title}</span>
        <span className="sb-rowtags">
          {t.priority==="High" && <span className={"sb-pri "+priorityClass(t.priority)}>▲</span>}
          <span className={"sb-chip "+typeClass(t.type)}>{t.type}</span>
          {admin && <TaskAdminMenu t={t} admin={admin} className="sb-cardkebab" />}
        </span>
      </div>

      {/* Status is dominant; due date pops; "Next" + blocker are supporting text. */}
      <div className="sb-cardstatus">
        <span className={"sb-status "+statusClass(t.status)}><span className="pip"/>{t.status}</span>
        {!isPosted && <span className={"sb-due "+dueCls}>🕒 {dueTxt}</span>}
      </div>
      {/* Fixed order: blocking issue → up next → supporting/owner → avatars. */}
      {t.blockedOn && <div className="sb-next blocked"><span className="sb-next-lbl">Blocked</span>Waiting on {t.blockedOn}</div>}
      {!isPosted && <div className="sb-next"><span className="sb-next-lbl">Next</span>{nextStep(t.status)}</div>}
      {supporting && <div className="sb-support">Supporting {t.owner.split(" ")[0]}</div>}

      <div className="sb-ppl">
        {uniquePeople.slice(0,5).map((p,i)=>(
          <span key={i} className={"sb-av"+(p.owner?" owner":"")}
            style={me&&p.name===me.name?{outline:"2px solid var(--violet)"}:{}}>{initials(p.name)}</span>
        ))}
        {(t.comments?.length>0) && <span style={{fontSize:11,color:"var(--muted)",marginLeft:"auto"}}>{Ic.chat} {t.comments.length}</span>}
      </div>
    </div>
  );
}

/* ===================================================================
   TASK DETAIL
   =================================================================== */
/* Reusable URL field used everywhere a link is expected (content links,
   reference, deliverables, drive links, post link, future URL fields). Actions
   live INSIDE the input on the right — Open (↗) then Copy (📋), shown only when
   there's a valid URL. Owns its own validation UI (inline error + subtle
   "valid link" hint) and copy feedback; the parent just reads `value`/`onChange`
   and optionally persists on `onBlur`. Exposes disabled + loading states. */
function UrlInput({ value, onChange, onBlur, placeholder = "https://…", disabled = false, loading = false, id, ariaLabel }) {
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedT = useRef(null);
  useEffect(() => () => clearTimeout(copiedT.current), []);
  const v = (value || "").trim();
  const valid = isValidUrl(v);
  const showError = touched && !!v && !valid;
  const hasText = !!v;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(v);
      setCopied(true);
      clearTimeout(copiedT.current);
      copiedT.current = setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable — no-op */ }
  };
  return (
    <div className="sb-urlfield">
      <div className={"sb-urlwrap"+(hasText?" has-actions":"")}>
        <input id={id} type="url" inputMode="url" autoComplete="off" spellCheck={false}
          className="sb-urlctrl" value={value || ""} disabled={disabled}
          aria-label={ariaLabel} aria-invalid={showError || undefined} placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
          onBlur={() => { setTouched(true); onBlur && onBlur(); }} />
        {hasText && (
          <div className="sb-urlactions">
            {loading
              ? <span className="sb-banner-spin" aria-hidden="true" />
              : <>
                  {valid && <a className="sb-urlbtn" href={v} target="_blank" rel="noreferrer noopener"
                    title="Open link" aria-label="Open link"><ArrowTopRightOnSquareIcon className="hi hi-sm" aria-hidden="true" /></a>}
                  <button type="button" className={"sb-urlbtn"+(copied?" copied":"")} onClick={copy}
                    disabled={!valid} title={copied ? "Copied" : "Copy link"} aria-label="Copy link">
                    {copied ? <CheckIcon className="hi hi-sm" aria-hidden="true" /> : <ClipboardIcon className="hi hi-sm" aria-hidden="true" />}</button>
                </>}
          </div>
        )}
      </div>
      {showError
        ? <div className="sb-fielderr" role="alert">Please enter a valid URL.</div>
        : copied
        ? <div className="sb-urlhint copied" role="status">✓ Link copied</div>
        : valid
        ? <div className="sb-urlhint ok">✓ Valid link</div>
        : null}
    </div>
  );
}
function TaskDetail({ task, me, isAdmin, isQA, onClose, onStatus, onAction, onApprove, onLinks, onRequestChanges, onBlocked, onComment, onReact, onEdit, onDuplicate, onArchive, onDelete, onSaved }) {
  const [confirmDel, setConfirmDel] = useState(false);   // admin delete confirmation
  const [draft, setDraft] = useState("");
  // Local drafts; persisted on blur. Component is keyed by task id, so these
  // reset when a new task opens.
  const [blocked, setBlocked] = useState(task.blockedOn || "");
  const [links, setLinksDraft] = useState(task.links || {});
  const [postLink, setPostLink] = useState(task.postLink || "");
  const [changeNote, setChangeNote] = useState("");
  const [showOverride, setShowOverride] = useState(false);
  const [askChanges, setAskChanges] = useState(false);
  const [warn, setWarn] = useState("");
  const [copiedKey, setCopiedKey] = useState(""); // #7 — copy feedback for the read-only reference link
  // #12 — auto-saves surface a global "✓ Saved just now" banner (always visible,
  // whichever field was edited), via the parent.
  const flashSaved = () => onSaved && onSaved();
  // Persist a text field on blur, but ONLY when the trimmed value actually
  // changed — whitespace-only edits don't count and don't flash "saved".
  const commit = (orig, next, saveFn) => {
    const a = (orig || "").trim(), b = (next || "").trim();
    if (a === b) return;
    saveFn(b); flashSaved();
  };
  const copyUrl = async (key, url) => {
    try { await navigator.clipboard.writeText(url); setCopiedKey(key); setTimeout(()=>setCopiedKey(""), 1600); } catch {}
  };
  const EMOJIS = ["👍","🔥","🙏","👀"];
  const isLink = task.link && task.link.startsWith("http");
  const phase = statusPhase(task.status);
  const action = workflowAction(task, me);                 // the single guided step for this user
  const required = requiredLinkKeys(task.type);
  // Only the type's required links (plus any already filled) — keeps it focused.
  const linkKeys = Object.keys(LINK_FIELDS).filter(k => required.includes(k) || (links[k]||"").trim());
  const postStage = ["Ready to Post","Posted"].includes(task.status);
  const lastFeedback = [...(task.activity||[])].reverse().find(e => e.type==="changes_requested")?.note;
  // Persist a content-link edit, but only if it's a valid URL (or cleared) AND
  // actually changed (trailing/whitespace-only edits don't count). The UrlInput
  // shows the inline "not a valid URL" error itself. #6/#12
  const saveLinks = (next, key) => {
    setLinksDraft(next);
    const v = key ? (next[key] || "").trim() : "";
    if (key && v && !isValidUrl(v)) return;          // invalid — don't persist junk
    const prev = key ? (task.links?.[key] || "").trim() : "";
    if (key && v === prev) return;                    // nothing actually changed
    onLinks(next); flashSaved();
  };
  const tm = (t) => typeof t === "number" ? new Date(t).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) : t;

  // Run the guided action, enforcing its preconditions (same gates as the rules).
  const doAction = () => {
    if (!action) return;
    if (action.requiresLinks) {
      const miss = missingLinks({ ...task, links });
      if (miss.length) { setWarn(`Add the required content link${miss.length>1?"s":""} first: ${miss.map(k=>LINK_FIELDS[k]).join(", ")}.`); return; }
    }
    if (action.needsPostLink && !postLink.trim()) { setWarn("Add the final post link first."); return; }
    if (action.needsPostLink && !isValidUrl(postLink.trim())) { setWarn("Please enter a valid URL for the post link."); return; }
    setWarn("");
    const extra = {};
    if (action.needsPostLink) extra.postLink = postLink.trim();
    onAction(action, extra);
  };

  return (
    <Portal>
    <div className="sb-scrim" onClick={onClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()}>
        <div className="hd">
          <span className={"sb-chip "+typeClass(task.type)}>{task.type}</span>
          <button className="sb-x" onClick={onClose}><XMarkIcon className="hi" aria-hidden="true" /></button>
        </div>
        <div className="bd">
          <h2 style={{fontSize:22,fontWeight:600,lineHeight:1.15,marginBottom:8}}>{task.title}</h2>

          {/* Status is the dominant signal; "Next" is small supporting text. */}
          <div className="sb-statusline">
            <span className={"sb-status big "+statusClass(task.status)}><span className="pip"/>{task.status}</span>
            {task.priority==="High" && <span className={"sb-pri "+priorityClass(task.priority)}>▲ High</span>}
            <span className="sb-tag">{task.location==="Both"?"479 + 828":task.location}</span>
            {task.relatedEvent && <span className="sb-tag">{task.relatedEvent}</span>}
          </div>
          <div className="sb-nextline">Next: {nextStep(task.status)}</div>

          {/* Workflow stepper: the six forward steps; "Changes Requested" is a
              returned branch on the review step, called out in text below. */}
          {(() => {
            const FLOW = ["Planned","In Progress","In Review","Approved","Ready to Post","Posted"];
            const returned = task.status==="Changes Requested";
            const flowIdx = returned ? 2 : FLOW.indexOf(task.status);
            return (<>
              <div className="sb-stepper" aria-label="Workflow progress">
                {FLOW.map((st,i)=>(
                  <div key={st} className={"sb-step"+(i<flowIdx?" done":i===flowIdx?" now":"")+(returned&&i===2?" branch":"")}>
                    <span className="dot" aria-hidden="true">{i<flowIdx && <CheckCircleIcon className="hi hi-sm"/>}</span>
                    <span className="stlbl">{st}</span>
                  </div>
                ))}
              </div>
              {returned && <div className="sb-step-note" role="status">
                <ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true"/> Returned — changes requested. Resubmit for review when ready.</div>}
            </>);
          })()}

          {task.brief && (
            <div className="sb-brief">
              <div className="sb-brief-h">Brief &amp; Notes</div>
              <div className="sb-brief-b">{task.brief}</div>
            </div>
          )}

          {/* QA sent it back — show the feedback to the owner. */}
          {task.status==="Changes Requested" && lastFeedback && (
            <div className="sb-lerr" style={{marginBottom:12}}><b>Changes requested:</b> {lastFeedback}</div>
          )}

          {/* The guided primary action for this user (Start work / Submit for QA /
              Mark ready to post / Mark as posted). */}
          {action && (
            <div style={{marginBottom:14}}>
              <button className="sb-btn" onClick={doAction}>{action.label}</button>
              {warn && <div className="sb-lerr" style={{marginTop:8}}>{warn}</div>}
            </div>
          )}
          {!action && task.status==="In Review" && !isQA && (
            <div className="sb-banner" style={{marginBottom:14}}>⏳ Submitted. Awaiting QA review.</div>
          )}

          {/* QA panel — Approve / Request changes, only for QA while In Review. */}
          {isQA && task.status==="In Review" && (
            <div className="sb-qa">
              <b>QA review</b>
              <div className="sb-btnrow">
                <button className="sb-btn green compact" onClick={onApprove}>Approve</button>
                <button className="sb-btn ghost subtle-danger compact" onClick={()=>setAskChanges(v=>!v)}>Request changes</button>
              </div>
              {askChanges && <>
                <textarea rows={2} value={changeNote} placeholder="What needs to change?"
                  onChange={e=>setChangeNote(e.target.value)} />
                <button className="sb-btn compact" disabled={!changeNote.trim()}
                  onClick={()=>{ onRequestChanges(changeNote.trim()); setChangeNote(""); setAskChanges(false); }}>
                  Send back for revisions</button>
              </>}
            </div>
          )}

          {/* Content links — appear once production has started (not at Planned).
              Required ones (by type) gate the Submit-for-QA step. */}
          {phase>=1 && <>
            <div className="sb-shead" style={{marginTop:6}}><h2>Content links</h2>
              {required.length>0 && <span className="sb-sub" style={{margin:0}}>* required for QA</span>}</div>
            {linkKeys.map(k => {
              const val = links[k] || "";
              return (
                <div className="sb-field" key={k}>
                  <label>{LINK_FIELDS[k]}{required.includes(k) && <span style={{color:"var(--red)"}}> *</span>}</label>
                  <UrlInput value={val} ariaLabel={LINK_FIELDS[k]} placeholder="https://drive.google.com/…"
                    onChange={nv=>setLinksDraft({...links, [k]: nv})}
                    onBlur={()=>saveLinks({ ...links, [k]: (links[k]||"").trim() }, k)} />
                </div>
              );
            })}
          </>}

          {/* Final post link — captured when marking as posted. */}
          {postStage && (
            <div className="sb-field"><label>Final post link</label>
              <UrlInput value={postLink} ariaLabel="Final post link" placeholder="https://instagram.com/…"
                disabled={task.status==="Posted"} onChange={setPostLink} />
            </div>
          )}

          {/* Waiting on (blocker) — editable while the task is live. */}
          {task.status!=="Posted" && (
            <div className="sb-field"><label>Waiting on (leave blank if not blocked)</label>
              <input value={blocked} onChange={e=>setBlocked(e.target.value)}
                onBlur={()=>commit(task.blockedOn, blocked, v=>onBlocked(v))}
                placeholder="e.g. Pastor's approval, David's graphics" />
            </div>
          )}

          <div className="sb-cap" style={{marginTop:6}}>
            <Detail k="Owner (lead)" v={task.owner==="Pending" ? (task.ownerSuggested ? `Pending: ${task.ownerSuggested} (from import)` : "Pending") : task.owner} />
            <Detail k="Priority" v={task.priority || "Medium"} />
            <Detail k="Shoot date" v={fmt(task.shootDate)} />
            <Detail k="Post date" v={fmt(task.postDate)} />
            {task.notes && <Detail k="Notes" v={task.notes} />}
            {task.link && (isLink
              ? <div className="sb-refrow">
                  <span className="sb-refrow-k">Reference</span>
                  <div className="sb-refrow-main">
                    <a className="sb-refrow-url" href={task.link} target="_blank" rel="noreferrer noopener" title={task.link}>{task.link}</a>
                    <div className="sb-refrow-actions">
                      <a className="sb-urlbtn" href={task.link} target="_blank" rel="noreferrer noopener"
                        title="Open link" aria-label="Open link"><ArrowTopRightOnSquareIcon className="hi hi-sm" aria-hidden="true"/></a>
                      <button type="button" className={"sb-urlbtn sb-refcopy"+(copiedKey==="ref"?" copied":"")}
                        title={copiedKey==="ref"?"Copied":"Copy link"} aria-label="Copy link" onClick={()=>copyUrl("ref",task.link)}>
                        {copiedKey==="ref"
                          ? <><CheckIcon className="hi hi-sm" aria-hidden="true"/><span className="sb-refcopy-txt">Copied</span></>
                          : <ClipboardDocumentIcon className="hi hi-sm" aria-hidden="true"/>}</button>
                    </div>
                  </div>
                </div>
              : <Detail k="Reference" v={task.link} />)}
          </div>

          <div className="sb-shead" style={{marginTop:18}}><h2>Production team</h2></div>
          {(task.support||[]).length===0
            ? <div className="sb-empty" style={{padding:16}}>No production team assigned yet.</div>
            : <div className="sb-crewlist">
                {orderedCrew(task.support).map(({s,i})=>{
                  const pending = s.name==="Pending";
                  return (
                    <div className="sb-crewrow" key={(s.name||"pending")+"-"+i}>
                      <span className="sb-av sb-crew-av" aria-hidden="true">{pending ? "?" : initials(s.name)}</span>
                      <div className="sb-crew-main">
                        <span className="sb-crew-name">{pending ? pendingCrewLabel(s) : s.name}</span>
                        <div className="sb-crew-meta">
                          <span className="sb-crew-rolestatic">{crewRoleLabel(s)}</span>
                          {s.loc && <span className="sb-crew-loc">{s.loc}</span>}
                          {pending && s.suggested && <span className="sb-crew-loc">suggested: {s.suggested}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>}

          {/* Activity timeline — created / status changes / QA / approvals,
              merged with comments, newest first. Approval events are tinted. */}
          <div className="sb-shead" style={{marginTop:18}}><h2>Activity</h2></div>
          {(() => {
            const events = [
              ...(task.activity||[]),
              ...(task.comments||[]).map(c=>({ type:"comment", by:c.who, at:c.tm, note:c.txt })),
            ].sort((a,b)=>(b.at||0)-(a.at||0));
            return events.length===0
              ? <div className="sb-empty" style={{padding:16}}>No activity yet.</div>
              : <div className="sb-timeline">
                  {events.map((e,i)=>(
                    <div className={"sb-tl"+(isApprovalEvent(e)?" qa":"")} key={i}>
                      <span className="sb-tl-dot"/>
                      <div style={{flex:1,minWidth:0}}>
                        <div className="sb-tl-top"><b>{activityLabel(e)}</b><span className="sb-tl-tm">{tm(e.at)}</span></div>
                        <div className="sb-tl-sub">{e.by}{["comment","changes_requested","assigned"].includes(e.type) && e.note ? ` · ${e.note}` : ""}</div>
                      </div>
                    </div>
                  ))}
                </div>;
          })()}

          <div className="sb-react">
            {EMOJIS.map(e=>{
              const arr = task.reactions?.[e]||[];
              return <button key={e} className={"sb-reactbtn"+(arr.includes(me.name)?" on":"")}
                onClick={()=>onReact(e)}>{e} {arr.length>0 && arr.length}</button>;
            })}
          </div>

          <div className="sb-shead" style={{marginTop:18}}><h2>Discussion</h2></div>
          <div className="sb-sub" style={{marginTop:-6}}>Keep it here, not in WhatsApp.</div>
          {(task.comments||[]).map((c,i)=>(
            <div className="sb-cmt" key={i}>
              <div className="who">{c.who}</div><div className="txt">{c.txt}</div><div className="tm">{tm(c.tm)}</div>
            </div>
          ))}
          <div className="sb-field" style={{marginTop:10}}>
            <textarea rows={2} placeholder="Add a note for the crew…" value={draft} onChange={e=>setDraft(e.target.value)} />
          </div>
          <button className="sb-btn compact" disabled={!draft.trim()} onClick={()=>{ onComment(draft.trim()); setDraft(""); }}>Post note</button>

          {/* Workflow moves through the explicit action above; admins keep a
              tucked-away manual override for corrections (not a duplicate field). */}
          {isAdmin && <>
            <div className="sb-shead" style={{marginTop:20}}><h2>Admin controls</h2></div>
            <div className="sb-btnrow">
              <button className="sb-btn ghost" onClick={onEdit}>Edit details</button>
              {onDuplicate && <button className="sb-btn ghost" onClick={onDuplicate}>Duplicate</button>}
              {onArchive && task.status!=="Posted" && <button className="sb-btn ghost" onClick={onArchive}>Mark posted</button>}
            </div>
            {onDelete && <button className="sb-btn danger" style={{marginTop:9}} onClick={()=>setConfirmDel(true)}>Delete content</button>}
            <button className="sb-quietlink" style={{marginTop:10}} onClick={()=>setShowOverride(o=>!o)} aria-expanded={showOverride}>
              {showOverride ? "Hide manual status override" : "Change status manually"}</button>
            {showOverride && <div className="sb-field" style={{marginTop:8}}>
              <div className="sb-seg" style={{flexWrap:"wrap"}}>
                {STAGES.map(s=>(
                  <button key={s} className={"sb-segbtn"+(task.status===s?" on":"")} onClick={()=>onStatus(s)}>{s}</button>))}
              </div>
            </div>}
          </>}
        </div>
      </div>
    </div>
    {confirmDel && onDelete && <ConfirmDialog
      title={`Delete “${task.title}”?`}
      body="This permanently removes the content — its links, reminders and history. This can't be undone."
      confirmLabel="Delete content" cancelLabel="Cancel"
      onConfirm={async ()=>{ await onDelete(); }} onClose={()=>setConfirmDel(false)} />}
    </Portal>
  );
}
function Detail({ k, v }) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",gap:14,padding:"7px 0",borderBottom:"1px solid var(--line)"}}>
      <span style={{fontSize:12.5,color:"var(--muted)",fontWeight:600,flex:"none"}}>{k}</span>
      <span style={{fontSize:13.5,textAlign:"right",minWidth:0,overflow:"hidden"}}>{v}</span>
    </div>
  );
}

/* ===================================================================
   TASK EDITOR
   =================================================================== */
/* Editor for a task's reminder schedule (also reused for the admin default
   schedule). Each row: days offset · before/after due · channels · recipients ·
   on/off. Capped at MAX_REMINDERS. */
function ReminderEditor({ reminders, onChange }) {
  const rem = reminders || [];
  const upd = (i, patch) => onChange(rem.map((r, j) => j === i ? { ...r, ...patch } : r));
  const toggleArr = (i, key, val) => {
    const s = new Set(rem[i][key] || []); s.has(val) ? s.delete(val) : s.add(val); upd(i, { [key]: [...s] });
  };
  const add = () => { if (rem.length >= MAX_REMINDERS) return; onChange([...rem,
    { id: `r${Date.now()}`, offset: 1, when: "before", channels: [...REMINDER_CHANNELS], recipients: ["owner"], enabled: true }]); };
  return (
    <div className="sb-remlist">
      {rem.map((r, i) => (
        <div className={"sb-rem" + (r.enabled === false ? " off" : "")} key={r.id || i}>
          <div className="hd">
            <input type="number" min="0" max="60" value={r.offset}
              onChange={e => upd(i, { offset: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })} />
            <span>day{r.offset === 1 ? "" : "s"}</span>
            <select value={r.when} onChange={e => upd(i, { when: e.target.value })}>
              <option value="before">before due</option><option value="after">after due</option>
            </select>
            <button type="button" className={"sb-sw"+(r.enabled!==false?" on":"")} role="switch"
              aria-checked={r.enabled!==false} aria-label="Reminder enabled"
              onClick={() => upd(i, { enabled: r.enabled === false })}><span/></button>
            <button type="button" className="sb-rem-x" onClick={() => onChange(rem.filter((_, j) => j !== i))} aria-label="Remove reminder"><XMarkIcon className="hi" aria-hidden="true" /></button>
          </div>
          <div className="chips">
            {REMINDER_CHANNELS.map(c => <button type="button" key={c}
              className={"sb-rchip" + ((r.channels || []).includes(c) ? " on" : "")} onClick={() => toggleArr(i, "channels", c)}>{c}</button>)}
          </div>
          <div className="chips">
            {REMINDER_RECIPIENTS.map(c => <button type="button" key={c}
              className={"sb-rchip" + ((r.recipients || []).includes(c) ? " on" : "")} onClick={() => toggleArr(i, "recipients", c)}>{c}</button>)}
          </div>
        </div>
      ))}
      {rem.length < MAX_REMINDERS
        ? <button type="button" className="sb-btn ghost compact" onClick={add}>+ Add reminder</button>
        : <div className="sb-sub" style={{margin:0}}>Maximum {MAX_REMINDERS} reminders.</div>}
    </div>
  );
}

/* ---- Reminder redesign (v1.1.2) ------------------------------------
   The task form shows only a concise SUMMARY; the full schedule opens in
   a bottom sheet rendered as an ordered timeline in Winnipeg time. */
const remPhrase = (r) => r.offset===0 ? "On the due date"
  : `${r.offset} day${r.offset!==1?"s":""} ${r.when==="after"?"overdue":"before"}`;
const remDate = (postDate, r) => {
  if (!postDate) return null;
  const [y,m,d] = postDate.split("-").map(Number);
  const dt = new Date(y, m-1, d);
  dt.setDate(dt.getDate() + (r.when==="after" ? r.offset : -r.offset));
  return dt.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}) + " at 9:00 AM";
};
const remChrono = (r) => (r.when==="after" ? 1 : -1) * (Number(r.offset)||0);
const sameSchedule = (a, b) => JSON.stringify(a||[]) === JSON.stringify(b||[]);
const CH_LABEL = { "in-app":"In-app", push:"Push", email:"Email" };
const RCP_LABEL = { owner:"Owner", crew:"Crew", lead:"Lead", admins:"Admins" };

function ReminderSummary({ reminders, defaults, postDate, onCustomize }) {
  const rem = reminders || [];
  const enabled = rem.filter(r => r.enabled !== false);
  const isDefault = sameSchedule(rem, defaults);
  const phrases = [...enabled].sort((a,b)=>remChrono(a)-remChrono(b)).map(remPhrase);
  return (
    <div className="sb-remsum">
      <div className="bd">
        <b>{isDefault ? "Using team default" : "Custom schedule"} · {enabled.length} reminder{enabled.length!==1?"s":""}</b>
        <span>{enabled.length ? phrases.join(", ") : "Reminders are off for this content item."}</span>
      </div>
      <button type="button" className="sb-secaction" onClick={onCustomize}>
        <Cog6ToothIcon className="hi hi-sm" aria-hidden="true"/>
        {enabled.length ? "Customize reminders" : "Enable reminders"}</button>
    </div>
  );
}

function ReminderSheet({ reminders, defaults, postDate, onChange, onClose }) {
  const rem = reminders || [];
  const [openId, setOpenId] = useState(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const upd = (id, patch) => onChange(rem.map(r => r.id===id ? { ...r, ...patch } : r));
  const toggleArr = (id, key, val) => {
    const r = rem.find(x=>x.id===id); const s = new Set(r[key]||[]);
    s.has(val) ? s.delete(val) : s.add(val); upd(id, { [key]: [...s] });
  };
  const add = () => { if (rem.length >= MAX_REMINDERS) return;
    const nr = { id:`r${Date.now()}`, offset:1, when:"before", channels:[...REMINDER_CHANNELS], recipients:["owner"], enabled:true };
    onChange([...rem, nr]); setOpenId(nr.id); };
  const sorted = [...rem].sort((a,b)=>remChrono(a)-remChrono(b));
  const isDefault = sameSchedule(rem, defaults);
  return (
    <Portal>
    <div className="sb-scrim" onClick={onClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()} role="dialog" aria-label="Reminder schedule">
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>Reminders</b>
          <button className="sb-x" onClick={onClose} aria-label="Close reminders"><XMarkIcon className="hi" aria-hidden="true"/></button></div>
        <div className="bd">
          <div className="sb-sub" style={{marginTop:0}}>All reminder times are shown in Winnipeg time.</div>
          {rem.length===0 && <div className="sb-empty compact">
            Reminders are off for this content item. Turn reminders on to notify the assigned team before the due date.</div>}
          <div className="sb-remtl">
            {sorted.map(r => {
              const off = r.enabled===false;
              const invalid = !off && (!(r.channels||[]).length || !(r.recipients||[]).length);
              const expanded = openId===r.id;
              const when = remDate(postDate, r);
              return (
                <div key={r.id} className={"sb-tlrow"+(off?" off":"")}>
                  <span className="tl-dot" aria-hidden="true"/>
                  <div className="tl-main">
                    <button type="button" className="tl-head" onClick={()=>setOpenId(expanded?null:r.id)}
                      aria-expanded={expanded}>
                      <span className="tl-when">
                        <b>{remPhrase(r)}</b>
                        {when && <span className="tl-date">{when}</span>}
                        <span className="tl-meta">
                          {(r.channels||[]).map(c=>CH_LABEL[c]||c).join(" · ") || "No channels"}
                          {" — "}{(r.recipients||[]).map(c=>RCP_LABEL[c]||c).join(" and ") || "no recipients"}
                        </span>
                      </span>
                      <span className={"sb-chev"+(expanded?" open":"")}><ChevronRightIcon className="hi hi-sm" aria-hidden="true"/></span>
                    </button>
                    {invalid && <div className="tl-err" role="alert">Choose at least one channel and one recipient.</div>}
                    {/* Always mounted so it can animate BOTH ways; `inert`
                        keeps the collapsed controls out of the tab order. */}
                    <div className={"tl-advwrap"+(expanded?" open":"")}>
                      <div className="tl-adv" inert={expanded?undefined:""} aria-hidden={!expanded}>
                      <div className="tl-advin">
                        <div className="tl-time">
                          <input type="number" min="0" max="60" value={r.offset} aria-label="Days"
                            onChange={e=>upd(r.id,{offset:Math.max(0,Math.min(60,Number(e.target.value)||0))})}/>
                          <span>day{r.offset===1?"":"s"}</span>
                          <select value={r.when} aria-label="Before or after due date"
                            onChange={e=>upd(r.id,{when:e.target.value})}>
                            <option value="before">before due</option><option value="after">after due</option>
                          </select>
                        </div>
                        {/* Two different questions — they were sharing one
                            "Delivery options" label and reading as one list. */}
                        <div className="tl-lbl">How to notify</div>
                        <div className="chips">
                          {REMINDER_CHANNELS.map(c => <button type="button" key={c}
                            className={"sb-rchip"+((r.channels||[]).includes(c)?" on":"")}
                            aria-pressed={(r.channels||[]).includes(c)}
                            onClick={()=>toggleArr(r.id,"channels",c)}>{CH_LABEL[c]||c}</button>)}
                        </div>
                        <div className="tl-lbl">Who to notify</div>
                        <div className="chips">
                          {REMINDER_RECIPIENTS.map(c => <button type="button" key={c}
                            className={"sb-rchip"+((r.recipients||[]).includes(c)?" on":"")}
                            aria-pressed={(r.recipients||[]).includes(c)}
                            onClick={()=>toggleArr(r.id,"recipients",c)}>{RCP_LABEL[c]||c}</button>)}
                        </div>
                        <button type="button" className="tl-remove" onClick={()=>{ onChange(rem.filter(x=>x.id!==r.id)); setOpenId(null); }}>
                          <XMarkIcon className="hi hi-sm" aria-hidden="true"/> Remove this reminder</button>
                      </div>
                      </div>
                    </div>
                  </div>
                  <button type="button" className={"sb-sw"+(!off?" on":"")} role="switch" aria-checked={!off}
                    aria-label={`Reminder ${remPhrase(r)} enabled`}
                    onClick={()=>upd(r.id,{enabled:off})}><span/></button>
                </div>
              );
            })}
          </div>
          {rem.length<MAX_REMINDERS
            ? <button type="button" className="sb-btn ghost compact" onClick={add}><PlusIcon className="hi hi-sm" aria-hidden="true"/> Add reminder</button>
            : <div className="sb-sub">Maximum {MAX_REMINDERS} reminders.</div>}
          <div className="sb-btnrow" style={{marginTop:14}}>
            {!isDefault && <button type="button" className="sb-btn ghost" onClick={()=>onChange([...(defaults||[])])}>Use team default</button>}
            <button type="button" className="sb-btn" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}

function TaskEditor({ task, prefill, users, allTasks, defaultReminders, onClose, onSave, onAuto }) {
  const [f, setF] = useState(() => {
    // Edit the RAW stored title (not the Title-Cased display value), and never
    // carry the display-only `_rawTitle` field into the saved document.
    const { _rawTitle, ...editable } = task || {};
    const base = task ? { ...editable, title: _rawTitle ?? task.title } : {
      title:"", type:"", location:"", owner:"", ownerSuggested:"",   // #1/#2 — nothing pre-selected
      shootDate:"", postDate:"", status:"Planned", priority:"Medium",
      blockedOn:"", brief:"", relatedEvent:"", link:"", notes:"", support:[], links:{},
      ...(prefill || {}),
    };
    // #11 — merge legacy "Creative brief" + "Notes" into one "Brief & Notes" field.
    if (task && task.notes && !String(base.brief || "").includes(task.notes))
      base.brief = [base.brief, task.notes].filter(Boolean).join("\n\n");
    base.notes = "";
    if (!base.reminders || !base.reminders.length)
      base.reminders = (defaultReminders && defaultReminders.length) ? defaultReminders : DEFAULT_REMINDERS;
    return base;
  });
  const set = (k,v)=>setF(p=>({...p,[k]:v}));
  const [attempted, setAttempted] = useState(false);   // #5 — surface validation only after a save attempt
  // #10 — shoot-based types (Reel/Photography) need a shoot date + location;
  // graphics types (Poster) don't, so those inputs clear/disable.
  const isShoot = isShootType(f.type);
  const setType = (t) => setF(p => ({ ...p, type:t,
    ...(isShootType(t) ? {} : { shootDate:"", location:"" }) }));
  const [remOpen, setRemOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [crewWarn, setCrewWarn] = useState(false);
  const [autoFeedback, setAutoFeedback] = useState(null);   // { kind:"err"|"ok"|"info", msg, crew? }
  const [showWhy, setShowWhy] = useState(false);
  const remDefaults = (defaultReminders && defaultReminders.length) ? defaultReminders : DEFAULT_REMINDERS;
  const hasOwner = f.owner && f.owner !== "Pending";
  // #1 — only AVAILABLE people can be chosen as owner, but keep an already-set
  // (now-unavailable) owner visible on an existing task so it still displays.
  const ownerOptions = useMemo(() => {
    const avail = users.filter(isAvailable);
    if (hasOwner && !avail.some(u => u.name === f.owner)) {
      const cur = users.find(u => u.name === f.owner);
      if (cur) return [cur, ...avail];
    }
    return avail;
  }, [users, f.owner]);
  // #5 — one clear reason the form can't be saved yet (empty when it's valid).
  /* Floors for the native date pickers. Normally today (and, for the post
     date, the shoot date). When editing a task whose date already sits in the
     past, that date becomes the floor instead — otherwise the browser marks
     the saved value invalid and the field can't be reopened. */
  const t0 = todayStr();
  const dateMsg = dateIssues(f, task);
  const minShoot = task?.shootDate && task.shootDate < t0 ? task.shootDate : t0;
  const minPost = (() => {
    const floor = isShoot && f.shootDate && f.shootDate > t0 ? f.shootDate : t0;
    return task?.postDate && task.postDate < floor ? task.postDate : floor;
  })();

  // Who the last recommendation put forward — used to mark those rows, and
  // retired the moment the user edits the team by hand. A recommendation the
  // user has already overruled is stale, and stale advice is worse than none.
  const recommendedNames = useMemo(
    () => new Set(autoFeedback?.kind === "ok" ? (autoFeedback.crew || []).map(c => c.name) : []),
    [autoFeedback]);
  const editCrew = (next) => { set("support", next); setAutoFeedback(null); setShowWhy(false); };

  // Footer read-out of the team as it stands, so nobody commits blind.
  const crewSummary = useMemo(() => {
    const crew = (f.support || []).filter(c => c && c.name && c.name !== "Pending");
    if (!crew.length) return null;
    const strained = crew.filter(c => {
      const p = users.find(u => u.name === c.name);
      const b = p && loadSummary(p, allTasks || []).band.key;
      return b === "busy" || b === "high";
    }).length;
    return { text: `${crew.length} crew selected`, strained };
  }, [f.support, users, allTasks]);
  const validationMsg =
    !f.title.trim() ? "Add a content title."
    : !f.type ? "Select a content type."
    : !f.owner ? "Select an owner."
    : (isShoot && !f.location) ? "Select a location."
    : (isShoot && !f.shootDate) ? "Set a shoot date."
    : !f.postDate ? "Set a post date."
    : dateMsg ? dateMsg
    : (f.link && !isValidUrl(f.link)) ? "The reference link isn't a valid URL."
    : "";
  const valid = !validationMsg;
  // Auto-assign needs the details that make an assignment correct (type, owner,
  // and — for shoot-based content — a location + shoot date), plus a post date.
  // Without them, don't guess (e.g. assume graphics) — tell the user what's missing.
  const autoAssignMsg =
    !f.type ? "Select a content type before auto-assigning."
    : !f.owner ? "Select an owner before auto-assigning."
    : (isShoot && !f.location) ? "Select a location before auto-assigning."
    : (isShoot && !f.shootDate) ? "Set a shoot date before auto-assigning."
    : !f.postDate ? "Set a post date before auto-assigning."
    : "";
  const tryAutoAssign = () => {
    setShowWhy(false);
    if (autoAssignMsg) { setAutoFeedback({ kind: "err", msg: autoAssignMsg }); return; }
    const crew = onAuto(f);
    const current = (f.support || []).filter(c => c && c.name);
    // Re-running on unchanged inputs returns the same team. Say so, and leave
    // the crew untouched — a button that appears to do nothing reads as broken.
    if (crew.length && sameCrew(crew, current)) {
      setAutoFeedback({ kind: "ok", crew,
        msg: "Already the best available crew for this content — nothing to change." });
      return;
    }
    set("support", crew);
    if (crew.length) {
      setAutoFeedback({ kind: "ok", crew, msg: current.length
        ? "Team updated — re-matched on role, availability and upcoming responsibilities."
        : "Recommended based on role, availability and upcoming responsibilities." });
    } else if (current.length) {
      // Never silently wipe a team the user built by hand.
      set("support", current);
      setAutoFeedback({ kind: "info",
        msg: "No better match available right now — keeping your current team." });
    } else {
      // Explain the no-op so it never looks like a silent failure.
      const ownerU = users.find(u => u.name === f.owner);
      const ownerDesigns = !isShoot && ownerU && (ownerU.skills || []).includes("design");
      setAutoFeedback({ kind: "info", msg: ownerDesigns
        ? `${(f.owner || "").split(" ")[0]} can design this — no extra crew needed.`
        : "No available team member matched this content. Add crew manually below." });
    }
  };
  // Clear a blocking error once the missing details are filled in.
  useEffect(() => { if (autoFeedback?.kind === "err" && !autoAssignMsg) setAutoFeedback(null); }, [autoAssignMsg, autoFeedback]);
  // Dirty = the form differs from the snapshot taken on first render. Compared
  // by value, so focus/blur/formatting don't trip it; a successful save closes
  // the editor (unmount) before this could warn.
  const initial = useRef(JSON.stringify(f));
  // Cleared just before the post-save close so that navigation isn't blocked.
  const savedRef = useRef(false);
  const isDirty = !savedRef.current && JSON.stringify(f) !== initial.current;
  const { leaveGuard } = useUnsavedRouteGuard(isDirty);
  // Closing IS a navigation now; the blocker above intercepts it while dirty,
  // so every close affordance can call onClose directly.
  const requestClose = onClose;
  const drag = useSheetDrag(requestClose);
  const doSave = async (withSoloOwner) => {
    // #2 — with no crew, the owner becomes the sole lead (Lead Designer / Content Lead).
    const payload = withSoloOwner && hasOwner ? { ...f, support: [soloCrewFor(f.type, f.owner)] } : f;
    setSaving(true);
    savedRef.current = true;                          // pre-clear so the close nav passes the guard
    try { await onSave(payload); }
    catch { savedRef.current = false; setSaving(false); }   // save failed → re-arm the guard
  };
  const trySave = () => {
    setAttempted(true);
    if (!valid) return;   // keep the button enabled; the footer shows the reason
    // #2 — no production team → confirm the owner will work alone before saving.
    if ((f.support || []).length === 0 && hasOwner) { setCrewWarn(true); return; }
    doSave(false);
  };
  return (
    <Portal>
    <div className="sb-scrim" onClick={requestClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()} style={drag.sheetStyle}>
        <div className="sb-grab" {...drag.handleProps}><span/></div>
        <div className="hd"><b className="sb-serif sb-sheettitle">{task?"Edit content":"Plan content"}</b>
          <button className="sb-x" onClick={requestClose} aria-label={task?"Close editor":"Close planner"}>
            <XMarkIcon className="hi" aria-hidden="true" /></button></div>
        <div className="bd sb-bd-sections">
          <div className="sb-sub" style={{marginTop:0}}>Plan a piece of content. The team adds the deliverable links later, when it's ready for QA.</div>
          <section className="sb-sec">
          <div className="sb-shead sb-sechead"><h2><DocumentTextIcon className="hi" aria-hidden="true"/>Content</h2></div>
          <div className="sb-field"><label>Content title<span className="sb-req" aria-hidden="true">*</span></label>
            <input value={f.title} onChange={e=>set("title",e.target.value)} placeholder="e.g. Sunday welcome reel" /></div>
          <div className="sb-formrow">
            <div className="sb-field"><label>Type<span className="sb-req" aria-hidden="true">*</span></label>
              <select value={f.type} onChange={e=>setType(e.target.value)}>
                <option value="" disabled>Select content type</option>
                {TYPES.map(t=><option key={t}>{t}</option>)}</select></div>
            <div className="sb-field"><label>Location{isShoot && <span className="sb-req" aria-hidden="true">*</span>}</label>
              <select value={f.location} disabled={!isShoot} onChange={e=>set("location",e.target.value)} title={!isShoot?"Location applies to shoot-based content only":undefined}>
                <option value="">Select location</option><option>479</option><option>828</option><option>Both</option></select></div>
          </div>
          <div className="sb-field"><label>Owner: who brings the idea / leads<span className="sb-req" aria-hidden="true">*</span></label>
            <select value={f.owner||""} onChange={e=>set("owner",e.target.value)}>
              <option value="" disabled>Select owner</option>
              <option value="Pending">Pending: unassigned</option>
              {ownerOptions.map(u=><option key={u.id}>{u.name}</option>)}</select>
            {f.owner==="Pending" && f.ownerSuggested && (() => {
              const m = matchUser(f.ownerSuggested, users);
              return m
                ? <button type="button" className="link" style={{marginTop:6}}
                    onClick={()=>{ set("owner", m.name); set("ownerSuggested",""); }}>
                    💡 From the sheet this was “{f.ownerSuggested}”. Assign {m.name}?</button>
                : <div className="sb-sub" style={{marginTop:6}}>From the sheet: “{f.ownerSuggested}” (no matching account yet)</div>;
            })()}
          </div>
          <div className="sb-field"><label>Brief &amp; Notes</label>
            <textarea rows={4} value={f.brief||""} onChange={e=>set("brief",e.target.value)}
              placeholder="Objectives, key message, references, notes, links, or anything the team should know." /></div>
          <div className="sb-formrow">
            {/* `min` steers the native picker; dateIssues() is the real gate,
                and it never blocks a past date that was already saved. */}
            <div className="sb-field"><label>Shoot date{isShoot && <span className="sb-req" aria-hidden="true">*</span>}</label>
              <input type="date" value={f.shootDate||""} disabled={!isShoot} min={minShoot}
                aria-invalid={!!dateMsg || undefined}
                onChange={e=>set("shootDate",e.target.value)}
                title={!isShoot?"Shoot date applies to shoot-based content only":undefined} /></div>
            <div className="sb-field"><label>Post date<span className="sb-req" aria-hidden="true">*</span></label>
              <input type="date" value={f.postDate} min={minPost}
                aria-invalid={!!dateMsg || undefined}
                aria-describedby={dateMsg ? "sb-dateerr" : undefined}
                onChange={e=>set("postDate",e.target.value)} /></div>
          </div>
          {/* `min` is only a hint to the picker — iOS lets you spin past it —
              so the conflict is reported the moment it exists, not at save. */}
          {dateMsg && <div className="sb-fielderr" id="sb-dateerr" role="alert"
            style={{marginTop:-4,marginBottom:13}}>{dateMsg}</div>}
          <div className="sb-field" style={{maxWidth:200}}><label>Priority</label>
            <select value={f.priority||"Medium"} onChange={e=>set("priority",e.target.value)}>{PRIORITIES.map(p=><option key={p}>{p}</option>)}</select></div>
          <div className="sb-field"><label>Related event (optional)</label>
            <input value={f.relatedEvent} onChange={e=>set("relatedEvent",e.target.value)} placeholder="e.g. Easter Service" /></div>
          <div className="sb-field" style={{marginBottom:0}}><label>Reference link (optional)</label>
            <UrlInput value={f.link} ariaLabel="Reference link"
              placeholder="https://…  (idea / inspiration / reference)"
              onChange={v=>set("link",v)} /></div>
          </section>

          <section className="sb-sec">
          <div className="sb-shead sb-sechead"><h2><UserGroupIcon className="hi" aria-hidden="true"/>Production team</h2>
            <button type="button" className="link" onClick={tryAutoAssign}><BoltIcon className="hi hi-sm" aria-hidden="true"/>
              {(f.support||[]).length ? " Recommend again" : " Auto-assign"}</button></div>
          {autoFeedback && (autoFeedback.kind === "err"
            ? <div className="sb-fielderr" role="alert" style={{marginBottom:8}}>{autoFeedback.msg}</div>
            : <div className={"sb-autofb"+(autoFeedback.kind==="ok"?" ok":"")} role="status">
                <span>{autoFeedback.msg}</span>
                {autoFeedback.kind==="ok" && autoFeedback.crew?.length>0 &&
                  <button type="button" className={"sb-whybtn"+(showWhy?" open":"")}
                    aria-expanded={showWhy} onClick={()=>setShowWhy(v=>!v)}>
                    {showWhy ? "Hide explanation" : "Why these people?"}
                    <ChevronDownIcon className="hi sb-whybtn-chev" aria-hidden="true"/></button>}
              </div>)}
          {(f.support||[]).length===0
            ? <div className="sb-crewempty">No one on the production team yet — auto-assign or add someone below.</div>
            : <div className="sb-crewlist">
                {orderedCrew(f.support).map(({s,i}, pos) => (
                  <CrewRow key={(s.name||"pending")+"-"+i} s={s} idx={i} pos={pos} users={users} allTasks={allTasks}
                    showLoc={f.location==="Both"} recommended={recommendedNames.has(s.name)}
                    reason={showWhy && recommendedNames.has(s.name)
                      ? crewReason(s, users, allTasks||[]) : null}
                    onRole={(idx,role)=>editCrew(f.support.map((x,j)=> j===idx ? {...x, role} : x))}
                    onRemove={(idx)=>editCrew(f.support.filter((_,j)=>j!==idx))}
                    onAssignSuggested={(idx,name)=>editCrew(f.support.map((x,j)=> j===idx ? { name, role:x.role, ...(x.loc?{loc:x.loc}:{}) } : x))} />
                ))}
              </div>}
          <AddCrew users={users} allTasks={allTasks} onAdd={(c)=>editCrew([...(f.support||[]),c])} />
          </section>

          <section className="sb-sec">
          <div className="sb-shead sb-sechead"><h2><BellAlertIcon className="hi" aria-hidden="true"/>Notifications</h2></div>
          <div className="sb-field" style={{marginBottom:0}}>
            <ReminderSummary reminders={f.reminders} defaults={remDefaults}
              postDate={f.postDate} onCustomize={()=>setRemOpen(true)} />
          </div>
          </section>
          {remOpen && <ReminderSheet reminders={f.reminders} defaults={remDefaults}
            postDate={f.postDate} onChange={(r)=>set("reminders",r)} onClose={()=>setRemOpen(false)} />}
        </div>
        {/* #7 — sticky footer: an optional validation message (only after a save
            attempt, and only while invalid) above a full-width Save button. */}
        <div className="sb-sheetfoot">
          {/* Reassurance before committing: who is on the hook, and whether any
              of them is already stretched. Silent when there is nothing to warn about. */}
          {crewSummary && <div className="sb-footcrew">
            <span>{crewSummary.text}</span>
            {/* `strained` is a COUNT: `{0 && …}` renders a bare "0" in JSX. */}
            {crewSummary.strained > 0 &&
              <span className="sb-footcrew-warn">{crewSummary.strained} already busy</span>}
          </div>}
          {attempted && validationMsg &&
            <div className="sb-footmsg" role="alert">{validationMsg}</div>}
          <button className="sb-btn sb-footbtn" disabled={saving || (task && !isDirty)} onClick={trySave}>
            {saving ? "Saving…" : task ? "Save changes" : "Create content"}</button>
        </div>
      </div>
    </div>
    {crewWarn && <ConfirmDialog
      title="No production team assigned"
      body={`${f.owner} will be responsible for ${soloCrewVerb(f.type)} alone.`}
      confirmLabel="Continue" cancelLabel="Go back" tone="warning" danger={false}
      busyLabel="Saving…" onConfirm={()=>doSave(true)} onClose={()=>setCrewWarn(false)} />}
    {leaveGuard}
    </Portal>
  );
}
/* One person on the production team. The PERSON leads, the role is an inline-
   editable chip (no remove-and-re-add to change it), workload is a quiet badge,
   and removing is a small trailing action — never the dominant element. */
function CrewRow({ s, idx, pos = 0, users, allTasks, showLoc, recommended, reason, onRole, onRemove, onAssignSuggested }) {
  const pending = s.name === "Pending";
  const m = pending && s.suggested ? matchUser(s.suggested, users) : null;
  const person = users.find(u => u.name === s.name);
  // Only the ends of the scale earn a coloured chip; everyone gets one short line.
  const sum = person ? loadSummary(person, allTasks || []) : null;
  return (
    <div className="sb-crewrow" style={{ "--i": pos }}>
      <span className="sb-av sb-crew-av" aria-hidden="true">{pending ? "?" : initials(s.name)}</span>
      <div className="sb-crew-main">
        <span className="sb-crew-name">{pending ? pendingCrewLabel(s) : s.name}</span>
        <div className="sb-crew-meta">
          <span className="sb-crew-rolechip">
            <select className="sb-crew-role" value={s.role || "other"}
              aria-label={`Responsibility for ${pending ? "this slot" : s.name}`}
              onChange={(e)=>onRole(idx, e.target.value)}>
              {CREW_ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
            <ChevronDownIcon className="hi sb-crew-rolechev" aria-hidden="true"/>
          </span>
          {/* One status at most. When the whole group is system-picked, saying
              "Recommended" on every row is noise — only a notable band earns a chip. */}
          {sum?.notable && <span className={"sb-crew-load tone-"+sum.band.tone}>{sum.band.label}</span>}
          {/* Campus only earns space when the task actually spans both. */}
          {showLoc && s.loc && <span className="sb-crew-loc">{s.loc}</span>}
          {pending && s.suggested && <span className="sb-crew-loc">suggested: {s.suggested}</span>}
        </div>
        {/* The explanation lives with the person it's about, not in a panel
            that lists everybody a second time. */}
        {reason && <span className="sb-crew-why">
          <CheckIcon className="hi hi-sm" aria-hidden="true"/>{reason}</span>}
      </div>
      {m && <button type="button" className="sb-btn ghost compact sb-crew-assign"
        onClick={()=>onAssignSuggested(idx, m.name)}>Assign {m.name.split(" ")[0]}</button>}
      <button type="button" className="sb-crew-x" onClick={()=>onRemove(idx)}
        aria-label={`Remove ${pending ? "this slot" : s.name} from the production team`}>
        <XMarkIcon className="hi hi-sm" aria-hidden="true"/></button>
    </div>
  );
}

/* Guided add flow: one "Add crew member" affordance that reveals person →
   responsibility → confirm, instead of two always-visible dropdowns. */
function AddCrew({ users, allTasks, onAdd }) {
  const assignable = (users || []).filter(isAvailable);   // never assign unavailable people
  const [open, setOpen] = useState(false);
  const [n,setN] = useState(""); const [r,setR] = useState(""); const [label,setLabel] = useState("");
  const isOther = r === "other";
  const canAdd = !!n && !!r && (!isOther || label.trim());
  const picked = assignable.find(u => u.name === n);
  const pickedLoad = useMemo(() => picked ? loadSummary(picked, allTasks || []) : null, [picked, allTasks]);
  const reset = () => { setN(""); setR(""); setLabel(""); setOpen(false); };
  const add = () => { onAdd(isOther ? { name:n, role:"other", label:label.trim() } : { name:n, role:r }); reset(); };
  if (!open) return (
    <button type="button" className="sb-addcrew-btn" onClick={()=>setOpen(true)}>
      <PlusIcon className="hi hi-sm" aria-hidden="true"/> Add crew member</button>
  );
  return (
    <div className="sb-addcrew-panel">
      <div className="sb-field"><label>Who's joining?</label>
        <select value={n} autoFocus onChange={e=>setN(e.target.value)}>
          <option value="" disabled>Select team member</option>
          {assignable.map(u=><option key={u.id}>{u.name}</option>)}</select></div>
      {/* Consequence of this choice, stated before it is made — a nudge, not a
          blocking dialog, so adding a busy person stays a one-tap decision. */}
      {pickedLoad && <div className={"sb-crewhint"+(pickedLoad.notable?" notable":"")}>
        {pickedLoad.notable &&
          <span className={"sb-wlbadge tone-"+pickedLoad.band.tone}><i className="sb-wl-dot" aria-hidden="true"/>{pickedLoad.band.label}</span>}
        <span>{picked.name.split(" ")[0]} · {pickedLoad.detail}</span>
      </div>}
      {n && <div className="sb-field" style={{marginTop:10}}><label>What's their responsibility?</label>
        <select value={r} onChange={e=>setR(e.target.value)}>
          <option value="" disabled>Select responsibility</option>
          {CREW_ROLES.map(x=><option key={x} value={x}>{roleLabel(x)}</option>)}</select></div>}
      {isOther && <input value={label} onChange={e=>setLabel(e.target.value)} className="sb-addcrew-label"
        placeholder="Custom task, e.g. Voiceover, Lighting" />}
      <div className="sb-btnrow" style={{marginTop:12}}>
        <button type="button" className="sb-btn ghost compact" onClick={reset}>Cancel</button>
        <button type="button" className="sb-btn compact" disabled={!canAdd} onClick={add}>Add to team</button>
      </div>
    </div>
  );
}

/* ===================================================================
   USER EDITOR (edit / approve)
   =================================================================== */
function UserEditor({ user, onClose, onSave, onApprove }) {
  const isPending = user.status === "pending";
  const [f, setF] = useState({
    skills: user.skills||[], location: user.location||[], role: user.role||"member",
    deprioritize: !!user.deprioritize, limited: !!user.limited, manualSchedule: !!user.manualSchedule,
    qa: !!user.qa, captions: !!user.captions, name: user.name||"",
    departments: userDepartments(user), lead: !!user.lead,   // #3 — multiple departments
    available: user.available !== false,                     // #4 — available for assignment (default on)
  });
  const [resetMsg, setResetMsg] = useState("");
  const set = (k,v)=>setF(p=>({...p,[k]:v}));
  const toggleSkill = (s)=>set("skills", f.skills.includes(s)?f.skills.filter(x=>x!==s):[...f.skills,s]);
  const toggleLoc = (l)=>set("location", f.location.includes(l)?f.location.filter(x=>x!==l):[...f.location,l]);
  const toggleDept = (d)=>set("departments", f.departments.includes(d)?f.departments.filter(x=>x!==d):[...f.departments,d]);
  const valid = f.name.trim() && f.skills.length && f.location.length;
  const SK = ["shoot","edit","coordinate","design","shadow"];
  const initial = useRef(JSON.stringify(f));
  const isDirty = JSON.stringify(f) !== initial.current;
  const { requestClose, leaveGuard } = useUnsavedGuard(isDirty, onClose);

  const payload = () => ({ id:user.id, ...f });
  const reset = async () => {
    try { await sendPasswordResetEmail(auth, user.email); setResetMsg("Reset email sent to "+user.email); }
    catch { setResetMsg("Couldn't send reset email."); }
  };

  return (
    <Portal>
    <div className="sb-scrim" onClick={requestClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()}>
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>{isPending?"Approve "+user.name:"Edit "+user.name}</b>
          <button className="sb-x" onClick={requestClose}><XMarkIcon className="hi" aria-hidden="true" /></button></div>
        <div className="bd">
          {isPending && <div className="sb-banner">Set their skills and location, then approve to let them in.</div>}

          <div className="sb-field"><label>Name<span className="sb-req" aria-hidden="true">*</span></label>
            <input value={f.name} onChange={e=>set("name",e.target.value)} /></div>
          <div className="sb-field"><label>Email (login)</label>
            <input value={user.email} disabled style={{opacity:.7}} /></div>

          <div className="sb-field"><label>Access level</label>
            <select value={f.role} onChange={e=>set("role",e.target.value)}>
              <option value="member">Member: can view all tasks</option>
              <option value="admin">Admin: full control</option></select></div>

          <div className="sb-field"><label>Departments <span className="sb-optional">(one or more)</span></label>
            <div className="sb-seg" style={{flexWrap:"wrap"}}>
              {DEPARTMENTS.map(d => <button key={d} type="button"
                className={"sb-segbtn"+(f.departments.includes(d)?" on":"")}
                aria-pressed={f.departments.includes(d)} onClick={()=>toggleDept(d)}>{d}</button>)}</div></div>

          <div className="sb-field"><label>Skills (what they can do)<span className="sb-req" aria-hidden="true">*</span></label>
            <div className="sb-seg" style={{flexWrap:"wrap"}}>
              {SK.map(s=>(<button key={s} className={"sb-segbtn"+(f.skills.includes(s)?" on":"")}
                onClick={()=>toggleSkill(s)}>{roleLabel(s)}</button>))}</div></div>

          <div className="sb-field"><label>Service location<span className="sb-req" aria-hidden="true">*</span></label>
            <div className="sb-seg">{["479","828"].map(l=>(
              <button key={l} className={"sb-segbtn"+(f.location.includes(l)?" on":"")} onClick={()=>toggleLoc(l)}>{l}</button>))}</div></div>

          <div className="sb-field"><label>Availability</label>
            <Toggle label="Available for assignment" v={f.available} on={()=>set("available",!f.available)} />
            {!f.available && <div className="sb-sub" style={{marginTop:4}}>Excluded from auto-assignment and can't be manually assigned until turned back on.</div>}
          </div>

          <div className="sb-field"><label>Roles &amp; permissions</label>
            <Toggle label="Department lead: leads their team" v={f.lead} on={()=>set("lead",!f.lead)} />
            <Toggle label="QA reviewer: can approve content & request changes" v={f.qa} on={()=>set("qa",!f.qa)} />
            <Toggle label="Captions & upload: handles posting after approval" v={f.captions} on={()=>set("captions",!f.captions)} />
          </div>

          <div className="sb-field"><label>Special handling</label>
            <Toggle label="Deprioritize: only assign if no one else free" v={f.deprioritize} on={()=>set("deprioritize",!f.deprioritize)} />
            <Toggle label="Coordinate only: can't shoot/edit after church" v={f.limited} on={()=>set("limited",!f.limited)} />
            <Toggle label="Manual schedule: confirm availability each time" v={f.manualSchedule} on={()=>set("manualSchedule",!f.manualSchedule)} />
          </div>

          {isPending
            ? <button className="sb-btn green" disabled={!valid} onClick={()=>onApprove(payload())}>Approve &amp; let in</button>
            : <button className="sb-btn" disabled={!valid} onClick={()=>onSave(payload())}>Save changes</button>}

          {!isPending && <>
            <button className="sb-btn ghost" style={{marginTop:9}} onClick={reset}>Send password reset email</button>
            {resetMsg && <div className="sb-sub" style={{marginTop:8,textAlign:"center"}}>{resetMsg}</div>}
          </>}
        </div>
      </div>
    </div>
    {leaveGuard}
    </Portal>
  );
}
function Toggle({ label, v, on }) {
  return (
    <button onClick={on} style={{display:"flex",alignItems:"center",gap:10,width:"100%",background:"none",border:"none",padding:"8px 0",textAlign:"left"}}>
      <span style={{width:38,height:23,borderRadius:999,background:v?"var(--violet)":"var(--line)",position:"relative",flex:"none",transition:".15s"}}>
        <span style={{position:"absolute",top:2,left:v?17:2,width:19,height:19,borderRadius:"50%",background:"#fff",transition:".15s",boxShadow:"0 1px 3px rgba(0,0,0,.2)"}}/>
      </span>
      <span style={{fontSize:13,color:"var(--ink)"}}>{label}</span>
    </button>
  );
}
