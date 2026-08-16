/* Comment trigger: notify @mentioned users. Comments live in the subcollection
   tasks/{taskId}/comments/{commentId}; a comment carries `mentions: [uid]`.
   Routed through notifyUsers so mentions fan out to in-app + push + email
   consistently with every other notification type. */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { db, loadUsers, notifyUsers, formatContentTitle, isActive } = require("./lib");
const { resendApiKey } = require("./emailService");
const { resolveMentions } = require("./mentions");

const truncate = (s, n = 120) => (s && s.length > n ? s.slice(0, n) + "…" : (s || ""));

// A mention only notifies when its target task is ACTIVE: it must exist and not be
// trashed. Pure + exported so the Trash guard is unit-tested, not just asserted.
function commentTargetActive(taskExists, taskData) {
  return !!taskExists && !(taskData && taskData.deletedAt);
}
exports.commentTargetActive = commentTargetActive;

exports.onCommentCreate = onDocumentCreated(
  { document: "tasks/{taskId}/comments/{commentId}", memory: "256MiB", timeoutSeconds: 30, secrets: [resendApiKey] },
  async (event) => {
    const c = event.data.data();
    if (!Array.isArray(c.mentions) || !c.mentions.length) return;

    // Validate the client's mention list server-side: real, approved, active
    // users only; author never self-notified; duplicates collapsed. The comment
    // itself was already created — a delivery failure here never un-posts it.
    const { taskId, commentId } = event.params;
    const { byUid } = await loadUsers();
    const recipients = resolveMentions(c.mentions, c.uid, byUid, isActive);
    if (!recipients.length) return;

    const taskSnap = await db.doc(`tasks/${taskId}`).get();
    // Never notify a mention against trashed (or vanished) content. Firestore rules
    // already deny creating comments on a trashed task; this is defense-in-depth for
    // any comment created before the task was trashed, or via a trusted path.
    if (!commentTargetActive(taskSnap.exists, taskSnap.exists ? taskSnap.data() : null)) return;
    const title = formatContentTitle(taskSnap.data().title);

    await notifyUsers(recipients, {
      type: "mention", taskId, commentId, keyBase: `mention_${commentId}`,
      title: `${c.who || "Someone"} mentioned you on '${title}'`,
      body: c.txt ? `"${truncate(c.txt)}"` : "",
    });
  },
);
