/* Weekly Saturday task check — 9:00 PM America/Winnipeg.
   Encourages the team to confirm what they're shooting/preparing tomorrow.
   In-app + push only (never email). Idempotent per user per Saturday via
   deterministic notification ids; invalid tokens pruned by sendPush. */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions/v2");
const { loadUsers, isActive, notifyUsers, TZ, localToday } = require("./lib");
const { resendApiKey } = require("./emailService");

const TITLE = "Check your creative tasks for tomorrow";
const BODY = "Take a quick look at My Day and confirm whether you have anything to shoot, edit, design, or prepare.";

async function runWeekly() {
  const { list } = await loadUsers();
  const targets = list.filter((u) => isActive(u));
  const day = localToday(); // Winnipeg-local date key -> one send per Saturday
  // notifyUsers handles the per-type opt-out, the idempotent doc, and per-channel
  // (in-app + push) delivery with retry — no more manual writeNotification/sendPush
  // coupling that dropped push if the in-app doc already existed.
  await notifyUsers(targets, {
    type: "weeklyTaskCheck", keyBase: `weeklycheck_${day}`,
    title: TITLE, body: BODY, route: "/my-day",
  });
  logger.info("weeklyTaskCheck complete", { targets: targets.length, day });
  return { targets: targets.length, day };
}

exports.weeklyTaskCheck = onSchedule(
  { schedule: "0 21 * * 6", timeZone: TZ, memory: "256MiB", timeoutSeconds: 300, maxInstances: 1, secrets: [resendApiKey] },
  runWeekly,
);
exports.runWeekly = runWeekly; // exposed for emulator/manual tests
