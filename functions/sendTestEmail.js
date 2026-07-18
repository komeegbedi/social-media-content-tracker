/* Admin-only callable to verify the email pipeline end-to-end.
   Requires an authenticated admin caller and an explicit recipient — it never
   allows arbitrary public sending. Returns the Resend message id. */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db } = require("./lib");
const { resendApiKey, sendTest, validEmail } = require("./emailService");

exports.sendTestEmail = onCall(
  { memory: "256MiB", timeoutSeconds: 30, secrets: [resendApiKey] },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    const caller = await db.doc(`users/${req.auth.uid}`).get();
    if (!caller.exists || caller.data().role !== "admin")
      throw new HttpsError("permission-denied", "Admins only.");

    const to = String((req.data && req.data.to) || "").trim();
    if (!validEmail(to)) throw new HttpsError("invalid-argument", "A valid recipient email is required.");

    try {
      const { messageId } = await sendTest(to);
      return { ok: true, messageId };
    } catch (e) {
      if (e.message === "no-secret") throw new HttpsError("failed-precondition", "RESEND_API_KEY is not configured on the server.");
      throw new HttpsError("internal", `Send failed: ${String(e.message || e).slice(0, 200)}`);
    }
  },
);
