/* Delivery retry sweep — every 15 minutes.

   Re-attempts notifications whose push or email channel failed or never ran (a
   crash between channels, a transient FCM/Resend error, a token that was offline).
   Each channel carries its own state + backoff, so this only touches channels
   that are still pending and whose nextAttemptAt has passed; in-app and already-
   sent channels are left alone. maxInstances:1 so two sweeps never overlap.

   Query key: notifications where deliveryPending == true and nextAttemptAt <= now
   (composite index in firestore.indexes.json). Old notifications predating the
   delivery model lack these fields, so they never match — no migration needed. */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions/v2");
const { db, Timestamp, TZ, loadUsers, deliverToUser } = require("./lib");
const { resendApiKey } = require("./emailService");

const MAX_PER_RUN = 400; // bound the work per sweep; the next run picks up the rest

// `opts.senders` is injected in tests; production uses the real FCM/Resend senders.
async function runRetry(opts = {}) {
  const now = new Date();
  const dueSnap = await db.collection("notifications")
    .where("deliveryPending", "==", true)
    .where("nextAttemptAt", "<=", Timestamp.fromDate(now))
    .limit(MAX_PER_RUN)
    .get();
  if (dueSnap.empty) { logger.debug("retryDeliveries: nothing due"); return { due: 0, attempted: 0, orphaned: 0 }; }

  const { byUid } = await loadUsers();
  let attempted = 0, orphaned = 0;
  for (const doc of dueSnap.docs) {
    const user = byUid[doc.data().uid];
    if (!user) { orphaned++; continue; } // recipient removed → leave the doc for retention cleanup
    try { await deliverToUser(doc.ref, user, opts); attempted++; }
    catch (e) { logger.warn("retryDeliveries: deliver failed", { id: doc.id, error: String((e && e.message) || e).slice(0, 200) }); }
  }
  logger.info("retryDeliveries complete", { due: dueSnap.size, attempted, orphaned });
  return { due: dueSnap.size, attempted, orphaned };
}

exports.retryDeliveries = onSchedule(
  { schedule: "every 15 minutes", timeZone: TZ, memory: "256MiB", timeoutSeconds: 120, maxInstances: 1, secrets: [resendApiKey] },
  runRetry,
);
// Exposed for emulator/manual testing without waiting for the scheduler.
exports.runRetry = runRetry;
