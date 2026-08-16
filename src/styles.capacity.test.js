/* Regression guard for the Team Capacity grid (P0-B). An expanded card must
   expand IN PLACE — vertically, within its own column. It must NOT span both
   columns (`grid-column:1/-1`), must NOT reorder via `order`, and the grid must
   NOT use `grid-auto-flow:dense` (which reflows collapsed cards into other
   columns when one opens). The user explicitly rejected the full-width version.
   Run: node --test src/styles.capacity.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

// Pull every `.sb-cap.open { … }` rule body out of the stylesheet.
function openRuleBodies() {
  const bodies = [];
  const re = /\.sb-cap\.open\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) bodies.push(m[1]);
  return bodies;
}

test("an expanded capacity card never spans the grid or reorders", () => {
  const bodies = openRuleBodies();
  assert.ok(bodies.length > 0, "expected .sb-cap.open styling to exist");
  const joined = bodies.join(" ");
  assert.ok(!/grid-column\s*:/.test(joined),
    "`.sb-cap.open` must NOT set `grid-column` — it must stay in its own column and expand vertically in place");
  assert.ok(!/order\s*:/.test(joined),
    "`.sb-cap.open` must NOT set `order` — it must not jump position when opened");
});

test("the capacity grid is a stable two-column layout without dense reflow", () => {
  const grid = css.match(/\.sb-caplist\{[^}]*grid-template-columns:repeat\(2[^}]*\}/);
  // the 2-up desktop grid still exists (inside the >=900 media query)
  assert.ok(/\.sb-caplist\{[^}]*grid-template-columns:repeat\(2/.test(css),
    "the 2-column desktop grid should remain");
  // and it must NOT use dense auto-flow (which reflows/reorders sibling cards)
  assert.ok(!/\.sb-caplist\{[^}]*grid-auto-flow:\s*row\s+dense/.test(css),
    "the grid must NOT use `grid-auto-flow:row dense` — dense reflow reorders collapsed cards across columns when one opens");
  // align-items:start keeps a taller (open) card from stretching its row-mate
  assert.ok(/\.sb-caplist\{[^}]*align-items:start/.test(css),
    "`align-items:start` should keep the row-mate top-anchored while a card grows");
});
