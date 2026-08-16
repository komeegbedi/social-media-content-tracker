/* SCENARIO B — STALE-INSTANCE DISPATCH (delivery side; emulator).

   Distinct from Scenario A (materialization/scheduling, in test/reminders.test.js):
   here a reminder instance was created while the task was ACTIVE, the task is THEN
   trashed, and the hourly DISPATCHER later claims that already-due instance. It must
   be skipped at SEND time — no in-app, no push, no email digest item — and trashed
   tasks must never inflate the leadership follow-up counts. (Scenario A prevents the
   instance from surviving in the first place; Scenario B is the belt-and-braces guard
   for an instance that predates the trash or was created out-of-band.)

     node --test test/reminders-trash.test.js   (vs a running emulator)
     npm run test:emulator                       (throwaway emulator) */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-reminders-trash-test";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db, Timestamp } = await import("../functions/lib.js");
const { runDispatch } = await import("../functions/dispatchReminders.js");

const OWNER = { uid: "u-own", name: "Ada Owner", status: "approved", role: "member", email: "ada@example.com" };
const LEAD = { uid: "u-lead", name: "Boss", status: "approved", role: "admin", email: "boss@example.com" };

async function wipe(coll) {
  const s = await db.collection(coll).get();
  await Promise.all(s.docs.map((d) => d.ref.delete()));
}
beforeEach(async () => {
  await Promise.all(["tasks", "reminderInstances", "notifications", "reminderDigests", "users", "settings"].map(wipe));
  await db.collection("users").doc(OWNER.uid).set(OWNER);
  await db.collection("users").doc(LEAD.uid).set(LEAD);
  // Deterministic settings; hour set so the leadership digest does NOT auto-fire here.
  await db.collection("settings").doc("notifications").set({ reminderHourLocal: 25, leadershipAlertRoles: ["admin", "lead"] });
});

const dueInstance = (taskId, over = {}) => db.collection("reminderInstances").doc(`${taskId}_r1_due`).set({
  taskId, reminderId: "r1", scheduleRev: "rev1",
  fireAt: Timestamp.fromDate(new Date(Date.now() - 3600_000)), // due an hour ago
  recipients: ["owner"], channels: ["in-app", "email"],
  status: "pending", leaseUntil: null, claimedBy: null, attempts: 0, lastError: "", dedupeKey: "d", processedAt: null,
  ...over,
});
const task = (over = {}) => ({ title: "Reel", status: "In Progress", owner: OWNER.name, postDate: "2027-01-15", ...over });

test("a due reminder for a TRASHED task is skipped — no notification, no digest item", async () => {
  await db.collection("tasks").doc("t-trash").set(task({ deletedAt: new Date() })); // trashed, status untouched
  await dueInstance("t-trash");

  const res = await runDispatch();

  const inst = (await db.collection("reminderInstances").doc("t-trash_r1_due").get()).data();
  assert.equal(inst.status, "skipped", "instance is skipped, not processed");
  assert.ok(res.skipped >= 1);
  const notifs = await db.collection("notifications").get();
  assert.equal(notifs.size, 0, "no in-app/push notification created for a trashed task");
  const digests = await db.collection("reminderDigests").get();
  assert.equal(digests.size, 0, "no email digest item enqueued for a trashed task");
});

test("the SAME reminder for an ACTIVE task IS processed (control) — proves the skip is Trash-specific", async () => {
  await db.collection("tasks").doc("t-live").set(task()); // active
  await dueInstance("t-live");

  const res = await runDispatch();

  const inst = (await db.collection("reminderInstances").doc("t-live_r1_due").get()).data();
  assert.equal(inst.status, "processed");
  assert.ok(res.processed >= 1);
  assert.ok((await db.collection("notifications").get()).size >= 1, "active task notifies");
});

test("leadership follow-up counts EXCLUDE trashed tasks", async () => {
  // Fire the leadership digest deterministically by matching the local hour.
  const { localHour } = await import("../functions/lib.js");
  await db.collection("settings").doc("notifications").set({ reminderHourLocal: localHour(), leadershipAlertRoles: ["admin", "lead"] });

  // Two overdue+no-crew tasks: one active, one trashed. Only the active one should count.
  await db.collection("tasks").doc("a").set(task({ postDate: "2000-01-01", support: [] }));
  await db.collection("tasks").doc("b").set(task({ postDate: "2000-01-01", support: [], deletedAt: new Date() }));

  await runDispatch();

  const digestId = (await db.collection("notifications").get()).docs
    .map((d) => d.data()).find((n) => n.type === "leadership");
  assert.ok(digestId, "a leadership digest was written");
  // The trashed task must not be counted: exactly ONE overdue / one without crew.
  assert.ok(/\b1 overdue\b/.test(digestId.body), `expected '1 overdue', got: ${digestId.body}`);
  assert.ok(/\b1 without crew\b/.test(digestId.body), `expected '1 without crew', got: ${digestId.body}`);
});
