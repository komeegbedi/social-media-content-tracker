/* Per-channel delivery core — pure lease/backoff primitives, incl. failure and
   crash-recovery scenarios. Pure (no Firestore, no FCM).
   Run with: node --test functions/deliveryCore.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  BACKOFF, LEASE_MS, isTerminal, nextDelayMs,
  isClaimable, claimChannel, finalizeChannel, skipChannel, rollup,
} = require("./deliveryCore");

const noJitter = () => 0.5; // rand=0.5 → zero jitter, so delays are exact for assertions

test("backoff is exponential, capped, and monotonic up to the cap", () => {
  assert.equal(nextDelayMs(1, noJitter), BACKOFF.baseMs);
  assert.equal(nextDelayMs(2, noJitter), BACKOFF.baseMs * 2);
  assert.equal(nextDelayMs(3, noJitter), BACKOFF.baseMs * 4);
  assert.equal(nextDelayMs(99, noJitter), BACKOFF.capMs); // saturates at the cap
});

/* ---- claimability (the concurrency gate) ---- */

test("isClaimable: never-attempted yes; terminal no", () => {
  assert.equal(isClaimable(undefined, 1000), true);
  for (const s of ["sent", "failed", "skipped"]) assert.equal(isClaimable({ status: s }, 1e9), false);
});

test("isClaimable: pending only once nextAttemptAt has passed", () => {
  assert.equal(isClaimable({ status: "pending", nextAttemptAt: 2000 }, 1000), false);
  assert.equal(isClaimable({ status: "pending", nextAttemptAt: 2000 }, 2000), true);
});

test("isClaimable: a valid lease blocks; an expired lease is reclaimable", () => {
  assert.equal(isClaimable({ status: "processing", leaseUntil: 5000 }, 4000), false); // lease still held
  assert.equal(isClaimable({ status: "processing", leaseUntil: 5000 }, 5000), true);  // lease expired → reclaim
});

/* ---- claim + finalize ---- */

test("claimChannel takes the lease, counts the attempt, preserves firstAttemptAt", () => {
  const st = claimChannel({ attempts: 1, firstAttemptAt: 100, nextAttemptAt: 500 }, "exec-A", 1000, LEASE_MS);
  assert.equal(st.status, "processing");
  assert.equal(st.attempts, 2);
  assert.equal(st.firstAttemptAt, 100);
  assert.equal(st.leaseOwner, "exec-A");
  assert.equal(st.leaseUntil, 1000 + LEASE_MS);
});

test("finalizeChannel: success is terminal, lease released, no re-increment", () => {
  const claimed = claimChannel({ attempts: 0 }, "A", 1000);
  const st = finalizeChannel(claimed, { ok: true }, 2000);
  assert.equal(st.status, "sent");
  assert.equal(st.attempts, 1);          // counted once, at claim
  assert.equal(st.sentAt, 2000);
  assert.equal(st.leaseOwner, null);
  assert.equal(st.nextAttemptAt, null);
});

test("finalizeChannel: temporary failure → pending with backoff, lease released", () => {
  const claimed = claimChannel({ attempts: 0 }, "A", 1000);
  const st = finalizeChannel(claimed, { ok: false, errorClass: "temporary", code: "500" }, 2000, noJitter);
  assert.equal(st.status, "pending");
  assert.equal(st.errorClass, "temporary");
  assert.equal(st.leaseUntil, null);
  assert.equal(st.nextAttemptAt, 2000 + BACKOFF.baseMs); // backoff for attempt #1
});

test("finalizeChannel: permanent failure is terminal, no retry", () => {
  const claimed = claimChannel({ attempts: 0 }, "A", 1000);
  const st = finalizeChannel(claimed, { ok: false, errorClass: "permanent", code: "422" }, 2000);
  assert.equal(st.status, "failed");
  assert.equal(st.nextAttemptAt, null);
});

test("finalizeChannel: attempts exhaust into a terminal failure", () => {
  const claimed = claimChannel({ attempts: BACKOFF.maxAttempts - 1 }, "A", 1000);
  assert.equal(claimed.attempts, BACKOFF.maxAttempts);
  const st = finalizeChannel(claimed, { ok: false, errorClass: "temporary" }, 2000);
  assert.equal(st.status, "failed");
  assert.equal(st.nextAttemptAt, null);
});

test("skipChannel marks terminal skipped without consuming an attempt", () => {
  const st = skipChannel({ attempts: 0 }, "push-off", 1000);
  assert.equal(st.status, "skipped");
  assert.equal(st.attempts, 0);
  assert.equal(st.reason, "push-off");
  assert.equal(st.nextAttemptAt, null);
});

/* ---- rollup + the deliveryPending⇒nextAttemptAt invariant ---- */

test("rollup: terminal-only → not pending, null next", () => {
  assert.deepEqual(rollup({ a: { status: "sent" }, b: { status: "skipped" }, c: { status: "failed" } }),
    { deliveryPending: false, nextAttemptAt: null });
});

test("rollup: a processing channel contributes its leaseUntil as the next time", () => {
  const r = rollup({ a: { status: "sent" }, b: { status: "processing", leaseUntil: 7000 } });
  assert.equal(r.deliveryPending, true);
  assert.equal(r.nextAttemptAt, 7000);
});

test("rollup invariant: deliveryPending true always yields a non-null nextAttemptAt", () => {
  const samples = [
    { p: { status: "pending", nextAttemptAt: 300 } },
    { p: { status: "processing", leaseUntil: 900 }, q: { status: "pending", nextAttemptAt: 400 } },
    { p: { status: "sent" }, q: { status: "pending", nextAttemptAt: 50 } },
  ];
  for (const d of samples) {
    const r = rollup(d);
    if (r.deliveryPending) assert.notEqual(r.nextAttemptAt, null);
  }
  // earliest across channels wins
  assert.equal(rollup(samples[1]).nextAttemptAt, 400);
});
