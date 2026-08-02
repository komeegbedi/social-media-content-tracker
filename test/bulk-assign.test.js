/* Bulk assignment — Firestore-bound (emulator).
   Proves the trusted backend path: admin-gated, whole-request validated, applied
   in bounded resumable chunks, with an op id + explicit progress/failure and a
   crash between chunks resuming without duplicate effect.

     node --test test/bulk-assign.test.js      (vs a running emulator)
     npm run test:emulator                     (throwaway emulator) */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-bulk-test";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db } = await import("../functions/lib.js");
const { bulkAssignCore } = await import("../functions/bulkAssign.js");

const tasksCol = () => db.collection("tasks");
const getTask = (id) => tasksCol().doc(id).get().then((s) => (s.exists ? s.data() : null));
async function clearCol(path) {
  for (;;) { const s = await db.collection(path).limit(400).get(); if (s.empty) break; const b = db.batch(); s.docs.forEach((d) => b.delete(d.ref)); await b.commit(); }
}

beforeEach(async () => {
  await clearCol("tasks"); await clearCol("users"); await clearCol("adminOps");
  await db.collection("users").doc("admin1").set({ role: "admin", status: "approved", name: "Ada" });
  await db.collection("users").doc("m1").set({ role: "member", status: "approved", name: "Mel" });
  await db.collection("users").doc("bo").set({ role: "member", status: "approved", name: "Bo Crew" });
});
const A = (taskId) => ({ taskId, support: [{ name: "Bo Crew", role: "shoot" }] });

test("a non-admin caller is denied", async () => {
  await assert.rejects(
    bulkAssignCore({ database: db, callerUid: "m1", opId: "x", assignments: [A("t1")] }),
    (e) => e.code === "permission-denied");
});

test("applies valid assignments, reports invalid ones as explicit failures", async () => {
  await tasksCol().doc("t1").set({ owner: "Ada", status: "Planned", support: [] });
  const r = await bulkAssignCore({ database: db, callerUid: "admin1", opId: "op1", assignments: [
    A("t1"),
    { taskId: "t2", support: [{ name: "Ghost", role: "edit" }] }, // invalid assignee → not applied
  ] });
  assert.equal(r.phase, "done");
  assert.equal(r.total, 1);                       // only the valid one is scheduled
  assert.equal(r.applied, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual((await getTask("t1")).support, [{ name: "Bo Crew", role: "shoot" }]);
});

test("a missing task is a per-item failure, not a thrown batch", async () => {
  const r = await bulkAssignCore({ database: db, callerUid: "admin1", opId: "op2", assignments: [A("nope")] });
  assert.equal(r.applied, 0);
  assert.equal(r.failed, 1);                       // task didn't exist → recorded, not crashed
});

test(">chunk assignments apply across bounded chunks; a crash resumes without duplication", async () => {
  const N = 20;
  const b = db.batch();
  for (let i = 0; i < N; i++) b.set(tasksCol().doc(`t${String(i).padStart(2, "0")}`), { status: "Planned", support: [] });
  await b.commit();
  const assignments = Array.from({ length: N }, (_, i) => A(`t${String(i).padStart(2, "0")}`));

  // First run crashes after the first small chunk.
  let crashed = false;
  const hooks = { afterChunk: async () => { if (!crashed) { crashed = true; throw new Error("crash"); } } };
  await assert.rejects(bulkAssignCore({ database: db, callerUid: "admin1", opId: "op3", assignments, deps: { hooks, page: 5 } }));
  // (bulkAssignCore uses the default CHUNK; force resumability by re-invoking.)

  // Resume — re-invoking the SAME opId continues from the cursor and completes.
  const r = await bulkAssignCore({ database: db, callerUid: "admin1", opId: "op3", assignments });
  assert.equal(r.phase, "done");
  assert.equal(r.applied, N);                      // all applied, none double-counted beyond N
  for (let i = 0; i < N; i++) assert.deepEqual((await getTask(`t${String(i).padStart(2, "0")}`)).support, [{ name: "Bo Crew", role: "shoot" }]);
});

test("re-invoking a completed op is an idempotent success", async () => {
  await tasksCol().doc("t1").set({ status: "Planned", support: [] });
  await bulkAssignCore({ database: db, callerUid: "admin1", opId: "op4", assignments: [A("t1")] });
  const again = await bulkAssignCore({ database: db, callerUid: "admin1", opId: "op4", assignments: [A("t1")] });
  assert.equal(again.alreadyDone, true);
});
