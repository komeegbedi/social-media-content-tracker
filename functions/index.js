/* IFC Creatives Board — Cloud Functions entry point.

   Region: northamerica-northeast1 (Montréal) — closest to the Winnipeg team.
   minInstances is left at 0 (no idle cost); maxInstances caps runaway fan-out.
   Per-function memory/timeout are set on each definition. */
const { setGlobalOptions } = require("firebase-functions/v2");

setGlobalOptions({ region: "northamerica-northeast1", maxInstances: 10 });

exports.onTaskWrite = require("./onTaskWrite").onTaskWrite;
exports.onCommentCreate = require("./onCommentCreate").onCommentCreate;
exports.onUserWrite = require("./onUserWrite").onUserWrite;
exports.dispatchReminders = require("./dispatchReminders").dispatchReminders;
exports.cleanupRetention = require("./cleanupRetention").cleanupRetention;
exports.weeklyTaskCheck = require("./weeklyTaskCheck").weeklyTaskCheck;
exports.onFcmTokenWrite = require("./onFcmTokenWrite").onFcmTokenWrite;
exports.sendTestEmail = require("./sendTestEmail").sendTestEmail;
