/* Mention notifications — end-to-end at the data layer (emulator).
   Exercises the real resolveMentions + loadUsers + notifyUsers path (everything
   the onCommentCreate trigger does but the event wrapper): duplicate/self/
   unapproved mentions are filtered, and a re-fired trigger dedupes.

     node --test test/mention-notify.test.js      (vs a running emulator)
     npm run test:emulator                        (throwaway emulator) */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-mention-test";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db, notifyUsers, loadUsers, isActive } = await import("../functions/lib.js");
const { resolveMentions } = await import("../functions/mentions.js");

const USERS = {
  author: { name: "Ada", status: "approved" },
  m1: { name: "Bo", status: "approved" },
  pend: { name: "Peg", status: "pending" },
};

before(async () => { for (const [id, u] of Object.entries(USERS)) await db.collection("users").doc(id).set(u); });
beforeEach(async () => {
  const snap = await db.collection("notifications").get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

const countFor = async (uid) => (await db.collection("notifications").where("uid", "==", uid).get()).size;

// Mirror onCommentCreate (minus the trigger wrapper), using the real helpers.
async function notifyMention(commentId, authorUid, mentions) {
  const { byUid } = await loadUsers();
  const recipients = resolveMentions(mentions, authorUid, byUid, isActive);
  if (!recipients.length) return;
  await notifyUsers(recipients, {
    type: "mention", taskId: "t1", commentId,
    keyBase: `mention_${commentId}`, title: "Ada mentioned you", channels: ["in-app"],
  });
}

test("only approved, non-self, deduped mentions are notified", async () => {
  await notifyMention("c1", "author", ["m1", "m1", "author", "pend", "ghost"]);
  assert.equal(await countFor("m1"), 1);      // approved teammate → notified once
  assert.equal(await countFor("author"), 0);  // self → never
  assert.equal(await countFor("pend"), 0);    // unapproved → dropped server-side
});

test("a re-fired comment trigger dedupes to one notification", async () => {
  await notifyMention("c2", "author", ["m1"]);
  await notifyMention("c2", "author", ["m1"]); // Firebase redelivers the create event
  assert.equal(await countFor("m1"), 1);
});
