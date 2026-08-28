/* END-TO-END mention notifications via the REAL Firestore trigger.
   ---------------------------------------------------------------------------
   Unlike test/mention-notify.test.js (which MIRRORS the trigger logic in-process),
   this writes an ACTUAL document to tasks/{taskId}/comments/{commentId} and asserts
   the notifications the DEPLOYED onCommentCreate trigger produces — proving the
   trigger WRAPPER fires and runs the whole server pipeline
   (loadUsers → resolveMentions/resolveGroupMention → notifyUsers → notification docs).

   Needs BOTH the Firestore AND Functions emulators, so it runs under its own command:
     npm run test:trigger

   No real push/email is sent: the mention policy is in-app + push, the test users
   have NO fcmTokens (sendPush skips "no-tokens"), and email is not a mention channel. */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PROJECT = process.env.GCLOUD_PROJECT || "demo-mention-trigger";
process.env.GCLOUD_PROJECT = PROJECT;
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// author + assignees + an approved outsider + excluded roles. NONE have fcmTokens.
const USERS = {
  author: { name: "Ada Author",     status: "approved", email: "author@x.com" },
  a1:     { name: "Bo One",         status: "approved", email: "a1@x.com" },
  a2:     { name: "Cy Two",         status: "approved", email: "a2@x.com" },
  a3:     { name: "Di Three",       status: "approved", email: "a3@x.com" },
  out:    { name: "Odell Outsider", status: "approved", email: "out@x.com" },
  pend:   { name: "Peg Pending",    status: "pending",  email: "pend@x.com" },
  rem:    { name: "Rex Removed",    status: "removed",  email: "rem@x.com" },
  dis:    { name: "Dana Disabled",  status: "approved", disabled: true, email: "dis@x.com" }, // approved BUT disabled
  qa:     { name: "Quinn QA",       status: "approved", qa: true, email: "qa@x.com" },
};

before(async () => { for (const [uid, u] of Object.entries(USERS)) await db.collection("users").doc(uid).set(u); });
beforeEach(async () => {
  const s = await db.collection("notifications").get();
  await Promise.all(s.docs.map((d) => d.ref.delete()));
});

const setTask = (id, data) => db.collection("tasks").doc(id).set({ title: "Launch Reel", status: "In Progress", ...data });
const postComment = (taskId, commentId, data) =>
  db.collection("tasks").doc(taskId).collection("comments").doc(commentId).set({
    uid: "author", who: "Ada Author", txt: data.txt || "hi", tm: new Date(),
    mentions: data.mentions || [],
    ...(data.mentionNames ? { mentionNames: data.mentionNames } : {}),
    ...(data.mentionRanges ? { mentionRanges: data.mentionRanges } : {}),
    ...(data.mentionAll ? { mentionAll: true } : {}),
  });
const notifsFor = async (commentId) =>
  (await db.collection("notifications").where("commentId", "==", commentId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const countForUid = async (uid) => (await db.collection("notifications").where("uid", "==", uid).get()).size;
const uidsOf = (list) => list.map((n) => n.uid).sort();

// Bounded polling — no arbitrary long sleeps; throws with the last value on timeout.
async function poll(produce, done, { timeout = 20000, interval = 200, label = "notifications" } = {}) {
  const start = Date.now(); let val;
  while (Date.now() - start < timeout) {
    val = await produce();
    if (done(val)) return val;
    await sleep(interval);
  }
  throw new Error(`Timed out (${timeout}ms) waiting for ${label}; last = ${JSON.stringify(val)}`);
}

/* 1 — INDIVIDUAL MENTION -------------------------------------------------- */
test("individual mention: mentioned user gets exactly one notification; author + others get none", async () => {
  await setTask("t1", { assigneeUids: ["author", "a1"] });
  await postComment("t1", "c1", { mentions: ["a1"], mentionNames: ["Bo One"], txt: "hey @Bo One please review" });

  await poll(() => notifsFor("c1"), (l) => l.length >= 1, { label: "c1 mention" });
  await sleep(300);                                   // settle: catch any stray extra writes
  const all = await notifsFor("c1");
  assert.deepEqual(uidsOf(all), ["a1"], "only the mentioned user is notified");
  const n = all[0];
  assert.equal(n.type, "mention");
  assert.equal(n.uid, "a1");
  assert.equal(n.taskId, "t1");
  assert.equal(n.commentId, "c1");
  assert.equal(n.id, "mention_c1_a1");               // deterministic per (comment, recipient)
  assert.ok(String(n.title).includes("Ada Author"), "author name in title");
  assert.ok(String(n.title).includes("Launch Reel"), "task title in title");
  // The Discussion deep-link the client builds from these fields (mirrors deepLinkUrl):
  assert.equal(`/content/${n.taskId}?focus=comments&comment=${n.commentId}`, "/content/t1?focus=comments&comment=c1");
  // Push was ATTEMPTED but sent nothing (no fcmTokens): its channel reaches a
  // TERMINAL state that is never "sent" (a real FCM send); in-app is delivered.
  const terminal = new Set(["skipped", "failed", "sent"]);
  const delivery = await poll(
    () => notifsFor("c1"),
    (l) => l[0] && l[0].delivery && l[0].delivery.push && terminal.has(l[0].delivery.push.status),
    { label: "c1 push finalized" }).then((l) => l[0].delivery);
  assert.notEqual(delivery.push.status, "sent", "no real push send happened (no device tokens)");
  assert.equal(delivery.push.status, "skipped", "push terminates as skipped (no-tokens)");
  assert.equal(delivery["in-app"].status, "sent");
  // The author and an approved non-recipient got nothing.
  assert.equal(await countForUid("author"), 0);
  assert.equal(await countForUid("out"), 0);
});

test("a mention whose trailing space was deleted (@Tofunmihey) still notifies exactly once", async () => {
  await setTask("tb", { assigneeUids: ["author", "a1"] });
  // The posted plain text is the separator-less "@Bo Onehey"; identity rides on
  // `mentions` (mentionRanges is rendering-only and the trigger ignores it).
  await postComment("tb", "cb", { mentions: ["a1"], mentionNames: ["Bo One"], mentionRanges: [0, 7], txt: "@Bo Onehey" });
  await poll(() => notifsFor("cb"), (l) => l.length >= 1, { label: "cb boundary" });
  await sleep(300);
  assert.deepEqual(uidsOf(await notifsFor("cb")), ["a1"], "the selected user is still notified exactly once");
});

test("an @all whose trailing space was deleted (@allnow) still notifies the assignees", async () => {
  await setTask("tba", { assigneeUids: ["author", "a1", "a2"] });
  await postComment("tba", "cba", { mentionAll: true, mentionRanges: [0, 4], txt: "@allnow" });
  await poll(() => notifsFor("cba"), (l) => l.length >= 2, { label: "cba boundary @all" });
  await sleep(300);
  assert.deepEqual(uidsOf(await notifsFor("cba")), ["a1", "a2"]);
});

/* 2 — @all ---------------------------------------------------------------- */
test("@all: every active, approved assignee is notified once; author/non-assignees/ineligible/DISABLED excluded", async () => {
  // assigneeUids carries author (self), pending, removed, DISABLED, and an unknown uid — all must drop.
  await setTask("t2", { assigneeUids: ["author", "a1", "a2", "pend", "rem", "dis", "ghostUid"] });
  await postComment("t2", "c2", { mentionAll: true, txt: "@all standup" });

  await poll(() => notifsFor("c2"), (l) => l.length >= 2, { label: "c2 @all" });
  await sleep(300);
  assert.deepEqual(uidsOf(await notifsFor("c2")), ["a1", "a2"], "author + pending/removed/disabled/unknown excluded");
  // Non-assignees (approved 'out', and QA who is never an assignee per the rules) get nothing.
  assert.equal(await countForUid("out"), 0);
  assert.equal(await countForUid("qa"), 0);
  assert.equal(await countForUid("dis"), 0, "a disabled assignee is never notified");
});

test("a DISABLED user is excluded whether named individually, via @all, or both", async () => {
  await setTask("t2d", { assigneeUids: ["author", "a1", "dis"] });
  // dis is BOTH named individually AND an assignee reachable by @all — still nothing.
  await postComment("t2d", "c2d", { mentionAll: true, mentions: ["dis"], mentionNames: ["Dana Disabled"], txt: "@all @Dana Disabled" });
  await poll(() => notifsFor("c2d"), (l) => l.length >= 1, { label: "c2d" });
  await sleep(300);
  assert.deepEqual(uidsOf(await notifsFor("c2d")), ["a1"], "only the active assignee; disabled dropped both ways");
});

test("@all recipients come from the TASK, not the client — a foreign uid in mentions[] can't ride along", async () => {
  await setTask("t2b", { assigneeUids: ["author", "a1"] });
  // Client sneaks 'out' (approved but NOT an assignee) into an individual slot AND flags @all.
  // 'out' should be notified ONLY via the individual mention path (valid, approved), while the
  // GROUP recipients are still derived from assigneeUids — proving @all ≠ client list.
  await postComment("t2b", "c2b", { mentionAll: true, mentions: ["out"], mentionNames: ["Odell Outsider"], txt: "@all + @Odell Outsider" });
  await poll(() => notifsFor("c2b"), (l) => l.length >= 2, { label: "c2b" });
  await sleep(300);
  assert.deepEqual(uidsOf(await notifsFor("c2b")), ["a1", "out"]);   // a1 from @all(task), out from individual
  // Remove 'out' from mentions and it would NOT be reachable by @all — assigneeUids is the source.
});

/* 3 — @everyone is UNSUPPORTED ------------------------------------------- */
test("@everyone is NOT a group mention: a comment with @everyone text notifies no assignees", async () => {
  // The real composer never sets mentionAll for @everyone (only @all does). A submitted
  // comment containing @everyone therefore carries no group token and no individual uid.
  await setTask("t3", { assigneeUids: ["author", "a1", "a2", "a3"] });
  await postComment("t3", "c3", { mentions: [], mentionAll: false, txt: "@everyone ship it" });
  // Sentinel: a later valid mention lands, proving the trigger processed c3 too.
  await postComment("t3", "c3b", { mentions: ["a1"], mentionNames: ["Bo One"], txt: "@Bo One" });
  await poll(() => notifsFor("c3b"), (l) => l.length >= 1, { label: "sentinel c3b" });
  await sleep(300);
  assert.equal((await notifsFor("c3")).length, 0, "@everyone notifies nobody — it is ordinary text");
});

/* 4 — DEDUP + SECURITY + >20 + missing/trashed ---------------------------- */
test("individual + @all: a user named AND in the group is notified only once", async () => {
  await setTask("t4", { assigneeUids: ["author", "a1", "a2"] });
  await postComment("t4", "c4", { mentions: ["a1"], mentionNames: ["Bo One"], mentionAll: true, txt: "@Bo One and @all" });
  await poll(() => notifsFor("c4"), (l) => l.length >= 2, { label: "c4 dedup" });
  await sleep(300);
  const all = await notifsFor("c4");
  assert.deepEqual(uidsOf(all), ["a1", "a2"]);
  assert.equal(all.filter((n) => n.uid === "a1").length, 1, "a1 (named + @all) notified exactly once");
});

test("forged / duplicate / unknown / self / unapproved individual UIDs cannot notify", async () => {
  await setTask("t5", { assigneeUids: ["author"] });
  await postComment("t5", "c5", {
    mentions: ["a1", "a1", "author", "pend", "rem", "dis", "ghost"],   // dup a1 · self · pending · removed · disabled · unknown
    mentionNames: ["Bo One"], txt: "@Bo One",
  });
  await poll(() => notifsFor("c5"), (l) => l.length >= 1, { label: "c5 security" });
  await sleep(300);
  assert.deepEqual(uidsOf(await notifsFor("c5")), ["a1"], "only the valid, approved, non-self, deduped uid");
});

test("@all with MORE THAN 20 assignees notifies them all (group not expanded into client mentions[])", async () => {
  const many = [];
  for (let i = 0; i < 25; i++) { const uid = `m${i}`; await db.collection("users").doc(uid).set({ name: `M ${i}`, status: "approved", email: `m${i}@x.com` }); many.push(uid); }
  await setTask("t6", { assigneeUids: ["author", ...many] });   // 26 incl. author
  await postComment("t6", "c6", { mentionAll: true, mentions: [], txt: "@all" });   // mentions[] EMPTY — proof the group isn't the client list
  await poll(() => notifsFor("c6"), (l) => l.length >= 25, { label: "c6 >20", timeout: 30000 });
  await sleep(500);
  assert.equal((await notifsFor("c6")).length, 25, "all 25 assignees notified (author excluded), past the 20-individual cap");
});

test("mentions on MISSING or TRASHED tasks produce no notification (sentinel-gated)", async () => {
  await postComment("ghostTask", "cMiss", { mentions: ["a1"], mentionNames: ["Bo One"] });      // no parent task
  await setTask("tTrash", { assigneeUids: ["author", "a1"], deletedAt: new Date() });
  await postComment("tTrash", "cTrash", { mentionAll: true, mentions: ["a1"], mentionNames: ["Bo One"], txt: "@all @Bo One" });
  // Sentinel: once a LATER valid mention lands, the trigger has processed the earlier
  // events too — so the two above would already have written docs if they were going to.
  await setTask("tLive", { assigneeUids: ["author", "a1"] });
  await postComment("tLive", "cLive", { mentions: ["a1"], mentionNames: ["Bo One"], txt: "@Bo One" });
  await poll(() => notifsFor("cLive"), (l) => l.length >= 1, { label: "sentinel cLive" });
  await sleep(400);
  assert.equal((await notifsFor("cMiss")).length, 0, "missing task → no notification");
  assert.equal((await notifsFor("cTrash")).length, 0, "trashed task → no notification");
});
