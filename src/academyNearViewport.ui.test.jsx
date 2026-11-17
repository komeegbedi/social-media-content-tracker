/* Image look-ahead (useNearViewport): observers are rooted on the app's REAL
   scrollers (.sb-content-style vertical container, horizontal card rows), and a
   card in a row only becomes "near" when the row is vertically near AND the
   card is horizontally near. Run: npm run test:ui */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";
import { useNearViewport, scrollRoots, VERTICAL_AHEAD, HORIZONTAL_AHEAD } from "./academyShared.jsx";

let made;
class FakeIO {
  constructor(cb, opts) { this.cb = cb; this.opts = opts; this.targets = []; this.disconnected = false; made.push(this); }
  observe(t) { this.targets.push(t); }
  disconnect() { this.disconnected = true; }
  fire(isIntersecting) { act(() => this.cb(this.targets.map((target) => ({ target, isIntersecting })))); }
}
beforeEach(() => { made = []; vi.stubGlobal("IntersectionObserver", FakeIO); });
afterEach(() => vi.unstubAllGlobals());

function Probe({ skip }) {
  const [near, setRef] = useNearViewport(skip);
  return <div ref={setRef} data-testid="probe" data-near={String(near)} />;
}
const near = () => screen.getByTestId("probe").dataset.near;

describe("useNearViewport", () => {
  test("a card inside a horizontal row inside the scrolling page: two observers on the real roots", () => {
    render(<div data-testid="page" style={{ overflowY: "auto" }}><div data-testid="row" style={{ overflowX: "auto", overflowY: "hidden" }}><Probe /></div></div>);
    const page = screen.getByTestId("page"), row = screen.getByTestId("row"), probe = screen.getByTestId("probe");
    expect(scrollRoots(probe)).toEqual({ row, page });
    const [vert, horiz] = made;
    expect(vert.opts).toEqual({ root: page, rootMargin: `${VERTICAL_AHEAD}px 0px` });
    expect(vert.targets).toEqual([row]);                // the ROW is measured against the page (the card itself is clipped by the row)
    expect(horiz.opts).toEqual({ root: row, rootMargin: `0px ${HORIZONTAL_AHEAD}` });
    expect(horiz.targets).toEqual([probe]);
    expect(near()).toBe("false");
    horiz.fire(true);                                   // horizontally near, but the row is still far below
    expect(near()).toBe("false");
    vert.fire(true);
    expect(near()).toBe("true");
    expect(vert.disconnected && horiz.disconnected).toBe(true);
  });

  test("the row approaching vertically is not enough while the card is far along the row", () => {
    render(<div style={{ overflowY: "auto" }}><div style={{ overflowX: "auto", overflowY: "hidden" }}><Probe /></div></div>);
    const [vert, horiz] = made;
    vert.fire(true); horiz.fire(false);
    expect(near()).toBe("false");
    vert.fire(false); horiz.fire(true);                 // the row scrolled back out before the card came near
    expect(near()).toBe("false");
    vert.fire(true);
    expect(near()).toBe("true");
  });

  test("outside any row: one observer on the nearest vertical scroller", () => {
    render(<div data-testid="page" style={{ overflowY: "scroll" }}><div style={{ overflow: "hidden" }}><Probe /></div></div>);
    expect(made).toHaveLength(1);
    expect(made[0].opts.root).toBe(screen.getByTestId("page"));
    made[0].fire(true);
    expect(near()).toBe("true");
  });

  test("no scrolling ancestor: rooted on the document", () => {
    render(<Probe />);
    expect(made).toHaveLength(1);
    expect(made[0].opts.root).toBe(null);
  });

  test("eager images never observe", () => {
    render(<Probe skip />);
    expect(near()).toBe("true");
    expect(made).toHaveLength(0);
  });
});

test("without IntersectionObserver everything is near", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  render(<Probe />);
  expect(near()).toBe("true");
});
