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
const { resolveMentions, resolveGroupMention } = await import("../functions/mentions.js");

const USERS = {
  author: { name: "Ada", status: "approved" },
  m1: { name: "Bo", status: "approved" },
  m2: { name: "Cy", status: "approved" },
  pend: { name: "Peg", status: "pending" },
  dis: { name: "Dana", status: "approved", disabled: true },   // approved BUT disabled
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

// Mirror onCommentCreate's FULL recipient logic: individual mentions + a group
// (@all) derived from the task's assigneeUids, merged and deduped.
async function notifyComment(commentId, authorUid, { mentions = [], mentionAll = false }, taskData) {
  const { byUid } = await loadUsers();
  const individual = mentions.length ? resolveMentions(mentions, authorUid, byUid, isActive) : [];
  const group = mentionAll ? resolveGroupMention(taskData, authorUid, byUid, isActive) : [];
  const byId = new Map();
  for (const u of [...individual, ...group]) { const id = u && (u.uid || u.id); if (id) byId.set(id, u); }
  const recipients = [...byId.values()];
  if (!recipients.length) return;
  await notifyUsers(recipients, {
    type: "mention", taskId: "t1", commentId,
    keyBase: `mention_${commentId}`, title: "Ada mentioned you", channels: ["in-app"],
  });
}

test("@all notifies the task's active assignees, excluding the author", async () => {
  const task = { assigneeUids: ["author", "m1", "m2", "pend", "ghost"] };
  await notifyComment("g1", "author", { mentionAll: true }, task);
  assert.equal(await countFor("m1"), 1);        // assignee → notified
  assert.equal(await countFor("m2"), 1);        // assignee → notified
  assert.equal(await countFor("author"), 0);    // author excluded
  assert.equal(await countFor("pend"), 0);      // unapproved assignee dropped
  assert.equal(await countFor("ghost"), 0);     // unknown dropped
});

test("individual + @all does NOT double-notify a person who is both", async () => {
  const task = { assigneeUids: ["author", "m1", "m2"] };
  await notifyComment("g2", "author", { mentions: ["m1"], mentionAll: true }, task);
  assert.equal(await countFor("m1"), 1);        // named AND in the group → exactly once
  assert.equal(await countFor("m2"), 1);
});

test("@all falls back to owner + support for a legacy task without assigneeUids", async () => {
  const task = { ownerUid: "m1", support: [{ uid: "m2" }] };   // no assigneeUids field
  await notifyComment("g3", "author", { mentionAll: true }, task);
  assert.equal(await countFor("m1"), 1);
  assert.equal(await countFor("m2"), 1);
});

test("the shared isActive treats a disabled (but approved) user as inactive", () => {
  assert.equal(isActive({ status: "approved", disabled: true }), false);
  assert.equal(isActive({ role: "admin", disabled: true }), false);
  assert.equal(isActive({ status: "approved" }), true);
});

test("a DISABLED user is never notified — individually, via @all, or both (real pipeline)", async () => {
  const task = { assigneeUids: ["author", "m1", "dis"] };
  await notifyComment("gd", "author", { mentions: ["dis"], mentionAll: true }, task);
  assert.equal(await countFor("m1"), 1);       // the active assignee
  assert.equal(await countFor("dis"), 0);      // disabled → nothing, both ways
});
