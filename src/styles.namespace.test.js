/* Regression guard: the determinate loading progress bar (src/loading.jsx,
   `.sb-loadprogress*`) and the Home dashboard's Team-Progress card
   (`.sb-progress*`, styled in styles.css / rendered in App.jsx) must stay in
   SEPARATE CSS namespaces. They previously shared `.sb-progress`, so each one's
   base rule (Home's card background/border/padding vs the bar's margin) cascaded
   into the other. Run: node --test src/styles.namespace.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const loading = readFileSync(new URL("./loading.jsx", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");

test("the loading primitive uses .sb-loadprogress and never the Home .sb-progress name", () => {
  // Note: "sb-loadprogress" does NOT contain the substring "sb-progress".
  assert.ok(loading.includes("sb-loadprogress"),
    "loading.jsx should emit the isolated .sb-loadprogress namespace");
  assert.ok(!loading.includes("sb-progress"),
    "loading.jsx must NOT reference .sb-progress — that is the Home Team-Progress card");
});

test("styles.css defines both namespaces, as distinct selector families", () => {
  assert.ok(/\.sb-loadprogress-fill\b/.test(css), "expected the loading bar's .sb-loadprogress-fill rule");
  assert.ok(/\.sb-loadprogress-track\b/.test(css), "expected the loading bar's .sb-loadprogress-track rule");
  // Home's card is still there and untouched (its distinctive child selectors).
  assert.ok(/\.sb-progress\s*\{/.test(css), "the Home .sb-progress card base rule should remain");
  assert.ok(/\.sb-progress\s+\.bar\b/.test(css), "the Home .sb-progress .bar rule should remain");
  // No selector should ever bind the two names together.
  assert.ok(!/\.sb-progress[\w-]*\.sb-loadprogress|\.sb-loadprogress[\w-]*\.sb-progress\b/.test(css),
    "the two progress namespaces must not be combined in a single selector");
});

test("Home still renders the .sb-progress card (not accidentally renamed)", () => {
  assert.ok(/className="sb-progress"/.test(app),
    "the Home dashboard should still use className=\"sb-progress\" for its Team-Progress card");
});
