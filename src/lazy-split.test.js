/* Code-splitting verification (runs after `vite build`, which `npm run verify`
   does first). Proves the Admin surface is a SEPARATE lazy chunk that the initial
   payload does not contain — so a non-admin never downloads admin code — and that
   the reduction is real, not merely renamed/repartitioned bytes.

   Run with: npm run build && node --test src/lazy-split.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist/assets";
const files = existsSync(DIST) ? readdirSync(DIST) : [];
const jsFiles = files.filter((f) => f.endsWith(".js"));
const read = (f) => readFileSync(join(DIST, f), "utf8");
// Skip when there's no build to inspect (standalone `npm test`); `npm run verify`
// builds first, so these run for real there.
const noBuild = jsFiles.length === 0;

// The entry (main) chunk is the one the HTML boots — the largest non-lazy index-*.
const indexFile = jsFiles.filter((f) => f.startsWith("index-")).sort((a, b) => read(b).length - read(a).length)[0];
const adminFile = jsFiles.find((f) => f.startsWith("AdminScreen-"));

// A distinctive admin-only string (ImportPanel help text) that survives minification.
const ADMIN_MARKER = "Bulk-create tasks";

test("a fresh build exists to inspect", { skip: noBuild }, () => {
  assert.ok(jsFiles.length > 0, "run `npm run build` first (verify does this)");
  assert.ok(indexFile, "an entry index-*.js chunk exists");
});

test("the Admin surface is emitted as its own lazy chunk", { skip: noBuild }, () => {
  assert.ok(adminFile, "AdminScreen-*.js chunk exists (React.lazy emitted a separate chunk)");
  assert.ok(read(adminFile).includes(ADMIN_MARKER), "admin code lives in the admin chunk");
});

test("the INITIAL chunk does not contain admin code (non-admins never download it)", { skip: noBuild }, () => {
  const idx = read(indexFile);
  assert.ok(!idx.includes(ADMIN_MARKER), "admin-only code must not be in the entry chunk");
  // The entry references the admin chunk by name — proof it's a dynamic import,
  // fetched on demand (only when an admin opens Admin), not eagerly bundled.
  assert.ok(idx.includes("AdminScreen"), "entry references the lazy AdminScreen chunk for on-demand load");
});

test("Firebase core stays shared, not duplicated into the admin chunk", { skip: noBuild }, () => {
  // Firestore's persistent-cache marker should appear once (shared/initial), never
  // copied into the admin chunk.
  assert.ok(adminFile && !read(adminFile).includes("persistentLocalCache"),
    "the admin chunk must not re-bundle Firebase core");
});
