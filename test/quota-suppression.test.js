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
const notif = (id) => ({ user: USER, type: "assigned", title: "T", body: "B", url: "/", notificationId: id });
const delivery = (id) => db.collection("emailDeliveries").doc(id).get().then((s) => s.data());
const gate = () => db.doc("systemUsage/resendQuota").get().then((s) => (s.exists ? s.data() : {}));

beforeEach(async () => {
  process.env.EMAIL_FORCE_SEND = "true";
  process.env.RESEND_API_KEY = "re_test_key";
  fetchCalls = 0;
  for (const c of ["emailDeliveries", "systemUsage", "reminderDigests", "users"]) {
    const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
});
afterEach(() => { delete process.env.EMAIL_FORCE_SEND; delete process.env.RESEND_API_KEY; globalThis.fetch = origFetch; });

test("daily_quota_exceeded → status suppressed; emailOutcome → skip:true; delivery terminal; day marked", async () => {
  globalThis.fetch = stub429("daily_quota_exceeded");
  const r = await sendNotificationEmail(notif("n-daily"));
  assert.equal(r.status, "suppressed");
  assert.equal(r.reason, "daily_quota_exceeded");
  assert.deepEqual(emailOutcome(r), { skip: true, reason: "daily_quota_exceeded" }, "mapped to skip immediately (no retry)");
  const d = await delivery("n-daily");
  assert.equal(d.status, "suppressed_quota_limit"); // terminal
  assert.equal(d.settled, true);
  assert.equal(d.reserved, false, "reservation released");
  assert.equal((await gate()).dailyExhaustedDay != null, true, "day marked exhausted");
});

test("monthly_quota_exceeded → suppressed; skip:true; month marked exhausted", async () => {
  globalThis.fetch = stub429("monthly_quota_exceeded");
  const r = await sendNotificationEmail(notif("n-monthly"));
  assert.equal(r.status, "suppressed");
  assert.deepEqual(emailOutcome(r), { skip: true, reason: "monthly_quota_exceeded" });
  const d = await delivery("n-monthly");
  assert.equal(d.status, "suppressed_quota_limit");
  assert.equal((await gate()).monthlyExhaustedMonth != null, true, "month marked exhausted");
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
