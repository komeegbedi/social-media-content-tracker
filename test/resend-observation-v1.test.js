/* Display-only Resend usage v1: recordObservationV1 + getObservationV1 (emulator).
   Proves the last-observed model, exactly-once application via the delivery receipt,
   out-of-order handling, strict validation, and that NO forbidden field is ever written.
     node --test test/resend-observation-v1.test.js   |   npm run test:emulator */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.GCLOUD_PROJECT = "demo-obs-v1";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FUNCTIONS_EMULATOR = "true";

const { db } = await import("../functions/lib.js");
const v1 = await import("../functions/resendObservationV1.js");
const { recordObservationV1, getObservationV1, V1_DISPLAY_DOC, MODEL } = v1;

const pub = () => db.doc(V1_DISPLAY_DOC).get().then((s) => (s.exists ? s.data() : null));
const del = (id) => db.collection("emailDeliveries").doc(id);
const seedDelivery = (id) => del(id).set({ status: "sent", reserved: false, settled: true });
const AT = (n) => `2026-08-30T10:0${n}:00.000Z`; // ordered ISO timestamps
const obs = (o) => ({ acceptedUnits: 1, deliveryId: "d1", responseReceivedAt: AT(1), ...o });

// Fields that must NEVER appear in the sanitized display doc or the callable result.
const FORBIDDEN = ["monthlyUsedBeforeSend", "dailyUsedBeforeSend", "acceptedUnits",
  "deliveryId", "deliveryIdHash", "idempotencyKey", "responseReceivedAt", "recipients", "headers", "payload"];

beforeEach(async () => {
  for (const c of ["emailDeliveries", "adminDiagnostics", "systemUsage"]) {
    const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
});

test("proven pre-send + 1 recipient → after = before + 1; model + proof stamped; receipt set", async () => {
  await seedDelivery("d1");
  const r = await recordObservationV1(obs({ monthlyUsedBeforeSend: 41, dailyUsedBeforeSend: 2 }));
  assert.equal(r.applied, true);
  const p = await pub();
  assert.equal(p.model, MODEL);
  assert.equal(p.providerUsageProven, true);
  assert.deepEqual(p.monthly, { used: 42, limit: 3000, percent: 1.4 });
  assert.deepEqual(p.daily, { used: 3, limit: 100, percent: 3 });
  assert.equal(p.dailyReason, null);
  assert.equal(p.source, "resend-send-response");
  assert.equal(p.observedAt, AT(1));
  const d = (await del("d1").get()).data();
  assert.equal(d.usageV1Applied, true);
  assert.ok(d.usageV1AppliedAt, "receipt timestamp set");
  for (const k of FORBIDDEN) assert.equal(k in p, false, `forbidden field ${k} must not be published`);
});

test("multiple recipients (units=3) → after = before + 3", async () => {
  await seedDelivery("d1");
  await recordObservationV1(obs({ monthlyUsedBeforeSend: 10, acceptedUnits: 3 }));
  assert.equal((await pub()).monthly.used, 13);
});

test("idempotent replay: second application does not increment", async () => {
  await seedDelivery("d1");
  await recordObservationV1(obs({ monthlyUsedBeforeSend: 41 }));
  const again = await recordObservationV1(obs({ monthlyUsedBeforeSend: 41, responseReceivedAt: AT(5) }));
  assert.equal(again.replay, true);
  assert.equal((await pub()).monthly.used, 42, "unchanged on replay");
});

test("missing/malformed monthly header → NO provider observation written", async () => {
  await seedDelivery("d1");
  const r = await recordObservationV1(obs({ monthlyUsedBeforeSend: null, dailyUsedBeforeSend: 2 }));
  assert.equal(r.invalid, true);
  assert.equal(await pub(), null, "no doc written; never fabricate zero");
});

test("daily absent → monthly written, daily null, dailyReason 'not-provided'", async () => {
  await seedDelivery("d1");
  await recordObservationV1(obs({ monthlyUsedBeforeSend: 41 })); // no dailyUsedBeforeSend
  const p = await pub();
  assert.equal(p.monthly.used, 42);
  assert.equal(p.daily, null);
  assert.equal(p.dailyReason, "not-provided");
});

test("daily 99 + 2 → monthly retained, daily null, dailyReason 'invalid'", async () => {
  await seedDelivery("d1");
  const r = await recordObservationV1(obs({ monthlyUsedBeforeSend: 41, dailyUsedBeforeSend: 99, acceptedUnits: 2 }));
  assert.equal(r.applied, true);
  const p = await pub();
  assert.equal(p.monthly.used, 43, "monthly retained (41 + 2)");
  assert.equal(p.daily, null);
  assert.equal(p.dailyReason, "invalid");
});

test("boundary: 2999 + 1 → 3000 valid; 2999 + 2 → invalid; header 3000 → invalid", async () => {
  await seedDelivery("d1");
  await recordObservationV1(obs({ monthlyUsedBeforeSend: 2999, acceptedUnits: 1 }));
  assert.equal((await pub()).monthly.used, 3000);
  await db.doc(V1_DISPLAY_DOC).delete(); await del("d1").set({ status: "sent" });
  assert.equal((await recordObservationV1(obs({ monthlyUsedBeforeSend: 2999, acceptedUnits: 2 }))).invalid, true);
  assert.equal(await pub(), null);
  assert.equal((await recordObservationV1(obs({ monthlyUsedBeforeSend: 3000, acceptedUnits: 1 }))).invalid, true);
});

test("no delivery receipt exists → skipped; no snapshot orphaned", async () => {
  const r = await recordObservationV1(obs({ monthlyUsedBeforeSend: 41 })); // d1 not seeded
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "no-delivery-receipt");
  assert.equal(await pub(), null);
});

test("older delayed response cannot overwrite a newer snapshot", async () => {
  await seedDelivery("dNew"); await seedDelivery("dOld");
  await recordObservationV1(obs({ deliveryId: "dNew", monthlyUsedBeforeSend: 50, responseReceivedAt: AT(3) }));
  await recordObservationV1(obs({ deliveryId: "dOld", monthlyUsedBeforeSend: 10, responseReceivedAt: AT(1) })); // older
  const p = await pub();
  assert.equal(p.observedAt, AT(3), "newer responseReceivedAt retained");
  assert.equal(p.monthly.used, 51);
  assert.equal((await del("dOld").get()).data().usageV1Applied, true, "older delivery still marked applied (not reprocessed)");
});

test("SAME responseReceivedAt: greater monthly wins, both receipts applied (42 then 43 → 43)", async () => {
  await seedDelivery("t1"); await seedDelivery("t2");
  const AT = "2026-08-30T10:00:00.000Z";
  await recordObservationV1(obs({ deliveryId: "t1", monthlyUsedBeforeSend: 41, responseReceivedAt: AT })); // 42
  await recordObservationV1(obs({ deliveryId: "t2", monthlyUsedBeforeSend: 42, responseReceivedAt: AT })); // 43
  assert.equal((await pub()).monthly.used, 43);
  assert.equal((await del("t1").get()).data().usageV1Applied, true);
  assert.equal((await del("t2").get()).data().usageV1Applied, true);
});

test("SAME responseReceivedAt in the other order stays at the greater value (43 then 42 → 43)", async () => {
  await seedDelivery("t1"); await seedDelivery("t2");
  const AT = "2026-08-30T10:00:00.000Z";
  await recordObservationV1(obs({ deliveryId: "t1", monthlyUsedBeforeSend: 42, responseReceivedAt: AT })); // 43
  await recordObservationV1(obs({ deliveryId: "t2", monthlyUsedBeforeSend: 41, responseReceivedAt: AT })); // 42
  assert.equal((await pub()).monthly.used, 43);
  assert.equal((await del("t2").get()).data().usageV1Applied, true, "loser still marked applied");
});

test("a LOWER but NEWER valid observation is accepted (no reset label, no high-water)", async () => {
  await seedDelivery("dA"); await seedDelivery("dB");
  await recordObservationV1(obs({ deliveryId: "dA", monthlyUsedBeforeSend: 500, responseReceivedAt: AT(1) }));
  await recordObservationV1(obs({ deliveryId: "dB", monthlyUsedBeforeSend: 9, responseReceivedAt: AT(2) })); // lower + newer
  const p = await pub();
  assert.equal(p.monthly.used, 10, "lower newer value accepted as-is (not max)");
  assert.equal(p.observedAt, AT(2));
  assert.equal("resetAt" in p, false);
});

test("concurrent distinct sends cannot corrupt the doc; both receipts set", async () => {
  const ids = ["c1", "c2", "c3", "c4"];
  await Promise.all(ids.map(seedDelivery));
  await Promise.all(ids.map((id, i) =>
    recordObservationV1(obs({ deliveryId: id, monthlyUsedBeforeSend: 40 + i, responseReceivedAt: AT(1 + i) }))));
  const p = await pub();
  assert.equal(p.model, MODEL);
  assert.equal(p.providerUsageProven, true);
  assert.ok(Number.isInteger(p.monthly.used) && p.monthly.used <= 3000, "doc remains structurally valid");
  assert.equal(p.observedAt, AT(4), "the newest responseReceivedAt wins");
  for (const id of ids) assert.equal((await del(id).get()).data().usageV1Applied, true);
});

const TELE4 = { appInitiatedThisMonth: 5, appSafetyCap: 2800, appDailyThisDay: 3, appDailyLimit: 90 };
test("getObservationV1: absent → not-observed; present → sanitized available + four-field telemetry", async () => {
  const none = await getObservationV1({ telemetry: TELE4 });
  assert.equal(none.providerAvailable, false);
  assert.equal(none.providerError.code, "not-observed");
  assert.deepEqual(none.internalTelemetry, TELE4);

  await seedDelivery("d1");
  await recordObservationV1(obs({ monthlyUsedBeforeSend: 41, dailyUsedBeforeSend: 2 }));
  const got = await getObservationV1({ telemetry: TELE4 });
  assert.equal(got.providerAvailable, true);
  assert.equal(got.model, MODEL);
  assert.equal(got.providerUsageProven, true);
  assert.deepEqual(got.monthly, { used: 42, limit: 3000, percent: 1.4 });
  assert.deepEqual(got.daily, { used: 3, limit: 100, percent: 3 });
  assert.deepEqual(got.internalTelemetry, TELE4);
  assert.equal(got.lastSyncedAt, AT(1));
  for (const k of FORBIDDEN) assert.equal(k in got, false, `forbidden field ${k} must not be returned`);
});

test("an invalid incoming responseReceivedAt is rejected before any write", async () => {
  await seedDelivery("d1");
  const r = await recordObservationV1(obs({ monthlyUsedBeforeSend: 41, responseReceivedAt: "not-a-date" }));
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "invalid-timestamp");
  assert.equal(await pub(), null, "nothing written on an invalid timestamp");
  assert.equal((await del("d1").get()).data().usageV1Applied, undefined, "receipt not marked");
});

test("a MALFORMED stored observedAt is repaired by the next valid observation", async () => {
  // Seed a poisoned snapshot with a junk timestamp (as if hand-edited / corrupted).
  await db.doc(V1_DISPLAY_DOC).set({ model: MODEL, providerUsageProven: true,
    monthly: { used: 10, limit: 3000, percent: 0.3 }, daily: null, dailyReason: "not-provided",
    observedAt: "garbage", source: "resend-send-response" });
  await seedDelivery("fix");
  const r = await recordObservationV1(obs({ deliveryId: "fix", monthlyUsedBeforeSend: 41, responseReceivedAt: AT(2) }));
  assert.equal(r.applied, true, "malformed prior timestamp treated as absent → write proceeds");
  const p = await pub();
  assert.equal(p.monthly.used, 42);
  assert.equal(p.observedAt, AT(2), "document repaired with a canonical timestamp");
});
