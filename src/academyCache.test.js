/* Academy session caches (academyCache.js). Run: node --test src/academyCache.test.js */
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  acquireShared, releaseShared, sharedState, sharedStats, sessionGen, clearAcademySession,
  cachedImageUrl, storeImageUrl, retainImage, releaseImage, imageCacheSize, IMAGE_CACHE_MAX, LINGER_MS, MAX_LINGERING,
} from "./academyCache.js";

const revoked = [];
globalThis.URL.revokeObjectURL = (u) => revoked.push(u);
const INIT = { docs: [], loaded: false, error: null };
// a fake listener: records unsubscribes, exposes its `set`
function fake() {
  const f = { set: null, starts: 0, unsubs: 0 };
  f.start = (set) => { f.set = set; f.starts += 1; return () => { f.unsubs += 1; }; };
  return f;
}
beforeEach(() => { mock.timers.reset(); clearAcademySession(); revoked.length = 0; });

test("one listener per key, shared by every reader; it lingers after the last reader, then closes", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake();
  const a = acquireShared("k", f.start, INIT), cbA = () => {}; a.listeners.add(cbA);
  const b = acquireShared("k", f.start, INIT), cbB = () => {}; b.listeners.add(cbB);
  assert.equal(a, b); assert.equal(f.starts, 1);
  f.set({ docs: [1], loaded: true, error: null });
  releaseShared("k", a, cbA); releaseShared("k", b, cbB);
  assert.equal(sharedState("k").docs[0], 1, "last data kept while lingering (Back renders at once)");
  mock.timers.tick(LINGER_MS - 1); assert.equal(f.unsubs, 0);
  mock.timers.tick(1); assert.equal(f.unsubs, 1, "closed after the linger time");
  assert.equal(sharedState("k"), undefined);
});

test("idle listeners are capped: beyond MAX_LINGERING the oldest idle one closes at once", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const fs = [];
  for (let i = 0; i < MAX_LINGERING + 5; i++) {
    const f = fake(); fs.push(f);
    const s = acquireShared(`k${i}`, f.start, INIT), cb = () => {}; s.listeners.add(cb); releaseShared(`k${i}`, s, cb);
  }
  assert.equal(sharedStats().lingering, MAX_LINGERING);
  assert.deepEqual(fs.slice(0, 5).map((f) => f.unsubs), [1, 1, 1, 1, 1], "the 5 oldest closed");
  assert.equal(fs[5].unsubs, 0);
  // a listener in use is never closed by the cap
  const inUse = fake(); const s = acquireShared("busy", inUse.start, INIT); s.listeners.add(() => {});
  for (let i = 0; i < MAX_LINGERING + 3; i++) { const f = fake(); const t = acquireShared(`m${i}`, f.start, INIT), cb = () => {}; t.listeners.add(cb); releaseShared(`m${i}`, t, cb); }
  assert.equal(inUse.unsubs, 0);
});

test("a listener that ended (e.g. permission denied) shows that state, and restarts for the next reader", () => {
  const f = fake();
  const s = acquireShared("course", f.start, INIT), cb = () => {}; s.listeners.add(cb);
  f.set({ docs: [{ id: "c1" }], loaded: true, error: null });
  f.set({ docs: [], loaded: true, error: { code: "permission-denied" } }, { ended: true });
  assert.deepEqual(sharedState("course").docs, [], "revoked access: the content is gone from the state");
  releaseShared("course", s, cb);
  const s2 = acquireShared("course", f.start, INIT);
  assert.equal(f.starts, 2, "the next reader re-runs the listener under current access");
  assert.equal(s2.state, INIT);
});

test("clearing the session: listeners closed, readers told, and late snapshots from the old session ignored", () => {
  const f = fake();
  const s = acquireShared("list", f.start, INIT);
  let notified = 0; s.listeners.add(() => { notified += 1; });
  const g = sessionGen();
  clearAcademySession();
  assert.equal(sessionGen(), g + 1);
  assert.equal(f.unsubs, 1, "the old session's listener closed");
  assert.equal(notified, 1, "a still-mounted reader is told to re-read and re-subscribe");
  f.set({ docs: [{ id: "late" }], loaded: true, error: null });   // a late snapshot from the old session
  assert.equal(sharedState("list"), undefined, "it never reaches the new session");
  const f2 = fake(); acquireShared("list", f2.start, INIT);
  f.set({ docs: [{ id: "late again" }], loaded: true, error: null });
  assert.equal(sharedState("list"), INIT, "not even into the new session's entry with the same key");
});

test("images: bounded LRU; images in use are never evicted; evicted URLs are revoked", () => {
  for (let i = 0; i < IMAGE_CACHE_MAX; i++) storeImageUrl(`p${i}`, `blob:${i}`);
  retainImage("p0");                         // p0 is on screen
  cachedImageUrl("p1");                      // p1 recently used
  storeImageUrl("new", "blob:new");
  assert.equal(imageCacheSize(), IMAGE_CACHE_MAX);
  assert.ok(cachedImageUrl("p0"), "in use: kept");
  assert.ok(cachedImageUrl("p1"), "recently used: kept");
  assert.equal(cachedImageUrl("p2"), null, "least recently used and idle: evicted");
  assert.deepEqual(revoked, ["blob:2"]);
  releaseImage("p0");
});

test("images: a download that finishes after sign-out is revoked, never cached; a replaced cover is a new entry", () => {
  const g = sessionGen();
  clearAcademySession();
  assert.equal(storeImageUrl("academy/covers/c1/a.jpg", "blob:late", g), false);
  assert.equal(cachedImageUrl("academy/covers/c1/a.jpg"), null);
  assert.ok(revoked.includes("blob:late"));
  storeImageUrl("academy/covers/c1/a.jpg", "blob:a");
  storeImageUrl("academy/covers/c1/b.jpg", "blob:b");          // new upload = new path
  assert.equal(cachedImageUrl("academy/covers/c1/b.jpg"), "blob:b");
  clearAcademySession();
  assert.ok(revoked.includes("blob:a") && revoked.includes("blob:b"), "sign-out revokes every cached URL");
  assert.equal(imageCacheSize(), 0);
});
