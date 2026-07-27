/* ===================================================================
   Migrate embedded task comments → the canonical comments subcollection.

   Each `tasks/{id}.comments[]` entry is copied to a `tasks/{id}/comments/{docId}`
   document, PRESERVING its original author, text, and timestamp. The write is:

     • Non-destructive — the embedded `comments[]` array is left in place. The
       app merges both sources and dedupes (see mergeComments in src/data.js), so
       nothing double-renders. A separate cleanup pass removes the arrays only
       AFTER this migration is verified in production.
     • Idempotent — the subcollection doc id is deterministic (`legacy-<index>`),
       so re-running overwrites the same doc instead of creating duplicates.
     • Dry-run by default — it reports what it WOULD write and changes nothing
       unless you pass --apply.

   The embedded comments carry only a display name (`who`), no uid — legacy data
   predates authenticated authorship. We resolve a uid by matching `who` against
   current user display names where possible; unmatched authors get uid "" (the
   name still renders). New comments always carry the real uid (written client-side).

   Usage:
     • Dry-run (emulator):   node scripts/migrate-comments.js
     • Apply   (emulator):   node scripts/migrate-comments.js --apply
     • Apply   (production):  GOOGLE_APPLICATION_CREDENTIALS=... \
                               node scripts/migrate-comments.js --apply --prod
   =================================================================== */
import { Timestamp } from "firebase-admin/firestore";

// Build a display-name → uid lookup from the users collection. First writer wins
// on duplicate names (the ownerUid limitation is tracked separately); an unmatched
// name simply yields "".
async function nameToUid(db) {
  const snap = await db.collection("users").get();
  const map = new Map();
  snap.forEach((d) => {
    const n = d.get("name");
    if (n && !map.has(n)) map.set(n, d.id);
  });
  return map;
}

/* Core migration, testable against any Firestore handle (emulator or prod).
   Returns a summary; when dryRun is true it performs no writes. */
export async function migrateComments(db, { dryRun = true, log = () => {} } = {}) {
  const uidByName = await nameToUid(db);
  const tasksSnap = await db.collection("tasks").get();

  let tasksWithComments = 0, comments = 0, written = 0;
  for (const t of tasksSnap.docs) {
    const arr = t.get("comments");
    if (!Array.isArray(arr) || arr.length === 0) continue;
    tasksWithComments++;
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i] || {};
      comments++;
      const payload = {
        uid: c.uid || uidByName.get(c.who) || "",
        who: c.who || "",
        txt: c.txt || "",
        tm: Timestamp.fromMillis(Number(c.tm) || 0),   // preserve original time → dedupes vs. embedded
        mentions: [],
      };
      log(`  ${dryRun ? "would write" : "write"} tasks/${t.id}/comments/legacy-${i}  (${payload.who || "unknown"})`);
      if (dryRun) continue;
      await t.ref.collection("comments").doc(`legacy-${i}`).set(payload);   // deterministic id → idempotent
      written++;
    }
  }

  const summary = { tasksWithComments, comments, written, dryRun };
  log(`\n${dryRun ? "[dry-run] " : ""}${dryRun ? comments + " comment(s) would be migrated" : written + " comment(s) migrated"} across ${tasksWithComments} task(s).`);
  return summary;
}

/* ---- CLI wrapper (only when run directly, not when imported by a test) ---- */
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const dryRun = !process.argv.includes("--apply");
  const PROD = process.argv.includes("--prod");
  if (!PROD) process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

  const { initializeApp, applicationDefault } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const PROJECT_ID = "ifc-social-media-tracker";
  initializeApp(PROD ? { credential: applicationDefault(), projectId: PROJECT_ID } : { projectId: PROJECT_ID });

  console.log(`\nComment migration — target: ${PROD ? "PRODUCTION" : "emulator"}${dryRun ? " (dry-run)" : " (APPLY)"}\n`);
  const summary = await migrateComments(getFirestore(), { dryRun, log: (m) => console.log(m) });
  console.log("\n", summary);
  if (dryRun) console.log("\nNo changes written. Re-run with --apply to migrate.\n");
  process.exit(0);
}
