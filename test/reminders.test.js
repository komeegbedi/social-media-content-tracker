/* Reminder materialization — gapless, revision-safe rebuild (emulator).
   Proves: idempotent redelivery, a reschedule replaces pending without a gap,
   processed history survives a new schedule (even on the same date), and Posted
   cancels pending.

     node --test test/reminders.test.js        (vs a running emulator)
     npm run test:emulator                     (throwaway emulator) */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-reminders-test";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db } = await import("../functions/lib.js");
const { materializeReminders } = await import("../functions/onTaskWrite.js");

const TASK = "t1";
const col = () => db.collection("reminderInstances");
const task = (over = {}) => ({
  status: "In Progress", postDate: "2027-01-15",
  reminders: [{ id: "d1", offset: 3, when: "before", channels: ["in-app"], recipients: ["owner"], enabled: true }],
  ...over,
});
const instances = async () => (await col().where("taskId", "==", TASK).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

beforeEach(async () => {
  const snap = await col().where("taskId", "==", TASK).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

test("materializes one pending instance, carrying a schedule revision", async () => {
  await materializeReminders(TASK, task());
  const list = await instances();
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "pending");
  assert.ok(list[0].scheduleRev, "instance carries a scheduleRev");
});

test("a redelivered write is idempotent — same id, no duplicate", async () => {
  await materializeReminders(TASK, task());
  const first = (await instances())[0].id;
  await materializeReminders(TASK, task()); // trigger re-fires
  const list = await instances();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, first);
});

test("a reschedule replaces the pending instance (no stale pending left behind)", async () => {
  await materializeReminders(TASK, task());
  const before = (await instances())[0].id;
  await materializeReminders(TASK, task({ reminders: [{ id: "d1", offset: 5, when: "before", channels: ["in-app"], recipients: ["owner"], enabled: true }] }));
  const list = await instances();
  assert.equal(list.length, 1);                 // old pending removed, new one created
  assert.notEqual(list[0].id, before);
});

test("a new schedule on the SAME date preserves the processed history", async () => {
  await materializeReminders(TASK, task());
  const list0 = await instances();
  await col().doc(list0[0].id).update({ status: "processed", processedAt: new Date() }); // it already fired

  // Same fire date (offset unchanged) but a new schedule (channels changed) → new revision.
  await materializeReminders(TASK, task({ reminders: [{ id: "d1", offset: 3, when: "before", channels: ["in-app", "push"], recipients: ["owner"], enabled: true }] }));
  const list = await instances();
  assert.equal(list.length, 2, "processed history kept + new schedule materialized");
  assert.equal(list.filter((i) => i.status === "processed").length, 1);
  assert.equal(list.filter((i) => i.status === "pending").length, 1);
});

test("Posted cancels pending instances but keeps processed history", async () => {
  await materializeReminders(TASK, task());
  const list0 = await instances();
  // A second reminder that has already fired.
  await col().doc("t1_hist_2020-01-01_zzzz").set({ taskId: TASK, status: "processed", scheduleRev: "zzzz" });

  await materializeReminders(TASK, task({ status: "Posted" }));
  const list = await instances();
  assert.equal(list.filter((i) => i.status === "pending").length, 0); // cancelled
  assert.equal(list.filter((i) => i.status === "processed").length, 1); // history kept
  assert.ok(!list.some((i) => i.id === list0[0].id)); // the previously-pending one is gone
});
