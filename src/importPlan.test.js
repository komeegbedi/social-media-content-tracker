/* Data-safety + idempotency contracts for the bulk CSV import (src/importPlan.js).
   Proves: content-based deterministic ids (SHA-256/128-bit), duplicate-row
   handling, reordering policy, fingerprint conflict detection, and retry-only-
   failed orchestration — all without Firestore. Run: node --test src/importPlan.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRowKeys, sourceContentDigest, normalizeRow, classifyExisting,
  importBatch, mergeRowResults, importSummary,
} from "./importPlan.js";

const A = { Title: "A", Owner: "Alex", Date: "2026-08-20" };
const B = { Title: "B", Owner: "Jordan", Date: "2026-08-21" };
const C = { Title: "C", Owner: "Sam", Date: "2026-08-22" };

// ---- deterministic keys -------------------------------------------------------

test("ids are Firestore-safe, deterministic, and 128-bit content digests", async () => {
  const k1 = await buildRowKeys([A, B, C]);
  const k2 = await buildRowKeys([A, B, C]);
  assert.deepEqual(k1.map((k) => k.id), k2.map((k) => k.id));       // deterministic
  for (const k of k1) {
    assert.match(k.id, /^imp_[0-9a-f]{32}$/);                       // 128-bit hex, safe chars
    assert.equal(k.fingerprint.length, 64);                        // full 256-bit fingerprint stored
  }
});

test("same content, renamed file / different metadata → same source digest AND same row ids", async () => {
  const text = "Title,Owner\nA,Alex\nB,Jordan\n";
  // filename/size/URL never enter — only content does
  assert.equal(await sourceContentDigest(text), await sourceContentDigest(text));
  // cosmetic whitespace / trailing newline differences normalise to the same digest
  assert.equal(await sourceContentDigest(text), await sourceContentDigest(text + "\n\n"));
  const rows = [{ Title: "A", Owner: "Alex" }, { Title: "B", Owner: "Jordan" }];
  const k1 = await buildRowKeys(rows);
  const k2 = await buildRowKeys(rows.map((r) => ({ ...r })));       // different object identity, same content
  assert.deepEqual(k1.map((k) => k.id), k2.map((k) => k.id));
});

test("same source retried after refresh → identical ids (nothing positional or random)", async () => {
  const before = await buildRowKeys([A, B, C]);
  const afterRefresh = await buildRowKeys([A, B, C]);              // fresh call, as after a reload
  assert.deepEqual(before.map((k) => k.id), afterRefresh.map((k) => k.id));
});

test("one changed row → a NEW id for that row only; the others keep theirs", async () => {
  const base = await buildRowKeys([A, B, C]);
  const edited = await buildRowKeys([A, { ...B, Owner: "Riley" }, C]);
  assert.equal(edited[0].id, base[0].id, "unchanged row A keeps its id");
  assert.equal(edited[2].id, base[2].id, "unchanged row C keeps its id");
  assert.notEqual(edited[1].id, base[1].id, "the edited row B gets a new id");
});

test("reordering DISTINCT rows does not change any id (identity is content-based, not positional)", async () => {
  const ordered = await buildRowKeys([A, B, C]);
  const shuffled = await buildRowKeys([C, A, B]);
  // map each id back by content: A,B,C ids must be identical regardless of order
  const byContent = (keys, rows) => Object.fromEntries(rows.map((r, i) => [r.Title, keys[i].id]));
  const o = byContent(ordered, [A, B, C]);
  const s = byContent(shuffled, [C, A, B]);
  assert.equal(o.A, s.A); assert.equal(o.B, s.B); assert.equal(o.C, s.C);
});

test("two identical rows in one file → two DISTINCT ids (occurrence ordinal), reorder-stable as a set", async () => {
  const keys = await buildRowKeys([A, A, B]);
  assert.notEqual(keys[0].id, keys[1].id, "the two identical rows are separate documents");
  assert.equal(keys[0].occurrence, 0);
  assert.equal(keys[1].occurrence, 1);
  // reordering the identical rows among themselves yields the SAME set of ids
  const set1 = new Set([keys[0].id, keys[1].id]);
  const re = await buildRowKeys([A, A, B]);
  assert.deepEqual(new Set([re[0].id, re[1].id]), set1);
  assert.equal(re[2].id, keys[2].id, "the distinct row B is unaffected");
});

test("normalizeRow is column-order independent and value-trimmed", () => {
  assert.equal(normalizeRow({ Title: "A", Owner: "Alex" }), normalizeRow({ Owner: "Alex ", Title: " A" }));
  assert.notEqual(normalizeRow({ Title: "A" }), normalizeRow({ Title: "B" }));
});

// ---- existing-document fingerprint reconciliation -----------------------------

test("existing document with MATCHING fingerprint → idempotent skip (match)", async () => {
  const [row] = await buildRowKeys([A]);
  const existing = { importFp: row.fingerprint, title: "A" };
  assert.equal(classifyExisting(existing, row), "match");
});

test("existing document with MISMATCHED fingerprint → conflict (never silently succeeds)", async () => {
  const [row] = await buildRowKeys([A]);
  assert.equal(classifyExisting({ importFp: "deadbeef".repeat(8) }, row), "conflict");
  assert.equal(classifyExisting({ /* no importFp */ }, row), "conflict");
  assert.equal(classifyExisting(null, row), "absent");
});

// ---- retry orchestration (unchanged safety) -----------------------------------

test("partial retry still submits ONLY failed rows; succeeded rows are never resubmitted", async () => {
  const rows = (await buildRowKeys([A, B, C])).map((k, i) => ({ ...k, task: [A, B, C][i] }));
  const status = mergeRowResults({}, [
    { key: rows[0].key, status: "succeeded", id: rows[0].id },
    { key: rows[1].key, status: "failed", id: rows[1].id, error: "unavailable" },
    { key: rows[2].key, status: "succeeded", id: rows[2].id },
  ]);
  const retry = importBatch(rows, status);
  assert.equal(retry.length, 1);
  assert.equal(retry[0].id, rows[1].id, "only the failed row is retried");
  const s = importSummary(rows, status);
  assert.deepEqual([s.succeeded, s.failed, s.remaining], [2, 1, 1]);
});
