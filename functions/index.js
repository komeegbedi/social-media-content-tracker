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
exports.retryDeliveries = require("./retryDeliveries").retryDeliveries;
exports.cleanupRetention = require("./cleanupRetention").cleanupRetention;
exports.weeklyTaskCheck = require("./weeklyTaskCheck").weeklyTaskCheck;
exports.onFcmTokenWrite = require("./onFcmTokenWrite").onFcmTokenWrite;
exports.sendTestEmail = require("./sendTestEmail").sendTestEmail;
exports.getEmailUsage = require("./getEmailUsage").getEmailUsage;
exports.removeUser = require("./removeUser").removeUser;
exports.bulkAssign = require("./bulkAssign").bulkAssign;
const academyCategoryDeletion = require("./academyCategoryDeletion");
exports.lockCategoryForDeletion = academyCategoryDeletion.lockCategoryForDeletion;
exports.finalizeCategoryDeletion = academyCategoryDeletion.finalizeCategoryDeletion;
exports.cancelCategoryDeletion = academyCategoryDeletion.cancelCategoryDeletion;
exports.adminOverrideStatus = require("./adminOverride").adminOverrideStatus;
exports.submitQuizAttempt = require("./academyQuiz").submitQuizAttempt;
const academyCompletion = require("./academyCompletion");
exports.completeLesson = academyCompletion.completeLesson;
exports.finishCourse = academyCompletion.finishCourse;
exports.grantQuizAttempts = academyCompletion.grantQuizAttempts;
exports.quizAttemptStatus = academyCompletion.quizAttemptStatus;
exports.requestQuizAttempt = academyCompletion.requestQuizAttempt;
exports.checkCoursePrerequisites = academyCompletion.checkCoursePrerequisites;
exports.fetchVideoMetadata = require("./videoMetadata").fetchVideoMetadata;
exports.fetchLinkMetadata = require("./linkMetadata").fetchLinkMetadata;
// Learner image access markers (storage.rules reads users + ONE marker: the
// two-document limit of Storage rules — see academyLearnerMedia.js).
const academyLearnerMedia = require("./academyLearnerMedia");
exports.onAcademyCourseMedia = academyLearnerMedia.onAcademyCourseMedia;
exports.onAcademyGuideMedia = academyLearnerMedia.onAcademyGuideMedia;
exports.onAcademyCategoryIndexMedia = academyLearnerMedia.onAcademyCategoryIndexMedia;
