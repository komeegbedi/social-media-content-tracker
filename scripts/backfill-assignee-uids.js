/* ===================================================================
   Backfill STABLE ASSIGNMENT IDENTITY on tasks (feature/assigned-team-workflow).

   Adds, from each task's existing owner/crew NAMES:
     • ownerUid          the owner's stable uid ("" when Pending/unresolved)
     • support[].uid     each crew member's uid (left absent when unresolved)
     • assigneeUids      authoritative deduped uid set READ BY firestore.rules

   Names are preserved for display + back-compat. This NEVER guesses: a duplicate
   display name or a name with no matching active user is LEFT UNRESOLVED and
   REPORTED — never silently mapped to the wrong person. Posted/history tasks and
   trashed tasks are still backfilled (identity is data, not workflow), but reported
   separately. Reuses withAssigneeUids() from src/data.js so the mapping logic is
   identical to the app.

   SAFE ROLLOUT: the rules keep a legacy owner-NAME fallback for tasks WITHOUT
   assigneeUids, so this backfill can run with zero downtime. Only once coverage is
   validated (0 unresolved on ACTIVE tasks) should the name fallback be removed.

   Usage:
     • Dry run (default, writes nothing):
         node scripts/backfill-assignee-uids.js               # emulator
         node scripts/backfill-assignee-uids.js --prod        # PRODUCTION (read-only)
     • Apply:
         node scripts/backfill-assignee-uids.js --write
         GOOGLE_APPLICATION_CREDENTIALS=... node scripts/backfill-assignee-uids.js --prod --write
   =================================================================== */
const PROD = process.argv.includes("--prod");
const WRITE = process.argv.includes("--write");
if (!PROD) process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { withAssigneeUids } from "../src/data.js";

const PROJECT_ID = "ifc-social-media-tracker";
initializeApp(PROD ? { credential: applicationDefault(), projectId: PROJECT_ID } : { projectId: PROJECT_ID });
const db = getFirestore();

const isActive = (t) => t.status !== "Posted" && !t.archivedAt && !t.deletedAt;
const changed = (a, b) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

async function run() {
  console.log(`\nAssignee-UID backfill — target: ${PROD ? "PRODUCTION" : "emulator"} · mode: ${WRITE ? "WRITE" : "DRY RUN"}\n`);

  const usersSnap = await db.collection("users").get();
  const users = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // Duplicate-name detection (for reporting; withAssigneeUids also refuses to map them).
  const nameCount = {};
  users.forEach((u) => { if (u.name) nameCount[u.name] = (nameCount[u.name] || 0) + 1; });
  const dupeNames = Object.keys(nameCount).filter((n) => nameCount[n] > 1);
  if (dupeNames.length) console.log(`⚠  Duplicate display names in the roster (never auto-mapped): ${dupeNames.join(", ")}\n`);

  const tasksSnap = await db.collection("tasks").get();
  let total = 0, wouldChange = 0, alreadyOk = 0, wrote = 0;
  const unresolvedActive = [];   // [{ taskId, title, role, name, reason }]
  const unresolvedHistory = [];

  for (const doc of tasksSnap.docs) {
    total++;
    const t = { id: doc.id, ...doc.data() };
    const { task: stamped, unresolved } = withAssigneeUids(t, users);
    const bucket = isActive(t) ? unresolvedActive : unresolvedHistory;
    unresolved.forEach((u) => bucket.push({ taskId: t.id, title: t.title || "(untitled)", ...u }));

    const needs = changed(t.ownerUid, stamped.ownerUid)
      || changed(t.assigneeUids, stamped.assigneeUids)
      || changed((t.support || []).map((s) => s && s.uid), (stamped.support || []).map((s) => s && s.uid));
    if (!needs) { alreadyOk++; continue; }
    wouldChange++;
    if (WRITE) {
      await doc.ref.update({
        ownerUid: stamped.ownerUid,
        support: stamped.support,
        assigneeUids: stamped.assigneeUids,
        updatedAt: FieldValue.serverTimestamp(),
      });
      wrote++;
    }
  }

  console.log(`Tasks scanned:        ${total}`);
  console.log(`Already backfilled:   ${alreadyOk}`);
  console.log(`${WRITE ? "Updated" : "Would update"}:        ${WRITE ? wrote : wouldChange}`);
  console.log(`\nUnresolved assignees on ACTIVE tasks (BLOCK UID-only rules): ${unresolvedActive.length}`);
  unresolvedActive.slice(0, 50).forEach((u) => console.log(`  • ${u.taskId}  "${u.title}"  ${u.role}: "${u.name}" (${u.reason})`));
  if (unresolvedActive.length > 50) console.log(`  … and ${unresolvedActive.length - 50} more`);
  console.log(`\nUnresolved assignees on history/trashed tasks (informational): ${unresolvedHistory.length}`);

  const coverageOk = unresolvedActive.length === 0;
  console.log(`\n${coverageOk ? "✅" : "⛔"} Coverage gate for UID-only rules: ${coverageOk
    ? "PASS — every ACTIVE task's assignees resolve to a uid. Safe to remove the legacy name fallback."
    : "FAIL — resolve the names above (fix duplicates / re-invite users), then re-run, BEFORE removing the fallback."}`);
  if (!WRITE) console.log(`\n(Dry run — nothing written. Re-run with --write to apply.)`);
  process.exit(0);
}
run().catch((e) => { console.error(e); process.exit(1); });
