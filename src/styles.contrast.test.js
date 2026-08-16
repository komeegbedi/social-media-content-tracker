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

/* Dark-mode surface separation: cards must read as a distinct layer above the base,
   and their hairline border must be discernible ON the card — the fix for near-black
   cards on a near-black background with an invisible 7%-white hairline. */
test("dark: surfaces are a monotonic elevation ladder above the background", () => {
  const bg = token(darkBlock, "background");
  const surface = token(darkBlock, "surface");
  const elevated = token(darkBlock, "surface-elevated");
  assert.ok(relLum(surface) > relLum(bg), "card surface must sit above the app background");
  assert.ok(relLum(elevated) > relLum(surface), "elevated surface must sit above the card surface");
  assert.ok(contrast(surface, bg) >= 1.06,
    `card/background fill separation is only ${contrast(surface, bg).toFixed(2)}:1`);
});

test("dark: the card hairline border is discernible on the card surface", () => {
  const surface = token(darkBlock, "surface");
  const border = token(darkBlock, "border");
  const alpha = border.match(/rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/);
  assert.ok(alpha, `--border should be a white-alpha hairline, got ${border}`);
  const edge = overWhiteAlpha(Number(alpha[1]), surface);
  assert.ok(contrast(edge, surface) >= 1.12,
    `hairline on the card has only ${contrast(edge, surface).toFixed(2)}:1 of separation — too faint`);
});

/* Semantic + accent COLOUR contrast (P13). Foreground tokens are used as text /
   icons and must clear 4.5:1 on the surfaces they sit on; white on the accent /
   success fills must clear 4.5:1; the focus ring must clear 3:1. These lock the
   split-token architecture so a future tweak can't quietly reintroduce the
   low-contrast values (light warning text was 1.96:1, focus ring ~2.6:1). */
for (const [theme, block] of [["light", lightBlock], ["dark", darkBlock]]) {
  const T = (n) => token(block, n);
  const page = T("background"), surface = T("surface"), elevated = T("surface-elevated");

  test(`${theme}: muted text is readable on page and surface (>=4.5:1)`, () => {
    for (const bg of [page, surface]) {
      const r = contrast(T("text-muted"), bg);
      assert.ok(r >= 4.5, `muted ${T("text-muted")} on ${bg} = ${r.toFixed(2)}:1`);
    }
  });

  test(`${theme}: accent foreground is a legible link/icon colour (>=4.5:1)`, () => {
    for (const bg of [page, surface, elevated]) {
      const r = contrast(T("accent-foreground"), bg);
      assert.ok(r >= 4.5, `accent-foreground ${T("accent-foreground")} on ${bg} = ${r.toFixed(2)}:1`);
    }
  });

  test(`${theme}: white --on-accent clears 4.5:1 on the accent fill`, () => {
    const r = contrast(T("on-accent"), T("accent-fill"));
    assert.ok(r >= 4.5, `on-accent ${T("on-accent")} on accent-fill ${T("accent-fill")} = ${r.toFixed(2)}:1`);
  });

  test(`${theme}: --on-success clears 4.5:1 on the success fill`, () => {
    const r = contrast(T("on-success"), T("success-fill"));
    assert.ok(r >= 4.5, `on-success on success-fill ${T("success-fill")} = ${r.toFixed(2)}:1`);
  });

  test(`${theme}: focus ring clears 3:1 against page and surface`, () => {
    for (const bg of [page, surface]) {
      const r = contrast(T("focus-ring"), bg);
      assert.ok(r >= 3, `focus-ring ${T("focus-ring")} on ${bg} = ${r.toFixed(2)}:1`);
    }
  });

  test(`${theme}: each semantic foreground clears 4.5:1 on its tint background`, () => {
    for (const fam of ["success", "warning", "danger", "info"]) {
      const fg = T(`${fam}-foreground`), bg = T(`${fam}-muted`);
      const r = contrast(fg, bg);
      assert.ok(r >= 4.5, `${fam}-foreground ${fg} on ${fam}-muted ${bg} = ${r.toFixed(2)}:1`);
    }
    // gold chip text sits on the gold tint
    const gr = contrast(T("gold-foreground"), T("gold-soft"));
    assert.ok(gr >= 4.5, `gold-foreground ${T("gold-foreground")} on gold-soft ${T("gold-soft")} = ${gr.toFixed(2)}:1`);
  });
}

/* Migration guard: `color:` is always a text/icon FOREGROUND, so it must use a
   -foreground (or -fg alias) token, never the bright base fill token (which was
   the low-contrast regression, e.g. amber text at 1.96:1). Decorative dots are
   allowed to use the base token because adjacent text carries the meaning. */
test("no color: rule uses a bright BASE semantic/accent token (foreground only)", () => {
  const offenders = css.split("\n")
    .map((l, i) => [i + 1, l.trim()])
    .filter(([, l]) => /color:var\(--(primary|violet|success|green|warning|amber|danger|red|info|blue|gold)\)/.test(l))
    .filter(([, l]) => !/\.dot-/.test(l));   // decorative dots may keep base tokens
  assert.deepEqual(offenders, [],
    `these color: rules must use a -foreground/-fg token, not the base fill:\n${offenders.map(([n, l]) => `  ${n}: ${l}`).join("\n")}`);
});

/* Guard: a solid control that pairs a base semantic/accent fill with white text
   is the white-on-bright-fill regression (danger button was ~3.3:1). Solid white
   controls must use the -fill tokens (danger-fill / accent-fill / success-fill). */
test("no solid rule pairs a bright BASE fill with white text", () => {
  const offenders = css.split("\n")
    .map((l, i) => [i + 1, l.trim()])
    .filter(([, l]) => /background:var\(--(primary|violet|danger|red|green)\)/.test(l) && /color:#fff/i.test(l));
  assert.deepEqual(offenders, [],
    `these solid controls must use a -fill token with white:\n${offenders.map(([n, l]) => `  ${n}: ${l}`).join("\n")}`);
});

test("no input rule reintroduces --surface-muted as its own fill", () => {
  // The exact regression: fields painted with the well colour they sit inside.
  const offenders = css.split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /\.sb-field (input|select|textarea)/.test(l) && /background:\s*var\(--surface-muted\)/.test(l));
  assert.deepEqual(offenders, [], `field rules must use var(--field): ${JSON.stringify(offenders)}`);
});
