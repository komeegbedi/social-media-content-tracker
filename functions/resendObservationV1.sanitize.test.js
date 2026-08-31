/* Server-side strict V1 sanitizers + callable rejection matrix (pure; injected store).
   Run: node --test functions/resendObservationV1.sanitize.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const v1 = require("./resendObservationV1");
const { sanitizeBlock, sanitizeV1Snapshot, sanitizeTelemetry, isCanonicalIso, safePercent, getObservationV1, recordObservationV1, MODEL } = v1;

const TELE4 = { appInitiatedThisMonth: 5, appSafetyCap: 2800, appDailyThisDay: 3, appDailyLimit: 90 };
const storeOf = (doc) => ({ read: async () => doc });
const good = (over = {}) => ({
  model: MODEL, providerUsageProven: true,
  monthly: { used: 42, limit: 3000, percent: 999 },        // persisted percent is deliberately wrong
  daily: { used: 3, limit: 100, percent: -7 }, dailyReason: null,
  observedAt: "2026-08-30T12:00:00.000Z", source: "resend-send-response", ...over,
});

/* ---- sanitizeBlock: exact-limit + integer range, recomputed percent ---- */
test("sanitizeBlock rejects missing/string/fractional/negative/zero/incorrect limits", () => {
  assert.equal(sanitizeBlock({ used: 42 }, 3000), null);                       // missing limit
  assert.equal(sanitizeBlock({ used: 42, limit: "3000" }, 3000), null);        // string limit
  assert.equal(sanitizeBlock({ used: 42, limit: 3000.5 }, 3000), null);        // fractional limit
  assert.equal(sanitizeBlock({ used: 42, limit: -3000 }, 3000), null);         // negative limit
  assert.equal(sanitizeBlock({ used: 42, limit: 0 }, 3000), null);             // zero limit
  assert.equal(sanitizeBlock({ used: 42, limit: 5000 }, 3000), null);          // wrong limit (not v1)
  assert.equal(sanitizeBlock({ used: 42, limit: 100 }, 3000), null);           // daily limit under monthly
});
test("sanitizeBlock rejects used>limit, fractional/negative used; accepts valid", () => {
  assert.equal(sanitizeBlock({ used: 3001, limit: 3000 }, 3000), null);
  assert.equal(sanitizeBlock({ used: 1.5, limit: 3000 }, 3000), null);
  assert.equal(sanitizeBlock({ used: -1, limit: 3000 }, 3000), null);
  assert.deepEqual(sanitizeBlock({ used: 3000, limit: 3000 }, 3000), { used: 3000, limit: 3000, percent: 100 });
});
test("percent is RECOMPUTED, never trusted; clamped finite 0..100", () => {
  assert.equal(sanitizeBlock({ used: 42, limit: 3000, percent: NaN }, 3000).percent, 1.4);
  assert.equal(sanitizeBlock({ used: 42, limit: 3000, percent: Infinity }, 3000).percent, 1.4);
  assert.equal(sanitizeBlock({ used: 42, limit: 3000, percent: -50 }, 3000).percent, 1.4);
  assert.equal(safePercent(3000, 3000), 100);
  assert.equal(safePercent(0, 0), 0);          // guarded (no NaN/Infinity)
});

/* ---- isCanonicalIso ---- */
test("isCanonicalIso accepts only canonical round-tripping instants", () => {
  assert.equal(isCanonicalIso("2026-08-30T12:00:00.000Z"), true);
  assert.equal(isCanonicalIso("2026-08-30"), false);            // non-canonical
  assert.equal(isCanonicalIso("garbage"), false);
  assert.equal(isCanonicalIso(1724990400000), false);          // number, not string
  assert.equal(isCanonicalIso(null), false);
});

/* ---- sanitizeTelemetry: four-field contract ---- */
test("sanitizeTelemetry requires four non-neg ints with used<=limit", () => {
  assert.deepEqual(sanitizeTelemetry(TELE4), TELE4);
  assert.equal(sanitizeTelemetry({ appInitiatedThisMonth: 5, appSafetyCap: 2800 }), null);   // missing daily fields
  assert.equal(sanitizeTelemetry({ ...TELE4, appDailyThisDay: 91, appDailyLimit: 90 }), null); // used>limit
  assert.equal(sanitizeTelemetry({ ...TELE4, appInitiatedThisMonth: -1 }), null);            // negative
  assert.equal(sanitizeTelemetry({ ...TELE4, appSafetyCap: 2.5 }), null);                    // fractional
  assert.equal(sanitizeTelemetry(null), null);
});

/* ---- sanitizeV1Snapshot + callable getObservationV1 rejection matrix ---- */
test("getObservationV1 rejects EVERY malformed schema with a stable reason (no partial totals)", async () => {
  const cases = [
    [null, "not-observed"],
    [{ internalTelemetry: TELE4 }, "not-observed"],                                   // telemetry-only
    [good({ model: "resend-future-v2" }), "provider-usage-unverified"],               // unknown model
    [(() => { const d = good(); delete d.providerUsageProven; return d; })(), "provider-usage-unverified"],
    [good({ monthly: { used: 42, limit: undefined } }), "invalid-provider-observation"], // bad limit (the P0 crasher)
    [good({ monthly: { used: 3001, limit: 3000 } }), "invalid-provider-observation"], // used>limit
    [good({ observedAt: "garbage" }), "invalid-provider-observation"],                // bad timestamp
    [good({ daily: { used: 3, limit: 100 }, dailyReason: "not-provided" }), "invalid-provider-observation"], // contradiction
    [good({ daily: null, dailyReason: null }), "invalid-provider-observation"],       // absent daily w/o a reason
    [good({ daily: null, dailyReason: "bogus" }), "invalid-provider-observation"],    // absent daily wrong reason
    [(() => { const d = good(); delete d.source; return d; })(), "invalid-provider-observation"], // missing source
    [good({ source: "spoofed" }), "invalid-provider-observation"],                    // unknown source
    [good({ source: 123 }), "invalid-provider-observation"],                          // non-string source
  ];
  for (const [doc, code] of cases) {
    const r = await getObservationV1({ store: storeOf(doc), telemetry: TELE4 });
    assert.equal(r.providerAvailable, false, `doc should be unavailable: ${JSON.stringify(doc)}`);
    assert.equal(r.monthly, null, "no partial provider totals");
    assert.equal(r.providerError.code, code, `expected ${code}`);
    assert.deepEqual(r.internalTelemetry, TELE4, "telemetry preserved on unavailable");
  }
});

test("getObservationV1 returns a VALID observation with recomputed percent + four-field telemetry", async () => {
  const r = await getObservationV1({ store: storeOf(good()), telemetry: TELE4 });
  assert.equal(r.providerAvailable, true);
  assert.equal(r.model, MODEL);
  assert.deepEqual(r.monthly, { used: 42, limit: 3000, percent: 1.4 });   // recomputed, not 999
  assert.deepEqual(r.daily, { used: 3, limit: 100, percent: 3 });         // recomputed, not -7
  assert.equal(r.dailyReason, null);
  assert.equal(r.lastSyncedAt, "2026-08-30T12:00:00.000Z");
  assert.deepEqual(r.internalTelemetry, TELE4);
});

test("getObservationV1: valid monthly with daily not-provided renders (daily null + reason)", async () => {
  const r = await getObservationV1({ store: storeOf(good({ daily: null, dailyReason: "not-provided" })), telemetry: TELE4 });
  assert.equal(r.providerAvailable, true);
  assert.equal(r.daily, null);
  assert.equal(r.dailyReason, "not-provided");
});

/* ---- P0: immutable v1 plan limits (env cannot change them) ---- */
test("v1 plan limits are immutable 3,000/100 regardless of environment config", () => {
  process.env.RESEND_MONTHLY_LIMIT = "5000";
  process.env.RESEND_DAILY_LIMIT = "999";
  for (const m of ["./resendObservationV1", "./resendQuotaMath"]) delete require.cache[require.resolve(m)];
  const fresh = require("./resendObservationV1");
  try {
    assert.equal(fresh.V1_MONTHLY_LIMIT, 3000, "monthly limit not env-derived");
    assert.equal(fresh.V1_DAILY_LIMIT, 100, "daily limit not env-derived");
    assert.equal(fresh.sanitizeBlock({ used: 42, limit: 5000 }, fresh.V1_MONTHLY_LIMIT), null, "env-implied 5000 limit rejected");
    assert.deepEqual(fresh.sanitizeBlock({ used: 42, limit: 3000 }, fresh.V1_MONTHLY_LIMIT), { used: 42, limit: 3000, percent: 1.4 });
  } finally {
    delete process.env.RESEND_MONTHLY_LIMIT; delete process.env.RESEND_DAILY_LIMIT;
    for (const m of ["./resendObservationV1", "./resendQuotaMath"]) delete require.cache[require.resolve(m)];
  }
});

/* ---- P0: read failure is DISTINCT from genuine not-observed ---- */
test("getObservationV1: a read FAILURE returns read-failed (never mislabeled not-observed)", async () => {
  const throwing = { read: async () => { throw new Error("firestore unavailable"); } };
  const r = await getObservationV1({ store: throwing, telemetry: TELE4 });
  assert.equal(r.providerAvailable, false);
  assert.equal(r.providerError.code, "read-failed");
  assert.deepEqual(r.internalTelemetry, TELE4, "telemetry preserved through a read failure");
});
test("getObservationV1: a SUCCESSFUL empty read returns not-observed", async () => {
  const r = await getObservationV1({ store: storeOf(null), telemetry: TELE4 });
  assert.equal(r.providerError.code, "not-observed");
});

/* ---- P1: telemetry limits must be POSITIVE integers (0/0 invalid) ---- */
test("sanitizeTelemetry rejects zero / non-positive limits", () => {
  assert.equal(sanitizeTelemetry({ appInitiatedThisMonth: 0, appSafetyCap: 0, appDailyThisDay: 0, appDailyLimit: 0 }), null);
  assert.equal(sanitizeTelemetry({ ...TELE4, appSafetyCap: 0 }), null);
  assert.equal(sanitizeTelemetry({ ...TELE4, appDailyLimit: 0 }), null);
  assert.deepEqual(sanitizeTelemetry(TELE4), TELE4);
});

/* ---- P1: canonical incoming timestamp REQUIRED before any write ---- */
test("recordObservationV1 rejects non-canonical incoming timestamps with NO write", async () => {
  const bad = ["2026-08-30", "2026-08-30T10:00:00+00:00", "2026-08-30 10:00:00", "not-a-date", 1724990400000];
  for (const ts of bad) {
    let called = false;
    const r = await recordObservationV1(
      { deliveryId: "d", responseReceivedAt: ts, monthlyUsedBeforeSend: 41, acceptedUnits: 1 },
      { runTransaction: () => { called = true; } });
    assert.equal(called, false, `no transaction attempted for ${ts}`);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "invalid-timestamp", `rejected ${ts}`);
  }
  for (const ts of [null, undefined]) {
    let called = false;
    const r = await recordObservationV1(
      { deliveryId: "d", responseReceivedAt: ts, monthlyUsedBeforeSend: 41, acceptedUnits: 1 },
      { runTransaction: () => { called = true; } });
    assert.equal(called, false);
    assert.equal(r.skipped, true, `null/undefined ts skipped`);
  }
});
test("recordObservationV1 accepts a canonical timestamp and writes the exact-limit block", async () => {
  let wrote = null, applied = false;
  const runTransaction = (fn) => fn({ deliveryExists: true, alreadyApplied: false, prevDoc: null,
    writeSnapshot: (d) => { wrote = d; }, markApplied: () => { applied = true; } });
  const r = await recordObservationV1(
    { deliveryId: "d", responseReceivedAt: "2026-08-30T10:00:00.000Z", monthlyUsedBeforeSend: 41, acceptedUnits: 1 },
    { runTransaction });
  assert.equal(r.applied, true);
  assert.equal(applied, true);
  assert.equal(wrote.observedAt, "2026-08-30T10:00:00.000Z");
  assert.equal(wrote.source, "resend-send-response");
  assert.equal(wrote.monthly.limit, 3000);
});

/* ---- P0/P1: stored-timestamp validity + deterministic ordering / tie-break ---- */
const AT1 = "2026-08-30T10:00:00.000Z";
const AT2 = "2026-08-30T10:05:00.000Z";
const prevDocOf = (over = {}) => ({ model: MODEL, providerUsageProven: true,
  monthly: { used: 42, limit: 3000, percent: 1.4 }, daily: null, dailyReason: "not-provided",
  observedAt: AT1, source: "resend-send-response", ...over });
// Record with an injected tx exposing `prevDoc`; returns {wrote, applied, r}.
async function recordWith(prevDoc, { ts = AT1, before = 41, dailyBefore, alreadyApplied = false } = {}) {
  let wrote = null, applied = false;
  const runTransaction = (fn) => fn({ deliveryExists: true, alreadyApplied, prevDoc,
    writeSnapshot: (d) => { wrote = d; }, markApplied: () => { applied = true; } });
  const obs = { deliveryId: "d", responseReceivedAt: ts, monthlyUsedBeforeSend: before, acceptedUnits: 1 };
  if (dailyBefore != null) obs.dailyUsedBeforeSend = dailyBefore;
  const r = await recordObservationV1(obs, { runTransaction });
  return { wrote, applied, r };
}

test("a NON-CANONICAL / malformed stored observedAt is treated as absent → repaired", async () => {
  for (const bad of ["garbage", "2099-01-01", "2099-01-01T00:00:00+00:00", 1735689600000, null]) {
    const { wrote, applied } = await recordWith(prevDocOf({ observedAt: bad }), { ts: AT1, before: 41 });
    assert.ok(wrote, `stored ${JSON.stringify(bad)} treated as absent → write repairs`);
    assert.equal(wrote.monthly.used, 42);
    assert.equal(applied, true);
  }
});

test("a VALID canonical FUTURE stored timestamp still blocks an older incoming observation", async () => {
  const { wrote, applied } = await recordWith(prevDocOf({ observedAt: "2099-01-01T00:00:00.000Z" }), { ts: AT1, before: 41 });
  assert.equal(wrote, null, "older incoming loses to a valid future stored timestamp");
  assert.equal(applied, true, "receipt still marked");
});

test("EQUAL canonical timestamps: greater monthly used wins (42 then 43 → 43)", async () => {
  const { wrote } = await recordWith(prevDocOf({ observedAt: AT1, monthly: { used: 42, limit: 3000, percent: 1.4 } }), { ts: AT1, before: 42 });
  assert.ok(wrote); assert.equal(wrote.monthly.used, 43);
});
test("EQUAL canonical timestamps: lower monthly used loses (43 then 42 → stays 43)", async () => {
  const { wrote, applied } = await recordWith(prevDocOf({ observedAt: AT1, monthly: { used: 43, limit: 3000, percent: 1.4 } }), { ts: AT1, before: 41 });
  assert.equal(wrote, null); assert.equal(applied, true);
});
test("EQUAL timestamps + equal monthly: greater valid daily used wins", async () => {
  const prev = prevDocOf({ observedAt: AT1, monthly: { used: 42, limit: 3000, percent: 1.4 }, daily: { used: 3, limit: 100, percent: 3 }, dailyReason: null });
  const { wrote } = await recordWith(prev, { ts: AT1, before: 41, dailyBefore: 4 }); // monthly 42==42, daily 5>3
  assert.ok(wrote); assert.equal(wrote.monthly.used, 42); assert.equal(wrote.daily.used, 5);
});
test("a LOWER-but-LATER observation still wins; an OLDER delayed one still loses", async () => {
  const lowerLater = await recordWith(prevDocOf({ observedAt: AT1, monthly: { used: 500, limit: 3000, percent: 16.7 } }), { ts: AT2, before: 9 });
  assert.ok(lowerLater.wrote); assert.equal(lowerLater.wrote.monthly.used, 10);
  const olderDelayed = await recordWith(prevDocOf({ observedAt: AT2, monthly: { used: 10, limit: 3000, percent: 0.3 } }), { ts: AT1, before: 499 });
  assert.equal(olderDelayed.wrote, null);
});
test("replay remains idempotent (no write, no ordering evaluated)", async () => {
  const { wrote, r } = await recordWith(prevDocOf(), { ts: AT1, before: 41, alreadyApplied: true });
  assert.equal(r.replay, true); assert.equal(wrote, null);
});
