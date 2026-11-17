/* Local emulator data safety: pure rules shared by scripts/emulator-backup.mjs,
   scripts/dev-emulators.mjs and scripts/emulator-test.mjs (and unit-tested in
   test/emulatorBackup.test.js). No Firebase imports here.

   Why: on 2026-11-16 a Mac restart cleared /private/tmp, which held every dev
   emulator export, while the dev emulators themselves ran without saving on exit.
   Backups must live somewhere a restart and the test runners can never clear, and
   no export may ever be overwritten or pruned unless newer verified ones exist. */
import path from "node:path";
import os from "node:os";

export const DEFAULT_BACKUP_ROOT = path.join(os.homedir(), "IFC-local-backups");
export const backupRoot = () => path.resolve(process.env.IFC_BACKUP_ROOT || DEFAULT_BACKUP_ROOT);

const norm = (p) => { const r = path.resolve(p); return r.endsWith(path.sep) ? r : r + path.sep; };
export const isInside = (child, parent) => norm(child).startsWith(norm(parent));

/* Places that are cleared by the OS or by our own test tooling. */
export function volatileRoots(repo) {
  const roots = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", os.tmpdir()];
  if (repo) roots.push(path.join(repo, ".emulator-test-tmp"), path.join(repo, "node_modules"), path.join(repo, "dist"));
  return roots.map((r) => path.resolve(r));
}

/* A backup location must be absolute, outside every volatile place, and outside
   the repository (so a clean checkout, `git clean`, or a test runner can't touch
   it). Throws with the reason; returns the resolved path. */
export function assertSafeBackupRoot(root, repo) {
  if (!root || !path.isAbsolute(root)) throw new Error(`backup root must be an absolute path (got "${root}")`);
  const r = path.resolve(root);
  for (const v of volatileRoots(repo)) if (isInside(r, v) || isInside(v, r)) throw new Error(`backup root ${r} overlaps ${v}, which the OS or the test tooling clears`);
  if (repo && isInside(r, repo)) throw new Error(`backup root ${r} is inside the repository (${repo}); keep backups outside it`);
  return r;
}

/* Test-runner cleanup may only remove the private temp folder it created itself:
   a direct child of the OS temp dir whose name starts with the given prefix — never
   anything under (or containing) the backup root. */
export function assertSafeCleanupTarget(target, { prefix = "ifcemu-", backup = backupRoot() } = {}) {
  const t = path.resolve(target);
  if (path.dirname(t) !== path.resolve(os.tmpdir()) || !path.basename(t).startsWith(prefix)) throw new Error(`refusing to clean ${t}: not a ${prefix}* folder directly in ${os.tmpdir()}`);
  if (isInside(t, backup) || isInside(backup, t)) throw new Error(`refusing to clean ${t}: it overlaps the backup root ${backup}`);
  return t;
}

/* Snapshot folder names: <UTC timestamp>-<kind>, e.g. 20261116T211500Z-periodic. */
export const KINDS = ["periodic", "on-exit", "manual", "pre-restart"];
export const snapshotName = (kind, d = new Date()) => {
  if (!KINDS.includes(kind)) throw new Error(`unknown snapshot kind "${kind}"`);
  return `${d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${kind}`;
};
export const parseSnapshotName = (name) => {
  const m = /^(\d{8}T\d{6}Z)-([a-z-]+)$/.exec(name);
  return m && KINDS.includes(m[2]) ? { stamp: m[1], kind: m[2] } : null;
};

/* Which snapshots may be pruned. Entries: { name, verified }. Rules:
   • only folders this tooling named (parseSnapshotName) are ever candidates;
   • unverified snapshots are never pruned automatically (a person looks at them);
   • "manual" and "pre-restart" snapshots are never pruned automatically;
   • the newest `keep` verified periodic/on-exit snapshots are kept, and at least
     `minVerified` verified snapshots always remain. */
export function planRetention(entries, { keep = 12, minVerified = 3 } = {}) {
  const ours = entries.filter((e) => parseSnapshotName(e.name)).sort((a, b) => (a.name < b.name ? 1 : -1)); // newest first
  const verified = ours.filter((e) => e.verified);
  const prunable = verified.filter((e) => ["periodic", "on-exit"].includes(parseSnapshotName(e.name).kind));
  const keepSet = new Set(prunable.slice(0, keep).map((e) => e.name));
  const remove = [];
  let remaining = verified.length;
  for (const e of prunable.slice(keep).reverse()) { // oldest first
    if (remaining <= minVerified) break;
    if (keepSet.has(e.name)) continue;
    remove.push(e.name); remaining -= 1;
  }
  return { remove, keep: ours.map((e) => e.name).filter((n) => !remove.includes(n)) };
}

/* Compare two data manifests (live vs export, or export vs restored). */
export function compareManifests(a, b) {
  const diffs = [];
  if (a.firestore.docs !== b.firestore.docs) diffs.push(`Firestore documents ${a.firestore.docs} vs ${b.firestore.docs}`);
  for (const k of new Set([...Object.keys(a.firestore.byCollection || {}), ...Object.keys(b.firestore.byCollection || {})]))
    if ((a.firestore.byCollection || {})[k] !== (b.firestore.byCollection || {})[k]) diffs.push(`${k}: ${(a.firestore.byCollection || {})[k] || 0} vs ${(b.firestore.byCollection || {})[k] || 0}`);
  if (a.firestore.digest !== b.firestore.digest) diffs.push("Firestore content digest differs");
  if (a.auth.users !== b.auth.users) diffs.push(`Auth users ${a.auth.users} vs ${b.auth.users}`);
  if (a.storage.objects !== b.storage.objects) diffs.push(`Storage objects ${a.storage.objects} vs ${b.storage.objects}`);
  if (a.storage.digest !== b.storage.digest) diffs.push("Storage content digest differs");
  return diffs;
}
