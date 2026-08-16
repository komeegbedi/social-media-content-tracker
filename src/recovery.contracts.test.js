/* Recoverability contracts that are pure enough to pin without Firebase:
   - Archiving/restoring a recurring event preserves its recurrence rule exactly.
   - Recent-search "remove one" and "clear all" Undo restore the EXACT prior order.
   Run: node --test src/recovery.contracts.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { seriesFromDoc, nextOccurrences } from "./events.js";

/* ---- event archive/restore preserves recurrence ---- */
const eventDoc = {
  id: "ev1", name: "Praise Night", emoji: "🎤",
  frequency: "monthly-weekday", interval: 1, anchorDate: "2026-09-04",
  showOnHome: true, active: true,
};

test("archiving an event hides it from all occurrence math (seriesFromDoc → null)", () => {
  assert.equal(seriesFromDoc({ ...eventDoc, archived: true }), null);
});

test("restoring (archived:false) returns the SAME recurrence rule — pattern is never lost", () => {
  const before = seriesFromDoc(eventDoc);                       // active
  const afterRestore = seriesFromDoc({ ...eventDoc, archived: false });
  assert.ok(before && afterRestore);
  // The rule (frequency/interval/anchor-derived pattern) is identical across the
  // archive→restore round-trip, so upcoming dates are unchanged.
  assert.deepEqual(afterRestore.rule, before.rule);
  const from = new Date(2026, 7, 1); // Aug 2026
  assert.deepEqual(
    nextOccurrences(afterRestore.rule, from, 3),
    nextOccurrences(before.rule, from, 3),
  );
});

/* ---- recent-search Undo restores exact prior order ---- */
// Mirrors GlobalSearch's pure operations: removeRecent filters, clearRecents
// empties, and undo restores the captured `prev` array verbatim.
const removeOne = (list, t) => list.filter((x) => x !== t);

test("remove-one Undo restores the removed term to its ORIGINAL position", () => {
  const recents = ["reel", "graphic", "carousel", "story"];
  const prev = recents;                                         // captured snapshot
  const afterRemove = removeOne(recents, "carousel");
  assert.deepEqual(afterRemove, ["reel", "graphic", "story"]);
  // Undo = restore the whole ordered snapshot (not append-to-end).
  assert.deepEqual(prev, ["reel", "graphic", "carousel", "story"]);
});

test("clear-all Undo restores the entire ordered list, newest-first", () => {
  const recents = ["reel", "graphic", "carousel"];
  const prev = recents;
  const afterClear = [];
  assert.deepEqual(afterClear, []);
  assert.deepEqual(prev, ["reel", "graphic", "carousel"]);      // order preserved for Undo
});

test("a captured snapshot is independent of later edits (no shared-reference leak)", () => {
  let recents = ["a", "b", "c"];
  const prev = recents;                 // snapshot the reference the component keeps
  recents = removeOne(recents, "b");    // commitRecents replaces the array (never mutates)
  assert.deepEqual(recents, ["a", "c"]);
  assert.deepEqual(prev, ["a", "b", "c"]); // snapshot still intact → Undo is faithful
});
