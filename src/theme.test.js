/* Tests for appearance-preference resolution + live system-theme following.
   Run with: node --test src/theme.test.js */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getThemePref, resolvePref, setThemePref, subscribeTheme, teardownTheme,
} from "./theme.js";

// --- minimal DOM/env mocks (theme.js reads these only at call time) ---
let store, mediaListeners, systemDark;
function setupDom() {
  store = {}; mediaListeners = []; systemDark = false;
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
  global.document = { documentElement: {
    _a: {}, classList: { add() {}, remove() {} },
    setAttribute(k, v) { this._a[k] = v; }, getAttribute(k) { return this._a[k]; },
  } };
}
const applied = () => document.documentElement.getAttribute("data-theme");
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
