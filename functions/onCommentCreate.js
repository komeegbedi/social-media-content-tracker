/* Comment trigger: notify @mentioned users. Comments live in the subcollection
   tasks/{taskId}/comments/{commentId}; a comment carries `mentions: [uid]`.
   Routed through notifyUsers so mentions fan out to in-app + push + email
   consistently with every other notification type. */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { db, loadUsers, notifyUsers, formatContentTitle } = require("./lib");
const { resendApiKey } = require("./emailService");

const truncate = (s, n = 120) => (s && s.length > n ? s.slice(0, n) + "…" : (s || ""));

exports.onCommentCreate = onDocumentCreated(
  { document: "tasks/{taskId}/comments/{commentId}", memory: "256MiB", timeoutSeconds: 30, secrets: [resendApiKey] },
  async (event) => {
    const c = event.data.data();
    const mentions = [...new Set(Array.isArray(c.mentions) ? c.mentions : [])].filter((uid) => uid !== c.uid);
    if (!mentions.length) return;

    const { taskId, commentId } = event.params;
    const taskSnap = await db.doc(`tasks/${taskId}`).get();
    const title = taskSnap.exists ? formatContentTitle(taskSnap.data().title) : "a task";
    const { byUid } = await loadUsers();
    const recipients = mentions.map((uid) => byUid[uid]).filter(Boolean);

    await notifyUsers(recipients, {
      type: "mention", taskId, keyBase: `mention_${commentId}`,
      title: `${c.who || "Someone"} mentioned you on '${title}'`,
      body: c.txt ? `"${truncate(c.txt)}"` : "",
    });
  },
);
