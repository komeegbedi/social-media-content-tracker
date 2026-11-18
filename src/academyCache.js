/* Academy session caches (rounds 7–8). Dependency-free so the app shell can
   clear them on sign-out / account or role change without loading the Academy
   chunk.

   1. Shared live subscriptions. One Firestore listener per key, shared by every
      component that reads it. When the last reader unmounts the listener
      LINGERS for LINGER_MS (Back / revisit renders at once from the last data
      while the listener keeps it current), then closes. At most MAX_LINGERING
      idle listeners are kept; beyond that the oldest idle one closes at once.
      Listeners in use are never closed by these limits.
      Access is unchanged: every listener runs as the signed-in user under
      firestore.rules, so a permission change reaches the UI as an update or a
      permission error exactly as before. An entry that ENDED (Firestore stops a
      listener after a permission error) is restarted the next time something
      reads it, instead of serving the old error or data.

   2. Image object URLs (auth-checked Storage reads → blob: URLs), LRU of
      IMAGE_CACHE_MAX entries. Entries in use are never evicted; evicted URLs
      are revoked. A replaced cover has a new storage path, so it is a new
      entry (the old one ages out).

   Sessions: clearAcademySession() closes every listener, revokes every object
   URL and starts a new session GENERATION. Anything still in flight from the
   previous session (a late snapshot, a late image download) carries the old
   generation and is discarded, so it can never repopulate the new session's
   cache. Readers still mounted are notified so they re-subscribe under the new
   session. */

export const LINGER_MS = 60000;
export const MAX_LINGERING = 40;
let gen = 0;
export const sessionGen = () => gen;
const subs = new Map(); // `${gen}|${key}` → entry
const lingering = new Set(); // entries with no readers, oldest first (insertion order)

function close(full, s) {
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  lingering.delete(s);
  if (subs.get(full) === s) subs.delete(full);
  try { s.unsub && s.unsub(); } catch { /* already closed */ }
  s.unsub = null;
}
/* Opt-in timing trace for performance measurements: a measurement script sets
   `window.__academyPerf = []` before the app loads; otherwise this does nothing.
   Records when each shared subscription starts and when its first result
   (data or error) arrives. No data content is recorded. */
function trace(ev, key, extra) {
  try {
    const t = typeof window !== "undefined" && window.__academyPerf;
    if (t && typeof t.push === "function") t.push({ ev, key, t: performance.now(), ...extra });
  } catch { /* never affects the app */ }
}
function start(full, s, startFn, initial) {
  const g = gen;
  s.ended = false;
  const key = full.slice(full.indexOf("|") + 1);
  let first = true;
  trace("start", key);
  const set = (next, opts) => {
    if (g !== gen || subs.get(full) !== s) return; // a previous session or a closed entry: ignore
    s.state = typeof next === "function" ? next(s.state) : next;
    if (opts && opts.ended) s.ended = true;          // the listener stopped (e.g. permission error)
    if (first && s.state && s.state.loaded) { first = false; trace("ready", key, { error: !!s.state.error, n: Array.isArray(s.state.docs) ? s.state.docs.length : undefined }); }
    s.listeners.forEach((l) => l());
  };
  try { s.unsub = startFn(set); } catch (e) { s.state = { ...initial, loaded: true, error: e }; s.ended = true; }
}
export function acquireShared(key, startFn, initial) {
  const full = `${gen}|${key}`;
  let s = subs.get(full);
  if (s && s.ended && s.listeners.size === 0) { close(full, s); s = null; } // retry an ended listener
  if (!s) {
    s = { full, state: initial, listeners: new Set(), unsub: null, timer: null, ended: false };
    subs.set(full, s);
    start(full, s, startFn, initial);
  }
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  lingering.delete(s);
  return s;
}
export function releaseShared(key, s, listener) {
  s.listeners.delete(listener);
  if (s.listeners.size || s.timer) return;
  if (subs.get(s.full) !== s) return; // already closed (cleared session)
  lingering.add(s);
  s.timer = setTimeout(() => { s.timer = null; if (!s.listeners.size) close(s.full, s); }, LINGER_MS);
  while (lingering.size > MAX_LINGERING) { const oldest = lingering.values().next().value; close(oldest.full, oldest); }
}
/* "Try again" for a listener that ENDED (Firestore stops a listener after an
   error) while readers are still mounted: restart it in place for them. Their
   view returns to loading (never the failed or older data) until the new
   listener answers. No-op for a live or unknown entry. */
export function restartShared(key, startFn, initial) {
  const full = `${gen}|${key}`;
  const s = subs.get(full);
  if (!s || !s.ended) return false;
  try { s.unsub && s.unsub(); } catch { /* already closed */ }
  s.unsub = null;
  s.state = initial;
  start(full, s, startFn, initial);
  s.listeners.forEach((l) => l());
  return true;
}
export const sharedState = (key) => subs.get(`${gen}|${key}`)?.state;
export const sharedStats = () => ({ open: subs.size, lingering: lingering.size, generation: gen });

/* ---- images ---------------------------------------------------------------- */
export const IMAGE_CACHE_MAX = 120;
const urls = new Map(); // path → { url, refs } (insertion order = LRU order)
export function cachedImageUrl(path) {
  const e = urls.get(path);
  if (!e) return null;
  urls.delete(path); urls.set(path, e); // touch
  return e.url;
}
/* `g`: the session generation the download started in; a late result from a
   previous session is revoked instead of cached. Returns whether it was kept. */
export function storeImageUrl(path, url, g = gen) {
  if (g !== gen) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } return false; }
  const old = urls.get(path);
  if (old && old.url !== url) { try { URL.revokeObjectURL(old.url); } catch { /* ignore */ } }
  urls.set(path, { url, refs: old?.refs || 0 });
  evictImages();
  return true;
}
export function retainImage(path) { const e = urls.get(path); if (e) e.refs += 1; }
export function releaseImage(path) { const e = urls.get(path); if (e && e.refs > 0) e.refs -= 1; evictImages(); }
function evictImages() {
  if (urls.size <= IMAGE_CACHE_MAX) return;
  for (const [p, e] of urls) {
    if (urls.size <= IMAGE_CACHE_MAX) break;
    if (e.refs > 0) continue;
    urls.delete(p);
    try { URL.revokeObjectURL(e.url); } catch { /* ignore */ }
  }
}
export const imageCacheSize = () => urls.size;

const clearHooks = new Set();
export const onAcademyClear = (fn) => { clearHooks.add(fn); return () => clearHooks.delete(fn); };

export function clearAcademySession() {
  const readers = [];
  for (const [full, s] of [...subs]) { s.listeners.forEach((l) => readers.push(l)); close(full, s); }
  subs.clear(); lingering.clear();
  for (const [, e] of urls) { try { URL.revokeObjectURL(e.url); } catch { /* ignore */ } }
  urls.clear();
  gen += 1;
  clearHooks.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  // readers still mounted re-read (now empty) and re-subscribe under the new session
  readers.forEach((l) => { try { l(); } catch { /* ignore */ } });
}
