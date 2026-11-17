/* Row pagination maths (round 6). Run: node --test src/academyRowPages.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowPages, activePage, dotWindow } from "./academyRowPages.js";

// n cards of width w with gap g, laid out from 0
const cards = (n, w, g = 12) => Array.from({ length: n }, (_, i) => ({ start: i * (w + g), end: i * (w + g) + w }));
const maxOf = (cs, viewport) => Math.max(0, cs[cs.length - 1].end - viewport);

test("no groups when everything fits, or the row is empty", () => {
  assert.deepEqual(rowPages([], 358, 0), []);
  const cs = cards(2, 150);
  assert.deepEqual(rowPages(cs, 358, maxOf(cs, 358)), []);
  // a single card wider than nothing to scroll
  assert.deepEqual(rowPages(cards(1, 150), 358, 0), []);
});

test("groups start at the first card not fully visible; the last group reaches the final cards", () => {
  const cs = cards(7, 150); // 2 fully visible per 358px view
  const max = maxOf(cs, 358);
  const pages = rowPages(cs, 358, max);
  assert.equal(pages[0], 0);
  assert.equal(pages[pages.length - 1], max, "last dot = maximum scroll");
  assert.ok(pages.every((p, i) => i === 0 || p > pages[i - 1]), "strictly increasing");
  assert.ok(pages.every((p) => p <= max));
  assert.equal(pages.length, 4); // cards 0-1, 2-3, 4-5, then the end (5-6)
});

test("recomputes from rendered sizes: enlarged text (wider cards) yields more groups", () => {
  const normal = cards(7, 150), big = cards(7, 220);
  assert.ok(rowPages(big, 358, maxOf(big, 358)).length > rowPages(normal, 358, maxOf(normal, 358)).length);
});

test("a card wider than the view still advances (no infinite loop)", () => {
  const cs = cards(3, 500);
  const pages = rowPages(cs, 358, maxOf(cs, 358));
  assert.ok(pages.length >= 2 && pages.length <= 7);
  assert.equal(pages.at(-1), maxOf(cs, 358));
});

test("active group follows the scroll position; the end is always the last group", () => {
  const pages = [0, 324, 648, 708];
  assert.equal(activePage(pages, 0, 708), 0);
  assert.equal(activePage(pages, 330, 708), 1);
  assert.equal(activePage(pages, 700, 708), 3); // within tolerance of the end
  assert.equal(activePage(pages, 707, 708), 3);
  assert.equal(activePage([], 50, 100), 0);
});

test("long collections get a sliding window of at most 7 indicators", () => {
  assert.deepEqual(dotWindow(4, 2), { from: 0, to: 4 });
  assert.deepEqual(dotWindow(20, 0), { from: 0, to: 7 });
  assert.deepEqual(dotWindow(20, 10), { from: 7, to: 14 });
  assert.deepEqual(dotWindow(20, 19), { from: 13, to: 20 });
});

import { pageProgress, liquidPill, stableWindow } from "./academyRowPages.js";
test("progress follows the real scroll between groups", () => {
  const pages = [0, 300, 600, 700];
  assert.equal(pageProgress(pages, 0, 700), 0);
  assert.equal(pageProgress(pages, 150, 700), 0.5);
  assert.equal(pageProgress(pages, 300, 700), 1);
  assert.equal(pageProgress(pages, 650, 700), 2.5);
  assert.equal(pageProgress(pages, 700, 700), 3);
  assert.equal(pageProgress([], 50, 100), 0);
});
test("liquid pill: settled at a dot, stretched to span both dots half way, settled at the next", () => {
  const centers = [14, 42, 70];
  assert.deepEqual(liquidPill(0, centers, 0, 18), { x: 5, w: 18 });
  const mid = liquidPill(0.5, centers, 0, 18);
  assert.equal(mid.x, 5); assert.equal(mid.w, 18 + 28);          // leading edge reached the next dot
  assert.deepEqual(liquidPill(1, centers, 0, 18), { x: 33, w: 18 });
  // backwards: from 1 toward 0 the LEFT edge leads
  const back = liquidPill(0.75, centers, 0, 18);
  assert.ok(back.x < 33 && back.x + back.w === 42 + 9);
  // never exaggerated: at most one gap wider than the pill
  for (let p = 0; p <= 2; p += 0.05) assert.ok(liquidPill(p, centers, 0, 18).w <= 18 + 28 + 1e-9);
  // positions inside a sliding window (from = 3) and clamping beyond it
  assert.deepEqual(liquidPill(3, centers, 3, 18), { x: 5, w: 18 });
  assert.deepEqual(liquidPill(9, centers, 3, 18), { x: 61, w: 18 });
});
test("stable window: stays put while the current group moves inside, slides only at its edges", () => {
  assert.equal(stableWindow(5, 4, 0), 0);
  let from = 0;
  const seen = [];
  for (let a = 0; a < 20; a++) { from = stableWindow(20, a, from); seen.push(from); }
  assert.deepEqual(seen.slice(0, 6), [0, 0, 0, 0, 0, 0]);          // no movement for the first groups
  assert.equal(seen[19], 13);                                       // reaches the end
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] - seen[i - 1] <= 1);  // one step at a time
  assert.equal(stableWindow(20, 0, 13), 0);                         // jumping back to the start
});
