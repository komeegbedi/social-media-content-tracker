/* Maintain a privacy-safe push summary on the parent user doc whenever a
   device token is added/removed: pushDeviceCount + pushUpdatedAt. Admins read
   the user doc (allowed) to show push status — the raw tokens are never
   exposed to clients (fcmTokens stay readable only by their owner). */
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { db, FieldValue } = require("./lib");

exports.onFcmTokenWrite = onDocumentWritten(
  { document: "users/{uid}/fcmTokens/{token}", memory: "256MiB", timeoutSeconds: 30 },
  async (event) => {
    const uid = event.params.uid;
    const snap = await db.collection("users").doc(uid).collection("fcmTokens").get();
    await db.collection("users").doc(uid).set(
      { pushDeviceCount: snap.size, pushUpdatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  },
);
