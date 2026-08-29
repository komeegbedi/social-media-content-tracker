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

/* ---- account-aware gate: Resend usage + local reservations vs the PLAN limit ---- */
const rqRef = () => db.doc("systemUsage/resendQuota");
const setResend = (monthlyUsed, ageMs = 0) =>
  rqRef().set({ provider: "resend", monthlyUsed, observedAt: new Date(Date.now() - ageMs).toISOString() });

test("CONTAINMENT: a bounded provider account value does NOT suppress while header semantics are unproven", async () => {
  // Even a header at plan capacity (3000) must not drive suppression in the interim — it is
  // not proven to be a "used" count. The local safety cap alone governs. (Once semantics are
  // proven, the account-aware deny — resend_account_limit — is re-enabled with the flag.)
  await setResend(3000);
  await seedDelivery("acc");
  const r = await quota.reserve({ type: "assigned", priority: "critical", period, deliveryRef: del("acc") });
  assert.equal(r.allowed, true, "provider header ignored; local cap has room");
});

test("reserve ALLOWS when the Resend snapshot is comfortably under the plan limit", async () => {
  await setResend(10);
  await seedDelivery("ok");
  const r = await quota.reserve({ type: "reminder", period, deliveryRef: del("ok") });
  assert.equal(r.allowed, true);
});

test("a STALE Resend snapshot is ignored by the gate (fail-safe → local cap governs)", async () => {
  await setResend(3000, 30 * 60 * 1000); // 30 min old → past the 15-min gate window
  await seedDelivery("stalegate");
  const r = await quota.reserve({ type: "reminder", period, deliveryRef: del("stalegate") });
  assert.equal(r.allowed, true, "an old account snapshot doesn't block sending");
});

test("no Resend snapshot at all → sending still works (fail-safe preserved)", async () => {
  await seedDelivery("nosnap");
  const r = await quota.reserve({ type: "reminder", period, deliveryRef: del("nosnap") });
  assert.equal(r.allowed, true);
});

test("concurrent reservations near the local safety cap never overshoot it", async () => {
  // App safety cap = 2800; seed at 2798 so only 2 more may reserve.
  await mRef().set({ provider: "resend", period: period.month, monthlyLimit: 2800, sentCount: 2798, reservedCount: 0 });
  for (let i = 0; i < 6; i++) await seedDelivery(`c${i}`);
  const results = await Promise.all(
    [0, 1, 2, 3, 4, 5].map((i) => quota.reserve({ type: "assigned", priority: "critical", period, deliveryRef: del(`c${i}`) })),
  );
  const allowed = results.filter((r) => r.allowed).length;
  assert.equal(allowed, 2, "exactly the remaining budget is granted; the rest are denied");
  const m = (await mRef().get()).data();
  assert.ok((m.sentCount + m.reservedCount) <= 2800, "never overshoots the safety cap");
});

/* ---- daily safety cap (default 90) + provider daily-exhausted gate ---- */
test("the 91st app send is suppressed when the daily safety cap is 90", async () => {
  // No explicit dailyLimit on the day doc → the reserve gate uses DAILY_LIMIT (90).
  await dRef().set({ provider: "resend", period: period.day, dailyLimit: 90, sentCount: 90, reservedCount: 0 });
  await seedDelivery("d91");
  const r = await quota.reserve({ type: "reminder", period, deliveryRef: del("d91") });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "daily_limit", "91st send blocked at the 90/day safety cap");
});

test("a provider daily_quota_exceeded marks the day exhausted → further sends suppressed", async () => {
  await rqRef().set({ dailyExhaustedDay: period.day, observedAt: new Date().toISOString() });
  await seedDelivery("dex");
  const r = await quota.reserve({ type: "assigned", priority: "critical", period, deliveryRef: del("dex") });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "resend_daily_exhausted");
});

test("a stale/other-day exhausted marker does not block today", async () => {
  await rqRef().set({ dailyExhaustedDay: "2000-01-01", observedAt: new Date().toISOString() });
  await seedDelivery("dok");
  const r = await quota.reserve({ type: "reminder", period, deliveryRef: del("dok") });
  assert.equal(r.allowed, true);
});

/* ---- provider MONTHLY exhaustion (persistent, age-independent) ---- */
test("a current-month exhausted marker blocks sends even when no fresh observation exists", async () => {
  // Marker only — NO observedAt (snapshot 'stale'/absent). Must still block.
  await rqRef().set({ monthlyExhaustedMonth: period.month });
  await seedDelivery("mex");
  const r = await quota.reserve({ type: "assigned", priority: "critical", period, deliveryRef: del("mex") });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "resend_monthly_exhausted");
});

test("a PREVIOUS-month exhausted marker does not block the current month", async () => {
  await rqRef().set({ monthlyExhaustedMonth: "2000-01" });
  await seedDelivery("mok");
  const r = await quota.reserve({ type: "reminder", period, deliveryRef: del("mok") });
  assert.equal(r.allowed, true);
});

test("markMonthlyExhausted persists the marker for the current month", async () => {
  await quota.markMonthlyExhausted(period.month);
  const doc = (await rqRef().get()).data();
  assert.equal(doc.monthlyExhaustedMonth, period.month);
});

/* ---- a structurally invalid provider observation must NOT block email ---- */
test("a poisoned Resend snapshot (used > plan) is IGNORED by the reserve gate (email not blocked)", async () => {
  await rqRef().set({ monthlyUsed: 3001, observedAt: new Date().toISOString() }); // impossible value
  await seedDelivery("poison");
  const r = await quota.reserve({ type: "reminder", period, deliveryRef: del("poison") });
  assert.equal(r.allowed, true, "invalid provider value must not suppress sends");
});
