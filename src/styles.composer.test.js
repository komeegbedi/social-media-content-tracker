/* CSS cascade regression for the inline-highlight comment composer.
   The composer paints a transparent <textarea> over a visible overlay, so the
   textarea MUST resolve to a transparent background in every theme. A generic
   `[data-theme="dark"] textarea{background:var(--field)}` rule (specificity 0,1,1)
   was repainting it opaque and hiding the text on iPhone dark mode. This locks in
   that a composer-scoped rule beats that generic rule.
   Run: node --test src/styles.composer.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// [a, b, c] = [#id, .class/[attr]/:pseudo-class, element/::pseudo-element] for ONE selector.
function specificity(sel) {
  const s = sel.trim();
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const attrs = (s.match(/\[[^\]]+\]/g) || []).length;
  const classes = (s.match(/\.[\w-]+/g) || []).length;
  const pseudoClasses = (s.match(/(^|[^:]):(?!:)[\w-]+/g) || []).length;
  const pseudoEls = (s.match(/::[\w-]+/g) || []).length;
  const cleaned = s
    .replace(/::[\w-]+/g, " ").replace(/:(?!:)[\w-]+/g, " ")
    .replace(/\.[\w-]+/g, " ").replace(/#[\w-]+/g, " ")
    .replace(/\[[^\]]+\]/g, " ").replace(/[>+~]/g, " ");
  const elements = (cleaned.match(/[a-zA-Z][\w-]*/g) || []).length;
  return [ids, attrs + classes + pseudoClasses, elements + pseudoEls];
}
const cmp = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);

// Every `selector { ...decls }` block (selectors may be comma lists).
function rules(text) {
  const out = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    out.push({ sels, body: m[2] });
  }
  return out;
}
const all = rules(css);
const declOf = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i"));
  return m ? m[1].trim() : null;
};

test("a generic [data-theme=\"dark\"] textarea rule DOES set an opaque background (the hazard exists)", () => {
  const hit = all.find((r) => r.sels.some((s) => /\[data-theme="dark"\]\s+textarea/.test(s)) && declOf(r.body, "background"));
  assert.ok(hit, "expected the generic dark textarea rule to exist");
  assert.match(declOf(hit.body, "background"), /var\(--field\)/, "…and to paint an opaque field background");
});

test("a composer-scoped rule makes the textarea background transparent and BEATS the dark generic rule", () => {
  const darkTextareaSpec = specificity('[data-theme="dark"] textarea');   // (0,1,1)

  // The strongest rule that (a) targets the composer textarea and (b) sets background:transparent.
  let best = null;
  for (const r of all) {
    if (declOf(r.body, "background") !== "transparent") continue;
    for (const s of r.sels) {
      if (!/\.sb-mc-input/.test(s)) continue;             // composer input layer
      if (/::/.test(s)) continue;                          // ignore ::placeholder etc.
      const sp = specificity(s);
      if (!best || cmp(sp, best) > 0) best = sp;
    }
  }
  assert.ok(best, "expected a composer rule setting the textarea background: transparent");
  assert.ok(cmp(best, darkTextareaSpec) > 0,
    `composer transparent-bg specificity ${JSON.stringify(best)} must exceed dark textarea ${JSON.stringify(darkTextareaSpec)}`);
});

test("the WRAPPER owns the visible field background; the input keeps transparent text + visible caret", () => {
  const wrap = all.find((r) => r.sels.includes(".sb-mc-wrap"));
  assert.ok(wrap && /var\(--field\)/.test(declOf(wrap.body, "background") || ""), ".sb-mc-wrap must own the field background");

  const winner = all.filter((r) => r.sels.some((s) => /\.sb-mc-input/.test(s) && !/::/.test(s)))
    .filter((r) => declOf(r.body, "-webkit-text-fill-color") || declOf(r.body, "caret-color"))
    .pop();
  assert.ok(winner, "expected a composer input rule");
  // The composer-scoped override preserves the WebKit-invisible-glyph + visible-caret contract.
  const scoped = all.find((r) => r.sels.includes(".sb-mc-wrap > textarea.sb-mc-input"));
  assert.ok(scoped, "expected the higher-specificity .sb-mc-wrap > textarea.sb-mc-input override");
  assert.equal(declOf(scoped.body, "color"), "transparent");
  assert.equal(declOf(scoped.body, "-webkit-text-fill-color"), "transparent");
  assert.match(declOf(scoped.body, "caret-color"), /var\(--text-primary\)/);
});

/* ---- caret alignment: composer overlay mention must not change glyph width ---- */

test("composer overlay mention overrides the semibold weight to a metric-neutral value", () => {
  const base = all.find((r) => r.sels.includes(".sb-mention-tag"));
  assert.ok(base, "expected the base .sb-mention-tag rule");
  assert.equal(declOf(base.body, "font-weight"), "600", "posted-comment mentions stay semibold");

  const override = all.find((r) => r.sels.includes(".sb-mc-overlay .sb-mention-tag"));
  assert.ok(override, "expected a composer-scoped .sb-mc-overlay .sb-mention-tag rule");
  assert.match(declOf(override.body, "font-weight") || "", /^(inherit|normal|400)$/,
    "composer mention weight must match the textarea (no wider bold glyphs)");
  // …and it must WIN over the base 600.
  assert.ok(cmp(specificity(".sb-mc-overlay .sb-mention-tag"), specificity(".sb-mention-tag")) > 0,
    "the composer override must be more specific than the base rule");
});

test("no composer mention rule applies METRIC-changing typography (width/geometry must be identical to the textarea)", () => {
  const METRIC = ["letter-spacing", "word-spacing", "font-size", "font-family", "font-stretch",
    "padding", "padding-left", "padding-right", "padding-inline", "padding-inline-start", "padding-inline-end",
    "border", "border-width", "border-inline", "transform", "tab-size", "text-transform"];
  for (const r of all) {
    for (const s of r.sels) {
      const sel = s.trim();
      if (!/\.sb-mention-tag/.test(sel)) continue;
      // Only rules that reach the COMPOSER mention (the base bare rule, or .sb-mc-* scoped).
      const bare = /^\.sb-mention-tag(\.[\w-]+)?$/.test(sel);
      const composerScoped = /\.sb-mc(-overlay|-wrap|-input|)\b/.test(sel);
      if (!bare && !composerScoped) continue;                 // e.g. a posted-comment-only rule → skip
      for (const p of METRIC) assert.equal(declOf(r.body, p), null, `${sel} must not set metric prop "${p}"`);
      const fs = declOf(r.body, "font-style"); if (fs) assert.match(fs, /^(normal|inherit)$/);
      // font-weight: allowed to be 600 ONLY on the bare rule (posted comments); any COMPOSER-scoped
      // rule must be metric-neutral so the overlay matches the textarea.
      if (composerScoped) { const fw = declOf(r.body, "font-weight"); if (fw) assert.match(fw, /^(inherit|normal|400)$/); }
    }
  }
});

test("posted-comment mentions keep their own semibold styling (only the composer is neutralized)", () => {
  // The only unscoped weight on .sb-mention-tag is 600, and the sole override is composer-scoped —
  // so a mention rendered outside .sb-mc-overlay (a posted comment) still resolves to 600.
  const weightRules = all.filter((r) => r.sels.some((s) => /\.sb-mention-tag/.test(s)) && declOf(r.body, "font-weight"));
  const unscoped = weightRules.filter((r) => r.sels.some((s) => /^\.sb-mention-tag(\.[\w-]+)?$/.test(s.trim())));
  assert.ok(unscoped.every((r) => declOf(r.body, "font-weight") === "600"), "the base mention weight is semibold");
  const overrides = weightRules.filter((r) => r.sels.every((s) => /\.sb-mc-overlay/.test(s)));
  assert.ok(overrides.length >= 1 && overrides.every((r) => /^(inherit|normal|400)$/.test(declOf(r.body, "font-weight"))),
    "every weight override is composer-scoped and metric-neutral");
});
