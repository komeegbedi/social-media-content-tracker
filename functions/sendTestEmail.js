/* Admin-only callable to verify the email pipeline end-to-end.
   Requires an authenticated admin caller and an explicit recipient — it never
   allows arbitrary public sending. Returns the Resend message id.

   Error contract: every failure throws an HttpsError with a stable code and a
   safe, user-facing message. The full original error (provider response, stack)
   is logged server-side only and never returned to the client. A bare
   "internal" should only ever mean a truly unexpected server fault. */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { db } = require("./lib");
const { resendApiKey, sendTest } = require("./emailService");

// Classified email error code -> [HttpsError code, user-facing message].
const ERROR_MAP = {
  "invalid-email":     ["invalid-argument",    "The recipient address is invalid."],
  "no-config":         ["failed-precondition", "Email delivery isn't configured on the server (missing provider key)."],
  "unverified-sender": ["failed-precondition", "The sender domain isn't verified with the email provider."],
  "provider-rejected": ["failed-precondition", "The email provider rejected the request."],
  "rate-limit":        ["resource-exhausted",  "The email provider rate limit was reached. Please try again shortly."],
  "temporary":         ["unavailable",         "The email service is temporarily unavailable. Please try again shortly."],
};

exports.sendTestEmail = onCall(
  { memory: "256MiB", timeoutSeconds: 30, secrets: [resendApiKey] },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in and try again.");

    // Authorisation — wrapped so a Firestore hiccup can't surface as bare "internal".
    let caller;
    try { caller = await db.doc(`users/${req.auth.uid}`).get(); }
    catch (e) {
      logger.error("sendTestEmail: caller lookup failed", { uid: req.auth.uid, message: String(e && e.message).slice(0, 300) });
      throw new HttpsError("unavailable", "Couldn't verify your account just now. Please try again shortly.");
    }
    if (!caller.exists || caller.data().role !== "admin")
      throw new HttpsError("permission-denied", "Only admins can send a test email.");

    const to = String((req.data && req.data.to) || "").trim();
    if (!to) throw new HttpsError("invalid-argument", "Enter a recipient email address.");

    try {
      const { messageId, to: sentTo } = await sendTest(to);
      return { ok: true, messageId, to: sentTo };
    } catch (e) {
      const mapped = ERROR_MAP[e && e.emailCode];
      // Always log the full detail securely (never returned to the client).
      logger.error("sendTestEmail failed", {
        emailCode: (e && e.emailCode) || "unknown",
        message: String((e && e.message) || e).slice(0, 300),
      });
      if (mapped) throw new HttpsError(mapped[0], mapped[1]);
      throw new HttpsError("internal", "We couldn't send the test email. The error has been logged. Please try again or check the function logs.");
    }
  },
);
