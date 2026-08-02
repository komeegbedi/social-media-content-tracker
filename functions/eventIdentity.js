/* ===================================================================
   Stable event identity for task notifications (pure).

   A notification's id must be STABLE across Firebase's retries of the same
   trigger event (so an at-least-once redelivery dedupes) yet DISTINCT for every
   later Firestore write (so a repeated In Review cycle, a reassignment, or a
   crew re-add notifies again).

   Identity is sourced from IMMUTABLE Firestore event metadata — NOT from mutable,
   client-authored task content (the activity array, display names, etc.):
     - primary : the CloudEvent id (event.id) — identical on a retry of the same
                 event, unique per write.
     - fallback: the after-snapshot commit time (after.updateTime) — the document
                 version's server timestamp, same on a redelivery, new per write.
   The basis is hashed to a truncated SHA-256 hex token so it is always a safe
   Firestore document-id component. Never Date.now(), never randomness, never
   activity-array length.

   A notification id is: `${type}_${taskId}_${eventToken}_${uid}` — the recipient
   uid is the authoritative identity; display names appear only in the copy.
   =================================================================== */
const { createHash } = require("crypto");

const TOKEN_LEN = 20; // hex chars of the truncated SHA-256 (80 bits — ample for per-task volumes)

// Normalise a Firestore Timestamp / {seconds,nanoseconds} / millis to a stable
// string, for the updateTime fallback basis.
function updateTimeBasis(updateTime) {
  if (updateTime == null) return "";
  if (typeof updateTime.toMillis === "function") return String(updateTime.toMillis());
  if (typeof updateTime.seconds === "number") return `${updateTime.seconds}.${updateTime.nanoseconds || 0}`;
  return String(updateTime);
}

// The immutable per-event token. Prefer event.id; fall back to after.updateTime.
function eventToken(eventId, updateTime) {
  const basis = eventId || updateTimeBasis(updateTime);
  if (!basis) throw new Error("eventToken: neither event.id nor updateTime available");
  return createHash("sha256").update(String(basis)).digest("hex").slice(0, TOKEN_LEN);
}

// One notification doc per (type, taskId, event, recipient). The caller
// (notifyUsers) appends `_${uid}`.
function notificationKeyBase(type, taskId, token) {
  return `${type}_${taskId}_${token}`;
}

module.exports = { eventToken, notificationKeyBase, updateTimeBasis, TOKEN_LEN };
