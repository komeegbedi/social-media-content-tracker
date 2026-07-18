/* Daily retention cleanup so the notification collections don't grow forever.

   Retention windows:
     reminderInstances (terminal)  90 days   (by processedAt)
     notifications (read)          180 days
     emailDeliveries (sent/suppr.) 90 days ; everything else 180 days
     fcmTokens (not seen)          180 days
     systemUsage/emailDaily-*      90 days   (monthly usage kept)
   Runs at 03:00 America/Winnipeg. Deletes in bounded batches. */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions/v2");
const { db, Timestamp, TZ } = require("./lib");

const DAY = 86400000;
const olderThan = (ts, cutoffMs) => !!(ts && ts.toMillis && ts.toMillis() < cutoffMs);

async function deleteDocs(docs) {
  let n = 0;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
    n += Math.min(400, docs.length - i);
  }
  return n;
}

async function runCleanup() {
  const now = Date.now();
  const c90 = now - 90 * DAY, c180 = now - 180 * DAY;
  const out = {};

  // Reminder instances in a terminal state, processed/failed > 90d ago.
  {
    const snap = await db.collection("reminderInstances")
      .where("processedAt", "<", Timestamp.fromMillis(c90)).limit(500).get();
    out.reminderInstances = await deleteDocs(snap.docs);
  }
  // Read notifications older than 180d (unread are kept regardless of age).
  {
    const snap = await db.collection("notifications")
      .where("createdAt", "<", Timestamp.fromMillis(c180)).limit(500).get();
    out.notifications = await deleteDocs(snap.docs.filter((d) => d.data().read === true));
  }
  // Email delivery log: sent/suppressed/skipped > 90d; anything else > 180d.
  {
    const s90 = await db.collection("emailDeliveries")
      .where("createdAt", "<", Timestamp.fromMillis(c90)).limit(500).get();
    const shed = ["sent", "suppressed_quota_limit", "skipped"];
    const del = s90.docs.filter((d) => shed.includes(d.data().status));
    const s180 = await db.collection("emailDeliveries")
      .where("createdAt", "<", Timestamp.fromMillis(c180)).limit(500).get();
    const seen = new Set(del.map((d) => d.id));
    s180.docs.forEach((d) => { if (!seen.has(d.id)) { del.push(d); seen.add(d.id); } });
    out.emailDeliveries = await deleteDocs(del);
  }
  // FCM tokens not seen in 180d (collection group across all users).
  {
    const snap = await db.collectionGroup("fcmTokens").limit(1000).get();
    out.fcmTokens = await deleteDocs(snap.docs.filter((d) => olderThan(d.data().lastSeen, c180)));
  }
  // Old daily usage docs (>90d). Monthly usage is retained.
  {
    const snap = await db.collection("systemUsage").get();
    const cutDay = new Date(c90).toISOString().slice(0, 10);
    const del = snap.docs.filter((d) => d.id.startsWith("emailDaily-") && d.id.slice("emailDaily-".length) < cutDay);
    out.dailyUsage = await deleteDocs(del);
  }

  logger.info("retention cleanup complete", out);
  return out;
}

exports.cleanupRetention = onSchedule(
  { schedule: "0 3 * * *", timeZone: TZ, memory: "256MiB", timeoutSeconds: 300, maxInstances: 1 },
  runCleanup,
);
exports.runCleanup = runCleanup; // exposed for tests / manual runs
