/* ===================================================================
   Reminder schedule identity (pure).

   A reminderInstance id encodes a schedule REVISION so that:
     - a redelivered task write reproduces the same ids (idempotent — no dup);
     - a changed schedule (new post date or reminder config) produces NEW ids,
       even when a reminder lands on the same calendar date, so a fresh legit
       schedule is materialized WITHOUT colliding with — or destroying — the
       processed history of the old one.

   The revision is a short SHA-256 of the schedule-defining content only
   (post date + reminder-hour + the reminders' timing/recipient/channel config).
   Unrelated task edits don't churn it; any real schedule change does.
   =================================================================== */
const { createHash } = require("crypto");

const REV_LEN = 12;

// Only the fields that actually define WHEN/HOW a reminder fires feed the hash,
// in a stable shape, so cosmetic task edits don't rebuild the queue.
function scheduleRevision(postDate, reminders, hour) {
  const basis = JSON.stringify({
    postDate: postDate || "",
    hour: hour == null ? "" : hour,
    reminders: (reminders || []).map((r) => ({
      id: r.id ?? null, offset: r.offset ?? null, when: r.when ?? null,
      channels: r.channels ?? null, recipients: r.recipients ?? null, enabled: r.enabled ?? null,
    })),
  });
  return createHash("sha256").update(basis).digest("hex").slice(0, REV_LEN);
}

// Deterministic instance id: task + reminder + fire date + schedule revision.
function instanceId(taskId, rid, fireDateISO, scheduleRev) {
  return `${taskId}_${rid}_${fireDateISO}_${scheduleRev}`;
}

module.exports = { scheduleRevision, instanceId, REV_LEN };
