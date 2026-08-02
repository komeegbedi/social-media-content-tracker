/* Reminder schedule identity — pure.
   Run with: node --test functions/reminderSchedule.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { scheduleRevision, instanceId, REV_LEN } = require("./reminderSchedule");

const REMINDERS = [
  { id: "d1", offset: 3, when: "before", channels: ["in-app"], recipients: ["owner"], enabled: true },
];

test("scheduleRevision is a short, stable hex token for identical schedules", () => {
  const a = scheduleRevision("2026-08-01", REMINDERS, 9);
  const b = scheduleRevision("2026-08-01", JSON.parse(JSON.stringify(REMINDERS)), 9);
  assert.equal(a, b);
  assert.equal(a.length, REV_LEN);
  assert.match(a, /^[0-9a-f]+$/);
});

test("scheduleRevision changes when any schedule-defining input changes", () => {
  const base = scheduleRevision("2026-08-01", REMINDERS, 9);
  assert.notEqual(base, scheduleRevision("2026-08-02", REMINDERS, 9));                 // post date
  assert.notEqual(base, scheduleRevision("2026-08-01", REMINDERS, 10));                // hour
  assert.notEqual(base, scheduleRevision("2026-08-01", [{ ...REMINDERS[0], offset: 5 }], 9)); // offset
  assert.notEqual(base, scheduleRevision("2026-08-01", [], 9));                        // removed reminder
});

test("scheduleRevision ignores non-schedule fields", () => {
  const a = scheduleRevision("2026-08-01", REMINDERS, 9);
  const withNoise = [{ ...REMINDERS[0], label: "friendly name", note: "x" }];
  assert.equal(a, scheduleRevision("2026-08-01", withNoise, 9));
});

test("instanceId embeds the revision so a same-date reschedule gets a new id", () => {
  const rev1 = scheduleRevision("2026-08-01", REMINDERS, 9);
  const rev2 = scheduleRevision("2026-08-01", [{ ...REMINDERS[0], offset: 5 }], 9);
  const id1 = instanceId("t1", "d1", "2026-07-29", rev1);
  const id2 = instanceId("t1", "d1", "2026-07-29", rev2); // same date, new schedule
  assert.notEqual(id1, id2);
  assert.equal(instanceId("t1", "d1", "2026-07-29", rev1), id1); // deterministic
});
