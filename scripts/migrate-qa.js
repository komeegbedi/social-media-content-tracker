/* ===================================================================
   Migrate QA reviewers to the QA department (one-time).

   QA is a distinct, non-production department. This normalises every existing
   QA user so they can never be staffed on production, WITHOUT touching any task
   data (assignments and history are preserved):

     • departments → ["QA"]
     • skills      → []              (skills are what make someone staffable)
     • available   → false           (never production-available)
     • captions / deprioritize / limited / manualSchedule → false

   It then REPORTS every task where a QA user is still listed as owner or crew,
   split into ACTIVE (needs an admin to reassign) vs ARCHIVED/COMPLETED (history —
   leave it). It never edits tasks: silently stripping a QA user from a live task
   could leave it ownerless or under-crewed.

   Usage:
     • Emulator:    npm run emulators   then   node scripts/migrate-qa.js
     • Production:  GOOGLE_APPLICATION_CREDENTIALS=... node scripts/migrate-qa.js --prod
                    (omit --prod and it targets the local emulator, like seed.js)
   =================================================================== */
const PROD = process.argv.includes("--prod");
if (!PROD) {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
}

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PROJECT_ID = "ifc-social-media-tracker";
initializeApp(PROD ? { credential: applicationDefault(), projectId: PROJECT_ID } : { projectId: PROJECT_ID });
const db = getFirestore();

const isQA = (u) => u && u.qa === true;
const isActive = (t) => t.status !== "Posted" && !t.archivedAt;

async function run() {
  console.log(`\nQA migration — target: ${PROD ? "PRODUCTION" : "emulator"}\n`);

  // 1. Normalise QA user docs.
  const usersSnap = await db.collection("users").get();
  const qaUsers = usersSnap.docs.filter((d) => isQA(d.data()));
  const qaNames = new Set(qaUsers.map((d) => d.data().name).filter(Boolean));

  let changed = 0;
  for (const doc of qaUsers) {
    const u = doc.data();
    const patch = {};
    if (JSON.stringify(u.departments || []) !== JSON.stringify(["QA"])) patch.departments = ["QA"];
    if ((u.skills || []).length) patch.skills = [];
    if (u.available !== false) patch.available = false;
    for (const flag of ["captions", "deprioritize", "limited", "manualSchedule"]) {
      if (u[flag]) patch[flag] = false;
    }
    if (Object.keys(patch).length) {
      await doc.ref.update(patch);
      changed++;
      console.log(`  normalised ${u.name || doc.id}: ${Object.keys(patch).join(", ")}`);
    }
  }
  console.log(`\n${qaUsers.length} QA user(s); ${changed} updated.\n`);

  if (!qaNames.size) { console.log("No QA users — nothing to report."); return; }

  // 2. Report tasks that still reference a QA user as owner or crew.
  const tasksSnap = await db.collection("tasks").get();
  const active = [], archived = [];
  for (const d of tasksSnap.docs) {
    const t = { id: d.id, ...d.data() };
    const roles = [];
    if (qaNames.has(t.owner)) roles.push("owner");
    for (const s of t.support || []) if (qaNames.has(s.name)) roles.push(s.role || "crew");
    if (roles.length) (isActive(t) ? active : archived).push({ id: t.id, title: t.title, status: t.status, roles });
  }

  const printGroup = (label, rows) => {
    console.log(`${label}: ${rows.length}`);
    rows.forEach((r) => console.log(`  • "${r.title}" [${r.status}] — QA user as ${r.roles.join(", ")}  (task ${r.id})`));
  };
  console.log("Tasks still listing a QA user:");
  printGroup("  ACTIVE — review & reassign", active);
  printGroup("  ARCHIVED/COMPLETED — history, leave as-is", archived);
  console.log("\nDone. No task data was modified.\n");
}

run().catch((e) => { console.error(e); process.exit(1); });
