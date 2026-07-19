/* Weekly Saturday task check — 9:00 PM America/Winnipeg.
   Encourages the team to confirm what they're shooting/preparing tomorrow.
   In-app + push only (never email). Idempotent per user per Saturday via
   deterministic notification ids; invalid tokens pruned by sendPush. */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions/v2");
const { loadUsers, prefsAllow, pushAllow, isActive, writeNotification, sendPush, TZ, localToday } = require("./lib");

const TITLE = "Check your creative tasks for tomorrow";
const BODY = "Take a quick look at My Day and confirm whether you have anything to shoot, edit, design, or prepare.";

async function runWeekly() {
  const { list } = await loadUsers();
  const targets = list.filter((u) => isActive(u) && prefsAllow(u, "weeklyTaskCheck"));
  const day = localToday(); // Winnipeg-local date key -> one send per Saturday
  let inApp = 0, pushed = 0;
  for (const u of targets) {
    const created = await writeNotification({
      id: `weeklycheck_${day}_${u.uid}`, uid: u.uid,
      type: "weeklyTaskCheck", title: TITLE, body: BODY,
    });
    if (!created) continue; // duplicate run — already delivered
    inApp++;
    if (pushAllow(u)) { await sendPush(u.uid, { title: TITLE, body: BODY, url: "/?tab=myday" }); pushed++; }
  }
  logger.info("weeklyTaskCheck complete", { targets: targets.length, inApp, pushed, day });
  return { targets: targets.length, inApp, pushed };
}

exports.weeklyTaskCheck = onSchedule(
  { schedule: "0 21 * * 6", timeZone: TZ, memory: "256MiB", timeoutSeconds: 300, maxInstances: 1 },
  runWeekly,
);
exports.runWeekly = runWeekly; // exposed for emulator/manual tests
