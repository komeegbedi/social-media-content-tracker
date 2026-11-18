/* Verify what Firebase Hosting ACTUALLY serves for a given release folder — headers,
   routing and bytes. We don't assume; we assert against a running Hosting (the
   emulator, a preview channel, or live).

   Usage:
     npm run test:headers                                    (builds dist, runs the Hosting emulator)
     VERIFY_DIST=<assembled release folder> HOSTING_ORIGIN=<https://…preview….web.app> node scripts/verify-headers.mjs
   VERIFY_DIST defaults to ./dist. When <VERIFY_DIST>.release-manifest.json exists
   (scripts/carry-over-assets.mjs), every RETAINED earlier-release asset is checked too.

   Checks
   • Cache-Control: HTML / routes / service worker no-cache; hashed assets immutable
     (the catch-all `**` rule and `/assets/**` both match assets; later rule wins).
   • "/" serves this folder's index.html byte-for-byte, naming THIS release's entry.
   • Every file in assets/ — this release's and the carried-over ones — is served 200 with
     the right content type and the same bytes as the folder.
   • A deliberately NONEXISTENT asset is a 404 (the "!/assets/**" rewrite), never index.html.
   • App deep links still get index.html; the release manifest itself is never served.

   Ref: https://firebase.google.com/docs/hosting/full-config */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname } from "node:path";

const NO_CACHE = "no-cache, max-age=0, must-revalidate";
const IMMUTABLE = "public, max-age=31536000, immutable";
const TYPE = { ".js": /^(text|application)\/javascript\b/, ".mjs": /^(text|application)\/javascript\b/, ".css": /^text\/css\b/, ".svg": /^image\/svg\+xml\b/,
  ".png": /^image\/png\b/, ".jpg": /^image\/jpeg\b/, ".webp": /^image\/webp\b/, ".woff2": /^font\/woff2\b/, ".json": /^application\/json\b/ };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(process.env.VERIFY_DIST || join(root, "dist"));
const hostingPort = JSON.parse(readFileSync(join(root, "firebase.json"), "utf8"))?.emulators?.hosting?.port || 5000;
const ORIGIN = (process.env.HOSTING_ORIGIN || `http://127.0.0.1:${hostingPort}`).replace(/\/$/, "");
if (!existsSync(join(DIST, "assets")) || !existsSync(join(DIST, "index.html"))) {
  console.error(`✗ ${DIST} is not a build — run \`npm run build\` (or point VERIFY_DIST at the assembled release).`);
  process.exit(1);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const localIndex = readFileSync(join(DIST, "index.html"));
const entry = (String(localIndex).match(/\/assets\/(index-[\w-]+\.js)/) || [])[1];
// the assembled release's manifest lives BESIDE the folder (never deployed); VERIFY_MANIFEST overrides
const manifestPath = process.env.VERIFY_MANIFEST || `${DIST}.release-manifest.json`;
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
if (manifest && manifest.release.entry !== entry) { console.error(`✗ manifest names ${manifest.release.entry}, index.html names ${entry}`); process.exit(1); }
const assets = readdirSync(join(DIST, "assets")).sort();
const retained = new Map((manifest?.retained || []).flatMap((r) => r.files.map((f) => [f.name, r.label])));
const ownCss = assets.find((f) => f.endsWith(".css") && !retained.has(f));

let failed = 0;
const pass = (label, detail) => console.log(`✓ ${label}${detail ? `\n    ${detail}` : ""}`);
const fail = (label, detail) => { console.error(`✗ ${label}${detail ? `\n    ${detail}` : ""}`); failed++; };
async function get(path) {
  const res = await fetch(ORIGIN + path, { redirect: "manual" });
  return { status: res.status, cc: res.headers.get("cache-control") || "", type: res.headers.get("content-type") || "", body: Buffer.from(await res.arrayBuffer()) };
}
console.log(`Verifying Hosting at ${ORIGIN}\n  release folder: ${DIST}\n  entry: ${entry}${manifest ? `\n  release ${manifest.release.label}; retained: ${manifest.retained.map((r) => `${r.label} (${r.entry})`).join(", ") || "none"}` : ""}\n`);

// 1. caching of HTML, routes and the service worker
for (const [label, path] of [["root /", "/"], ["/index.html", "/index.html"], ["SPA deep link /board", "/board"], ["service worker", "/firebase-messaging-sw.js"]]) {
  const r = await get(path);
  r.cc === NO_CACHE ? pass(`${label.padEnd(26)} ${path}`, `Cache-Control: ${r.cc}`) : fail(`${label.padEnd(26)} ${path}`, `expected ${NO_CACHE}\n    got:      ${r.cc}`);
}
// 2. the live index.html is THIS release's, naming THIS release's entry
{
  const r = await get("/");
  const served = (String(r.body).match(/\/assets\/(index-[\w-]+\.js)/) || [])[1];
  r.status === 200 && served === entry && sha(r.body) === sha(localIndex)
    ? pass("index.html is this release's", `names ${served}; bytes match the release folder`)
    : fail("index.html is this release's", `status ${r.status}; names ${served}; expected ${entry}; bytes ${sha(r.body) === sha(localIndex) ? "match" : "DIFFER"}`);
}
// 3. every asset — this release's and the retained earlier releases' — 200, type, bytes, immutable
let own = 0, kept = 0;
for (const name of assets) {
  const r = await get(`/assets/${name}`);
  const want = TYPE[extname(name)];
  const bytesOk = r.body.length && sha(r.body) === sha(readFileSync(join(DIST, "assets", name)));
  const ok = r.status === 200 && (!want || want.test(r.type)) && bytesOk && r.cc === IMMUTABLE && !/no-cache/.test(r.cc);
  const label = retained.has(name) ? `carried over (${retained.get(name)})` : "this release";
  if (ok) { retained.has(name) ? kept++ : own++; continue; }
  fail(`${label}: /assets/${name}`, `status ${r.status}; type ${r.type}; bytes ${bytesOk ? "match" : "DIFFER"}; Cache-Control ${r.cc}`);
}
pass(`assets served 200, right type, same bytes, immutable`, `${own} of this release${manifest ? `, ${kept} carried over` : ""} (of ${assets.length})`);
if (manifest) {
  const listed = manifest.retained.flatMap((r) => r.files.map((f) => f.name));
  const absent = listed.filter((n) => !assets.includes(n));
  absent.length ? fail("every retained file is in the folder", absent.join(", ")) : pass("every retained file is in the folder", `${listed.length} listed in the manifest`);
}
// 4. routing: a deliberately nonexistent asset is a real 404; app routes get index.html; the manifest isn't served
{
  const missing = `/assets/__verify-missing-${randomBytes(6).toString("hex")}.js`;
  const r = await get(missing);
  r.status === 404 && !(r.body.includes(Buffer.from(String(entry || "~")))) ? pass(`nonexistent asset → 404`, `${missing}`) : fail(`nonexistent asset → 404`, `${missing}: ${r.status} ${r.type}`);
}
for (const [label, path] of [["deep link /learn", "/learn"], ["deep link /learn/manage/course/x", "/learn/manage/course/x?item=l1"]]) {
  const r = await get(path);
  r.status === 200 && /text\/html/.test(r.type) && String(r.body).includes(`/assets/${entry}`) ? pass(`${label.padEnd(26)} ${path}`, `${r.status} ${r.type}`) : fail(`${label} ${path}`, `${r.status} ${r.type}`);
}
{
  const r = await get("/.release-manifest.json");
  !String(r.body).includes('"retained"') ? pass("release manifest not served", `${r.status} ${r.type}`) : fail("release manifest not served", "the manifest is publicly readable");
}

console.log("");
if (failed) { console.error(`Hosting verification FAILED: ${failed} check(s) wrong.`); process.exit(1); }
console.log("All Hosting checks passed.");
