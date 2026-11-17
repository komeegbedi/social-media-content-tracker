#!/usr/bin/env node
/* Start the DEVELOPMENT emulators with durable, verified persistence
   (see docs/local-data-safety.md). Replaces bare `firebase emulators:start` for dev.

     node scripts/dev-emulators.mjs [--every 10] [--verify-every 6] [--keep 12] [--from <export folder>]

   • Loads the newest VERIFIED snapshot from <backup root>/dev-emulators/<project>/ (or --from).
   • Exports on orderly shutdown (Ctrl+C) into a NEW <stamp>-on-exit folder, then verifies it.
   • While running, takes a <stamp>-periodic snapshot every --every minutes (an abrupt restart
     skips the shutdown export); every --verify-every-th one is restored into a separate
     throwaway emulator and compared. Snapshots are never overwritten; only verified,
     tool-named periodic/on-exit snapshots beyond --keep are pruned (at least 3 verified stay).
   • The backup root defaults to ~/IFC-local-backups (IFC_BACKUP_ROOT to change it) and must be
     outside /tmp, the OS temp dir and the repository (checked). The Storage emulator's own
     temp files go in a private folder, never the backup root. */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { backupRoot, assertSafeBackupRoot, snapshotName, parseSnapshotName } from "./emulatorBackup.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIREBASE = path.join(REPO, "node_modules", ".bin", "firebase");
const BACKUP = path.join(REPO, "scripts", "emulator-backup.mjs");

const a = (() => { const o = {}; const v = process.argv.slice(2); for (let i = 0; i < v.length; i++) if (v[i].startsWith("--")) o[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith("--") ? v[++i] : true; return o; })();
const config = path.resolve(a.config || path.join(REPO, "firebase.json"));
const cfg = JSON.parse(fs.readFileSync(config, "utf8"));
const project = a.project || JSON.parse(fs.readFileSync(path.join(REPO, ".firebaserc"), "utf8")).projects.default;
const bucket = a.bucket || (() => { try { const m = fs.readFileSync(path.join(REPO, ".env"), "utf8").match(/^VITE_FIREBASE_STORAGE_BUCKET=(.+)$/m); if (m) return m[1].trim(); } catch { /* none */ } return `${project}.appspot.com`; })();
const host = (k, d) => `${(cfg.emulators && cfg.emulators[k] && cfg.emulators[k].host) || "127.0.0.1"}:${(cfg.emulators && cfg.emulators[k] && cfg.emulators[k].port) || d}`;
const H = { firestore: host("firestore", 8080), auth: host("auth", 9099), storage: host("storage", 9199) };

const root = assertSafeBackupRoot(backupRoot(), REPO);
const dir = path.join(root, "dev-emulators", project);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const verifiedOk = (p) => { try { return JSON.parse(fs.readFileSync(path.join(p, "verify.json"), "utf8")).ok === true; } catch { return false; } };
const complete = (p) => fs.existsSync(path.join(p, "firebase-export-metadata.json"));
const snaps = fs.readdirSync(dir).filter((n) => parseSnapshotName(n)).sort().reverse().map((n) => path.join(dir, n));
const from = a.from ? path.resolve(a.from) : snaps.find(verifiedOk) || null;
if (a.from && !complete(from)) throw new Error(`--from ${from} is not a complete export`);
if (!from) {
  const unverified = snaps.find(complete);
  if (unverified) console.warn(`dev-emulators: no VERIFIED snapshot in ${dir}; the newest complete one (${path.basename(unverified)}) is not verified. Verify it first:\n  node scripts/emulator-backup.mjs verify ${unverified} --project ${project} --bucket ${bucket}\nor pass --from explicitly. Starting with EMPTY data.`);
  else console.warn(`dev-emulators: no snapshot in ${dir}; starting with EMPTY data (the first periodic snapshot will capture it).`);
}
const onExit = path.join(dir, snapshotName("on-exit"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ifcdev-"));   // the emulators' own temp files
const startArgs = ["emulators:start", "--config", config, "--project", project, "--export-on-exit", onExit, ...(from ? ["--import", from] : [])];
console.log(`dev-emulators: ${project}  load: ${from ? path.basename(from) : "(empty)"}  on exit → ${path.basename(onExit)}  snapshots → ${dir}`);
const child = spawn(FIREBASE, startArgs, { cwd: REPO, stdio: "inherit", env: { ...process.env, TMPDIR: tmp } });

const every = Math.max(1, Number(a.every || 10)) * 60000, verifyEvery = Math.max(1, Number(a["verify-every"] || 6));
let n = 0, busy = false;
const timer = setInterval(() => {
  if (busy) return; busy = true; n += 1;
  const r = spawnSync(process.execPath, [BACKUP, "snapshot", "--config", config, "--project", project, "--bucket", bucket, "--firestore", H.firestore, "--auth", H.auth, "--storage", H.storage,
    "--dest", dir, "--kind", "periodic", "--keep", String(a.keep || 12), "--tmpdir", tmp, ...(n % verifyEvery === 0 ? ["--verify"] : [])], { encoding: "utf8", env: { ...process.env, TMPDIR: tmp } });
  console.log(`dev-emulators: periodic snapshot ${r.status === 0 ? "ok" : "FAILED"} ${(r.stdout || "").trim().split("\n").pop() || (r.stderr || "").trim().split("\n").pop()}`);
  busy = false;
}, every);

let stopping = false;
const stop = (sig) => { if (stopping) return; stopping = true; clearInterval(timer); console.log(`dev-emulators: ${sig}: exporting to ${path.basename(onExit)}…`); child.kill("SIGINT"); };
process.on("SIGINT", () => stop("SIGINT")); process.on("SIGTERM", () => stop("SIGTERM"));
child.on("exit", (code) => {
  clearInterval(timer);
  if (complete(onExit)) {
    // The emulators are gone, so there is no live fingerprint: restore-check it (it must load
    // into a separate throwaway emulator; its contents are recorded in manifest-restored.json).
    const v = spawnSync(process.execPath, [BACKUP, "verify", onExit, "--project", project, "--bucket", bucket], { encoding: "utf8" });
    console.log(`dev-emulators: shutdown export ${v.status === 0 ? "written and restore-checked" : "written but the restore check FAILED"}: ${onExit}`);
  } else console.warn(`dev-emulators: NO shutdown export at ${onExit} (abrupt stop?). The newest periodic snapshot is your restore point.`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left for the OS */ }
  process.exit(code == null ? 1 : code);
});
