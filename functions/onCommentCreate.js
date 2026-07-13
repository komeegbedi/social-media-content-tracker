/* Comment trigger: notify @mentioned users. Comments live in the subcollection
   tasks/{taskId}/comments/{commentId}; a comment carries `mentions: [uid]`. */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { db, loadUsers, prefsAllow, writeNotification } = require("./lib");

const truncate = (s, n = 120) => (s && s.length > n ? s.slice(0, n) + "…" : (s || ""));

exports.onCommentCreate = onDocumentCreated(
  { document: "tasks/{taskId}/comments/{commentId}", memory: "256MiB", timeoutSeconds: 30 },
  async (event) => {
    const c = event.data.data();
    const mentions = Array.isArray(c.mentions) ? c.mentions : [];
    if (!mentions.length) return;

    const { taskId, commentId } = event.params;
    const taskSnap = await db.doc(`tasks/${taskId}`).get();
    const title = taskSnap.exists ? taskSnap.data().title : "a task";
    const { byUid } = await loadUsers();

    await Promise.all([...new Set(mentions)].map((uid) => {
      if (uid === c.uid) return null;            // don't notify yourself
      const u = byUid[uid];
      if (!u || !prefsAllow(u, "mention")) return null;
      return writeNotification({
        id: `mention_${commentId}_${uid}`, uid, type: "mention", taskId,
        title: `${c.who || "Someone"} mentioned you on '${title}'`,
        body: c.txt ? `"${truncate(c.txt)}"` : "",
      });
    }));
  },
);
