/* User-removal saga — Firestore-bound (emulator).
   Proves the durable, resumable, idempotent removal: tombstone + Auth disable +
   token cleanup + immutable audit, with crash-after-Auth-disable resuming
   correctly and the token trigger unable to resurrect a removed profile.

     node --test test/removal.test.js          (vs a running emulator)
     npm run test:emulator                     (throwaway emulator) */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-removal-test";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db } = await import("../functions/lib.js");
const { removeUserCore } = await import("../functions/removeUser.js");
const { syncPushSummary } = await import("../functions/onFcmTokenWrite.js");

const user = (id) => db.collection("users").doc(id);
const tokens = (id) => user(id).collection("fcmTokens");
const get = (path) => db.doc(path).get().then((s) => (s.exists ? s.data() : null));

async function clearCol(path) {
  const snap = await db.collection(path).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

beforeEach(async () => {
  for (const c of ["users", "adminOps", "auditEvents"]) await clearCol(c);
  for (const id of ["t1", "t2", "act1"]) { const s = await tokens(id).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }
  await user("admin1").set({ role: "admin", status: "approved", name: "Ada Admin" });
  await user("admin2").set({ role: "admin", status: "approved", name: "Al Admin" });
  await user("m1").set({ role: "member", status: "approved", name: "Mel Member" });
  await user("t1").set({ role: "member", status: "approved", name: "Tom Target", email: "tom@x.com", skills: ["shoot"], qa: false });
  await tokens("t1").doc("tokA").set({ ua: "chrome" });
  await tokens("t1").doc("tokB").set({ ua: "safari" });
});

const authOf = () => { const calls = []; return { fn: async (uid) => { calls.push(uid); }, calls }; };

test("happy path: tombstones, disables Auth, clears tokens, writes an immutable audit", async () => {
  const auth = authOf();
  const r = await removeUserCore({ database: db, callerUid: "admin1", targetUid: "t1", deps: { disableAuthUser: auth.fn } });
  assert.equal(r.phase, "done");
  assert.deepEqual(auth.calls, ["t1"]);                          // Auth disabled (not deleted)

  const t = await get("users/t1");
  assert.equal(t.status, "removed");
  assert.equal(t.disabled, true);
  assert.equal(t.role, "member");
  assert.deepEqual(t.skills, []);
  assert.equal(t.name, "Tom Target");                            // identity preserved for attribution
  assert.equal(t.email, undefined);                             // sensitive field stripped
  assert.equal((await tokens("t1").get()).size, 0);            // token cleanup complete

  const audit = await get("auditEvents/remove_t1");
  assert.equal(audit.type, "user_removed");
  assert.equal(audit.reversible, true);
  assert.equal(audit.targetUid, "t1");
  assert.equal((await get("adminOps/remove_t1")).phase, "done");
});

test("repeated invocation is an idempotent success (no double work)", async () => {
  const auth = authOf();
  await removeUserCore({ database: db, callerUid: "admin1", targetUid: "t1", deps: { disableAuthUser: auth.fn } });
  const again = await removeUserCore({ database: db, callerUid: "admin1", targetUid: "t1", deps: { disableAuthUser: auth.fn } });
  assert.ok(again.alreadyDone || again.alreadyRemoved, "a completed removal reports idempotent success");
  assert.equal((await tokens("t1").get()).size, 0);
});

test("a crash after Auth disable resumes and completes on retry", async () => {
  await user("t2").set({ role: "member", status: "approved", name: "Ty Two" });
  await tokens("t2").doc("tk").set({ ua: "x" });
  const auth = authOf();
  let crashed = false;
  const hooks = { afterDisable: async () => { if (!crashed) { crashed = true; throw new Error("boom after auth disable"); } } };

  await assert.rejects(removeUserCore({ database: db, callerUid: "admin1", targetUid: "t2", deps: { disableAuthUser: auth.fn, hooks } }));
  // Partial state: tombstoned + Auth disabled, but op not advanced, tokens intact, no audit.
  assert.equal((await get("users/t2")).disabled, true);
  assert.deepEqual(auth.calls, ["t2"]);
  assert.equal((await get("adminOps/remove_t2")).phase, "validating");
  assert.equal((await tokens("t2").get()).size, 1);
  assert.equal(await get("auditEvents/remove_t2"), null);

  // Retry resumes and finishes.
  const r = await removeUserCore({ database: db, callerUid: "admin1", targetUid: "t2", deps: { disableAuthUser: auth.fn, hooks } });
  assert.equal(r.phase, "done");
  assert.equal((await tokens("t2").get()).size, 0);
  assert.ok(await get("auditEvents/remove_t2"));
});

test("a non-admin caller is denied", async () => {
  await assert.rejects(
    removeUserCore({ database: db, callerUid: "m1", targetUid: "t1", deps: { disableAuthUser: authOf().fn } }),
    (e) => e.code === "permission-denied");
  assert.equal(await get("users/t1").then((t) => t.status), "approved"); // untouched
});

test("self-removal is denied", async () => {
  await assert.rejects(
    removeUserCore({ database: db, callerUid: "admin1", targetUid: "admin1", deps: { disableAuthUser: authOf().fn } }),
    (e) => e.code === "failed-precondition");
});

test("the token trigger cannot resurrect a removed profile", async () => {
  await removeUserCore({ database: db, callerUid: "admin1", targetUid: "t1", deps: { disableAuthUser: authOf().fn } });
  // A late token write fires the sync — it must NOT re-create/modify the tombstone.
  const before = await get("users/t1");
  assert.equal(await syncPushSummary("t1"), "skipped-removed");
  const after = await get("users/t1");
  assert.equal(after.status, "removed");
  assert.equal(after.pushDeviceCount, undefined);            // no summary written
  assert.deepEqual(after, before);
  // A truly absent parent is also never created.
  assert.equal(await syncPushSummary("ghost"), "skipped-absent");
  assert.equal(await get("users/ghost"), null);
  // A live user IS summarized.
  await user("act1").set({ role: "member", status: "approved", name: "Active" });
  await tokens("act1").doc("t").set({ ua: "x" });
  assert.equal(await syncPushSummary("act1"), "updated");
  assert.equal((await get("users/act1")).pushDeviceCount, 1);
});
