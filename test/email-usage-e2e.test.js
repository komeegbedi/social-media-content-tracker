/* END-TO-END display-only v1 accounting (emulator). Executes the REAL pipeline
   (claim → reserve → POST → record v1 observation → settle) with a stubbed successful
   Resend response carrying PRE-SEND headers, and asserts the v1 display doc + delivery
   receipt + internal telemetry. Proves the poisoned legacy cache is never read. Uses
   EMAIL_FORCE_SEND + a stubbed global fetch (no real send).
     node --test test/email-usage-e2e.test.js   |   npm run test:emulator */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-usage-e2e";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db } = await import("../functions/lib.js");
const { sendTest, sendNotificationEmail } = await import("../functions/emailService.js");
const { V1_DISPLAY_DOC, MODEL } = await import("../functions/resendObservationV1.js");

const origFetch = globalThis.fetch;
const stub200 = (monthly, daily) => async () => {
  const h = { "x-resend-monthly-quota": String(monthly) };
  if (daily != null) h["x-resend-daily-quota"] = String(daily);
  return { ok: true, status: 200, headers: { get: (k) => (h[String(k).toLowerCase()] ?? null) }, json: async () => ({ id: "m1" }) };
};
const USER = { uid: "u1", name: "Ada", email: "ada@example.com", status: "approved" };
const v1Doc = () => db.doc(V1_DISPLAY_DOC).get().then((s) => (s.exists ? s.data() : null));
const monthDoc = () => { const k = new Date().toISOString().slice(0, 7); return db.doc(`systemUsage/email-${k}`).get().then((s) => (s.exists ? s.data() : {})); };
const poisoned = () => db.doc("systemUsage/resendQuota").get().then((s) => (s.exists ? s.data() : {}));

beforeEach(async () => {
  process.env.EMAIL_FORCE_SEND = "true"; process.env.RESEND_API_KEY = "re_test_key";
  for (const c of ["emailDeliveries", "systemUsage", "adminDiagnostics", "users"]) {
    const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
  // Seed the POISONED legacy cache to prove the v1 display path never reads or repairs it.
  await db.doc("systemUsage/resendQuota").set({ monthlyUsed: 3001, dailyUsed: 5, monthlyLimit: 3000, dailyLimit: 100 });
});
afterEach(() => { delete process.env.EMAIL_FORCE_SEND; delete process.env.RESEND_API_KEY; globalThis.fetch = origFetch; });

test("a successful one-recipient send publishes a v1 observation (header+1); poisoned cache untouched", async () => {
  globalThis.fetch = stub200(43, 3);                    // PRE-send headers 43/3
  const r = await sendTest("one@example.com");
  assert.ok(r.messageId || r.messageId === "");         // succeeded

  const pub = await v1Doc();
  assert.equal(pub.model, MODEL);
  assert.equal(pub.providerUsageProven, true);
  assert.deepEqual(pub.monthly, { used: 44, limit: 3000, percent: 1.5 }, "after = header 43 + 1 recipient");
  assert.deepEqual(pub.daily, { used: 4, limit: 100, percent: 4 });
  assert.equal(pub.internalTelemetry.appInitiatedThisMonth, 1, "app safety usage advanced 0 → 1");

  // The poisoned legacy cache is NEVER read or written by the v1 path.
  assert.equal((await poisoned()).monthlyUsed, 3001, "legacy cache untouched");
  // App monthly sentCount increased (reserve + settle ran).
  assert.equal((await monthDoc()).sentCount, 1);
  // The delivery carries the v1 receipt (not the legacy usageApplied), settled as sent.
  const del = (await db.collection("emailDeliveries").get()).docs[0].data();
  assert.equal(del.usageV1Applied, true, "v1 usage receipt set");
  assert.equal(del.usageApplied, undefined, "legacy receipt not used");
  assert.equal(del.settled, true);
  assert.equal(del.status, "sent");
});

test("in the local emulator a test send is SKIPPED (benign) — no send, no v1 observation", async () => {
  delete process.env.EMAIL_FORCE_SEND;                 // real local-emulator behavior
  let called = false;
  globalThis.fetch = async () => { called = true; return stub200(43, 3)(); };
  const r = await sendTest("one@example.com");
  assert.equal(r.skipped, true, "reported as a skip, not a failure");
  assert.equal(r.reason, "emulator");
  assert.equal(called, false, "no real Resend call in the emulator");
  assert.equal(await v1Doc(), null, "nothing recorded");
  assert.equal((await poisoned()).monthlyUsed, 3001, "legacy cache untouched");
});

test("a replay of the same delivery id does not increment usage again (v1 receipt + claim guard)", async () => {
  globalThis.fetch = stub200(43, 3);
  await sendNotificationEmail({ user: USER, type: "assigned", title: "T", body: "B", url: "/", notificationId: "rep-1" });
  assert.equal((await v1Doc()).monthly.used, 44);
  assert.equal((await v1Doc()).internalTelemetry.appInitiatedThisMonth, 1);
  assert.equal((await monthDoc()).sentCount, 1);
  // Replay with the SAME notificationId — claim sees it already sent → no re-send/re-count.
  const r2 = await sendNotificationEmail({ user: USER, type: "assigned", title: "T", body: "B", url: "/", notificationId: "rep-1" });
  assert.equal(r2.status, "already-sent");
  assert.equal((await v1Doc()).monthly.used, 44, "no double count on replay");
  assert.equal((await v1Doc()).internalTelemetry.appInitiatedThisMonth, 1);
  assert.equal((await monthDoc()).sentCount, 1);
});
