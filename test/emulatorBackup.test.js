/* Local data safety boundaries (scripts/emulatorBackup.js). Run: node --test test/emulatorBackup.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertSafeBackupRoot, assertSafeCleanupTarget, planRetention, snapshotName, parseSnapshotName, compareManifests, DEFAULT_BACKUP_ROOT, isInside,
} from "../scripts/emulatorBackup.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("backups may not live anywhere a restart or the test tooling clears, nor inside the repo", () => {
  for (const bad of ["/tmp/ifc", "/private/tmp/claude-501/x", path.join(os.tmpdir(), "ifc-backups"), path.join(REPO, ".emulator-test-tmp", "b"), path.join(REPO, "backups"), "relative/dir"])
    assert.throws(() => assertSafeBackupRoot(bad, REPO), undefined, bad);
  assert.throws(() => assertSafeBackupRoot("/", REPO), /overlaps/, "a root that CONTAINS a volatile folder is refused too");
  assert.equal(assertSafeBackupRoot(DEFAULT_BACKUP_ROOT, REPO), path.resolve(os.homedir(), "IFC-local-backups"));
});

test("test cleanup may remove only its own private temp folder, never the backup root", () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "ifcemu-"));
  try { assert.equal(assertSafeCleanupTarget(own), own); } finally { fs.rmSync(own, { recursive: true, force: true }); }
  const backup = path.join(os.homedir(), "IFC-local-backups");
  for (const bad of [backup, path.join(backup, "dev-emulators"), os.tmpdir(), path.join(os.tmpdir(), "other-folder"), path.join(REPO, ".emulator-test-tmp"), "/private/tmp/ifcemu-x"])
    assert.throws(() => assertSafeCleanupTarget(bad, { backup }), /refusing/, bad);
  // a backup root placed (wrongly) in the temp dir is still protected from cleanup
  const odd = path.join(os.tmpdir(), "ifcemu-backups");
  assert.throws(() => assertSafeCleanupTarget(odd, { backup: odd }), /overlaps the backup root/);
});

test("the test runner's cleanup goes through the guard", () => {
  const src = fs.readFileSync(path.join(REPO, "scripts", "emulator-test.mjs"), "utf8");
  assert.match(src, /fs\.rmSync\(assertSafeCleanupTarget\(tmp\)/);
  assert.doesNotMatch(src.replace(/fs\.rmSync\(assertSafeCleanupTarget\(tmp\)/, ""), /fs\.rmSync\(/, "no other deletion in the test runner");
});

test("dev, test, review and restore-verification emulators never share ports", async () => {
  const dev = Object.values(JSON.parse(fs.readFileSync(path.join(REPO, "firebase.json"), "utf8")).emulators || {}).map((e) => e && e.port).filter(Boolean);
  const { TEST_PORTS } = await import("../scripts/emulator-test.mjs");
  const { VERIFY_PORTS } = await import("../scripts/emulator-backup.mjs");
  const REVIEW = [4430, 4530, 9590, 8390, 9400, 5390, 9690, 8395, 9790];   // .emulator-test-tmp/review (docs/local-data-safety.md)
  const sets = { dev, test: Object.values(TEST_PORTS), verify: Object.values(VERIFY_PORTS), review: REVIEW };
  const names = Object.keys(sets);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const shared = sets[names[i]].filter((p) => sets[names[j]].includes(p));
    assert.deepEqual(shared, [], `${names[i]} and ${names[j]} share ${shared}`);
  }
});

test("snapshot names are timestamped and typed; nothing else counts as a snapshot", () => {
  const n = snapshotName("periodic", new Date("2026-11-17T02:10:57.123Z"));
  assert.equal(n, "20261117T021057Z-periodic");
  assert.deepEqual(parseSnapshotName(n), { stamp: "20261117T021057Z", kind: "periodic" });
  for (const x of ["export", "20261117T021057Z-periodic.partial", "backup2", "20261117T021057Z-other"]) assert.equal(parseSnapshotName(x), null, x);
  assert.throws(() => snapshotName("weekly"));
});

test("retention never removes manual, pre-restart, unverified or foreign folders, and always leaves verified ones", () => {
  const e = [];
  for (let h = 0; h < 20; h++) e.push({ name: `202611${String(10 + Math.floor(h / 10)).padStart(2, "0")}T${String(h % 10).padStart(2, "0")}0000Z-periodic`, verified: true });
  e.push({ name: "20261101T000000Z-manual", verified: true }, { name: "20261101T010000Z-pre-restart", verified: false }, { name: "20261101T020000Z-periodic", verified: false }, { name: "backup2", verified: true });
  const { remove } = planRetention(e, { keep: 12 });
  assert.equal(remove.length, 8, "20 verified periodic → keep the newest 12");
  for (const keep of ["20261101T000000Z-manual", "20261101T010000Z-pre-restart", "20261101T020000Z-periodic", "backup2"]) assert.ok(!remove.includes(keep), keep);
  const newest12 = e.filter((x) => /periodic$/.test(x.name) && x.verified).map((x) => x.name).sort().reverse().slice(0, 12);
  for (const n of newest12) assert.ok(!remove.includes(n));
  // with few verified snapshots nothing is removed
  assert.deepEqual(planRetention([{ name: "20261101T000000Z-periodic", verified: true }, { name: "20261102T000000Z-periodic", verified: true }], { keep: 1 }).remove, []);
  assert.ok(isInside("/a/b/c", "/a/b") && !isInside("/a/bc", "/a/b"));
});

test("manifest comparison reports every difference", () => {
  const m = { firestore: { docs: 3, byCollection: { a: 2, b: 1 }, digest: "x" }, auth: { users: 2 }, storage: { objects: 1, digest: "s" } };
  assert.deepEqual(compareManifests(m, structuredClone(m)), []);
  const n = structuredClone(m); n.firestore.docs = 2; n.firestore.byCollection.b = 0; n.firestore.digest = "y"; n.auth.users = 1; n.storage.objects = 0; n.storage.digest = "t";
  assert.equal(compareManifests(m, n).length, 6);
});
