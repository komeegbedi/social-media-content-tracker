/* Stale application modules: classification, fail-fast, safe reload. Run: npm test */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// a minimal browser surface for sessionStorage (the reload-loop marker)
const mem = new Map();
globalThis.window = { sessionStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) } };

const { isModuleLoadError, classifyLoadFailure, guardedImport, isStale, markStale, saveAndReload, registerUnsaved, hasUnsavedWork, noteStartup, runningEntry,
  __resetAppUpdate, STALE_MESSAGE } = await import("./appUpdate.js");
const { trackUpload } = await import("./academyUploads.js");

const docWith = (entry) => ({ querySelector: () => ({ getAttribute: () => entry }) });
const OLD = "/assets/index-JLXwCp0n.js", NEW = "/assets/index-hglzyQex.js";
const html = (entry) => `<!doctype html><script type="module" crossorigin src="${entry}"></script>`;
const res = (body, type = "text/html; charset=utf-8", ok = true) => ({ ok, status: ok ? 200 : 404, text: async () => body, headers: { get: (h) => (h.toLowerCase() === "content-type" ? type : null) } });
const chromeErr = (url = "https://ifc-social-media-tracker.web.app/assets/index.esm-Di5kQlnq.js") => new TypeError(`Failed to fetch dynamically imported module: ${url}`);
beforeEach(() => { __resetAppUpdate(); mem.clear(); });

test("recognises module-loading failures from Chrome, Firefox, Safari and Vite — and nothing else", () => {
  assert.equal(isModuleLoadError(chromeErr()), true);
  assert.equal(isModuleLoadError(new TypeError("error loading dynamically imported module: https://x/assets/a.js")), true);
  assert.equal(isModuleLoadError(new TypeError("Importing a module script failed.")), true);
  assert.equal(isModuleLoadError(new Error("Unable to preload CSS for /assets/a.css")), true);
  assert.equal(isModuleLoadError(Object.assign(new Error("x"), { code: "functions/internal" })), false);
  assert.equal(isModuleLoadError(new Error("Missing or insufficient permissions.")), false);
});

test("the running build's entry is read from the page", () => {
  assert.equal(runningEntry(docWith(`${OLD}`)), OLD);
  assert.equal(runningEntry(docWith("https://ifc.example/assets/index-hglzyQex.js")), NEW);
  assert.equal(runningEntry({ querySelector: () => null }), null);
});

test("an OLD tab after a release (the reported case): the served page names another entry → stale", async () => {
  const calls = [];
  const fetch = async (url) => { calls.push(url); return res(html(NEW)); };
  assert.equal(await classifyLoadFailure(chromeErr(), { online: true, fetch, running: OLD }), "stale");
  assert.equal(isStale(), true);
  assert.match(calls[0], /^\/\?appVersionCheck=/, "checked the current index.html, uncached");
});

test("same build, but the module URL answers with HTML (rewrite) or 404 → stale; with JavaScript → it was the network", async () => {
  const fetchHtml = async (url) => (url.startsWith("/?") ? res(html(OLD)) : res("<!doctype html>"));
  assert.equal(await classifyLoadFailure(chromeErr(), { online: true, fetch: fetchHtml, running: OLD }), "stale");
  __resetAppUpdate();
  const fetch404 = async (url) => (url.startsWith("/?") ? res(html(OLD)) : res("not found", "text/html", false));
  assert.equal(await classifyLoadFailure(chromeErr(), { online: true, fetch: fetch404, running: OLD }), "stale");
  __resetAppUpdate();
  const fetchJs = async (url) => (url.startsWith("/?") ? res(html(OLD)) : res("export{}", "text/javascript"));
  assert.equal(await classifyLoadFailure(chromeErr(), { online: true, fetch: fetchJs, running: OLD }), "unreachable");
  assert.equal(isStale(), false);
});

test("a genuinely OFFLINE device or a blocked request is not mistaken for a new release", async () => {
  let fetched = 0;
  assert.equal(await classifyLoadFailure(chromeErr(), { online: false, fetch: async () => { fetched++; return res(html(NEW)); }, running: OLD }), "offline");
  assert.equal(fetched, 0, "offline: no probing");
  const blocked = async () => { throw new TypeError("Failed to fetch"); };
  assert.equal(await classifyLoadFailure(chromeErr(), { online: true, fetch: blocked, running: OLD }), "unreachable");
  assert.equal(isStale(), false);
  assert.equal(await classifyLoadFailure(new Error("permission-denied"), { online: true, fetch: blocked }), "other");
});

test("guardedImport: a typed, friendly error (original kept as cause); once stale, unloaded modules fail fast without a request", async () => {
  const fetch = async () => res(html(NEW));
  const e = await guardedImport("firebase/functions", () => Promise.reject(chromeErr()), { online: true, fetch, running: OLD }).catch((x) => x);
  assert.equal(e.code, "app/stale");
  assert.equal(e.message, STALE_MESSAGE);
  assert.doesNotMatch(e.message, /https?:|MIME|dynamically/);
  assert.match(String(e.cause?.message), /index\.esm-Di5kQlnq/, "the technical detail stays available for the log");
  let calls = 0;
  const again = await guardedImport("firebase/functions", () => { calls++; return Promise.resolve({}); }).catch((x) => x);
  assert.equal(again.code, "app/stale"); assert.equal(calls, 0, "no repeated failing request");
});

test("guardedImport: modules already loaded keep working in a stale tab; non-module errors pass through unchanged", async () => {
  const m = { ok: 1 };
  assert.equal(await guardedImport("firebase/storage", async () => m), m);
  markStale(NEW);
  assert.equal(await guardedImport("firebase/storage", async () => m), m);
  const other = new Error("boom");
  __resetAppUpdate();
  assert.equal(await guardedImport("x", () => Promise.reject(other)).catch((x) => x), other);
});

test("safe reload: saves every dirty editor first, then reloads ONCE to the editor's own URL", async () => {
  let saved = 0, reloads = [];
  let dirty = true;
  registerUnsaved("course:c1", { label: "the course", isDirty: () => dirty, save: async () => { saved++; dirty = false; }, url: () => "/learn/manage/course/c1?item=l2&path=p1" });
  assert.equal(hasUnsavedWork(), true);
  const r = await saveAndReload({ reload: (u) => reloads.push(u), doc: docWith(OLD) });
  assert.deepEqual(r, { ok: true });
  assert.equal(saved, 1);
  assert.deepEqual(reloads, ["/learn/manage/course/c1?item=l2&path=p1"], "route, selected lesson and path context kept");
});

test("safe reload refuses — and changes nothing — while saving fails, an edit is still unsaved, or an image uploads", async () => {
  let reloads = 0;
  const reload = () => { reloads++; };
  const off = registerUnsaved("purpose-video", { label: "the introduction", isDirty: () => true, save: async () => { throw new Error("That link isn't a valid video."); } });
  let r = await saveAndReload({ reload, doc: docWith(OLD) });
  assert.equal(r.ok, false);
  assert.match(r.message, /Couldn't save the introduction, so the page wasn't reloaded\. Your changes are still here\./);
  assert.equal(hasUnsavedWork(), true, "the editor is still registered (nothing discarded)");
  off();
  registerUnsaved("course:c2", { label: "the course", isDirty: () => true, save: async () => {} });   // "saved" but still dirty
  r = await saveAndReload({ reload, doc: docWith(OLD) });
  assert.match(r.message, /The course isn't saved yet, so the page wasn't reloaded\. Your changes are still here\./);
  __resetAppUpdate();
  let finish; trackUpload(new Promise((res2) => { finish = res2; }));
  r = await saveAndReload({ reload, doc: docWith(OLD) });
  assert.match(r.message, /An image is still uploading/);
  finish(); await new Promise((res2) => setTimeout(res2, 0));
  assert.equal(reloads, 0, "never reloaded");
});

test("no reload loop: a reload that didn't reach a newer build isn't repeated; reaching it clears the marker", async () => {
  let reloads = 0;
  const reload = () => { reloads++; };
  assert.equal((await saveAndReload({ reload, doc: docWith(OLD), now: 1000 })).ok, true);
  const again = await saveAndReload({ reload, doc: docWith(OLD), now: 5000 });
  assert.equal(again.ok, false);
  assert.match(again.message, /didn't load yet/);
  assert.equal(reloads, 1);
  noteStartup(docWith(NEW));                                    // the newer build is running now
  assert.equal(mem.size, 0, "marker cleared");
  assert.equal((await saveAndReload({ reload, doc: docWith(NEW), now: 6000 })).ok, true);
  assert.equal(reloads, 2);
});
