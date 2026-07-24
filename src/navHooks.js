/* React navigation adapters over react-router + src/nav.js. DOM/router only —
   no Firebase — so the real hooks can be exercised under jsdom in tests. The
   UI (App.jsx) consumes these instead of touching history or pathnames. */
import { useMemo, useCallback, useRef, useEffect } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import {
  parseLocation, pathForScreen, fallbackPath, withParams, PARAM,
  openComposeNew as buildComposeNew, openComposeEdit as buildComposeEdit,
  openPanel as buildPanel, closeOverlays,
} from "./nav.js";

/* The ONE hook that reads the URL and exposes parsed nav state + typed actions.
   Normal forward moves push a real history entry; only genuine
   redirects/normalisation replace. */
export function useNav() {
  const location = useLocation();
  const navigate = useNavigate();
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
    // Overlays (push): mutually exclusive by construction (see nav.js helpers).
    openComposeNew: () => setSearch(buildComposeNew(location.search)),
    openComposeEdit: (id) => setSearch(buildComposeEdit(location.search, id)),
    openPanel: (name) => setSearch(buildPanel(location.search, name)),
    closeOverlay: () => setSearch(closeOverlays(location.search)),
    // Shareable filters live in the query string too.
    setEventFilter: (id, occ) =>
      navigate(
        { pathname: "/workflow", search: withParams(location.search, { [PARAM.event]: id }) },
        { state: occ ? { eventOcc: occ } : undefined }
      ),
    clearEventFilter: () => setSearch(withParams(location.search, { [PARAM.event]: null })),
    setAdminSection: (section) =>
      setSearch(withParams(location.search, { [PARAM.section]: section || null })),
    // Safe Back: honour real app history, else fall back so we never step out
    // of the app into wherever the tab was opened from.
    goBack: () => {
      if (window.history.state && typeof window.history.state.idx === "number" && window.history.state.idx > 0)
        navigate(-1);
      else navigate(fallbackPath(nav), { replace: true });
    },
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
