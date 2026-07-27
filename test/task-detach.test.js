/* Task detachment — Firestore-bound (emulator).
   Proves chunked, resumable reassignment: posted history preserved, >500 affected
   writes handled safely, and a crash between chunks resumes with no duplicate
   effect. Also the full removeUserCore integration (reassign policy end-to-end).

     node --test test/task-detach.test.js      (vs a running emulator)
     npm run test:emulator                     (throwaway emulator) */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-detach-test";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db } = await import("../functions/lib.js");
const { detachTasks } = await import("../functions/taskDetach.js");
const { removeUserCore } = await import("../functions/removeUser.js");

const GONE = "Gone User";
const tasksCol = () => db.collection("tasks");
const get = (id) => tasksCol().doc(id).get().then((s) => (s.exists ? s.data() : null));

async function clearCol(path) {
  for (;;) {
    const snap = await db.collection(path).limit(400).get();
    if (snap.empty) break;
    const b = db.batch(); snap.docs.forEach((d) => b.delete(d.ref)); await b.commit();
  }
}
// Seed N active tasks owned by GONE (padded ids so __name__ ordering is stable).
async function seedOwned(n, prefix = "t") {
  for (let i = 0; i < n; i += 400) {
    const b = db.batch();
    for (let j = i; j < Math.min(i + 400, n); j++) {
      b.set(tasksCol().doc(`${prefix}${String(j).padStart(4, "0")}`), { owner: GONE, status: "In Progress", support: [] });
    }
    await b.commit();
  }
}
const newOp = async (id, extra = {}) => {
  await db.collection("adminOps").doc(id).set({ type: "user_removal", phase: "tokens_cleared", ...extra });
  return db.collection("adminOps").doc(id);
};

beforeEach(async () => { await clearCol("tasks"); await clearCol("adminOps"); await clearCol("users"); });

test("posted tasks are preserved; active owner/crew are detached", async () => {
  await tasksCol().doc("active").set({ owner: GONE, status: "In Progress", support: [{ name: GONE, role: "shoot" }] });
  await tasksCol().doc("posted").set({ owner: GONE, status: "Posted", support: [{ name: GONE, role: "shoot" }] });
  await tasksCol().doc("crew").set({ owner: "Al", status: "Planned", support: [{ name: GONE, role: "edit" }] });
  const opRef = await newOp("op1");

  await detachTasks({ db, opRef, userName: GONE, mode: "unassign", resolvedTargetName: null });

  assert.equal((await get("active")).owner, "Pending");
  assert.deepEqual((await get("active")).support, []);
  assert.equal((await get("posted")).owner, GONE);            // history untouched
  assert.deepEqual((await get("posted")).support, [{ name: GONE, role: "shoot" }]);
  assert.equal((await get("crew")).owner, "Al");             // not the owner
  assert.deepEqual((await get("crew")).support, []);
});

test("more than 500 affected tasks are handled in bounded chunks", async () => {
  await seedOwned(900);
  const opRef = await newOp("op2");
  await detachTasks({ db, opRef, userName: GONE, mode: "unassign", resolvedTargetName: null, page: 400 });
  const snap = await tasksCol().where("owner", "==", "Pending").get();
  assert.equal(snap.size, 900); // every one detached, across 3 chunks
});

test("a crash between chunks resumes from the cursor with no duplicate effect", async () => {
  await seedOwned(900);
  const opRef = await newOp("op3");
  let crashed = false;
  const hooks = { afterChunk: async () => { if (!crashed) { crashed = true; throw new Error("crash after chunk 1"); } } };

  await assert.rejects(detachTasks({ db, opRef, userName: GONE, mode: "unassign", resolvedTargetName: null, page: 400, hooks }));
  const afterCrash = (await tasksCol().where("owner", "==", "Pending").get()).size;
  assert.equal(afterCrash, 400);                              // only the first chunk committed
  assert.ok((await opRef.get()).data().taskCursor);          // cursor persisted

  // Resume — finishes the rest, and never re-touches chunk 1.
  await detachTasks({ db, opRef, userName: GONE, mode: "unassign", resolvedTargetName: null, page: 400, hooks });
  assert.equal((await tasksCol().where("owner", "==", "Pending").get()).size, 900);
});

test("removeUserCore reassigns active work end-to-end via the saga", async () => {
  await db.collection("users").doc("admin1").set({ role: "admin", status: "approved", name: "Ada" });
  await db.collection("users").doc("keep").set({ role: "member", status: "approved", name: "Keep User" });
  await db.collection("users").doc("gone").set({ role: "member", status: "approved", name: GONE });
  await tasksCol().doc("x").set({ owner: GONE, status: "In Progress", support: [] });
  await tasksCol().doc("done").set({ owner: GONE, status: "Posted", support: [] });

  const r = await removeUserCore({
    database: db, callerUid: "admin1", targetUid: "gone",
    policy: { mode: "reassign", reassignToUid: "keep" },
    deps: { disableAuthUser: async () => {} },
  });
  assert.equal(r.phase, "done");
  assert.equal((await get("x")).owner, "Keep User");         // active work reassigned
  assert.equal((await get("done")).owner, GONE);            // posted history kept
  assert.equal((await db.doc("users/gone").get()).data().status, "removed");
});
