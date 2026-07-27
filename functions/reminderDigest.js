/* ===================================================================
   Durable reminder-email digest.

   Reminder in-app/push delivery is durable (it goes through notifyUsers, which
   writes a notification doc with per-channel delivery state that the retry sweep
   re-attempts). The EMAIL digest used to be accumulated in memory and sent only
   after every instance was marked "processed" — so a crash between the mark and
   the send silently lost the email.

   Now each due reminder's email requirement is written to a durable
   reminderDigests/{uid}_{day} doc BEFORE its instance is marked processed. A
   separate flush sends every pending digest (across runs, so a crash never loses
   one) idempotently — sendDigestEmail is keyed by `reminderdigest_{uid}_{day}`
   and the emailDeliveries ledger, so it can never send twice.
   =================================================================== */
const { db, FieldValue } = require("./lib");

const digestId = (uid, day) => `${uid}_${day}`;

// One line per task per day (dedupe by taskId — several reminders for the same
// task collapse to one digest row).
function dedupeDigestItems(items) {
  const byTask = new Map();
  for (const it of items || []) if (it && it.taskId && !byTask.has(it.taskId)) byTask.set(it.taskId, it);
  return [...byTask.values()];
}

// Durably record a reminder's email requirement. Idempotent via arrayUnion, so a
// reclaimed instance re-enqueuing the identical item is a no-op. A digest that was
// already sent is left "sent" — a resend would be a no-op anyway (idempotency key),
// but we avoid the churn.
async function enqueueDigestItem(uid, day, item) {
  const ref = db.collection("reminderDigests").doc(digestId(uid, day));
  await ref.set({
    uid, day, notificationId: `reminderdigest_${uid}_${day}`,
    items: FieldValue.arrayUnion(item),
    status: "pending",
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

// Send every pending digest idempotently. Terminal outcomes mark the digest done;
// retryable ones (temporary / uncertain) are left pending for the next run.
// `send` is injected in tests; defaults to the real sendDigestEmail.
async function flushDigests({ byUid, send } = {}) {
  const sendFn = send || require("./emailService").sendDigestEmail;
  const snap = await db.collection("reminderDigests").where("status", "==", "pending").limit(200).get();
  let sent = 0, retry = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const user = byUid[d.uid];
    if (!user) { await doc.ref.update({ status: "sent", note: "orphan-recipient" }); continue; }
    const items = dedupeDigestItems(d.items);
    if (!items.length) { await doc.ref.update({ status: "sent" }); continue; }
    const r = await sendFn({ user, items, notificationId: d.notificationId });
    const terminal = ["sent", "already-sent", "skipped", "suppressed"].includes(r && r.status)
      || (r && r.status === "failed" && r.permanent);
    if (terminal) { await doc.ref.update({ status: "sent", sentAt: FieldValue.serverTimestamp() }); sent++; }
    else retry++; // unknown / temporary → stays pending; retried next run (see 3C-3)
  }
  return { sent, retry };
}

module.exports = { digestId, dedupeDigestItems, enqueueDigestItem, flushDigests };
