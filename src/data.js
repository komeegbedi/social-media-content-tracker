/* Pure logic — no React, no Firebase. Easy to unit-test or reuse. */

// The full 7-stage content workflow. A task's `status` is always one of these.
// "Changes Requested" and "Ready to Post" are first-class statuses — they mark
// real handoffs between departments (owner ↔ QA ↔ caption/upload team).
export const STAGES = [
  "Planned", "In Progress", "In Review", "Changes Requested", "Approved", "Ready to Post", "Posted",
];

// Email format validation (client). Trims, rejects missing @ / domain,
// spaces, and multiple @. Mirrors the server-side EMAIL_RE in emailService.
// Not a deliverability guarantee — format only.
export function isValidEmail(raw) {
  const e = (raw || "").trim();
  if (!e || /\s/.test(e)) return false;
  if ((e.match(/@/g) || []).length !== 1) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// A stored link must be a real http(s) URL — never plain text. Used to guard
// every URL input (content links, deliverables, references, drive links, etc.).
export function isValidUrl(raw) {
  const s = (raw || "").trim();
  if (!s || /\s/.test(s)) return false;
  if (!/^https?:\/\//i.test(s)) return false;         // must start http:// or https://
  try { const u = new URL(s); return !!u.hostname && u.hostname.includes("."); }
  catch { return false; }
}

// Reminder-schedule building blocks (v1.1). Mirrors the server default in
// functions/lib.js; the server falls back to this if settings aren't set.
export const REMINDER_CHANNELS = ["in-app", "push", "email"];
export const REMINDER_RECIPIENTS = ["owner", "crew", "lead", "admins"];
export const MAX_REMINDERS = 10;
export const DEFAULT_REMINDERS = [
  { id: "d1", offset: 7, when: "before", channels: [...REMINDER_CHANNELS], recipients: ["owner", "crew"], enabled: true },
  { id: "d2", offset: 3, when: "before", channels: [...REMINDER_CHANNELS], recipients: ["owner", "crew"], enabled: true },
  { id: "d3", offset: 1, when: "before", channels: [...REMINDER_CHANNELS], recipients: ["owner", "crew"], enabled: true },
  { id: "d4", offset: 3, when: "after",  channels: [...REMINDER_CHANNELS], recipients: ["owner", "admins"], enabled: true },
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
     "Approved": "Mark ready to post",
     "Ready to Post": "Post to Instagram",
     "Posted": "Done, posted" }[status] || "");

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

// Tasks tied to a SPECIFIC event occurrence. Primary match is the structured
// `relatedEventOccurrenceId` so a recurring event's July content never counts
// under its August occurrence. For annual events (birthdays/holidays) we keep a
// loose name-token fallback so legacy content (linked before occurrence ids
// existed) still shows — that's safe because there's only one per year.
export function occurrenceTasks(occ, tasks) {
  if (!occ) return [];
  const tokens = occ.annual
    ? (occ.name || "").toLowerCase().split(/\W+/)
        .filter((w) => w.length > 3 && !["pastor", "birthday", "conference"].includes(w))
    : [];
  return (tasks || []).filter((t) => {
    if (t.relatedEventOccurrenceId) return t.relatedEventOccurrenceId === occ.eventOccurrenceId;
    if (!tokens.length) return false;
    return tokens.some((tok) => (t.relatedEvent || "").toLowerCase().includes(tok));
  });
}

// How many tasks are planned for an event occurrence, so Upcoming can show
// "1 content item planned" vs "no content assigned".
export function occurrenceContentCount(occ, tasks) {
  return occurrenceTasks(occ, tasks).length;
}

// support-crew role code → human label.
export const roleLabel = (r) =>
  ({ shoot:"Shooting", edit:"Editing", coordinate:"Getting People",
     design:"Graphic Design", shadow:"Shadowing", other:"Other",
     contentlead:"Content Lead", leaddesign:"Lead Designer" }[r] || r);

// When a piece of content is saved with NO production team, the owner takes on the
// lead role themselves. Graphics (Poster) → Lead Designer; everything else
// (Reel/Video, Photography) → Content Lead. Used by the "produce it alone?"
// confirmation to add the owner as the sole crew member.
export const soloCrewRole = (type) => (type === "Poster" ? "leaddesign" : "contentlead");
export function soloCrewFor(type, ownerName) {
  return { name: ownerName, role: soloCrewRole(type) };
}
// The verb used in the solo-owner warning, by type ("designing this graphic"
// vs "producing this reel").
export const soloCrewVerb = (type) =>
  type === "Poster" ? "designing this graphic"
  : type === "Photography" ? "shooting this content"
  : "producing this reel";

// The crew task picker; "other" carries a free-text custom label on the entry.
export const CREW_ROLES = ["shoot", "edit", "coordinate", "design", "shadow", "other"];

// Production order for DISPLAYING a task's team (owner is rendered separately,
// above these). Used everywhere a crew list is shown so the order is consistent.
export const CREW_ORDER = ["shoot", "edit", "design", "coordinate", "shadow", "other"];
export const crewOrderIndex = (role) => {
  const i = CREW_ORDER.indexOf(role);
  return i < 0 ? CREW_ORDER.length : i;
};
// Sort crew into production order while preserving each entry's ORIGINAL index
// (callers mutate by index, so identity must survive the sort).
export function orderedCrew(support) {
  return (support || [])
    .map((s, i) => ({ s, i }))
    .sort((a, b) => crewOrderIndex(a.s && a.s.role) - crewOrderIndex(b.s && b.s.role));
}

// Human label for a support-crew entry — shows the custom label for "Other".
export function crewRoleLabel(s) {
  if (s && s.role === "other") return (s.label || "").trim() || "Other";
  return roleLabel(s && s.role);
}
// Same, for an unfilled (Pending) slot: "Pending editor" / "Pending · Voiceover".
export const pendingCrewLabel = (s) =>
  s && s.role === "other"
    ? `Pending · ${(s.label || "").trim() || "Other"}`
    : pendingRoleLabel(s && s.role);

// Content links a task can carry (Drive links, by kind). Required ones must
// be attached before the task can be sent to QA — see requiredLinkKeys().
export const LINK_FIELDS = {
  ig: "Instagram-size graphic",
  landscape: "Landscape-size graphic",
  video: "Video link (Drive)",
  photos: "Photography folder / album",
};
// Content types and their chip colour. Shoot-based types (Reel, Photography)
// need a shoot date + location; the rest (Poster) are design/graphics.
export const TYPES = ["Reel", "Poster", "Photography"];
export const SHOOT_TYPES = ["Reel", "Photography"];
export const isShootType = (t) => SHOOT_TYPES.includes(t);
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
   { label, to, kind, requiresLinks?, needsPostLink? } or null
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
      return isCaption ? { label: "Mark ready to post", to: "Ready to Post", kind: "ready" } : null;
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
export const fmt = (s) => { if(!s) return "-"; const d=new Date(s+"T00:00:00");
  return d.toLocaleDateString(undefined,{month:"short",day:"numeric"}); };
export const daysTo = (s) => { if(!s) return null; const d=new Date(s+"T00:00:00");
  return Math.round((d-today())/86400000); };

/* ---- date validation ------------------------------------------------------
   Rules the planner enforces before a piece of content can be saved. Pure and
   timezone-safe: `iso()` goes through UTC, which lands on the wrong day for
   anyone east of Greenwich, so scheduling compares local calendar days. */
export const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day — rejects "2026-02-31", which Date() silently rolls over.
export const isRealDate = (s) => {
  if (!DATE_RE.test(s || "")) return false;
  const [y, m, day] = s.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  return d.getFullYear() === y && d.getMonth() === m - 1 && d.getDate() === day;
};
// Years beyond this are almost certainly a typo ("2206") rather than a plan.
const MAX_YEARS_AHEAD = 3;

/* Returns the first blocking problem with a form's dates, or "".
   `original` is the task as last saved: a date that was ALREADY in the past
   when the editor opened must not block unrelated edits — only dates the user
   actually sets or changes are held to "not before today". */
export function dateIssues(form, original) {
  const f = form || {}, o = original || {};
  const shoot = f.shootDate || "", post = f.postDate || "";
  const isShoot = isShootType(f.type);

  for (const [val, label] of [[shoot, "Shoot date"], [post, "Post date"]]) {
    if (val && !isRealDate(val)) return `${label} isn't a real date.`;
  }
  // Shoot date only applies to shoot-based content.
  if (isShoot && shoot && post && post < shoot)
    return "Post date must be on or after the shoot date.";

  const t = todayStr();
  if (shoot && isShoot && shoot !== o.shootDate && shoot < t)
    return "Shoot date can't be in the past.";
  if (post && post !== o.postDate && post < t)
    return "Post date can't be in the past.";

  const maxYear = new Date().getFullYear() + MAX_YEARS_AHEAD;
  for (const [val, label] of [[shoot, "shoot date"], [post, "post date"]]) {
    if (val && Number(val.slice(0, 4)) > maxYear) return `Check the year on the ${label}.`;
  }
  return "";
}
/* ===================================================================
   Content-title formatting — proper Title Case for CONTENT / TASK titles
   only (never names, emails, URLs, file names, descriptions, comments,
   captions). Preserves apostrophes, hyphens and punctuation; keeps known
   acronyms/platforms in their canonical casing; keeps minor words lowercase
   except at the start or end. Idempotent (safe to apply to an already-formatted
   title). Mirrored in functions/lib.js for notification generation — keep both
   copies in sync.
   =================================================================== */
const TITLE_SMALL = new Set(["a","an","and","as","at","but","by","en","for","if",
  "in","nor","of","on","or","per","the","to","v","vs","via","with"]);
const TITLE_SPECIAL = { qa:"QA", csv:"CSV", ifc:"IFC", pwa:"PWA",
  instagram:"Instagram", youtube:"YouTube", ig:"IG", tiktok:"TikTok" };

// Case one whitespace-free token, preserving leading/trailing punctuation.
function titleCaseToken(word, forceCap) {
  if (!word) return word;
  const lower = word.toLowerCase();
  const m = lower.match(/^([^a-z0-9]*)([a-z0-9](?:.*[a-z0-9])?)([^a-z0-9]*)$/);
  if (!m) return word;                                   // pure punctuation
  const [, pre, core, post] = m;
  if (TITLE_SPECIAL[core]) return pre + TITLE_SPECIAL[core] + post;   // QA, CSV, Instagram…
  if (!forceCap && TITLE_SMALL.has(core)) return pre + core + post;   // minor word, mid-title
  return pre + core.charAt(0).toUpperCase() + core.slice(1) + post;
}

// A space-delimited word may be hyphenated (behind-the-scenes) — case each part,
// forcing the outer parts to capitalise.
function titleCaseWord(word, isFirst, isLast) {
  if (word.indexOf("-") === -1) return titleCaseToken(word, isFirst || isLast);
  const parts = word.split("-");
  return parts.map((p, i) =>
    titleCaseToken(p, i === 0 || i === parts.length - 1)
  ).join("-");
}

export function formatContentTitle(title) {
  const s = (title == null ? "" : String(title)).trim();
  if (!s) return "";
  const toks = s.split(/(\s+)/);                          // keep whitespace tokens
  const wordPos = [];
  toks.forEach((t, i) => { if (/\S/.test(t)) wordPos.push(i); });
  const first = wordPos[0], last = wordPos[wordPos.length - 1];
  return toks.map((t, i) => /\S/.test(t) ? titleCaseWord(t, i === first, i === last) : t).join("");
}

/* ---- auto-assign (eligibility first, then balance by real weighted load) ----
   `allTasks` (optional) lets the balancer seed each candidate's CURRENT active
   capacity points, so it hands work to whoever is genuinely lightest across the
   whole board — not merely whoever has fewer rows on this one task. */
export function autoAssign(task, users, allTasks = []) {
  if (!task || !task.type) return [];   // no type chosen → nothing to assign (don't assume graphics)
  users = (users || []).filter(isAvailable); // #4: never auto-assign unavailable people
  if (!isShootType(task.type)) {   // Poster / graphics → needs one designer
    const ownerU = users.find(u => u.name === task.owner);
    // If the owner is a designer, they design it themselves — no extra crew.
    if (ownerU && (ownerU.skills || []).includes("design")) return [];
    // Otherwise pick the lightest AVAILABLE designer who isn't the owner.
    const other = (allTasks || []).filter(t => t.id !== task.id);
    const designers = users
      .filter(u => u.name !== task.owner && (u.skills || []).includes("design"))
      .sort((a, b) => personLoad(a, other).activePoints - personLoad(b, other).activePoints);
    return designers.length ? [{ name: designers[0].name, role: "design" }] : [];
  }
  const locs = task.location==="Both" ? ["479","828"] : [task.location];
  // Seed each candidate's balance with their current active capacity points
  // (from every OTHER live task), so the lightest person wins.
  const out = []; const load = {};
  users.forEach(u => { load[u.name] = personLoad(u, (allTasks || []).filter(t => t.id !== task.id)).activePoints; });
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
      if (chosen){ used.add(chosen.name); load[chosen.name] += responsibilityWeight(role); return chosen.name; }
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

// Levenshtein edit distance — for small spelling differences / typos.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]
        : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

/* How likely two name fragments refer to the same person, 0–1 (with a short
   reason). Handles: contained names, shared prefixes, shortened names with a
   little spelling drift (Jon ~ Jonathan), and small typos. Fuzzy guesses
   are capped below 1 so they always require confirmation. */
function nameSim(s, t) {
  if (!s || !t) return { score: 0, reason: "" };
  if (s === t) return { score: 1, reason: "exact" };
  const short = s.length <= t.length ? s : t;
  const long = s.length <= t.length ? t : s;
  if (short.length < 3) return { score: 0, reason: "" };   // too short to fuzz safely
  let best = 0, why = "similar name";
  const bump = (c, label) => { if (c > best) { best = c; why = label; } };

  if (long.startsWith(short)) bump(0.72 + 0.2 * (short.length / long.length), "shared prefix");
  else if (long.includes(short)) bump(0.64 + 0.2 * (short.length / long.length), "contained name");

  // Shortened name vs the other's leading chars, allowing a little drift.
  const lead = long.slice(0, short.length);
  const leadSim = 1 - editDistance(short, lead) / short.length;
  if (leadSim >= 0.6) bump(0.5 + 0.28 * leadSim * (short.length >= 4 ? 1 : 0.75), "shortened name");

  // Whole-word typo similarity (best for similar-length names).
  const overall = 1 - editDistance(s, t) / Math.max(s.length, t.length);
  if (overall >= 0.75) bump(0.6 + 0.35 * ((overall - 0.75) / 0.25), "similar spelling");

  return { score: Math.min(best, 0.95), reason: why };
}

/* Confidence → suggestion tier for the import UI: high = "Possible match",
   medium = "Maybe this is …?", low = don't suggest. */
export const matchTier = (c) => (c >= 0.8 ? "high" : c >= 0.6 ? "medium" : "low");

/* All plausible users a (shortened/alternate) name could refer to, each scored
   0–1 with a reason, best first. Collecting ALL candidates (not just the best)
   is what lets us detect ambiguity — e.g. "Sam" matching two Sams.
   `mappings` is the remembered { matchKey(csvName): userName } map. */
export function matchCandidates(name, users = [], mappings = {}) {
  const n = normName(name);
  if (!n) return [];

  // A previously confirmed manual mapping is definitive — one candidate.
  const remembered = mappings[n];
  if (remembered) {
    const u = users.find((x) => normName(x.name) === normName(remembered));
    if (u) return [{ user: u, confidence: 1, reason: "remembered" }];
  }

  const csvFirst = n.split(" ")[0];
  const csvTokens = n.split(" ").filter(Boolean);
  const out = [];
  for (const x of users) {
    const full = normName(x.name);
    const handle = (x.email || "").toLowerCase().split("@")[0];
    const tokens = full.split(" ").filter(Boolean);
    let sc = 0, reason = "similar name";
    const bump = (c, r) => { if (c > sc) { sc = c; reason = r; } };

    if (full === n) bump(1, "exact name");
    if (n.includes("@") && normName(x.email) === n) bump(0.98, "email");
    if (handle && handle === n) bump(0.92, "email handle");
    if (tokens[0] === csvFirst) bump(0.9, "first name");
    for (const tok of tokens) { const r = nameSim(csvFirst, tok); if (r.score > 0) bump(r.score, r.reason); }
    if (csvTokens.length === 1 && /^[a-z]{2,4}$/.test(csvFirst) &&
        tokens.map((t) => t[0]).join("") === csvFirst) bump(0.78, "initials");

    if (sc >= 0.6) out.push({ user: x, confidence: Math.round(sc * 100) / 100, reason });
  }
  return out.sort((a, b) => b.confidence - a.confidence || a.user.name.localeCompare(b.user.name));
}

// Best single guess (back-compat) — { user, confidence, reason } or null.
export function matchUserScored(name, users = [], mappings = {}) {
  return matchCandidates(name, users, mappings)[0] || null;
}

// Two candidates are "ambiguous" when the runner-up is nearly as strong as the
// best — i.e. we can't safely tell them apart (two Sams, etc.).
const AMBIGUITY_GAP = 0.1;
export function isAmbiguous(candidates) {
  return candidates.length >= 2
    && candidates[0].confidence >= 0.7
    && candidates[1].confidence >= candidates[0].confidence - AMBIGUITY_GAP;
}

// Auto-resolve a name to a user ONLY when there's a single, clearly-best,
// high-confidence match. Remembered mappings always resolve; otherwise we
// refuse when confidence is low (<0.9) OR the match is ambiguous, leaving the
// task Pending for the admin to confirm. Prevents wrong-person assignment.
export function matchUser(name, users = [], mappings = {}) {
  const c = matchCandidates(name, users, mappings);
  if (!c.length) return null;
  if (c[0].reason === "remembered") return c[0].user;
  if (c[0].confidence >= 0.9 && !isAmbiguous(c)) return c[0].user;
  return null;
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
  if (/coordinate|get(ting)? ?people/.test(n)) roles.push("coordinate");
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
    const roleText = sanitizeName(dash >= 0 ? seg.slice(dash + 1) : "");
    const roles = detectRoles(roleText);              // known roles only
    namesPart.split(/&|,/).forEach((rawName) => {
      const nm = sanitizeName(rawName);
      if (!nm) return;
      const u = matchUser(nm, users, mappings);
      const base = u ? { name: u.name } : { name: "Pending", suggested: nm };
      // Don't force unknown roles to "Getting People" — keep them as a custom
      // "Other" task with the sheet's wording (e.g. "Caption Writing").
      if (roles.length) roles.forEach((role) => out.push({ ...base, role }));
      else out.push({ ...base, role: "other", label: roleText });
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
   crew), each with its candidate match(es) — drives the import reconciliation UI.
   Returns [{ name, key, candidates: [{user,confidence,reason}], ambiguous }]
   (only names that have at least one plausible guess). */
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
      const candidates = matchCandidates(nm, users, mappings);
      if (candidates.length) seen.set(key, { name: nm, key, candidates: candidates.slice(0, 5), ambiguous: isAmbiguous(candidates) });
    }
  }
  return [...seen.values()].sort((a, b) => b.candidates[0].confidence - a.candidates[0].confidence);
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
    u.name, u.email, u.role, u.status, ...userDepartments(u),
    ...(u.skills || []), ...(u.location || []),
  ].join(" ").toLowerCase();
  return (users || []).filter((u) => { const h = haystack(u); return terms.every((term) => h.includes(term)); });
}

/* ===================================================================
   People management (Admin → People)
   =================================================================== */
// Departments are org groupings only. "Caption & Upload" and "QA" are NOT
// departments — they're capabilities, already surfaced as Roles & permissions
// toggles (user.captions / user.qa), so keeping them here would duplicate.
export const DEPARTMENTS = [
  "Graphic Design", "Content Creation", "Videography", "Photography",
];

// A user may belong to MULTIPLE departments. Stored as `departments: [...]`,
// but older docs used a single `department` string — normalise both to an
// array so every read path is consistent.
export function userDepartments(user) {
  if (!user) return [];
  if (Array.isArray(user.departments)) return user.departments.filter(Boolean);
  return user.department ? [user.department] : [];
}

// Availability for assignment (#4). Missing = available (opt-out, not opt-in),
// so existing users keep working. When false: excluded from auto-assign and
// blocked from manual assignment; the Team page shows "Unavailable".
export const isAvailable = (user) => !(user && user.available === false);

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

/* ===================================================================
   CAPACITY ENGINE (v1) — effort-weighted, phase-aware workload.

   Principle: workload is the effort of a person's CURRENT responsibility,
   not how many task rows contain their name. Each responsibility (owner or a
   support-crew role) carries a role weight, is ACTIVE only during the workflow
   phase where that work actually happens (derived from task status — never a
   manual per-assignment status), and is placed on a timeline by the date most
   relevant to that role. Weights are internal + versioned (not user-editable in
   v1). Scope: creative/production responsibilities only — shared QA and posting
   queues are NOT attributed to individuals in v1.
   =================================================================== */
export const CAPACITY_MODEL = {
  version: 1,
  // Role -> effort weight (a heavy edit is worth ~5 coordination pings).
  roles: { owner: 2, shoot: 3, edit: 5, design: 4, coordinate: 1, shadow: 0.5, other: 1 },
  // A responsibility that hasn't started yet counts at half.
  phaseMultiplier: { active: 1, upcoming: 0.5, done: 0 },
  // Weekly capacity (in the same points) by availability.
  capacity: { full: 20, limited: 10, unavailable: 0 },
};

// A person's weekly capacity in points, from their availability flags.
export function weeklyCapacity(user) {
  if (!isAvailable(user)) return CAPACITY_MODEL.capacity.unavailable;
  if (user && user.limited) return CAPACITY_MODEL.capacity.limited;
  return CAPACITY_MODEL.capacity.full;
}

// Effort weight for a role (falls back to "other").
export const responsibilityWeight = (role) =>
  CAPACITY_MODEL.roles[role] != null ? CAPACITY_MODEL.roles[role] : CAPACITY_MODEL.roles.other;

// Which phase a responsibility is in, derived from the task's workflow status:
//   "active"   → the work is happening now (full weight)
//   "upcoming" → not started yet (half weight)
//   "done"     → this person's part is finished (zero)
// Owner spans the whole task; coordination happens before the shoot; shoot/edit/
// design/shadow happen during production ("In Progress"/"Changes Requested").
export function responsibilityPhase(role, status) {
  if (status === "Posted") return "done";
  const planning = status === "Planned";
  const producing = status === "In Progress" || status === "Changes Requested";
  switch (role) {
    case "owner":      return "active";                                   // until Posted
    case "coordinate": return planning ? "active" : "done";               // pre-production only
    case "shoot":
    case "shadow":
    case "edit":
    case "design":
    case "other":
    default:           return planning ? "upcoming" : producing ? "active" : "done";
  }
}

// The date a responsibility should sit on in the timeline. Shoot-side roles use
// the shoot date; edit/design/owner/other use the post date. Falls back to the
// other date, or null (→ "unscheduled").
export function responsibilityDate(role, task) {
  const shoot = task.shootDate || task.postDate || null;
  const post = task.postDate || task.shootDate || null;
  return (role === "shoot" || role === "shadow" || role === "coordinate") ? shoot : post;
}

// Time bucket relative to today. Overdue/near items land in "thisWeek".
export function loadBucket(dateStr) {
  if (!dateStr) return "unscheduled";
  const d = daysTo(dateStr);
  if (d == null) return "unscheduled";
  if (d <= 7) return "thisWeek";     // includes past-due (negative)
  if (d <= 14) return "nextWeek";
  return "later";
}

// Every non-done responsibility this person holds across the live board, each
// with its role, weight, phase, effective load, relevant date and time bucket.
export function personResponsibilities(user, tasks) {
  const name = user && user.name;
  const out = [];
  for (const t of (tasks || [])) {
    if (!t || t.status === "Posted") continue;
    const roles = [];
    if (t.owner === name) roles.push("owner");
    for (const s of (t.support || [])) if (s && s.name === name) roles.push(s.role || "other");
    for (const role of roles) {
      const phase = responsibilityPhase(role, t.status);
      if (phase === "done") continue;
      const weight = responsibilityWeight(role);
      const date = responsibilityDate(role, t);
      out.push({
        taskId: t.id, title: t.title, type: t.type, role, weight, phase,
        effective: weight * CAPACITY_MODEL.phaseMultiplier[phase],
        date, bucket: loadBucket(date),
      });
    }
  }
  return out;
}

// A person's aggregate capacity picture: active vs upcoming points, counts,
// timeline buckets, weekly capacity and the resulting band.
export function personLoad(user, tasks) {
  const items = personResponsibilities(user, tasks);
  const active = items.filter((i) => i.phase === "active");
  const upcoming = items.filter((i) => i.phase === "upcoming");
  const sum = (arr) => Math.round(arr.reduce((s, i) => s + i.effective, 0) * 10) / 10;
  const capacity = weeklyCapacity(user);
  const buckets = { thisWeek: [], nextWeek: [], later: [], unscheduled: [] };
  items.forEach((i) => buckets[i.bucket].push(i));
  const activePoints = sum(active);
  return {
    items, active, upcoming, activePoints, upcomingPoints: sum(upcoming),
    activeCount: active.length, upcomingCount: upcoming.length,
    capacity, buckets, band: workloadBand(user, activePoints, capacity),
  };
}

// Coarse capacity band (never a false-precise %). Driven by ACTIVE load only;
// upcoming work is shown separately. Unavailable always wins.
export function workloadBand(user, activePoints, capacity) {
  if (!isAvailable(user)) return { key: "unavail", label: "Unavailable", tone: "neutral" };
  if (!activePoints || activePoints <= 0) return { key: "available", label: "Available", tone: "green" };
  const ratio = capacity > 0 ? activePoints / capacity : 1;
  if (ratio <= 0.4) return { key: "light",    label: "Light",         tone: "green" };
  if (ratio <= 0.7) return { key: "balanced", label: "Balanced",      tone: "blue" };
  if (ratio <= 0.9) return { key: "busy",     label: "Busy",          tone: "amber" };
  return { key: "high", label: "High workload", tone: "red" };
}

// Human label for a responsibility, weight-tiered (heavy/standard/light).
export const responsibilityTier = (weight) => weight >= 4 ? "Heavy" : weight >= 2 ? "Standard" : "Light";

/* ---- Plain-language workload ---------------------------------------------
   The engine thinks in points. People think in "two edits due this week".
   Nothing below invents new data — it phrases what personLoad already knows,
   so the UI never has to show a number nobody can interpret. */

// What someone IS in a role ("best available shooter") and the kind of work
// they're compared on ("light editing schedule"). No engine vocabulary: the
// internal "owner" role must never surface as "pieces to own".
const ROLE_PERSON = { shoot:"shooter", edit:"editor", design:"designer",
  coordinate:"coordinator", shadow:"trainee", owner:"lead" };
const ROLE_NOUN = { shoot:"filming", edit:"editing", design:"design",
  coordinate:"coordination", shadow:"shadowing", owner:"ownership" };

// What's on someone's plate, in as few words as it can honestly be said, plus
// whether their band is worth badging at all — "Light"/"Balanced" is not news,
// so only the ends of the scale (free, busy, over, unavailable) earn a chip.
export function loadSummary(user, tasks) {
  const load = personLoad(user, tasks);
  const band = load.band;
  const notable = band.key !== "light" && band.key !== "balanced";
  const week = load.buckets.thisWeek.length;
  const base = { band, notable, load, dueThisWeek: week, upcoming: load.items.length - week };
  if (!isAvailable(user)) return { ...base, detail: "Unavailable" };
  if (week) return { ...base, detail: `${week} due this week` };
  return { ...base, detail: load.items.length ? "Nothing due this week" : "Available this week" };
}

// Is this the same team, regardless of the order it was built in? Auto-assign
// is deterministic, so re-running it on unchanged inputs returns an identical
// crew — the UI needs to know that so "nothing changed" can be SAID rather
// than looking like a dead button.
const crewKey = (c) => `${(c && c.name) || ""}|${(c && c.role) || ""}|${(c && c.loc) || ""}`;
export function sameCrew(a, b) {
  const A = (a || []).map(crewKey).sort(), B = (b || []).map(crewKey).sort();
  return A.length === B.length && A.every((k, i) => k === B[i]);
}

// Why this person is the right call — a recommendation, not a readout of the
// score that produced it. Stays honest: when someone else is genuinely freer we
// say what's on this person's plate instead of claiming they're the best pick.
export function crewReason(pick, users, tasks) {
  const role = pick && pick.role;
  if (role === "shadow") return "Learning on this one";
  const person = (users || []).find((u) => u.name === (pick && pick.name));
  if (!person) return "Available";
  if (!isAvailable(person)) return "Unavailable";
  const { detail, load } = loadSummary(person, tasks);
  // How many equally-skilled, available people are carrying LESS than they are.
  const lighter = (users || []).filter((u) =>
    u.name !== person.name && isAvailable(u) && (u.skills || []).includes(role)
    && personLoad(u, tasks).activePoints < load.activePoints).length;
  if (lighter > 0) return detail;
  if (load.activePoints <= 0) return `Best available ${ROLE_PERSON[role] || "choice"}`;
  return `Light ${ROLE_NOUN[role] || "workload"} schedule`;
}

// Immutable toggle of an id in a Set (returns a NEW set; never mutates). Used to
// track which capacity cards are expanded — keyed by stable user id, so rapid
// expansion of several cards never cross-contaminates.
export function toggleId(set, id) {
  const next = new Set(set);
  next.has(id) ? next.delete(id) : next.add(id);
  return next;
}

// Lightweight data-quality flags so a stale board doesn't quietly produce a
// confident-but-wrong capacity picture. We never auto-change status — just flag.
export function staleFlags(task) {
  const flags = [];
  if (!task || task.status === "Posted") return flags;
  const shoot = task.shootDate ? daysTo(task.shootDate) : null;
  const post = task.postDate ? daysTo(task.postDate) : null;
  if (task.status === "Planned" && shoot != null && shoot < 0) flags.push("shoot-passed-still-planned");
  if (post != null && post < 0) flags.push("post-passed-not-posted");
  return flags;
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
  { id: "unavail",  label: "Unavailable",    test: (u) => !isAvailable(u) },
  { id: "nodept",   label: "No department",  test: (u) => userDepartments(u).length === 0 },
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
  DEPARTMENTS.forEach((d) => take(d, (u) => userDepartments(u).includes(d)));
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
    // Posted content is archived — it drops out of My Work (find it in the
    // Workflow "Archived" group, Search, or Admin).
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

/* Recent celebratory moments — ONE win per completed piece of content, newest
   first. The production TASK is the canonical source: its title is never
   concatenated with a linked recurring event's name (that produced the
   "X posted · X Poster" duplicate-looking rows), and repeated completion events
   for the same content collapse into a single win — a "Posted" always wins over
   an earlier "Approved". Returns structured data so the UI owns the wording. */
export function recentWins(tasks, limit = 5) {
  const byContent = new Map();
  (tasks || []).forEach((t) => {
    const posted = lastEvent(t, "posted");
    const ev = posted || lastEvent(t, "approved");
    if (!ev) return;
    const key = t.id != null ? t.id : t.title;      // one entry per piece of content
    const win = { id: key, at: ev.at, title: t.title, action: posted ? "Posted" : "Approved", type: t.type };
    const prev = byContent.get(key);
    if (!prev || (win.action === "Posted" && prev.action !== "Posted") || win.at > prev.at) byContent.set(key, win);
  });
  return [...byContent.values()].sort((a, b) => b.at - a.at).slice(0, limit);
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
