import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { rowPages, activePage, pageProgress, liquidPill, stableWindow } from "./academyRowPages.js";

/* A horizontal browsing row (phones/tablets): native touch/trackpad scrolling
   with gentle snap, part of the next card visible, no visible scrollbar, and
   pagination dots underneath. The groups are measured from the rendered cards
   (academyRowPages.js) and re-measured whenever the row or a card changes size
   (resize, orientation, enlarged text) or the cards change. No dots when
   everything fits. No auto-advance, no looping, no custom drag (so a tap after a
   swipe never opens a card by accident, and a vertical swipe over the row
   scrolls the page). `wide="grid"` turns it back into a grid on desktop, where
   no dots show.

   Round 7 indicator: the dot BUTTONS never change size or move (stable hit
   areas). A separate small pill follows the actual scroll position every frame:
   it stretches toward the next dot, travels and settles (liquidPill). It is
   positioned with a transform + width on one absolutely positioned element
   (nothing else re-lays out), written straight to the DOM from a
   requestAnimationFrame — scrolling never re-renders the row or its cards. React
   state changes only when the CURRENT group changes (aria-current) or the dot
   window slides. Reduced motion: the pill jumps to the current dot. */
const PILL = 18;
const DOT = 28; // dot button width (px); keep in step with .ac-hdot in styles.css

export function HRow({ id, title, viewAll, children, wide = "row", noun = "item" }) {
  const ref = useRef(null);
  const dotsRef = useRef(null);
  const pillRef = useRef(null);
  const [pg, setPg] = useState({ pages: [], active: 0, max: 0, rtl: false, from: 0 });
  const pgRef = useRef(pg);
  pgRef.current = pg;
  const reduce = () => typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // place the pill for the current scroll position (no React render). Every
  // dot lives on one track; the pill is positioned in track coordinates, so it
  // moves continuously even while the visible window of dots slides.
  const paint = useCallback(() => {
    const el = ref.current, track = dotsRef.current, pill = pillRef.current;
    if (!el || !track || !pill) return;
    const st = pgRef.current;
    const btns = [...track.querySelectorAll(".ac-hdot")];
    if (!btns.length) return;
    const centers = btns.map((b) => b.offsetLeft + b.offsetWidth / 2);
    const prog = reduce() ? st.active : pageProgress(st.pages, Math.abs(el.scrollLeft), st.max);
    const { x, w } = liquidPill(prog, centers, 0, PILL);
    const tx = st.rtl ? -(track.scrollWidth - x - w) : x;
    pill.style.transform = `translateX(${tx}px)`;
    pill.style.width = `${w}px`;
  }, []);

  const measure = useCallback(() => {
    const el = ref.current; if (!el) return;
    const kids = [...el.children];
    const rtl = getComputedStyle(el).direction === "rtl";
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    let pages = [];
    if (kids.length && max > 2) {
      // Each card's start/end in scroll coordinates: the scrollLeft at which its
      // leading edge sits at the snap line (the row's inline padding).
      const er = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingInlineStart) || 0;
      const sl = Math.abs(el.scrollLeft);
      const cards = kids.map((k) => {
        const r = k.getBoundingClientRect();
        const s0 = (rtl ? er.right - r.right : r.left - er.left) + sl - pad;
        return { start: s0, end: s0 + r.width };
      });
      pages = rowPages(cards, el.clientWidth - pad, max);
    }
    setPg((old) => {
      const active = activePage(pages, Math.abs(el.scrollLeft), max);
      const from = stableWindow(pages.length, active, old.from);
      if (old.max === max && old.active === active && old.rtl === rtl && old.from === from && old.pages.length === pages.length && old.pages.every((p, i) => Math.abs(p - pages[i]) < 1)) return old;
      return { pages, active, max, rtl, from };
    });
  }, []);
  useEffect(() => {
    const el = ref.current; if (!el) return undefined;
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
    if (ro) { ro.observe(el); [...el.children].forEach((k) => ro.observe(k)); }
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(() => { if (ro) { ro.disconnect(); ro.observe(el); [...el.children].forEach((k) => ro.observe(k)); } measure(); }) : null;
    mo && mo.observe(el, { childList: true });
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => { ro && ro.disconnect(); mo && mo.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("orientationchange", measure); };
  }, [measure, children]);
  // after any render that changes the dots, put the pill in place
  useLayoutEffect(() => { paint(); }, [pg, paint]);

  const raf = useRef(0);
  const onScroll = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const el = ref.current; if (!el) return;
      const st = pgRef.current;
      const active = activePage(st.pages, Math.abs(el.scrollLeft), st.max);
      if (active !== st.active) {
        const from = stableWindow(st.pages.length, active, st.from);
        setPg((old) => ({ ...old, active, from }));
      }
      paint();
    });
  };
  useEffect(() => () => raf.current && cancelAnimationFrame(raf.current), []);
  const go = (i) => {
    const el = ref.current; if (!el) return;
    const left = pg.pages[i];
    el.scrollTo({ left: pg.rtl ? -left : left, behavior: reduce() ? "auto" : "smooth" });
    // the current dot (and the window) follow the scroll as it arrives
  };
  const n = pg.pages.length;
  const from = Math.min(pg.from, Math.max(0, n - 7)), to = Math.min(n, from + 7);
  return (
    <section aria-labelledby={id} className="ac-hsection">
      <div className="sb-shead ac-hhead">
        <h2 id={id} className="ac-h2">{title}</h2>
        {viewAll && <div className="ac-hctrl">{viewAll}</div>}
      </div>
      <div ref={ref} className={"ac-hrow" + (wide === "grid" ? " ac-hrow-gridwide" : "")} role="list" onScroll={onScroll}>
        {children}
      </div>
      {n > 1 && (
        /* a window of at most 7 dots onto a track holding every dot; the track
           slides (smoothly, or instantly with reduced motion) when the window moves */
        <div className="ac-hdots" role="group" aria-label={`${title}: groups`}>
          <div className="ac-hdots-view" style={{ width: `${Math.min(n, 7) * DOT}px` }}>
            <div className="ac-hdots-track" ref={dotsRef} style={{ transform: `translateX(${(pg.rtl ? 1 : -1) * from * DOT}px)` }}>
              <span className="ac-hpill" ref={pillRef} aria-hidden="true" />
              {pg.pages.map((_, i) => {
                const inside = i >= from && i < to;
                const edge = (i === from && from > 0) || (i === to - 1 && to < n);
                return (
                  <button key={i} type="button" className={"ac-hdot" + (i === pg.active ? " on" : "") + (edge ? " edge" : "")}
                    aria-label={`Show ${noun} group ${i + 1} of ${n}`} aria-current={i === pg.active ? "true" : undefined}
                    disabled={!inside} aria-hidden={inside ? undefined : "true"} onClick={() => go(i)}>
                    <span aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
