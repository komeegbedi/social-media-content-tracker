const { test } = require("node:test");
const assert = require("node:assert/strict");
const D = require("./academyCategoryDeletion");
const ts = (n) => ({ toMillis: () => n });

test("PARITY: server and browser fingerprint a course identically (any publish/save/move after review is detected)", async () => {
  const C = await import("../src/academyCategoryDeletion.js");
  const cases = [[{ status: "published", category: "photo", updatedAt: ts(9) }, { category: "photo", rev: 4 }], [null, { category: "photo", rev: 1 }], [{ status: "archived", category: "photo", updatedAt: ts(1) }, null], [{ status: "draft", category: "photo" }, { category: "film", rev: 2 }]];
  for (const [l, d] of cases) assert.equal(D.courseFingerprint(l, d), C.courseFingerprint(l, d));
  assert.notEqual(D.courseFingerprint({ status: "published", category: "photo", updatedAt: ts(9) }, null), D.courseFingerprint({ status: "published", category: "photo", updatedAt: ts(10) }, null), "a re-publish changes it");
});

test("review diff: added, removed and changed courses / guides / paths are all reported", () => {
  const current = { courses: [{ id: "a", title: "A", fp: "1" }, { id: "n", title: "New", fp: "x" }], guides: [{ id: "g2", title: "G2", fp: "g" }, { id: "g3", title: "G3", fp: "new" }], paths: [] };
  const expected = { courses: [{ id: "a", fp: "0" }, { id: "gone", fp: "y" }], guides: [{ id: "g1", fp: "z" }, { id: "g3", fp: "old" }], paths: ["p1"] };
  const ch = D.diffContents(current, expected).map((c) => `${c.kind}:${c.type}:${c.id}`).sort();
  assert.deepEqual(ch, ["added:course:n", "added:guide:g2", "changed:course:a", "changed:guide:g3", "removed:course:gone", "removed:guide:g1", "removed:path:p1"]);
  assert.deepEqual(D.diffContents({ courses: [{ id: "a", fp: "1" }], guides: [], paths: [] }, { courses: [{ id: "a", fp: "1" }], guides: [], paths: [] }), []);
  assert.deepEqual(D.idsFor("filmmaking"), ["filmmaking", "videography"]);
});
