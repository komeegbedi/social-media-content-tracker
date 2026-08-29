/* Resend usage — pre-send header accounting + idempotent merge (pure/unit).
   Run: node --test functions/resendUsage.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const svc = require("./resendUsage");
const {
  getResendQuotaUsage, recordObservedUsage, applyObservation, periodKeysFor,
  parseQuotaHeader, pct1, PLAN_MONTHLY_LIMIT, validateObservation, cachedUsageValid,
} = svc;

const TELE = { appInitiatedThisMonth: 0, appSafetyCap: 2800 };
const FIXED = Date.parse("2026-08-28T12:00:00.000Z"); // month 2026-08, day 2026-08-28
const clock = (ms = FIXED) => () => ms;
const noAlerts = async () => {};
const KEYS = periodKeysFor(FIXED);

// tx runner over an in-memory cache doc + public doc + delivery receipt.
function memTx(state = { doc: null, pub: null, delivery: null }) {
  const run = (fn) => fn({
    prev: state.doc, delivery: state.delivery,
    write: (data) => { state.doc = { ...(state.doc || {}), ...data }; },
    writePublic: (data) => { state.pub = { ...(state.pub || {}), ...data }; },
    writeReceipt: (units) => { state.delivery = { ...(state.delivery || {}), usageApplied: true, usageAppliedUnits: units }; },
  });
  run.state = state;
  return run;
}
function memStore(initial = null) {
  let doc = initial;
  return { read: async () => doc, write: async (s) => { doc = { ...(doc || {}), ...s }; }, peek: () => doc };
}
const inp = (before, dBefore, units) => ({ monthlyUsedBeforeSend: before, dailyUsedBeforeSend: dBefore, acceptedUnits: units });

/* ---- validation ---- */
test("parseQuotaHeader: valid; never 0 for missing/malformed", () => {
  assert.equal(parseQuotaHeader("42"), 42); assert.equal(parseQuotaHeader(null), null); assert.equal(parseQuotaHeader("N/A"), null);
});
test("pct1: one decimal", () => { assert.equal(pct1(43, 3000), 1.4); });

/* ---- applyObservation: header is PRE-send; add accepted units ---- */
test("fresh send: header 42/2 + one recipient → 43/3", () => {
  const { snap } = applyObservation(null, inp(42, 2, 1), false, FIXED);
  assert.equal(snap.monthlyUsed, 43);
  assert.equal(snap.dailyUsed, 3);
});
test("two accepted recipients add two units (44/4)", () => {
  const { snap } = applyObservation(null, inp(42, 2, 2), false, FIXED);
  assert.equal(snap.monthlyUsed, 44);
  assert.equal(snap.dailyUsed, 4);
});
test("concurrency: local floor wins — prev already 43, header 42, +1 → 44", () => {
  const prev = { monthlyUsed: 43, periodMonth: KEYS.month, periodDay: KEYS.day };
  const { snap } = applyObservation(prev, inp(42, 2, 1), false, FIXED);
  assert.equal(snap.monthlyUsed, 44, "cannot land at 43 again");
});
test("out-of-band: prev 42, provider header 50, +1 → 51 (provider floor wins)", () => {
  const prev = { monthlyUsed: 42, periodMonth: KEYS.month, periodDay: KEYS.day };
  const { snap } = applyObservation(prev, inp(50, null, 1), false, FIXED);
  assert.equal(snap.monthlyUsed, 51);
});
test("catch-up: a missed earlier send is reflected by the next header", () => {
  // prev cache 42 (one send missed), next header 44 (reflects the missed + before), +1 → 45
  const prev = { monthlyUsed: 42, periodMonth: KEYS.month, periodDay: KEYS.day };
  assert.equal(applyObservation(prev, inp(44, null, 1), false, FIXED).snap.monthlyUsed, 45);
});
test("replay (already applied) does not add units — reconciles max(prev, header)", () => {
  const prev = { monthlyUsed: 44, periodMonth: KEYS.month, periodDay: KEYS.day };
  assert.equal(applyObservation(prev, inp(42, null, 1), true, FIXED).snap.monthlyUsed, 44);
});
test("self-heal: a poisoned cached floor (3001) is ignored so a valid send resets it", () => {
  const prev = { monthlyUsed: 3001, dailyUsed: 200, periodMonth: KEYS.month, periodDay: KEYS.day };
  const { snap } = applyObservation(prev, inp(44, 3, 1), false, FIXED);
  assert.equal(snap.monthlyUsed, 45, "impossible prev floor must not latch");
  assert.equal(snap.dailyUsed, 4, "impossible daily floor must not latch");
});
test("month transition permits reset (header 5 + 1 → 6)", () => {
  const prev = { monthlyUsed: 2900, periodMonth: "2026-07", periodDay: "2026-07-31" };
  const { snap } = applyObservation(prev, inp(5, null, 1), false, FIXED);
  assert.equal(snap.monthlyUsed, 6);
  assert.equal(snap.periodMonth, "2026-08");
});
test("paid plan (no daily header) → dailyUsed null unless a same-day value already exists", () => {
  assert.equal(applyObservation(null, inp(300, null, 1), false, FIXED).snap.dailyUsed, null);
  const prev = { monthlyUsed: 40, dailyUsed: 9, periodMonth: KEYS.month, periodDay: KEYS.day };
  assert.equal(applyObservation(prev, inp(41, null, 1), false, FIXED).snap.dailyUsed, 9); // don't regress
});

/* ---- STRICT validation (the 3001 defect) ---- */
test("header 3000 with plan 3000 + one recipient is REJECTED (never becomes 3001)", () => {
  const v = validateObservation({ monthlyUsedBeforeSend: 3000, dailyUsedBeforeSend: 3, acceptedUnits: 1 });
  assert.equal(v.valid, false);
  assert.equal(v.code, "invalid-provider-observation");
  assert.equal(v.reason, "monthly-exceeds-plan");
});
test("a header EQUAL to plan capacity is not treated as usage", () => {
  assert.equal(validateObservation({ monthlyUsedBeforeSend: PLAN_MONTHLY_LIMIT, acceptedUnits: 1 }).valid, false);
});
test("monthly used greater than the plan limit is rejected", () => {
  assert.equal(validateObservation({ monthlyUsedBeforeSend: 5000, acceptedUnits: 1 }).valid, false);
});
test("daily used greater than the daily limit is rejected (independently)", () => {
  assert.equal(validateObservation({ monthlyUsedBeforeSend: 40, dailyUsedBeforeSend: 100, acceptedUnits: 1 }).valid, false);
});
test("non-integer / negative headers are rejected", () => {
  assert.equal(validateObservation({ monthlyUsedBeforeSend: 1.5, acceptedUnits: 1 }).valid, false);
  assert.equal(validateObservation({ monthlyUsedBeforeSend: -1, acceptedUnits: 1 }).valid, false);
});
test("a normal pre-send used value passes (42 + 1 ≤ 3000)", () => {
  assert.deepEqual(validateObservation({ monthlyUsedBeforeSend: 42, dailyUsedBeforeSend: 2, acceptedUnits: 1 }), { valid: true, units: 1 });
});
test("the exactly-full boundary is valid (2999 + 1 = 3000)", () => {
  assert.equal(validateObservation({ monthlyUsedBeforeSend: 2999, acceptedUnits: 1 }).valid, true);
});
test("cachedUsageValid rejects a poisoned 3001/3000 snapshot", () => {
  assert.equal(cachedUsageValid({ monthlyUsed: 3001, monthlyLimit: 3000 }), false);
  assert.equal(cachedUsageValid({ monthlyUsed: 42, monthlyLimit: 3000 }), true);
});

test("recordObservedUsage REJECTS an invalid observation — no write, no receipt, no alert", async () => {
  const run = memTx({ doc: { monthlyUsed: 42, periodMonth: KEYS.month, periodDay: KEYS.day }, pub: null, delivery: null });
  const fired = [];
  const out = await recordObservedUsage({ monthlyUsedBeforeSend: 3000, dailyUsedBeforeSend: 3, acceptedUnits: 1, deliveryId: "bad" },
    { now: clock(), alerter: async (t) => fired.push(...t), runTransaction: run, provenSemantics: true });
  assert.equal(out.invalid, true);
  assert.equal(out.code, "invalid-provider-observation");
  assert.equal(run.state.doc.monthlyUsed, 42, "last known-good NOT overwritten");
  assert.equal(run.state.pub, null, "nothing published");
  assert.equal(run.state.delivery, null, "no receipt written");
  assert.deepEqual(fired, [], "no threshold alert fired");
});

test("getResendQuotaUsage shows a poisoned cache as unavailable (never 3001/3000)", async () => {
  const poisoned = { monthlyUsed: 3001, dailyUsed: 4, monthlyLimit: 3000, dailyLimit: 100,
    observedAt: new Date(FIXED).toISOString(), periodMonth: KEYS.month, periodDay: KEYS.day };
  const r = await getResendQuotaUsage({ store: memStore(poisoned), now: clock(), telemetry: TELE, provenSemantics: true });
  assert.equal(r.providerAvailable, false);
  assert.equal(r.monthly, null);
  assert.equal(r.providerError.code, "invalid-provider-observation");
  assert.deepEqual(r.internalTelemetry, TELE, "app safety telemetry still returned");
});

/* ---- recordObservedUsage (transactional, receipt) ---- */
test("records post-send usage, publishes sanitized public doc, writes receipt", async () => {
  const run = memTx();
  const snap = await recordObservedUsage({ ...inp(42, 2, 1), deliveryId: "d1" }, { now: clock(), alerter: noAlerts, runTransaction: run, provenSemantics: true });
  assert.equal(snap.monthlyUsed, 43);
  assert.equal(run.state.doc.monthlyUsed, 43);
  assert.deepEqual(run.state.pub.monthly, { used: 43, limit: 3000, percent: pct1(43, 3000) });
  assert.deepEqual(run.state.pub.daily, { used: 3, limit: 100, percent: 3 });
  assert.equal(run.state.delivery.usageApplied, true);
  assert.equal(run.state.delivery.usageAppliedUnits, 1);
  // sanitized — no internal fields leak
  for (const k of ["monthlyUsed", "alertedThresholds", "usageApplied"]) assert.equal(k in run.state.pub, false);
});

test("a replayed idempotency key does not increment twice (43 stays 43)", async () => {
  const run = memTx();
  await recordObservedUsage({ ...inp(42, 2, 1), deliveryId: "d2" }, { now: clock(), alerter: noAlerts, runTransaction: run, provenSemantics: true });
  assert.equal(run.state.doc.monthlyUsed, 43);
  await recordObservedUsage({ ...inp(42, 2, 1), deliveryId: "d2" }, { now: clock(), alerter: noAlerts, runTransaction: run, provenSemantics: true }); // replay
  assert.equal(run.state.doc.monthlyUsed, 43, "no double-count on replay");
});

test("an invalid monthly-before value publishes nothing", async () => {
  const run = memTx();
  const out = await recordObservedUsage({ monthlyUsedBeforeSend: null, acceptedUnits: 1, deliveryId: "d3" }, { now: clock(), alerter: noAlerts, runTransaction: run, provenSemantics: true });
  assert.equal(out.invalid, true);
  assert.equal(run.state.pub, null);
  assert.equal(run.state.doc, null);
});

test("acceptedUnits defaults to 1 when absent/invalid", async () => {
  const run = memTx();
  await recordObservedUsage({ monthlyUsedBeforeSend: 42, dailyUsedBeforeSend: 2, deliveryId: "d4" }, { now: clock(), alerter: noAlerts, runTransaction: run, provenSemantics: true });
  assert.equal(run.state.doc.monthlyUsed, 43);
});

/* ---- getResendQuotaUsage (reads cache; period-aware) ---- */
const cached = (over = {}) => ({ monthlyUsed: 43, dailyUsed: 3, monthlyLimit: 3000, dailyLimit: 100,
  observedAt: new Date(FIXED).toISOString(), periodMonth: KEYS.month, periodDay: KEYS.day, ...over });

test("observed cache → view model (43/3000, 3/100)", async () => {
  const r = await getResendQuotaUsage({ store: memStore(cached()), now: clock(), telemetry: TELE, provenSemantics: true });
  assert.equal(r.providerAvailable, true);
  assert.equal(r.monthly.used, 43);
  assert.equal(r.daily.used, 3);
});
test("nothing observed → providerAvailable:false", async () => {
  const r = await getResendQuotaUsage({ store: memStore(null), now: clock(), telemetry: TELE, provenSemantics: true });
  assert.equal(r.providerAvailable, false);
  assert.equal(r.providerError.code, "not-observed");
});
test("prior month → not-observed-this-month", async () => {
  const r = await getResendQuotaUsage({ store: memStore(cached({ periodMonth: "2026-07" })), now: clock(), telemetry: TELE, provenSemantics: true });
  assert.equal(r.providerAvailable, false);
  assert.equal(r.providerError.code, "not-observed-this-month");
});
test("new day → daily null with not-observed-today; monthly kept", async () => {
  const r = await getResendQuotaUsage({ store: memStore(cached({ periodDay: "2026-08-27" })), now: clock(), telemetry: TELE, provenSemantics: true });
  assert.equal(r.monthly.used, 43);
  assert.equal(r.daily, null);
  assert.equal(r.dailyReason, "not-observed-today");
});
test("legacy cache without period keys → not shown as current", async () => {
  const r = await getResendQuotaUsage({ store: memStore({ monthlyUsed: 43, observedAt: new Date(FIXED).toISOString() }), now: clock(), telemetry: TELE, provenSemantics: true });
  assert.equal(r.providerAvailable, false);
  assert.equal(r.providerError.code, "not-observed-this-month");
});
/* ---- CONTAINMENT: header semantics unproven (default flag) ---- */
test("containment: recordObservedUsage persists NOTHING while semantics unproven", async () => {
  const run = memTx();
  const out = await recordObservedUsage({ monthlyUsedBeforeSend: 42, dailyUsedBeforeSend: 2, acceptedUnits: 1, deliveryId: "c1" },
    { now: clock(), alerter: noAlerts, runTransaction: run }); // no provenSemantics → default false
  assert.equal(out.skipped, true);
  assert.equal(out.reason, "header-semantics-unproven");
  assert.equal(run.state.doc, null, "no cache write");
  assert.equal(run.state.pub, null, "no public write");
  assert.equal(run.state.delivery, null, "no receipt");
});
test("containment: a bounded-but-unproven header (42/3000) is NOT persisted", async () => {
  const run = memTx();
  const out = await recordObservedUsage({ monthlyUsedBeforeSend: 42, acceptedUnits: 1, deliveryId: "c2" },
    { now: clock(), alerter: noAlerts, runTransaction: run });
  assert.equal(out.skipped, true);
  assert.equal(run.state.doc, null);
});
test("containment: getResendQuotaUsage reports provider-usage-unverified (even for a bounded cache)", async () => {
  const r = await getResendQuotaUsage({ store: memStore(cached()), now: clock(), telemetry: TELE }); // default false
  assert.equal(r.providerAvailable, false);
  assert.equal(r.monthly, null);
  assert.equal(r.providerError.code, "provider-usage-unverified");
  assert.deepEqual(r.internalTelemetry, TELE, "app safety telemetry still returned");
});

test("result never contains key material", async () => {
  const r = await getResendQuotaUsage({ store: memStore(cached()), now: clock(), telemetry: TELE, provenSemantics: true });
  const blob = JSON.stringify(r).toLowerCase();
  assert.equal(blob.includes("re_"), false);
  assert.equal("_debug" in r, false);
});
