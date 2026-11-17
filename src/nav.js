/* Central navigation mapping — the ONE place that knows how a URL maps to a
   screen + overlays, and vice-versa. Pure and DOM-free so it unit-tests under
   `node --test` exactly like data.js. The React layer (App.jsx) is a thin
   adapter over these functions; it must never compare pathnames itself.

   The URL is the sole source of truth. Nothing here holds state — every
   function is (location) -> value or (location, change) -> next location. */

// Top-level screens and their canonical paths. Order = tab order.
export const SCREENS = ["home", "myday", "board", "mine", "learn", "team", "admin"];

const SCREEN_PATH = {
  home: "/",
  myday: "/my-day",
  board: "/workflow",
  mine: "/my-work",
  learn: "/learn",
  team: "/team",
  admin: "/admin",
};
const PATH_SCREEN = Object.fromEntries(Object.entries(SCREEN_PATH).map(([s, p]) => [p, s]));

// Legacy tab ids (old ?tab= values) → screen. Same ids as the nav model.
const LEGACY_TAB = { home: "home", myday: "myday", board: "board", mine: "mine", learn: "learn", team: "team", admin: "admin" };

// Human titles for <title> — "IFC Creatives Board" is appended by the caller.
export const SCREEN_TITLE = {
  home: "Home", myday: "My Day", board: "Workflow", mine: "My Work",
  learn: "Creative Academy", team: "Team", admin: "Admin", content: "Content", notfound: "Not found",
};

/* IFC Creative Academy routes (all render the `learn` screen):
     /learn                                   catalogue + purpose video
     /learn/course/:courseId                  course overview
     /learn/course/:courseId/lesson/:lessonId lesson player
   Ids are opaque Firestore ids; a malformed id falls through to /learn. */
const ID = "[A-Za-z0-9_-]{1,64}";
const LEARN_COURSE = new RegExp(`^/learn/course/(${ID})$`);
const LEARN_LESSON = new RegExp(`^/learn/course/(${ID})/lesson/(${ID})$`);
const LEARN_GUIDE = new RegExp(`^/learn/guide/(${ID})$`);
/* Category ids: the six built-ins are plain words, but categories created in
   the workspace get a slug + random suffix that can contain DIGITS
   ("testing-123-k3x9"). Accept every id the rules allow ([a-z0-9-]{1,40})
   and let the page decide whether it exists / is visible —
   an unknown id shows "not available", never a silent bounce back to /learn. */
const LEARN_CATEGORY = /^\/learn\/category\/([a-z0-9-]{1,40})$/;      // exactly the ids the rules allow
const LEARN_BROWSE = "/learn/browse";
const LEARN_PATHWAY = new RegExp(`^/learn/path/(${ID})$`);
/* Course / lesson URL. `opts.path` = the learning path the learner opened it
   from (?path=<id>) — explicit context, carried through lesson navigation so
   completion can offer "Continue learning path". Without it, the URL is the
   plain direct link (unchanged). */
export const learnPath = (courseId, lessonId, opts = {}) => {
  const base = !courseId ? "/learn"
    : !lessonId ? `/learn/course/${encodeURIComponent(courseId)}`
    : `/learn/course/${encodeURIComponent(courseId)}/lesson/${encodeURIComponent(lessonId)}`;
  return courseId && opts.path ? `${base}?path=${encodeURIComponent(opts.path)}` : base;
};
//   /learn/guide/:guideId   quick guide        /learn/path/:pathId   learning path
export const learnGuidePath = (guideId) => `/learn/guide/${encodeURIComponent(guideId)}`;
//   /learn/category/:categoryId   category page   /learn/browse?format=&category=&sort=&q=   full listing
/* Where an old editing link should go: the course workspace (with the lesson
   selected), else a category workspace, else null. Ids are validated. */
const VALID_ID = new RegExp(`^${"[A-Za-z0-9_-]{1,64}"}$`);
export function legacyEditTarget({ course, lesson, category } = {}) {
  const ok = (v) => typeof v === "string" && VALID_ID.test(v);
  if (ok(course)) return learnManagePath({ view: "course", id: course, item: ok(lesson) ? lesson : "" });
  if (ok(category)) return learnManagePath({ view: "category", id: category });
  return null;
}
const EDIT_WORDS = "edit|details|settings|manage";
export function legacyEditRedirect(path, p) {
  let m;
  // /learn/manage/course/:id/(lesson|item|lessons)/:lid · /learn/manage/course/:id/:lid · …/:id/edit
  if ((m = path.match(new RegExp(`^/learn/manage/course/(${ID})/(?:lessons?|items?)/(${ID})/?$`)))) return legacyEditTarget({ course: m[1], lesson: m[2] });
  if ((m = path.match(new RegExp(`^/learn/manage/course/(${ID})/(?:${EDIT_WORDS})/?$`)))) return legacyEditTarget({ course: m[1] });
  if ((m = path.match(new RegExp(`^/learn/manage/course/(${ID})/(${ID})/?$`)))) return legacyEditTarget({ course: m[1], lesson: m[2] });
  // /learn/manage/category/:cat/course/:id(/lesson/:lid)
  if ((m = path.match(new RegExp(`^/learn/manage/category/${ID}/course/(${ID})(?:/lessons?/(${ID}))?/?$`)))) return legacyEditTarget({ course: m[1], lesson: m[2] });
  // /learn/manage?course=&lesson= · ?category=
  if (path === "/learn/manage" && !p.get("guide") && (p.get("course") || p.get("category"))) return legacyEditTarget({ course: p.get("course"), lesson: p.get("lesson") || p.get("item"), category: p.get("category") });
  // /learn/course/:id/edit · /learn/course/:id/lesson/:lid/edit · learner pages with ?edit / ?manage
  if ((m = path.match(new RegExp(`^/learn/course/(${ID})/(?:${EDIT_WORDS})/?$`)))) return legacyEditTarget({ course: m[1] });
  if ((m = path.match(new RegExp(`^/learn/course/(${ID})/lesson/(${ID})/(?:${EDIT_WORDS})/?$`)))) return legacyEditTarget({ course: m[1], lesson: m[2] });
  if ((m = path.match(new RegExp(`^/learn/course/(${ID})(?:/lesson/(${ID}))?$`))) && (p.has("edit") || p.has("manage"))) return legacyEditTarget({ course: m[1], lesson: m[2] });
  // old guide editing links (the dialog editor is gone): /learn/guide/:id/edit · ?edit · /learn/manage?guide=
  const keepPath = (to) => { const pc = p.get("path"); return pc && PATH_ID.test(pc) ? `${to}?path=${encodeURIComponent(pc)}` : to; };
  if ((m = path.match(new RegExp(`^/learn/guide/(${ID})/(?:${EDIT_WORDS})/?$`)))) return keepPath(`/learn/manage/guide/${m[1]}`);
  if ((m = path.match(new RegExp(`^/learn/guide/(${ID})$`))) && (p.has("edit") || p.has("manage"))) return keepPath(`/learn/manage/guide/${m[1]}`);
  if ((m = path.match(new RegExp(`^/learn/manage/guides?/(${ID})/(?:${EDIT_WORDS})/?$`)))) return `/learn/manage/guide/${m[1]}`;
  if (path === "/learn/manage" && p.get("guide") && VALID_ID.test(p.get("guide"))) return `/learn/manage/guide/${p.get("guide")}`;
  return null;
}

/* Authoring workspace (Academy editors) + draft preview:
     /learn/manage                         Academy (categories)
     /learn/manage/category/:id|new        category workspace
     /learn/manage/course/:id|new          course workspace  (?item=<lessonId|details>&category=<id>)
     /learn/manage/more                    quick guides, learning paths, topics
     /learn/preview/course/:id[/lesson/:lid]  learner view of the CURRENT DRAFT */
// focus: a field to move to on arrival (course details: "prior" | "cover" | "title" | "category").
export const MANAGE_FOCI = ["prior", "cover", "title", "category"];
// path: the learning path an editor came from (kept so "Back to course" can
// restore it; the learner page validates it as usual).
const PATH_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function learnManagePath({ view = "home", id = "", item = "", category = "", focus = "", path = "" } = {}) {
  const base = view === "home" ? "/learn/manage" : view === "more" ? "/learn/manage/more" : `/learn/manage/${view}/${encodeURIComponent(id || "new")}`;
  const q = new URLSearchParams();
  if (item) q.set("item", item);
  if (category) q.set("category", category);
  if (focus && MANAGE_FOCI.includes(focus)) q.set("focus", focus);
  if (path && PATH_ID.test(path) && (view === "course" || view === "guide")) q.set("path", path);
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}
export const learnPreviewPath = (courseId, lessonId, opts = {}) => {
  const base = lessonId
    ? `/learn/preview/course/${encodeURIComponent(courseId)}/lesson/${encodeURIComponent(lessonId)}`
    : `/learn/preview/course/${encodeURIComponent(courseId)}`;
  return opts.path && PATH_ID.test(opts.path) ? `${base}?path=${encodeURIComponent(opts.path)}` : base;
};
export const learnPreviewGuidePath = (guideId, opts = {}) => `/learn/preview/guide/${encodeURIComponent(guideId)}${opts.path && PATH_ID.test(opts.path) ? `?path=${encodeURIComponent(opts.path)}` : ""}`;
export const learnPreviewCategoryPath = (categoryId) => `/learn/preview/category/${encodeURIComponent(categoryId)}`;
export const learnCategoryPath = (categoryId) => `/learn/category/${encodeURIComponent(categoryId)}`;
export const learnBrowsePath = (params = {}) => {
  const q = new URLSearchParams();
  for (const k of ["view", "format", "category", "topic", "sort", "q"]) if (params[k]) q.set(k, params[k]);
  const s = q.toString();
  return s ? `${LEARN_BROWSE}?${s}` : LEARN_BROWSE;
};
export const learnPathwayPath = (pathId) => `/learn/path/${encodeURIComponent(pathId)}`;

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
  path: "path",         // /learn/course/:id[/lesson/:lid]?path=<pathId>  (learning-path context)
};
// "profile" = THE account menu (mobile avatar + desktop sidebar); one panel at a time.
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
    screen: "notfound", contentId: null, memberId: null, courseId: null, lessonId: null, guideId: null, pathId: null, pathCtx: null,
    categoryId: null, browse: null, manage: null, preview: false,
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
      // The old Admin → Academy page was only links; old links/bookmarks go to
      // the Academy workspace (replace-navigation, so Back doesn't bounce).
      if (out.section === "academy") {
        const to = legacyEditTarget({ course: p.get("course"), lesson: p.get("lesson") || p.get("item"), category: p.get("category") }) || "/learn/manage";
        return { ...base, screen: "learn", manage: { view: "home" }, redirect: to };
      }
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

  // Old course/lesson EDITING links (earlier builds, bookmarks) → the workspace
  // editor for the same course/lesson. Checked before the learner routes so an
  // edit link never lands on a page that saves differently.
  const legacy = legacyEditRedirect(path, p);
  if (legacy) return { ...base, screen: "learn", redirect: legacy };

  // Academy: course overview and lesson player are sub-routes of the Learn screen.
  const lesson = path.match(LEARN_LESSON);
  // ?path=<id>: which learning path the learner came from (validated later).
  const pathCtx = (p.get(PARAM.path) || "").trim().slice(0, 128) || null;
  if (lesson) return { ...base, screen: "learn", courseId: lesson[1], lessonId: lesson[2], pathCtx };
  const course = path.match(LEARN_COURSE);
  if (course) return { ...base, screen: "learn", courseId: course[1], pathCtx };
  const guide = path.match(LEARN_GUIDE);
  if (guide) return { ...base, screen: "learn", guideId: guide[1] };
  const pathway = path.match(LEARN_PATHWAY);
  if (pathway) return { ...base, screen: "learn", pathId: pathway[1] };
  const cat = path.match(LEARN_CATEGORY);
  if (cat) return { ...base, screen: "learn", categoryId: cat[1] };
  if (path === LEARN_BROWSE) {
    return { ...base, screen: "learn", browse: {
      format: p.get("format") || "", category: p.get("category") || "", topic: p.get("topic") || "", sort: p.get("sort") || "", q: p.get("q") || "",
      // view=categories: every category as cards (the categories row's View all)
      view: p.get("view") === "categories" ? "categories" : "" } };
  }
  if (path === "/learn/manage") return { ...base, screen: "learn", manage: { view: "home" } };
  if (path === "/learn/manage/more") return { ...base, screen: "learn", manage: { view: "more" } };
  const mg = path.match(new RegExp(`^/learn/manage/(category|course|guide)/(new|${ID})$`));
  if (mg) return { ...base, screen: "learn", manage: { view: mg[1], id: mg[2], item: p.get("item") || "", category: p.get("category") || "", focus: MANAGE_FOCI.includes(p.get("focus")) ? p.get("focus") : "", path: PATH_ID.test(p.get("path") || "") ? p.get("path") : "" } };
  if (path.startsWith("/learn/manage/")) return { ...base, screen: "learn", redirect: "/learn/manage" };
  const pvl = path.match(new RegExp(`^/learn/preview/course/(${ID})/lesson/(${ID})$`));
  const pvGuide = path.match(new RegExp(`^/learn/preview/guide/(${ID})$`));
  if (pvGuide) return { ...base, screen: "learn", preview: true, guideId: pvGuide[1], pathCtx: PATH_ID.test(p.get(PARAM.path) || "") ? p.get(PARAM.path) : null };
  const pvCat = path.match(/^\/learn\/preview\/category\/([a-z0-9-]{1,40})$/);
  if (pvCat) return { ...base, screen: "learn", preview: true, categoryId: pvCat[1] };
  const pvPath = PATH_ID.test(p.get(PARAM.path) || "") ? p.get(PARAM.path) : null;
  if (pvl) return { ...base, screen: "learn", preview: true, courseId: pvl[1], lessonId: pvl[2], pathCtx: pvPath };
  const pvc = path.match(new RegExp(`^/learn/preview/course/(${ID})$`));
  if (pvc) return { ...base, screen: "learn", preview: true, courseId: pvc[1], pathCtx: pvPath };
  if (path.startsWith("/learn/")) return { ...base, screen: "learn", redirect: "/learn" };

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
  const order = [PARAM.path, PARAM.compose, PARAM.edit, PARAM.panel, PARAM.event, PARAM.section, PARAM.filter, PARAM.focus, PARAM.comment, PARAM.user];
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
     admin_delivery_health → Admin (the delivery/email diagnostics live there)
     account_approved      → Home (the welcome — this one IS about Home)

   Destinations are derived ONLY from the notification's structured type + ids and
   mapped to KNOWN internal routes here — a stored `route` string on the doc is never
   trusted for client navigation (it could be stale or arbitrary). */
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

  // Notification-delivery / email-health warnings → the Admin console (diagnostics).
  if (type === "admin_delivery_health") return { pathname: "/admin", search: "" };

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
  if (navState.screen === "learn" && navState.preview && navState.courseId) return learnManagePath({ view: "course", id: navState.courseId });
  // A lesson's parent is its course; a course's parent is the catalogue.
  if (navState.screen === "learn" && navState.lessonId) return learnPath(navState.courseId);
  if (navState.screen === "learn" && navState.manage && navState.manage.view !== "home") return "/learn/manage";
  if (navState.screen === "learn" && (navState.courseId || navState.guideId || navState.pathId || navState.categoryId || navState.browse || navState.manage)) return "/learn";
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
  if (navState.screen === "learn" && (navState.courseId || navState.guideId || navState.pathId || navState.categoryId))
    return `${contentTitle || (navState.lessonId ? "Lesson" : navState.guideId ? "Tips & resources" : navState.pathId ? "Learning path" : navState.categoryId ? "Category" : "Course")} · Learn · IFC Creatives Board`;
  if (navState.screen === "learn" && navState.browse) return `${navState.browse.view === "categories" ? "All categories" : "Browse"} · Learn · IFC Creatives Board`;
  if (navState.screen === "learn" && navState.manage) return `${contentTitle || "Manage"} · Academy workspace · IFC Creatives Board`;
  if (navState.screen === "learn" && navState.preview) return `Preview · ${contentTitle || "Course"} · IFC Creatives Board`;
  return `${SCREEN_TITLE[navState.screen] || "IFC Creatives Board"} · IFC Creatives Board`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
