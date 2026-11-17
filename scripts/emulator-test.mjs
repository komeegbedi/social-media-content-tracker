#!/usr/bin/env node
/* Run an emulator test suite in COMPLETE isolation from the development emulators.

     node scripts/emulator-test.mjs --project demo-x --only firestore[,storage,…] -- <command…>

   Each run gets its own folder under .emulator-test-tmp/<run>/ that is:
     • the working directory — every emulator writes its debug logs (firestore-debug.log,
       firebase-debug.log, …) to its CWD, so the dev emulator's logs are never overwritten;
     • TMPDIR — the Storage emulator keeps blobs in $TMPDIR/firebase/storage/blobs and DELETES
       that folder when it stops; a shared TMPDIR wipes the dev emulator's files;
     • the project directory: a generated firebase.json (the real one, with the emulators on
       TEST ports below and the UI off) and links to the repo's rules, indexes, functions and dist.
   The project must be a throwaway demo-* project, so nothing can reach real data.
   The command runs from the repo root with the emulator addresses exported by emulators:exec. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { assertSafeCleanupTarget } from "./emulatorBackup.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Test ports: none overlap the dev emulators (firebase.json) — checked in the runner below.
export const TEST_PORTS = { hub: 4460, logging: 4560, firestore: 8460, firestoreWs: 9460, auth: 9461, storage: 9462, functions: 5460,
  pubsub: 8461, eventarc: 9463, hosting: 5461, tasks: 9464 };

function parse(argv) {
  const i = argv.indexOf("--");
  if (i < 0) throw new Error("usage: emulator-test.mjs --project demo-x --only a,b -- <command>");
  const opts = {}; const head = argv.slice(0, i);
  for (let k = 0; k < head.length; k += 2) opts[head[k].replace(/^--/, "")] = head[k + 1];
  return { project: opts.project, only: opts.only, command: argv.slice(i + 1) };
}
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function main() {
  const { project, only, command } = parse(process.argv.slice(2));
  if (!/^demo-[a-z0-9-]+$/.test(project || "")) throw new Error(`--project must be a throwaway demo-* project (got "${project}")`);
  if (!only || !command.length) throw new Error("--only and a command are required");
  const base = JSON.parse(fs.readFileSync(path.join(REPO, "firebase.json"), "utf8"));
  const devPorts = new Set(Object.values(base.emulators || {}).map((e) => e && e.port).filter(Boolean).concat([4400, 4500, 9150]));
  for (const p of Object.values(TEST_PORTS)) if (devPorts.has(p)) throw new Error(`test port ${p} overlaps a dev emulator port`);

  const run = path.join(REPO, ".emulator-test-tmp", `${project}-${Date.now()}`);
  fs.mkdirSync(run, { recursive: true });
  // TMPDIR: a private folder created for this run (never the dev emulator's own TMPDIR) and
  // SHORT — the Functions emulator binds a Unix socket in it, and macOS caps socket paths at
  // 104 characters (a long path fails with EADDRINUSE).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ifcemu-"));
  for (const f of ["firestore.rules", "firestore.indexes.json", "storage.rules", "dist"]) {
    const target = path.join(REPO, f); if (fs.existsSync(target)) fs.symlinkSync(target, path.join(run, f));
  }
  // functions/: a folder of links to the real source (nothing is written into the repo's
  // functions/) plus a TEST-ONLY .secret.local: functions that declare secrets (e.g. the
  // Resend key) don't run in the emulator without a value, and a demo project can't read
  // Secret Manager. The emulator never sends email (EMAIL_FORCE_SEND is removed below).
  const fsrc = path.join(REPO, "functions"), fdst = path.join(run, "functions");
  fs.mkdirSync(fdst);
  for (const e of fs.readdirSync(fsrc)) if (!/^\.secret\.local$|^\.env\.local$/.test(e)) fs.symlinkSync(path.join(fsrc, e), path.join(fdst, e));
  const secrets = new Set();
  for (const e of fs.readdirSync(fsrc)) if (e.endsWith(".js")) for (const m of fs.readFileSync(path.join(fsrc, e), "utf8").matchAll(/defineSecret\("([A-Z0-9_]+)"\)/g)) secrets.add(m[1]);
  fs.writeFileSync(path.join(fdst, ".secret.local"), [...secrets].map((k) => `${k}=emulator-test-dummy`).join("\n") + "\n");
  const h = "127.0.0.1", P = TEST_PORTS;
  const cfg = { ...base, emulators: {
    hub: { host: h, port: P.hub }, logging: { host: h, port: P.logging }, firestore: { host: h, port: P.firestore, websocketPort: P.firestoreWs },
    auth: { host: h, port: P.auth }, storage: { host: h, port: P.storage }, functions: { host: h, port: P.functions }, pubsub: { host: h, port: P.pubsub },
    eventarc: { host: h, port: P.eventarc }, hosting: { host: h, port: P.hosting }, tasks: { host: h, port: P.tasks },
    ui: { enabled: false }, singleProjectMode: true } };
  fs.writeFileSync(path.join(run, "firebase.json"), JSON.stringify(cfg, null, 2));

  const inner = `cd ${shq(REPO)} && ${command.map(shq).join(" ")}`;
  console.log(`emulator-test: ${project} [${only}] in ${path.relative(REPO, run)} (ports ${P.firestore}/${P.storage}/${P.functions}/${P.hosting})`);
  const r = spawnSync(path.join(REPO, "node_modules", ".bin", "firebase"),
    ["emulators:exec", "--config", path.join(run, "firebase.json"), "--project", project, "--only", only, inner],
    { cwd: run, stdio: "inherit", env: (() => { const env = { ...process.env, TMPDIR: tmp, HOSTING_ORIGIN: `http://${h}:${P.hosting}` }; delete env.EMAIL_FORCE_SEND; return env; })() });
  // only the folder this run created — never anything overlapping the backup root (checked)
  try { fs.rmSync(assertSafeCleanupTarget(tmp), { recursive: true, force: true }); } catch (e) { console.warn(`emulator-test: left ${tmp}: ${e.message}`); }
  process.exit(r.status == null ? 1 : r.status);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
