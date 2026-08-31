/* Real-time publish behavior (emulator) — DISPLAY-ONLY v1 model. A successful app send
   (notification, digest, test) with valid quota headers publishes the SANITIZED v1
   provider observation AND app-safety telemetry to adminDiagnostics/emailUsageV1 (disjoint
   merge fields). Failed / suppressed / header-less sends publish no false provider
   observation. The legacy adminDiagnostics/emailUsage doc is never written. Uses
   EMAIL_FORCE_SEND + a stubbed global fetch so no real send happens.
     node --test test/email-usage-publish.test.js   |   npm run test:emulator */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-usage-publish";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db } = await import("../functions/lib.js");
const { sendNotificationEmail, sendDigestEmail, sendTest } = await import("../functions/emailService.js");
const { enqueueDigestItem, flushDigests } = await import("../functions/reminderDigest.js");
const { V1_DISPLAY_DOC, MODEL } = await import("../functions/resendObservationV1.js");

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
const v1Doc = () => db.doc(V1_DISPLAY_DOC).get().then((s) => (s.exists ? s.data() : null));
const legacyDoc = () => db.doc("adminDiagnostics/emailUsage").get().then((s) => (s.exists ? s.data() : null));
const FORBIDDEN = ["monthlyUsedBeforeSend", "dailyUsedBeforeSend", "acceptedUnits", "deliveryId",
  "deliveryIdHash", "idempotencyKey", "responseReceivedAt", "recipients", "headers", "payload"];

beforeEach(async () => {
  process.env.EMAIL_FORCE_SEND = "true";
  process.env.RESEND_API_KEY = "re_test_key";
  fetchCalls = 0;
  for (const c of ["emailDeliveries", "systemUsage", "adminDiagnostics", "reminderDigests", "users"]) {
    const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
});
afterEach(() => { delete process.env.EMAIL_FORCE_SEND; delete process.env.RESEND_API_KEY; globalThis.fetch = origFetch; });

test("a successful NOTIFICATION send publishes the v1 provider observation + app telemetry (disjoint)", async () => {
  globalThis.fetch = stub200(41, 2);
  const r = await sendNotificationEmail(notif("n1"));
  assert.equal(r.status, "sent");
  const pub = await v1Doc();
  assert.equal(pub.model, MODEL);
  assert.equal(pub.providerUsageProven, true);
  assert.deepEqual(pub.monthly, { used: 42, limit: 3000, percent: 1.4 });
  assert.deepEqual(pub.daily, { used: 3, limit: 100, percent: 3 });
  assert.equal(pub.dailyReason, null);
  assert.equal(pub.source, "resend-send-response");
  assert.equal(pub.internalTelemetry.appInitiatedThisMonth, 1, "app safety usage advanced by the send");
  for (const k of FORBIDDEN) assert.equal(k in pub, false, `forbidden field ${k} must not be published`);
  assert.equal(await legacyDoc(), null, "the legacy adminDiagnostics/emailUsage doc is never written");
});

test("a DIGEST send publishes a v1 observation and advances telemetry", async () => {
  globalThis.fetch = stub200(42);   // no daily header
  await db.collection("users").doc(USER.uid).set(USER);
  const day = new Date().toISOString().slice(0, 10);
  await enqueueDigestItem(USER.uid, day, { taskId: "t", title: "X", dueText: "due" });
  await flushDigests({ byUid: { [USER.uid]: USER }, send: sendDigestEmail });
  const pub = await v1Doc();
  assert.equal(pub.monthly.used, 43);
  assert.equal(pub.daily, null);
  assert.equal(pub.dailyReason, "not-provided");
  assert.equal(pub.internalTelemetry.appInitiatedThisMonth, 1);
});

test("an admin TEST send publishes a v1 observation and advances telemetry", async () => {
  globalThis.fetch = stub200(43, 5);
  await sendTest("ada@example.com");
  const pub = await v1Doc();
  assert.equal(pub.monthly.used, 44);
  assert.deepEqual(pub.daily, { used: 6, limit: 100, percent: 6 });
  assert.equal(pub.internalTelemetry.appInitiatedThisMonth, 1);
});

test("a SUPPRESSED quota send (429, no headers) publishes NOTHING (no provider obs, no telemetry)", async () => {
  globalThis.fetch = stub429NoHeaders("daily_quota_exceeded");
  const r = await sendNotificationEmail(notif("n2"));
  assert.equal(r.status, "suppressed");
  assert.equal(await v1Doc(), null, "no v1 doc written on a quota-suppressed send");
});

test("a 200 success WITHOUT quota headers publishes NO provider observation (telemetry still advances)", async () => {
  globalThis.fetch = stub200();     // no monthly header
  const r = await sendNotificationEmail(notif("n3"));
  assert.equal(r.status, "sent");
  const pub = await v1Doc();
  assert.equal(pub.model, undefined, "no provider snapshot without a valid header");
  assert.equal(pub.monthly == null, true, "no provider numbers");
  assert.equal(pub.internalTelemetry.appInitiatedThisMonth, 1, "the successful send still advances safety usage");
});

test("a MALFORMED monthly header publishes NO provider observation", async () => {
  globalThis.fetch = stub200("N/A"); // non-numeric
  await sendNotificationEmail(notif("n4"));
  const pub = await v1Doc();
  assert.equal(pub.model, undefined);
  assert.equal(pub.monthly == null, true);
});

test("a header at plan capacity (3000) is rejected — no provider observation", async () => {
  globalThis.fetch = stub200(3000);
  await sendNotificationEmail(notif("n5"));
  const pub = await v1Doc();
  assert.equal(pub.model, undefined, "capacity header not shown as a real observation");
  assert.equal(pub.internalTelemetry.appInitiatedThisMonth, 1);
});
