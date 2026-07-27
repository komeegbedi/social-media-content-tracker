/* Durable reminder digest — Firestore-bound (emulator).
   Proves the email requirement is durably recorded (so a crash after an instance
   is marked processed can't lose it) and flushed idempotently, retrying only
   non-terminal outcomes.

     node --test test/reminder-digest.test.js      (vs a running emulator)
     npm run test:emulator                         (throwaway emulator) */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-digest-test";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db } = await import("../functions/lib.js");
const { enqueueDigestItem, flushDigests, digestId } = await import("../functions/reminderDigest.js");

const DAY = "2026-07-27";
const byUid = { u1: { uid: "u1", name: "Ada", status: "approved", email: "ada@example.com" } };
const col = () => db.collection("reminderDigests");
const getDigest = (uid) => col().doc(digestId(uid, DAY)).get().then((s) => s.data());

beforeEach(async () => {
  const snap = await col().get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

test("enqueue durably records a pending digest; arrayUnion dedupes identical items", async () => {
  await enqueueDigestItem("u1", DAY, { taskId: "t1", title: "X", dueText: "due tomorrow" });
  await enqueueDigestItem("u1", DAY, { taskId: "t1", title: "X", dueText: "due tomorrow" }); // reclaim → no-op
  await enqueueDigestItem("u1", DAY, { taskId: "t2", title: "Y", dueText: "due today" });
  const d = await getDigest("u1");
  assert.equal(d.status, "pending");
  assert.equal(d.items.length, 2);
  assert.equal(d.notificationId, `reminderdigest_u1_${DAY}`);
});

test("flush sends a pending digest and marks it done; a second flush is a no-op", async () => {
  await enqueueDigestItem("u1", DAY, { taskId: "t1", title: "X", dueText: "due" });
  let calls = 0;
  const send = async () => { calls++; return { status: "sent" }; };
  const r1 = await flushDigests({ byUid, send });
  assert.equal(r1.sent, 1);
  assert.equal((await getDigest("u1")).status, "sent");

  const r2 = await flushDigests({ byUid, send }); // nothing pending now
  assert.equal(r2.sent, 0);
  assert.equal(calls, 1, "an already-sent digest is never re-sent");
});

test("a non-terminal (uncertain) send leaves the digest pending for retry", async () => {
  await enqueueDigestItem("u1", DAY, { taskId: "t1", title: "X", dueText: "due" });
  const r = await flushDigests({ byUid, send: async () => ({ status: "unknown" }) });
  assert.equal(r.retry, 1);
  assert.equal((await getDigest("u1")).status, "pending"); // will be retried next run

  // Later the provider resolves → sent.
  const r2 = await flushDigests({ byUid, send: async () => ({ status: "sent" }) });
  assert.equal(r2.sent, 1);
  assert.equal((await getDigest("u1")).status, "sent");
});

test("a digest for a removed recipient is closed out, not retried forever", async () => {
  await enqueueDigestItem("ghost", DAY, { taskId: "t1", title: "X", dueText: "due" });
  const r = await flushDigests({ byUid, send: async () => ({ status: "sent" }) }); // 'ghost' not in byUid
  assert.equal(r.sent, 0);
  assert.equal((await getDigest("ghost")).status, "sent");
});
