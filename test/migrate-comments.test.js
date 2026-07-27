/* Migration test — embedded task.comments[] → comments subcollection.
   Verifies dry-run writes nothing, apply preserves the embedded array and
   resolves authorship, and re-running is idempotent (no duplicates).

   Runs against a Firestore emulator (Admin SDK, rules bypassed):
     node --test test/migrate-comments.test.js         (vs a running emulator)
     npm run test:emulator                             (starts a throwaway one) */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// Point the Admin SDK at the emulator BEFORE it initialises.
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
const { initializeApp, deleteApp } = await import("firebase-admin/app");
const { getFirestore } = await import("firebase-admin/firestore");
const { migrateComments } = await import("../scripts/migrate-comments.js");

let app, db;
const PROJECT_ID = "migrate-test-" + Date.now();

before(async () => {
  app = initializeApp({ projectId: PROJECT_ID }, "migrate-" + Date.now());
  db = getFirestore(app);
  // Two users; "Ghost" authored a comment but no longer has an account.
  await db.collection("users").doc("u_ada").set({ name: "Ada Admin" });
  await db.collection("users").doc("u_bo").set({ name: "Bo Member" });
  // One task with three embedded comments (one from a departed author).
  await db.collection("tasks").doc("t1").set({
    title: "Sunday Reel",
    comments: [
      { who: "Ada Admin", txt: "kickoff", tm: 1000 },
      { who: "Bo Member", txt: "on it", tm: 2000 },
      { who: "Ghost", txt: "legacy note", tm: 3000 },
    ],
  });
  // A task with no comments must be ignored.
  await db.collection("tasks").doc("t2").set({ title: "No discussion" });
});
after(async () => { if (app) await deleteApp(app); });

const subCount = async () => (await db.collection("tasks").doc("t1").collection("comments").get()).size;

test("dry-run reports the work but writes nothing", async () => {
  const s = await migrateComments(db, { dryRun: true });
  assert.deepEqual(s, { tasksWithComments: 1, comments: 3, written: 0, dryRun: true });
  assert.equal(await subCount(), 0);   // nothing persisted
});

test("apply copies comments, resolves uid, and preserves the embedded array", async () => {
  const s = await migrateComments(db, { dryRun: false });
  assert.equal(s.written, 3);
  assert.equal(await subCount(), 3);

  const c0 = (await db.collection("tasks").doc("t1").collection("comments").doc("legacy-0").get()).data();
  assert.equal(c0.uid, "u_ada");                 // resolved from display name
  assert.equal(c0.who, "Ada Admin");
  assert.equal(c0.txt, "kickoff");
  assert.equal(c0.tm.toMillis(), 1000);          // original timestamp preserved
  assert.deepEqual(c0.mentions, []);

  const ghost = (await db.collection("tasks").doc("t1").collection("comments").doc("legacy-2").get()).data();
  assert.equal(ghost.uid, "");                   // departed author → empty uid, name still shown
  assert.equal(ghost.who, "Ghost");

  // Non-destructive: the embedded array is still there for the dual-read window.
  const task = (await db.collection("tasks").doc("t1").get()).data();
  assert.equal(task.comments.length, 3);
});

test("re-running is idempotent — no duplicates", async () => {
  await migrateComments(db, { dryRun: false });
  assert.equal(await subCount(), 3);             // still 3, not 6
});
