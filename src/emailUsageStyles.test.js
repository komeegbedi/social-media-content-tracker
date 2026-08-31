/* Readability regression for the Email panel. Guards the minimum font-size (and, for the
   most actionable copy, line-height) of EVERY meaningful Email-panel text selector so a
   future edit can't silently shrink status/error/help/badge/control text below threshold.
   Run: node --test src/emailUsageStyles.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

// Declaration body for a selector (up to the first closing brace — none of these rules nest).
function ruleBody(selector) {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `selector ${selector} must exist`);
  return css.slice(i, css.indexOf("}", i));
}
const px = (body, prop = "font-size") => {
  const m = new RegExp(prop + "\\s*:\\s*([0-9.]+)px").exec(body);
  return m ? Number(m[1]) : null;
};
const lineHeight = (body) => {
  const m = /line-height\s*:\s*([0-9.]+)/.exec(body);
  return m ? Number(m[1]) : null;
};

// Actionable status/error/help copy: >= 13.5px with a comfortable line-height.
for (const sel of [".sb-usage-help{", ".sb-usage-note{", ".sb-usage-quiet{"]) {
  test(`${sel} actionable copy is >=13.5px with line-height 1.4–1.5`, () => {
    const b = ruleBody(sel);
    assert.ok(px(b) >= 13.5, `${sel} font-size >= 13.5px (got ${px(b)})`);
    const lh = lineHeight(b);
    assert.ok(lh >= 1.4 && lh <= 1.5, `${sel} line-height 1.4–1.5 (got ${lh})`);
  });
}

// Every other meaningful Email-panel text selector: >= 13px.
for (const sel of [".sb-usagerow-foot{", ".sb-usagerow-na{", ".sb-usage-badge{",
  ".sb-usage-refresh{", ".sb-usage-tech>summary{", ".sb-usage-extlink{"]) {
  test(`${sel} is >=13px`, () => {
    assert.ok(px(ruleBody(sel)) >= 13, `${sel} font-size >= 13px (got ${px(ruleBody(sel))})`);
  });
}

test(".sb-usage-help and .sb-usage-note use a themed AA-contrast token (not --text-muted)", () => {
  assert.match(ruleBody(".sb-usage-help{"), /color:\s*var\(--text-secondary\)/);
  assert.match(ruleBody(".sb-usage-note{"), /color:\s*var\(--text-secondary\)/);
});

test("reduced-motion is still honored for the live usage bars", () => {
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\s*\.sb-usage-live \.sb-usagebar>span\{transition:none\}/);
});
