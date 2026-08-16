/* Direction-safe tab-centering math (src/rtlScroll.js). Run: node --test src/rtlScroll.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { centeredScrollTarget } from "./rtlScroll.js";

// Applying the target must leave the element's centre on the box's centre — the
// definition of "centered" — in both LTR and RTL scroll models.
function centreAfter({ scrollLeft, boxLeft, boxWidth, elLeft, elWidth }) {
  const target = centeredScrollTarget({ scrollLeft, boxLeft, boxWidth, elLeft, elWidth });
  const applied = target - scrollLeft;            // how much we scrolled
  const elLeftAfter = elLeft - applied;           // content moves opposite to scroll
  const elCentreAfter = elLeftAfter + elWidth / 2;
  const boxCentre = boxLeft + boxWidth / 2;
  return { elCentreAfter, boxCentre };
}

test("centers an element to the box centre (LTR-style rects)", () => {
  const { elCentreAfter, boxCentre } = centreAfter({ scrollLeft: 0, boxLeft: 0, boxWidth: 800, elLeft: 700, elWidth: 60 });
  assert.equal(Math.round(elCentreAfter), Math.round(boxCentre));
});

test("centers with a non-zero starting scrollLeft (already scrolled)", () => {
  const { elCentreAfter, boxCentre } = centreAfter({ scrollLeft: 120, boxLeft: 0, boxWidth: 400, elLeft: 30, elWidth: 80 });
  assert.equal(Math.round(elCentreAfter), Math.round(boxCentre));
});

test("centers under an RTL negative-scroll model (scrollLeft <= 0)", () => {
  // Modern RTL: scrollLeft starts at 0 (inline-start = right) and goes negative.
  const { elCentreAfter, boxCentre } = centreAfter({ scrollLeft: -150, boxLeft: 0, boxWidth: 500, elLeft: 40, elWidth: 90 });
  assert.equal(Math.round(elCentreAfter), Math.round(boxCentre));
});

test("an already-centered element needs (near) zero adjustment", () => {
  const t = centeredScrollTarget({ scrollLeft: 200, boxLeft: 0, boxWidth: 300, elLeft: 120, elWidth: 60 });
  assert.equal(Math.round(t - 200), 0);   // el centre (150) already == box centre (150)
});
