/* Pagination for a horizontal browsing row (round 6), measured from the cards the
   browser actually rendered — not a fixed "N per page" guess — so it stays right
   after resizes, orientation changes, enlarged text and content changes.

   rowPages(): the scroll positions that start each group. A group starts at the
   first card not fully visible in the previous group; positions are clamped to
   the row's maximum scroll, so the last group always ends on the final cards.
   No groups (an empty array) when everything fits.

   activePage(): which group a scroll position belongs to.
   dotWindow(): at most `max` indicators, sliding with the active group, so a long
   collection never becomes dozens of dots. */

const EPS = 2; // px tolerance for sub-pixel layout

/** cards: [{ start, end }] in scroll coordinates (scrollLeft at which the card's
 *  leading edge is aligned with the row's first card). viewport: visible width.
 *  maxScroll: scrollWidth - clientWidth. */
export function rowPages(cards, viewport, maxScroll) {
  if (!cards.length || !(viewport > 0) || !(maxScroll > EPS)) return [];
  const pages = [0];
  let start = 0;
  for (;;) {
    const next = cards.find((c) => c.end > start + viewport + EPS);
    if (!next) break;
    let pos = Math.max(next.start, start + 1); // always advance
    if (pos >= maxScroll - EPS) { pages.push(maxScroll); break; }
    pages.push(pos);
    start = pos;
    if (pages.length > 500) break; // defensive: never loop on bad measurements
  }
  // the final group must reach the end of the row
  if (pages[pages.length - 1] < maxScroll - EPS) pages.push(maxScroll);
  // de-duplicate positions closer than a couple of pixels
  return pages.filter((p, i) => i === 0 || p - pages[i - 1] > EPS);
}

export function activePage(pages, scrollLeft, maxScroll) {
  if (!pages.length) return 0;
  if (scrollLeft >= maxScroll - EPS) return pages.length - 1;
  // the group whose start is nearest the current position
  let best = 0;
  for (let i = 1; i < pages.length; i++) if (Math.abs(pages[i] - scrollLeft) < Math.abs(pages[best] - scrollLeft)) best = i;
  return best;
}

export function dotWindow(count, active, max = 7) {
  if (count <= max) return { from: 0, to: count };
  const half = Math.floor(max / 2);
  const from = Math.min(Math.max(0, active - half), count - max);
  return { from, to: from + max };
}

/* Round 7: the moving indicator. */

/* Continuous position (fractional group index) for a scroll offset: 1.5 = half
   way from group 2 to group 3. Follows the real scroll, so a swipe, a trackpad
   fling or an interrupted smooth scroll all drive it directly. */
export function pageProgress(pages, scrollLeft, maxScroll) {
  if (pages.length < 2) return 0;
  const sl = Math.max(0, Math.min(scrollLeft, maxScroll));
  if (sl >= pages[pages.length - 1] - EPS) return pages.length - 1;
  for (let i = 0; i < pages.length - 1; i++) {
    const a = pages[i], b = pages[i + 1];
    if (sl <= b) return i + (b > a ? (sl - a) / (b - a) : 0);
  }
  return pages.length - 1;
}

const ease = (t) => t * t * (3 - 2 * t); // smoothstep: soft start and settle

/* The pill for a progress value: it stretches toward the next dot (the leading
   edge moves first), then the trailing edge catches up and it settles. Works the
   same in both directions. `centers` are the dot centres (px) of the visible
   window, `from` the window's first group; returns { x, w } in px. */
export function liquidPill(progress, centers, from, base = 18) {
  if (!centers.length) return { x: 0, w: base };
  const p = Math.max(from, Math.min(progress, from + centers.length - 1)) - from;
  const i = Math.floor(p), f = p - i;
  const c0 = centers[i], c1 = centers[Math.min(i + 1, centers.length - 1)];
  const d = c1 - c0;
  const lead = ease(Math.min(1, f * 2)), trail = ease(Math.max(0, f * 2 - 1));
  const left = c0 - base / 2 + d * trail, right = c0 + base / 2 + d * lead;
  return { x: left, w: right - left };
}

/* A window of at most `max` dots that stays put while the current group moves
   inside it and slides only when the current group reaches its edge. */
export function stableWindow(count, active, prevFrom = 0, max = 7) {
  if (count <= max) return 0;
  let from = Math.max(0, Math.min(prevFrom, count - max));
  if (active < from + 1) from = Math.max(0, active - 1);
  else if (active > from + max - 2) from = Math.min(count - max, active - max + 2);
  return from;
}
