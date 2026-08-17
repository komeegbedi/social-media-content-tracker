/* Assigned-team workflow — backend integration (emulator).
   Proves: bulk/auto (re)assignment maintains the authoritative assigneeUids set;
   user-removal detachment maintains ownerUid + assigneeUids; and concurrent
   workflow advances (the client's advanceTask transaction pattern) never lose or
   duplicate activity history.

     node --test test/assigned-workflow.test.js   (vs a running emulator)
     npm run test:emulator                          (throwaway emulator) */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-assigned-workflow-test";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db, FieldValue } = await import("../functions/lib.js");
const { bulkAssignCore } = await import("../functions/bulkAssign.js");
const { detachTasks } = await import("../functions/taskDetach.js");
// The SHARED transition core the client's advanceTask runs — driven here inside an
// Admin SDK transaction so this test exercises the SAME idempotent/stale/append
// decision the production code path uses (no simulated note-append stand-in).
const { planTransition, workflowCapability } = await import("../src/workflowTransition.js");

const tasks = () => db.collection("tasks");
const get = (id) => tasks().doc(id).get().then((s) => (s.exists ? s.data() : null));
async function wipe(coll) { const s = await db.collection(coll).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }

beforeEach(async () => {
  await Promise.all(["tasks", "users", "adminOps"].map(wipe));
  await db.collection("users").doc("admin1").set({ role: "admin", status: "approved", name: "Ada" });
  await db.collection("users").doc("bo").set({ role: "member", status: "approved", name: "Bo Crew" });
});

test("bulkAssign maintains the authoritative assigneeUids (owner uid + new crew uids)", async () => {
  await tasks().doc("t1").set({ status: "Planned", owner: "Otis", ownerUid: "own", support: [], assigneeUids: ["own"] });
  const r = await bulkAssignCore({ database: db, callerUid: "admin1", opId: "op1",
    assignments: [{ taskId: "t1", support: [{ name: "Bo Crew", uid: "bo", role: "shoot" }] }] });
  assert.equal(r.applied, 1);
  const t = await get("t1");
  assert.deepEqual(t.assigneeUids.sort(), ["bo", "own"]);   // owner uid + crew uid
});

test("user-removal detachment maintains ownerUid + assigneeUids (reassign)", async () => {
  await tasks().doc("t2").set({ owner: "Gone", ownerUid: "gone", status: "In Progress",
    support: [{ name: "Bo Crew", uid: "bo", role: "edit" }], assigneeUids: ["gone", "bo"] });
  const opRef = db.collection("adminOps").doc("rm1");
  await opRef.set({ type: "user_removal", phase: "tokens_cleared" });
  await detachTasks({ db, opRef, userName: "Gone", mode: "reassign",
    resolvedTargetName: "Ada", removedUid: "gone", resolvedTargetUid: "admin1" });
  const t = await get("t2");
  assert.equal(t.owner, "Ada");
  assert.equal(t.ownerUid, "admin1");
  assert.deepEqual(t.assigneeUids.sort(), ["admin1", "bo"]);   // 'gone' gone, target added, crew kept
});

// Run the PRODUCTION transition core inside an Admin SDK transaction — the same
// shape as the client's advanceTask (re-read → planTransition → conditional write).
// Firestore retries the loser of a write race, which re-reads the winner's committed
// status; planTransition then returns an idempotent no-op, so exactly one workflow
// event is ever appended and no existing activity is lost.
const advance = (taskId, opts, actor) => db.runTransaction(async (tx) => {
  const ref = tasks().doc(taskId);
  const snap = await tx.get(ref);
  const plan = planTransition(snap.exists ? snap.data() : null, {
    ...opts, actor: { uid: actor.uid, name: actor.name, cap: workflowCapability(actor, opts.kind) },
  });
  if (!plan.ok || plan.idempotent) return plan;   // stale/gone/links or idempotent → NO write
  tx.update(ref, {
    ...plan.update,
    ...(plan.archive ? { archivedAt: FieldValue.serverTimestamp() } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});
const otis = { uid: "own", name: "Otis", role: "member" };
const boCrew = { uid: "bo", name: "Bo Crew", role: "member" };

test("CONCURRENT Planned → In Progress: one 'started' event, loser is an idempotent no-op", async () => {
  await tasks().doc("t3").set({ status: "Planned", owner: "Otis", ownerUid: "own",
    assigneeUids: ["own", "bo"], activity: [{ type: "created", by: "Ada", at: 1 }] });

  // Two assigned users concurrently Start work (Planned → In Progress).
  const opts = { fromStatus: "Planned", toStatus: "In Progress", kind: "started" };
  const results = await Promise.all([advance("t3", opts, otis), advance("t3", opts, boCrew)]);

  const t = await get("t3");
  assert.equal(t.status, "In Progress", "final status is In Progress");
  const started = t.activity.filter((a) => a.type === "started");
  assert.equal(started.length, 1, "exactly one 'started' event");
  assert.ok(t.activity.some((a) => a.type === "created"), "the pre-existing 'created' event is preserved");
  assert.equal(t.activity.length, 2, "created + exactly one started — nothing lost or duplicated");
  // One op did the write; the other re-read In Progress and returned an idempotent success WITHOUT writing.
  assert.equal(results.filter((r) => r && r.idempotent).length, 1, "the losing/retried op is an idempotent success");
  assert.equal(results.filter((r) => r && r.ok && !r.idempotent).length, 1, "exactly one op performed the transition");
});

test("CONCURRENT In Progress → In Review: one 'qa_sent' event, no duplicate or lost activity", async () => {
  await tasks().doc("t4").set({ status: "In Progress", type: "Reel", owner: "Otis", ownerUid: "own",
    assigneeUids: ["own", "bo"], links: { video: "https://drive.example/reel" },
    activity: [{ type: "created", by: "Ada", at: 1 }, { type: "started", by: "Otis", uid: "own", at: 2 }] });

  // Two assigned users concurrently Submit for QA (In Progress → In Review); the
  // required deliverable link is present so the transition is permitted.
  const opts = { fromStatus: "In Progress", toStatus: "In Review", kind: "qa_sent" };
  const results = await Promise.all([advance("t4", opts, otis), advance("t4", opts, boCrew)]);

  const t = await get("t4");
  assert.equal(t.status, "In Review", "final status is In Review");
  const qaSent = t.activity.filter((a) => a.type === "qa_sent");
  assert.equal(qaSent.length, 1, "exactly one 'qa_sent' event");
  assert.equal(t.activity.length, 3, "created + started + exactly one qa_sent — nothing lost or duplicated");
  assert.equal(results.filter((r) => r && r.idempotent).length, 1, "the losing/retried op is an idempotent success");
});
