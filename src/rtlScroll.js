/* Direction-safe horizontal-centering math for an overflowing tab/chip strip.
   Firebase-free + pure, so the calculation is unit-testable. It works from PHYSICAL
   bounding-rect deltas, so it is correct in both LTR and RTL — it never assumes a
   positive scrollLeft means "logical forward" (RTL scroll models vary). The caller
   applies the result with element.scroll* and lets the browser clamp to the valid
   range (which differs by RTL model). Run: node --test src/rtlScroll.test.js */

// Physical scrollLeft that puts `el`'s centre on `box`'s centre.
//   scrollLeft — the container's current scrollLeft (any RTL model)
//   boxLeft/boxWidth — the container's viewport rect
//   elLeft/elWidth — the active element's rect
// Returns the target scrollLeft (UN-clamped; the browser clamps to its range).
export function centeredScrollTarget({ scrollLeft, boxLeft, boxWidth, elLeft, elWidth }) {
  const elCentre = elLeft + elWidth / 2;
  const boxCentre = boxLeft + boxWidth / 2;
  // scrolling right (increasing scrollLeft) moves content left, so add the gap
  // between the element centre and the box centre.
  return scrollLeft + (elCentre - boxCentre);
}
