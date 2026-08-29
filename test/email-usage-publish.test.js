/* Real-time publish behavior (emulator): a successful app send (notification, digest,
   test) publishes the SANITIZED adminDiagnostics/emailUsage doc; failed / suppressed /
   header-less sends do NOT publish a false observation. Uses EMAIL_FORCE_SEND + a
   stubbed global fetch so no real send happens.
     node --test test/email-usage-publish.test.js   |   npm run test:emulator */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-usage-publish";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db } = await import("../functions/lib.js");
const { sendNotificationEmail, sendDigestEmail, sendTest } = await import("../functions/emailService.js");
const { enqueueDigestItem, flushDigests } = await import("../functions/reminderDigest.js");
const { PUBLIC_DOC } = await import("../functions/resendUsage.js");

const origFetch = globalThis.fetch;
let fetchCalls = 0;
const resWith = (status, headers = {}, body = { id: "m1" }) => {
  const low = {}; for (const [k, v] of Object.entries(headers)) low[k.toLowerCase()] = String(v);
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => (low[String(k).toLowerCase()] ?? null) }, json: async () => body };
};
const stub200 = (monthly, daily) => async () => {
  fetchCalls++; const h = {};
  if (monthly != null) h["x-resend-monthly-quota"] = monthly;
  if (daily != null) h["x-resend-daily-quota"] = daily;
  return resWith(200, h);
};
const stub429NoHeaders = (name) => async () => { fetchCalls++; return resWith(429, {}, { name, message: name }); };

const USER = { uid: "u1", name: "Ada", email: "ada@example.com", status: "approved" };
const notif = (id) => ({ user: USER, type: "assigned", title: "T", body: "B", url: "/", notificationId: id });
const pubDoc = () => db.doc(PUBLIC_DOC).get().then((s) => (s.exists ? s.data() : null));

beforeEach(async () => {
  process.env.EMAIL_FORCE_SEND = "true";
  process.env.RESEND_API_KEY = "re_test_key";
  fetchCalls = 0;
  for (const c of ["emailDeliveries", "systemUsage", "adminDiagnostics", "reminderDigests", "users"]) {
    const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
});
afterEach(() => { delete process.env.EMAIL_FORCE_SEND; delete process.env.RESEND_API_KEY; globalThis.fetch = origFetch; });

test("CONTAINMENT: a successful NOTIFICATION send publishes app-safety telemetry but NOT provider usage", async () => {
  globalThis.fetch = stub200(41, 2);
  const r = await sendNotificationEmail(notif("n1"));
  assert.equal(r.status, "sent");
  const pub = await pubDoc();
  assert.equal(pub.monthly, null, "provider usage neutralized while semantics unproven");
  assert.equal(pub.daily, null);
  assert.equal(pub.internalTelemetry.appInitiatedThisMonth, 1, "app safety usage advanced by the send");
  for (const k of ["monthlyUsed", "alertedThresholds", "dailyExhaustedDay"]) assert.equal(k in pub, false);
});

test("CONTAINMENT: a DIGEST send advances app-safety telemetry, publishes no provider usage", async () => {
  globalThis.fetch = stub200(42);
  await db.collection("users").doc(USER.uid).set(USER);
  const day = new Date().toISOString().slice(0, 10);
  await enqueueDigestItem(USER.uid, day, { taskId: "t", title: "X", dueText: "due" });
  await flushDigests({ byUid: { [USER.uid]: USER }, send: sendDigestEmail });
  const pub = await pubDoc();
  assert.equal(pub.monthly, null);
  assert.equal(pub.internalTelemetry.appInitiatedThisMonth, 1);
});

test("CONTAINMENT: an admin TEST send advances app-safety telemetry, publishes no provider usage", async () => {
  globalThis.fetch = stub200(43);
  await sendTest("ada@example.com");
  const pub = await pubDoc();
  assert.equal(pub.monthly, null, "provider usage neutralized");
  assert.equal(pub.internalTelemetry.appInitiatedThisMonth, 1, "test send advances app safety usage");
});

test("a SUPPRESSED quota send (429, no headers) does NOT publish a false observation", async () => {
  globalThis.fetch = stub429NoHeaders("daily_quota_exceeded");
  const r = await sendNotificationEmail(notif("n2"));
  assert.equal(r.status, "suppressed");
  assert.equal(await pubDoc(), null, "no public doc written");
});

test("a 200 success WITHOUT quota headers publishes NO provider observation (internal usage still counts)", async () => {
  globalThis.fetch = stub200();     // no monthly header
  const r = await sendNotificationEmail(notif("n3"));
  assert.equal(r.status, "sent");
  const pub = await pubDoc();
  assert.equal(pub.monthly, null, "neutralized, no false provider numbers");
  assert.equal(pub.internalTelemetry.appInitiatedThisMonth, 1, "the successful send still advances safety usage");
});

test("a MALFORMED monthly header publishes NO provider observation", async () => {
  globalThis.fetch = stub200("N/A"); // non-numeric
  await sendNotificationEmail(notif("n4"));
  const pub = await pubDoc();
  assert.equal(pub.monthly, null);
});
