/* Visual-polish guards: the lesson pre-play poster fills its 16:9 frame (only the
   poster — cards, editor previews and the player keep their sizing), and the
   workspace notes keep ONE layout whose action group is never stretched across the
   banner (the bug: a variant rule gave every span — the actions too — flex:1).
   Run: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/* every [selector, declarations] pair, media queries included (flat scan) */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2].replace(/\s+/g, "")]);
const declsFor = (pred) => rules.filter(([sel]) => sel.split(",").some((s) => pred(s.trim()))).map(([, d]) => d);

test("pre-play poster: provider artwork covers the 16:9 frame, centred; the shared thumbnail default is unchanged", () => {
  const poster = declsFor((s) => s === ".ac-poster .ac-srcthumb img").join(";");
  assert.match(poster, /object-fit:cover/);
  assert.match(poster, /object-position:50%50%|object-position:center/);
  const base = declsFor((s) => s === ".ac-srcthumb img").join(";");
  assert.match(base, /object-fit:contain/, "cards / editor previews keep the letterboxed default");
  // the player (iframe) is never cropped or scaled by these rules
  assert.equal(declsFor((s) => /\.ac-frame/.test(s)).some((d) => /object-fit:cover|transform:scale/.test(d)), false);
});

test("workspace notes: no rule stretches the action group; actions are a compact group", () => {
  const stretchers = rules.filter(([sel, d]) => /\.ac-wsnote\s*>\s*span(?![^,]*:not\(\.ac-wsnoteacts\))/.test(sel) && /flex:1(;|$)/.test(d));
  assert.deepEqual(stretchers.map(([s]) => s), [], "a `.ac-wsnote > span { flex: 1 }` rule would also stretch .ac-wsnoteacts");
  const acts = declsFor((s) => s === ".ac-wsnoteacts").join(";");
  assert.match(acts, /margin-inline-start:auto/, "actions sit on the right on wide screens");
  assert.match(acts, /gap:8px/);
  assert.doesNotMatch(acts, /flex:1(;|$)|flex-grow:1/);
  assert.equal(declsFor((s) => s === ".ac-wsnote .ac-link").length, 0, "no loose link pushed across the banner");
});
