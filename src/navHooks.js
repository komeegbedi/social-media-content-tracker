/* React navigation adapters over react-router + src/nav.js. DOM/router only —
   no Firebase — so the real hooks can be exercised under jsdom in tests. The
   UI (App.jsx) consumes these instead of touching history or pathnames. */
import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import { useLocation, useNavigate, useNavigationType, useBlocker } from "react-router-dom";
import {
  parseLocation, pathForScreen, fallbackPath, withParams, PARAM,
  openComposeNew as buildComposeNew, openComposeEdit as buildComposeEdit,
  openPanel as buildPanel, closeOverlays, overlayClose,
} from "./nav.js";

// Is there a real in-app history entry behind us in this session? React Router
// stamps a numeric `idx` on history.state; idx>0 means the current entry was
// pushed on top of an earlier one we can safely unwind to. On a cold/direct
// entry idx is 0 (or absent), so callers must synthesize a parent instead of
// stepping back into the browser's pre-app history (email app, blank tab).
const canGoBack = () =>
  typeof window !== "undefined" &&
  window.history.state && typeof window.history.state.idx === "number" &&
  window.history.state.idx > 0;

// Dev-only loop detector. The unwind close model makes a Task↔Edit ping-pong
// structurally impossible; this only exists to surface a regression loudly if
// some future handler starts pushing a parent on top of its child again.
const _recentUrls = [];
function useNavCycleGuard(location) {
  useEffect(() => {
    if (!(typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV)) return;
    _recentUrls.push(location.pathname + location.search);
    if (_recentUrls.length > 6) _recentUrls.shift();
    if (_recentUrls.length === 6) {
      const [a, b] = _recentUrls;
      const pingpong = a !== b && _recentUrls.every((u, i) => u === (i % 2 === 0 ? a : b));
      if (pingpong) console.warn("[nav] history cycle detected — an overlay is pushing its parent instead of unwinding:", a, "↔", b);
    }
  }, [location.key]);
}

/* The ONE hook that reads the URL and exposes parsed nav state + typed actions.
   Normal forward moves push a real history entry; only genuine
   redirects/normalisation replace. */
export function useNav() {
  const location = useLocation();
  const navigate = useNavigate();
  useNavCycleGuard(location);
  const nav = useMemo(
    () => parseLocation(location.pathname, location.search),
    [location.pathname, location.search]
  );
  // Change only the search string on the current path (overlays, filters).
  const setSearch = useCallback((nextSearch, opts) => {
    if (nextSearch === location.search || (nextSearch === "" && location.search === ""))
      return;                                        // identical intent → no dup entry
    navigate({ pathname: location.pathname, search: nextSearch }, opts);
  }, [navigate, location.pathname, location.search]);

  return {
    nav, location, navigate,
    // Redirect / normalise — replace, never a new entry.
    replace: (to) => navigate(to, { replace: true }),
    // Navigate carrying route state (rich data that travels WITH the entry,
    // e.g. an event occurrence or a compose prefill) — not parallel state.
    navigateWithState: (to, state) => navigate(to, { state }),
    // Top-level screens — push a real history entry.
    goScreen: (screen, opts) => {
      const path = pathForScreen(screen);
      if (path !== location.pathname) navigate(path, opts);
    },
    // Content detail is its own route.
    openContent: (id) => navigate(`/content/${encodeURIComponent(id)}`),

    /* ---- launcher → destination -----------------------------------------
       A temporary launcher (notification drawer, search overlay, profile
       sheet) helps the user REACH something; it must not linger in the Back
       stack. When a launcher opens a destination we REPLACE the launcher's
       history entry, so the destination sits directly on the underlying
       working page — Back and Close both return there, never resurrecting the
       launcher. Primary surfaces (sidebar, dashboards) keep pushing above. */
    launch: (dest) => navigate(dest, { replace: true }),
    launchScreen: (screen) => navigate(pathForScreen(screen), { replace: true }),
    launchContent: (id) => navigate(`/content/${encodeURIComponent(id)}`, { replace: true }),
    // Overlays (push): mutually exclusive by construction (see nav.js helpers).
    openComposeNew: () => setSearch(buildComposeNew(location.search)),
    openComposeEdit: (id) => setSearch(buildComposeEdit(location.search, id)),
    openPanel: (name) => setSearch(buildPanel(location.search, name)),
    // Dismiss an overlay by UNWINDING to its parent, never by pushing a fresh
    // parent on top (which created the Task↔Edit loop). See nav.js overlayClose.
    closeOverlay: () => {
      const action = overlayClose({ search: location.search, canGoBack: canGoBack() });
      if (action.type === "noop") return;
      if (action.type === "back") navigate(-1);
      else navigate({ pathname: location.pathname, search: action.search }, { replace: true });
    },
    // Shareable filters live in the query string too.
    setEventFilter: (id, occ) =>
      navigate(
        { pathname: "/workflow", search: withParams(location.search, { [PARAM.event]: id }) },
        { state: occ ? { eventOcc: occ } : undefined }
      ),
    clearEventFilter: () => setSearch(withParams(location.search, { [PARAM.event]: null })),
    setAdminSection: (section) =>
      setSearch(withParams(location.search, { [PARAM.section]: section || null })),
    // Safe Back for a nested destination (e.g. Task Detail closing to its
    // origin): unwind to the real parent when it exists, else replace with a
    // logical fallback so we never step history into an external site/blank tab.
    goBack: () => {
      if (canGoBack()) navigate(-1);
      else navigate(fallbackPath(nav), { replace: true });
    },
  };
}

/* Unsaved-changes guard with a PENDING-NAVIGATION model.

   Every navigation away from a dirty form is blocked. When it is, we capture the
   intent (React Router hands us the history ACTION and the target LOCATION), show
   the caller's confirm UI, and — crucially — complete the navigation OURSELVES
   after the form goes clean. We do NOT rely on blocker.proceed(): it cannot
   replay a blocked POP (browser/Android Back) in this RR version, which is what
   forced a second Back press before. Instead:

     • POP (Back, and the editor's own -1 close) → re-issue navigate(-1)
     • PUSH/REPLACE (a sidebar click, etc.)      → navigate to the captured target

   The re-issue happens once the form is clean (a `discarding` render clears the
   block), so it is never re-blocked, never double-fires, and never loops.

   Returns { blocked, discard, keep } — the caller renders its own dialog. */
export function useDirtyNavGuard(isDirty) {
  const navigate = useNavigate();
  const [discarding, setDiscarding] = useState(false);
  const effectiveDirty = isDirty && !discarding;
  const pending = useRef(null);

  const blocker = useBlocker(
    useCallback(({ currentLocation, nextLocation, historyAction }) => {
      const block = effectiveDirty &&
        (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search);
      if (block) pending.current = { action: historyAction, to: nextLocation };
      return block;
    }, [effectiveDirty])
  );

  // Refresh / tab-close protection while dirty.
  useEffect(() => {
    if (!effectiveDirty) return;
    const h = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [effectiveDirty]);

  // After Discard, the clean render lands here: release the block and complete
  // the captured navigation exactly once.
  useEffect(() => {
    if (!discarding) return;
    const p = pending.current;
    pending.current = null;
    if (blocker.state === "blocked") blocker.reset();
    if (!p) return;
    if (p.action === "POP") navigate(-1);
    else navigate({ pathname: p.to.pathname, search: p.to.search }, { replace: p.action === "REPLACE" });
    // No setDiscarding(false): the navigation unmounts the guarded form.
  }, [discarding, blocker.state]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    blocked: blocker.state === "blocked",
    discard: () => setDiscarding(true),
    keep: () => { pending.current = null; blocker.reset(); },
  };
}

// Per-history-entry scroll offsets for the single scroll region (.sb-content).
// Module-scoped so it survives re-renders; keyed by React Router's stable
// location.key. Only real PAGE changes (pathname) reset/restore — opening or
// closing an overlay (search-only change) must leave the underlying scroll be.
export const _scrollByKey = new Map();
export function useScrollRestoration(location) {
  const navType = useNavigationType();               // "POP" | "PUSH" | "REPLACE"
  const prevPath = useRef(location.pathname);
  useEffect(() => {
    const el = document.querySelector(".sb-content");
    if (!el) return;
    const record = () => { _scrollByKey.set(location.key, el.scrollTop); };
    el.addEventListener("scroll", record, { passive: true });
    if (prevPath.current !== location.pathname) {     // a genuine page navigation
      if (navType === "POP") {                         // Back/Forward → restore
        const y = _scrollByKey.get(location.key);
        el.scrollTop = y != null ? y : 0;
      } else {                                         // new page → top, no jump
        el.scrollTop = 0;
      }
      prevPath.current = location.pathname;
    }
    return () => el.removeEventListener("scroll", record);
  }, [location.key, location.pathname, navType]);
}
