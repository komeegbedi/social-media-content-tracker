/* Event identity — end-to-end at the data layer (emulator).
   Drives notifyUsers with keys composed exactly as onTaskWrite does — from the
   event token — and asserts the notification docs that result. Proves the full
   dedup vs. notify-again contract.

     node --test test/notify-identity.test.js      (vs a running emulator)
     npm run test:emulator                         (throwaway emulator) */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// A dedicated project namespace so this file's data never collides with other
// emulator test files (the suite runs with --test-concurrency=1, one at a time).
process.env.GCLOUD_PROJECT = "demo-identity-test";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db, notifyUsers } = await import("../functions/lib.js");
const { eventToken, notificationKeyBase } = await import("../functions/eventIdentity.js");

const QA = { uid: "qa1", name: "Quinn", status: "approved", role: "admin" };
const A = { uid: "ua", name: "Ada", status: "approved", role: "member" };
const B = { uid: "ub", name: "Bo", status: "approved", role: "member" };
const TASK = "t1";

before(async () => {
  for (const u of [QA, A, B]) await db.collection("users").doc(u.uid).set(u);
});
beforeEach(async () => {
  const snap = await db.collection("notifications").get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

const countFor = async (uid) => (await db.collection("notifications").where("uid", "==", uid).get()).size;

// Mirror onTaskWrite: build the key from the event token, deliver in-app only so
// the test counts documents without push/email noise.
const fire = (eventId, type, recipients) =>
  notifyUsers(recipients, {
    type, taskId: TASK, title: "x", channels: ["in-app"],
    keyBase: notificationKeyBase(type, TASK, eventToken(eventId)),
  });

test("the same event id retried twice produces one notification", async () => {
  await fire("evt-1", "qa", [QA]);
  await fire("evt-1", "qa", [QA]); // Firebase redelivers the identical event
  assert.equal(await countFor("qa1"), 1);
});

test("two distinct event ids with identical task contents produce distinct notifications", async () => {
  await fire("evt-1", "qa", [QA]);
  await fire("evt-2", "qa", [QA]); // different write, same task/type/recipient
  assert.equal(await countFor("qa1"), 2);
});

test("A→B→A→B owner cycles notify on every legitimate assignment", async () => {
  await fire("evt-a1", "assigned", [A]); // ∅ → A
  await fire("evt-b1", "assigned", [B]); // A → B
  await fire("evt-a2", "assigned", [A]); // B → A
  await fire("evt-b2", "assigned", [B]); // A → B
  assert.equal(await countFor("ua"), 2);
  assert.equal(await countFor("ub"), 2);
});

test("crew removal and re-add without a status transition notifies again", async () => {
  await fire("evt-add1", "assigned", [B]);  // added
  // (a separate write removes B — no notification)
  await fire("evt-add2", "assigned", [B]);  // re-added by a later write → new event
  assert.equal(await countFor("ub"), 2);
});

test("a repeated In Review cycle notifies QA again", async () => {
  await fire("evt-review1", "qa", [QA]);    // In Review
  // (Changes Requested, then submitted again — a distinct later write)
  await fire("evt-review2", "qa", [QA]);
  assert.equal(await countFor("qa1"), 2);
});

test("multiple notification types from one task write do not collide", async () => {
  // One write (one event id) that both assigns QA as owner AND moves to In Review.
  await fire("evt-multi", "assigned", [QA]);
  await fire("evt-multi", "qa", [QA]);
  assert.equal(await countFor("qa1"), 2); // distinct types → two docs, no collision
});
