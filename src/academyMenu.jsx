/* IFC Creative Academy — anchored menu (portal), shared by Add content, item
   actions and course actions in the authoring workspace.

   • Rendered in a portal on <body>, so ancestor overflow (the scrollable
     outline) can't clip it — no z-index tricks.
   • Positioned from the trigger's live rect: below when it fits, above when it
     doesn't, else on the roomier side with the MENU (not the page) scrolling.
     Kept inside the viewport horizontally. Repositions on resize and on any
     scroll; closes if the trigger scrolls out of view.
   • Small screens (≤ 599 px): a bottom sheet with a scrim.
   • Keyboard: focus moves to the first item; ↑/↓/Home/End move; Escape or Tab
     closes and returns focus to the trigger. Outside click closes without
     stealing focus from what was clicked. Choosing an item doesn't return focus
     to the trigger (the caller moves it to whatever the choice opened). */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "./overlay.jsx";

const MARGIN = 8;

/* Pure placement maths (unit-tested). */
export function placeMenu({ anchor, menu, viewport, align = "start" }) {
  const below = viewport.height - anchor.bottom - MARGIN - 4;
  const above = anchor.top - MARGIN - 4;
  let side, maxHeight = null, top;
  if (menu.height <= below) side = "below";
  else if (menu.height <= above) side = "above";
  else { side = below >= above ? "below" : "above"; maxHeight = Math.max(120, side === "below" ? below : above); }
  const h = maxHeight ? Math.min(menu.height, maxHeight) : menu.height;
  top = side === "below" ? anchor.bottom + 4 : anchor.top - 4 - h;
  let left = align === "end" ? anchor.right - menu.width : anchor.left;
  left = Math.max(MARGIN, Math.min(left, viewport.width - menu.width - MARGIN));
  return { top: Math.round(top), left: Math.round(left), side, maxHeight };
}

export function AnchoredMenu({ anchorRef, open, onClose, label, align = "start", children, className = "" }) {
  const narrow = useMediaQuery("(max-width: 599px)");
  const menuRef = useRef(null);
  const [pos, setPos] = useState(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;

  const close = useCallback((reason) => {
    closeRef.current?.(reason);
    if (reason === "escape" || reason === "tab" || reason === "scroll") {
      const a = anchorRef.current;
      if (a && document.contains(a)) requestAnimationFrame(() => a.focus({ preventScroll: true }));
    }
  }, [anchorRef]);

  const place = useCallback(() => {
    const a = anchorRef.current, m = menuRef.current;
    if (!a || !m || narrow) return;
    const r = a.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) { close("scroll"); return; }
    m.style.maxHeight = "none";
    const size = { width: m.offsetWidth, height: m.scrollHeight };
    const p = placeMenu({ anchor: r, menu: size, viewport: { width: window.innerWidth, height: window.innerHeight }, align });
    m.style.maxHeight = p.maxHeight ? `${p.maxHeight}px` : "";
    setPos((old) => (old && old.top === p.top && old.left === p.left && old.side === p.side && old.maxHeight === p.maxHeight ? old : p));
  }, [anchorRef, align, narrow, close]);

  useLayoutEffect(() => { if (open) place(); else setPos(null); }, [open, place]);
  useEffect(() => {
    if (!open) return undefined;
    const onScroll = (e) => { if (menuRef.current && menuRef.current.contains(e.target)) return; place(); };
    const onDown = (e) => {
      const m = menuRef.current, a = anchorRef.current;
      if ((m && m.contains(e.target)) || (a && a.contains(e.target))) return;
      close("outside");
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    // content changes (e.g. "Add content below…" swapping in the five types) → re-place
    let lastH = -1;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { const h = menuRef.current?.scrollHeight || 0; if (h !== lastH) { lastH = h; place(); } }) : null;
    if (ro && menuRef.current) ro.observe(menuRef.current);
    document.addEventListener("pointerdown", onDown, true);
    const f = requestAnimationFrame(() => menuRef.current?.querySelector('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true }));
    return () => { cancelAnimationFrame(f); ro?.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", onScroll, true); document.removeEventListener("pointerdown", onDown, true); };
  }, [open, place, close, anchorRef]);

  const onKeyDown = (e) => {
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])') || [])];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close("escape"); }
    else if (e.key === "Tab") { e.preventDefault(); close("tab"); }
  };

  if (!open) return null;
  const menu = (
    <div ref={menuRef} role="menu" aria-label={label} onKeyDown={onKeyDown}
      className={"ac-menu ac-amenu " + (narrow ? "is-sheet " : "") + (pos ? `is-${pos.side} ` : "") + className}
      style={narrow ? undefined : { position: "fixed", top: pos ? pos.top : -9999, left: pos ? pos.left : -9999, visibility: pos ? "visible" : "hidden" }}>
      {narrow && <div className="ac-menusheethead" aria-hidden="true"><span className="ac-menusheetgrip" /><b>{label}</b></div>}
      {children}
    </div>
  );
  return createPortal(narrow ? <div className="ac-menuscrim" onPointerDown={(e) => { if (e.target === e.currentTarget) close("outside"); }}>{menu}</div> : menu, document.body);
}

/* A trigger + menu pair. `renderTrigger({ ref, open, toggle, props })`.
   `children(close)` renders the items; call close() after a choice. */
/* close() — after a choice that moves focus elsewhere (a new editor).
   close({ refocus: true }) — after a choice that opens a dialog: focus goes back
   to the trigger first, so the dialog restores focus there when it closes. */
export function MenuButton({ label, align, renderTrigger, children, onOpenChange, className }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const set = (v, opts) => { setOpen(v); onOpenChange?.(v); if (!v && opts?.refocus) ref.current?.focus({ preventScroll: true }); };
  return (
    <>
      {renderTrigger({ ref, open, toggle: () => set(!open), props: { "aria-haspopup": "menu", "aria-expanded": open } })}
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => set(false)} label={label} align={align} className={className}>
        {children((opts) => set(false, opts))}
      </AnchoredMenu>
    </>
  );
}
