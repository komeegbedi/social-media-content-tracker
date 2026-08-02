/* Tests for the comment merge/dedup layer that lets the legacy embedded array and
   the canonical subcollection coexist during migration without double-rendering.
   Run with: node --test src/comments.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmMillis, commentKey, mergeComments } from "./data.js";

test("tmMillis normalises every timestamp shape to epoch-millis", () => {
  assert.equal(tmMillis(1720000000000), 1720000000000);              // legacy number
  assert.equal(tmMillis({ toMillis: () => 42 }), 42);                // Firestore Timestamp
  assert.equal(tmMillis({ seconds: 2, nanoseconds: 500000000 }), 2500); // plain wire shape
  assert.equal(tmMillis(new Date(1000)), 1000);                      // Date
  assert.equal(tmMillis(null), 0);
  assert.equal(tmMillis(undefined), 0);
});

test("a migrated subcollection comment collapses onto its embedded twin", () => {
  // The migration preserves who/txt/tm, so both representations share a key.
  const embedded = { who: "Ada", txt: "nice work", tm: 1000 };
  const migrated = { who: "Ada", txt: "nice work", tm: { toMillis: () => 1000 }, id: "legacy-0" };
  assert.equal(commentKey(embedded), commentKey(migrated));
});

test("mergeComments renders each comment once, subcollection copy winning", () => {
  const embedded = [
    { who: "Ada", txt: "first", tm: 1000 },
    { who: "Bo", txt: "second", tm: 2000 },
  ];
  const sub = [
    // migrated twin of the first embedded comment (same identity)
    { who: "Ada", txt: "first", tm: { toMillis: () => 1000 }, id: "legacy-0" },
    // a brand-new comment written straight to the subcollection
    { who: "Cy", txt: "third", tm: { toMillis: () => 3000 }, id: "abc" },
  ];
  const merged = mergeComments(embedded, sub);
  assert.equal(merged.length, 3);                       // no duplicate for "first"
  assert.deepEqual(merged.map(c => c.txt), ["first", "second", "third"]); // oldest first
  assert.equal(merged[0].source, "sub");                // canonical copy wins
  assert.equal(merged[0].id, "legacy-0");
  assert.equal(merged[1].source, "legacy");             // not-yet-migrated stays visible
});

test("mergeComments tolerates missing/empty inputs", () => {
  assert.deepEqual(mergeComments(), []);
  assert.deepEqual(mergeComments(undefined, undefined), []);
  assert.equal(mergeComments([{ who: "A", txt: "x", tm: 5 }], []).length, 1);
  assert.equal(mergeComments([], [{ who: "A", txt: "x", tm: { toMillis: () => 5 }, id: "z" }]).length, 1);
});

test("distinct comments are not collapsed", () => {
  const sub = [
    { who: "Ada", txt: "hi", tm: { toMillis: () => 1000 }, id: "a" },
    { who: "Ada", txt: "hi", tm: { toMillis: () => 2000 }, id: "b" }, // same text, different time
    { who: "Bo", txt: "hi", tm: { toMillis: () => 1000 }, id: "c" },  // same text/time, different author
  ];
  assert.equal(mergeComments([], sub).length, 3);
});
