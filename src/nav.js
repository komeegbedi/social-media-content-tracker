/* Central navigation mapping — the ONE place that knows how a URL maps to a
   screen + overlays, and vice-versa. Pure and DOM-free so it unit-tests under
   `node --test` exactly like data.js. The React layer (App.jsx) is a thin
   adapter over these functions; it must never compare pathnames itself.

   The URL is the sole source of truth. Nothing here holds state — every
   function is (location) -> value or (location, change) -> next location. */

// Top-level screens and their canonical paths. Order = tab order.
export const SCREENS = ["home", "myday", "board", "mine", "team", "admin"];

const SCREEN_PATH = {
  home: "/",
  myday: "/my-day",
  board: "/workflow",
  mine: "/my-work",
  team: "/team",
  admin: "/admin",
};
const PATH_SCREEN = Object.fromEntries(Object.entries(SCREEN_PATH).map(([s, p]) => [p, s]));

// Legacy tab ids (old ?tab= values) → screen. Same ids as the nav model.
const LEGACY_TAB = { home: "home", myday: "myday", board: "board", mine: "mine", team: "team", admin: "admin" };

// Human titles for <title> — "IFC Creatives Board" is appended by the caller.
export const SCREEN_TITLE = {
  home: "Home", myday: "My Day", board: "Workflow", mine: "My Work",
  team: "Team", admin: "Admin", content: "Content", notfound: "Not found",
};

export const pathForScreen = (screen) => SCREEN_PATH[screen] || "/";

// Query-param names for URL-backed overlays and filters. Centralised so the
// React layer never hardcodes a string.
export const PARAM = {
  compose: "compose",   // ?compose=new  → new-content editor
  edit: "edit",         // ?edit=<id>    → edit-content editor
  panel: "panel",       // ?panel=profile|notifications|search
  event: "event",       // /workflow?event=<occurrenceId>
  section: "section",   // /admin?section=people
  filter: "filter",     // /workflow?filter=attention
  focus: "focus",       // /content/:id?focus=comments|review  (deep-link a section)
  comment: "comment",   // /content/:id?focus=comments&comment=<id>  (highlight target)
  user: "user",         // /admin?section=people&user=<uid>  (highlight a person)
};
export const PANELS = ["profile", "notifications", "search"];
// Sections of the content detail a notification can jump straight to.
export const FOCI = ["comments", "review", "links"];

/* ---- parsing ------------------------------------------------------------- */

// A URLSearchParams-like read that works from either a string or an instance.
const params = (search) =>
  search instanceof URLSearchParams ? search : new URLSearchParams(search || "");

/* parseLocation(pathname, search) -> {
     screen, contentId, memberId, section, event, overlay:{editor, panel},
     redirect            // canonical path to replace-navigate to, or null
   }
   `redirect` is a hint the React layer applies with <Navigate replace> — it
   covers /home normalisation, the reserved /team/:memberId route, and unknown
   paths. Legacy ?tab=/?task= migration is handled separately by migrate(). */
export function parseLocation(pathname, search) {
  const p = params(search);
  const base = {
    screen: "notfound", contentId: null, memberId: null,
    section: null, event: null, filter: null, focus: null, comment: null, user: null,
    overlay: parseOverlay(p),
    redirect: null,
  };

  // Normalise a trailing slash (except root) before matching.
  const path = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  if (path === "/home") return { ...base, screen: "home", redirect: "/" };
  if (PATH_SCREEN[path]) {
    const screen = PATH_SCREEN[path];
    const out = { ...base, screen };
    if (screen === "board") {
      out.event = p.get(PARAM.event) || null;
      out.filter = p.get(PARAM.filter) || null;   // e.g. ?filter=attention from a summary
    }
    if (screen === "admin") {
      out.section = p.get(PARAM.section) || null;
      out.user = p.get(PARAM.user) || null;        // highlight a person (e.g. a pending approval)
    }
    return out;
  }
  // /content/:id — optional section focus + comment highlight (from a notification).
  const content = path.match(/^\/content\/([^/]+)$/);
  if (content) {
    const focus = p.get(PARAM.focus);
    return {
      ...base, screen: "content", contentId: decodeURIComponent(content[1]),
      focus: FOCI.includes(focus) ? focus : null,
      comment: p.get(PARAM.comment) || null,
    };
  }

  // Reserved: /team/:memberId — no screen yet, fall back to /team.
  const member = path.match(/^\/team\/([^/]+)$/);
  if (member) return { ...base, screen: "team", memberId: decodeURIComponent(member[1]), redirect: "/team" };

  // Unknown → catch-all recovery to home.
  return { ...base, redirect: "/" };
}

// Overlays from the query string. At most ONE editor and ONE panel; an editor
// and a panel are mutually exclusive (opening one closes the other), so if a
// malformed URL carries both, the editor wins as the more specific action.
export function parseOverlay(search) {
  const p = params(search);
  let editor = null;
  if (p.get(PARAM.compose) === "new") editor = { mode: "new" };
  else if (p.get(PARAM.edit)) editor = { mode: "edit", id: p.get(PARAM.edit) };

  let panel = null;
  const pn = p.get(PARAM.panel);
  if (!editor && pn && PANELS.includes(pn)) panel = pn;

  return { editor, panel };
}

export const hasOverlay = (overlay) => !!(overlay && (overlay.editor || overlay.panel));

/* ---- legacy migration ---------------------------------------------------- */

/* One-time translation of old deep links to canonical URLs. Returns the
   canonical { pathname, search } to REPLACE the current entry with, or null
   when there's nothing legacy to migrate. Legacy forms:
     ?task=<id>              -> /content/<id>
     ?tab=<id>               -> that screen's path
     ?tab=admin&sec=people   -> /admin?section=people   */
export function migrate(pathname, search) {
  const p = params(search);
  const task = p.get("task");
  const tab = p.get("tab");
  const sec = p.get("sec");
  if (!task && !tab) return null;

  if (task) return { pathname: `/content/${encodeURIComponent(task)}`, search: "" };

  const screen = LEGACY_TAB[tab];
  if (!screen) return { pathname: "/", search: "" };
  if (screen === "admin" && sec) {
    const q = new URLSearchParams(); q.set(PARAM.section, sec);
    return { pathname: "/admin", search: `?${q.toString()}` };
  }
  return { pathname: SCREEN_PATH[screen], search: "" };
}

/* ---- building next locations (adapters return a search string) ----------- */

// Rebuild a search string from a base search, applying { key: value|null }.
// null/"" deletes the key. Order is stabilised so identical intent produces an
// identical string (so navigation never creates a redundant history entry).
export function withParams(search, changes) {
  const p = params(search);
  for (const [k, v] of Object.entries(changes)) {
    if (v == null || v === "") p.delete(k);
    else p.set(k, v);
  }
  // Stable key order for deterministic output.
  const order = [PARAM.compose, PARAM.edit, PARAM.panel, PARAM.event, PARAM.section, PARAM.filter, PARAM.focus, PARAM.comment, PARAM.user];
  const out = new URLSearchParams();
  for (const k of order) if (p.has(k)) out.set(k, p.get(k));
  const s = out.toString();
  return s ? `?${s}` : "";
}

// Overlay open/close helpers. Each returns the next search string for the SAME
// pathname. Opening a panel clears any editor and vice-versa (one at a time).
export const openComposeNew = (search) =>
  withParams(search, { [PARAM.compose]: "new", [PARAM.edit]: null, [PARAM.panel]: null });
export const openComposeEdit = (search, id) =>
  withParams(search, { [PARAM.edit]: id, [PARAM.compose]: null, [PARAM.panel]: null });
export const openPanel = (search, name) =>
  withParams(search, { [PARAM.panel]: PANELS.includes(name) ? name : null, [PARAM.compose]: null, [PARAM.edit]: null });
export const closeOverlays = (search) =>
  withParams(search, { [PARAM.compose]: null, [PARAM.edit]: null, [PARAM.panel]: null });

/* Decide how to DISMISS an overlay (editor or panel) without creating a
   Task↔Edit loop. An overlay is always opened by PUSHING its ?param on top of
   its parent, so the parent is the entry directly below.

   INVARIANT: a child returns to its parent by UNWINDING history (going back to
   the entry that's already there) — never by pushing a fresh copy of the parent
   on top of the child. Pushing was the bug: it left the dismissed editor sitting
   in history as a Back target, so closing the detail stepped back into it.

     • nothing open            → "noop"    (never pop a real page by accident)
     • opened in-session       → "back"    (unwind one entry to the real parent)
     • direct entry (no back)  → "replace" (synthesize the parent, e.g.
                                            /content/:id from /content/:id?edit) */
export function overlayClose({ search, canGoBack }) {
  const cleaned = closeOverlays(search);
  if (cleaned === search) return { type: "noop" };
  if (canGoBack) return { type: "back" };
  return { type: "replace", search: cleaned };
}

/* ---- notification deep-linking ------------------------------------------

   A notification is only an entry point: tapping it must land the user on the
   exact thing it refers to, ready to act — never a generic dashboard. This
   maps a notification's STRUCTURED fields (type + ids) to a concrete location.
   It never parses the notification's display text.

   The notification doc carries: { type, taskId?, eventOccurrenceId?, commentId? }.
   Destinations by type:
     assigned/reminder/overdue/ready/approved → the content itself
     qa (review request)   → the content, scrolled to the QA review panel
     changes/mention       → the content, scrolled to Discussion (+ comment id)
     leadership (summary)  → Workflow filtered to everything needing follow-up
     weeklyTaskCheck       → My Day (what's due for Sunday)
     account_approved      → Home (the welcome — this one IS about Home) */
export function notificationDestination(n) {
  if (!n) return { pathname: "/", search: "" };
  const type = n.type;

  // Content is the strongest signal — anything about a task opens that task.
  if (n.taskId) {
    const focus =
      type === "qa" ? "review"
      : (type === "mention" || type === "changes") ? "comments"
      : null;
    const search = withParams("", {
      [PARAM.focus]: focus,
      [PARAM.comment]: focus === "comments" ? (n.commentId || null) : null,
    });
    return { pathname: `/content/${encodeURIComponent(n.taskId)}`, search };
  }

  if (n.eventOccurrenceId)
    return { pathname: "/workflow", search: withParams("", { [PARAM.event]: n.eventOccurrenceId }) };

  // People/account notifications → Admin → People (never Workflow). A pending
  // approval highlights the exact person via ?user. An explicit adminSection is
  // honoured for forward-compatible account/permission alerts.
  if (type === "account_pending" || n.adminSection) {
    return {
      pathname: "/admin",
      search: withParams("", { [PARAM.section]: n.adminSection || "people", [PARAM.user]: n.userId || null }),
    };
  }

  // Follow-up DIGEST (a production summary) → the exact items behind it.
  if (type === "leadership")
    return { pathname: "/workflow", search: withParams("", { [PARAM.filter]: "attention" }) };

  if (type === "weeklyTaskCheck") return { pathname: "/my-day", search: "" };
  if (type === "account_approved") return { pathname: "/", search: "" };  // Home IS the point — welcome

  return { pathname: "/", search: "" };   // last-resort only for unknown types
}

/* ---- safe back fallbacks (for direct entry with no in-app history) -------- */

// Where an in-app Back control should land when there's no earlier app entry
// (a push/email deep link opened cold) — so we never step history back into the
// email app, an external site, or a blank tab. A logical PARENT of where the
// user is, tuned by any section focus the deep link carried.
export function fallbackPath(navState) {
  if (!navState) return "/";
  if (navState.screen === "content") {
    // A review request → the awaiting-review list; otherwise the workflow.
    if (navState.focus === "review") return "/workflow?filter=review";
    return "/workflow";
  }
  if (navState.screen === "admin") return "/admin";
  if (navState.memberId) return "/team";
  return "/";
}

// Document title for a parsed location. contentTitle is looked up by the caller
// (nav.js has no data access) and passed in when known.
export function titleFor(navState, contentTitle) {
  if (!navState) return "IFC Creatives Board";
  if (navState.overlay?.editor)
    return `${navState.overlay.editor.mode === "new" ? "Plan content" : "Edit content"} · IFC Creatives Board`;
  if (navState.overlay?.panel)
    return `${cap(navState.overlay.panel)} · IFC Creatives Board`;
  if (navState.screen === "content")
    return `${contentTitle || "Content"} · IFC Creatives Board`;
  return `${SCREEN_TITLE[navState.screen] || "IFC Creatives Board"} · IFC Creatives Board`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
