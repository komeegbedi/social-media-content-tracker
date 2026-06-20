/* Pure logic — no React, no Firebase. Easy to unit-test or reuse. */

// The 5-stage production pipeline. A task's `status` is always one of these.
export const STAGES = ["Planned", "In Progress", "In Review", "Approved", "Posted"];
export const STAGE_SHORT = ["Plan", "Make", "Review", "Approved", "Posted"];

// Preset "next action" chips — what a task is actually waiting on *right now*.
// Stored on the task as `nextAction` (one of these) plus an optional free-text
// `nextActionNote`. Status tells you the stage; nextAction tells a person what
// to actually do, which is the question contributors really ask.
export const NEXT_ACTIONS = [
  "Awaiting approval", "Needs footage", "Needs captions", "Needs revisions", "Ready to post",
];

// Task priority. Defaults to "Medium" so only High (and Low) stand out.
export const PRIORITIES = ["Low", "Medium", "High"];

// status string → CSS class for the coloured status pill.
export const statusClass = (s) =>
  ({ Planned:"st-planned","In Progress":"st-progress","In Review":"st-review",
     Approved:"st-approved",Posted:"st-posted" }[s] || "st-planned");

// priority string → CSS class for the priority flag.
export const priorityClass = (p) =>
  ({ Low:"pri-low", Medium:"pri-med", High:"pri-high" }[p] || "pri-med");

// support-crew role code → human label.
export const roleLabel = (r) =>
  ({ shoot:"Shooting", edit:"Editing", coordinate:"Getting People",
     design:"Graphic Design", shadow:"Shadowing" }[r] || r);

// Content links a task can carry (Drive links, by kind). Required ones must
// be attached before the task can be sent to QA — see requiredLinkKeys().
export const LINK_FIELDS = {
  ig: "Instagram-size graphic",
  landscape: "Landscape-size graphic",
  video: "Video link (Drive)",
  photos: "Photography folder / album",
};
// Content types and their chip colour.
export const TYPES = ["Reel", "Poster", "Photography"];
export const typeClass = (t) =>
  ({ Reel:"chip-reel", Poster:"chip-poster", Photography:"chip-photo" }[t] || "chip-reel");

// Which content links are REQUIRED before content goes to QA, by type.
export function requiredLinkKeys(type) {
  if (type === "Poster") return ["ig", "landscape"];   // Graphic design
  if (type === "Reel") return ["video"];               // Reels / video
  if (type === "Photography") return ["photos"];       // Photography folder
  return [];
}
// Required link keys still missing on a task.
export function missingLinks(task) {
  const links = task.links || {};
  return requiredLinkKeys(task.type).filter((k) => !String(links[k] || "").trim());
}
// Statuses that mean "submitted to QA or beyond" — content must be attached.
export const QA_STATUSES = ["In Review", "Approved", "Posted"];

// ---- activity timeline ----
// One entry per meaningful event on a task. `at` is a millisecond timestamp.
export const activityEntry = (type, by, note = "") => ({ type, by, at: Date.now(), note });
// Human label for an activity entry (approval history is just the QA subset).
export function activityLabel(e) {
  switch (e.type) {
    case "created": return "Created";
    case "qa_sent": return "Sent to QA";
    case "approved": return "Approved";
    case "changes_requested": return "Requested changes";
    case "posted": return "Posted";
    case "status": return `Moved to ${e.note || "next stage"}`;
    case "assigned": return e.note || "Assignment changed";
    case "comment": return "Commented";
    default: return e.type;
  }
}
export const isApprovalEvent = (e) => ["qa_sent", "approved", "changes_requested"].includes(e.type);

// Turn a "next action" into a verb-led to-do for the My Day list,
// e.g. "Needs captions" + "Sunday reel" → "Write captions for Sunday reel".
export const actionVerb = (action, title) =>
  ({ "Needs footage": `Get footage for ${title}`,
     "Needs captions": `Write captions for ${title}`,
     "Needs revisions": `Revise ${title}`,
     "Ready to post": `Post ${title}`,
     "Awaiting approval": `Approve ${title}` }[action] || title);

export const initials = (n="") =>
  n.trim().split(/\s+/).map(w=>w[0]).join("").slice(0,2).toUpperCase() || "?";

export const emailFor = (name="") =>
  name.toLowerCase().replace(/[^a-z]/g,"") + "@ifc.app";

/* ---- dates ---- */
export const today = () => { const d=new Date(); d.setHours(0,0,0,0); return d; };
export const addDays = (n) => { const d=today(); d.setDate(d.getDate()+n); return d; };
export const iso = (d) => d.toISOString().slice(0,10);
export const fmt = (s) => { if(!s) return "—"; const d=new Date(s+"T00:00:00");
  return d.toLocaleDateString(undefined,{month:"short",day:"numeric"}); };
export const daysTo = (s) => { if(!s) return null; const d=new Date(s+"T00:00:00");
  return Math.round((d-today())/86400000); };

/* ---- auto-assign (mirrors the Apps Script rules) ---- */
export function autoAssign(task, users) {
  if (task.type === "Poster") {
    const ownerU = users.find(u => u.name===task.owner);
    const ownerIsDesigner = ownerU && (ownerU.skills||[]).includes("design");
    if (ownerIsDesigner && task.owner!=="David") return [{name:"David",role:"design"}];
    if (!ownerIsDesigner) {
      const d = users.find(u=>u.name==="David") || users.find(u=>(u.skills||[]).includes("design"));
      return d ? [{name:d.name,role:"design"}] : [];
    }
    return [];
  }
  const locs = task.location==="Both" ? ["479","828"] : [task.location];
  const out = []; const load = {}; users.forEach(u=>load[u.name]=0);
  locs.forEach(loc => {
    const used = new Set([task.owner]);
    const pick = (role) => {
      const cands = users.filter(u => {
        const sk = u.skills||[];
        if (used.has(u.name)) return false;
        if (!sk.includes(role)) return false;
        if (sk.includes("design") && !sk.includes("shoot")) return false;
        if (!(u.location||[]).includes(loc)) return false;
        if (u.limited && role!=="coordinate") return false;
        if (u.manualSchedule) return false;
        return true;
      });
      const norm = cands.filter(u=>!u.deprioritize), dep = cands.filter(u=>u.deprioritize);
      norm.sort((a,b)=>load[a.name]-load[b.name]); dep.sort((a,b)=>load[a.name]-load[b.name]);
      const chosen = [...norm,...dep][0];
      if (chosen){ used.add(chosen.name); load[chosen.name]++; return chosen.name; }
      return null;
    };
    const sh=pick("shoot"); if(sh) out.push({name:sh,role:"shoot",loc});
    const ed=pick("edit");  if(ed) out.push({name:ed,role:"edit",loc});
    const co=pick("coordinate"); if(co) out.push({name:co,role:"coordinate",loc});
    const sd=pick("shadow"); if(sd) out.push({name:sd,role:"shadow",loc});
  });
  return out;
}

/* ===================================================================
   CSV / Google Sheet import (tasks only)
   =================================================================== */

/* Parse CSV text into an array of row objects keyed by the header row.
   Handles quoted fields, embedded commas, escaped quotes ("") and
   newlines inside quotes. Returns [] for empty input. */
export function parseCSV(text) {
  const s = (text || "").replace(/^﻿/, ""); // strip BOM
  const rows = []; let row = []; let field = ""; let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] ?? "").trim(); });
    return obj;
  });
}

// Header aliases: maps an app field to the column names we accept, so the
// importer understands both our simple template AND the team's live sheet
// (e.g. "Content Title", "Date to be Posted", "Support Team"). Headers are
// lower-cased by parseCSV before lookup.
const COLS = {
  title: ["title", "content title"],
  type: ["type", "content type"],
  location: ["location", "campus"],
  owner: ["owner"],
  support: ["support team", "support", "crew"],
  status: ["status"],
  shootDate: ["shootdate", "shoot date", "date to be shot"],
  postDate: ["postdate", "post date", "date to be posted", "date"],
  relatedEvent: ["relatedevent", "related event", "event"],
  priority: ["priority"],
  nextAction: ["nextaction", "next action"],
  nextActionNote: ["nextactionnote", "next action note"],
  blockedOn: ["blockedon", "blocked on", "waitingon", "waiting on"],
  brief: ["brief", "creative brief", "description"],
  link: ["link", "links"],
  notes: ["notes", "notes / links", "notes/links"],
  qaStatus: ["qa status", "qa"],
  reviewDate: ["date sent for review", "review date"],
};
const getCol = (row, key) => { for (const a of COLS[key]||[key]) if (row[a] !== undefined) return row[a]; return ""; };
const hasCol = (row, key) => (COLS[key]||[key]).some((a) => row[a] !== undefined);

// Strip invisible/format/control characters (sheets sometimes embed them,
// e.g. U+2068) and collapse whitespace.
export const sanitizeName = (s) =>
  String(s || "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u2029\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/\s+/g, " ").trim();
const normName = (s) => sanitizeName(s).toLowerCase();

// Find the registered user a sheet name most likely refers to. Matches a full
// name, or a first name on either side (the sheet mostly uses first names).
// Powers the "if a Kolade signs up, suggest them for Kolade's tasks" feature.
export function matchUser(name, users = []) {
  const n = normName(name);
  if (!n) return null;
  return users.find((u) => normName(u.name) === n)
    || users.find((u) => normName(u.name).split(" ")[0] === n)
    || users.find((u) => n.split(" ")[0] === normName(u.name).split(" ")[0])
    || null;
}

// "2/15/2026" or "2026-02-15" → "2026-02-15"; anything else → "".
function parseSheetDate(v) {
  const s = String(v || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
}

function mapType(v) {
  const n = String(v || "").toLowerCase();
  if (/photo/.test(n)) return "Photography";
  if (/poster|graphic|flyer|design/.test(n)) return "Poster";
  return "Reel"; // "IG Reel", "Reel", "video", default
}

// Map the sheet's free-form statuses onto the app's 5 pipeline stages.
function mapStatus(v) {
  const n = String(v || "").toLowerCase().trim();
  if (/post/.test(n)) return "Posted";
  if (/review/.test(n)) return "In Review";          // incl. "Completed & In Review"
  if (/approve/.test(n)) return "Approved";
  if (/progress|editing|making|shooting/.test(n)) return "In Progress";
  return STAGES.find((s) => s.toLowerCase() === n) || "Planned"; // "Not Started" etc.
}

// Detect crew roles from a free-text fragment ("shoot and edit", "interview").
function detectRoles(text) {
  const n = String(text || "").toLowerCase();
  const roles = [];
  if (/shoot|film|record/.test(n)) roles.push("shoot");
  if (/edit/.test(n)) roles.push("edit");
  if (/coordinate|get ?people|people|interview/.test(n)) roles.push("coordinate");
  if (/design|graphic/.test(n)) roles.push("design");
  if (/shadow/.test(n)) roles.push("shadow");
  return [...new Set(roles)];
}

// Parse a "Name - role || Name - role" support string into crew entries,
// resolving each name to a registered user where possible. Unknown people
// become { name: "Pending", suggested: "<sheet name>" } so an admin can
// assign them once that person has an account.
export function parseSupport(raw, users = []) {
  const s = sanitizeName(raw);
  if (!s || s === "-") return [];
  const out = [];
  s.split(/\|\|/).forEach((segment) => {
    const seg = segment.trim();
    if (!seg || seg === "-") return;
    const dash = seg.indexOf("-");
    const namesPart = dash >= 0 ? seg.slice(0, dash) : seg;
    let roles = detectRoles(dash >= 0 ? seg.slice(dash + 1) : "");
    if (!roles.length) roles = ["coordinate"];        // sensible default
    namesPart.split(/&|,/).forEach((rawName) => {
      const nm = sanitizeName(rawName);
      if (!nm) return;
      const u = matchUser(nm, users);
      roles.forEach((role) => out.push(u ? { name: u.name, role } : { name: "Pending", role, suggested: nm }));
    });
  });
  return out;
}

/* Map a parsed CSV row to a task, normalising every field to the app's
   schema. Owner / crew that don't match a registered user are imported as
   "Pending" with the original sheet name kept in `ownerSuggested` / each
   crew entry's `suggested`, so admins can assign them later (with matching
   suggestions). Returns { task, error }. */
export function rowToTask(row, users = []) {
  const title = sanitizeName(getCol(row, "title"));
  if (!title) return { task: null, error: "Missing title" };

  const LOCS = ["479", "828", "Both"];
  const locRaw = sanitizeName(getCol(row, "location"));
  const location = LOCS.find((l) => l.toLowerCase() === locRaw.toLowerCase()) || (locRaw || "828");

  const priority = PRIORITIES.find((p) => p.toLowerCase() === getCol(row, "priority").toLowerCase()) || "Medium";
  const nextAction = NEXT_ACTIONS.find((a) => a.toLowerCase() === getCol(row, "nextAction").toLowerCase()) || "";

  // Owner → registered user, else "Pending" (keep the sheet name as a hint).
  const ownerRaw = sanitizeName(getCol(row, "owner"));
  const ownerUser = matchUser(ownerRaw, users);
  const owner = ownerUser ? ownerUser.name : "Pending";
  const ownerSuggested = ownerUser ? "" : ownerRaw;

  // Notes / Links: pull the first URL into `link`, keep the rest as notes,
  // and fold in QA status + review date so nothing from the sheet is lost.
  const notesRaw = getCol(row, "notes");
  const url = (notesRaw.match(/https?:\/\/\S+/) || [])[0] || "";
  const link = (sanitizeName(getCol(row, "link")) || url).trim();
  const qa = sanitizeName(getCol(row, "qaStatus"));
  const reviewDate = sanitizeName(getCol(row, "reviewDate"));
  const notes = [
    notesRaw.replace(/https?:\/\/\S+/g, "").trim(),
    qa ? `QA: ${qa}` : "",
    reviewDate ? `Sent for review: ${reviewDate}` : "",
  ].filter(Boolean).join(" · ");

  const task = {
    title, type: mapType(getCol(row, "type")), location,
    status: mapStatus(getCol(row, "status")),
    owner, ownerSuggested, priority, nextAction,
    nextActionNote: sanitizeName(getCol(row, "nextActionNote")),
    blockedOn: sanitizeName(getCol(row, "blockedOn")),
    brief: getCol(row, "brief").trim(),
    shootDate: parseSheetDate(getCol(row, "shootDate")),
    postDate: parseSheetDate(getCol(row, "postDate")),
    relatedEvent: sanitizeName(getCol(row, "relatedEvent")),
    link, notes,
  };
  // Use the sheet's Support Team if that column exists; otherwise fall back
  // to auto-assigning crew (keeps the simple template working).
  task.support = hasCol(row, "support") ? parseSupport(getCol(row, "support"), users) : autoAssign(task, users);
  return { task, error: null };
}

/* Convert a Google Sheets URL to its CSV-export URL. Pass through any URL
   that already looks like a CSV endpoint. The sheet must be link-shared
   ("Anyone with the link can view") for the fetch to succeed. */
export function sheetCsvUrl(url) {
  const u = (url || "").trim();
  const m = u.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return u;
  const gid = (u.match(/[#&?]gid=([0-9]+)/) || [])[1] || "0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

/* ---- "Needs your attention" (powers the My Day screen) ----
   From a person's active tasks, keep only the ones that genuinely need a look
   right now — due within 2 days, overdue, blocked, awaiting an action, or in
   review — and rank the most urgent first. Returns the task list, most
   urgent first, so My Day can stay a short, focused to-do list. */
export function attentionItems(tasks, me) {
  const mine = (tasks || []).filter((t) =>
    t.status !== "Posted" &&
    (t.owner === me.name || (t.support || []).some((s) => s.name === me.name)));

  // Gate: does this task warrant showing on My Day at all?
  const needsAttention = (t) => {
    const d = daysTo(t.postDate);
    return (d !== null && d <= 2) || !!t.nextAction || !!t.blockedOn || t.status === "In Review";
  };

  // Higher score = more urgent. Drives the sort order.
  const urgency = (t) => {
    const d = daysTo(t.postDate);
    let s = 0;
    if (d !== null && d < 0) s += 100;        // overdue
    else if (d === 0) s += 60;                // due today
    else if (d !== null && d <= 2) s += 40;   // due soon
    if (t.blockedOn) s += 25;                 // blocked — someone needs to unblock it
    if (t.priority === "High") s += 20;
    if (t.nextAction) s += 10;
    if (t.status === "In Review") s += 8;
    return s;
  };

  return mine.filter(needsAttention).sort((a, b) => urgency(b) - urgency(a));
}

/* ---- role-specific dashboards ----
   QA reviewers care about the approval queue, not their personal tasks. */
export function qaQueue(tasks) {
  const all = tasks || [];
  return {
    awaiting: all.filter((t) => t.status === "In Review"),                 // needs approval now
    returned: all.filter((t) => t.status !== "Posted" && t.nextAction === "Needs revisions"),
    approved: all.filter((t) => t.status === "Approved"),                  // recently cleared
  };
}

/* Caption / upload team: their work starts once content is approved. */
export function postQueue(tasks) {
  const live = (tasks || []).filter((t) => t.status !== "Posted");
  return {
    captions: live.filter((t) => t.status === "Approved" && t.nextAction !== "Ready to post"),
    ready: live.filter((t) => t.nextAction === "Ready to post"),
    overdue: live.filter((t) => { const d = daysTo(t.postDate); return t.status === "Approved" && d !== null && d < 0; }),
  };
}

/* ---- import assignment suggestions ----
   Pending tasks (owner/crew imported as "Pending") whose sheet name matches
   a given user — powers "this user may match N pending tasks" after they sign
   up, and the one-click bulk assign. */
export function pendingMatches(user, tasks) {
  return (tasks || []).filter((t) => {
    const ownerMatch = t.owner === "Pending" && t.ownerSuggested && matchUser(t.ownerSuggested, [user]);
    const supMatch = (t.support || []).some((s) => s.name === "Pending" && s.suggested && matchUser(s.suggested, [user]));
    return ownerMatch || supMatch;
  });
}

// Return a copy of `task` with every Pending slot matching `user` filled in.
export function applyAssignment(task, user) {
  const out = { ...task };
  if (task.owner === "Pending" && task.ownerSuggested && matchUser(task.ownerSuggested, [user])) {
    out.owner = user.name; out.ownerSuggested = "";
  }
  out.support = (task.support || []).map((s) =>
    (s.name === "Pending" && s.suggested && matchUser(s.suggested, [user]))
      ? { name: user.name, role: s.role, ...(s.loc ? { loc: s.loc } : {}) }
      : s);
  return out;
}

/* ---- global search ----
   Search across ALL tasks regardless of status (active + archived/posted),
   matching title, related event, owner, crew (incl. pending sheet names),
   type, notes and brief. All whitespace-separated terms must match. */
export function searchTasks(tasks, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const haystack = (t) => [
    t.title, t.relatedEvent, t.owner, t.ownerSuggested, t.type, t.notes, t.brief,
    ...(t.support || []).map((s) => s.name),
    ...(t.support || []).map((s) => s.suggested || ""),
  ].join(" ").toLowerCase();
  return (tasks || []).filter((t) => { const h = haystack(t); return terms.every((term) => h.includes(term)); });
}

/* ===================================================================
   Wins & metrics dashboards (encouragement + visibility, not surveillance)
   =================================================================== */
const inThisMonth = (ms) => {
  if (!ms) return false;
  const d = new Date(ms), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
};
// Most recent activity entry of a given type (uses the timeline from Slice A).
const lastEvent = (t, type) =>
  (t.activity || []).filter((e) => e.type === type).sort((a, b) => b.at - a.at)[0];
const postedThisMonth = (t) => {
  if (t.status !== "Posted") return false;
  const e = lastEvent(t, "posted");
  return e ? inThisMonth(e.at) : false;
};

// A contributor's personal wins.
export function personalWins(tasks, me) {
  const mine = (tasks || []).filter((t) => t.owner === me.name || (t.support || []).some((s) => s.name === me.name));
  return {
    completed: mine.filter((t) => t.status === "Posted").length,
    approved: mine.filter((t) => t.status === "Approved" || t.status === "Posted").length,
    thisMonth: mine.filter(postedThisMonth).length,
    contributions: mine.filter((t) => t.owner !== me.name).length, // supporting others
  };
}

// Whole-team wins.
export function teamWins(tasks) {
  const posted = (tasks || []).filter((t) => t.status === "Posted");
  const byType = (ty) => posted.filter((t) => t.type === ty).length;
  return {
    posted: posted.length,
    reels: byType("Reel"),
    graphics: byType("Poster"),
    photos: byType("Photography"),
    campaigns: new Set(posted.map((t) => t.relatedEvent).filter(Boolean)).size,
  };
}

// Posted-content wins for a given month (offset 0 = this month, -1 = last).
export function monthlyWins(tasks, offset = 0) {
  const ref = new Date(); ref.setDate(1); ref.setMonth(ref.getMonth() + offset);
  const y = ref.getFullYear(), mo = ref.getMonth();
  const inMonth = (ms) => { if (!ms) return false; const d = new Date(ms); return d.getFullYear() === y && d.getMonth() === mo; };
  const posted = (tasks || []).filter((t) => { if (t.status !== "Posted") return false; const e = lastEvent(t, "posted"); return e ? inMonth(e.at) : false; });
  const byType = (ty) => posted.filter((t) => t.type === ty).length;
  return {
    posted: posted.length, reels: byType("Reel"), graphics: byType("Poster"), photos: byType("Photography"),
    campaigns: new Set(posted.map((t) => t.relatedEvent).filter(Boolean)).size,
  };
}

// Recent celebratory moments (most recent posted/approved per task), newest first.
export function recentWins(tasks, limit = 5) {
  const wins = [];
  (tasks || []).forEach((t) => {
    const posted = lastEvent(t, "posted"), approved = lastEvent(t, "approved");
    if (posted) wins.push({ at: posted.at, text: `${t.title} posted${t.relatedEvent ? ` · ${t.relatedEvent}` : ""}` });
    else if (approved) wins.push({ at: approved.at, text: `${t.title} approved` });
  });
  return wins.sort((a, b) => b.at - a.at).slice(0, limit);
}

// Posted-content contributions per person (owner or crew), most first.
export function contributorWins(tasks, users, limit = 6) {
  const count = {};
  (users || []).forEach((u) => { count[u.name] = 0; });
  (tasks || []).filter((t) => t.status === "Posted").forEach((t) => {
    new Set([t.owner, ...(t.support || []).map((s) => s.name)]).forEach((n) => { if (count[n] !== undefined) count[n]++; });
  });
  return Object.entries(count).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, n]) => ({ name, n }));
}

// Visibility metrics for leaders/admins.
export function dashboardMetrics(tasks, users) {
  const all = tasks || [];
  const active = all.filter((t) => t.status !== "Posted");
  const overdue = (t) => { const d = daysTo(t.postDate); return d !== null && d < 0; };
  const upcoming = (t) => { const d = daysTo(t.postDate); return d !== null && d >= 0 && d <= 7; };

  // Average approval time = approved.at − qa_sent.at, across tasks with both.
  const durations = [];
  all.forEach((t) => {
    const q = lastEvent(t, "qa_sent"), a = lastEvent(t, "approved");
    if (q && a && a.at >= q.at) durations.push(a.at - q.at);
  });
  const avgApprovalHours = durations.length
    ? Math.round(durations.reduce((s, x) => s + x, 0) / durations.length / 3600000) : null;

  // Most active = distinct task involvement (owner or crew).
  const load = {};
  (users || []).forEach((u) => { load[u.name] = 0; });
  all.forEach((t) => {
    new Set([t.owner, ...(t.support || []).map((s) => s.name)]).forEach((n) => { if (load[n] !== undefined) load[n]++; });
  });
  const mostActive = Object.entries(load).filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, n }));

  return {
    completedThisMonth: all.filter(postedThisMonth).length,
    awaiting: all.filter((t) => t.status === "In Review").length,
    overdue: active.filter(overdue).length,
    upcoming: active.filter(upcoming).length,
    avgApprovalHours,
    mostActive,
  };
}

/* ---- capacity ---- */
export function computeCapacity(tasks, users) {
  const cap = {};
  users.forEach(u => cap[u.name]={shoot:0,edit:0,coordinate:0,design:0,shadow:0,total:0});
  tasks.forEach(t => {
    if (t.status==="Posted") return;
    (t.support||[]).forEach(s => {
      if (!cap[s.name]) return;
      cap[s.name][s.role]=(cap[s.name][s.role]||0)+1;
      cap[s.name].total++;
    });
  });
  return cap;
}
