/* Email quota reservation lifecycle (emulator).
   Proves a delivery holds exactly ONE reservation across retries (no leak), that
   it settles exactly once (no double-release), and that reconcile gives up on
   stale unresolved deliveries — releasing that one reservation, guarded.

     node --test test/email-quota.test.js      (vs a running emulator)
     npm run test:emulator                     (throwaway emulator) */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-quota-test";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db, Timestamp } = await import("../functions/lib.js");
const quota = await import("../functions/emailQuota.js");

const period = quota.periods();
const mRef = () => db.doc(`systemUsage/email-${period.month}`);
const dRef = () => db.doc(`systemUsage/emailDaily-${period.day}`);
const del = (id) => db.collection("emailDeliveries").doc(id);
const usage = async () => ({
  m: (await mRef().get()).data() || {},
  d: (await dRef().get()).data() || {},
});
// A delivery record as claimDelivery would create it (processing, not yet reserved).
const seedDelivery = (id, over = {}) => del(id).set({ status: "processing", attemptCount: 1, reserved: false, settled: false, ...over });

beforeEach(async () => {
  for (const c of ["emailDeliveries", "systemUsage"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((x) => x.ref.delete()));
  }
});

test("a delivery reserves exactly once, even across repeated attempts", async () => {
  await seedDelivery("n1");
  const r1 = await quota.reserve({ type: "reminder", period, deliveryRef: del("n1") });
  assert.equal(r1.allowed, true);
  const r2 = await quota.reserve({ type: "reminder", period, deliveryRef: del("n1") }); // retry
  assert.equal(r2.already, true);                 // idempotent — no second reservation
  const u = await usage();
  assert.equal(u.m.reservedCount, 1, "reserved exactly once");
  assert.equal((await del("n1").get()).data().reserved, true);
});

test("settle sent commits the one reservation exactly once", async () => {
  await seedDelivery("n2");
  await quota.reserve({ type: "reminder", period, deliveryRef: del("n2") });
  const a = await quota.settleReservation(del("n2"), "sent", period, { status: "sent" });
  assert.equal(a.settled, true);
  let u = await usage();
  assert.equal(u.m.reservedCount, 0);
  assert.equal(u.m.sentCount, 1);
  // A second settle is a no-op — no double count.
  const b = await quota.settleReservation(del("n2"), "sent", period, { status: "sent" });
  assert.equal(b.settled, false);
  u = await usage();
  assert.equal(u.m.reservedCount, 0);
  assert.equal(u.m.sentCount, 1);
});

test("a reservation cannot be double-released", async () => {
  await seedDelivery("n3");
  await quota.reserve({ type: "reminder", period, deliveryRef: del("n3") });
  await quota.settleReservation(del("n3"), "release", period, { status: "failed" });
  await quota.settleReservation(del("n3"), "release", period, { status: "failed" }); // again
  const u = await usage();
  assert.equal(u.m.reservedCount, 0, "released once, not below zero / not twice");
});

test("reconcile gives up on a stale unresolved delivery, releasing once; spares fresh ones", async () => {
  // Stale unknown (reserved, past grace).
  await seedDelivery("stale");
  await quota.reserve({ type: "reminder", period, deliveryRef: del("stale") });
  await del("stale").update({ status: "unknown", reservedAt: Timestamp.fromMillis(Date.now() - 10 * 60 * 1000) });
  // Fresh unknown (reserved, within grace).
  await seedDelivery("fresh");
  await quota.reserve({ type: "reminder", period, deliveryRef: del("fresh") });
  await del("fresh").update({ status: "unknown" }); // reservedAt stays ~now

  const released = await quota.reconcile(60 * 1000); // 1-minute grace
  assert.equal(released, 1);
  assert.equal((await del("stale").get()).data().settled, true);
  assert.equal((await del("fresh").get()).data().settled ?? false, false, "fresh one still awaiting retry");

  // Reconcile again → the stale one is already settled, nothing more released.
  assert.equal(await quota.reconcile(60 * 1000), 0);
});

test("quota denial suppresses and settles without holding a reservation", async () => {
  await mRef().set({ provider: "resend", period: period.month, monthlyLimit: 1, sentCount: 1, reservedCount: 0 });
  await seedDelivery("blocked");
  const r = await quota.reserve({ type: "reminder", period, deliveryRef: del("blocked") });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "monthly_limit");
  const d = (await del("blocked").get()).data();
  assert.equal(d.settled, true);
  assert.equal(d.reserved, false);
  assert.equal(d.status, "suppressed_quota_limit");
});
