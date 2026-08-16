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

/* SCENARIO A — MATERIALIZATION (scheduling side). Trashing a task cancels its
   pending reminder instances at (re)build time so none survive to be dispatched;
   restore rebuilds only the valid FUTURE schedule. (Scenario B — a due instance the
   dispatcher claims for an already-trashed task — is in test/reminders-trash.test.js.) */
test("Scenario A · Trash cancels pending reminder instances (status preserved, not Posted)", async () => {
  await materializeReminders(TASK, task());
  assert.equal((await instances()).filter((i) => i.status === "pending").length, 1);
  // Soft-delete: deletedAt present, status is STILL the working status (not Posted).
  await materializeReminders(TASK, task({ deletedAt: new Date() }));
  assert.equal((await instances()).filter((i) => i.status === "pending").length, 0);
});

test("Scenario A · Restore recreates only valid FUTURE instances and preserves processed history", async () => {
  await materializeReminders(TASK, task());
  const list0 = await instances();
  await col().doc(list0[0].id).update({ status: "processed", processedAt: new Date() }); // one already fired
  // A separate future reminder that is pending when we trash.
  await materializeReminders(TASK, task({ reminders: [
    { id: "d1", offset: 3, when: "before", channels: ["in-app"], recipients: ["owner"], enabled: true },
    { id: "d2", offset: 1, when: "before", channels: ["in-app"], recipients: ["owner"], enabled: true },
  ] }));
  assert.ok((await instances()).filter((i) => i.status === "pending").length >= 1);

  // Trash → all pending cancelled, processed kept.
  await materializeReminders(TASK, task({ deletedAt: new Date(), reminders: [
    { id: "d1", offset: 3, when: "before", channels: ["in-app"], recipients: ["owner"], enabled: true },
    { id: "d2", offset: 1, when: "before", channels: ["in-app"], recipients: ["owner"], enabled: true },
  ] }));
  let list = await instances();
  assert.equal(list.filter((i) => i.status === "pending").length, 0, "trash cancels all pending");
  assert.equal(list.filter((i) => i.status === "processed").length, 1, "processed history survives trash");

  // Restore (deletedAt cleared) → future schedule rebuilt, processed history intact.
  await materializeReminders(TASK, task({ reminders: [
    { id: "d1", offset: 3, when: "before", channels: ["in-app"], recipients: ["owner"], enabled: true },
    { id: "d2", offset: 1, when: "before", channels: ["in-app"], recipients: ["owner"], enabled: true },
  ] }));
  list = await instances();
  assert.ok(list.filter((i) => i.status === "pending").length >= 1, "restore recreates future reminders");
  assert.equal(list.filter((i) => i.status === "processed").length, 1, "processed history still intact after restore");
});
