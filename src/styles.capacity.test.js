/* Regression guard: an expanded Team Capacity card must expand IN PLACE — it must
   never be pulled to the front (order) or made full-width (grid-column), which
   yanked it to the top of the desktop grid. Run: node --test src/styles.capacity.test.js */
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

test("an expanded capacity card never reorders or spans the grid", () => {
  const bodies = openRuleBodies();
  assert.ok(bodies.length > 0, "expected .sb-cap.open styling to exist");
  const joined = bodies.join(" ");
  assert.ok(!/order\s*:/.test(joined),
    "`.sb-cap.open` must not set `order` — that moves the card to the front of the list");
  assert.ok(!/grid-column\s*:/.test(joined),
    "`.sb-cap.open` must not set `grid-column` — that makes the card full-width and reflows the grid");
});

test("the capacity list still uses the stable two-column desktop grid", () => {
  // The layout itself is intact; only the reorder-on-open behaviour was removed.
  assert.ok(/\.sb-caplist\{[^}]*grid-template-columns:repeat\(2/.test(css),
    "the 2-column desktop grid should remain");
});
