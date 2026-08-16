/* Overlay primitives, kept firebase-free so the accessibility machinery is
   unit-testable in isolation (RTL + jsdom). App.jsx re-exports Portal so existing
   `import { Portal } from "./App.jsx"` call-sites keep working.

   Every dialog / bottom-sheet / drawer renders through <Portal>, which:
   - renders into document.body so it escapes any transformed/animated ancestor's
     stacking context and layers above the floating nav;
   - manages focus for ALL overlays: focus moves in on open and returns to the
     triggering control on close;
   - and, for TRUE MODALS only (`modal` — the default), makes the background inert
     + scroll-locked and traps Tab inside the topmost modal. A `modal={false}`
     popover/menu keeps the background live and does NOT trap or carry aria-modal. */
import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

let _savedScrollY = 0;
const _activeOverlays = new Set();
function applyBackgroundLock() {
  _savedScrollY = window.scrollY || window.pageYOffset || 0;
  const b = document.body;
  b.style.position = "fixed";
  b.style.top = `-${_savedScrollY}px`;
  b.style.left = "0";
  b.style.right = "0";
  b.style.width = "100%";
  document.getElementById("root")?.setAttribute("inert", "");
}
function releaseBackgroundLock() {
  const b = document.body;
  b.style.position = "";
  b.style.top = "";
  b.style.left = "";
  b.style.right = "";
  b.style.width = "";
  document.getElementById("root")?.removeAttribute("inert");
  window.scrollTo(0, _savedScrollY);
}
function acquireOverlay(token) {
  const wasEmpty = _activeOverlays.size === 0;
  _activeOverlays.add(token);
  if (wasEmpty && _activeOverlays.size === 1) applyBackgroundLock();
}
function releaseOverlay(token) {
  _activeOverlays.delete(token);
  if (_activeOverlays.size === 0) releaseBackgroundLock();
}

/* Reset the URL to a canonical route (no transient overlay/filter query). Used by
   sign-out so `?panel=profile` etc. can't survive into the next user's session.
   Extracted here so it can be unit-tested without firebase. */
export function resetUrlToCanonical() {
  try { window.history.replaceState(null, "", "/"); } catch { /* non-browser */ }
}

export function Portal({ children, modal = true }) {
  const token = useRef();
  const rootRef = useRef(null);
  const prevFocusRef = useRef(null);
  if (!token.current) token.current = Symbol("overlay");
  // (1) Capture the trigger once, restore focus to it once on unmount — decoupled
  // from `modal` so a viewport-driven modal↔non-modal switch never mis-restores.
  useLayoutEffect(() => {
    prevFocusRef.current = document.activeElement;
    return () => {
      const pf = prevFocusRef.current;
      if (pf && typeof pf.focus === "function" && document.contains(pf)) pf.focus({ preventScroll: true });
    };
  }, []);
  // (2) Move focus into the overlay on open (unless it focused something itself).
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      if (root.contains(document.activeElement) && document.activeElement !== document.body) return;
      const dlg = root.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]') || root;
      const focusable = dlg.querySelector('input:not([type="hidden"]),textarea,select,button,[href],[tabindex]:not([tabindex="-1"])');
      (focusable || dlg).focus?.({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  // (3) Modal-only behaviours: inert + scroll-lock, and a topmost-wins Tab trap.
  // These toggle with `modal`, so a responsive overlay stays correct across resizes.
  useLayoutEffect(() => {
    if (!modal) return;
    const t = token.current;
    acquireOverlay(t);
    const SEL = 'a[href],button:not([disabled]),input:not([type="hidden"]),textarea,select,[tabindex]:not([tabindex="-1"])';
    const onKey = (e) => {
      if (e.key !== "Tab") return;
      const root = rootRef.current; if (!root) return;
      const dlg = root.querySelector('[role="dialog"],[role="alertdialog"]'); if (!dlg) return;
      const all = document.querySelectorAll('[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]');
      if (all.length && all[all.length - 1] !== dlg) return;  // only the topmost modal traps
      const f = [...dlg.querySelectorAll(SEL)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1], ae = document.activeElement;
      if (!dlg.contains(ae)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && ae === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && ae === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); releaseOverlay(t); };
  }, [modal]);
  return createPortal(<div ref={rootRef} style={{ display: "contents" }}>{children}</div>, document.body);
}

/* Bottom-sheet drag-to-dismiss. Pure pointer/touch math + transform — no
   firebase, no router — so drawers/sheets that use it stay unit-testable. Drag
   down past a distance or flick threshold calls onClose; otherwise it springs
   back. Lives here (overlay primitives) so both App.jsx sheets and the extracted
   NotifPanelShell share one implementation. */
export function useSheetDrag(onClose) {
  const [y, setY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const st = useRef(null);
  const start = (e) => {
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    st.current = { y0:cy, last:cy, t:Date.now(), lt:Date.now() };
    setDragging(true);
  };
  const move = (e) => {
    if (!st.current) return;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    st.current.last = cy; st.current.lt = Date.now();
    setY(Math.max(0, cy - st.current.y0));
  };
  const end = () => {
    if (!st.current) return;
    const dy = Math.max(0, st.current.last - st.current.y0);
    const v = dy / Math.max(1, st.current.lt - st.current.t);     // px per ms
    st.current = null; setDragging(false);
    if (dy > 110 || v > 0.55) onClose(); else setY(0);
  };
  return {
    handleProps: { onTouchStart:start, onTouchMove:move, onTouchEnd:end,
      onPointerDown:start, onPointerMove:(e)=>{ if(st.current) move(e); }, onPointerUp:end },
    sheetStyle: { transform:`translateY(${y}px)`,
      transition: dragging ? "none" : "transform .28s cubic-bezier(.32,1.32,.5,1)" },
  };
}

/* Tracks a media query as a boolean (SSR-safe, updates on change). */
export function useMediaQuery(query) {
  const [match, setMatch] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}
