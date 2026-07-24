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
};
export const PANELS = ["profile", "notifications", "search"];

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
    section: null, event: null,
    overlay: parseOverlay(p),
    redirect: null,
  };

  // Normalise a trailing slash (except root) before matching.
  const path = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  if (path === "/home") return { ...base, screen: "home", redirect: "/" };
  if (PATH_SCREEN[path]) {
    const screen = PATH_SCREEN[path];
    const out = { ...base, screen };
    if (screen === "board") out.event = p.get(PARAM.event) || null;
    if (screen === "admin") out.section = p.get(PARAM.section) || null;
    return out;
  }
  // /content/:id
  const content = path.match(/^\/content\/([^/]+)$/);
  if (content) return { ...base, screen: "content", contentId: decodeURIComponent(content[1]) };

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
  const order = [PARAM.compose, PARAM.edit, PARAM.panel, PARAM.event, PARAM.section];
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

/* ---- safe back fallbacks (for direct entry with no in-app history) -------- */

// Where an in-app Back control should land when there's no earlier app entry —
// so we never call history back into an external site. Depends on the screen
// the user is currently on.
export function fallbackPath(navState) {
  if (!navState) return "/";
  if (navState.screen === "content") return "/workflow";
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
