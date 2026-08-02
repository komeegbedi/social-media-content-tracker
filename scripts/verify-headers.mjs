/* Verify the ACTUAL Cache-Control headers Firebase Hosting emits — because the
   catch-all `**` rule and the `/assets/**` rule both match assets, and Firebase
   resolves overlapping header rules in definition order (later wins). We don't
   assume; we assert against the running Hosting emulator.

   Usage (builds dist first is the caller's job):
     firebase emulators:exec --only hosting "node scripts/verify-headers.mjs"
   or standalone against an already-running emulator:
     HOSTING_ORIGIN=http://127.0.0.1:5000 node scripts/verify-headers.mjs

   Ref: https://firebase.google.com/docs/hosting/full-config#headers */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const NO_CACHE = "no-cache, max-age=0, must-revalidate";
const IMMUTABLE = "public, max-age=31536000, immutable";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Keep the port coupled to firebase.json so the two never drift.
const hostingPort = JSON.parse(readFileSync(join(root, "firebase.json"), "utf8"))?.emulators?.hosting?.port || 5000;
const ORIGIN = process.env.HOSTING_ORIGIN || `http://127.0.0.1:${hostingPort}`;
const distAssets = join(root, "dist", "assets");
if (!existsSync(distAssets)) {
  console.error("✗ dist/assets not found — run `npm run build` before verifying headers.");
  process.exit(1);
}

// Discover the real content-hashed asset filenames (they change every build).
const files = readdirSync(distAssets);
const hashedJs = files.find((f) => /^index-.*\.js$/.test(f)) || files.find((f) => f.endsWith(".js"));
const hashedCss = files.find((f) => f.endsWith(".css"));

// Each check: [label, path, expected exact Cache-Control].
const checks = [
  ["root /", "/", NO_CACHE],
  ["/index.html", "/index.html", NO_CACHE],
  ["SPA deep link /board", "/board", NO_CACHE],
  ["service worker", "/firebase-messaging-sw.js", NO_CACHE],
  ["hashed JS", `/assets/${hashedJs}`, IMMUTABLE],
  ...(hashedCss ? [["hashed CSS", `/assets/${hashedCss}`, IMMUTABLE]] : []),
];

async function raw(path) {
  const res = await fetch(ORIGIN + path, { redirect: "manual" });
  // Node's fetch joins repeated headers with ", " — so a value carrying BOTH
  // directives means two conflicting rules were applied. We assert exact equality
  // below, which also catches that case.
  return { status: res.status, cc: res.headers.get("cache-control") };
}

let failed = 0;
console.log(`Verifying Hosting headers at ${ORIGIN}\n`);
for (const [label, path, expected] of checks) {
  let got;
  try { got = await raw(path); }
  catch (e) { console.error(`✗ ${label} (${path}) — request failed: ${e.message}`); failed++; continue; }
  const ok = got.cc === expected;
  // Assets must not carry two conflicting Cache-Control values.
  const conflict = expected === IMMUTABLE && /no-cache/.test(got.cc || "");
  if (ok && !conflict) {
    console.log(`✓ ${label.padEnd(22)} ${path}\n    Cache-Control: ${got.cc}`);
  } else {
    console.error(`✗ ${label.padEnd(22)} ${path}\n    expected: ${expected}\n    got:      ${got.cc}${conflict ? "  ← conflicting rules applied" : ""}`);
    failed++;
  }
}

console.log("");
if (failed) { console.error(`Header verification FAILED: ${failed} check(s) wrong.`); process.exit(1); }
console.log("All header checks passed.");
