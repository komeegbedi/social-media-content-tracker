/* Comment trigger: notify @mentioned users. Comments live in the subcollection
   tasks/{taskId}/comments/{commentId}; a comment carries `mentions: [uid]`.
   Routed through notifyUsers so mentions fan out to in-app + push + email
   consistently with every other notification type. */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { db, loadUsers, notifyUsers, formatContentTitle, isActive } = require("./lib");
const { resendApiKey } = require("./emailService");
const { resolveMentions } = require("./mentions");

const truncate = (s, n = 120) => (s && s.length > n ? s.slice(0, n) + "…" : (s || ""));

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
    const title = taskSnap.exists ? formatContentTitle(taskSnap.data().title) : "a task";

    await notifyUsers(recipients, {
      type: "mention", taskId, commentId, keyBase: `mention_${commentId}`,
      title: `${c.who || "Someone"} mentioned you on '${title}'`,
      body: c.txt ? `"${truncate(c.txt)}"` : "",
    });
  },
);
