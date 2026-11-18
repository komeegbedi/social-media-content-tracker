#!/usr/bin/env node
/* Assemble a Hosting release that also serves the previous releases' hashed assets.

   A tab opened before a release keeps running the old build and lazily loads that
   build's chunks (/assets/<name>-<hash>.js) later — e.g. the Functions SDK the first
   time a video link is checked. Hosting serves only the files of the current deploy,
   so without this an old tab gets a 404 for them (and the app's "newer version"
   notice). Copying the previous release(s)' assets into the new build lets old tabs
   keep working until they reload.

   BOUNDED: sources must be the CLEAN ORIGINAL builds of earlier releases, each proven
   byte-for-byte against the SHA256SUMS recorded when that release was built — never an
   assembled deploy folder (which would carry its own carried-over files forward, release
   after release). At most --keep (default 2) earlier releases are retained. The result
   is described in <dist>.release-manifest.json — BESIDE the release folder, so it is
   never deployed.

   SAFE: only files missing from the new build are copied; a same-named file must be
   byte-identical; nothing outside assets/ is copied (index.html always comes from the
   new build); the new build must itself be clean.

   usage:
     node scripts/carry-over-assets.mjs --dist <new clean build> --release <label> [--commit <sha>]
       --from <label>:<clean build dir>:<its SHA256SUMS file>   (repeat, newest first; ≤ --keep)
       [--keep 2] [--dry-run]
   SHA256SUMS format: `shasum -a 256` lines with paths relative to the build ("./assets/…"). */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const MANIFEST = ".release-manifest.json";            // legacy in-folder name (refused as a source)
export const manifestPathFor = (dist) => `${path.resolve(dist)}.release-manifest.json`;
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const ENTRY = /\/assets\/(index-[\w-]+\.js)/;
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  });
}
/* A clean original build: index.html names exactly one entry, that entry is the only
   entry-shaped file in assets/, and there is no release manifest (not an assembled folder). */
export function cleanBuildInfo(dir) {
  const html = path.join(dir, "index.html"), assets = path.join(dir, "assets");
  if (!fs.existsSync(html) || !fs.existsSync(assets)) throw new Error(`${dir} is not a build (index.html + assets/ expected)`);
  if (fs.existsSync(path.join(dir, MANIFEST)) || fs.existsSync(manifestPathFor(dir))) throw new Error(`${dir} is an ASSEMBLED release (it has a release manifest); use that release's clean original build`);
  const entry = (fs.readFileSync(html, "utf8").match(ENTRY) || [])[1];
  if (!entry) throw new Error(`${dir}/index.html names no /assets/index-*.js entry`);
  const entries = fs.readdirSync(assets).filter((n) => /^index-[\w-]+\.js$/.test(n));
  if (entries.length !== 1 || entries[0] !== entry) throw new Error(`${dir} is not a clean build: entry files ${entries.join(", ")} (index.html names ${entry})`);
  return { entry, assets: fs.readdirSync(assets).filter((n) => fs.statSync(path.join(assets, n)).isFile()).sort() };
}
/* Every file of `dir` must match the recorded sums exactly (same set, same bytes). */
export function verifySums(dir, sumsFile) {
  const rec = new Map(fs.readFileSync(sumsFile, "utf8").split("\n").filter(Boolean).map((l) => {
    const m = l.match(/^([0-9a-f]{64})\s+\*?(?:\.\/)?(.+)$/); if (!m) throw new Error(`bad line in ${sumsFile}: ${l}`); return [m[2], m[1]];
  }));
  const files = walk(dir).filter((f) => !f.split("/").some((seg) => seg.startsWith(".")));
  const extra = files.filter((f) => !rec.has(f)), missing = [...rec.keys()].filter((f) => !files.includes(f));
  if (extra.length || missing.length) throw new Error(`${dir} differs from ${path.basename(sumsFile)}: extra ${extra.join(", ") || "none"}; missing ${missing.join(", ") || "none"}`);
  for (const f of files) if (sha(path.join(dir, f)) !== rec.get(f)) throw new Error(`${dir}/${f} doesn't match ${path.basename(sumsFile)}`);
  return files.length;
}

export function assembleRelease({ dist, release, commit = "", from = [], keep = 2, dryRun = false }) {
  if (!release) throw new Error("--release <label> is required");
  if (from.length > keep) throw new Error(`at most ${keep} earlier releases may be retained (got ${from.length})`);
  const cur = cleanBuildInfo(dist);
  const dst = path.join(dist, "assets");
  const manifest = { createdAt: new Date().toISOString(), keep,
    release: { label: release, commit, entry: cur.entry, files: cur.assets.map((n) => ({ name: n, sha256: sha(path.join(dst, n)) })) }, retained: [] };
  const seen = new Set();
  for (const src of from) {
    if (!src.label || !src.dir || !src.sums) throw new Error("each --from needs <label>:<dir>:<SHA256SUMS>");
    const info = cleanBuildInfo(src.dir);
    if (info.entry === cur.entry || seen.has(info.entry)) throw new Error(`${src.dir} (${info.entry}) duplicates another build in this release`);
    seen.add(info.entry);
    verifySums(src.dir, src.sums);
    const files = [];
    for (const n of info.assets) {
      const a = path.join(src.dir, "assets", n), b = path.join(dst, n), h = sha(a);
      if (fs.existsSync(b)) {
        if (sha(b) !== h) throw new Error(`refusing: ${n} differs between ${src.label} and the new build`);
        files.push({ name: n, sha256: h, copied: false });
        continue;
      }
      if (!dryRun) fs.copyFileSync(a, b);
      files.push({ name: n, sha256: h, copied: true });
    }
    manifest.retained.push({ label: src.label, entry: info.entry, sums: path.basename(src.sums), files });
  }
  if (fs.existsSync(manifestPathFor(dist)) && !dryRun) throw new Error(`${manifestPathFor(dist)} exists: ${dist} was already assembled`);
  if (!dryRun) fs.writeFileSync(manifestPathFor(dist), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const vals = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
  try {
    const from = vals("--from").map((v) => { const [label, dir, sums] = String(v).split(":"); return { label, dir, sums }; });
    const m = assembleRelease({ dist: vals("--dist")[0] || "dist", release: vals("--release")[0], commit: vals("--commit")[0] || "",
      from, keep: Number(vals("--keep")[0] || 2), dryRun: args.includes("--dry-run") });
    console.log(`release ${m.release.label} (${m.release.entry}): ${m.release.files.length} own assets`);
    for (const r of m.retained) console.log(`  retained ${r.label} (${r.entry}): ${r.files.filter((f) => f.copied).length} copied, ${r.files.filter((f) => !f.copied).length} already identical`);
    console.log(args.includes("--dry-run") ? "dry run: nothing written" : `manifest → ${manifestPathFor(vals("--dist")[0] || "dist")}`);
  } catch (e) { console.error("assemble failed:", e.message); process.exit(1); }
}
