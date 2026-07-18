/* IFC Creatives Board — the digital home of the IFC Creative Team.
   (Internal note: powered by StudioBoard architecture.) */
import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  onAuthStateChanged, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, updateProfile, sendPasswordResetEmail,
} from "firebase/auth";
import {
  collection, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, serverTimestamp,
} from "firebase/firestore";
import { auth, db, googleProvider, functions } from "./firebase";
import { httpsCallable } from "firebase/functions";
import {
  STAGES, statusClass, roleLabel, initials, emailFor,
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
  DEFAULT_REMINDERS, REMINDER_CHANNELS, REMINDER_RECIPIENTS, MAX_REMINDERS,
} from "./data";
import { upcomingEvents, searchEvents, isoDate } from "./events";
import { useNotifications, NOTIF_META, NOTIF_FALLBACK, PREF_TYPES, effectivePrefs, timeAgo } from "./notifications";
import { pushState, enablePush, listenForeground } from "./push";
import {
  HomeIcon, ClockIcon, ViewColumnsIcon, ClipboardDocumentListIcon, UserGroupIcon,
  Cog6ToothIcon, BellIcon, MagnifyingGlassIcon, XMarkIcon, ChevronRightIcon,
  EllipsisHorizontalIcon, ExclamationTriangleIcon, SunIcon, MoonIcon, FunnelIcon,
  BoltIcon, PlusIcon, ArrowUpTrayIcon, CalendarDaysIcon, CakeIcon,
  ChatBubbleLeftRightIcon, BellAlertIcon, ArrowRightStartOnRectangleIcon, CheckCircleIcon,
} from "@heroicons/react/24/outline";
import {
  HomeIcon as HomeSolid, ClockIcon as ClockSolid, ViewColumnsIcon as ViewColumnsSolid,
  ClipboardDocumentListIcon as ClipboardSolid, UserGroupIcon as UserGroupSolid,
  Cog6ToothIcon as CogSolid,
} from "@heroicons/react/24/solid";
import { setView, reportIssue, logIssue } from "./logging";
import { getTheme, setTheme } from "./theme";

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
function BetaBanner({ onReport }) {
  const [open, setOpen] = useState(() => loadPref("sb-beta-dismissed", false) !== true);
  if (!open) return null;
  const dismiss = () => { setOpen(false); savePref("sb-beta-dismissed", true); };
  return (
    <div className="sb-beta">
      <span className="sb-beta-tag">Beta</span>
      <span className="sb-beta-txt">We're testing IFC Creatives Board. Please report bugs, confusing steps, or feature ideas.</span>
      <button className="sb-beta-report" onClick={onReport}>Report</button>
      <button className="sb-beta-x" onClick={dismiss} aria-label="Dismiss beta notice"><XMarkIcon className="hi" aria-hidden="true" /></button>
    </div>
  );
}

/* Light/dark toggle. Default follows the OS; a manual choice is remembered. */
function ThemeToggle({ compact }) {
  const [theme, setT] = useState(getTheme());
  const toggle = () => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); setT(next); };
  return compact
    ? <button className="sb-report-top" onClick={toggle} aria-label="Toggle dark mode">
        {theme==="dark"?<SunIcon className="hi" aria-hidden="true"/>:<MoonIcon className="hi" aria-hidden="true"/>}</button>
    : <button className="sb-report" onClick={toggle} aria-label="Toggle dark mode">
        {theme==="dark"?<SunIcon className="hi-sm hi" aria-hidden="true"/>:<MoonIcon className="hi-sm hi" aria-hidden="true"/>}
        <span className="lbl">{theme==="dark"?"Light mode":"Dark mode"}</span></button>;
}

/* Mobile account drawer — opened from the header avatar. Pulls the profile,
   theme, report and sign-out off every screen and into one slide-up sheet. */
function ProfileDrawer({ me, isAdmin, unread = 0, pendingCount = 0, onClose, onNotifications, onReport, onGoTab }) {
  const [theme, setT] = useState(getTheme());
  const toggleTheme = () => { const next = theme==="dark"?"light":"dark"; setTheme(next); setT(next); };
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sb-scrim" onMouseDown={onClose}>
      <div className="sb-drawer" onMouseDown={e=>e.stopPropagation()}>
        <div className="sb-drawer-user">
          <span className="sb-av" style={{width:46,height:46,fontSize:16}}>{initials(me.name)}</span>
          <div style={{minWidth:0}}>
            <div className="nm">{me.name}</div>
            <div className="rl">{isAdmin?"Admin":"Member"} · {me.email}</div>
          </div>
        </div>
        {onGoTab && <button className="sb-drawer-item" onClick={()=>{ onGoTab("team"); onClose(); }}>
          <span className="i"><UserGroupIcon className="hi" aria-hidden="true"/></span>Team
        </button>}
        {onGoTab && isAdmin && <button className="sb-drawer-item" onClick={()=>{ onGoTab("admin"); onClose(); }}>
          <span className="i"><Cog6ToothIcon className="hi" aria-hidden="true"/></span>Admin
          {pendingCount>0 && <span className="sb-drawer-state">{pendingCount}</span>}
        </button>}
        <button className="sb-drawer-item" onClick={toggleTheme}>
          <span className="i">{theme==="dark"?<SunIcon className="hi" aria-hidden="true"/>:<MoonIcon className="hi" aria-hidden="true"/>}</span>
          {theme==="dark"?"Light mode":"Dark mode"}
          <span className="sb-drawer-state">{theme==="dark"?"On":"Off"}</span>
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
  );
}

/* Notification Center — a slide-over listing the signed-in user's
   notifications (newest first). Reads via useNotifications; docs are written
   by the backend (Slice 3), so until then this shows the empty state. */
function NotifCenter({ notif, onClose, onOpenTask, onViewEvent, onSettings }) {
  const { items, unread, hasMore, loadMore, markRead, markAllRead } = notif;
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const open = (n) => {
    if (!n.read) markRead(n.id);
    if (n.taskId) { onClose(); onOpenTask(n.taskId); }
    else if (n.eventOccurrenceId && onViewEvent) {
      onClose();
      onViewEvent({ eventOccurrenceId: n.eventOccurrenceId, name: n.eventName || "Event", annual: false });
    }
  };
  return (
    <div className="sb-scrim" onMouseDown={onClose}>
      <div className="sb-notifpanel" onMouseDown={e=>e.stopPropagation()}>
        <div className="sb-notifhd">
          <b className="sb-serif" style={{fontSize:17}}>Notifications</b>
          <div className="sb-notifhd-actions">
            {unread>0 && <button className="link" onClick={markAllRead}>Mark all read</button>}
            <button className="sb-iconbtn" onClick={onSettings} aria-label="Notification settings"><Cog6ToothIcon className="hi" aria-hidden="true"/></button>
            <button className="sb-x" onClick={onClose}><XMarkIcon className="hi" aria-hidden="true" /></button>
          </div>
        </div>
        {items.length===0
          ? <div className="sb-empty"><div className="big"><BellIcon className="hi hi-empty" aria-hidden="true"/></div>You're all caught up. New updates will show here.</div>
          : <div className="sb-notiflist">
              {items.map(n => {
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
                    {!n.read && <span className="ndot" />}
                  </button>
                );
              })}
              {hasMore && <div style={{textAlign:"center",padding:"6px 0 12px"}}>
                <button className="sb-btn ghost compact" onClick={loadMore}>Load more</button></div>}
            </div>}
      </div>
    </div>
  );
}

/* Device push enrollment. iOS/iPadOS only allow web push once the app is added
   to the Home Screen, so we guide the user there first instead of showing a
   button that silently won't work. */
function PushControls({ me }) {
  const [state, setState] = useState("loading");
  const [busy, setBusy] = useState(false);
  useEffect(() => { pushState().then(setState); }, []);
  const enable = async () => {
    setBusy(true);
    const r = await enablePush(me.id);
    setState(r.ok ? "granted" : (r.reason === "denied" ? "denied" : await pushState()));
    setBusy(false);
  };
  if (state === "loading") return null;
  if (state === "granted") return <div className="sb-push ok">✓ Push is on for this device.</div>;
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
function AdminEmailTest() {
  const [to, setTo] = useState("");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true); setStatus(null);
    try {
      const res = await httpsCallable(functions, "sendTestEmail")({ to: to.trim() });
      setStatus({ ok: true, msg: `Sent ✓${res.data?.messageId ? ` (id ${res.data.messageId})` : ""}` });
    } catch (e) {
      setStatus({ ok: false, msg: e?.message || "Send failed" });
    }
    setBusy(false);
  };
  return (
    <>
      <div className="sb-mlabel">Admin · test email</div>
      <div className="sb-field">
        <input type="email" value={to} onChange={(e)=>setTo(e.target.value)} placeholder="recipient@example.com" />
      </div>
      <button className="sb-btn ghost" disabled={busy || !to.trim()} onClick={send}>{busy ? "Sending…" : "Send test email"}</button>
      {status && <div className="sb-sub" style={{marginTop:8, color: status.ok ? "var(--green)" : "var(--red)"}}>{status.msg}</div>}
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
          <div className="ic"><ExclamationTriangleIcon className="hi hi-empty" aria-hidden="true"/></div>
          <h1>Something went wrong</h1>
          <p>The error has been logged. If you have a second, tell us what you were
             doing and we'll look into it.</p>
          <textarea rows={3} value={this.state.note} placeholder="What were you doing? (optional)"
            onChange={(e)=>this.setState({ note: e.target.value })}
            style={{width:"100%",borderRadius:12,border:"none",padding:"11px 12px",fontSize:16,marginBottom:12}} />
          {this.state.sent
            ? <p style={{marginTop:0}}>Thanks. Your report was sent.</p>
            : <button onClick={async ()=>{ await reportIssue({ note: this.state.note, action: "crash report" }); this.setState({ sent: true }); }}>Send report</button>}
          <button style={{marginTop:10}} onClick={()=>location.reload()}>Reload app</button>
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
function useCollection(path, canRead) {
  const [docs, setDocs] = useState([]);
  useEffect(() => {
    if (!canRead) { setDocs([]); return; }
    return onSnapshot(collection(db, path),
      (snap) => setDocs(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => logIssue({ kind: "error", action: `collection read failed: ${path}`,
        message: err.message, code: err.code }));
  }, [path, canRead]);
  return docs;
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
        <div className="ic">📡</div>
        <h1>Can't connect</h1>
        <p>Unable to connect right now. Please check your internet connection and try again.</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <button onClick={onRetry}>Try again</button>
          <button onClick={onSignOut} style={{ background: "rgba(255,255,255,.1)" }}>Sign out</button>
        </div>
        {!online && <p style={{ fontSize: 12.5, marginTop: 14 }}>Your device is currently offline.</p>}
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
    setErr(""); setOk(""); setBusy(true);
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

  const toggleMode = () => { setMode(m=>m==="register"?"signin":"register"); setErr(""); setOk(""); };
  return (
    <div className="sb-login">
      <div className="sb-loginbox">
        <div className="sb-lbrand">
          <div className="logo">✦</div>
          <h1>IFC Creatives Board</h1>
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
          <div className="sb-field"><label>Email</label>
            <input type="email" autoComplete="username" value={email}
              onChange={(e)=>setEmail(e.target.value)} placeholder="you@email.com" /></div>
          <div className="sb-field"><label>Password</label>
            <input type="password" autoComplete={mode==="register"?"new-password":"current-password"}
              value={pw} onChange={(e)=>setPw(e.target.value)} placeholder="••••••••"
              onKeyDown={(e)=>{ if(e.key==="Enter") doEmail(); }} /></div>

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
        <div className="ic">🪪</div>
        <h1>You're on the list, {profile.name.split(" ")[0]}</h1>
        <p>Your account is waiting for an admin to approve it. Once you're in, you'll see
           every reel and poster the team is working on. Hang tight, this usually doesn't take long.</p>
        <button onClick={()=>signOut(auth)}>Sign out</button>
      </div>
    </div>
  );
}

/* ===================================================================
   MAIN BOARD (approved users)
   =================================================================== */
function Board({ profile, isAdmin }) {
  // `users` = the active team (used for assignment, capacity, owner pickers).
  // `allUsers` = everyone incl. pending — admins only, for the approval queue.
  const users = useCollection("users", true).filter(u => u.status === "approved" || u.role === "admin");
  const allUsers = useCollection("users", isAdmin);
  const tasks = useCollection("tasks", true);
  const issues = useCollection("issues", isAdmin); // admin-only (rules)
  const notifSettings = useDoc("settings/notifications", true); // reminder defaults

  const [tab, setTab] = useState("home");
  const [openId, setOpenId] = useState(null);
  const [editTask, setEditTask] = useState(null);
  const [editPrefill, setEditPrefill] = useState(null);  // defaults for a new task (e.g. from an event)
  const newForEvent = (prefill) => { setEditPrefill(prefill); setEditTask("new"); };
  // Board scoped to one event occurrence (from Home's "View content →").
  const [boardEvent, setBoardEvent] = useState(null);
  const viewEvent = (occ) => {
    setBoardEvent({ id: occ.eventOccurrenceId, label: occ.name, annual: occ.annual, name: occ.name });
    setTab("board");
  };
  const [editUser, setEditUser] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);

  // Stamp the active screen onto any error/report logged from here.
  useEffect(() => setView(tab), [tab]);

  // Deep link from a push notification (/?task=<id>) → open that task once.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("task");
    if (t) { setOpenId(t); window.history.replaceState({}, "", window.location.pathname); }
  }, []);

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
  const notif = useNotifications(me.id);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifSettingsOpen, setNotifSettingsOpen] = useState(false);
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

  // Navigation model (v1.1.2): outline icon at rest, solid when active.
  // Mobile bottom nav = the 4 main destinations + Profile (Team/Admin live in
  // the profile sheet); desktop sidebar shows Main + Management groups.
  const navIco = (Out, Solid, active) => active
    ? <Solid className="hi hi-nav" aria-hidden="true" />
    : <Out className="hi hi-nav" aria-hidden="true" />;
  const mainNav = [
    { id:"home",  label:"Home",    ico:(a)=>navIco(HomeIcon, HomeSolid, a) },
    { id:"myday", label:"My Day",  ico:(a)=>navIco(ClockIcon, ClockSolid, a) },
    { id:"board", label:"Board",   ico:(a)=>navIco(ViewColumnsIcon, ViewColumnsSolid, a) },
    { id:"mine",  label:"My Work", ico:(a)=>navIco(ClipboardDocumentListIcon, ClipboardSolid, a) },
  ];
  const mgmtNav = [
    { id:"team", label:"Team", ico:(a)=>navIco(UserGroupIcon, UserGroupSolid, a) },
    ...(isAdmin ? [{ id:"admin", label:"Admin", badge: pendingCount, ico:(a)=>navIco(Cog6ToothIcon, CogSolid, a) }] : []),
  ];

  /* ---- task writes ---- */
  const saveTask = async (t) => {
    if (t.id) {
      const { id, ...rest } = t;
      await updateDoc(doc(db, "tasks", id), { ...rest, updatedAt: serverTimestamp() });
    } else {
      await addDoc(collection(db, "tasks"), {
        ...t, comments: [], reactions: {}, activity: [activityEntry("created", me.name)],
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
    }
    setEditTask(null);
  };
  const deleteTask = async (id) => { await deleteDoc(doc(db, "tasks", id)); };

  
  // Archive = move to the Posted/completed status (no separate flag in the model).
  const archiveTask = async (task) =>
    updateDoc(doc(db, "tasks", task.id), {
      status: "Posted",
      activity: [...(task.activity||[]), activityEntry("posted", me.name, "Posted")],
      updatedAt: serverTimestamp(),
    });

  // Duplicate = fresh copy at the start of the workflow, no produced artifacts.
  const duplicateTask = async (task) => {
    const { id, comments, reactions, activity, createdAt, updatedAt,
            caption, postLink, links, blockedOn, ...rest } = task;
    await addDoc(collection(db, "tasks"), {
      ...rest, title: `Copy of ${task.title}`, status: "Planned",
      caption: "", postLink: "", links: {}, blockedOn: "",
      comments: [], reactions: {}, activity: [activityEntry("created", me.name)],
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  };
  const importTasks = async (newTasks) =>
    Promise.all(newTasks.map((t) => addDoc(collection(db, "tasks"), {
      ...t, comments: [], reactions: {}, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    })));

  // Map a destination status → the activity-timeline event type.
  const eventType = (status) => ({
    "In Progress":"started", "In Review":"qa_sent", "Approved":"approved",
    "Changes Requested":"changes_requested", "Ready to Post":"ready", "Posted":"posted",
  }[status] || "status");
  // Admin manual status override (the status segmented control).
  const setStatus = async (task, status) =>
    updateDoc(doc(db, "tasks", task.id), {
      status, activity: [...(task.activity||[]), activityEntry(eventType(status), me.name, status)],
      updatedAt: serverTimestamp(),
    });
  // The guided workflow action (Start work / Submit for QA / Mark ready / Posted).
  // `extra` carries caption / postLink when the step requires them.
  const runWorkflow = async (task, action, extra = {}) =>
    updateDoc(doc(db, "tasks", task.id), {
      status: action.to, ...extra,
      activity: [...(task.activity||[]), activityEntry(action.kind, me.name, action.to)],
      updatedAt: serverTimestamp(),
    });
  // QA "request changes": send back as the first-class "Changes Requested" status.
  const qaRequestChanges = async (task, note) =>
    updateDoc(doc(db, "tasks", task.id), {
      status: "Changes Requested",
      activity: [...(task.activity||[]), activityEntry("changes_requested", me.name, note)],
      updatedAt: serverTimestamp(),
    });
  // Collaborative fields any approved member can set from a task's detail view.
  const setBlocked = async (id, blockedOn) =>
    updateDoc(doc(db, "tasks", id), { blockedOn, updatedAt: serverTimestamp() });
  const setLinks = async (task, links) =>
    updateDoc(doc(db, "tasks", task.id), { links, updatedAt: serverTimestamp() });
  const setCaption = async (task, caption) =>
    updateDoc(doc(db, "tasks", task.id), { caption, updatedAt: serverTimestamp() });
  const addComment = async (task, txt) =>
    updateDoc(doc(db, "tasks", task.id), {
      comments: [...(task.comments||[]), { who: me.name, txt, tm: Date.now() }],
      updatedAt: serverTimestamp(),
    });
  const toggleReact = async (task, emo) => {
    const r = { ...(task.reactions||{}) };
    const arr = new Set(r[emo] || []);
    arr.has(me.name) ? arr.delete(me.name) : arr.add(me.name);
    r[emo] = [...arr];
    await updateDoc(doc(db, "tasks", task.id), { reactions: r, updatedAt: serverTimestamp() });
  };
  const autoAll = async () => {
    const targets = tasks.filter(t => !(t.support && t.support.length) && t.status !== "Posted");
    await Promise.all(targets.map(t =>
      updateDoc(doc(db, "tasks", t.id), { support: autoAssign(t, users), updatedAt: serverTimestamp() })));
  };
  const autoOne = async (task) =>
    updateDoc(doc(db, "tasks", task.id), { support: autoAssign(task, users), updatedAt: serverTimestamp() });

  /* ---- user writes ---- */
  const saveUser = async (u) => {
    const { id, ...rest } = u;
    await updateDoc(doc(db, "users", id), rest);
    setEditUser(null);
  };
  const approveUser = async (u) => {
    await updateDoc(doc(db, "users", u.id), { ...u, status: "approved" });
    setEditUser(null);
  };
  const removeUser = async (id) => { await deleteDoc(doc(db, "users", id)); };
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
    await Promise.all(updates);
    await deleteDoc(doc(db, "users", user.id));
  };

  /* ---- bulk-assign imported "Pending" tasks to a newly-matched user ---- */
  const assignSuggested = async (user) => {
    const matches = pendingMatches(user, tasks);
    await Promise.all(matches.map((t) => {
      const u = applyAssignment(t, user);
      return updateDoc(doc(db, "tasks", t.id),
        { owner: u.owner, ownerSuggested: u.ownerSuggested || "", support: u.support, updatedAt: serverTimestamp() });
    }));
  };

  /* ---- issue log (admin triage) ---- */
  const resolveIssue = async (id, status) =>
    updateDoc(doc(db, "issues", id), { status });

  const openTask = tasks.find(t => t.id === openId);

  return (
    <div className="sb-root">
      <div className="sb-shell">
        <aside className="sb-side">
          <div className="sb-sbrand"><span className="sb-spark">✦</span>
            <span className="sb-brandtext"><span className="ifc">IFC</span>Creatives Board</span></div>
          <button className="sb-searchbtn" onClick={()=>setSearchOpen(true)} aria-label="Search">
            <span className="ico"><MagnifyingGlassIcon className="hi hi-sm" aria-hidden="true"/></span><span className="lbl">Search…</span><kbd className="sb-kbd">/</kbd>
          </button>
          <nav className="sb-snav" aria-label="Main">
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
          {isAdmin && <button className="sb-btn" style={{marginTop:14}} onClick={()=>setEditTask("new")} aria-label="New content">
            <PlusIcon className="hi hi-sm" aria-hidden="true"/><span className="lbl">New content</span></button>}
          <div className="sb-sfoot">
            <div className="sb-suser">
              <span className="sb-av" style={{width:34,height:34,fontSize:12}}>{initials(me.name)}</span>
              <span className="lbl"><div className="nm">{me.name}</div><div className="rl">{isAdmin?"Admin":"Member"} · {me.email}</div></span>
            </div>
            <ThemeToggle />
            <button className="sb-report" onClick={()=>setNotifOpen(true)} aria-label="Notifications">
              <BellIcon className="hi hi-sm" aria-hidden="true"/><span className="lbl"> Notifications</span>{notif.unread>0 && <span className="pill" style={{marginLeft:6}}>{notif.unread>9?"9+":notif.unread}</span>}
            </button>
            <button className="sb-report" onClick={()=>setShowReport(true)} aria-label="Report an issue"><ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true"/><span className="lbl"> Report an issue</span></button>
            <button className="sb-signout" onClick={()=>signOut(auth)} aria-label="Sign out"><ArrowRightStartOnRectangleIcon className="hi hi-sm" aria-hidden="true"/><span className="lbl"> Sign out</span></button>
            <div className="sb-brandfoot lbl"><b>IFC Creatives Board</b>Built for the IFC Creative Team.</div>
          </div>
        </aside>

        <div className="sb-main">
          <header className="sb-top">
            <span className="brand"><span className="sb-spark">✦</span>Creatives Board</span>
            <span style={{display:"flex",alignItems:"center",gap:10}}>
              <button className="sb-report-top" onClick={()=>setSearchOpen(true)} aria-label="Search"><MagnifyingGlassIcon className="hi" aria-hidden="true"/></button>
              <button className="sb-report-top sb-bellbtn" onClick={()=>setNotifOpen(true)} aria-label="Notifications">
                <BellIcon className="hi" aria-hidden="true"/>{notif.unread>0 && <span className="sb-belldot">{notif.unread>9?"9+":notif.unread}</span>}
              </button>
              <button className="sb-avbtn" onClick={()=>setShowDrawer(true)} aria-label="Profile and settings">
                <span className="sb-av" style={{width:30,height:30,fontSize:11}}>{initials(me.name)}</span>
              </button>
            </span>
          </header>

          <div className="sb-content">
            <BetaBanner onReport={()=>setShowReport(true)} />
            {tab==="home"  && <Home tasks={tasks} users={users} me={me} goTab={setTab} isAdmin={isAdmin} onNewForEvent={newForEvent} onViewEvent={viewEvent} openTask={setOpenId} />}
            {tab==="myday" && <MyDay tasks={tasks} me={me} openTask={setOpenId} goTab={setTab} />}
            {tab==="board" && <BoardList tasks={tasks} openTask={setOpenId} me={me} isAdmin={isAdmin} eventFilter={boardEvent} onClearEventFilter={()=>setBoardEvent(null)} />}
            {tab==="mine"  && <Mine tasks={tasks} me={me} openTask={setOpenId} />}
            {tab==="team"  && <Team tasks={tasks} users={users} />}
            {tab==="admin" && isAdmin && (
              <Admin users={allUsers} tasks={tasks} teamUsers={users} issues={issues}
                onEditUser={setEditUser} onEditTask={setEditTask}
                onDeleteUser={removeUser} onRemoveUser={removeUserWithTasks} onDeleteTask={deleteTask}
                onArchiveTask={archiveTask} onDuplicateTask={duplicateTask} onOpenTask={setOpenId}
                onAutoAll={autoAll} onAutoOne={autoOne} onImport={importTasks} onResolveIssue={resolveIssue}
                onAssignSuggested={assignSuggested} onNewForEvent={newForEvent} />
            )}
          </div>

          <nav className="sb-nav" aria-label="Main">
            {mainNav.map(n => (
              <button key={n.id} className={"sb-navbtn"+(tab===n.id?" on":"")} onClick={()=>setTab(n.id)} aria-current={tab===n.id?"page":undefined}>
                <span className="ico">{n.ico(tab===n.id)}</span>{n.label}
                {n.badge>0 && <span className="pill">{n.badge}</span>}
              </button>
            ))}
            <button className={"sb-navbtn"+(["team","admin"].includes(tab)?" on":"")} onClick={()=>setShowDrawer(true)} aria-label="Profile and more">
              <span className="ico"><span className="sb-av sb-navav">{initials(me.name)}</span></span>Profile
              {isAdmin && pendingCount>0 && <span className="pill">{pendingCount}</span>}
            </button>
          </nav>
        </div>
      </div>

      {isAdmin && tab!=="admin" && (
        <button className="sb-fab" onClick={()=>setEditTask("new")} aria-label="New content"><PlusIcon className="hi hi-nav" aria-hidden="true"/></button>
      )}

      {showDrawer && (
        <ProfileDrawer me={me} isAdmin={isAdmin} unread={notif.unread} pendingCount={pendingCount}
          onClose={()=>setShowDrawer(false)} onGoTab={setTab}
          onNotifications={()=>{ setShowDrawer(false); setNotifOpen(true); }}
          onReport={()=>{ setShowDrawer(false); setShowReport(true); }} />
      )}

      {notifOpen && (
        <NotifCenter notif={notif}
          onClose={()=>setNotifOpen(false)}
          onOpenTask={(id)=>{ setNotifOpen(false); setOpenId(id); }}
          onViewEvent={(occ)=>{ setNotifOpen(false); viewEvent(occ); }}
          onSettings={()=>{ setNotifOpen(false); setNotifSettingsOpen(true); }} />
      )}

      {notifSettingsOpen && (
        <NotifSettings me={me} isAdmin={isAdmin} onSave={saveNotifPrefs} onClose={()=>setNotifSettingsOpen(false)} />
      )}

      {toast && (
        <button className="sb-toast" onClick={()=>{ setToast(null); setNotifOpen(true); }}><BellIcon className="hi hi-sm" aria-hidden="true"/> {toast}</button>
      )}

      {searchOpen && (
        <GlobalSearch tasks={tasks} users={isAdmin ? allUsers : users}
          onClose={()=>setSearchOpen(false)}
          onOpenTask={(id)=>{ setSearchOpen(false); setOpenId(id); }}
          goTab={(t)=>{ setSearchOpen(false); setTab(t); }} />
      )}

      {openTask && (
        <TaskDetail key={openTask.id} task={openTask} me={me} isAdmin={isAdmin}
          isQA={isAdmin || !!me.qa}
          onClose={()=>setOpenId(null)}
          onStatus={(s)=>setStatus(openTask, s)}
          onAction={(action, extra)=>runWorkflow(openTask, action, extra)}
          onApprove={()=>setStatus(openTask, "Approved")}
          onLinks={(links)=>setLinks(openTask, links)}
          onCaption={(c)=>setCaption(openTask, c)}
          onRequestChanges={(note)=>qaRequestChanges(openTask, note)}
          onBlocked={(b)=>setBlocked(openTask.id, b)}
          onComment={(txt)=>addComment(openTask, txt)}
          onReact={(emo)=>toggleReact(openTask, emo)}
          onEdit={()=>{ setOpenId(null); setEditTask(openTask); }} />
      )}
      {editTask && (
        <TaskEditor task={editTask==="new"?null:editTask} prefill={editPrefill} users={users}
          defaultReminders={notifSettings?.defaultReminders}
          onClose={()=>{ setEditTask(null); setEditPrefill(null); }}
          onSave={(t)=>{ saveTask(t); setEditPrefill(null); }} onAuto={(t)=>autoAssign(t, users)} />
      )}
      {editUser && (
        <UserEditor user={editUser} onClose={()=>setEditUser(null)}
          onSave={saveUser} onApprove={approveUser} />
      )}
      {showReport && <ReportIssue onClose={()=>setShowReport(false)} />}
    </div>
  );
}

/* ===================================================================
   REPORT ISSUE  (any signed-in user can file a problem)
   =================================================================== */
function ReportIssue({ onClose }) {
  const [note, setNote] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | error
  const send = async () => {
    setState("sending");
    const ok = await reportIssue({ note: note.trim(), action: "manual report" });
    setState(ok ? "sent" : "error");
  };
  return (
    <div className="sb-scrim" onClick={onClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()}>
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>Report an issue</b>
          <button className="sb-x" onClick={onClose}><XMarkIcon className="hi" aria-hidden="true" /></button></div>
        <div className="bd">
          {state==="sent" ? (
            <div className="sb-empty"><div className="big">✓</div>
              Thanks. Your report was sent and we'll take a look.</div>
          ) : <>
            <div className="sb-sub" style={{marginTop:0}}>
              Tell us what went wrong or felt off. We'll automatically include your
              account, the screen you're on, and your device details.</div>
            <div className="sb-field"><label>What happened?</label>
              <textarea rows={5} value={note} onChange={e=>setNote(e.target.value)}
                placeholder="e.g. I tried to mark a reel Approved and nothing happened." /></div>
            {state==="error" && <div className="sb-lerr">Couldn't send that. Please try again.</div>}
            <button className="sb-btn compact" disabled={!note.trim() || state==="sending"} onClick={send}>
              {state==="sending" ? "Sending…" : "Send report"}</button>
          </>}
        </div>
      </div>
    </div>
  );
}

/* ===================================================================
   HOME (personal)
   =================================================================== */
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

  const stats = [
    { n:myOverdue.length, lbl:"Overdue",   dot:"dot-red" },
    { n:myDueSoon.length, lbl:"Due soon",  dot:"dot-amber" },
    { n:myMaking.length,  lbl:"Active",    dot:"dot-blue" },
    { n:myReview.length,  lbl:"In review", dot:"dot-green" },
  ];

  // Whole-team pulse, shown smaller at the bottom.
  const active = tasks.filter(t => t.status!=="Posted");
  const pulse = [
    { n:active.filter(t=>t.status==="In Review").length, lbl:"Needs approval", dot:"dot-amber" },
    { n:tasks.filter(t=>t.status==="Approved").length,   lbl:"Ready to post",  dot:"dot-green" },
    { n:active.filter(t=>{const d=daysTo(t.postDate);return d!==null&&d>=0&&d<=2;}).length, lbl:"Due soon", dot:"dot-blue" },
    { n:active.filter(t=>{const d=daysTo(t.postDate);return d!==null&&d<0;}).length, lbl:"Overdue", dot:"dot-red" },
  ];

  return (
    <div className="sb-page">
      <div className="sb-eyebrow">What's on your plate</div>
      <div className="sb-h">My Day</div>
      <div className="sb-sub">{focusMsg}</div>

      {/* QA reviewer dashboard — "what needs my approval today?" */}
      {me.qa && <>
        <div className="sb-div"><span>For your review</span></div>
        <QueueSection title="Awaiting your approval" items={qq.awaiting} me={me} openTask={openTask} />
        <QueueSection title="Returned for changes" items={qq.returned} me={me} openTask={openTask} />
        <QueueSection title="Recently approved" items={qq.approved} me={me} openTask={openTask} />
        {qq.awaiting.length===0 && qq.returned.length===0 &&
          <div className="sb-empty"><div className="big">✓</div>No content is waiting on your review.</div>}
      </>}

      {/* Caption / upload dashboard — "what's approved and needs posting?" */}
      {me.captions && <>
        <div className="sb-div"><span>Captions &amp; posting</span></div>
        <QueueSection title="Approved: needs captions" items={pq.captions} me={me} openTask={openTask} />
        <QueueSection title="Ready to post" items={pq.ready} me={me} openTask={openTask} />
        <QueueSection title="Overdue posts" items={pq.overdue} me={me} openTask={openTask} />
        {pq.captions.length===0 && pq.ready.length===0 && pq.overdue.length===0 &&
          <div className="sb-empty"><div className="big">✓</div>Nothing approved is waiting to be posted.</div>}
      </>}

      {(me.qa || me.captions) && <div className="sb-div"><span>Your own tasks</span></div>}

      {/* Personal numbers as one compact strip (was four chunky tiles). */}
      <div className="sb-strip">
        {stats.map(s => (
          <div className="sb-stat" key={s.lbl}>
            <span className={"num "+s.dot}>{s.n}</span><span className="lbl">{s.lbl}</span>
          </div>
        ))}
      </div>

      <div className="sb-shead sb-shead-strong"><h2>Needs your attention</h2>
        <button className="link subtle" onClick={()=>goTab("mine")}>All my work →</button></div>
      {attention.length===0
        ? <div className="sb-empty"><div className="big">✓</div>Nothing urgent. Enjoy the breather.</div>
        : <div className="sb-attnlist">{attention.map(t =>
            <AttentionItem key={t.id} t={t} onClick={()=>openTask(t.id)} />)}</div>}

      <div className="sb-div"><span>Team pulse</span></div>
      <div className="sb-strip" style={{marginTop:12}}>
        {pulse.map(p => (
          <button className="sb-stat" key={p.lbl} onClick={()=>goTab("board")}>
            <span className={"num "+p.dot}>{p.n}</span><span className="lbl">{p.lbl}</span>
          </button>
        ))}
      </div>
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
                <span className="r-icon">{e.kind==="birthday"?<CakeIcon className="hi" aria-hidden="true"/>:<CalendarDaysIcon className="hi" aria-hidden="true"/>}</span>
                <span className="r-main">{e.name}</span>
                <span className="r-sub">{e.daysAway===0?"Today":`in ${e.daysAway} day${e.daysAway!==1?"s":""}`}</span>
              </button>
            ))}
          </>}
        </div>
      </div>
    </div>
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
      <div className="sb-eyebrow">Everything in motion</div>
      <div className="sb-h">The board</div>
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
              <section className="sb-group" key={g.status}>
                <button className="sb-grouphd" onClick={()=>toggle(g.status)} aria-expanded={!isCollapsed}>
                  <span className={"sb-chev"+(isCollapsed?"":" open")}><ChevronRightIcon className="hi hi-sm" aria-hidden="true" /></span>
                  <span className={"sb-status "+statusClass(g.status)}><span className="pip"/>{g.status}</span>
                  {archive && <span className="sb-archtag">Archive</span>}
                  <span className="sb-groupct">{g.items.length}</span>
                </button>
                {!isCollapsed && (view==="list"
                  ? <div className="sb-listrows">
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
      <div className="sb-eyebrow">What needs you next</div>
      <div className="sb-h">My work</div>
      <div className="sb-sub">
        {total===0 ? "You're all clear. Nothing assigned to you right now."
          : `${total} thing${total!==1?"s":""} with your name on ${total!==1?"them":"it"}, most urgent first.`}
      </div>

      {total===0 && <div className="sb-empty"><div className="big">✓</div>No assignments yet. Your creative work will appear here.</div>}

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
function Team({ tasks, users }) {
  const cap = useMemo(()=>computeCapacity(tasks,users),[tasks,users]);
  const total = Object.values(cap).reduce((s,c)=>s+c.total,0) || 1;
  const max = Math.max(1, ...Object.values(cap).map(c=>c.total));
  const rows = users.map(u=>({u,c:cap[u.name]||{shoot:0,edit:0,coordinate:0,design:0,shadow:0,total:0}}))
    .sort((a,b)=>b.c.total-a.c.total);
  const avg = total/(users.length||1);
  const legend = [["seg-shoot","Shooting"],["seg-edit","Editing"],["seg-coordinate","Getting People"],["seg-design","Design"],["seg-shadow","Shadowing"]];

  return (
    <div className="sb-page">
      <div className="sb-eyebrow">Who's carrying what</div>
      <div className="sb-h">Team load</div>
      <div className="sb-sub">Active tasks per person (posted work excluded). Spot overload at a glance.</div>
      <div className="sb-caplegend" style={{marginBottom:16}}>
        {legend.map(([cls,lbl])=>(<span key={cls}><i className={cls}></i>{lbl}</span>))}
      </div>
      <div className="sb-caplist">
        {rows.map(({u,c}) => {
          const pct = ((c.total/total)*100).toFixed(0);
          const over = c.total>0 && c.total>=avg*1.8 && c.total>=3;
          const idle = c.total===0;
          return (
            <div className="sb-cap" key={u.id}>
              <div className="top">
                <span className="name">
                  <span className="sb-av">{initials(u.name)}</span>{u.name}
                  {over && <span className="sb-overload">OVERLOADED</span>}
                  {idle && <span className="sb-idle">free</span>}
                </span>
                <span className="pct">{c.total} · {pct}%</span>
              </div>
              <div className="sb-capbar">
                {["shoot","edit","coordinate","design","shadow"].map(r =>
                  c[r]>0 && <i key={r} className={"seg-"+r} style={{width:`${(c[r]/max)*100}%`}}/>)}
              </div>
            </div>
          );
        })}
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

/* The HOME landing page — a ministry / celebration dashboard, not a task list.
   It answers: what have we accomplished, what's coming up, what should I
   celebrate, what should I be aware of? Operational work lives in My Day. */
function Home({ tasks, users, me, goTab, isAdmin, onNewForEvent, onViewEvent, openTask }) {
  const pw = personalWins(tasks, me);
  const m = dashboardMetrics(tasks, users);
  const thisM = monthlyWins(tasks, 0);
  const events = upcomingEvents(4);
  const recents = recentWins(tasks, 4);
  const readyToPost = tasks.filter(t=>t.status==="Approved").length;
  const prepCount = events.filter(e=>e.prepNow).length;
  // "Your focus": only what needs the signed-in user, capped so Home stays calm.
  const focus = attentionItems(tasks, me).slice(0, 4);
  // Compact team progress: completed vs everything currently on the board.
  const doneCount = tasks.filter(t=>t.status==="Posted").length;
  const totalCount = tasks.length;
  const donePct = totalCount ? Math.round((doneCount/totalCount)*100) : 0;

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
    <div className="sb-page">
      <div className="sb-eyebrow">{greet}</div>
      <div className="sb-h">Welcome back, {me.name.split(" ")[0]} 👋</div>
      <div className="sb-sub sb-greet">
        <span>{s1}</span>
        <span>{s2}</span>
      </div>

      {/* Coming up — what's on the ministry horizon */}
      {events.length>0 && <>
        <div className="sb-shead"><h2>Coming up</h2>
          <button className="link" onClick={()=>goTab("board")}>Plan content →</button></div>
        <div className="sb-evlist">
          {events.slice(0,3).map((e,i) => {
            const n = occurrenceContentCount(e, tasks);
            return (
            <div className="sb-ev" key={e.eventOccurrenceId||i}>
              <span className="sb-ev-ic">{e.kind==="birthday"?<CakeIcon className="hi" aria-hidden="true"/>:<CalendarDaysIcon className="hi" aria-hidden="true"/>}</span>
              <div style={{flex:1,minWidth:0}}>
                <div className="sb-ev-name">{e.name}</div>
                <div className="sb-ev-sub">
                  {fmtEventDate(e.date)} · {e.daysAway===0?"today":`${e.daysAway} day${e.daysAway!==1?"s":""} away`}
                  {n>0
                    ? ` · ${n} content piece${n!==1?"s":""} planned`
                    : <span className="sb-ev-warn"> · Content has not been planned yet</span>}
                </div>
              </div>
              {n===0
                ? (isAdmin && onNewForEvent &&
                    <button className="sb-btn ghost compact" onClick={()=>onNewForEvent(eventPrefill(e))}>Create content</button>)
                : (onViewEvent &&
                    <button className="sb-btn ghost compact" onClick={()=>onViewEvent(e)}>View content →</button>)}
            </div>
            );
          })}
        </div>
      </>}

      {/* Your focus — only what needs YOU; the full list lives in My Day */}
      <div className="sb-shead"><h2>Your focus</h2>
        <button className="link subtle" onClick={()=>goTab("myday")}>My Day →</button></div>
      {focus.length===0
        ? <div className="sb-empty compact">Nothing needs you right now. Enjoy the calm.</div>
        : <div className="sb-attnlist">{focus.map(t =>
            <AttentionItem key={t.id} t={t} onClick={()=>openTask ? openTask(t.id) : goTab("myday")} />)}</div>}

      {/* Team progress — one compact summary instead of metric walls */}
      <div className="sb-shead"><h2>Team progress</h2></div>
      <div className="sb-progress">
        <div className="row">
          <b>{doneCount} of {totalCount} content pieces completed</b>
          <span className="pct">{donePct}%</span>
        </div>
        <div className="bar" role="progressbar" aria-valuenow={donePct} aria-valuemin={0} aria-valuemax={100}
          aria-label="Team content completion"><span style={{width:`${donePct}%`}}/></div>
        <div className="chips">
          <button onClick={()=>goTab("board")}>{m.awaiting} awaiting review</button>
          <button onClick={()=>goTab("board")}>{readyToPost} ready to post</button>
          {m.overdue>0 && <button className="warn" onClick={()=>goTab("myday")}>{m.overdue} overdue</button>}
        </div>
      </div>

      {/* Wins — this month + yours, kept encouraging and compact */}
      <div className="sb-shead"><h2>Ministry wins</h2></div>
      <div className="sb-wincards">
        <WinCard n={thisM.posted} label="Posted this month" />
        <WinCard n={pw.completed} label="You completed" />
        <WinCard n={pw.contributions} label="Your contributions" />
      </div>

      {/* Recent wins */}
      <div className="sb-shead"><h2>Recent wins</h2></div>
      {recents.length===0
        ? <div className="sb-empty">Nothing posted yet. Your first win is coming!</div>
        : <div className="sb-recent">{recents.map((r,i)=>(<div className="sb-recent-row" key={i}><CheckCircleIcon className="hi hi-sm" aria-hidden="true" style={{color:"var(--success)",verticalAlign:"-4px",marginRight:6}}/>{r.text}</div>))}</div>}
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

/* Shared kebab actions for an admin content card. */
const adminKebab = (t, h) => [
  { label:"Open", onClick:()=>h.open(t.id) },
  { label:"Edit", onClick:()=>h.edit(t) },
  { label:"Duplicate", onClick:()=>h.duplicate(t) },
  ...(t.status!=="Posted" ? [{ label:"Archive", onClick:()=>h.archive(t) }] : []),
  { label:"Delete", danger:true, onClick:()=>{ if(confirm(`Delete "${t.title}"?`)) h.del(t.id); } },
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

function Admin({ users, tasks, teamUsers, issues, onEditUser, onEditTask, onDeleteUser, onRemoveUser, onDeleteTask, onArchiveTask, onDuplicateTask, onOpenTask, onAutoAll, onAutoOne, onImport, onResolveIssue, onAssignSuggested, onNewForEvent }) {
  const [sec, setSec] = useState("overview");
  const [contentFilter, setContentFilter] = useState("all");
  const pending = users.filter(u => u.status === "pending");
  const openIssues = (issues || []).filter(i => i.status !== "resolved").length;

  // Card action handlers, bundled once and threaded through the panels.
  const h = { open:onOpenTask, edit:onEditTask, archive:onArchiveTask,
              duplicate:onDuplicateTask, del:onDeleteTask, auto:onAutoOne };
  const goContent = (filter="all") => { setContentFilter(filter); setSec("content"); };

  const tabs = [
    ["overview", "Overview"],
    ["people",   pending.length>0 ? `People · ${pending.length}` : "People"],
    ["content",  "Content"],
    ["import",   "Import"],
    ["issues",   openIssues>0 ? `Issues · ${openIssues}` : "Issues"],
  ];

  return (
    <div className="sb-page">
      <div className="sb-eyebrow">Control room</div>
      <div className="sb-h">Admin</div>
      <div className="sb-sub">What needs leadership attention.</div>
      <div className="sb-seg" style={{marginBottom:14}}>
        {tabs.map(([id,label]) => (
          <button key={id} className={"sb-segbtn"+(sec===id?" on":"")} onClick={()=>setSec(id)}>{label}</button>
        ))}
      </div>

      {sec==="overview" && <AdminOverview tasks={tasks} users={users} h={h}
        onGoContent={goContent} onGoPeople={()=>setSec("people")} onGoImport={()=>setSec("import")}
        onNewContent={()=>onEditTask("new")} onAutoAll={onAutoAll} onNewForEvent={onNewForEvent}
        onEditUser={onEditUser} onDeleteUser={onDeleteUser} onAssignSuggested={onAssignSuggested} />}

      {sec==="people" && <AdminPeople users={users} tasks={tasks}
        onEditUser={onEditUser} onDeleteUser={onDeleteUser} onRemoveUser={onRemoveUser}
        onAssignSuggested={onAssignSuggested} />}

      {sec==="content" && <AdminContent tasks={tasks} h={h}
        filter={contentFilter} setFilter={setContentFilter}
        onNewContent={()=>onEditTask("new")} onAutoAll={onAutoAll} />}

      {sec==="import" && <ImportPanel users={teamUsers} onImport={onImport} />}
      {sec==="issues" && <IssueLog issues={issues} onResolve={onResolveIssue} />}
    </div>
  );
}

/* Overview = the admin landing page: health at a glance, then only the things
   that need a leader — stuck work, approvals, unassigned content — plus recent
   activity and quick actions. No endless content list. */
function AdminOverview({ tasks, users, h, onGoContent, onGoPeople, onGoImport, onNewContent, onAutoAll, onEditUser, onDeleteUser, onAssignSuggested, onNewForEvent }) {
  const health = adminHealth(tasks, users);
  const attention = adminNeedsAttention(tasks);
  const pending = users.filter(u => u.status === "pending");
  const ready = adminReadyToMove(tasks);
  const activity = recentActivity(tasks, 8);
  const events = upcomingEvents(3);
  const [eventNote, setEventNote] = useState(false);

  // Does any active task reference this event? Loose token match on relatedEvent.
  const eventCount = (e) => occurrenceContentCount(e, tasks);
  const ago = (ms) => {
    const m = Math.round((Date.now()-ms)/60000);
    if (m<1) return "just now"; if (m<60) return `${m}m ago`;
    const hrs = Math.round(m/60); if (hrs<24) return `${hrs}h ago`;
    return `${Math.round(hrs/24)}d ago`;
  };

  // Severity-coded so a leader can scan instantly: red = broken, amber =
  // slipping, gold = waiting on QA, green = good to go, violet = people.
  const cards = [
    { k:"blocked", n:health.blocked,      label:"Blocked",           tone:"red",    go:()=>onGoContent("blocked") },
    { k:"overdue", n:health.overdue,      label:"Overdue",           tone:"amber",  go:()=>onGoContent("overdue") },
    { k:"qa",      n:health.awaitingQA,   label:"Awaiting QA",       tone:"gold",   go:()=>onGoContent("qa") },
    { k:"ready",   n:health.ready,        label:"Ready to post",     tone:"green",  go:()=>onGoContent("ready") },
    { k:"pending", n:health.pendingUsers, label:"Awaiting approval", tone:"violet", go:onGoPeople },
    { k:"unassig", n:health.unassigned,   label:"Unassigned",        tone:"blue",   go:()=>onGoContent("needowner") },
  ];

  return (
    <>
      {/* Quick actions first — the things a leader comes here to DO */}
      <div className="sb-btnrow sb-quickrow">
        <button className="sb-btn" onClick={onNewContent}>+ New content</button>
        <button className="sb-btn ghost" onClick={onGoImport}><ArrowUpTrayIcon className="hi hi-sm" aria-hidden="true"/> Import CSV</button>
        <button className="sb-btn ghost" onClick={()=>setEventNote(v=>!v)}><PlusIcon className="hi hi-sm" aria-hidden="true"/> Create event</button>
        <button className="sb-btn gold" onClick={onAutoAll}><BoltIcon className="hi hi-sm" aria-hidden="true"/> Auto-assign crew</button>
      </div>
      {eventNote && <div className="sb-assign" style={{marginTop:10}}>
        Event management is coming soon. Pastor birthdays &amp; key dates already power the reminders on Home.</div>}

      {/* Health overview */}
      <div className="sb-health" style={{marginTop:18}}>
        {cards.map(c => (
          <button key={c.k} className={"sb-hcard tone-"+c.tone} onClick={c.go}>
            <span className="n">{c.n}</span><span className="l">{c.label}</span>
          </button>
        ))}
      </div>

      {/* Decision #1: people waiting to be let in */}
      {pending.length>0 && <>
        <div className="sb-shead sb-shead-strong"><h2>Waiting for approval</h2><span className="sb-tag">{pending.length}</span></div>
        <div className="sb-prowlist">
          {pending.map(u => (
            <PendingRow key={u.id} u={u} tasks={tasks}
              onReview={()=>onEditUser(u)} onReject={onDeleteUser} onAssignSuggested={onAssignSuggested} />
          ))}
        </div>
      </>}

      {/* Only problematic items — overdue, blocked, missing owner/crew */}
      <div className="sb-shead sb-shead-strong"><h2>Needs attention</h2><span className="sb-tag">{attention.length}</span></div>
      {attention.length===0
        ? <div className="sb-empty"><div className="big">✓</div>Nothing currently needs leadership attention.</div>
        : <div className="sb-list">{attention.slice(0,6).map(t => <AdminTaskCard key={t.id} t={t} h={h} />)}</div>}
      {attention.length>6 && <button className="sb-morelink" onClick={()=>onGoContent("overdue")}>See everything that's stuck in Content →</button>}

      {/* Healthy work that can advance with a nudge */}
      {ready.length>0 && <>
        <div className="sb-shead"><h2>Ready to move</h2><span className="sb-tag">{ready.length}</span></div>
        <div className="sb-list">{ready.slice(0,5).map(t => <AdminTaskCard key={t.id} t={t} h={h} />)}</div>
        {ready.length>5 && <button className="sb-morelink" onClick={()=>onGoContent("ready")}>See all ready to move →</button>}
      </>}

      {/* Upcoming events with a "no content yet" flag */}
      {events.length>0 && <>
        <div className="sb-shead"><h2>Upcoming</h2></div>
        <div className="sb-evlist">
          {events.map((e,i) => {
            const n = eventCount(e);
            return (
              <div className="sb-ev" key={i}>
                <span className="sb-ev-ic">{e.kind==="birthday"?<CakeIcon className="hi" aria-hidden="true"/>:<CalendarDaysIcon className="hi" aria-hidden="true"/>}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div className="sb-ev-name">{e.name}</div>
                  <div className="sb-ev-sub">
                    {fmtEventDate(e.date)} · {e.daysAway===0?"today":`${e.daysAway} day${e.daysAway!==1?"s":""} away`}
                    {n>0
                      ? <> · {n} content item{n!==1?"s":""} planned</>
                      : <span className="sb-ev-warn"> · ⚠ no content assigned</span>}
                  </div>
                </div>
                {n===0 && onNewForEvent &&
                  <button className="sb-btn ghost compact" onClick={()=>onNewForEvent(eventPrefill(e))}>Create content</button>}
              </div>
            );
          })}
        </div>
      </>}

      {/* Recent activity feed — who did what across the team */}
      {activity.length>0 && <>
        <div className="sb-shead"><h2>Activity</h2></div>
        <div className="sb-actfeed">
          {activity.map((a,i) => (
            <button className="sb-actrow" key={i} onClick={()=>h.open(a.taskId)}>
              <span className="sb-act-dot"/>
              <span className="sb-act-txt"><b>{a.who}</b> {a.verb} “{a.title}”</span>
              <span className="sb-act-ago">{ago(a.at)}</span>
            </button>
          ))}
        </div>
      </>}
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
        <button className="sb-btn" onClick={onNewContent}>+ New content</button>
        <button className="sb-btn gold" onClick={onAutoAll}><BoltIcon className="hi hi-sm" aria-hidden="true"/> Auto-assign empty</button>
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
        { label:"Reject", danger:true, onClick:()=>{ if(confirm(`Reject ${u.name}? Their account will be removed.`)) onReject(u.id); } },
      ]} />
    </div>
  );
}

/* A team member card — identity, campus, department, permissions, and a live
   active-task count. Edit is primary; Remove lives in the kebab (safer). */
function PersonCard({ u, tasks, onEdit, onRemove }) {
  const chips = roleChips(u);
  const active = userActiveTasks(u, tasks);
  const campus = (u.location||[]).join(" · ") || "No campus";
  const dept = u.department || "No department";
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
        <span className="sb-activecount">{active} active task{active!==1?"s":""}</span>
      </div>
    </div>
  );
}

/* People = approvals + team management: search, filters, grouped roster. */
function AdminPeople({ users, tasks, onEditUser, onDeleteUser, onRemoveUser, onAssignSuggested }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [removing, setRemoving] = useState(null);   // user pending removal
  const searching = q.trim().length > 0;

  const pending = users.filter(u => u.status === "pending");
  const allApproved = users.filter(u => u.status === "approved" || u.role === "admin");
  let team = searching ? searchPeople(allApproved, q) : applyPeopleFilter(allApproved, filter);
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

      <div className="sb-sub" style={{margin:"8px 0 6px"}}>
        {teamTotal} team member{teamTotal!==1?"s":""}{searching?` matching “${q.trim()}”`:filter!=="all"?` · ${activeLabel}`:""}
      </div>

      {teamTotal===0
        ? <div className="sb-empty"><div className="big">👥</div>No one matches.</div>
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
        {[["all","All"],["report","Reports"],["error","Errors"]].map(([k,l])=>(
          <button key={k} className={"sb-segbtn"+(kind===k?" on":"")} onClick={()=>setKind(k)}>{l}</button>))}
      </div>
      <div className="sb-seg" style={{marginBottom:14}}>
        {[["open","Open"],["resolved","Resolved"],["all","All"]].map(([k,l])=>(
          <button key={k} className={"sb-segbtn"+(show===k?" on":"")} onClick={()=>setShow(k)}>{l}</button>))}
      </div>

      {list.length===0
        ? <div className="sb-empty"><div className="big">✓</div>Nothing here. No {show==="open"?"open ":""}issues.</div>
        : <div className="sb-list" style={{gridTemplateColumns:"1fr"}}>
            {list.map(i => {
              const expanded = openId===i.id;
              const isErr = i.kind==="error";
              return (
                <div className="sb-task" key={i.id} style={{cursor:"default"}}>
                  <div className="row1">
                    <span className="title" style={{fontSize:14}}>{i.note || i.message || "(no detail)"}</span>
                    <span className="sb-rowtags">
                      <span className={"sb-chip "+(isErr?"chip-poster":"chip-reel")}>{isErr?"Error":"Report"}</span>
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
        <input type="file" accept=".csv,text/csv" onChange={onFile} /></div>

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
                ? <div className="sub"><span style={{color:"var(--red,#c0392b)"}}>{r.error}</span></div>
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
  return (
    <button className="sb-task" onClick={onClick}>
      <div className="row1">
        <span className="title">{t.title}</span>
        <span className="sb-rowtags">
          {t.priority==="High" && <span className={"sb-pri "+priorityClass(t.priority)}>▲</span>}
          <span className={"sb-chip "+typeClass(t.type)}>{t.type}</span>
        </span>
      </div>

      {/* Status is dominant; due date pops; "Next" + blocker are supporting text. */}
      <div className="sb-cardstatus">
        <span className={"sb-status "+statusClass(t.status)}><span className="pip"/>{t.status}</span>
        {!isPosted && <span className={"sb-due "+dueCls}>🕒 {dueTxt}</span>}
      </div>
      {/* Fixed order: blocking issue → up next → supporting/owner → avatars. */}
      {t.blockedOn && <div className="sb-next blocked"><span className="sb-next-lbl">Blocked</span>Waiting on {t.blockedOn}</div>}
      {!isPosted && <div className="sb-next"><span className="sb-next-lbl">Up next</span>{nextStep(t.status)}</div>}
      {supporting && <div className="sb-support">Supporting {t.owner.split(" ")[0]}</div>}

      <div className="sb-ppl">
        {uniquePeople.slice(0,5).map((p,i)=>(
          <span key={i} className={"sb-av"+(p.owner?" owner":"")}
            style={me&&p.name===me.name?{outline:"2px solid var(--violet)"}:{}}>{initials(p.name)}</span>
        ))}
        {(t.comments?.length>0) && <span style={{fontSize:11,color:"var(--muted)",marginLeft:"auto"}}>{Ic.chat} {t.comments.length}</span>}
      </div>
    </button>
  );
}

/* ===================================================================
   TASK DETAIL
   =================================================================== */
function TaskDetail({ task, me, isAdmin, isQA, onClose, onStatus, onAction, onApprove, onLinks, onCaption, onRequestChanges, onBlocked, onComment, onReact, onEdit }) {
  const [draft, setDraft] = useState("");
  // Local drafts; persisted on blur. Component is keyed by task id, so these
  // reset when a new task opens.
  const [blocked, setBlocked] = useState(task.blockedOn || "");
  const [links, setLinksDraft] = useState(task.links || {});
  const [caption, setCaptionDraft] = useState(task.caption || "");
  const [postLink, setPostLink] = useState(task.postLink || "");
  const [changeNote, setChangeNote] = useState("");
  const [askChanges, setAskChanges] = useState(false);
  const [warn, setWarn] = useState("");
  const EMOJIS = ["👍","🔥","🙏","👀"];
  const isLink = task.link && task.link.startsWith("http");
  const phase = statusPhase(task.status);
  const action = workflowAction(task, me);                 // the single guided step for this user
  const required = requiredLinkKeys(task.type);
  // Only the type's required links (plus any already filled) — keeps it focused.
  const linkKeys = Object.keys(LINK_FIELDS).filter(k => required.includes(k) || (links[k]||"").trim());
  const captionStage = ["Approved","Ready to Post","Posted"].includes(task.status);
  const postStage = ["Ready to Post","Posted"].includes(task.status);
  const canCaption = (!!me.captions || isAdmin) && task.status !== "Posted";
  const lastFeedback = [...(task.activity||[])].reverse().find(e => e.type==="changes_requested")?.note;
  const saveLinks = (next) => { setLinksDraft(next); onLinks(next); };
  const tm = (t) => typeof t === "number" ? new Date(t).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) : t;

  // Run the guided action, enforcing its preconditions (same gates as the rules).
  const doAction = () => {
    if (!action) return;
    if (action.requiresLinks) {
      const miss = missingLinks({ ...task, links });
      if (miss.length) { setWarn(`Add the required content link${miss.length>1?"s":""} first: ${miss.map(k=>LINK_FIELDS[k]).join(", ")}.`); return; }
    }
    if (action.needsCaption && !caption.trim()) { setWarn("Write the caption first."); return; }
    if (action.needsPostLink && !postLink.trim()) { setWarn("Add the final post link first."); return; }
    setWarn("");
    const extra = {};
    if (action.needsCaption) extra.caption = caption.trim();
    if (action.needsPostLink) extra.postLink = postLink.trim();
    onAction(action, extra);
  };

  return (
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
              <div className="sb-brief-h">Creative brief</div>
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
                <button className="sb-btn danger compact" onClick={()=>setAskChanges(v=>!v)}>Request changes</button>
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
                  <div className="sb-inline">
                    <input value={val} placeholder="Paste a Google Drive link…"
                      onChange={e=>setLinksDraft({...links, [k]: e.target.value})}
                      onBlur={()=>saveLinks({ ...links, [k]: (links[k]||"").trim() })} />
                    {val.startsWith("http") &&
                      <a className="sb-btn ghost compact" style={{textDecoration:"none",display:"flex",alignItems:"center"}}
                        href={val} target="_blank" rel="noreferrer noopener">Open</a>}
                  </div>
                </div>
              );
            })}
          </>}

          {/* Caption — written by the caption/upload team once approved. */}
          {captionStage && (
            <div className="sb-field"><label>Caption</label>
              <textarea rows={3} value={caption} disabled={!canCaption}
                onChange={e=>setCaptionDraft(e.target.value)} onBlur={()=>onCaption(caption.trim())}
                placeholder="Write the Instagram caption…" />
            </div>
          )}

          {/* Final post link — captured when marking as posted. */}
          {postStage && (
            <div className="sb-field"><label>Final post link</label>
              <div className="sb-inline">
                <input value={postLink} disabled={task.status==="Posted"}
                  onChange={e=>setPostLink(e.target.value)} placeholder="Instagram / TikTok post URL…" />
                {postLink.startsWith("http") &&
                  <a className="sb-btn ghost compact" style={{textDecoration:"none",display:"flex",alignItems:"center"}}
                    href={postLink} target="_blank" rel="noreferrer noopener">Open</a>}
              </div>
            </div>
          )}

          {/* Waiting on (blocker) — editable while the task is live. */}
          {task.status!=="Posted" && (
            <div className="sb-field"><label>Waiting on (leave blank if not blocked)</label>
              <input value={blocked} onChange={e=>setBlocked(e.target.value)}
                onBlur={()=>onBlocked(blocked.trim())}
                placeholder="e.g. Pastor's approval, David's graphics" />
            </div>
          )}

          <div className="sb-cap" style={{marginTop:6}}>
            <Detail k="Owner (lead)" v={task.owner==="Pending" ? (task.ownerSuggested ? `Pending: ${task.ownerSuggested} (from import)` : "Pending") : task.owner} />
            <Detail k="Priority" v={task.priority || "Medium"} />
            <Detail k="Shoot date" v={fmt(task.shootDate)} />
            <Detail k="Post date" v={fmt(task.postDate)} />
            {task.notes && <Detail k="Notes" v={task.notes} />}
            {task.link && <Detail k="Reference" v={isLink ? <a className="sb-link" href={task.link} target="_blank" rel="noreferrer noopener">{task.link}</a> : task.link} />}
          </div>

          <div className="sb-shead" style={{marginTop:18}}><h2>Crew</h2></div>
          {(task.support||[]).length===0
            ? <div className="sb-empty" style={{padding:16}}>No support crew yet.</div>
            : (task.support||[]).map((s,i)=>{
              const pending = s.name==="Pending";
              return (
              <div className="sb-cmt" key={i} style={{display:"flex",alignItems:"center",gap:10}}>
                <span className="sb-av">{pending ? "?" : initials(s.name)}</span>
                {pending
                  ? <span><b>{pendingCrewLabel(s)}</b>{s.suggested && <span style={{color:"var(--muted)"}}> · suggested: {s.suggested}</span>}</span>
                  : <span><b>{s.name}</b> · <span style={{color:"var(--muted)"}}>{crewRoleLabel(s)}{s.loc?` · ${s.loc}`:""}</span></span>}
              </div>
              );
            })}

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

          {/* Admin override — jump the workflow to any status if needed. */}
          {isAdmin && <>
            <div className="sb-field" style={{marginTop:18}}><label>Admin · set status</label>
              <div className="sb-seg" style={{flexWrap:"wrap"}}>
                {STAGES.map(s=>(
                  <button key={s} className={"sb-segbtn"+(task.status===s?" on":"")} onClick={()=>onStatus(s)}>{s}</button>))}
              </div>
            </div>
            <button className="sb-btn ghost" style={{marginTop:9}} onClick={onEdit}>Edit content details</button>
          </>}
        </div>
      </div>
    </div>
  );
}
function Detail({ k, v }) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",gap:14,padding:"7px 0",borderBottom:"1px solid var(--line)"}}>
      <span style={{fontSize:12.5,color:"var(--muted)",fontWeight:600,flex:"none"}}>{k}</span>
      <span style={{fontSize:13.5,textAlign:"right"}}>{v}</span>
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
      <button type="button" className="sb-btn ghost compact" onClick={onCustomize}>
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
                    {expanded && (
                      <div className="tl-adv">
                        <div className="tl-time">
                          <input type="number" min="0" max="60" value={r.offset} aria-label="Days"
                            onChange={e=>upd(r.id,{offset:Math.max(0,Math.min(60,Number(e.target.value)||0))})}/>
                          <span>day{r.offset===1?"":"s"}</span>
                          <select value={r.when} aria-label="Before or after due date"
                            onChange={e=>upd(r.id,{when:e.target.value})}>
                            <option value="before">before due</option><option value="after">after due</option>
                          </select>
                        </div>
                        <div className="tl-lbl">Delivery options</div>
                        <div className="chips">
                          {REMINDER_CHANNELS.map(c => <button type="button" key={c}
                            className={"sb-rchip"+((r.channels||[]).includes(c)?" on":"")}
                            aria-pressed={(r.channels||[]).includes(c)}
                            onClick={()=>toggleArr(r.id,"channels",c)}>{CH_LABEL[c]||c}</button>)}
                        </div>
                        <div className="chips">
                          {REMINDER_RECIPIENTS.map(c => <button type="button" key={c}
                            className={"sb-rchip"+((r.recipients||[]).includes(c)?" on":"")}
                            aria-pressed={(r.recipients||[]).includes(c)}
                            onClick={()=>toggleArr(r.id,"recipients",c)}>{RCP_LABEL[c]||c}</button>)}
                        </div>
                        <button type="button" className="link danger" onClick={()=>{ onChange(rem.filter(x=>x.id!==r.id)); setOpenId(null); }}>
                          Remove this reminder</button>
                      </div>
                    )}
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
  );
}

function TaskEditor({ task, prefill, users, defaultReminders, onClose, onSave, onAuto }) {
  const [f, setF] = useState(() => {
    const base = task ? { ...task } : {
      title:"", type:"Reel", location:"828", owner:users[0]?.name||"", ownerSuggested:"",
      shootDate:"", postDate:"", status:"Planned", priority:"Medium",
      blockedOn:"", brief:"", relatedEvent:"", link:"", notes:"", support:[], links:{},
      ...(prefill || {}),
    };
    if (!base.reminders || !base.reminders.length)
      base.reminders = (defaultReminders && defaultReminders.length) ? defaultReminders : DEFAULT_REMINDERS;
    return base;
  });
  const set = (k,v)=>setF(p=>({...p,[k]:v}));
  const valid = f.title.trim() && f.location && f.type && f.owner;
  const [remOpen, setRemOpen] = useState(false);
  const remDefaults = (defaultReminders && defaultReminders.length) ? defaultReminders : DEFAULT_REMINDERS;
  return (
    <div className="sb-scrim" onClick={onClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()}>
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>{task?"Edit content":"Plan content"}</b>
          <button className="sb-x" onClick={onClose}><XMarkIcon className="hi" aria-hidden="true" /></button></div>
        <div className="bd">
          <div className="sb-sub" style={{marginTop:0}}>Plan a piece of content. The team adds the deliverable links later, when it's ready for QA.</div>
          <div className="sb-field"><label>Content title</label>
            <input value={f.title} onChange={e=>set("title",e.target.value)} placeholder="e.g. Sunday welcome reel" /></div>
          <div className="sb-btnrow">
            <div className="sb-field" style={{flex:1}}><label>Type</label>
              <select value={f.type} onChange={e=>set("type",e.target.value)}>{TYPES.map(t=><option key={t}>{t}</option>)}</select></div>
            <div className="sb-field" style={{flex:1}}><label>Location</label>
              <select value={f.location} onChange={e=>set("location",e.target.value)}><option>479</option><option>828</option><option>Both</option></select></div>
          </div>
          <div className="sb-field"><label>Owner: who brings the idea / leads</label>
            <select value={f.owner||"Pending"} onChange={e=>set("owner",e.target.value)}>
              <option value="Pending">Pending: unassigned</option>
              {users.map(u=><option key={u.id}>{u.name}</option>)}</select>
            {f.owner==="Pending" && f.ownerSuggested && (() => {
              const m = matchUser(f.ownerSuggested, users);
              return m
                ? <button type="button" className="link" style={{marginTop:6}}
                    onClick={()=>{ set("owner", m.name); set("ownerSuggested",""); }}>
                    💡 From the sheet this was “{f.ownerSuggested}”. Assign {m.name}?</button>
                : <div className="sb-sub" style={{marginTop:6}}>From the sheet: “{f.ownerSuggested}” (no matching account yet)</div>;
            })()}
          </div>
          <div className="sb-field"><label>Creative brief: what are we making &amp; why</label>
            <textarea rows={3} value={f.brief||""} onChange={e=>set("brief",e.target.value)}
              placeholder="Objective, key message, deliverables, references / creative direction…" /></div>
          <div className="sb-btnrow">
            <div className="sb-field" style={{flex:1}}><label>Shoot date</label>
              <input type="date" value={f.shootDate} onChange={e=>set("shootDate",e.target.value)} /></div>
            <div className="sb-field" style={{flex:1}}><label>Post date</label>
              <input type="date" value={f.postDate} onChange={e=>set("postDate",e.target.value)} /></div>
          </div>
          <div className="sb-field" style={{maxWidth:200}}><label>Priority</label>
            <select value={f.priority||"Medium"} onChange={e=>set("priority",e.target.value)}>{PRIORITIES.map(p=><option key={p}>{p}</option>)}</select></div>
          <div className="sb-field"><label>Related event (optional)</label>
            <input value={f.relatedEvent} onChange={e=>set("relatedEvent",e.target.value)} placeholder="e.g. Easter Service" /></div>
          <div className="sb-field"><label>Reference link (optional)</label>
            <input value={f.link} onChange={e=>set("link",e.target.value)} placeholder="Idea / inspiration / reference" /></div>
          <div className="sb-field"><label>Notes (optional)</label>
            <textarea rows={2} value={f.notes} onChange={e=>set("notes",e.target.value)} /></div>

          <div className="sb-shead"><h2>Support crew</h2>
            <button className="link" onClick={()=>set("support", onAuto(f))}><BoltIcon className="hi hi-sm" aria-hidden="true"/> Auto-assign</button></div>
          {(f.support||[]).length===0
            ? <div className="sb-sub">No crew yet. Tap Auto-assign or add below.</div>
            : (f.support||[]).map((s,i)=>{
              const pending = s.name==="Pending";
              const m = pending && s.suggested ? matchUser(s.suggested, users) : null;
              return (
              <div className="sb-cmt" key={i} style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <span className="sb-av">{pending ? "?" : initials(s.name)}</span>
                <span style={{flex:1,minWidth:0}}>
                  {pending
                    ? <><b>{pendingCrewLabel(s)}</b>{s.suggested && <span style={{color:"var(--muted)"}}> · suggested: {s.suggested}</span>}</>
                    : <><b>{s.name}</b> · <span style={{color:"var(--muted)"}}>{crewRoleLabel(s)}{s.loc?` · ${s.loc}`:""}</span></>}
                </span>
                {m && <button type="button" className="sb-btn ghost compact"
                  onClick={()=>set("support", f.support.map((x,j)=> j===i ? { name:m.name, role:x.role, ...(x.loc?{loc:x.loc}:{}) } : x))}>
                  Assign {m.name.split(" ")[0]} →</button>}
                <button className="sb-x" onClick={()=>set("support",f.support.filter((_,j)=>j!==i))}><XMarkIcon className="hi" aria-hidden="true" /></button>
              </div>
              );
            })}
          <AddCrew users={users} onAdd={(c)=>set("support",[...(f.support||[]),c])} />

          <div className="sb-field" style={{marginTop:18}}>
            <label>Reminders</label>
            <ReminderSummary reminders={f.reminders} defaults={remDefaults}
              postDate={f.postDate} onCustomize={()=>setRemOpen(true)} />
          </div>
          {remOpen && <ReminderSheet reminders={f.reminders} defaults={remDefaults}
            postDate={f.postDate} onChange={(r)=>set("reminders",r)} onClose={()=>setRemOpen(false)} />}

          <button className="sb-btn" style={{marginTop:14}} disabled={!valid} onClick={()=>onSave(f)}>{task?"Save changes":"Create task"}</button>
          {!valid && <div className="sb-sub" style={{marginTop:8,textAlign:"center"}}>Title, type, location and owner are required.</div>}
        </div>
      </div>
    </div>
  );
}
function AddCrew({ users, onAdd }) {
  const [n,setN] = useState(users[0]?.name||""); const [r,setR] = useState("shoot");
  const [label,setLabel] = useState("");
  useEffect(()=>{ if(!n && users[0]) setN(users[0].name); },[users]); // keep valid default
  const isOther = r === "other";
  const canAdd = !!n && (!isOther || label.trim());      // "Other" requires a custom label
  const add = () => {
    onAdd(isOther ? { name:n, role:"other", label:label.trim() } : { name:n, role:r });
    setLabel("");
  };
  const sel = {flex:2,border:"1px solid var(--line)",borderRadius:11,padding:11,background:"var(--card)"};
  return (
    <div style={{marginTop:8}}>
      <div className="sb-btnrow">
        <select style={sel} value={n} onChange={e=>setN(e.target.value)}>{users.map(u=><option key={u.id}>{u.name}</option>)}</select>
        <select style={sel} value={r} onChange={e=>setR(e.target.value)}>
          {CREW_ROLES.map(x=><option key={x} value={x}>{roleLabel(x)}</option>)}</select>
        <button className="sb-btn compact" disabled={!canAdd} onClick={add}>Add</button>
      </div>
      {isOther && <input value={label} onChange={e=>setLabel(e.target.value)}
        placeholder="Custom task, e.g. Caption Writing, Voiceover, Lighting"
        style={{width:"100%",marginTop:8,border:"1px solid var(--line)",borderRadius:11,padding:11,background:"var(--card)",color:"var(--ink)"}} />}
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
    department: user.department||"", lead: !!user.lead,
  });
  const [resetMsg, setResetMsg] = useState("");
  const set = (k,v)=>setF(p=>({...p,[k]:v}));
  const toggleSkill = (s)=>set("skills", f.skills.includes(s)?f.skills.filter(x=>x!==s):[...f.skills,s]);
  const toggleLoc = (l)=>set("location", f.location.includes(l)?f.location.filter(x=>x!==l):[...f.location,l]);
  const valid = f.name.trim() && f.skills.length && f.location.length;
  const SK = ["shoot","edit","coordinate","design","shadow"];

  const payload = () => ({ id:user.id, ...f });
  const reset = async () => {
    try { await sendPasswordResetEmail(auth, user.email); setResetMsg("Reset email sent to "+user.email); }
    catch { setResetMsg("Couldn't send reset email."); }
  };

  return (
    <div className="sb-scrim" onClick={onClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()}>
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>{isPending?"Approve "+user.name:"Edit "+user.name}</b>
          <button className="sb-x" onClick={onClose}><XMarkIcon className="hi" aria-hidden="true" /></button></div>
        <div className="bd">
          {isPending && <div className="sb-banner">Set their skills and location, then approve to let them in.</div>}

          <div className="sb-field"><label>Name</label>
            <input value={f.name} onChange={e=>set("name",e.target.value)} /></div>
          <div className="sb-field"><label>Email (login)</label>
            <input value={user.email} disabled style={{opacity:.7}} /></div>

          <div className="sb-field"><label>Access level</label>
            <select value={f.role} onChange={e=>set("role",e.target.value)}>
              <option value="member">Member: can view all tasks</option>
              <option value="admin">Admin: full control</option></select></div>

          <div className="sb-field"><label>Department</label>
            <select value={f.department} onChange={e=>set("department",e.target.value)}>
              <option value="">No department yet</option>
              {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}</select></div>

          <div className="sb-field"><label>Skills (what they can do)</label>
            <div className="sb-seg" style={{flexWrap:"wrap"}}>
              {SK.map(s=>(<button key={s} className={"sb-segbtn"+(f.skills.includes(s)?" on":"")}
                onClick={()=>toggleSkill(s)}>{roleLabel(s)}</button>))}</div></div>

          <div className="sb-field"><label>Service location</label>
            <div className="sb-seg">{["479","828"].map(l=>(
              <button key={l} className={"sb-segbtn"+(f.location.includes(l)?" on":"")} onClick={()=>toggleLoc(l)}>{l}</button>))}</div></div>

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
