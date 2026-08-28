/* Weekly Saturday task check — 9:00 PM America/Winnipeg.
   Encourages the team to confirm what they're shooting/preparing tomorrow.
   In-app + push only (never email). Idempotent per user per Saturday via
   deterministic notification ids; invalid tokens pruned by sendPush. */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions/v2");
const { db, loadUsers, notifyUsers, TZ, localToday } = require("./lib");
const { isProductionEligible } = require("./notificationPolicy");
const { eligibleAssigneeUids, indexUsersByName } = require("./assignmentIdentity");
const { resendApiKey } = require("./emailService");

const TITLE = "Review your upcoming production work";
const BODY = "Take a quick look at My Day and confirm what needs your attention for the week ahead.";

// The set of uids with ACTIVE production work (what My Day shows): tasks that are
// neither trashed nor Posted. Assignment identity follows the app's canonical rule
// (eligibleAssigneeUids): a PRESENT assigneeUids is authoritative (a present empty set
// notifies nobody — never a stale owner), an absent one derives from ownerUid +
// support[].uid, and a genuinely legacy task falls back to a UNIQUE, eligible
// OWNER-name match only (name-only crew are not authorized by Firestore and are
// skipped). QA/Admin+QA/pending/disabled/removed are never counted.
async function uidsWithActiveWork(users, byUid) {
  const snap = await db.collection("tasks").get();
  const nameIndex = indexUsersByName(users);
  const withWork = new Set();
  snap.docs.forEach((d) => {
    const t = { id: d.id, ...d.data() };
    if (t.deletedAt || t.status === "Posted") return;
    eligibleAssigneeUids(t, { byUid, nameIndex, logger, taskId: d.id }).forEach((uid) => withWork.add(uid));
  });
  return withWork;
}

async function runWeekly() {
  const { list, byUid } = await loadUsers();
  // ONLY active, approved, production-eligible users — never QA (incl. Admin+QA),
  // never pending/disabled/removed. isProductionEligible enforces all of that.
  const eligible = list.filter((u) => isProductionEligible(u));
  // Narrow to people who actually have active production work in their My Day, so
  // the Saturday nudge doesn't reach eligible-but-idle accounts (e.g. a non-QA admin
  // with nothing assigned).
  const withWork = await uidsWithActiveWork(list, byUid);
  const targets = eligible.filter((u) => withWork.has(u.uid));
  const day = localToday(); // Winnipeg-local date key -> one send per Saturday
  // notifyUsers handles the per-type opt-out, the idempotent doc, and per-channel
  // (in-app + push) delivery with retry.
  await notifyUsers(targets, {
    type: "weeklyTaskCheck", keyBase: `weeklycheck_${day}`,
    title: TITLE, body: BODY, route: "/my-day",
  });
  logger.info("weeklyTaskCheck complete", { eligible: eligible.length, targets: targets.length, day });
  return { targets: targets.length, day };
}

exports.weeklyTaskCheck = onSchedule(
  { schedule: "0 21 * * 6", timeZone: TZ, memory: "256MiB", timeoutSeconds: 300, maxInstances: 1, secrets: [resendApiKey] },
  runWeekly,
);
exports.runWeekly = runWeekly; // exposed for emulator/manual tests
