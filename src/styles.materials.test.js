/* Material-grammar guards (FOURTH). The app uses four deliberate material levels:
   canvas (opaque), working surfaces (opaque), elevated surfaces (opaque), and
   navigation glass (translucent+blur, mobile chrome only, with a solid fallback).
   These source-level assertions lock in that grammar and its preference-mode
   behaviour so a future edit can't (a) put glass on a content/elevated surface,
   or (b) leave a translucent panel see-through under reduced transparency.
   Run: node --test src/styles.materials.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

// Pull the body of an @media block by its condition substring.
function mediaBlock(condition) {
  const i = css.indexOf("@media (" + condition);
  assert.ok(i >= 0, `expected an @media (${condition}) block`);
  // walk braces from the opening { of the media rule
  const open = css.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") { depth--; if (depth === 0) return css.slice(open + 1, j); }
  }
  throw new Error("unbalanced media block for " + condition);
}

test("only navigation chrome uses backdrop-filter; content/elevated surfaces never do", () => {
  // Every rule BLOCK that sets a real backdrop-filter (not `:none`) must belong to
  // nav chrome (.sb-top / .sb-nav) or the modal scrim (.sb-modal). No working
  // surface (.sb-task/.sb-cap/.sb-field) or elevated surface (.sb-sheet/.sb-drawer/
  // .sb-notifpanel) may blur its backdrop.
  const offenders = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const [, selector, body] = m;
    const bf = body.match(/backdrop-filter\s*:\s*([^;]+)/);
    if (!bf || /^\s*none/.test(bf[1])) continue;                // no blur, or a reset
    if (!/\.sb-top|\.sb-nav\b|\.sb-modal/.test(selector)) offenders.push(selector.trim().slice(0, 50));
  }
  assert.deepEqual(offenders, [], "backdrop-filter appeared on a non-nav/non-scrim surface");
});

test("nav glass declares a solid fallback where backdrop-filter is unsupported", () => {
  // Both glass surfaces declare a solid background line and an @supports-not
  // fallback, so they never render fully transparent on unsupported browsers.
  assert.ok(/@supports not \(\(backdrop-filter/.test(css), "expected an @supports-not fallback for glass");
  const flat = css.replace(/\s+/g, "");
  assert.ok(/@supportsnot\(\(backdrop-filter[^{]*\)\)\{[^}]*\.sb-top\{background:var\(--background\)\}/.test(flat),
    ".sb-top needs a solid @supports-not fallback");
  assert.ok(/\.sb-nav\{background:var\(--surface\)\}/.test(flat), ".sb-nav needs a solid @supports-not fallback");
});

test("reduced transparency turns nav glass + scrim into solid/none and strengthens the scrim", () => {
  const b = mediaBlock("prefers-reduced-transparency: reduce");
  assert.ok(/\.sb-top\{[^}]*backdrop-filter:none/.test(b), ".sb-top must drop its blur");
  assert.ok(/\.sb-nav\{[^}]*backdrop-filter:none/.test(b), ".sb-nav must drop its blur");
  assert.ok(/\.sb-top\{[^}]*background:var\(--background\)/.test(b), ".sb-top must become solid");
  assert.ok(/\.sb-nav\{[^}]*background:var\(--surface-elevated\)/.test(b), ".sb-nav must become solid");
  assert.ok(/\.sb-modal,\.sb-scrim\{[^}]*backdrop-filter:none/.test(b), "scrim/modal must drop blur");
  // scrim opacity raised above the default .40 so the foreground dominates
  assert.ok(/--overlay:rgba\(9,\s*9,\s*11,\s*\.62\)/.test(b), "reduced-transparency should raise the light scrim opacity");
  assert.ok(/\[data-theme="dark"\]\{--overlay:rgba\(0,\s*0,\s*0,\s*\.82\)/.test(b), "reduced-transparency should raise the dark scrim opacity");
});

test("increased contrast strengthens borders, muted text, focus, and selected states (not just borders)", () => {
  const b = mediaBlock("prefers-contrast: more");
  assert.ok(/--border:rgba\(0,0,0,\.42\)/.test(b), "stronger light border token");
  assert.ok(/--text-muted:#4B5460/.test(b), "muted text should be strengthened under increased contrast");
  assert.ok(/--focus-ring:#3D46B0/.test(b), "focus ring should be strengthened");
  assert.ok(/\.sb-navbtn\.on[^{]*\{[^}]*outline:2px solid var\(--accent-foreground\)/.test(b),
    "selected nav must gain a border so the state isn't colour-only");
  assert.ok(/text-decoration:underline/.test(b), "links should be underlined under increased contrast");
  assert.ok(/:focus-visible\{outline-width:3px\}/.test(b), "focus outline should widen");
});

test("the desktop sidebar is a stable OPAQUE navigation region (no glass)", () => {
  // .sb-side background is a solid token, never a translucent color-mix or blur.
  const m = css.match(/\.sb-side\{[^}]*\}/g) || [];
  const joined = m.join(" ");
  assert.ok(!/backdrop-filter/.test(joined), "the desktop sidebar must not use backdrop-filter");
});
