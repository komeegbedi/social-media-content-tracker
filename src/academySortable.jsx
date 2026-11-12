/* IFC Creative Academy — accessible drag-and-drop list.

   Pointer (mouse, pen, touch): drag a row by its visible handle. Only the
   handle has `touch-action: none`, so touching anything else scrolls normally.
   While dragging:
     • the dragged row — or a whole BLOCK (a section header + its lessons, via
       `spanOf`) — stays attached to the pointer (transform only);
     • the other rows slide into the places they'll occupy (transform + a short
       transition, none under prefers-reduced-motion) — nothing is inserted into
       the list, so there's no layout jitter;
     • a thin insertion line (absolutely positioned) marks the landing slot;
     • the real scroll container (the outline, or the page) auto-scrolls near
       its edges, and positions are recomputed from live geometry;
     • text selection is suppressed and the click that ends a drag is swallowed,
       so a drop never navigates.
   On drop the list reports `onMove(id, slot)` — `slot` is the insertion index
   among the rows that remain after removing the dragged block. Dropping where
   it started reports nothing (no-op → no Undo). The caller reorders its data
   synchronously; transitions are disabled for that frame so rows don't jump.

   Keyboard: focus a handle, Space/Enter to lift, ↑/↓ (Home/End) to move
   between allowed slots, Space/Enter to drop, Escape to cancel; every step is
   announced in a polite live region. Callers also offer "Move to position…". */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bars3Icon } from "@heroicons/react/24/outline";
export { useUndo } from "./academyUndo.jsx";

function scrollParent(el) {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return document.scrollingElement || document.documentElement;
}
const isDocScroller = (el) => el === document.scrollingElement || el === document.documentElement || el === document.body;

/* Geometry of a drag, measured once at lift (positions relative to the list). */
function measure(listEl, items, startIndex, span) {
  const els = [...listEl.querySelectorAll(":scope > [data-sort-row]")];
  const base = listEl.getBoundingClientRect().top;
  const rects = els.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top - base, height: r.height }; });
  const gap = rects.length > 1 ? Math.max(0, rects[1].top - (rects[0].top + rects[0].height)) : 0;
  const end = startIndex + span;
  const blockTop = rects[startIndex].top;
  const blockH = rects[end - 1].top + rects[end - 1].height - blockTop + gap;
  const rest = items.map((_, i) => i).filter((i) => i < startIndex || i >= end);
  // top of each remaining row once the block is taken out
  const restTop = rest.map((i) => rects[i].top - (i >= end ? blockH : 0));
  const lastBottom = rest.length ? restTop[rest.length - 1] + rects[rest[rest.length - 1]].height + gap : 0;
  const slotY = (s) => (s < rest.length ? restTop[s] : lastBottom);
  return { rects, gap, end, blockTop, blockH, rest, slotY };
}

export function SortableList({
  items, getLabel, canDrag = () => true, onMove, renderItem, className = "", disabled = false,
  spanOf = () => 1, canDropAt = () => true, positionLabel,
}) {
  const listRef = useRef(null);
  const [drag, setDrag] = useState(null);        // { id, start, span, slot, dy, kind: "pointer"|"keyboard" }
  const [settling, setSettling] = useState(false);
  const [msg, setMsg] = useState("");
  const st = useRef({});
  const dragRef = useRef(null); dragRef.current = drag;

  const indexOf = (id) => items.findIndex((x) => x.id === id);
  const restItems = (start, span) => items.filter((_, i) => i < start || i >= start + span);
  const allowedSlots = (item, start, span) => {
    const rest = restItems(start, span);
    const out = [];
    for (let s = 0; s <= rest.length; s++) if (canDropAt(item, s, rest)) out.push(s);
    return out;
  };
  const describe = (item, slot, slots) => (positionLabel ? positionLabel(item, slot, slots) : `position ${slots.indexOf(slot) + 1} of ${slots.length}`);

  /* Settle: after a drop the parent re-renders in the new order; transforms go
     to zero WITHOUT a transition for one frame so nothing visibly jumps. */
  useLayoutEffect(() => {
    if (!settling) return undefined;
    const r = requestAnimationFrame(() => setSettling(false));
    return () => cancelAnimationFrame(r);
  }, [settling]);

  // If the rows change underneath an active drag (another editor), cancel it.
  const sig = items.map((x) => x.id).join("|");
  const sigAtStart = useRef(sig);
  useEffect(() => { if (drag && sigAtStart.current !== sig) cancel("The list changed while you were moving an item; the move was cancelled."); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = (item, kind) => {
    const start = indexOf(item.id);
    const span = Math.max(1, spanOf(item, start, items) || 1);
    const g = measure(listRef.current, items, start, span);
    const slots = allowedSlots(item, start, span);
    sigAtStart.current = sig;
    return { item, start, span, g, slots, from: start };   // a block's original slot == its start index
  };

  /* ---- pointer ---- */
  const nearestSlot = (s, y) => {
    let best = s.slots[0] ?? s.from, d = Infinity;
    for (const k of s.slots) { const dd = Math.abs(s.g.slotY(k) - y); if (dd < d) { d = dd; best = k; } }
    return best;
  };
  const onPointerDown = (e, item) => {
    if (disabled || drag || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
    const b = begin(item, "pointer");
    const scroller = scrollParent(listRef.current);
    st.current = { ...b, pointerId: e.pointerId, startY: e.clientY, startListTop: listRef.current.getBoundingClientRect().top, lastY: e.clientY, scroller, moved: false, raf: 0 };
    document.body.classList.add("ac-dragging");
    setDrag({ id: item.id, start: b.start, span: b.span, slot: b.from, dy: 0, kind: "pointer" });
    const tick = () => {
      const s = st.current; if (!s.item) return;
      const r = isDocScroller(s.scroller) ? { top: 0, bottom: window.innerHeight } : s.scroller.getBoundingClientRect();
      const edge = Math.min(64, (r.bottom - r.top) / 4), y = s.lastY;
      let v = 0;
      if (y < r.top + edge) v = -Math.ceil(((r.top + edge - y) / edge) * 14);
      else if (y > r.bottom - edge) v = Math.ceil(((y - (r.bottom - edge)) / edge) * 14);
      if (v) { const before = s.scroller.scrollTop; s.scroller.scrollTop += v; if (s.scroller.scrollTop !== before) follow(y); }
      s.raf = requestAnimationFrame(tick);
    };
    st.current.raf = requestAnimationFrame(tick);
  };
  const follow = (clientY) => {
    const s = st.current; if (!s.item) return;
    s.lastY = clientY;
    if (Math.abs(clientY - s.startY) > 3) s.moved = true;
    // pointer position in list coordinates, so scrolling is accounted for
    const listTop = listRef.current.getBoundingClientRect().top;
    const dy = (clientY - listTop) - (s.startY - s.startListTop);
    const slot = nearestSlot(s, s.g.blockTop + dy);
    setDrag((d) => (d && d.kind === "pointer" ? (d.dy === dy && d.slot === slot ? d : { ...d, dy, slot }) : d));
  };
  const finishPointer = (commit) => {
    const s = st.current; if (!s.item) return;
    cancelAnimationFrame(s.raf);
    document.body.classList.remove("ac-dragging");
    st.current = {};
    const d = dragRef.current;
    if (s.moved) {   // swallow the click that follows a real drag (no accidental navigation)
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    }
    setSettling(true);
    setDrag(null);
    if (commit && d && d.slot !== s.from) {
      onMove(s.item.id, d.slot);
      setMsg(`Moved ${getLabel(s.item)}.`);
    }
  };
  const cancel = (why) => {
    if (st.current.item) { cancelAnimationFrame(st.current.raf); document.body.classList.remove("ac-dragging"); st.current = {}; }
    setSettling(true); setDrag(null);
    if (why) setMsg(why);
  };
  useEffect(() => () => { cancelAnimationFrame(st.current.raf); document.body.classList.remove("ac-dragging"); }, []);

  /* ---- keyboard ---- */
  const kb = useRef(null);
  const onHandleKey = (e, item) => {
    if (disabled) return;
    const k = e.key;
    const d = dragRef.current;
    if (!d) {
      if (k === " " || k === "Enter") {
        e.preventDefault();
        const b = begin(item, "keyboard");
        kb.current = b;
        setDrag({ id: item.id, start: b.start, span: b.span, slot: b.from, dy: 0, kind: "keyboard" });
        setMsg(`Picked up ${getLabel(item)}${b.span > 1 ? ` and its ${b.span - 1} item${b.span === 2 ? "" : "s"}` : ""}. ${describe(item, b.from, b.slots)}. Use the arrow keys to move, Space to drop, Escape to cancel.`);
      }
      return;
    }
    if (d.kind !== "keyboard" || d.id !== item.id) return;
    const b = kb.current;
    const i = b.slots.indexOf(d.slot);
    if (k === "ArrowUp" || k === "ArrowDown" || k === "Home" || k === "End") {
      e.preventDefault();
      const j = k === "Home" ? 0 : k === "End" ? b.slots.length - 1 : Math.max(0, Math.min(b.slots.length - 1, (i < 0 ? 0 : i) + (k === "ArrowUp" ? -1 : 1)));
      const slot = b.slots[j];
      setDrag({ ...d, slot, dy: b.g.slotY(slot) - b.g.blockTop });
      setMsg(`${getLabel(item)}: ${describe(item, slot, b.slots)}.`);
    } else if (k === " " || k === "Enter") {
      e.preventDefault();
      kb.current = null; setSettling(true); setDrag(null);
      if (d.slot !== b.from) { onMove(item.id, d.slot); setMsg(`Dropped ${getLabel(item)}, ${describe(item, d.slot, b.slots)}.`); }
      else setMsg(`${getLabel(item)} not moved.`);
    } else if (k === "Escape") {
      e.preventDefault(); kb.current = null; cancel(`Move cancelled. ${getLabel(item)} is back where it was.`);
    }
  };

  /* ---- transforms ---- */
  const g = drag ? (drag.kind === "keyboard" ? kb.current?.g : st.current.g) : null;
  const transformFor = (i) => {
    if (!drag || !g) return 0;
    const inBlock = i >= drag.start && i < drag.start + drag.span;
    if (inBlock) return drag.dy;
    const k = g.rest.indexOf(i);
    return (k >= drag.slot ? g.blockH : 0) - (i >= g.end ? g.blockH : 0);
  };
  const lineY = drag && g ? g.slotY(drag.slot) - Math.max(2, g.gap / 2) - 1 : null;

  const handleFor = (item) => (canDrag(item) ? {
    "aria-label": `Reorder ${getLabel(item)}`,
    "aria-describedby": "ac-sort-help",
    "aria-pressed": drag?.kind === "keyboard" && drag.id === item.id,
    className: "ac-handle" + (drag?.id === item.id ? " lifted" : ""),
    disabled,
    onPointerDown: (e) => onPointerDown(e, item),
    onPointerMove: (e) => { if (st.current.item && e.pointerId === st.current.pointerId) follow(e.clientY); },
    onPointerUp: () => finishPointer(true),
    onPointerCancel: () => finishPointer(false),
    onLostPointerCapture: () => { if (st.current.item) finishPointer(true); },
    onKeyDown: (e) => onHandleKey(e, item),
    onBlur: () => { if (dragRef.current?.kind === "keyboard" && dragRef.current.id === item.id) { kb.current = null; cancel("Move cancelled."); } },
    children: <Bars3Icon className="hi hi-sm" aria-hidden="true" />,
  } : null);

  return (
    <div className={"ac-sortable " + className + (drag ? " is-sorting" : "") + (settling ? " is-settling" : "")} ref={listRef}>
      <span id="ac-sort-help" className="sb-vh">Press Space to pick up, arrow keys to move, Space to drop, Escape to cancel.</span>
      <span className="sb-vh" aria-live="polite" role="status">{msg}</span>
      {items.map((item, i) => {
        const inBlock = drag && i >= drag.start && i < drag.start + drag.span;
        const y = transformFor(i);
        return (
          <div key={item.id} data-sort-row={item.id}
            className={"ac-dragrow" + (inBlock ? " dragging" : "") + (inBlock && drag.kind === "keyboard" ? " lifted" : "")}
            style={y ? { transform: `translate3d(0, ${y}px, 0)` } : undefined}>
            {renderItem(item, { handle: handleFor(item), index: i, dragging: !!inBlock })}
          </div>
        );
      })}
      {lineY != null && drag.slot !== (drag.kind === "keyboard" ? kb.current?.from : st.current.from) && (
        <div className="ac-dropline" aria-hidden="true" style={{ transform: `translate3d(0, ${lineY}px, 0)` }} />
      )}
    </div>
  );
}

/* A handle button from the props SortableList hands to renderItem. */
export const DragHandle = ({ handle }) => handle ? <button type="button" {...handle} /> : <span className="ac-handle-spacer" aria-hidden="true" />;
