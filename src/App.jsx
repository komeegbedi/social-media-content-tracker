import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  onAuthStateChanged, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, updateProfile, sendPasswordResetEmail,
} from "firebase/auth";
import {
  collection, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, serverTimestamp,
} from "firebase/firestore";
import { auth, db, googleProvider } from "./firebase";
import {
  STAGES, statusClass, roleLabel, initials, emailFor,
  fmt, daysTo, autoAssign, computeCapacity,
  parseCSV, rowToTask, sheetCsvUrl,
  PRIORITIES, priorityClass, attentionItems, matchUser,
  PHASES, statusPhase, nextStep, workflowAction,
  LINK_FIELDS, requiredLinkKeys, missingLinks, QA_STATUSES,
  activityEntry, activityLabel, isApprovalEvent,
  TYPES, typeClass, qaQueue, postQueue, pendingMatches, applyAssignment,
  personalWins, teamWins, dashboardMetrics, searchTasks,
  monthlyWins, recentWins, contributorWins,
} from "./data";
import { upcomingEvents } from "./events";
import { setView, reportIssue, logIssue } from "./logging";
import { getTheme, setTheme } from "./theme";

/* Light/dark toggle. Default follows the OS; a manual choice is remembered. */
function ThemeToggle({ compact }) {
  const [theme, setT] = useState(getTheme());
  const toggle = () => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); setT(next); };
  return compact
    ? <button className="sb-report-top" onClick={toggle} aria-label="Toggle dark mode">{theme==="dark"?"☀":"🌙"}</button>
    : <button className="sb-report" onClick={toggle}>{theme==="dark"?"☀︎ Light mode":"🌙 Dark mode"}</button>;
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
          <div className="ic">⚠️</div>
          <h1>Something went wrong</h1>
          <p>The error has been logged. If you have a second, tell us what you were
             doing and we'll look into it.</p>
          <textarea rows={3} value={this.state.note} placeholder="What were you doing? (optional)"
            onChange={(e)=>this.setState({ note: e.target.value })}
            style={{width:"100%",borderRadius:12,border:"none",padding:"11px 12px",fontSize:16,marginBottom:12}} />
          {this.state.sent
            ? <p style={{marginTop:0}}>Thanks — your report was sent.</p>
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

function useAuthUser() {
  const [user, setUser] = useState(undefined); // undefined=loading, null=signed out
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  return user;
}

// Make sure a signed-in user has a profile doc. First sign-in → pending.
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
// an admin approves them or edits their skills, etc. onSnapshot returns its
// unsubscribe fn, which useEffect calls on cleanup.
function useProfile(uid) {
  const [profile, setProfile] = useState(undefined);
  useEffect(() => {
    if (!uid) { setProfile(null); return; }
    return onSnapshot(doc(db, "users", uid),
      (s) => setProfile(s.exists() ? { id: s.id, ...s.data() } : null),
      () => setProfile(null));
  }, [uid]);
  return profile;
}

// Live-subscribe to a whole collection ("users" or "tasks"). `canRead` gates
// the subscription so we don't query before the user is allowed (Firestore
// rules would reject it). Every connected client stays in sync in real time.
function useCollection(path, canRead) {
  const [docs, setDocs] = useState([]);
  useEffect(() => {
    if (!canRead) { setDocs([]); return; }
    return onSnapshot(collection(db, path),
      (snap) => setDocs(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => console.error(path, err));
  }, [path, canRead]);
  return docs;
}

/* ===================================================================
   ROOT
   =================================================================== */
const Ic = { home:"♡", day:"◉", board:"▦", mine:"✓", team:"♦", admin:"⚙", chat:"💬" };

export default function App() {
  const user = useAuthUser();                          // Firebase Auth user (or null)
  useEffect(() => { if (user) ensureProfile(user); }, [user]); // first sign-in → pending profile
  const profile = useProfile(user?.uid);               // their Firestore profile doc

  // Gating ladder, in order: still loading → not signed in → profile not ready
  // → signed in but not yet approved → full app.
  if (user === undefined || (user && profile === undefined)) return <Loading />;
  if (!user) return <Login />;
  if (!profile) return <Loading label="Setting up your account…" />;

  const isAdmin = profile.role === "admin";
  const approved = profile.status === "approved" || isAdmin;
  if (!approved) return <Pending profile={profile} />;

  return <Board profile={profile} isAdmin={isAdmin} />;
}

function Loading({ label = "Loading StudioBoard…" }) {
  return <div className="sb-loading"><div><div className="sb-spin" />{label}</div></div>;
}

/* ===================================================================
   LOGIN  (email/password + register + Google)
   =================================================================== */
function Login() {
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
    if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found"))
      return "Email or password isn't right.";
    if (c.includes("email-already-in-use")) return "That email already has an account — try signing in.";
    if (c.includes("weak-password")) return "Password should be at least 6 characters.";
    if (c.includes("invalid-email")) return "That doesn't look like a valid email.";
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

  return (
    <div className="sb-login">
      <div className="sb-loginbox">
        <div className="logo">✦</div>
        <h1>StudioBoard</h1>
        <p>{mode === "register"
          ? "Create your account for the IFC media team."
          : "Sign in to see what's on your plate."}</p>

        <div className="sb-lcard">
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

          <button className="sb-btn" onClick={doEmail} disabled={busy || !email || !pw}>
            {busy ? "Please wait…" : mode === "register" ? "Create account" : "Sign in"}
          </button>
        </div>

        <div className="sb-ltoggle">
          {mode === "register" ? "Already have an account? " : "New to the team? "}
          <button onClick={()=>{ setMode(m=>m==="register"?"signin":"register"); setErr(""); setOk(""); }}>
            {mode === "register" ? "Sign in" : "Create one"}
          </button>
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
           every reel and poster the team is working on. Hang tight — this usually doesn't take long.</p>
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

  const [tab, setTab] = useState("home");
  const [openId, setOpenId] = useState(null);
  const [editTask, setEditTask] = useState(null);
  const [editUser, setEditUser] = useState(null);
  const [showReport, setShowReport] = useState(false);

  // Stamp the active screen onto any error/report logged from here.
  useEffect(() => setView(tab), [tab]);

  const me = profile;
  const pendingCount = allUsers.filter(u => u.status === "pending").length;

  const nav = [
    { id:"home", ico:Ic.home, label:"Home" },
    { id:"myday", ico:Ic.day, label:"My Day" },
    { id:"board", ico:Ic.board, label:"Board" },
    { id:"mine", ico:Ic.mine, label:"My Work" },
    { id:"team", ico:Ic.team, label:"Team" },
    ...(isAdmin ? [{ id:"admin", ico:Ic.admin, label:"Admin", badge: pendingCount }] : []),
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
          <div className="sb-sbrand"><span className="sb-spark">✦</span>StudioBoard</div>
          <nav className="sb-snav">
            {nav.map(n => (
              <button key={n.id} className={tab===n.id?"on":""} onClick={()=>setTab(n.id)}>
                <span className="ico">{n.ico}</span>{n.label}
                {n.badge>0 && <span className="pill">{n.badge}</span>}
              </button>
            ))}
          </nav>
          {isAdmin && <button className="sb-btn" style={{marginTop:14}} onClick={()=>setEditTask("new")}>+ New content</button>}
          <div className="sb-sfoot">
            <div className="sb-suser">
              <span className="sb-av" style={{width:34,height:34,fontSize:12}}>{initials(me.name)}</span>
              <span><div className="nm">{me.name}</div><div className="rl">{isAdmin?"Admin":"Member"} · {me.email}</div></span>
            </div>
            <ThemeToggle />
            <button className="sb-report" onClick={()=>setShowReport(true)}>⚠︎ Report an issue</button>
            <button className="sb-signout" onClick={()=>signOut(auth)}>Sign out</button>
          </div>
        </aside>

        <div className="sb-main">
          <header className="sb-top">
            <span className="brand"><span className="sb-spark">✦</span>StudioBoard</span>
            <span style={{display:"flex",alignItems:"center",gap:8}}>
              <ThemeToggle compact />
              <button className="sb-report-top" onClick={()=>setShowReport(true)} aria-label="Report an issue">⚠︎</button>
              <button className="sb-whoami" onClick={()=>signOut(auth)}>
                <span className="sb-av" style={{width:22,height:22,fontSize:9}}>{initials(me.name)}</span>
                {me.name.split(" ")[0]} · Sign out
              </button>
            </span>
          </header>

          <div className="sb-content">
            {tab==="home"  && <Home tasks={tasks} users={users} me={me} goTab={setTab} />}
            {tab==="myday" && <MyDay tasks={tasks} me={me} openTask={setOpenId} goTab={setTab} />}
            {tab==="board" && <BoardList tasks={tasks} openTask={setOpenId} />}
            {tab==="mine"  && <Mine tasks={tasks} me={me} openTask={setOpenId} />}
            {tab==="team"  && <Team tasks={tasks} users={users} />}
            {tab==="admin" && isAdmin && (
              <Admin users={allUsers} tasks={tasks} teamUsers={users} issues={issues}
                onEditUser={setEditUser} onEditTask={setEditTask}
                onDeleteUser={removeUser} onDeleteTask={deleteTask}
                onArchiveTask={archiveTask} onDuplicateTask={duplicateTask} onOpenTask={setOpenId}
                onAutoAll={autoAll} onImport={importTasks} onResolveIssue={resolveIssue}
                onAssignSuggested={assignSuggested} />
            )}
          </div>

          <nav className="sb-nav">
            {nav.map(n => (
              <button key={n.id} className={"sb-navbtn"+(tab===n.id?" on":"")} onClick={()=>setTab(n.id)}>
                <span className="ico">{n.ico}</span>{n.label}
                {n.badge>0 && <span className="pill">{n.badge}</span>}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {isAdmin && tab!=="admin" && (
        <button className="sb-fab" onClick={()=>setEditTask("new")} aria-label="New content">+</button>
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
        <TaskEditor task={editTask==="new"?null:editTask} users={users}
          onClose={()=>setEditTask(null)} onSave={saveTask} onAuto={(t)=>autoAssign(t, users)} />
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
          <button className="sb-x" onClick={onClose}>✕</button></div>
        <div className="bd">
          {state==="sent" ? (
            <div className="sb-empty"><div className="big">✓</div>
              Thanks — your report was sent. We'll take a look.</div>
          ) : <>
            <div className="sb-sub" style={{marginTop:0}}>
              Tell us what went wrong or felt off. We'll automatically include your
              account, the screen you're on, and your device details.</div>
            <div className="sb-field"><label>What happened?</label>
              <textarea rows={5} value={note} onChange={e=>setNote(e.target.value)}
                placeholder="e.g. I tried to mark a reel Approved and nothing happened." /></div>
            {state==="error" && <div className="sb-lerr">Couldn't send that — please try again.</div>}
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
        : "You're all clear — nothing needs you right now.");

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
        <QueueSection title="Approved — needs captions" items={pq.captions} me={me} openTask={openTask} />
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

      <div className="sb-shead"><h2>Needs your attention</h2>
        <button className="link" onClick={()=>goTab("mine")}>All my work →</button></div>
      {attention.length===0
        ? <div className="sb-empty"><div className="big">✓</div>Nothing urgent — enjoy the breather.</div>
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
  const label = `${nextStep(t.status)} — ${t.title}`;
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
      <span className="sb-attn-chev">›</span>
    </button>
  );
}

/* ===================================================================
   BOARD LIST
   =================================================================== */
function BoardList({ tasks, openTask }) {
  const [filter, setFilter] = useState("All");
  const [q, setQ] = useState("");
  const filters = ["All","Reel","Poster","Photography","In Review","Changes Requested","Approved","Ready to Post","479","828","Archive"];
  const searching = q.trim().length > 0;

  // Search spans EVERYTHING (active + archive). Otherwise the board shows
  // active work, with an Archive view for posted/completed content.
  let list;
  if (searching) {
    list = searchTasks(tasks, q);
  } else if (filter === "Archive") {
    list = tasks.filter(t => t.status === "Posted");
  } else {
    list = tasks.filter(t => {
      if (t.status === "Posted") return false;                 // archived → not on the active board
      if (filter === "All") return true;
      if (["Reel","Poster","Photography"].includes(filter)) return t.type === filter;
      if (filter === "479" || filter === "828") return t.location === filter || t.location === "Both";
      return t.status === filter;
    });
  }
  list = [...list].sort((a,b)=>(daysTo(a.postDate)??99)-(daysTo(b.postDate)??99));

  return (
    <div className="sb-page">
      <div className="sb-eyebrow">{searching ? "Search results" : filter==="Archive" ? "Archive" : "Everything in motion"}</div>
      <div className="sb-h">The board</div>
      <div className="sb-sub">
        {searching ? `${list.length} result${list.length!==1?"s":""} for “${q.trim()}” — across every status.`
          : filter==="Archive" ? "Posted & completed work — searchable for reference and reuse."
          : "Active content, sorted by what's due first."}
      </div>

      <div className="sb-field" style={{marginBottom:10}}>
        <div className="sb-inline">
          <input value={q} onChange={e=>setQ(e.target.value)}
            placeholder="🔍 Search all tasks — title, event, person, type, notes…" />
          {searching && <button className="sb-btn ghost compact" onClick={()=>setQ("")}>Clear</button>}
        </div>
      </div>

      {!searching && <div className="sb-seg">
        {filters.map(f => (
          <button key={f} className={"sb-segbtn"+(filter===f?" on":"")} onClick={()=>setFilter(f)}>{f}</button>
        ))}
      </div>}

      {list.length===0
        ? <div className="sb-empty"><div className="big">{searching?"🔍":"▦"}</div>
            {searching ? `Nothing matches “${q.trim()}”.` : filter==="Archive" ? "Nothing archived yet." : "No content matches that filter."}</div>
        : <div className="sb-list">{list.map(t => <TaskCard key={t.id} t={t} onClick={()=>openTask(t.id)} />)}</div>}
    </div>
  );
}

/* ===================================================================
   MINE
   =================================================================== */
function Mine({ tasks, me, openTask }) {
  const mine = tasks.filter(t => t.owner===me.name || (t.support||[]).some(s=>s.name===me.name));
  const owned = mine.filter(t => t.owner===me.name);
  const helping = mine.filter(t => t.owner!==me.name);
  return (
    <div className="sb-page">
      <div className="sb-eyebrow">Just for you</div>
      <div className="sb-h">My work</div>
      <div className="sb-sub">{mine.length} thing{mine.length!==1?"s":""} with your name on {mine.length!==1?"them":"it"}.</div>

      <div className="sb-shead"><h2>You're leading</h2><span className="sb-tag">{owned.length}</span></div>
      {owned.length===0 ? <div className="sb-empty">Nothing you own right now.</div>
        : <div className="sb-list">{owned.map(t => <TaskCard key={t.id} t={t} me={me} onClick={()=>openTask(t.id)} />)}</div>}

      <div className="sb-shead"><h2>You're supporting</h2><span className="sb-tag">{helping.length}</span></div>
      {helping.length===0 ? <div className="sb-empty">No support tasks assigned.</div>
        : <div className="sb-list">{helping.map(t => <TaskCard key={t.id} t={t} me={me} onClick={()=>openTask(t.id)} />)}</div>}
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
function Home({ tasks, users, me, goTab }) {
  const pw = personalWins(tasks, me);
  const tw = teamWins(tasks);
  const m = dashboardMetrics(tasks, users);
  const thisM = monthlyWins(tasks, 0);
  const lastM = monthlyWins(tasks, -1);
  const events = upcomingEvents(4);
  const recents = recentWins(tasks, 4);
  const contributors = contributorWins(tasks, users, 5);
  const activeContributors = new Set(
    tasks.filter(t=>t.status!=="Posted").flatMap(t=>[t.owner, ...(t.support||[]).map(s=>s.name)])
  ).size;
  const readyToPost = tasks.filter(t=>t.status==="Approved").length;
  const prepCount = events.filter(e=>e.prepNow).length;

  const hi = new Date().getHours();
  const greet = hi<12?"Good morning":hi<17?"Good afternoon":"Good evening";
  const fmtEv = (d) => d.toLocaleDateString(undefined,{month:"short",day:"numeric"});

  return (
    <div className="sb-page">
      <div className="sb-eyebrow">{greet}</div>
      <div className="sb-h">{greet}, {me.name.split(" ")[0]} 👋</div>
      <div className="sb-sub">
        You helped complete <b>{pw.thisMonth}</b> project{pw.thisMonth!==1?"s":""} this month. The team has posted
        {" "}<b>{thisM.posted}</b> piece{thisM.posted!==1?"s":""} of content.
        {prepCount>0 ? ` ${prepCount} upcoming event${prepCount!==1?"s":""} need content prep.` : " You're caught up on prep — nice."}
      </div>

      {/* Ministry wins */}
      <div className="sb-shead"><h2>Ministry wins</h2></div>
      <div className="sb-mlabel">This month</div>
      <div className="sb-wincards">
        <WinCard n={thisM.posted} label="Content posted" />
        <WinCard n={thisM.reels} label="Reels completed" />
        <WinCard n={thisM.graphics} label="Graphics delivered" />
      </div>
      <div className="sb-mlabel">Last month</div>
      <div className="sb-wincards">
        <WinCard n={lastM.posted} label="Content posted" />
        <WinCard n={lastM.campaigns} label="Campaigns" />
      </div>

      {/* Personal contributions */}
      <div className="sb-shead"><h2>Your contributions</h2></div>
      <div className="sb-wincards">
        <WinCard n={pw.completed} label="Projects completed" />
        <WinCard n={pw.contributions} label="Contributions" />
        <WinCard n={pw.approved} label="Approved / posted" />
      </div>
      {contributors.length>0 && <>
        <div className="sb-mlabel">Across the team</div>
        <div className="sb-caplist">
          {contributors.map(c => (
            <div className="sb-cap" key={c.name}><div className="top">
              <span className="name"><span className="sb-av">{initials(c.name)}</span>{c.name}</span>
              <span className="pct">{c.n} delivered</span>
            </div></div>
          ))}
        </div>
      </>}

      {/* Team statistics */}
      <div className="sb-shead"><h2>Team statistics</h2></div>
      <div className="sb-strip">
        <div className="sb-stat"><span className="num dot-violet">{activeContributors}</span><span className="lbl">Active contributors</span></div>
        <div className="sb-stat"><span className="num dot-green">{tw.posted}</span><span className="lbl">Posted all-time</span></div>
        <div className="sb-stat"><span className="num dot-amber">{m.awaiting}</span><span className="lbl">In approval</span></div>
        <div className="sb-stat"><span className="num dot-blue">{m.avgApprovalHours==null?"—":m.avgApprovalHours+"h"}</span><span className="lbl">Avg approval</span></div>
      </div>

      {/* Upcoming events */}
      <div className="sb-shead"><h2>Upcoming events</h2></div>
      {events.length===0
        ? <div className="sb-empty">No upcoming events.</div>
        : <div className="sb-evlist">
            {events.map((e,i) => (
              <div className="sb-ev" key={i}>
                <span className="sb-ev-ic">{e.kind==="birthday"?"🎂":"📅"}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div className="sb-ev-name">{e.name}</div>
                  <div className="sb-ev-sub">
                    {fmtEv(e.date)} · {e.daysAway===0?"today":`${e.daysAway} day${e.daysAway!==1?"s":""} away`}
                    {" · "}{e.prepNow ? "start content prep now" : `prep in ${e.prepInDays} day${e.prepInDays!==1?"s":""}`}
                  </div>
                </div>
              </div>
            ))}
          </div>}

      {/* Team pulse — small, awareness not stress */}
      <div className="sb-div"><span>Team pulse</span></div>
      <div className="sb-strip" style={{marginTop:12}}>
        <button className="sb-stat" onClick={()=>goTab("board")}><span className="num dot-amber">{m.awaiting}</span><span className="lbl">Awaiting approval</span></button>
        <button className="sb-stat" onClick={()=>goTab("board")}><span className="num dot-green">{readyToPost}</span><span className="lbl">Ready to post</span></button>
        <button className="sb-stat" onClick={()=>goTab("myday")}><span className="num dot-red">{m.overdue}</span><span className="lbl">Overdue</span></button>
        <button className="sb-stat" onClick={()=>goTab("board")}><span className="num dot-blue">{m.upcoming}</span><span className="lbl">Upcoming (7d)</span></button>
      </div>

      {/* Recent wins */}
      <div className="sb-shead"><h2>Recent wins</h2></div>
      {recents.length===0
        ? <div className="sb-empty">Nothing posted yet — your first win is coming!</div>
        : <div className="sb-recent">{recents.map((r,i)=>(<div className="sb-recent-row" key={i}>✅ {r.text}</div>))}</div>}
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
        onClick={()=>setOpen(o=>!o)}>⋯</button>
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

function Admin({ users, tasks, teamUsers, issues, onEditUser, onEditTask, onDeleteUser, onDeleteTask, onArchiveTask, onDuplicateTask, onOpenTask, onAutoAll, onImport, onResolveIssue, onAssignSuggested }) {
  const [sec, setSec] = useState("tasks");
  const pending = users.filter(u => u.status === "pending");
  const approved = users.filter(u => u.status === "approved" || u.role === "admin");
  const openIssues = (issues || []).filter(i => i.status !== "resolved").length;

  return (
    <div className="sb-page">
      <div className="sb-eyebrow">Control room</div>
      <div className="sb-h">Admin</div>
      <div className="sb-sub">Create and manage content, people, and assignments.</div>
      <div className="sb-seg" style={{marginBottom:14}}>
        <button className={"sb-segbtn"+(sec==="tasks"?" on":"")} onClick={()=>setSec("tasks")}>Tasks</button>
        <button className={"sb-segbtn"+(sec==="people"?" on":"")} onClick={()=>setSec("people")}>
          People{pending.length>0?` · ${pending.length} pending`:""}</button>
        <button className={"sb-segbtn"+(sec==="import"?" on":"")} onClick={()=>setSec("import")}>Import</button>
        <button className={"sb-segbtn"+(sec==="issues"?" on":"")} onClick={()=>setSec("issues")}>
          Issues{openIssues>0?` · ${openIssues} open`:""}</button>
      </div>

      {sec==="tasks" && <>
        <div className="sb-btnrow" style={{marginBottom:14}}>
          <button className="sb-btn" onClick={()=>onEditTask("new")}>+ New content</button>
          <button className="sb-btn gold" onClick={onAutoAll}>⚡ Auto-assign empty</button>
        </div>
        <div className="sb-list">
          {tasks.map(t => (
            <div className="sb-task sb-task-act" key={t.id} role="button" tabIndex={0}
              onClick={()=>onOpenTask(t.id)}
              onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); onOpenTask(t.id); } }}>
              <div className="row1"><span className="title">{t.title}</span>
                <div className="sb-row1end">
                  <span className={"sb-chip "+typeClass(t.type)}>{t.type}</span>
                  <KebabMenu items={[
                    { label:"Open", onClick:()=>onOpenTask(t.id) },
                    { label:"Edit", onClick:()=>onEditTask(t) },
                    { label:"Duplicate", onClick:()=>onDuplicateTask(t) },
                    ...(t.status!=="Posted" ? [{ label:"Archive", onClick:()=>onArchiveTask(t) }] : []),
                    { label:"Delete", danger:true, onClick:()=>{ if(confirm(`Delete "${t.title}"?`)) onDeleteTask(t.id); } },
                  ]} />
                </div></div>
              <div className="sb-cardstatus">
                <span className={"sb-status "+statusClass(t.status)}><span className="pip"/>{t.status}</span>
                <span className="sb-due due-ok">{fmt(t.postDate)}</span>
              </div>
              {t.status!=="Posted" && <div className="sb-next">Next: {nextStep(t.status)}</div>}
              <div className="sub"><span><b>{t.owner==="Pending"&&t.ownerSuggested?`Pending — ${t.ownerSuggested}`:t.owner}</b> · {t.location}</span></div>
            </div>
          ))}
          {tasks.length===0 && <div className="sb-empty">No content yet. Tap “New content” to start.</div>}
        </div>
      </>}

      {sec==="people" && <>
        {pending.length>0 && <>
          <div className="sb-banner">⏳ {pending.length} {pending.length===1?"person is":"people are"} waiting for approval</div>
          <div className="sb-list" style={{marginBottom:18}}>
            {pending.map(u => (
              <div className="sb-task" key={u.id} style={{cursor:"default"}}>
                <div className="row1"><span className="title">{u.name}</span>
                  <span className="sb-chip chip-poster">Pending</span></div>
                <div className="sub"><span>{u.email}</span></div>
                <AssignHint user={u} tasks={tasks} onAssign={onAssignSuggested} />
                <div className="sb-btnrow" style={{marginTop:10}}>
                  <button className="sb-btn green" onClick={()=>onEditUser(u)}>Review &amp; approve</button>
                  <button className="sb-btn danger" onClick={()=>{ if(confirm(`Reject ${u.name}? They'll be removed.`)) onDeleteUser(u.id); }}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        </>}

        <div className="sb-shead"><h2>Team</h2><span className="sb-tag">{approved.length}</span></div>
        <div className="sb-list">
          {approved.map(u => (
            <div className="sb-task" key={u.id} style={{cursor:"default"}}>
              <div className="row1">
                <span className="title">{u.name}{u.role==="admin" && <span className="sb-chip chip-poster" style={{marginLeft:8}}>Admin</span>}</span>
              </div>
              <div className="sub"><span>{u.email}</span><span>{(u.location||[]).join("/")}</span></div>
              <div className="sub"><span>{(u.skills||[]).map(roleLabel).join(", ")||"No skills set"}</span>
                {(u.qa||u.captions) && <span>{[u.qa&&"QA",u.captions&&"Captions"].filter(Boolean).join(" · ")}</span>}</div>
              <AssignHint user={u} tasks={tasks} onAssign={onAssignSuggested} />
              <div className="sb-btnrow" style={{marginTop:10}}>
                <button className="sb-btn ghost" onClick={()=>onEditUser(u)}>Edit</button>
                <button className="sb-btn danger" onClick={()=>{ if(confirm(`Remove ${u.name}?`)) onDeleteUser(u.id); }}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      </>}

      {sec==="import" && <ImportPanel users={teamUsers} onImport={onImport} />}

      {sec==="issues" && <IssueLog issues={issues} onResolve={onResolveIssue} />}
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
        ? <div className="sb-empty"><div className="big">✓</div>Nothing here — no {show==="open"?"open ":""}issues.</div>
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
                    <span>on {i.route||"—"}</span>
                    <span>{tm(i.createdAt)}</span>
                    {i.taskId && <span>task {i.taskId}</span>}
                  </div>
                  {i.note && i.message && <div className="sub"><span style={{color:"var(--muted)"}}>{i.message}</span></div>}
                  {expanded && (
                    <div className="sb-issue-meta">
                      {i.action && <div><b>Action:</b> {i.action}</div>}
                      <div><b>Device:</b> {i.userAgent || "—"}</div>
                      <div><b>Viewport:</b> {i.viewport || "—"} · <b>URL:</b> {i.url || "—"}</div>
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
  const [rows, setRows] = useState([]);     // [{ task, error }]
  const [sheetUrl, setSheetUrl] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const ingest = (text) => {
    const parsed = parseCSV(text).map((r) => rowToTask(r, users));
    setRows(parsed);
    setMsg(parsed.length ? "" : "No rows found — check the file has a header row and at least one task.");
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
    setBusy(true); setMsg(""); setRows([]);
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
      setRows([]);
    } catch {
      setMsg("Import failed — please try again.");
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
                    <div className="sub"><span><b>{r.task.owner||"—"}</b> · {r.task.location} · {r.task.status}</span>
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
  const phase = statusPhase(t.status);
  const pct = ((phase+1)/PHASES.length)*100;             // progress through the 4 phases
  const ownerLabel = t.owner==="Pending" ? (t.ownerSuggested ? `Pending — ${t.ownerSuggested}` : "Pending") : t.owner;
  // De-duplicate owner + crew so the same person shows one avatar.
  const people = [{name:t.owner,owner:true}, ...(t.support||[]).map(s=>({name:s.name}))];
  const seen = new Set(); const uniquePeople = people.filter(p=>!seen.has(p.name)&&seen.add(p.name));
  return (
    <button className="sb-task" onClick={onClick}>
      <div className="row1">
        <span className="title">{t.title}</span>
        <span className="sb-rowtags">
          {t.priority==="High" && <span className={"sb-pri "+priorityClass(t.priority)}>▲ High</span>}
          <span className={"sb-chip "+typeClass(t.type)}>{t.type}</span>
        </span>
      </div>

      {/* Status is dominant; "Next" + blocker are small supporting text. */}
      <div className="sb-cardstatus">
        <span className={"sb-status "+statusClass(t.status)}><span className="pip"/>{t.status}</span>
        {!isPosted && <span className={"sb-due "+dueCls}>{dueTxt}</span>}
      </div>
      {t.blockedOn
        ? <div className="sb-next blocked">⛔ Waiting on {t.blockedOn}</div>
        : !isPosted && <div className="sb-next">Next: {nextStep(t.status)}</div>}

      <div className="sub">
        <span><b>{ownerLabel}</b> leads</span>
        <span>{t.location==="Both"?"479 + 828":t.location}</span>
      </div>

      {/* Slim progress bar through the 4 phases (Planning → Posting). */}
      <div className="sb-prog" aria-label={`Status: ${t.status}`}>
        <i className={isPosted?"done":""} style={{width:`${pct}%`}}/>
      </div>

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
          <button className="sb-x" onClick={onClose}>✕</button>
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

          {/* Phase progress: Planning → Creating → Review → Posting. */}
          <div className="sb-phases">
            {PHASES.map((p,i)=>(
              <div key={p} className={"sb-phase"+(i<phase?" done":i===phase?" now":"")}><span/>{p}</div>
            ))}
          </div>

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
            <div className="sb-banner" style={{marginBottom:14}}>⏳ Submitted — awaiting QA review.</div>
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
            <Detail k="Owner (lead)" v={task.owner==="Pending" ? (task.ownerSuggested ? `Pending — ${task.ownerSuggested} (from import)` : "Pending") : task.owner} />
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
              const pending = s.name==="Pending" && s.suggested;
              return (
              <div className="sb-cmt" key={i} style={{display:"flex",alignItems:"center",gap:10}}>
                <span className="sb-av">{initials(pending ? s.suggested : s.name)}</span>
                <span><b>{pending ? "Pending" : s.name}</b>{pending && <span style={{color:"var(--muted)"}}> ({s.suggested})</span>}
                  {" · "}<span style={{color:"var(--muted)"}}>{roleLabel(s.role)}{s.loc?` · ${s.loc}`:""}</span></span>
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
function TaskEditor({ task, users, onClose, onSave, onAuto }) {
  const [f, setF] = useState(task || {
    title:"", type:"Reel", location:"828", owner:users[0]?.name||"", ownerSuggested:"",
    shootDate:"", postDate:"", status:"Planned", priority:"Medium",
    blockedOn:"", brief:"", relatedEvent:"", link:"", notes:"", support:[], links:{},
  });
  const set = (k,v)=>setF(p=>({...p,[k]:v}));
  const valid = f.title.trim() && f.location && f.type && f.owner;
  return (
    <div className="sb-scrim" onClick={onClose}>
      <div className="sb-sheet" onClick={e=>e.stopPropagation()}>
        <div className="hd"><b className="sb-serif" style={{fontSize:18}}>{task?"Edit content":"Plan content"}</b>
          <button className="sb-x" onClick={onClose}>✕</button></div>
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
          <div className="sb-field"><label>Owner — who brings the idea / leads</label>
            <select value={f.owner||"Pending"} onChange={e=>set("owner",e.target.value)}>
              <option value="Pending">Pending — unassigned</option>
              {users.map(u=><option key={u.id}>{u.name}</option>)}</select>
            {f.owner==="Pending" && f.ownerSuggested && (() => {
              const m = matchUser(f.ownerSuggested, users);
              return m
                ? <button type="button" className="link" style={{marginTop:6}}
                    onClick={()=>{ set("owner", m.name); set("ownerSuggested",""); }}>
                    💡 From the sheet this was “{f.ownerSuggested}” — assign {m.name}?</button>
                : <div className="sb-sub" style={{marginTop:6}}>From the sheet: “{f.ownerSuggested}” (no matching account yet)</div>;
            })()}
          </div>
          <div className="sb-field"><label>Creative brief — what are we making &amp; why</label>
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
            <button className="link" onClick={()=>set("support", onAuto(f))}>⚡ Auto-assign</button></div>
          {(f.support||[]).length===0
            ? <div className="sb-sub">No crew yet — tap Auto-assign or add below.</div>
            : (f.support||[]).map((s,i)=>{
              const pending = s.name==="Pending" && s.suggested;
              const m = pending ? matchUser(s.suggested, users) : null;
              return (
              <div className="sb-cmt" key={i} style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <span className="sb-av">{initials(pending ? s.suggested : s.name)}</span>
                <span style={{flex:1,minWidth:0}}>
                  <b>{pending ? "Pending" : s.name}</b>
                  {pending && <span style={{color:"var(--muted)"}}> ({s.suggested})</span>}
                  {" · "}<span style={{color:"var(--muted)"}}>{roleLabel(s.role)}{s.loc?` · ${s.loc}`:""}</span>
                </span>
                {m && <button type="button" className="link"
                  onClick={()=>set("support", f.support.map((x,j)=> j===i ? { name:m.name, role:x.role, ...(x.loc?{loc:x.loc}:{}) } : x))}>
                  assign {m.name}</button>}
                <button className="sb-x" onClick={()=>set("support",f.support.filter((_,j)=>j!==i))}>✕</button>
              </div>
              );
            })}
          <AddCrew users={users} onAdd={(c)=>set("support",[...(f.support||[]),c])} />

          <button className="sb-btn" style={{marginTop:14}} disabled={!valid} onClick={()=>onSave(f)}>{task?"Save changes":"Create task"}</button>
          {!valid && <div className="sb-sub" style={{marginTop:8,textAlign:"center"}}>Title, type, location and owner are required.</div>}
        </div>
      </div>
    </div>
  );
}
function AddCrew({ users, onAdd }) {
  const [n,setN] = useState(users[0]?.name||""); const [r,setR] = useState("shoot");
  useEffect(()=>{ if(!n && users[0]) setN(users[0].name); },[users]); // keep valid default
  return (
    <div className="sb-btnrow" style={{marginTop:8}}>
      <select style={{flex:2,border:"1px solid var(--line)",borderRadius:11,padding:11,background:"var(--card)"}}
        value={n} onChange={e=>setN(e.target.value)}>{users.map(u=><option key={u.id}>{u.name}</option>)}</select>
      <select style={{flex:2,border:"1px solid var(--line)",borderRadius:11,padding:11,background:"var(--card)"}}
        value={r} onChange={e=>setR(e.target.value)}>
        {["shoot","edit","coordinate","design","shadow"].map(x=><option key={x} value={x}>{roleLabel(x)}</option>)}</select>
      <button className="sb-btn compact" disabled={!n} onClick={()=>onAdd({name:n,role:r})}>Add</button>
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
          <button className="sb-x" onClick={onClose}>✕</button></div>
        <div className="bd">
          {isPending && <div className="sb-banner">Set their skills and location, then approve to let them in.</div>}

          <div className="sb-field"><label>Name</label>
            <input value={f.name} onChange={e=>set("name",e.target.value)} /></div>
          <div className="sb-field"><label>Email (login)</label>
            <input value={user.email} disabled style={{opacity:.7}} /></div>

          <div className="sb-field"><label>Access level</label>
            <select value={f.role} onChange={e=>set("role",e.target.value)}>
              <option value="member">Member — can view all tasks</option>
              <option value="admin">Admin — full control</option></select></div>

          <div className="sb-field"><label>Skills (what they can do)</label>
            <div className="sb-seg" style={{flexWrap:"wrap"}}>
              {SK.map(s=>(<button key={s} className={"sb-segbtn"+(f.skills.includes(s)?" on":"")}
                onClick={()=>toggleSkill(s)}>{roleLabel(s)}</button>))}</div></div>

          <div className="sb-field"><label>Service location</label>
            <div className="sb-seg">{["479","828"].map(l=>(
              <button key={l} className={"sb-segbtn"+(f.location.includes(l)?" on":"")} onClick={()=>toggleLoc(l)}>{l}</button>))}</div></div>

          <div className="sb-field"><label>Roles</label>
            <Toggle label="QA reviewer — can approve content & request changes" v={f.qa} on={()=>set("qa",!f.qa)} />
            <Toggle label="Captions & upload — handles posting after approval" v={f.captions} on={()=>set("captions",!f.captions)} />
          </div>

          <div className="sb-field"><label>Special handling</label>
            <Toggle label="Deprioritize — only assign if no one else free" v={f.deprioritize} on={()=>set("deprioritize",!f.deprioritize)} />
            <Toggle label="Coordinate only — can't shoot/edit after church" v={f.limited} on={()=>set("limited",!f.limited)} />
            <Toggle label="Manual schedule — confirm availability each time" v={f.manualSchedule} on={()=>set("manualSchedule",!f.manualSchedule)} />
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
