/* ===================================================================
   Import tasks from a CSV file into Firestore.

   Usage:
     node scripts/import-csv.js [path]        # default: production-tasks.csv

   By default it targets the LOCAL emulator (same as the seed script). To
   import into PRODUCTION instead, the simplest path is the in-app importer
   (Admin → Import) which needs no service-account credentials.

   Owners / crew that don't match an existing user are imported as "Pending"
   with the original name kept as a suggestion (see rowToTask in src/data.js).
   =================================================================== */
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { parseCSV, rowToTask } from "../src/data.js";

const FILE = process.argv[2] || "production-tasks.csv";
initializeApp({ projectId: "ifc-social-media-tracker" });
const db = getFirestore();

async function main() {
  // Current roster — used to resolve owner/crew names to real accounts.
  const users = (await db.collection("users").get()).docs.map((d) => {
    const u = d.data();
    return { name: u.name, skills: u.skills || [], location: u.location || [],
             deprioritize: !!u.deprioritize, limited: !!u.limited, manualSchedule: !!u.manualSchedule };
  });

  const rows = parseCSV(readFileSync(FILE, "utf8"));
  let imported = 0, skipped = 0;
  for (const r of rows) {
    const { task, error } = rowToTask(r, users);
    if (error) { skipped++; continue; }
    await db.collection("tasks").add({
      ...task, comments: [], reactions: {},
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    imported++;
  }
  console.log(`✓ Imported ${imported} task(s) from ${FILE}${skipped ? ` (${skipped} skipped)` : ""}`);
  process.exit(0);
}

main().catch((e) => { console.error("Import failed:", e.message); process.exit(1); });
