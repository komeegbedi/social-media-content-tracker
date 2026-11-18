/* scripts/carry-over-assets.mjs — assembling a release with BOUNDED asset retention. Run: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { assembleRelease, cleanBuildInfo, verifySums, manifestPathFor } from "../scripts/carry-over-assets.mjs";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
function build(files, entry, { sums = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "carry-"));
  fs.mkdirSync(path.join(d, "assets"));
  const html = `<script type="module" src="/assets/${entry}"></script>`;
  fs.writeFileSync(path.join(d, "index.html"), html);
  const all = { "index.html": html };
  for (const [n, c] of Object.entries(files)) { fs.writeFileSync(path.join(d, "assets", n), c); all[`assets/${n}`] = c; }
  const s = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sums-")), "dist.SHA256SUMS");
  if (sums) fs.writeFileSync(s, Object.entries(all).map(([n, c]) => `${sha(c)}  ./${n}`).join("\n") + "\n");
  return { dir: d, sums: s };
}

test("assembles: only the previous release's missing assets; index.html from the new build; a manifest names what is retained", () => {
  const old = build({ "index-OLD.js": "old entry", "index.esm-Di5kQlnq.js": "old functions sdk", "shared-AAA.js": "same" }, "index-OLD.js");
  const cur = build({ "index-NEW.js": "new entry", "index.esm-tG.js": "new functions sdk", "shared-AAA.js": "same" }, "index-NEW.js");
  const before = fs.readFileSync(path.join(cur.dir, "index.html"), "utf8");
  const m = assembleRelease({ dist: cur.dir, release: "r3", commit: "abc", from: [{ label: "r2", ...old }] });
  assert.equal(m.release.entry, "index-NEW.js");
  assert.deepEqual(m.retained[0].files.filter((f) => f.copied).map((f) => f.name).sort(), ["index-OLD.js", "index.esm-Di5kQlnq.js"]);
  assert.equal(fs.readFileSync(path.join(cur.dir, "assets", "index.esm-Di5kQlnq.js"), "utf8"), "old functions sdk");
  assert.equal(fs.readFileSync(path.join(cur.dir, "index.html"), "utf8"), before, "index.html always from the new build");
  assert.equal(fs.readdirSync(cur.dir).some((n) => n.startsWith(".")), false, "nothing extra inside the deploy folder");
  const written = JSON.parse(fs.readFileSync(manifestPathFor(cur.dir), "utf8"));
  assert.equal(written.retained[0].label, "r2");
  assert.equal(written.retained[0].files.find((f) => f.name === "index-OLD.js").sha256, sha("old entry"));
});

test("BOUNDED: an assembled folder (with a manifest or several entries) can't be a source; at most --keep releases", () => {
  const r1 = build({ "index-R1.js": "1" }, "index-R1.js");
  const r2 = build({ "index-R2.js": "2" }, "index-R2.js");
  const r3 = build({ "index-R3.js": "3" }, "index-R3.js");
  assembleRelease({ dist: r2.dir, release: "r2", from: [{ label: "r1", ...r1 }] });        // r2's deploy folder now holds r1's files
  const r4 = build({ "index-R4.js": "4" }, "index-R4.js");
  assert.throws(() => assembleRelease({ dist: r4.dir, release: "r4", from: [{ label: "r2", dir: r2.dir, sums: r2.sums }] }), /ASSEMBLED release/);
  fs.rmSync(manifestPathFor(r2.dir));                                                  // even without its manifest…
  assert.throws(() => cleanBuildInfo(r2.dir), /not a clean build: entry files/);           // …two entries give it away
  assert.throws(() => assembleRelease({ dist: r4.dir, release: "r4", keep: 2, from: [{ label: "a", ...r3 }, { label: "b", ...r1 }, { label: "c", ...build({ "index-R0.js": "0" }, "index-R0.js") }] }), /at most 2/);
});

test("a source must match the checksums recorded for that release, byte for byte", () => {
  const old = build({ "index-OLD.js": "o", "a-1.js": "a" }, "index-OLD.js");
  assert.equal(verifySums(old.dir, old.sums), 3);
  fs.writeFileSync(path.join(old.dir, "assets", "a-1.js"), "tampered");
  const cur = build({ "index-NEW.js": "n" }, "index-NEW.js");
  assert.throws(() => assembleRelease({ dist: cur.dir, release: "r", from: [{ label: "old", ...old }] }), /doesn't match/);
  fs.writeFileSync(path.join(old.dir, "assets", "a-1.js"), "a");
  fs.writeFileSync(path.join(old.dir, "assets", "extra-9.js"), "x");
  assert.throws(() => assembleRelease({ dist: cur.dir, release: "r", from: [{ label: "old", ...old }] }), /extra assets\/extra-9\.js/);
});

test("refuses unsafe inputs: a same-named file with different bytes, a non-build folder, the same build twice", () => {
  const cur = build({ "index-NEW.js": "x", "chunk-A.js": "new bytes" }, "index-NEW.js");
  assert.throws(() => assembleRelease({ dist: cur.dir, release: "r", from: [{ label: "o", ...build({ "index-OLD.js": "y", "chunk-A.js": "other bytes" }, "index-OLD.js") }] }), /differs/);
  const notBuild = fs.mkdtempSync(path.join(os.tmpdir(), "carry-"));
  assert.throws(() => assembleRelease({ dist: cur.dir, release: "r", from: [{ label: "o", dir: notBuild, sums: "x" }] }), /not a build/);
  assert.throws(() => assembleRelease({ dist: cur.dir, release: "r", from: [{ label: "same", ...build({ "index-NEW.js": "x" }, "index-NEW.js") }] }), /duplicates/);
});

test("dry run writes nothing", () => {
  const old = build({ "index-OLD.js": "o", "a-1.js": "a" }, "index-OLD.js");
  const cur = build({ "index-NEW.js": "n" }, "index-NEW.js");
  const m = assembleRelease({ dist: cur.dir, release: "r", from: [{ label: "old", ...old }], dryRun: true });
  assert.equal(m.retained[0].files.filter((f) => f.copied).length, 2);
  assert.deepEqual(fs.readdirSync(path.join(cur.dir, "assets")), ["index-NEW.js"]);
  assert.equal(fs.existsSync(manifestPathFor(cur.dir)), false);
});
