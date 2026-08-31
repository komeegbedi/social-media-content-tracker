/* Server-side strict V1 sanitizers + callable rejection matrix (pure; injected store).
   Run: node --test functions/resendObservationV1.sanitize.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const v1 = require("./resendObservationV1");
const { sanitizeBlock, sanitizeV1Snapshot, sanitizeTelemetry, isCanonicalIso, safePercent, getObservationV1, MODEL } = v1;

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
