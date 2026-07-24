/* A form field must stay visible against EVERY surface it can sit on, in both
   themes. Dark mode once had --surface-muted (#1C1D20) for fields on a
   --surface-elevated (#1C1D1F) sheet: a contrast ratio of 1.00, i.e. invisible.
   Run with: node --test src/styles.contrast.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

// Pull a token's value out of a :root-style block.
function token(block, name) {
  const m = block.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}
const lightBlock = css.slice(css.indexOf(":root{"), css.indexOf('[data-theme="dark"]{'));
const darkBlock = css.slice(css.indexOf('[data-theme="dark"]{'));

const rgb = (hex) => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const relLum = (hex) => {
  const s = rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// Composite an rgba(255,255,255,a) hairline over its backdrop.
const overWhiteAlpha = (alpha, bg) =>
  "#" + rgb(bg).map((c) => Math.round(c + (255 - c) * alpha).toString(16).padStart(2, "0")).join("");

for (const [theme, block] of [["light", lightBlock], ["dark", darkBlock]]) {
  test(`${theme}: field tokens exist and differ from every surface`, () => {
    const field = token(block, "field");
    assert.ok(/^#[0-9a-f]{6}$/i.test(field || ""), `--field must be a hex colour, got ${field}`);
    for (const surface of ["surface", "surface-elevated", "surface-muted", "background"]) {
      const bg = token(block, surface);
      assert.notEqual(field.toLowerCase(), bg.toLowerCase(),
        `--field is identical to --${surface} in ${theme} — the field would be invisible`);
    }
  });

  test(`${theme}: a field's EDGE is discernible on every surface it sits on`, () => {
    const field = token(block, "field");
    const border = token(block, "field-border");
    for (const surface of ["surface", "surface-elevated", "surface-muted"]) {
      const bg = token(block, surface);
      // Either the fill or the border must carry the edge. Alpha borders are
      // composited over the surface behind them before measuring.
      const alpha = border.match(/rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/);
      const edge = alpha ? overWhiteAlpha(Number(alpha[1]), bg) : border;
      const best = Math.max(contrast(field, bg), contrast(edge, bg));
      assert.ok(best >= 1.18,
        `${theme}: field on --${surface} has only ${best.toFixed(2)}:1 of separation ` +
        `(fill ${field}, edge ${edge} on ${bg}) — needs >= 1.18`);
    }
  });
}

test("no input rule reintroduces --surface-muted as its own fill", () => {
  // The exact regression: fields painted with the well colour they sit inside.
  const offenders = css.split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /\.sb-field (input|select|textarea)/.test(l) && /background:\s*var\(--surface-muted\)/.test(l));
  assert.deepEqual(offenders, [], `field rules must use var(--field): ${JSON.stringify(offenders)}`);
});
