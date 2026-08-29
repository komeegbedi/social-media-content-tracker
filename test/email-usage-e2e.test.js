/* END-TO-END test-email accounting (emulator). Executes the REAL pipeline
   (claim → reserve → POST → record observation → settle) with a stubbed successful
   Resend response carrying PRE-SEND headers, and asserts the public doc + receipt +
   internal telemetry. Uses EMAIL_FORCE_SEND + a stubbed global fetch (no real send).
     node --test test/email-usage-e2e.test.js   |   npm run test:emulator */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-usage-e2e";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db } = await import("../functions/lib.js");
const { sendTest, sendNotificationEmail } = await import("../functions/emailService.js");
const { PUBLIC_DOC, periodKeysFor } = await import("../functions/resendUsage.js");

const origFetch = globalThis.fetch;
const stub200 = (monthly, daily) => async () => {
  const h = { "x-resend-monthly-quota": String(monthly) };
  if (daily != null) h["x-resend-daily-quota"] = String(daily);
  return { ok: true, status: 200, headers: { get: (k) => (h[String(k).toLowerCase()] ?? null) }, json: async () => ({ id: "m1" }) };
};
const USER = { uid: "u1", name: "Ada", email: "ada@example.com", status: "approved" };
const pubDoc = () => db.doc(PUBLIC_DOC).get().then((s) => (s.exists ? s.data() : null));
const monthDoc = () => { const k = new Date().toISOString().slice(0, 7); return db.doc(`systemUsage/email-${k}`).get().then((s) => (s.exists ? s.data() : {})); };

beforeEach(async () => {
  process.env.EMAIL_FORCE_SEND = "true"; process.env.RESEND_API_KEY = "re_test_key";
  for (const c of ["emailDeliveries", "systemUsage", "adminDiagnostics", "users"]) {
    const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
  // Seed provider usage 42 monthly / 2 daily (current period); app usage 0 (no email-{month}).
  const { month, day } = periodKeysFor(Date.now());
  await db.doc("systemUsage/resendQuota").set({
    monthlyUsed: 42, dailyUsed: 2, monthlyLimit: 3000, dailyLimit: 100,
    periodMonth: month, periodDay: day, observedAt: new Date().toISOString(),
  });
});
afterEach(() => { delete process.env.EMAIL_FORCE_SEND; delete process.env.RESEND_API_KEY; globalThis.fetch = origFetch; });

test("CONTAINMENT: a successful one-recipient send does NOT publish provider usage, but advances app safety (1 recipient)", async () => {
  globalThis.fetch = stub200(43, 3);                    // PRE-send headers 43/3 (unproven → ignored)
  const r = await sendTest("one@example.com");
  assert.ok(r.messageId || r.messageId === "");         // succeeded

  const pub = await pubDoc();
  assert.equal(pub.monthly, null, "provider usage NEUTRALIZED (compatibility signal) while semantics unproven");
  assert.equal(pub.daily, null);
  assert.equal(pub.internalTelemetry.appInitiatedThisMonth, 1, "app safety usage advanced 0 → 1");
  // provider cache is NOT advanced by the header (stays at the seeded 42)
  const cache = (await db.doc("systemUsage/resendQuota").get()).data();
  assert.equal(cache.monthlyUsed, 42, "header not persisted as usage");
  // app monthly sentCount increased (reserve + settle ran)
  assert.equal((await monthDoc()).sentCount, 1);
  // NO usage-application receipt (nothing recorded), but reservation settled as sent
  const del = (await db.collection("emailDeliveries").get()).docs[0].data();
  assert.equal(del.usageApplied, undefined, "no provider usage receipt");
  assert.equal(del.settled, true);
  assert.equal(del.status, "sent");
});

test("in the local emulator a test send is SKIPPED (benign) — no send, no recorded usage", async () => {
  delete process.env.EMAIL_FORCE_SEND;                 // real local-emulator behavior
  let called = false;
  globalThis.fetch = async () => { called = true; return stub200(43, 3)(); };
  const r = await sendTest("one@example.com");
  assert.equal(r.skipped, true, "reported as a skip, not a failure");
  assert.equal(r.reason, "emulator");
  assert.equal(called, false, "no real Resend call in the emulator");
  // The seeded provider doc is unchanged (still 42) — nothing recorded.
  assert.equal((await db.doc("systemUsage/resendQuota").get()).data().monthlyUsed, 42);
});

test("a replay of the same delivery id does not increment app-safety usage again", async () => {
  globalThis.fetch = stub200(43, 3);
  await sendNotificationEmail({ user: USER, type: "assigned", title: "T", body: "B", url: "/", notificationId: "rep-1" });
  assert.equal((await pubDoc()).internalTelemetry.appInitiatedThisMonth, 1);
  assert.equal((await monthDoc()).sentCount, 1);
  // Replay with the SAME notificationId — claim sees it already sent → no re-send/re-count.
  const r2 = await sendNotificationEmail({ user: USER, type: "assigned", title: "T", body: "B", url: "/", notificationId: "rep-1" });
  assert.equal(r2.status, "already-sent");
  assert.equal((await pubDoc()).internalTelemetry.appInitiatedThisMonth, 1, "no double count on replay");
  assert.equal((await monthDoc()).sentCount, 1);
});
