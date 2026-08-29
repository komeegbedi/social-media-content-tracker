/* Resend usage — "last observed" model with the REAL Firestore cache (emulator).
     node --test test/resend-usage.test.js      (vs a running emulator)
     npm run test:emulator                       (throwaway emulator) */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-resend-usage";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db } = await import("../functions/lib.js");
const { getResendQuotaUsage, recordObservedUsage, CACHE_DOC, PUBLIC_DOC } = await import("../functions/resendUsage.js");
const publicDoc = () => db.doc(PUBLIC_DOC).get().then((s) => (s.exists ? s.data() : null));

const noAlerts = async () => {};

beforeEach(async () => {
  for (const c of ["systemUsage", "adminDiagnostics", "emailDeliveries", "users", "notifications"]) {
    const s = await db.collection(c).get(); await Promise.all(s.docs.map((x) => x.ref.delete()));
  }
});

test("recording a send writes cache + sanitized public doc (header 40 + 1 unit → 41)", async () => {
  await recordObservedUsage({ monthlyUsedBeforeSend: 40, dailyUsedBeforeSend: 0, acceptedUnits: 1, deliveryId: "d1" }, { alerter: noAlerts, provenSemantics: true });
  const doc = (await db.doc(CACHE_DOC).get()).data();
  assert.equal(doc.monthlyUsed, 41);
  assert.equal(doc.observedVia, "send");
  const pub = await publicDoc();
  assert.deepEqual(pub.monthly, { used: 41, limit: 3000, percent: 1.4 });
  assert.deepEqual(pub.daily, { used: 1, limit: 100, percent: 1 });
  assert.equal(pub.source, "resend");
  for (const k of ["monthlyUsed", "alertedThresholds", "dailyExhaustedDay"]) assert.equal(k in pub, false);
  const r = await getResendQuotaUsage({ provenSemantics: true });
  assert.equal(r.providerAvailable, true);
  assert.equal(r.monthly.used, 41);
});

test("a later send advances the observed value", async () => {
  await recordObservedUsage({ monthlyUsedBeforeSend: 40, dailyUsedBeforeSend: 0, acceptedUnits: 1, deliveryId: "a" }, { alerter: noAlerts, provenSemantics: true });
  await recordObservedUsage({ monthlyUsedBeforeSend: 950, dailyUsedBeforeSend: 3, acceptedUnits: 1, deliveryId: "b" }, { alerter: noAlerts, provenSemantics: true });
  const r = await getResendQuotaUsage({ provenSemantics: true });
  assert.equal(r.monthly.used, 951);
  assert.equal(r.daily.used, 4);
});

test("nothing observed yet → providerAvailable:false; internal count stays in telemetry only", async () => {
  const month = new Date().toISOString().slice(0, 7);
  await db.doc(`systemUsage/email-${month}`).set({ provider: "resend", monthlyLimit: 2800, sentCount: 42, reservedCount: 3 });
  const r = await getResendQuotaUsage({ provenSemantics: true });
  assert.equal(r.providerAvailable, false);
  assert.equal(r.monthly, null, "no fabricated provider numbers");
  assert.equal(r.providerError.code, "not-observed");
  assert.equal(r.internalTelemetry.appInitiatedThisMonth, 42);
});

/* ---- concurrency (real Firestore transactions) ---- */
test("two DISTINCT concurrent sends both seeing header 42 → final 44 (+2, no lost update)", async () => {
  await Promise.all([
    recordObservedUsage({ monthlyUsedBeforeSend: 42, dailyUsedBeforeSend: 0, acceptedUnits: 1, deliveryId: "cA" }, { alerter: noAlerts, provenSemantics: true }),
    recordObservedUsage({ monthlyUsedBeforeSend: 42, dailyUsedBeforeSend: 0, acceptedUnits: 1, deliveryId: "cB" }, { alerter: noAlerts, provenSemantics: true }),
  ]);
  const doc = (await db.doc(CACHE_DOC).get()).data();
  assert.equal(doc.monthlyUsed, 44, "both accepted sends counted; the loser's local floor wins");
  assert.equal((await publicDoc()).monthly.used, 44);
});

test("replaying the same delivery id does not increment twice (stays 43)", async () => {
  await recordObservedUsage({ monthlyUsedBeforeSend: 42, dailyUsedBeforeSend: 0, acceptedUnits: 1, deliveryId: "rep" }, { alerter: noAlerts, provenSemantics: true });
  await recordObservedUsage({ monthlyUsedBeforeSend: 42, dailyUsedBeforeSend: 0, acceptedUnits: 1, deliveryId: "rep" }, { alerter: noAlerts, provenSemantics: true });
  assert.equal((await db.doc(CACHE_DOC).get()).data().monthlyUsed, 43);
});

test("two simultaneous sends that both cross 70% produce exactly ONE alert", async () => {
  const fired = [];
  const alerter = async (t) => { fired.push(...t); };
  const at70 = Math.round(0.70 * 3000) - 1;   // header just below 70%; +1 unit → crosses 70%
  await Promise.all([
    recordObservedUsage({ monthlyUsedBeforeSend: at70, dailyUsedBeforeSend: 0, acceptedUnits: 1, deliveryId: "t1" }, { alerter, provenSemantics: true }),
    recordObservedUsage({ monthlyUsedBeforeSend: at70, dailyUsedBeforeSend: 0, acceptedUnits: 1, deliveryId: "t2" }, { alerter, provenSemantics: true }),
  ]);
  assert.deepEqual(fired, [70], "threshold claimed atomically → single alert");
});

test("a genuine month transition permits the counter to reset", async () => {
  await recordObservedUsage({ monthlyUsedBeforeSend: 2900, dailyUsedBeforeSend: 0, acceptedUnits: 1, deliveryId: "m1", }, { now: () => Date.parse("2026-08-31T12:00:00Z"), alerter: noAlerts, provenSemantics: true });
  await recordObservedUsage({ monthlyUsedBeforeSend: 5, dailyUsedBeforeSend: 0, acceptedUnits: 1, deliveryId: "m2" }, { now: () => Date.parse("2026-09-01T12:00:00Z"), alerter: noAlerts, provenSemantics: true });
  const doc = (await db.doc(CACHE_DOC).get()).data();
  assert.equal(doc.monthlyUsed, 6);
  assert.equal(doc.periodMonth, "2026-09");
});
