/* End-to-end quota-exhaustion suppression (emulator). Proves the COMPLETE result path
   — not just classifyProviderError — for a 429 daily/monthly_quota_exceeded:
     sendNotificationEmail → _deliver → suppressed → emailOutcome skip:true (no retry),
     digest terminal on first flush, and re-invoke stays suppressed WITHOUT calling
     Resend. Uses EMAIL_FORCE_SEND + a stubbed global fetch so no real send happens.
     node --test test/quota-suppression.test.js   |   npm run test:emulator */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-quota-suppress";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const lib = await import("../functions/lib.js");
const { db, emailOutcome } = lib;
const { sendNotificationEmail, sendDigestEmail } = await import("../functions/emailService.js");
const { enqueueDigestItem, flushDigests } = await import("../functions/reminderDigest.js");

const origFetch = globalThis.fetch;
let fetchCalls = 0;
const stub429 = (name) => async () => {
  fetchCalls++;
  return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ name, message: name }) };
};

const USER = { uid: "u1", name: "Ada", email: "ada@example.com", status: "approved" };
const ADMIN = { uid: "admin1", name: "Root", email: "root@example.com", role: "admin", status: "approved" };
const notif = (id) => ({ user: USER, type: "assigned", title: "T", body: "B", url: "/", notificationId: id });
const delivery = (id) => db.collection("emailDeliveries").doc(id).get().then((s) => s.data());
const gate = () => db.doc("systemUsage/resendQuota").get().then((s) => (s.exists ? s.data() : {}));
// An admin_delivery_health notification is keyed `${keyBase}_${uid}` — prove the operational
// alert reached the seeded admin without depending on notifyUsers internals.
const alertExists = async (keyBase) =>
  (await db.collection("notifications").doc(`${keyBase}_${ADMIN.uid}`).get()).exists;
const day = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);

beforeEach(async () => {
  process.env.EMAIL_FORCE_SEND = "true";
  process.env.RESEND_API_KEY = "re_test_key";
  fetchCalls = 0;
  for (const c of ["emailDeliveries", "systemUsage", "reminderDigests", "users", "notifications"]) {
    const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
  await db.collection("users").doc(ADMIN.uid).set(ADMIN); // recipient for the operational alert
});
afterEach(() => { delete process.env.EMAIL_FORCE_SEND; delete process.env.RESEND_API_KEY; globalThis.fetch = origFetch; });

// Option A (strict current-delivery-only): a quota 429 suppresses ONLY the current delivery,
// emits the operational alert, and writes NO provider period exhaustion marker.
test("daily_quota_exceeded → suppressed; skip:true; delivery terminal; NO daily marker; alert emitted", async () => {
  globalThis.fetch = stub429("daily_quota_exceeded");
  const r = await sendNotificationEmail(notif("n-daily"));
  assert.equal(r.status, "suppressed");
  assert.equal(r.reason, "daily_quota_exceeded");
  assert.deepEqual(emailOutcome(r), { skip: true, reason: "daily_quota_exceeded" }, "mapped to skip immediately (no retry)");
  const d = await delivery("n-daily");
  assert.equal(d.status, "suppressed_quota_limit"); // terminal
  assert.equal(d.settled, true);
  assert.equal(d.reserved, false, "reservation released");
  assert.equal((await gate()).dailyExhaustedDay, undefined, "NO provider daily exhaustion marker written");
  assert.equal(await alertExists(`emaildaily_${day()}`), true, "deduped daily operational alert emitted");
});

test("monthly_quota_exceeded → suppressed; skip:true; NO monthly marker; alert emitted", async () => {
  globalThis.fetch = stub429("monthly_quota_exceeded");
  const r = await sendNotificationEmail(notif("n-monthly"));
  assert.equal(r.status, "suppressed");
  assert.deepEqual(emailOutcome(r), { skip: true, reason: "monthly_quota_exceeded" });
  const d = await delivery("n-monthly");
  assert.equal(d.status, "suppressed_quota_limit");
  assert.equal((await gate()).monthlyExhaustedMonth, undefined, "NO provider monthly exhaustion marker written");
  assert.equal(await alertExists(`emailquota_100_${month()}`), true, "deduped monthly operational alert emitted");
});

test("request-rate 429 (rate_limit_exceeded) is NOT quota → retryable (same idempotency key), no suppression, no marker", async () => {
  globalThis.fetch = stub429("rate_limit_exceeded");
  const r = await sendNotificationEmail(notif("n-rate"));
  assert.equal(r.status, "pending", "left in a retryable state, not suppressed");
  const d = await delivery("n-rate");
  assert.equal(d.settled, false, "not terminal — a retry will re-attempt");
  assert.equal(d.reserved, true, "reservation held across the retry (same idempotencyKey = notificationId)");
  assert.equal(d.idempotencyKey, "n-rate", "same idempotency key retained for the retry");
  assert.notEqual(d.status, "suppressed_quota_limit");
  const g = await gate();
  assert.equal(g.dailyExhaustedDay, undefined);
  assert.equal(g.monthlyExhaustedMonth, undefined);
});

test("concurrent quota 429s: each delivery settles independently; NO marker; alert stays deduped (one per period)", async () => {
  globalThis.fetch = stub429("daily_quota_exceeded");
  const ids = ["c1", "c2", "c3", "c4"];
  const results = await Promise.all(ids.map((i) => sendNotificationEmail(notif(i))));
  for (const r of results) { assert.equal(r.status, "suppressed"); assert.equal(r.reason, "daily_quota_exceeded"); }
  for (const i of ids) {
    const d = await delivery(i);
    assert.equal(d.status, "suppressed_quota_limit", `${i} settled on its own`);
    assert.equal(d.settled, true);
  }
  assert.equal((await gate()).dailyExhaustedDay, undefined, "no provider marker created by any concurrent 429");
  // The operational alert is deduped to ONE admin notification for the UTC-day bucket
  // (an application dedupe bucket, not a Resend reset period).
  const snap = await db.collection("notifications").where("type", "==", "admin_delivery_health").get();
  assert.equal(snap.size, 1, "exactly one deduped admin alert despite four concurrent 429s");
});

test("no retry is scheduled — the delivery is terminal (settled, not pending/unknown)", async () => {
  globalThis.fetch = stub429("daily_quota_exceeded");
  await sendNotificationEmail(notif("n-noretry"));
  const d = await delivery("n-noretry");
  assert.equal(d.settled, true);
  assert.ok(!["pending", "unknown", "processing"].includes(d.status), "not left in a retryable state");
});

test("re-invoking a quota-suppressed delivery returns suppressed WITHOUT calling Resend again", async () => {
  globalThis.fetch = stub429("daily_quota_exceeded");
  await sendNotificationEmail(notif("n-re"));
  const afterFirst = fetchCalls;
  assert.equal(afterFirst, 1);
  const r2 = await sendNotificationEmail(notif("n-re"));   // same notificationId
  assert.equal(r2.status, "suppressed", "consistently suppressed on re-invoke");
  assert.equal(fetchCalls, afterFirst, "Resend was NOT called again");
});

test("a quota-suppressed digest is marked terminal on the first flush (retry = 0)", async () => {
  globalThis.fetch = stub429("daily_quota_exceeded");
  await db.collection("users").doc(USER.uid).set(USER);
  const day = new Date().toISOString().slice(0, 10);
  await enqueueDigestItem(USER.uid, day, { taskId: "t1", title: "X", dueText: "due" });
  const { sent, retry } = await flushDigests({ byUid: { [USER.uid]: USER }, send: sendDigestEmail });
  assert.equal(retry, 0, "NOT left pending for a retry");
  assert.equal(sent, 1, "marked terminal on the first attempt");
});
