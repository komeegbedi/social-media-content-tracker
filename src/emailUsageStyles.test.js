/* Readability regression for the Email panel's meaningful secondary/help copy.
   Guards the minimum font-size + line-height requirements in the stylesheet so a future
   edit can't silently shrink status/help text back below the threshold.
   Run: node --test src/emailUsageStyles.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

// Pull the declaration body for a selector (first match).
function ruleBody(selector) {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `selector ${selector} must exist`);
  return css.slice(i, css.indexOf("}", i));
}
const px = (body, prop) => {
  const m = new RegExp(prop + "\\s*:\\s*([0-9.]+)px").exec(body);
  return m ? Number(m[1]) : null;
};
const lineHeight = (body) => {
  const m = /line-height\s*:\s*([0-9.]+)/.exec(body);
  return m ? Number(m[1]) : null;
};

test(".sb-usage-help is >=13.5px with a comfortable line-height and a themed color token", () => {
  const b = ruleBody(".sb-usage-help{");
  assert.ok(px(b, "font-size") >= 13.5, "help copy >= 13.5px");
  const lh = lineHeight(b);
  assert.ok(lh >= 1.4 && lh <= 1.5, "line-height 1.4–1.5");
  assert.match(b, /color:\s*var\(--text-secondary\)/, "AA-contrast secondary token, not muted");
});

test(".sb-usage-note (status/help block) is >=13px with readable line-height", () => {
  const b = ruleBody(".sb-usage-note{");
  assert.ok(px(b, "font-size") >= 13, "note copy >= 13px");
  assert.ok(lineHeight(b) >= 1.4, "line-height >= 1.4");
});

test(".sb-usagerow-foot (meaningful % + reason) is >=13px", () => {
  assert.ok(px(ruleBody(".sb-usagerow-foot{"), "font-size") >= 13, "row foot >= 13px");
});

test("reduced-motion is still honored for the live usage bars", () => {
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\s*\.sb-usage-live \.sb-usagebar>span\{transition:none\}/);
});
