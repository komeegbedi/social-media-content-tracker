/* Round 6: the browsing row's pagination dots, with layout stubbed (jsdom has no
   layout; real geometry is exercised in the browser journey). Cards are 150px
   wide with a 12px gap in a 390px row with 16px padding. */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import { HRow } from "./academyRow.jsx";

const W = 150, GAP = 12, PAD = 16, VIEW = 390;
let scrollLeft = 0;
let cardW = W;

function stubLayout() {
  const proto = HTMLElement.prototype;
  vi.spyOn(proto, "getBoundingClientRect").mockImplementation(function () {
    if (this.classList.contains("ac-hrow")) return { left: 0, right: VIEW, width: VIEW, top: 0, bottom: 200, height: 200 };
    const i = [...this.parentElement.children].indexOf(this);
    const left = PAD + i * (cardW + GAP) - scrollLeft;
    return { left, right: left + cardW, width: cardW, top: 0, bottom: 200, height: 200 };
  });
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get() { return this.classList.contains("ac-hrow") ? PAD * 2 + this.children.length * cardW + (this.children.length - 1) * GAP : 0; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return this.classList.contains("ac-hrow") ? VIEW : 0; } });
  Object.defineProperty(proto, "offsetLeft", { configurable: true, get() { return this.classList.contains("ac-hdot") ? [...this.parentElement.querySelectorAll(".ac-hdot")].indexOf(this) * 28 : 0; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return this.classList.contains("ac-hdot") ? 28 : 0; } });
  Object.defineProperty(proto, "scrollLeft", { configurable: true, get() { return scrollLeft; }, set(v) { scrollLeft = v; } });
  proto.scrollTo = function ({ left }) { scrollLeft = left; this.dispatchEvent(new Event("scroll")); };
}

beforeEach(() => {
  scrollLeft = 0; cardW = W;
  stubLayout();
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  let id = 0; window.requestAnimationFrame = (cb) => { const n = ++id; Promise.resolve().then(() => cb(n)); return n; };
  window.cancelAnimationFrame = () => {};
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["scrollWidth", "clientWidth", "scrollLeft", "offsetLeft", "offsetWidth"]) delete HTMLElement.prototype[k];
});

const Row = ({ n }) => (
  <HRow id="h" title="Explore categories" noun="category" viewAll={<a href="/all">View all</a>}>
    {Array.from({ length: n }, (_, i) => <div key={i} role="listitem">Card {i + 1}</div>)}
  </HRow>
);
const dots = () => screen.queryAllByRole("button", { name: /^Show category group/ });

describe("HRow pagination dots", () => {
  test("no dots when everything fits; none for an empty or single-card row", () => {
    const { unmount } = render(<Row n={2} />); expect(dots()).toHaveLength(0); unmount();
    const u2 = render(<Row n={1} />); expect(dots()).toHaveLength(0); u2.unmount();
    render(<Row n={0} />); expect(dots()).toHaveLength(0);
  });
  test("one dot per measured group, labelled with position and count; the first is current", () => {
    render(<Row n={7} />);
    const d = dots();
    expect(d.length).toBe(4);
    expect(d[0]).toHaveAccessibleName("Show category group 1 of 4");
    expect(d[0]).toHaveAttribute("aria-current", "true");
    expect(d[3]).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("button", { name: /Scroll .* (back|forward)/ })).toBeNull(); // no arrows
  });
  test("clicking the last dot scrolls to the end of the row and marks it current", async () => {
    render(<Row n={7} />);
    await act(async () => { fireEvent.click(dots().at(-1)); });
    const max = PAD * 2 + 7 * W + 6 * GAP - VIEW;
    expect(scrollLeft).toBe(max);
    expect(dots().at(-1)).toHaveAttribute("aria-current", "true");
  });
  test("scrolling by hand moves the current dot", async () => {
    render(<Row n={7} />);
    const row = document.querySelector(".ac-hrow");
    await act(async () => { scrollLeft = 2 * (W + GAP); fireEvent.scroll(row); });
    expect(dots()[1]).toHaveAttribute("aria-current", "true");
    await act(async () => { scrollLeft = 0; fireEvent.scroll(row); });
    expect(dots()[0]).toHaveAttribute("aria-current", "true");
  });
  test("re-measures on resize: larger cards (enlarged text) give more groups", () => {
    render(<Row n={7} />);
    const before = dots().length;
    act(() => { cardW = 230; window.dispatchEvent(new Event("resize")); });
    expect(dots().length).toBeGreaterThan(before);
  });
  test("a long collection shows at most 7 indicators", () => {
    render(<Row n={40} />);
    expect(dots().length).toBeLessThanOrEqual(7);
    expect(dots()[0].getAttribute("aria-label")).toMatch(/of (\d+)$/);
    expect(Number(dots()[0].getAttribute("aria-label").match(/of (\d+)$/)[1])).toBeGreaterThan(7);
  });
  test("the pill follows the scroll position (stretching between dots) without moving the buttons", async () => {
    render(<Row n={7} />);
    const pill = document.querySelector(".ac-hpill");
    const btnW = dots().map((d) => d.className);
    const row = document.querySelector(".ac-hrow");
    await act(async () => { scrollLeft = 0; fireEvent.scroll(row); });
    const w0 = parseFloat(pill.style.width);
    await act(async () => { scrollLeft = 162; fireEvent.scroll(row); });   // half way to group 2 (starts at 324)
    expect(parseFloat(pill.style.width)).toBeGreaterThan(w0);                // stretched toward the next dot
    expect(dots()[0]).toHaveAttribute("aria-current", "true");               // nearest group is still the first
    await act(async () => { fireEvent.click(dots()[1]); });                 // scrolls exactly to group 2
    expect(parseFloat(pill.style.width)).toBe(w0);                           // settled on dot 2
    expect(dots()[1]).toHaveAttribute("aria-current", "true");
    expect(dots().length).toBe(btnW.length);
  });
  test("reduced motion: the pill sits on the current dot (no stretching)", async () => {
    window.matchMedia = (q) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
    render(<Row n={7} />);
    const pill = document.querySelector(".ac-hpill");
    const row = document.querySelector(".ac-hrow");
    await act(async () => { scrollLeft = 162; fireEvent.scroll(row); });
    expect(parseFloat(pill.style.width)).toBe(18);
  });
  test("long rows: the window of dots stays put while moving inside it", async () => {
    render(<Row n={40} />);
    const first = dots()[0].getAttribute("aria-label");
    const row = document.querySelector(".ac-hrow");
    await act(async () => { scrollLeft = 2 * 162; fireEvent.scroll(row); });
    expect(dots()[0].getAttribute("aria-label")).toBe(first);
  });
  test("header: title then a single View all link", () => {
    render(<Row n={7} />);
    expect(screen.getByRole("heading", { name: "Explore categories" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "View all" })).toHaveLength(1);
  });
});
