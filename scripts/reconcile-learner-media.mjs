#!/usr/bin/env node
/* Learner image access markers — drift check and repair.

   Compares every academyLearnerMedia marker with the published courses and
   resources (and the hidden-category list) and reports:
     missing — a learner-visible item without a marker (its images stay hidden)
     stale   — a marker whose item is no longer learner-visible (its images are
               STILL readable by approved learners: a revocation that didn't land)

   READ-ONLY by default. --apply re-syncs exactly the reported items through
   the same transactional sync the triggers use.

   usage:
     node scripts/reconcile-learner-media.mjs --project <id> [--apply]
   Emulator: set FIRESTORE_EMULATOR_HOST. Production: Application Default
   Credentials of an account allowed to read (and, with --apply, write)
   Firestore. Exit code 0 = no drift, 2 = drift found (after --apply: drift
   that remained), 1 = error. Prints counts and marker ids only — no content. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const project = args[args.indexOf("--project") + 1];
const apply = args.includes("--apply");
if (args.indexOf("--project") < 0 || !project || project.startsWith("--")) {
  console.error("usage: node scripts/reconcile-learner-media.mjs --project <id> [--apply]");
  process.exit(1);
}
process.env.GCLOUD_PROJECT = project;
process.env.GOOGLE_CLOUD_PROJECT = project;
const here = path.dirname(fileURLToPath(import.meta.url));
const { reconcileLearnerMedia } = createRequire(import.meta.url)(path.join(here, "..", "functions", "academyLearnerMedia.js"));

try {
  const where = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : "PRODUCTION";
  console.log(`learner-media reconcile: project ${project} (${where}) — ${apply ? "APPLY" : "dry run, read-only"}`);
  const r = await reconcileLearnerMedia(undefined, { apply });
  console.log(JSON.stringify({ visibleItems: r.visibleItems, markers: r.markers, missing: r.missing, stale: r.stale, repaired: r.repaired }, null, 2));
  if (apply && (r.missing.length || r.stale.length)) {
    const again = await reconcileLearnerMedia(undefined, { apply: false });
    console.log(`after repair: missing ${again.missing.length}, stale ${again.stale.length}`);
    process.exit(again.missing.length || again.stale.length ? 2 : 0);
  }
  process.exit(r.missing.length || r.stale.length ? 2 : 0);
} catch (e) {
  console.error("reconcile failed:", e?.message || e);
  process.exit(1);
}
