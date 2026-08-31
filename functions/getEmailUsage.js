/* Admin-only callable: return the LAST OBSERVED Resend account email-usage for the
   diagnostics panel. Usage is captured from POST /emails responses on every send (see
   resendObservationV1.js) and stored in the sanitized adminDiagnostics/emailUsageV1 doc;
   this reads and re-sanitizes that doc — no key, no live fetch (Resend has no usage on GET).
   getObservationV1 fully validates the v1 schema, so invalid data comes back as
   providerAvailable:false with a stable reason code, never a fabricated zero. */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { db } = require("./lib");
const { getObservationV1 } = require("./resendObservationV1");

exports.getEmailUsage = onCall(
  { memory: "256MiB", timeoutSeconds: 15 },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in and try again.");
    let caller;
    try { caller = await db.doc(`users/${req.auth.uid}`).get(); }
    catch (e) {
      logger.error("getEmailUsage: caller lookup failed", { uid: req.auth.uid, message: String(e && e.message).slice(0, 200) });
      throw new HttpsError("unavailable", "Couldn't verify your account just now. Please try again shortly.");
    }
    if (!caller.exists || caller.data().role !== "admin")
      throw new HttpsError("permission-denied", "Only admins can view email usage.");

    // Reads the sanitized last-observed v1 usage; never throws (labelled snapshot on failure).
    return getObservationV1();
  },
);
