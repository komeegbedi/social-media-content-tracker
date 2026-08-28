/* Overdue producer + admin delivery-health — backend delivery (emulator, Firestore).
   Proves the daily overdue sweep notifies the RIGHT owners by workflow status, alerts
   once on first becoming overdue (idempotent across retries), re-alerts on a due-date
   revision, excludes ineligible accounts, and honors the per-type opt-out; and that
   email delivery-health alerts reach active admins ONLY and bypass the leadership opt-out.
     node --test test/notif-overdue.test.js      (vs a running emulator)
     npm run test:emulator                        (throwaway emulator) */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-notif-overdue";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const lib = await import("../functions/lib.js");
const { db, loadUsers } = lib;
const { overdueSweep, runDailyStages } = await import("../functions/dispatchReminders.js");
const { alertAdmins } = await import("../functions/emailQuota.js");

const silentLog = { info() {}, warn() {}, error() {} };

const PAST = "2000-01-01";     // unambiguously before Winnipeg "today"
const FUTURE = "2999-01-01";

const USERS = {
  owner:    { name: "Ollie Own",  status: "approved" },
  crew:     { name: "Cy Crew",    status: "approved" },
  caps:     { name: "Cap Poster", status: "approved", captions: true },
  qa:       { name: "Quinn QA",   status: "approved", qa: true },
  admin:    { name: "Ada Admin",  role: "admin" },
  adminqa:  { name: "Andy AQ",    role: "admin", qa: true },
  lead:     { name: "Lee Lead",   status: "approved", lead: true },
  pending:  { name: "Peg Pend",   status: "pending" },
  disabled: { name: "Del Dis",    status: "approved", disabled: true },
  disAdmin: { name: "Dan DisAdm", role: "admin", disabled: true },
};

const wipe = async (c) => { const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); };
beforeEach(async () => {
  await Promise.all(["users", "tasks", "notifications"].map(wipe));
  for (const [id, u] of Object.entries(USERS)) await db.collection("users").doc(id).set(u);
});
const notifs = async (uid) => (await db.collection("notifications").where("uid", "==", uid).get()).docs.map((d) => d.data());
const countFor = async (uid, type = "overdue") => (await notifs(uid)).filter((n) => n.type === type).length;
const sweep = async () => { const { list, byUid } = await loadUsers(); return overdueSweep(list, byUid); };

test("first overdue alert reaches owner + crew for production-owned statuses", async () => {
  await db.collection("tasks").doc("t").set({ status: "In Progress", title: "Reel A", postDate: PAST, ownerUid: "owner", support: [{ uid: "crew" }] });
  await sweep();
  assert.equal(await countFor("owner"), 1);
  assert.equal(await countFor("crew"), 1);
  const [n] = await notifs("owner");
  assert.equal(n.title, "'Reel A' is overdue");
  assert.match(n.body, /^This was due .+\. Open it to review the next action\.$/);
  assert.equal(n.taskId, "t"); // deep-links to the exact task (client derives /content/{taskId})
});

test("Approved / Ready to Post overdue alerts go to captions users, not production owner", async () => {
  await db.collection("tasks").doc("t").set({ status: "Approved", title: "Post B", postDate: PAST, ownerUid: "owner", support: [{ uid: "crew" }] });
  await sweep();
  assert.equal(await countFor("caps"), 1, "captions/upload user is alerted");
  assert.equal(await countFor("owner"), 0, "production owner is not blamed once it's out of their hands");
  assert.equal(await countFor("crew"), 0);
});

test("In Review overdue blames nobody (production can't act)", async () => {
  await db.collection("tasks").doc("t").set({ status: "In Review", title: "Rev C", postDate: PAST, ownerUid: "owner", support: [{ uid: "crew" }] });
  await sweep();
  for (const u of Object.keys(USERS)) assert.equal(await countFor(u), 0, `${u} must not be alerted for In Review`);
});

test("Posted / trashed / not-yet-due tasks never alert", async () => {
  await db.collection("tasks").doc("done").set({ status: "Posted", title: "x", postDate: PAST, ownerUid: "owner" });
  await db.collection("tasks").doc("trash").set({ status: "In Progress", title: "x", postDate: PAST, ownerUid: "owner", deletedAt: new Date() });
  await db.collection("tasks").doc("future").set({ status: "In Progress", title: "x", postDate: FUTURE, ownerUid: "owner" });
  await db.collection("tasks").doc("nodate").set({ status: "In Progress", title: "x", ownerUid: "owner" });
  await sweep();
  assert.equal(await countFor("owner"), 0);
});

test("ineligible assignees (QA / Admin+QA / pending / disabled) never receive overdue", async () => {
  await db.collection("tasks").doc("t").set({ status: "In Progress", title: "x", postDate: PAST,
    ownerUid: "qa", support: [{ uid: "adminqa" }, { uid: "pending" }, { uid: "disabled" }] });
  await sweep();
  for (const u of ["qa", "adminqa", "pending", "disabled"]) assert.equal(await countFor(u), 0, `${u} excluded`);
});

test("alert fires ONCE — a retry (same day) does not duplicate", async () => {
  await db.collection("tasks").doc("t").set({ status: "In Progress", title: "x", postDate: PAST, ownerUid: "owner" });
  await sweep();
  await sweep(); // the hourly cron re-runs; idempotency key is stable
  assert.equal(await countFor("owner"), 1);
});

test("a due-date revision that is still overdue produces a NEW alert", async () => {
  await db.collection("tasks").doc("t").set({ status: "In Progress", title: "x", postDate: "2000-01-01", ownerUid: "owner" });
  await sweep();
  await db.collection("tasks").doc("t").update({ postDate: "2000-02-02" }); // rescheduled, still in the past
  await sweep();
  assert.equal(await countFor("owner"), 2, "new due-date revision → fresh idempotency key → new alert");
});

test("overdue honors the per-type opt-out", async () => {
  await db.collection("users").doc("owner").set({ ...USERS.owner, notifPrefs: { perType: { overdue: false } } });
  await db.collection("tasks").doc("t").set({ status: "In Progress", title: "x", postDate: PAST, ownerUid: "owner" });
  await sweep();
  assert.equal(await countFor("owner"), 0);
});

test("accurate counts: a task whose only recipient opted out counts as suppressed, not created", async () => {
  await db.collection("users").doc("owner").set({ ...USERS.owner, notifPrefs: { perType: { overdue: false } } });
  await db.collection("tasks").doc("t").set({ status: "In Progress", title: "x", postDate: PAST, ownerUid: "owner" });
  const { list, byUid } = await loadUsers();
  const s = await overdueSweep(list, byUid);
  assert.equal(s.tasksOverdue, 1);
  assert.equal(s.created, 0, "opted-out recipient → nothing created");
  assert.equal(s.suppressed, 1, "counted as suppressed");
});

test("counts: created on first run, deduped on an idempotent retry (no duplicate)", async () => {
  await db.collection("tasks").doc("t").set({ status: "In Progress", title: "x", postDate: PAST, ownerUid: "owner", support: [{ uid: "crew" }] });
  const { list, byUid } = await loadUsers();
  const first = await overdueSweep(list, byUid);
  assert.equal(first.created, 2);
  const second = await overdueSweep(list, byUid);           // Cloud Scheduler retry
  assert.equal(second.created, 0, "retry creates nothing new");
  assert.equal(second.deduped, 2, "both recipients already had the alert");
  assert.equal(await countFor("owner"), 1);
  assert.equal(await countFor("crew"), 1);
});

test("a transient sweep failure PROPAGATES (surfaced for retry), then a retry creates the alert", async () => {
  await db.collection("tasks").doc("t").set({ status: "In Progress", title: "x", postDate: PAST, ownerUid: "owner" });
  const { list, byUid } = await loadUsers();
  // First attempt: the delivery pipeline throws (transient Firestore/network failure).
  let calls = 0;
  const flaky = async (...args) => { calls++; if (calls === 1) throw new Error("transient"); return lib.notifyUsers(...args); };
  await assert.rejects(() => overdueSweep(list, byUid, { notify: flaky }), /transient/);
  assert.equal(await countFor("owner"), 0, "nothing delivered on the failed attempt");
  // Retry succeeds and creates the missing alert.
  const s = await overdueSweep(list, byUid);
  assert.equal(s.created, 1);
  assert.equal(await countFor("owner"), 1);
});

test("runDailyStages: leadership fails, overdue succeeds → overdue still runs, leadership error captured", async () => {
  let overdueRan = false;
  const r = await runDailyStages({
    leadership: async () => { throw new Error("digest boom"); },
    overdue: async () => { overdueRan = true; return { created: 1 }; },
    date: "2026-08-28", log: silentLog,
  });
  assert.equal(overdueRan, true, "overdue still runs after a leadership failure");
  assert.ok(r.leadershipError, "leadership error is captured (not discarded)");
  assert.match(r.leadershipError.message, /digest boom/);
  assert.equal(r.overdueError, null);
});

test("runDailyStages: leadership succeeds, overdue fails → overdue error captured", async () => {
  let leadershipRan = false;
  const r = await runDailyStages({
    leadership: async () => { leadershipRan = true; },
    overdue: async () => { throw new Error("sweep boom"); },
    date: "2026-08-28", log: silentLog,
  });
  assert.equal(leadershipRan, true);
  assert.equal(r.leadershipError, null);
  assert.ok(r.overdueError, "overdue error is captured for the caller to surface/retry");
  assert.match(r.overdueError.message, /sweep boom/);
});

test("runDailyStages: BOTH stages fail → both are attempted and both errors are represented", async () => {
  let leadershipRan = false, overdueRan = false;
  const r = await runDailyStages({
    leadership: async () => { leadershipRan = true; throw new Error("L-boom"); },
    overdue: async () => { overdueRan = true; throw new Error("O-boom"); },
    date: "2026-08-28", log: silentLog,
  });
  assert.equal(leadershipRan, true);
  assert.equal(overdueRan, true, "overdue is attempted even after leadership threw");
  assert.match(r.leadershipError.message, /L-boom/);
  assert.match(r.overdueError.message, /O-boom/);
});

test("runDailyStages: both succeed → no errors", async () => {
  const r = await runDailyStages({
    leadership: async () => {},
    overdue: async () => ({ created: 2 }),
    date: "2026-08-28", log: silentLog,
  });
  assert.equal(r.leadershipError, null);
  assert.equal(r.overdueError, null);
  assert.deepEqual(r.stats, { created: 2 });
});

test("present-empty assigneeUids never alerts a stale owner (weekly/overdue corrected identity)", async () => {
  await db.collection("tasks").doc("t").set({ status: "In Progress", title: "x", postDate: PAST, assigneeUids: [], ownerUid: "owner", support: [{ uid: "crew" }] });
  await sweep();
  assert.equal(await countFor("owner"), 0, "authoritative empty set → nobody");
  assert.equal(await countFor("crew"), 0);
});

test("a genuinely legacy task (owner by NAME only) alerts the unique eligible match", async () => {
  await db.collection("tasks").doc("t").set({ status: "In Progress", title: "x", postDate: PAST, owner: "Ollie Own" });
  await sweep();
  assert.equal(await countFor("owner"), 1, "unique, eligible legacy name resolves");
});

test("overdue: name-only legacy SUPPORT crew is NOT notified (only the legacy owner is authorized)", async () => {
  await db.collection("tasks").doc("t").set({ status: "In Progress", title: "x", postDate: PAST,
    owner: "Ollie Own", support: [{ name: "Cy Crew", role: "shoot" }] }); // crew by NAME only
  await sweep();
  assert.equal(await countFor("owner"), 1, "legacy owner resolves");
  assert.equal(await countFor("crew"), 0, "legacy support crew is not authorized by name → no alert");
});

test("email delivery-health alerts reach ACTIVE admins only and bypass the leadership opt-out", async () => {
  // An admin who opted OUT of leadership must STILL get delivery-health (it's required).
  await db.collection("users").doc("admin").set({ ...USERS.admin, notifPrefs: { perType: { leadership: false } } });
  await alertAdmins({ monthlyThresholds: [90], period: { month: "2026-08", day: "2026-08-28" } });
  assert.equal(await countFor("admin", "admin_delivery_health"), 1, "opted-out admin still alerted (required)");
  assert.equal(await countFor("adminqa", "admin_delivery_health"), 1, "Admin+QA is an admin → alerted");
  assert.equal(await countFor("disAdmin", "admin_delivery_health"), 0, "disabled admin excluded");
  for (const u of ["owner", "lead", "qa"]) assert.equal(await countFor(u, "admin_delivery_health"), 0, `${u} is not an admin`);
  const [n] = (await notifs("admin")).filter((x) => x.type === "admin_delivery_health");
  assert.equal(n.route, "/admin"); // deep-links to the admin console
});
