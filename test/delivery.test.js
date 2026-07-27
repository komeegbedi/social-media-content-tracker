/* Per-channel delivery — Firestore-bound integration (emulator).
   Proves: channels are decoupled (in-app never blocks push/email); a failed
   channel persists as pending+backoff and is retried by the sweep; the
   transactional lease makes concurrent attempts send exactly once; an expired
   lease is reclaimed after a crash; a valid lease is respected.

   Senders are injected (no live FCM/Resend). Runs against the emulator:
     node --test test/delivery.test.js         (vs a running emulator)
     npm run test:emulator                     (throwaway emulator) */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Admin SDK (via lib.js) must target the emulator before it initialises. A
// dedicated project namespace keeps this file's data isolated from other emulator
// test files (node --test runs files concurrently on one emulator).
process.env.GCLOUD_PROJECT = "demo-delivery-test";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db, ensureNotification, deliverToUser } = await import("../functions/lib.js");
const { runRetry } = await import("../functions/retryDeliveries.js");

const USER = { uid: "u1", name: "Ada", status: "approved", role: "admin", email: "ada@example.com" };
const CHANNELS = ["in-app", "push", "email"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const senders = (over = {}) => ({
  push: over.push || (async () => ({ ok: true })),
  email: over.email || (async () => ({ ok: true })),
});

before(async () => { await db.collection("users").doc("u1").set(USER); });
beforeEach(async () => {
  const snap = await db.collection("notifications").get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

const mk = (id) => ensureNotification({
  id, uid: "u1", type: "assigned", title: "You've been assigned", channels: CHANNELS,
});
const get = (id) => db.collection("notifications").doc(id).get().then((s) => s.data());

// The core invariant we assert everywhere: a doc that still needs work must be
// findable by the sweep (deliveryPending ⇒ non-null nextAttemptAt).
function assertInvariant(d) {
  if (d.deliveryPending) assert.notEqual(d.nextAttemptAt, null, "deliveryPending=true must have a non-null nextAttemptAt");
  else assert.equal(d.nextAttemptAt, null);
}

test("ensureNotification is idempotent and seeds per-channel delivery state", async () => {
  const a = await mk("n1");
  const b = await mk("n1");
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  const d = await get("n1");
  assert.equal(d.delivery["in-app"].status, "sent");
  assert.equal(d.delivery.push.status, "pending");
  assert.equal(d.delivery.email.status, "pending");
  assertInvariant(d);
});

test("a failed push persists pending+backoff while email still sends (channels decoupled)", async () => {
  await mk("n2");
  const ref = db.collection("notifications").doc("n2");
  await deliverToUser(ref, USER, { senders: senders({
    push: async () => ({ ok: false, errorClass: "temporary", code: "500" }),
  }) });
  const d = await get("n2");
  assert.equal(d.delivery.push.status, "pending");
  assert.ok(d.delivery.push.nextAttemptAt > Date.now());
  assert.equal(d.delivery.email.status, "sent");
  assert.equal(d.delivery["in-app"].status, "sent");
  assertInvariant(d);
});

test("two concurrent delivery attempts send each external channel exactly once", async () => {
  await mk("n3");
  const ref = db.collection("notifications").doc("n3");
  let pushCalls = 0, emailCalls = 0;
  const slow = (counter) => async () => { counter(); await sleep(60); return { ok: true }; };
  const s = { push: slow(() => pushCalls++), email: slow(() => emailCalls++) };
  // Simulate the trigger's inline delivery racing the sweep: two callers, same doc.
  await Promise.all([
    deliverToUser(ref, USER, { senders: s }),
    deliverToUser(ref, USER, { senders: s }),
  ]);
  assert.equal(pushCalls, 1, "push must be sent exactly once");
  assert.equal(emailCalls, 1, "email must be sent exactly once");
  const d = await get("n3");
  assert.equal(d.delivery.push.status, "sent");
  assert.equal(d.delivery.email.status, "sent");
  assertInvariant(d);
});

test("a valid lease is respected — a rival attempt does not send", async () => {
  await mk("n4");
  const ref = db.collection("notifications").doc("n4");
  // Someone else holds a fresh lease on push.
  await ref.update({
    "delivery.push": { status: "processing", attempts: 1, leaseOwner: "other-exec", leaseUntil: Date.now() + 60_000 },
    deliveryPending: true, nextAttemptAt: new Date(Date.now() + 60_000),
  });
  let pushCalls = 0;
  await deliverToUser(ref, USER, { senders: senders({ push: async () => { pushCalls++; return { ok: true }; } }) });
  assert.equal(pushCalls, 0, "must not send while another lease is valid");
  const d = await get("n4");
  assert.equal(d.delivery.push.status, "processing"); // untouched
});

test("an expired lease is reclaimed after a crash and delivered", async () => {
  await mk("n5");
  const ref = db.collection("notifications").doc("n5");
  // A previous executor claimed push then crashed; its lease is now expired.
  await ref.update({
    "delivery.push": { status: "processing", attempts: 1, leaseOwner: "dead-exec", leaseUntil: Date.now() - 1000 },
    "delivery.email": { status: "sent", attempts: 1 },
    deliveryPending: true, nextAttemptAt: new Date(Date.now() - 1000),
  });
  let pushCalls = 0;
  const res = await runRetry({ senders: senders({ push: async () => { pushCalls++; return { ok: true }; } }) });
  assert.equal(res.attempted, 1);
  assert.equal(pushCalls, 1, "expired lease must be reclaimed and delivered");
  const d = await get("n5");
  assert.equal(d.delivery.push.status, "sent");
  assert.equal(d.deliveryPending, false);
  assertInvariant(d);
});

test("the sweep ignores notifications with nothing pending", async () => {
  await mk("n6");
  await db.collection("notifications").doc("n6").update({ deliveryPending: false, nextAttemptAt: null });
  const res = await runRetry({ senders: senders() });
  assert.equal(res.due, 0);
});
