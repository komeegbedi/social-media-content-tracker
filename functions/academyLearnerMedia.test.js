/* Learner image access markers: the visibility test, hidden-list diffs and the
   transactional sync (against an in-memory store). The real triggers run in
   test/trigger/learner-media-trigger.test.js. Run: npm run test:functions */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { learnerVisible, changedHiddenIds, syncLearnerMedia, syncCategories, reconcileLearnerMedia, markerId, COLLECTION } = require("./academyLearnerMedia");

/* In-memory Firestore stand-in. `failNext(n)` makes the next n transactions
   fail (a sync that errors, like a trigger invocation that throws). */
function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  let failing = 0, writes = 0;
  const snap = (path) => ({ id: path.split("/").pop(), exists: data.has(path), data: () => (data.has(path) ? { ...data.get(path) } : undefined) });
  const inColl = (c) => [...data.keys()].filter((p) => p.startsWith(c + "/") && p.split("/").length === 2);
  const ref = (path) => ({ path, get: async () => snap(path), delete: async () => { writes++; data.delete(path); } });
  const store = {
    data, failNext: (n = 1) => { failing = n; }, writes: () => writes,
    doc: (path) => ref(path),
    collection: (c) => ({
      doc: (id) => ref(`${c}/${id}`),
      get: async () => ({ docs: inColl(c).map(snap) }),
      where: (field, op, vals) => ({ get: async () => {
        if (op === "in") { assert.ok(vals.length <= 30, "`in` takes at most 30 values"); return { docs: inColl(c).filter((p) => vals.includes(data.get(p)[field])).map(snap) }; }
        assert.equal(op, "==");
        return { docs: inColl(c).filter((p) => data.get(p)[field] === vals).map(snap) };
      } }),
    }),
    async runTransaction(fn) {
      if (failing > 0) { failing -= 1; throw Object.assign(new Error("ABORTED: simulated failure"), { code: 10 }); }
      const pending = [];
      const tx = { get: async (r) => snap(r.path), set: (r, v) => pending.push(["set", r.path, v]), delete: (r) => pending.push(["del", r.path]) };
      const out = await fn(tx);
      for (const [k, p, v] of pending) { writes++; k === "set" ? data.set(p, v) : data.delete(p); }
      return out;
    },
  };
  return store;
}
const M = (kind, id) => `${COLLECTION}/${markerId(kind, id)}`;

test("visibility = published and not in a hidden category (the firestore.rules test)", () => {
  assert.equal(learnerVisible({ status: "published", category: "photography" }, []), true);
  assert.equal(learnerVisible({ status: "published", category: "photography" }, ["photography"]), false);
  assert.equal(learnerVisible({ status: "draft", category: "photography" }, []), false);
  assert.equal(learnerVisible({ status: "archived", category: "photography" }, []), false);
  assert.equal(learnerVisible(null, []), false, "a deleted item");
  assert.equal(learnerVisible({ status: "published" }, ["x"]), true, "no category: '' is never hidden");
  assert.equal(learnerVisible({ status: "published", category: "a" }, undefined), true, "no index yet");
});

test("only categories whose hidden state changed are re-synced", () => {
  assert.deepEqual(changedHiddenIds(["a", "b"], ["b", "c"]).sort(), ["a", "c"]);
  assert.deepEqual(changedHiddenIds(undefined, ["a"]), ["a"]);
  assert.deepEqual(changedHiddenIds(["a"], ["a"]), []);
});

test("sync: the marker exists exactly while the item is learner-visible; never for drafts", async () => {
  const s = fakeStore({ "courses/c1": { status: "published", category: "photography" }, "academySettings/categoryIndex": { hidden: [] } });
  assert.equal(await syncLearnerMedia("course", "c1", s), true);
  assert.deepEqual({ ...s.data.get(M("course", "c1")), updatedAt: null }, { kind: "course", id: "c1", category: "photography", updatedAt: null });
  s.data.set("courses/c1", { status: "archived", category: "photography" });
  assert.equal(await syncLearnerMedia("course", "c1", s), false);
  assert.ok(!s.data.has(M("course", "c1")), "unpublished → marker removed");
  // a never-published draft: no live doc at all
  assert.equal(await syncLearnerMedia("course", "draftOnly", s), false);
  assert.ok(!s.data.has(M("course", "draftOnly")));
  // deleted
  s.data.set("courses/c1", { status: "published", category: "photography" }); await syncLearnerMedia("course", "c1", s);
  s.data.delete("courses/c1"); await syncLearnerMedia("course", "c1", s);
  assert.ok(!s.data.has(M("course", "c1")), "deleted → marker removed");
});

test("sync is idempotent and converges from the CURRENT state (retries, duplicate or late events)", async () => {
  const s = fakeStore({ "guides/g1": { status: "published", category: "a" } });
  await syncLearnerMedia("guide", "g1", s);
  const first = s.data.get(M("guide", "g1"));
  await syncLearnerMedia("guide", "g1", s);
  assert.equal(s.data.get(M("guide", "g1")), first, "no rewrite when nothing changed");
  // the category is hidden; a LATE course event recomputes and still hides it
  s.data.set("academySettings/categoryIndex", { hidden: ["a"] });
  await syncLearnerMedia("guide", "g1", s);
  assert.ok(!s.data.has(M("guide", "g1")));
});

test("hiding / showing a category re-syncs its courses and guides (more than 30 categories in chunks)", async () => {
  const init = { "academySettings/categoryIndex": { hidden: [] } };
  for (let i = 0; i < 35; i++) init[`courses/c${i}`] = { status: "published", category: `cat${i}` };
  init["guides/g1"] = { status: "published", category: "cat34" };
  init["courses/other"] = { status: "published", category: "untouched" };
  const s = fakeStore(init);
  for (const p of Object.keys(init)) { const [c, id] = p.split("/"); if (c === "courses") await syncLearnerMedia("course", id, s); if (c === "guides") await syncLearnerMedia("guide", id, s); }
  const all = Array.from({ length: 35 }, (_, i) => `cat${i}`);
  s.data.set("academySettings/categoryIndex", { hidden: all });
  assert.equal(await syncCategories(all, s), 36);
  assert.equal([...s.data.keys()].filter((p) => p.startsWith(COLLECTION + "/")).sort().join(), M("course", "other"), "only the untouched category stays visible");
  s.data.set("academySettings/categoryIndex", { hidden: [] });
  await syncCategories(["cat34"], s);
  assert.ok(s.data.has(M("course", "c34")) && s.data.has(M("guide", "g1")), "shown again");
});

test("refuses unknown kinds and empty ids", async () => {
  await assert.rejects(syncLearnerMedia("path", "p1", fakeStore()));
  await assert.rejects(syncLearnerMedia("course", "", fakeStore()));
});

test("a FAILED revocation leaves the marker (images still readable) until a retry or reconcile repairs it", async () => {
  const s = fakeStore({ "courses/c1": { status: "published", category: "a" }, "academySettings/categoryIndex": { hidden: [] } });
  await syncLearnerMedia("course", "c1", s);
  s.data.set("courses/c1", { status: "archived", category: "a" });          // unpublished in Firestore…
  s.failNext(1);
  await assert.rejects(syncLearnerMedia("course", "c1", s), /simulated failure/, "…but the trigger's sync fails (the event is retried)");
  assert.ok(s.data.has(M("course", "c1")), "the stale marker still exists: revocation has NOT happened yet");
  const found = await reconcileLearnerMedia(s);
  assert.deepEqual(found.stale, [markerId("course", "c1")], "the drift check reports it");
  assert.equal(found.repaired, 0); assert.ok(s.data.has(M("course", "c1")), "dry run writes nothing");
  const fixed = await reconcileLearnerMedia(s, { apply: true });
  assert.equal(fixed.repaired, 1);
  assert.ok(!s.data.has(M("course", "c1")), "repaired: marker removed");
  assert.deepEqual(await reconcileLearnerMedia(s), { visibleItems: 0, markers: 0, missing: [], stale: [], repaired: 0 });
});

test("a retried event converges: the retry recomputes from the current state", async () => {
  const s = fakeStore({ "guides/g1": { status: "published", category: "a" }, "academySettings/categoryIndex": { hidden: [] } });
  await syncLearnerMedia("guide", "g1", s);
  s.data.set("academySettings/categoryIndex", { hidden: ["a"] });
  s.failNext(2);
  await assert.rejects(syncCategories(["a"], s)); await assert.rejects(syncCategories(["a"], s));
  assert.ok(s.data.has(M("guide", "g1")), "still readable while the retries fail");
  await syncCategories(["a"], s);                                             // a later retry succeeds
  assert.ok(!s.data.has(M("guide", "g1")));
});

test("rapid publish → hide → show, events handled in ANY order, ends in the state of the documents", async () => {
  const states = [
    { item: { status: "published", category: "a" }, hidden: [] },          // publish
    { item: { status: "published", category: "a" }, hidden: ["a"] },       // hide
    { item: { status: "published", category: "a" }, hidden: [] },          // show
  ];
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [2, 0, 1]]) {
    const s = fakeStore({ "courses/c1": states[2].item, "academySettings/categoryIndex": { hidden: states[2].hidden } });
    for (const _ of order) await syncLearnerMedia("course", "c1", s);      // every event reads the CURRENT docs
    assert.ok(s.data.has(M("course", "c1")), `order ${order}: visible at the end`);
  }
  // …and when the last change was "hide", every order ends hidden
  for (const order of [[0, 1], [1, 0]]) {
    const s = fakeStore({ "courses/c1": states[1].item, "academySettings/categoryIndex": { hidden: ["a"] } });
    for (const _ of order) await syncLearnerMedia("course", "c1", s);
    assert.ok(!s.data.has(M("course", "c1")), `order ${order}: hidden at the end`);
  }
});

test("reconcile: missing markers (initialisation of already-published items) and stale or malformed markers", async () => {
  const s = fakeStore({
    "academySettings/categoryIndex": { hidden: ["h"] },
    "courses/pub": { status: "published", category: "a" },                  // published before the triggers existed
    "courses/hid": { status: "published", category: "h" },
    "courses/dr": { status: "draft", category: "a" },
    "guides/g": { status: "published", category: "a" },
    [`${COLLECTION}/course_dr`]: { kind: "course", id: "dr" },             // stale
    [`${COLLECTION}/junk`]: { foo: 1 },                                    // malformed
  });
  const r = await reconcileLearnerMedia(s);
  assert.deepEqual(r.missing, [markerId("course", "pub"), markerId("guide", "g")]);
  assert.deepEqual(r.stale, ["course_dr", "junk"]);
  const before = s.writes();
  await reconcileLearnerMedia(s);
  assert.equal(s.writes(), before, "dry run: no writes");
  await reconcileLearnerMedia(s, { apply: true });
  const after = await reconcileLearnerMedia(s);
  assert.deepEqual([after.missing, after.stale], [[], []]);
  assert.deepEqual([...s.data.keys()].filter((p) => p.startsWith(COLLECTION)).sort(), [M("course", "pub"), M("guide", "g")]);
});
