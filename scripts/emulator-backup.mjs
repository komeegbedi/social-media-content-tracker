#!/usr/bin/env node
/* Verified, never-overwritten emulator snapshots (see docs/local-data-safety.md).

   node scripts/emulator-backup.mjs snapshot --config <firebase.json> --project <id> --bucket <bucket>
        --firestore 127.0.0.1:8080 --auth 127.0.0.1:9099 --storage 127.0.0.1:9199
        --dest <folder under the backup root> [--kind periodic|on-exit|manual|pre-restart] [--verify] [--keep 12]
   node scripts/emulator-backup.mjs verify <export folder> --project <id> --bucket <bucket>
   node scripts/emulator-backup.mjs manifest --project <id> --bucket <bucket>   (emulator hosts from env)

   snapshot: fingerprints the LIVE data, exports into a NEW folder <stamp>-<kind>.partial,
   renames it when the export is complete, writes manifest-live.json, optionally restores it
   into a separate throwaway emulator on its own ports and compares (verify.json), then prunes
   only verified, tool-named periodic/on-exit snapshots beyond --keep (planRetention).
   Nothing is ever overwritten. Read-only toward the running emulators (export only). */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { backupRoot, assertSafeBackupRoot, snapshotName, parseSnapshotName, planRetention, compareManifests, isInside } from "./emulatorBackup.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIREBASE = path.join(REPO, "node_modules", ".bin", "firebase");
// Restore-verification ports: distinct from dev (8080/9099/9199/5001/4400…), the test runner
// (84xx/94xx/54xx: 8460…) and the isolated review set (8390/9590/9690/4430).
export const VERIFY_PORTS = { hub: 4470, logging: 4570, firestore: 8470, firestoreWs: 9474, auth: 9471, storage: 9472 };

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; out[k] = v; } else out._.push(a); }
  return out;
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/* ---- manifest (runs with FIRESTORE_EMULATOR_HOST etc. set) -------------------------- */
async function manifest({ project, bucket }) {
  const req = createRequire(path.join(REPO, "package.json"));
  const { initializeApp } = req("firebase-admin/app"); const { getFirestore } = req("firebase-admin/firestore");
  const { getAuth } = req("firebase-admin/auth"); const { getStorage } = req("firebase-admin/storage");
  initializeApp({ projectId: project, storageBucket: bucket });
  const db = getFirestore(); const docs = []; const seen = new Set();
  const canon = (v) => { if (v && typeof v.toDate === "function") return { __ts: v.toDate().toISOString() }; if (v && v.constructor && v.constructor.name === "DocumentReference") return { __ref: v.path };
    if (Array.isArray(v)) return v.map(canon); if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])); return v; };
  async function walk(col) {
    for (const d of (await col.get()).docs) { if (!seen.has(d.ref.path)) { seen.add(d.ref.path); docs.push([d.ref.path, JSON.stringify(canon(d.data()))]); } for (const sub of await d.ref.listCollections()) await walk(sub); }
    for (const r of await col.listDocuments()) if (!seen.has(r.path)) for (const sub of await r.listCollections()) await walk(sub);
  }
  for (const c of await db.listCollections()) await walk(c);
  docs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const byCollection = {}; for (const [p] of docs) { const top = p.split("/")[0]; byCollection[top] = (byCollection[top] || 0) + 1; }
  const users = []; let token;
  do { const r = await getAuth().listUsers(1000, token); users.push(...r.users.map((u) => `${u.uid}|${u.email || ""}|${u.providerData.map((p) => p.providerId).join(",")}`)); token = r.pageToken; } while (token);
  users.sort();
  let files = [];
  try { [files] = await getStorage().bucket().getFiles(); } catch (e) { if (!/not found|404/i.test(String(e.message))) throw e; }
  const objs = files.map((f) => `${f.name}|${f.metadata.md5Hash || ""}|${f.metadata.size || 0}`).sort();
  return {
    project, bucket, at: new Date().toISOString(),
    firestore: { docs: docs.length, byCollection, digest: sha(docs.map((d) => d.join("\t")).join("\n")) },
    auth: { users: users.length, digest: sha(users.join("\n")) },
    storage: { objects: objs.length, bytes: files.reduce((n, f) => n + Number(f.metadata.size || 0), 0), digest: sha(objs.join("\n")) },
  };
}
/* run `manifest` in a child process pointed at the given emulator hosts */
function manifestOf({ project, bucket, firestore, auth, storage }) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "manifest", "--project", project, "--bucket", bucket], {
    encoding: "utf8", env: { ...process.env, FIRESTORE_EMULATOR_HOST: firestore, FIREBASE_AUTH_EMULATOR_HOST: auth, FIREBASE_STORAGE_EMULATOR_HOST: storage }, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`manifest failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

/* ---- restore verification in a separate throwaway emulator ---------------------------- */
async function verify(dir, { project, bucket }) {
  // With manifest-live.json (a snapshot of running emulators): restore and compare.
  // Without it (a shutdown export — the emulators were already gone): a RESTORE CHECK —
  // the export must load into a throwaway emulator; what it contains is recorded.
  const liveFile = path.join(dir, "manifest-live.json");
  const live = fs.existsSync(liveFile) ? JSON.parse(fs.readFileSync(liveFile, "utf8")) : null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ifcverify-"));        // temporary work only (never the backup)
  for (const f of ["firestore.rules", "storage.rules"]) fs.symlinkSync(path.join(REPO, f), path.join(work, f));
  const h = "127.0.0.1", P = VERIFY_PORTS;
  fs.writeFileSync(path.join(work, "firebase.json"), JSON.stringify({ firestore: { rules: "firestore.rules" }, storage: { rules: "storage.rules" },
    emulators: { hub: { host: h, port: P.hub }, logging: { host: h, port: P.logging }, firestore: { host: h, port: P.firestore, websocketPort: P.firestoreWs },
      auth: { host: h, port: P.auth }, storage: { host: h, port: P.storage }, ui: { enabled: false }, singleProjectMode: true } }, null, 2));
  const child = spawn(FIREBASE, ["emulators:start", "--config", path.join(work, "firebase.json"), "--project", project, "--only", "firestore,auth,storage", "--import", dir],
    { cwd: work, env: { ...process.env, TMPDIR: work }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (b) => { log += b; }); child.stderr.on("data", (b) => { log += b; });
  const ready = await new Promise((res) => { const t = setInterval(() => { if (/All emulators ready/.test(log)) { clearInterval(t); res(true); } if (child.exitCode !== null) { clearInterval(t); res(false); } }, 300); setTimeout(() => { clearInterval(t); res(false); }, 180000); });
  let result;
  try {
    if (!ready) throw new Error(`verify emulators didn't start:\n${log.slice(-2000)}`);
    const restored = manifestOf({ project, bucket, firestore: `${h}:${P.firestore}`, auth: `${h}:${P.auth}`, storage: `${h}:${P.storage}` });
    if (live) { const diffs = compareManifests(live, restored); result = { ok: diffs.length === 0, mode: "compare", diffs, restored, at: new Date().toISOString() }; }
    else { fs.writeFileSync(path.join(dir, "manifest-restored.json"), JSON.stringify(restored, null, 2)); result = { ok: true, mode: "restore-check", diffs: [], restored, at: new Date().toISOString() }; }
  } catch (e) { result = { ok: false, diffs: [String(e.message || e)], at: new Date().toISOString() }; }
  finally {
    child.kill("SIGINT");
    await new Promise((res) => { if (child.exitCode !== null) return res(); child.on("exit", res); setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } res(); }, 30000); });
    fs.rmSync(work, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(dir, "verify.json"), JSON.stringify(result, null, 2));
  return result;
}

/* ---- snapshot -------------------------------------------------------------------------- */
async function snapshot(o) {
  const root = assertSafeBackupRoot(backupRoot(), REPO);
  const dest = path.resolve(o.dest);
  if (!isInside(dest, root)) throw new Error(`--dest ${dest} must be inside the backup root ${root}`);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const name = snapshotName(o.kind || "manual");
  const final = path.join(dest, name), partial = `${final}.partial`;
  if (fs.existsSync(final) || fs.existsSync(partial)) throw new Error(`refusing to overwrite ${final}`);
  const live = manifestOf(o);
  const r = spawnSync(FIREBASE, ["emulators:export", partial, "--config", path.resolve(o.config), "--project", o.project], { encoding: "utf8", cwd: path.dirname(path.resolve(o.config)), env: { ...process.env, TMPDIR: o.tmpdir || process.env.TMPDIR } });
  if (r.status !== 0 || !fs.existsSync(path.join(partial, "firebase-export-metadata.json"))) throw new Error(`export failed (folder left as ${partial}):\n${r.stdout}\n${r.stderr}`);
  fs.writeFileSync(path.join(partial, "manifest-live.json"), JSON.stringify(live, null, 2));
  fs.renameSync(partial, final);
  fs.chmodSync(final, 0o700);
  let v = null;
  if (o.verify) v = await verify(final, o);
  const entries = fs.readdirSync(dest).filter((n) => parseSnapshotName(n)).map((n) => {
    let verified = false; try { verified = JSON.parse(fs.readFileSync(path.join(dest, n, "verify.json"), "utf8")).ok === true; } catch { /* not verified */ }
    return { name: n, verified };
  });
  const plan = planRetention(entries, { keep: Number(o.keep || 12) });
  for (const n of plan.remove) { const p = path.join(dest, n); if (isInside(p, dest) && parseSnapshotName(n)) fs.rmSync(p, { recursive: true, force: true }); }
  return { snapshot: final, live, verified: v, pruned: plan.remove };
}

async function main() {
  const a = args(process.argv.slice(2)); const cmd = a._[0];
  if (cmd === "manifest") { console.log(JSON.stringify(await manifest({ project: a.project, bucket: a.bucket }))); return; }
  if (cmd === "verify") { const r = await verify(path.resolve(a._[1]), { project: a.project, bucket: a.bucket }); console.log(JSON.stringify({ ok: r.ok, diffs: r.diffs })); process.exitCode = r.ok ? 0 : 1; return; }
  if (cmd === "snapshot") {
    for (const k of ["config", "project", "bucket", "firestore", "auth", "storage", "dest"]) if (!a[k]) throw new Error(`--${k} is required`);
    const r = await snapshot(a);
    console.log(JSON.stringify({ snapshot: r.snapshot, docs: r.live.firestore.docs, users: r.live.auth.users, objects: r.live.storage.objects, verified: r.verified ? r.verified.ok : "not run", diffs: r.verified ? r.verified.diffs : [], pruned: r.pruned }));
    if (r.verified && !r.verified.ok) process.exitCode = 1;
    return;
  }
  throw new Error("usage: emulator-backup.mjs snapshot|verify|manifest …");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
