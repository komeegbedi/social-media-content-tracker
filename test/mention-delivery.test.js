/* Mention DELIVERY channels — Firestore-bound, mocked providers (emulator).
   Complements test/delivery.test.js (which proves the generic channel mechanics —
   decoupling, no-dup, exactly-once, lease) by pinning the MENTION type's policy and
   the per-preference channel gating. Senders are INJECTED — no live FCM/Resend.

     node --test test/mention-delivery.test.js     (vs a running emulator)
     npm run test:emulator                          (throwaway emulator) */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-mention-delivery";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db, notifyUsers, ensureNotification, deliverToUser } = await import("../functions/lib.js");

const base = { uid: "u1", name: "Ada", status: "approved", email: "ada@example.com" };
const noteRef = (id) => db.collection("notifications").doc(id);

before(async () => {
  await db.collection("users").doc("u1").set(base);
  // A device token so push has something to send to (unless a pref/skip intervenes).
  await db.collection("users").doc("u1").collection("fcmTokens").doc("tok1").set({ createdAt: Date.now() });
});
beforeEach(async () => {
  const s = await db.collection("notifications").get();
  await Promise.all(s.docs.map((d) => d.ref.delete()));
});

test("a mention notification uses the in-app + push policy (email is NOT a mention channel)", async () => {
  await notifyUsers([base], { type: "mention", keyBase: "mention_cA", taskId: "t", commentId: "cA", title: "X mentioned you" });
  const d = (await noteRef("mention_cA_u1").get()).data();
  assert.deepEqual(d.channels, ["in-app", "push"]);
  assert.equal(d.delivery["in-app"].status, "sent");
  assert.ok(d.delivery.push, "push channel is seeded");
  assert.equal(d.delivery.email, undefined, "email is not attempted for mentions");
});

test("push disabled in prefs: in-app still delivered, push skipped, sender never called", async () => {
  const pushOff = { ...base, notifPrefs: { push: false } };
  const { ref } = await ensureNotification({ id: "m_off_u1", uid: "u1", type: "mention", title: "hi", channels: ["in-app", "push"] });
  let pushCalls = 0;
  await deliverToUser(ref, pushOff, { senders: { push: async () => { pushCalls++; return { ok: true }; }, email: async () => ({ ok: true }) } });
  const d = (await ref.get()).data();
  assert.equal(pushCalls, 0, "push sender must not be called when the user disabled push");
  assert.equal(d.delivery.push.status, "skipped");
  assert.equal(d.delivery["in-app"].status, "sent");
});

test("a per-type mention opt-out suppresses the notification entirely (no in-app doc)", async () => {
  const muted = { ...base, notifPrefs: { perType: { mention: false } } };
  await notifyUsers([muted], { type: "mention", keyBase: "mention_muted", taskId: "t", commentId: "cM", title: "X mentioned you" });
  const snap = await noteRef("mention_muted_u1").get();
  assert.equal(snap.exists, false, "a type-level mention opt-out writes no notification at all");
});

test("push failure on a mention does not duplicate the doc or drop the in-app copy", async () => {
  const { ref } = await ensureNotification({ id: "m_fail_u1", uid: "u1", type: "mention", title: "hi", channels: ["in-app", "push"] });
  await deliverToUser(ref, base, { senders: { push: async () => { throw new Error("fcm down"); }, email: async () => ({ ok: true }) } });
  const d = (await ref.get()).data();
  assert.equal(d.delivery["in-app"].status, "sent", "in-app is unaffected by a push failure");
  assert.equal(d.delivery.push.status, "pending", "failed push stays pending for the retry sweep");
  assert.ok(d.delivery.push.nextAttemptAt > Date.now(), "failed push is backed off, not lost");
  const dupes = await db.collection("notifications").where("uid", "==", "u1").where("commentId", "==", "").get();
  assert.equal((await db.collection("notifications").get()).size, 1, "still exactly one notification doc");
});
