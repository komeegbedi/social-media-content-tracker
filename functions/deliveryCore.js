/* ===================================================================
   Per-channel notification delivery — pure logic (no Firestore, no FCM).

   Each channel (in-app, push, email) tracks its OWN delivery state so one
   channel's success never blocks another's retry. This is the fix for the old
   coupling bug where an existing in-app notification short-circuited push and
   email forever.

   Delivery is transactional per channel (the Firestore layer in lib.js drives
   the transactions; the primitives here are pure and testable):
     claimable → claimChannel() → "processing" (+lease) → external send →
     finalizeChannel() → sent | pending(+backoff) | failed | skipped
   A lease (leaseOwner + leaseUntil) means a concurrent trigger or sweep skips a
   channel that's already in flight, and reclaims it only after the lease expires
   (crash recovery). maxInstances:1 is a throttle, NOT the concurrency guarantee.

   Channel state shape:
     { status, attempts, firstAttemptAt, lastAttemptAt, sentAt,
       nextAttemptAt, leaseOwner, leaseUntil, errorCode, errorClass, reason }
   status ∈ pending | processing | sent | failed | skipped
     - pending    : awaiting (re)try at/after nextAttemptAt
     - processing : claimed, external call in flight; reclaimable after leaseUntil
     - sent       : delivered (terminal)
     - failed     : permanent error or attempts exhausted (terminal)
     - skipped    : deliberately not sent — prefs off, no token, inactive (terminal)

   Timestamps here are epoch-millis (numbers) for deterministic testing; the
   Firestore layer converts the doc-level rollup to a Timestamp for querying.
   =================================================================== */

const TERMINAL = new Set(["sent", "failed", "skipped"]);
const isTerminal = (status) => TERMINAL.has(status);

// Bounded exponential backoff: 5m, 10m, 20m, 40m, 80m, … capped at 6h, ±20% jitter.
const BACKOFF = { baseMs: 5 * 60 * 1000, capMs: 6 * 60 * 60 * 1000, maxAttempts: 6 };
// How long a claim holds a channel before another executor may reclaim it. Long
// enough to cover an external send + commit; short enough to recover quickly.
const LEASE_MS = 2 * 60 * 1000;

function nextDelayMs(attempts, rand = Math.random) {
  const exp = Math.min(BACKOFF.baseMs * 2 ** Math.max(0, attempts - 1), BACKOFF.capMs);
  const jitter = exp * 0.2 * (rand() * 2 - 1); // ±20%
  return Math.max(0, Math.round(exp + jitter));
}

// May this channel be claimed for an attempt right now?
//   - never attempted           → yes
//   - terminal                  → no
//   - processing (lease held)   → only after the lease expires (crash recovery)
//   - pending                   → only once nextAttemptAt has passed
function isClaimable(st, nowMs) {
  if (!st) return true;
  if (isTerminal(st.status)) return false;
  if (st.status === "processing") return (st.leaseUntil || 0) <= nowMs;
  return (st.nextAttemptAt || 0) <= nowMs;
}

// Take the lease: mark processing, count the attempt, stamp owner + expiry. The
// attempt is counted HERE (not at finalize) so a crash mid-send still consumes an
// attempt and can't loop forever.
function claimChannel(prev, execId, nowMs, leaseMs = LEASE_MS) {
  const p = prev || {};
  return {
    ...p,
    status: "processing",
    attempts: (p.attempts || 0) + 1,
    firstAttemptAt: p.firstAttemptAt || nowMs,
    lastAttemptAt: nowMs,
    leaseOwner: execId,
    leaseUntil: nowMs + leaseMs,
    nextAttemptAt: null, // while processing the reclaim time is leaseUntil (see rollup)
  };
}

// Fold the send outcome into a claimed (processing) channel and release the lease.
// Attempts were already counted at claim time, so this never re-increments.
//   { ok:true }                               → sent (terminal)
//   { skip:true, reason }                     → skipped (terminal)
//   { ok:false, errorClass:"permanent", code} → failed (terminal)
//   { ok:false, errorClass:"temporary", code} → pending + backoff, or failed at max attempts
function finalizeChannel(prev, outcome, nowMs, rand = Math.random) {
  const base = { ...prev, leaseOwner: null, leaseUntil: null, lastAttemptAt: nowMs };
  if (outcome.skip) return { ...base, status: "skipped", reason: outcome.reason || "", nextAttemptAt: null };
  if (outcome.ok) return { ...base, status: "sent", sentAt: nowMs, nextAttemptAt: null, errorCode: "", errorClass: "" };
  const permanent = outcome.errorClass === "permanent";
  const exhausted = (prev.attempts || 0) >= BACKOFF.maxAttempts;
  const terminal = permanent || exhausted;
  return {
    ...base,
    status: terminal ? "failed" : "pending",
    errorCode: outcome.code || "",
    errorClass: outcome.errorClass || "temporary",
    nextAttemptAt: terminal ? null : nowMs + nextDelayMs(prev.attempts || 1, rand),
  };
}

// Mark a channel skipped without an external attempt (prefs off / inactive).
function skipChannel(prev, reason, nowMs) {
  return { ...(prev || {}), status: "skipped", reason: reason || "", leaseOwner: null, leaseUntil: null, lastAttemptAt: nowMs, nextAttemptAt: null };
}

// Doc-level rollup for the retry sweep's query. A non-terminal channel always
// contributes a concrete next time — leaseUntil while processing, else
// nextAttemptAt — which guarantees the invariant: deliveryPending == true implies
// a non-null nextAttemptAt (so the sweep can always find and reclaim it).
function rollup(delivery) {
  let deliveryPending = false;
  let nextAttemptAt = null;
  for (const ch of Object.keys(delivery)) {
    const st = delivery[ch];
    if (!st || isTerminal(st.status)) continue;
    deliveryPending = true;
    const n = st.status === "processing" ? (st.leaseUntil || 0) : (st.nextAttemptAt || 0);
    if (nextAttemptAt == null || n < nextAttemptAt) nextAttemptAt = n;
  }
  return { deliveryPending, nextAttemptAt };
}

module.exports = {
  BACKOFF, LEASE_MS, TERMINAL, isTerminal, nextDelayMs,
  isClaimable, claimChannel, finalizeChannel, skipChannel, rollup,
};
