/* Tests for appearance-preference resolution + live system-theme following.
   Run with: node --test src/theme.test.js */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getThemePref, resolvePref, setThemePref, subscribeTheme, teardownTheme, initTheme,
} from "./theme.js";

// --- minimal DOM/env mocks (theme.js reads these only at call time) ---
// A tiny fake <head> that supports the element-replacement path theme.js uses
// (createElement + appendChild + querySelectorAll + element.remove).
let store, mediaListeners, systemDark, head;
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(), _a: {},
    setAttribute(k, v) { this._a[k] = v; }, getAttribute(k) { return this._a[k]; },
    remove() { head.children = head.children.filter((x) => x !== this); },
  };
}
function setupDom() {
  store = {}; mediaListeners = []; systemDark = false;
  head = { children: [], appendChild(el) { head.children.push(el); return el; } };
  // Seed the single static theme-color meta that index.html ships.
  const seed = makeEl("meta");
  seed.setAttribute("name", "theme-color"); seed.setAttribute("id", "theme-color-meta"); seed.setAttribute("content", "#F7F7F8");
  head.children.push(seed);
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const mql = {
    get matches() { return systemDark; },
    addEventListener: (_e, cb) => mediaListeners.push(cb),
    removeEventListener: (_e, cb) => { mediaListeners = mediaListeners.filter((x) => x !== cb); },
  };
  global.window = { matchMedia: (q) => String(q).includes("prefers-color-scheme")
    ? mql : { matches: false, addEventListener() {}, removeEventListener() {} } };
  global.document = {
    documentElement: {
      _a: {}, style: {}, classList: { add() {}, remove() {} },
      setAttribute(k, v) { this._a[k] = v; }, getAttribute(k) { return this._a[k]; },
    },
    head,
    createElement: (tag) => makeEl(tag),
    querySelectorAll: (sel) => (/meta\[name=("|')theme-color\1\]/.test(sel) ? head.children.filter((el) => el._a.name === "theme-color") : []),
    getElementById: (id) => head.children.find((el) => el._a.id === id) || null,
  };
}
const applied = () => document.documentElement.getAttribute("data-theme");
const themeColor = () => { const m = document.getElementById("theme-color-meta"); return m && m.getAttribute("content"); };
const themeColorCount = () => document.querySelectorAll('meta[name="theme-color"]').length;
const colorScheme = () => document.documentElement.style.colorScheme;
const fireSystemChange = (dark) => { systemDark = dark; mediaListeners.slice().forEach((cb) => cb({ matches: dark })); };

beforeEach(() => { setupDom(); teardownTheme(); });
afterEach(() => { teardownTheme(); delete global.window; delete global.document; delete global.localStorage; });

test("default preference is system", () => {
  assert.equal(getThemePref(), "system");
});

test("resolvePref: light/dark are literal, system follows the OS", () => {
  assert.equal(resolvePref("light"), "light");
  assert.equal(resolvePref("dark"), "dark");
  systemDark = false; assert.equal(resolvePref("system"), "light");
  systemDark = true;  assert.equal(resolvePref("system"), "dark");
});

test("setThemePref persists the choice and applies the resolved theme", () => {
  setThemePref("dark");
  assert.equal(getThemePref(), "dark");     // saves "dark", not just the resolved theme
  assert.equal(applied(), "dark");
  setThemePref("light");
  assert.equal(getThemePref(), "light");
  assert.equal(applied(), "light");
  setThemePref("system");
  assert.equal(getThemePref(), "system");   // saves "system", never the resolved value
});

test("Match system updates immediately when the OS flips; fixed modes do not", () => {
  setThemePref("system");
  systemDark = false;
  const seen = [];
  const unsub = subscribeTheme((t) => seen.push(t));
  fireSystemChange(true);
  assert.equal(applied(), "dark");
  assert.ok(seen.includes("dark"), "subscribers notified on OS change");
  fireSystemChange(false);
  assert.equal(applied(), "light");
  // Switch to a fixed mode → OS changes must be ignored, listener removed.
  setThemePref("dark");
  assert.equal(mediaListeners.length, 0, "OS listener removed when leaving system mode");
  fireSystemChange(false);
  assert.equal(applied(), "dark", "fixed Dark stays dark even when device goes light");
  unsub();
});

test("legacy sb-theme value is honoured once", () => {
  store["sb-theme"] = "dark";
  assert.equal(getThemePref(), "dark");
});

// --- Safari browser-chrome color follows the RESOLVED theme, immediately ---

test("Light → Dark → Light updates theme-color meta + colorScheme immediately", () => {
  setThemePref("light");
  assert.equal(themeColor(), "#F7F7F8");
  assert.equal(colorScheme(), "light");
  setThemePref("dark");
  assert.equal(themeColor(), "#08090A");   // no reload needed
  assert.equal(colorScheme(), "dark");
  setThemePref("light");
  assert.equal(themeColor(), "#F7F7F8");
  assert.equal(colorScheme(), "light");
});

test("repeated switching leaves exactly ONE theme-color meta (element replaced, never accumulated)", () => {
  for (const p of ["dark", "light", "system", "dark", "light"]) setThemePref(p);
  assert.equal(themeColorCount(), 1, "no competing/duplicate theme-color tags");
  assert.equal(document.getElementById("theme-color-meta").getAttribute("content"), "#F7F7F8");
});

test("Match system re-colors the chrome when the OS flips", () => {
  setThemePref("system"); systemDark = false;
  assert.equal(themeColor(), "#F7F7F8");
  fireSystemChange(true);
  assert.equal(themeColor(), "#08090A");
  assert.equal(colorScheme(), "dark");
  fireSystemChange(false);
  assert.equal(themeColor(), "#F7F7F8");
  assert.equal(colorScheme(), "light");
});

test("initTheme applies the stored preference's chrome color before React renders", () => {
  store["sb-appearance"] = "dark";
  initTheme();
  assert.equal(applied(), "dark");
  assert.equal(themeColor(), "#08090A");
  assert.equal(colorScheme(), "dark");
});

test("index.html declares exactly one identified, non-media-gated theme-color meta", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const metas = html.match(/<meta[^>]*name=["']theme-color["'][^>]*>/gi) || [];
  assert.equal(metas.length, 1, "exactly one theme-color meta (no competing tags)");
  assert.match(metas[0], /id=["']theme-color-meta["']/, "identified by id for dynamic updates");
  assert.doesNotMatch(metas[0], /\bmedia=/, "must not be gated by a prefers-color-scheme media query");
  assert.match(html, /name=["']color-scheme["'][^>]*content=["']light dark["']/i, "color-scheme meta present");
});
