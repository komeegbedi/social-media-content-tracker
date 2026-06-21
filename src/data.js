/* Pure logic — no React, no Firebase. Easy to unit-test or reuse. */

// The full 7-stage content workflow. A task's `status` is always one of these.
// "Changes Requested" and "Ready to Post" are first-class statuses — they mark
// real handoffs between departments (owner ↔ QA ↔ caption/upload team).
export const STAGES = [
  "Planned", "In Progress", "In Review", "Changes Requested", "Approved", "Ready to Post", "Posted",
];

// For the progress bar, the 7 statuses group into 4 human phases.
export const PHASES = ["Planning", "Creating", "Review", "Posting"];
export const statusPhase = (s) =>
  ({ "Planned":0, "In Progress":1, "Changes Requested":1, "In Review":2,
     "Approved":2, "Ready to Post":3, "Posted":3 }[s] ?? 0);

// The system-driven next step for a status — "who owns the next action".
// Shown as small secondary text; the status itself is the dominant signal.
export const nextStep = (status) =>
  ({ "Planned": "Start creating the content",
     "In Progress": "Submit content for QA",
     "In Review": "Awaiting QA approval",
     "Changes Requested": "Revise & resubmit for QA",
     "Approved": "Write the caption",
     "Ready to Post": "Post to Instagram",
     "Posted": "Done — posted" }[status] || "");

// Task priority. Defaults to "Medium" so only High (and Low) stand out.
export const PRIORITIES = ["Low", "Medium", "High"];

// status string → CSS class for the coloured status pill.
export const statusClass = (s) =>
  ({ "Planned":"st-planned", "In Progress":"st-progress", "In Review":"st-review",
     "Changes Requested":"st-changes", "Approved":"st-approved",
     "Ready to Post":"st-ready", "Posted":"st-posted" }[s] || "st-planned");

// priority string → CSS class for the priority flag.
export const priorityClass = (p) =>
  ({ Low:"pri-low", Medium:"pri-med", High:"pri-high" }[p] || "pri-med");

// A concise label for an unfilled support slot — "Pending editor" rather than
// repeating "Pending (Name) · Getting People" everywhere.
const PENDING_ROLE = { shoot: "shooter", edit: "editor", coordinate: "coordinator", design: "designer", shadow: "shadow" };
export const pendingRoleLabel = (role) => PENDING_ROLE[role] ? `Pending ${PENDING_ROLE[role]}` : "Pending assignment";

// How many tasks are tied to an event (loose token match on relatedEvent),
// so Upcoming can show "1 content item planned" vs "no content assigned".
export function eventContentCount(eventName, tasks) {
  const tokens = (eventName || "").toLowerCase().split(/\W+/)
    .filter((w) => w.length > 3 && !["pastor", "birthday", "conference"].includes(w));
  if (!tokens.length) return 0;
  return (tasks || []).filter((t) =>
    tokens.some((tok) => (t.relatedEvent || "").toLowerCase().includes(tok))).length;
}

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
    case "started": return "Started work";
    case "qa_sent": return "Sent to QA";
    case "approved": return "Approved";
    case "changes_requested": return "Requested changes";
    case "ready": return "Marked ready to post";
    case "posted": return "Posted";
    case "status": return `Moved to ${e.note || "next stage"}`;
    case "assigned": return e.note || "Assignment changed";
    case "comment": return "Commented";
    default: return e.type;
  }
}
export const isApprovalEvent = (e) =>
  ["qa_sent", "approved", "changes_requested", "ready", "started"].includes(e.type);

/* The single guided action this user can take next, given the task's status
   and their role — the heart of the system-driven workflow. Returns
   { label, to, kind, requiresLinks?, needsCaption?, needsPostLink? } or null
   (no action for this person right now; e.g. they're waiting on someone else).
   QA approve / request-changes is handled by its own panel, not here. */
export function workflowAction(task, me) {
  const isOwner = task.owner === me.name;
  const isCaption = !!me.captions || me.role === "admin";
  const isAdmin = me.role === "admin";
  const mine = isOwner || isAdmin;
  switch (task.status) {
    case "Planned":
      return mine ? { label: "Start work", to: "In Progress", kind: "started" } : null;
    case "In Progress":
      return mine ? { label: "Submit for QA", to: "In Review", kind: "qa_sent", requiresLinks: true } : null;
    case "Changes Requested":
      return mine ? { label: "Resubmit for QA", to: "In Review", kind: "qa_sent", requiresLinks: true } : null;
    case "Approved":
      return isCaption ? { label: "Mark ready to post", to: "Ready to Post", kind: "ready", needsCaption: true } : null;
    case "Ready to Post":
      return isCaption ? { label: "Mark as posted", to: "Posted", kind: "posted", needsPostLink: true } : null;
    default: // In Review (QA panel), Posted (done)
      return null;
  }
}

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
// Stable key for remembering an admin-confirmed name → user mapping.
export const matchKey = (s) => normName(s);

const ratio = (a, b) => Math.min(a, b) / Math.max(a, b);

/* Intelligently guess which registered user a (often shortened/alternate) name
   refers to — "Kome" → Oghenekome Egbedi, "Dola" → Dolabomi Bello. Returns
   { user, confidence (0–1), reason } or null. `mappings` is the remembered
   { matchKey(csvName): userName } map an admin has confirmed before. */
export function matchUserScored(name, users = [], mappings = {}) {
  const n = normName(name);
  if (!n) return null;
  const find = (pred) => users.find(pred);

  // 1. A previously confirmed manual mapping wins outright.
  const remembered = mappings[n];
  if (remembered) {
    const u = find((x) => normName(x.name) === normName(remembered));
    if (u) return { user: u, confidence: 1, reason: "remembered" };
  }
  // 2. Exact full name.
  let u = find((x) => normName(x.name) === n);
  if (u) return { user: u, confidence: 1, reason: "exact name" };
  // 3. Email — value is an email, or matches a user's email handle.
  if (n.includes("@")) {
    u = find((x) => normName(x.email) === n);
    if (u) return { user: u, confidence: 0.98, reason: "email" };
  }
  u = find((x) => (x.email || "").toLowerCase().split("@")[0] === n);
  if (u) return { user: u, confidence: 0.92, reason: "email handle" };

  const csvFirst = n.split(" ")[0];
  const csvTokens = n.split(" ").filter(Boolean);

  // 4. Exact first name.
  u = find((x) => normName(x.name).split(" ")[0] === csvFirst);
  if (u) return { user: u, confidence: 0.9, reason: "first name" };

  // 5. Contained / partial token — handles Kome⊂Oghenekome, Dola⊂Dolabomi.
  let best = null;
  for (const x of users) {
    for (const tok of normName(x.name).split(" ").filter(Boolean)) {
      if (csvFirst.length < 3 || tok.length < 3) continue;
      let conf = 0, why = "partial name";
      if (tok === csvFirst) { conf = 0.9; why = "first name"; }
      else if (tok.startsWith(csvFirst) || csvFirst.startsWith(tok)) conf = 0.72 + 0.18 * ratio(tok.length, csvFirst.length);
      else if (tok.includes(csvFirst) || csvFirst.includes(tok)) conf = 0.64 + 0.18 * ratio(tok.length, csvFirst.length);
      if (conf > (best?.confidence || 0)) best = { user: x, confidence: Math.round(conf * 100) / 100, reason: why };
    }
  }
  // 6. Initials — "OE" → Oghenekome Egbedi.
  if ((!best || best.confidence < 0.75) && csvTokens.length === 1 && /^[a-z]{2,4}$/.test(csvFirst)) {
    u = find((x) => normName(x.name).split(" ").map((t) => t[0]).join("") === csvFirst);
    if (u && 0.78 > (best?.confidence || 0)) best = { user: u, confidence: 0.78, reason: "initials" };
  }
  return best && best.confidence >= 0.6 ? best : null;
}

// Auto-resolve a name to a user only when we're confident (exact, remembered,
// email, or exact first name ≥0.9). Fuzzy/partial guesses are left "Pending"
// so the import reconciliation UI can confirm them before assigning.
export function matchUser(name, users = [], mappings = {}) {
  const m = matchUserScored(name, users, mappings);
  return m && m.confidence >= 0.9 ? m.user : null;
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
export function parseSupport(raw, users = [], mappings = {}) {
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
      const u = matchUser(nm, users, mappings);
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
export function rowToTask(row, users = [], mappings = {}) {
  const title = sanitizeName(getCol(row, "title"));
  if (!title) return { task: null, error: "Missing title" };

  const LOCS = ["479", "828", "Both"];
  const locRaw = sanitizeName(getCol(row, "location"));
  const location = LOCS.find((l) => l.toLowerCase() === locRaw.toLowerCase()) || (locRaw || "828");

  const priority = PRIORITIES.find((p) => p.toLowerCase() === getCol(row, "priority").toLowerCase()) || "Medium";

  // Owner → registered user, else "Pending" (keep the sheet name as a hint).
  const ownerRaw = sanitizeName(getCol(row, "owner"));
  const ownerUser = matchUser(ownerRaw, users, mappings);
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
    owner, ownerSuggested, priority,
    blockedOn: sanitizeName(getCol(row, "blockedOn")),
    brief: getCol(row, "brief").trim(),
    shootDate: parseSheetDate(getCol(row, "shootDate")),
    postDate: parseSheetDate(getCol(row, "postDate")),
    relatedEvent: sanitizeName(getCol(row, "relatedEvent")),
    link, notes,
  };
  // Use the sheet's Support Team if that column exists; otherwise fall back
  // to auto-assigning crew (keeps the simple template working).
  task.support = hasCol(row, "support") ? parseSupport(getCol(row, "support"), users, mappings) : autoAssign(task, users);
  return { task, error: null };
}

/* Collect the distinct still-"Pending" names across parsed import rows (owner +
   crew), each with the best-guess match — drives the import reconciliation UI.
   Returns [{ name, key, user, confidence, reason }] (only names with a guess). */
export function reconcileNames(rows, users = [], mappings = {}) {
  const seen = new Map();
  for (const r of rows || []) {
    const t = r.task; if (!t) continue;
    const names = [];
    if (t.owner === "Pending" && t.ownerSuggested) names.push(t.ownerSuggested);
    (t.support || []).forEach((s) => { if (s.name === "Pending" && s.suggested) names.push(s.suggested); });
    for (const nm of names) {
      const key = matchKey(nm);
      if (!key || seen.has(key)) continue;
      const m = matchUserScored(nm, users, mappings);
      if (m) seen.set(key, { name: nm, key, user: m.user, confidence: m.confidence, reason: m.reason });
    }
  }
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
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

  // Statuses where the owner/crew clearly has the ball.
  const owesAction = (t) => ["In Progress", "Changes Requested", "Ready to Post"].includes(t.status);

  // Gate: does this task warrant showing on My Day at all?
  const needsAttention = (t) => {
    const d = daysTo(t.postDate);
    return (d !== null && d <= 2) || !!t.blockedOn || owesAction(t) || t.status === "In Review";
  };

  // Higher score = more urgent. Drives the sort order.
  const urgency = (t) => {
    const d = daysTo(t.postDate);
    let s = 0;
    if (d !== null && d < 0) s += 100;        // overdue
    else if (d === 0) s += 60;                // due today
    else if (d !== null && d <= 2) s += 40;   // due soon
    if (t.status === "Changes Requested") s += 30; // bounced back — act now
    if (t.blockedOn) s += 25;                 // blocked — someone needs to unblock it
    if (t.priority === "High") s += 20;
    if (owesAction(t)) s += 10;
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
    awaiting: all.filter((t) => t.status === "In Review"),          // needs approval now
    returned: all.filter((t) => t.status === "Changes Requested"),  // sent back, awaiting revision
    approved: all.filter((t) => t.status === "Approved"),           // recently cleared
  };
}

/* Caption / upload team: their work starts once content is approved. */
export function postQueue(tasks) {
  const live = (tasks || []).filter((t) => t.status !== "Posted");
  return {
    captions: live.filter((t) => t.status === "Approved"),       // approved → needs a caption
    ready: live.filter((t) => t.status === "Ready to Post"),     // caption done → post it
    overdue: live.filter((t) => { const d = daysTo(t.postDate); return (t.status === "Approved" || t.status === "Ready to Post") && d !== null && d < 0; }),
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
    t.status, t.location, t.caption, t.link, t.postLink,
    ...Object.values(t.links || {}),
    ...(t.support || []).map((s) => s.name),
    ...(t.support || []).map((s) => s.suggested || ""),
  ].join(" ").toLowerCase();
  return (tasks || []).filter((t) => { const h = haystack(t); return terms.every((term) => h.includes(term)); });
}

/* People search — for the global "find anything" search + People page. */
export function searchPeople(users, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const haystack = (u) => [
    u.name, u.email, u.role, u.status, u.department,
    ...(u.skills || []), ...(u.location || []),
  ].join(" ").toLowerCase();
  return (users || []).filter((u) => { const h = haystack(u); return terms.every((term) => h.includes(term)); });
}

/* ===================================================================
   People management (Admin → People)
   =================================================================== */
export const DEPARTMENTS = [
  "Graphic Design", "Content Creation", "Videography", "Photography", "Caption & Upload", "QA",
];

// Permission/role chips shown on a person card.
export function roleChips(user) {
  const chips = [];
  if (user.role === "admin") chips.push("Admin");
  if (user.lead) chips.push("Lead");
  if (user.qa) chips.push("QA");
  if (user.captions) chips.push("Captions");
  if (!chips.length) chips.push("Member");
  return chips;
}

// How many active (non-Posted) tasks a person owns or is crew on.
export function userActiveTasks(user, tasks) {
  return (tasks || []).filter((t) => t.status !== "Posted" &&
    (t.owner === user.name || (t.support || []).some((s) => s.name === user.name))).length;
}

export const PEOPLE_FILTERS = [
  { id: "all",      label: "All",            test: () => true },
  { id: "admins",   label: "Admins",         test: (u) => u.role === "admin" },
  { id: "leads",    label: "Leads",          test: (u) => !!u.lead },
  { id: "qa",       label: "QA",             test: (u) => !!u.qa },
  { id: "captions", label: "Captions",       test: (u) => !!u.captions },
  { id: "479",      label: "479",            test: (u) => (u.location || []).includes("479") },
  { id: "828",      label: "828",            test: (u) => (u.location || []).includes("828") },
  { id: "nodept",   label: "No department",  test: (u) => !u.department },
];

export function applyPeopleFilter(users, id) {
  const f = PEOPLE_FILTERS.find((x) => x.id === id) || PEOPLE_FILTERS[0];
  return (users || []).filter(f.test);
}

// Group approved team members for scanning. One bucket each, by priority:
// Admins → Department Leads → each department → No department.
export function groupPeople(users) {
  const out = [];
  const used = new Set();
  const take = (label, pred) => {
    const items = (users || []).filter((u) => !used.has(u.id) && pred(u));
    items.forEach((u) => used.add(u.id));
    if (items.length) out.push({ label, items });
  };
  take("Admins", (u) => u.role === "admin");
  take("Department Leads", (u) => u.lead);
  DEPARTMENTS.forEach((d) => take(d, (u) => u.department === d));
  take("No department", () => true);
  return out;
}

/* ===================================================================
   Board organization — grouping, sorting, filtering
   =================================================================== */

// Firestore Timestamp / Date / millis → comparable millis (0 if missing).
const tsMillis = (v) =>
  !v ? 0
  : typeof v === "number" ? v
  : typeof v.toMillis === "function" ? v.toMillis()
  : typeof v.seconds === "number" ? v.seconds * 1000
  : new Date(v).getTime() || 0;

export const BOARD_SORTS = [
  { id: "post-asc",    label: "Post date · soonest first" },
  { id: "post-desc",   label: "Post date · latest first" },
  { id: "created-desc",label: "Newest created" },
  { id: "created-asc", label: "Oldest created" },
  { id: "priority",    label: "Priority · High → Low" },
  { id: "updated",     label: "Recently updated" },
  { id: "owner",       label: "Owner · A → Z" },
];

const PRI_RANK = { High: 0, Medium: 1, Low: 2 };
const dueRank = (t) => { const d = daysTo(t.postDate); return d == null ? Infinity : d; };

export function sortTasks(list, sortId = "post-asc") {
  const arr = [...(list || [])];
  switch (sortId) {
    case "post-desc":    return arr.sort((a, b) => dueRank(b) - dueRank(a));
    case "created-desc": return arr.sort((a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt));
    case "created-asc":  return arr.sort((a, b) => tsMillis(a.createdAt) - tsMillis(b.createdAt));
    case "priority":     return arr.sort((a, b) =>
      (PRI_RANK[a.priority] ?? 1) - (PRI_RANK[b.priority] ?? 1) || dueRank(a) - dueRank(b));
    case "updated":      return arr.sort((a, b) => tsMillis(b.updatedAt) - tsMillis(a.updatedAt));
    case "owner":        return arr.sort((a, b) =>
      String(a.owner || "").localeCompare(String(b.owner || "")) || dueRank(a) - dueRank(b));
    case "post-asc":
    default:             return arr.sort((a, b) => dueRank(a) - dueRank(b));
  }
}

// Group a (already filtered + sorted) list into STAGES order, skipping empties.
export function groupByStatus(list) {
  return STAGES
    .map((status) => ({ status, items: (list || []).filter((t) => t.status === status) }))
    .filter((g) => g.items.length > 0);
}

const isOwner = (t, me) => !!me && t.owner === me.name;
const isCrew  = (t, me) => !!me && (t.support || []).some((s) => s.name === me.name);

/* Board filters — kept deliberately small so the board reads at a glance.
   The board is for "where is everything?"; "what's mine?" lives on My Work.
   Each `test(task, me)` is a pure predicate; "all" returns everything. */
export const BOARD_FILTERS = [
  { id: "all",      label: "All",            test: () => true },
  { id: "reel",     label: "Reels",          test: (t) => t.type === "Reel" },
  { id: "poster",   label: "Posters",        test: (t) => t.type === "Poster" },
  { id: "479",      label: "479",            test: (t) => t.location === "479" || t.location === "Both" },
  { id: "828",      label: "828",            test: (t) => t.location === "828" || t.location === "Both" },
  { id: "high",     label: "High priority",  test: (t) => t.priority === "High" },
  { id: "overdue",  label: "Overdue",        test: (t) => t.status !== "Posted" && (daysTo(t.postDate) ?? 99) < 0 },
  { id: "review",   label: "In Review",      test: (t) => t.status === "In Review" },
  { id: "ready",    label: "Ready to Post",  test: (t) => t.status === "Ready to Post" },
  { id: "approved", label: "Approved",       test: (t) => t.status === "Approved" },
  { id: "archive",  label: "Archive",        test: (t) => t.status === "Posted" },
];

export function applyBoardFilter(tasks, filterId, me) {
  const f = BOARD_FILTERS.find((x) => x.id === filterId) || BOARD_FILTERS[0];
  return (tasks || []).filter((t) => f.test(t, me));
}

/* My Work, organized by URGENCY (not by lead/support). Each task lands in
   exactly one section — the first it qualifies for, top-down — so overdue and
   due-soon work always floats above status buckets. Answers "what should I
   work on next?" rather than "here are all my assignments." */
export function myWorkSections(tasks, me) {
  const mine = (tasks || []).filter((t) => isOwner(t, me) || isCrew(t, me));
  const used = new Set();
  const take = (pred) => {
    const out = sortTasks(mine.filter((t) => !used.has(t.id) && pred(t)), "post-asc");
    out.forEach((t) => used.add(t.id));
    return out;
  };
  const active = (t) => t.status !== "Posted";
  const due = (t) => daysTo(t.postDate);
  const sections = [
    { key: "overdue",  label: "Overdue",           items: take((t) => active(t) && (due(t) ?? 99) < 0) },
    { key: "soon",     label: "Due soon",          items: take((t) => active(t) && due(t) != null && due(t) >= 0 && due(t) <= 7) },
    { key: "changes",  label: "Changes requested", items: take((t) => t.status === "Changes Requested") },
    { key: "ready",    label: "Ready to post",     items: take((t) => t.status === "Ready to Post") },
    { key: "review",   label: "In review",         items: take((t) => t.status === "In Review") },
    { key: "approved", label: "Approved",          items: take((t) => t.status === "Approved") },
    { key: "progress", label: "In progress",       items: take((t) => t.status === "In Progress") },
    { key: "planned",  label: "Planned",           items: take((t) => t.status === "Planned") },
    { key: "posted",   label: "Posted",            items: take((t) => t.status === "Posted") },
  ];
  return sections.filter((s) => s.items.length > 0);
}

// The current viewer's role on a task — for the "Lead"/"Support" card chip.
export function myRole(task, me) {
  if (!me) return null;
  if (task.owner === me.name) return "Lead";
  if ((task.support || []).some((s) => s.name === me.name)) return "Support";
  return null;
}

/* ===================================================================
   Admin control-centre — "what needs leadership attention?"
   =================================================================== */
const isActive = (t) => t.status !== "Posted";
const noOwner  = (t) => !t.owner || t.owner === "Pending";
const noCrew   = (t) => !((t.support || []).length);
const isOverdue = (t) => isActive(t) && (daysTo(t.postDate) ?? 99) < 0;
const isBlocked = (t) => isActive(t) && !!(t.blockedOn && t.blockedOn.trim());

// At-a-glance health counts for the Overview cards. Each maps to a Content
// filter (or the People tab) so the cards double as shortcuts.
export function adminHealth(tasks, users) {
  return {
    pendingUsers: (users || []).filter((u) => u.status === "pending").length,
    awaitingQA:   (tasks || []).filter((t) => t.status === "In Review").length,
    blocked:      (tasks || []).filter(isBlocked).length,
    overdue:      (tasks || []).filter(isOverdue).length,
    ready:        (tasks || []).filter((t) => t.status === "Ready to Post").length,
    unassigned:   (tasks || []).filter((t) => isActive(t) && (noOwner(t) || noCrew(t))).length,
  };
}

// The things only an admin can resolve — overdue, blocked, bounced-back,
// or missing an owner/crew. Deduped, soonest-due first.
export function adminNeedsAttention(tasks) {
  return sortTasks((tasks || []).filter((t) => isActive(t) && (
    isOverdue(t) || isBlocked(t) || t.status === "Changes Requested" || noOwner(t) || noCrew(t)
  )), "post-asc");
}

export function adminUnassigned(tasks) {
  return sortTasks((tasks || []).filter((t) => isActive(t) && (noOwner(t) || noCrew(t))), "post-asc");
}

export function recentContent(tasks, limit = 6) {
  return [...(tasks || [])].sort((a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt)).slice(0, limit);
}

// Things that can advance with a nudge — healthy work in the pipeline.
export function adminReadyToMove(tasks) {
  return sortTasks((tasks || []).filter((t) =>
    ["In Review", "Approved", "Ready to Post"].includes(t.status)), "post-asc");
}

// A cross-task activity feed for the leadership dashboard: who did what, newest
// first. Reads each task's activity[] timeline.
const ACTIVITY_VERB = {
  created: "created", started: "started", qa_sent: "sent for review",
  approved: "approved", changes_requested: "requested changes on",
  ready: "marked ready", posted: "posted", status: "updated",
  assigned: "reassigned", comment: "commented on",
};
export function recentActivity(tasks, limit = 8) {
  const out = [];
  for (const t of tasks || []) {
    for (const e of t.activity || []) {
      out.push({ taskId: t.id, title: t.title, who: e.by, type: e.type,
                 verb: ACTIVITY_VERB[e.type] || e.type, at: e.at || 0 });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

// A one-line "what's wrong" for an admin card — blocker first, then the most
// pressing gap. Null when nothing needs intervention.
export function taskProblem(t) {
  if (isBlocked(t)) return `Waiting on ${t.blockedOn}`;
  if (isActive(t)) {
    if (noOwner(t)) return "No owner assigned";
    if (noCrew(t))  return "No crew assigned";
    if (isOverdue(t)) return "Past its post date";
  }
  return null;
}

/* Admin content filters — admins care about what's stuck/broken, not type. */
export const ADMIN_FILTERS = [
  { id: "all",       label: "All",               test: () => true },
  { id: "needowner", label: "Needs owner",       test: (t) => isActive(t) && noOwner(t) },
  { id: "needcrew",  label: "Needs crew",        test: (t) => isActive(t) && noCrew(t) },
  { id: "qa",        label: "Awaiting QA",       test: (t) => t.status === "In Review" },
  { id: "changes",   label: "Changes requested", test: (t) => t.status === "Changes Requested" },
  { id: "ready",     label: "Ready to post",     test: (t) => t.status === "Ready to Post" },
  { id: "overdue",   label: "Overdue",           test: isOverdue },
  { id: "blocked",   label: "Blocked",           test: isBlocked },
  { id: "archived",  label: "Archived",          test: (t) => t.status === "Posted" },
];

export function applyAdminFilter(tasks, id) {
  const f = ADMIN_FILTERS.find((x) => x.id === id) || ADMIN_FILTERS[0];
  return (tasks || []).filter(f.test);
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
