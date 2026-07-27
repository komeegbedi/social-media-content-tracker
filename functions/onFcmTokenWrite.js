/* Maintain a privacy-safe push summary on the parent user doc whenever a device
   token is added/removed: pushDeviceCount + pushUpdatedAt. Admins read the user
   doc (allowed) to show push status — the raw tokens are never exposed to clients
   (fcmTokens stay readable only by their owner).

   CRITICAL: this must NEVER recreate a removed/absent parent profile. `set(...,
   {merge:true})` on a missing doc would CREATE it, resurrecting a user the
   removal saga just tombstoned (its token deletions fire this very trigger). So
   we bail unless the parent exists and is active. */
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { db, FieldValue } = require("./lib");

// Testable core: refresh the push summary, but only for a LIVE parent profile.
// Returns a skip reason (no write) when the parent is gone/removed/disabled.
async function syncPushSummary(uid) {
  const parentRef = db.collection("users").doc(uid);
  const parent = await parentRef.get();
  if (!parent.exists) return "skipped-absent";
  const p = parent.data();
  if (p.status === "removed" || p.disabled === true) return "skipped-removed";
  const snap = await parentRef.collection("fcmTokens").get();
  await parentRef.set({ pushDeviceCount: snap.size, pushUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return "updated";
}

exports.onFcmTokenWrite = onDocumentWritten(
  { document: "users/{uid}/fcmTokens/{token}", memory: "256MiB", timeoutSeconds: 30 },
  async (event) => { await syncPushSummary(event.params.uid); },
);
exports.syncPushSummary = syncPushSummary; // for tests
