/* Stale application modules: detection and SAFE recovery.

   The app is split into hashed lazy chunks (/assets/<name>-<hash>.js). A tab
   opened before a release keeps running the old entry; after the release its
   old lazy chunks are gone from Hosting, and (with the SPA rewrite) a request
   for one returned index.html — "Failed to fetch dynamically imported module",
   MIME type text/html. The same browser error also happens when the device is
   offline or a content blocker stops the request, so failures are CLASSIFIED:

     stale   — a newer release is live (the served index.html names a different
               entry than the one running), or the module URL itself answers
               with HTML / 404 while the network works;
     offline — the browser says it's offline;
     unreachable — the network request itself failed (blocked, dropped);
     other   — not a module-loading failure (passed through unchanged).

   Recovery never reloads by itself. A stale tab shows "A newer version…" and
   offers a reload that first SAVES every registered editor (and refuses while
   an image uploads, or when a save fails — the editor and its content stay).
   Reload loops are prevented: a reload that didn't reach a newer build is not
   repeated automatically, and the next attempt explains instead.

   User-facing text never contains module URLs or MIME errors; the original
   error is kept as `cause` for the issue log. */
import { useSyncExternalStore } from "react";
import { uploadsInFlight } from "./academyUploads.js";

export const STALE_MESSAGE = "A newer version of the app is available. Save your changes, then reload to continue.";
export const OFFLINE_MESSAGE = "You're offline, so this part of the app couldn't load. Reconnect, then try again.";
export const UNREACHABLE_MESSAGE = "This part of the app couldn't load. Check your connection (or any content blocker), then try again.";

const MODULE_FAIL = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk [\w-]+ failed|ChunkLoadError|Expected a JavaScript.*module script|MIME type/i;
export const isModuleLoadError = (e) => !!e && (e.name === "ChunkLoadError" || MODULE_FAIL.test(String(e.message || e)));
const moduleUrlOf = (e) => (String(e?.message || "").match(/https?:\/\/[^\s"')]+\.(?:m?js|css)/) || [])[0] || null;

/* ---------------- state (one per tab) ---------------- */
let state = { status: "current", latest: null };
const subs = new Set();
const emit = () => subs.forEach((f) => f());
export const isStale = () => state.status === "stale";
export function markStale(latest = null) {
  if (state.status === "stale") return;
  state = { status: "stale", latest };
  emit();
}
export const useAppUpdate = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state, () => state);
export function __resetAppUpdate() { state = { status: "current", latest: null }; guards.clear(); loaded.clear(); emit(); }   // tests

/* ---------------- build identity ---------------- */
export function runningEntry(doc = typeof document !== "undefined" ? document : null) {
  const s = doc?.querySelector?.('script[type="module"][src*="/assets/index-"]');
  const src = s?.getAttribute("src") || "";
  return (src.match(/\/assets\/index-[\w-]+\.js/) || [])[0] || null;
}
export async function latestEntry(fetchImpl = fetch) {
  const r = await fetchImpl(`/?appVersionCheck=${Date.now()}`, { cache: "no-store", credentials: "same-origin" });
  if (!r.ok) return null;
  return ((await r.text()).match(/\/assets\/index-[\w-]+\.js/) || [])[0] || null;
}

/* ---------------- classification ---------------- */
let inflight = null;
export async function classifyLoadFailure(e, deps = {}) {
  if (!isModuleLoadError(e)) return "other";
  const online = deps.online ?? (typeof navigator === "undefined" ? true : navigator.onLine !== false);
  if (!online) return "offline";
  if (isStale()) return "stale";
  const fetchImpl = deps.fetch || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) return "unreachable";
  if (!deps.fetch && inflight) return inflight;                  // one check at a time per tab
  const run = (async () => {
    let latest;
    try { latest = await latestEntry(fetchImpl); } catch { return "unreachable"; }   // can't even reach the app → network
    const running = deps.running !== undefined ? deps.running : runningEntry();
    if (latest && running && latest !== running) { markStale(latest); return "stale"; }
    const url = moduleUrlOf(e);
    if (url) {
      try {
        const r = await fetchImpl(url, { cache: "no-store", credentials: "same-origin" });
        const type = r.headers?.get?.("content-type") || "";
        if (!r.ok || /text\/html/i.test(type)) { markStale(latest); return "stale"; }
        return "unreachable";                                     // the module exists and is JS: the earlier request was cut off
      } catch { return "unreachable"; }
    }
    return "unreachable";
  })();
  if (!deps.fetch) { inflight = run; run.finally(() => { inflight = null; }); }
  return run;
}

const typed = (kind, cause) => Object.assign(new Error(kind === "stale" ? STALE_MESSAGE : kind === "offline" ? OFFLINE_MESSAGE : UNREACHABLE_MESSAGE),
  { code: `app/${kind}`, cause });
export const isAppUpdateError = (e) => /^app\/(stale|offline|unreachable)$/.test(String(e?.code || ""));

/* Load a lazy module through this guard: a module-loading failure becomes a
   typed error (code app/stale | app/offline | app/unreachable, friendly
   message, original as `cause`). Once the tab is known to be stale, modules it
   hasn't loaded yet fail fast without another request (they can't exist). */
const loaded = new Set();
export async function guardedImport(key, loader, deps) {
  if (isStale() && !loaded.has(key)) throw typed("stale", null);
  try { const m = await loader(); loaded.add(key); return m; }
  catch (e) {
    const kind = await classifyLoadFailure(e, deps);
    if (kind === "other") throw e;
    throw typed(kind, e);
  }
}

/* ---------------- unsaved work + safe reload ---------------- */
const guards = new Map();
/* An editor with unsaved work registers { label, isDirty(), save(), url() }.
   save() must resolve only once the work is stored, and throw otherwise. */
export function registerUnsaved(id, guard) { guards.set(id, guard); return () => { if (guards.get(id) === guard) guards.delete(id); }; }
/* An editor is open (its "Save and reload" will save it first). */
export const hasOpenEditors = () => guards.size > 0;
export const hasUnsavedWork = () => [...guards.values()].some((g) => { try { return !!g.isDirty(); } catch { return true; } });

const RELOAD_KEY = "ifc.appUpdateReload";
const store = () => { try { return window.sessionStorage; } catch { return null; } };
/* Called once at startup: forget a reload marker once a newer build is running. */
export function noteStartup(doc) {
  const s = store(); if (!s) return;
  try {
    const rec = JSON.parse(s.getItem(RELOAD_KEY) || "null");
    if (rec && rec.from !== runningEntry(doc)) s.removeItem(RELOAD_KEY);
  } catch { s.removeItem(RELOAD_KEY); }
}

/* Save everything, then reload (to the editor's own URL when it gives one).
   → { ok: true } (reloading) or { ok: false, message } with nothing lost. */
export async function saveAndReload({ reload = (url) => (url ? window.location.assign(url) : window.location.reload()), now = Date.now(), doc } = {}) {
  if (uploadsInFlight() > 0) return { ok: false, message: "An image is still uploading. Wait for it to finish, then reload." };
  const s = store();
  try {
    const rec = JSON.parse(s?.getItem(RELOAD_KEY) || "null");
    if (rec && rec.from && rec.from === runningEntry(doc) && now - rec.at < 120000) {   // only when the build is identifiable
      return { ok: false, message: "The page reloaded but the newer version didn't load yet. Wait a minute, then reload again. Your changes are saved." };
    }
  } catch { /* unreadable marker: ignore */ }
  let url = null;
  for (const [, g] of guards) {
    let dirty;
    try { dirty = !!g.isDirty(); } catch { dirty = true; }
    if (dirty) {
      try { await g.save(); }
      catch (e) { return { ok: false, message: `Couldn't save ${g.label || "your changes"}, so the page wasn't reloaded. Your changes are still here.${e?.message && !isModuleLoadError(e) ? ` (${e.message})` : ""}` }; }
      let still; try { still = !!g.isDirty(); } catch { still = true; }
      if (still) return { ok: false, message: `${g.label ? `${g.label[0].toUpperCase()}${g.label.slice(1)} isn't` : "Your changes aren't"} saved yet, so the page wasn't reloaded. Your changes are still here.` };
    }
    try { url = (g.url && g.url()) || url; } catch { /* keep the current URL */ }
  }
  await new Promise((r) => setTimeout(r, 60));                     // let "saved" states render (beforeunload guards read them)
  if (uploadsInFlight() > 0) return { ok: false, message: "An image is still uploading. Wait for it to finish, then reload." };
  try { s?.setItem(RELOAD_KEY, JSON.stringify({ from: runningEntry(doc), at: now })); } catch { /* private mode */ }
  reload(url && url.startsWith("/") ? url : null);
  return { ok: true };
}

/* Vite reports failed preloads of a dynamic import's dependencies here. */
export function installPreloadListener(win = typeof window !== "undefined" ? window : null) {
  if (!win || win.__ifcPreloadListener) return;
  win.__ifcPreloadListener = true;
  win.addEventListener("vite:preloadError", (ev) => { classifyLoadFailure(ev?.payload || new Error("Unable to preload CSS")).catch(() => {}); });
}
