/* Notification eligibility — backend delivery (emulator, Firestore only).
   Proves the weekly production check-in targets only active production-eligible
   users WITH active work (never QA/Admin+QA/pending/disabled/removed, honors
   opt-out), and that the leadership digest honors its per-type opt-out.
     node --test test/notif-eligibility.test.js      (vs a running emulator)
     npm run test:emulator                            (throwaway emulator) */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-notif-eligibility";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const lib = await import("../functions/lib.js");
const { db } = lib;
const { runWeekly } = await import("../functions/weeklyTaskCheck.js");
const { leadershipDigest } = await import("../functions/dispatchReminders.js");

const USERS = {
  prod:     { name: "Pat Prod",  status: "approved" },
  prod2:    { name: "Cy Crew",   status: "approved" },
  prodIdle: { name: "Ida Idle",  status: "approved" },              // eligible but NO work
  qa:       { name: "Quinn QA",  status: "approved", qa: true },
  adminqa:  { name: "Andy AQ",   role: "admin",     qa: true },
  admin:    { name: "Ada Admin", role: "admin" },
  lead:     { name: "Lee Lead",  status: "approved", lead: true },
  pending:  { name: "Peg Pend",  status: "pending" },
  disabled: { name: "Del Dis",   status: "approved", disabled: true },
  removed:  { name: "Rex Rem",   status: "removed" },
};

const wipe = async (c) => { const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); };
beforeEach(async () => {
  await Promise.all(["users", "tasks", "notifications"].map(wipe));
  for (const [id, u] of Object.entries(USERS)) await db.collection("users").doc(id).set(u);
});
const countFor = async (uid, type) =>
  (await db.collection("notifications").where("uid", "==", uid).get()).docs.filter((d) => !type || d.data().type === type).length;

test("weekly check-in targets ONLY active production-eligible users with active work", async () => {
  // prod + prod2 have active production work.
  await db.collection("tasks").doc("t1").set({ status: "In Progress", ownerUid: "prod", support: [{ uid: "prod2" }] });
  // Ineligible users are given "work" too, to prove the eligibility gate excludes them anyway.
  await db.collection("tasks").doc("t2").set({ status: "In Progress", ownerUid: "qa", support: [{ uid: "disabled" }, { uid: "pending" }, { uid: "adminqa" }, { uid: "removed" }] });
  // prodIdle + admin have NO active work.
  await runWeekly();
  assert.equal(await countFor("prod", "weeklyTaskCheck"), 1);
  assert.equal(await countFor("prod2", "weeklyTaskCheck"), 1);
  assert.equal(await countFor("prodIdle"), 0, "eligible but idle → excluded");
  assert.equal(await countFor("admin"), 0, "non-QA admin but no work → excluded");
  for (const u of ["qa", "adminqa", "disabled", "pending", "removed"])
    assert.equal(await countFor(u), 0, `${u} must be excluded from the weekly check-in`);
});

test("weekly check-in only counts ACTIVE work (Posted / trashed tasks don't qualify)", async () => {
  await db.collection("tasks").doc("done").set({ status: "Posted", ownerUid: "prod" });
  await db.collection("tasks").doc("trash").set({ status: "In Progress", ownerUid: "prod2", deletedAt: new Date() });
  await runWeekly();
  assert.equal(await countFor("prod"), 0, "only Posted work → not in My Day → excluded");
  assert.equal(await countFor("prod2"), 0, "only trashed work → excluded");
});

test("weekly: present-empty assigneeUids excludes a stale owner; a legacy name resolves uniquely", async () => {
  // Authoritative empty set → nobody, even with a stale ownerUid still on the doc.
  await db.collection("tasks").doc("empty").set({ status: "In Progress", assigneeUids: [], ownerUid: "prod" });
  // Genuinely legacy task (owner by NAME only) → the unique eligible match.
  await db.collection("tasks").doc("legacy").set({ status: "In Progress", owner: "Cy Crew" }); // prod2's display name
  await runWeekly();
  assert.equal(await countFor("prod"), 0, "authoritative empty assigneeUids → no active work");
  assert.equal(await countFor("prod2"), 1, "legacy owner-by-name resolves to the unique eligible user");
});

test("weekly check-in honors the per-type opt-out", async () => {
  await db.collection("users").doc("prod").set({ ...USERS.prod, notifPrefs: { perType: { weeklyTaskCheck: false } } });
  await db.collection("tasks").doc("t1").set({ status: "In Progress", ownerUid: "prod" });
  await runWeekly();
  assert.equal(await countFor("prod"), 0, "opted out → no weekly check-in");
});

test("leadership digest honors the leadership opt-out (and only leads/admins get it)", async () => {
  await db.collection("tasks").doc("t1").set({ status: "In Progress", blockedOn: "waiting on assets" }); // something to report
  await db.collection("users").doc("lead").set({ ...USERS.lead, notifPrefs: { perType: { leadership: false } } });
  const { list } = await lib.loadUsers();
  await leadershipDigest(list, { leadershipAlertRoles: ["admin", "lead"] });
  assert.equal(await countFor("admin", "leadership"), 1, "admin (opted in) gets the digest");
  assert.equal(await countFor("adminqa", "leadership"), 1, "Admin+QA is an admin → gets leadership");
  assert.equal(await countFor("lead", "leadership"), 0, "lead opted out → suppressed");
  assert.equal(await countFor("prod", "leadership"), 0, "non-lead non-admin → never");
});

test("leadership digest excludes disabled / pending / removed leaders (account eligibility)", async () => {
  await db.collection("tasks").doc("t1").set({ status: "In Progress", blockedOn: "waiting on assets" });
  // A disabled admin, a pending lead, and a removed lead — all opted IN by default.
  await db.collection("users").doc("admin").set({ ...USERS.admin, disabled: true });
  await db.collection("users").doc("pendLead").set({ name: "Pat Pend", status: "pending", lead: true });
  await db.collection("users").doc("remLead").set({ name: "Ray Rem", status: "removed", lead: true });
  const { list } = await lib.loadUsers();
  await leadershipDigest(list, { leadershipAlertRoles: ["admin", "lead"] });
  assert.equal(await countFor("admin", "leadership"), 0, "disabled admin → no digest");
  assert.equal(await countFor("pendLead", "leadership"), 0, "pending lead → no digest");
  assert.equal(await countFor("remLead", "leadership"), 0, "removed lead → no digest");
  assert.equal(await countFor("lead", "leadership"), 1, "an active, opted-in lead still gets it");
});
