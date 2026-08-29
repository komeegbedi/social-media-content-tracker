/* Raw POST /emails transport + provider-error classification (pure/unit, injected
   fetch + record). Run: node --test functions/resendPost.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resendPostSend, classifyProviderError, pickDiagnosticHeaders } = require("./emailService");

const KEY = "re_test_key";

function mkRes(status, { headers = {}, body = {}, jsonThrows = false } = {}) {
  const low = {}; for (const [k, v] of Object.entries(headers)) low[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (low[String(k).toLowerCase()] ?? null) },
    json: async () => { if (jsonThrows) throw new Error("not json"); return body; },
  };
}
const capture = () => { const calls = []; return { record: async (o) => calls.push(o), calls }; };

/* ---- diagnostic header allowlisting (no sensitive info leaks) ---- */
test("pickDiagnosticHeaders captures quota/rate headers but NEVER auth/cookies/recipients", () => {
  const headers = {
    "x-resend-monthly-quota": "42", "x-resend-daily-quota": "3",
    "ratelimit-remaining": "9", "x-ratelimit-limit": "10", "retry-after": "30",
    "authorization": "Bearer re_secret_key", "set-cookie": "sid=abc",
    "x-api-key": "re_secret", "to": "victim@example.com", "x-recipient-email": "a@b.com",
    "content-type": "application/json",
  };
  const diag = pickDiagnosticHeaders(headers);
  assert.equal(diag["x-resend-monthly-quota"], "42");
  assert.equal(diag["x-resend-daily-quota"], "3");
  assert.equal(diag["ratelimit-remaining"], "9");
  const blob = JSON.stringify(diag).toLowerCase();
  for (const bad of ["authorization", "bearer", "re_secret", "cookie", "sid=", "victim@example.com", "x-recipient", "x-api-key"]) {
    assert.equal(blob.includes(bad.toLowerCase()), false, `must not leak ${bad}`);
  }
});
test("pickDiagnosticHeaders works on a Headers-like object (forEach) and tolerates junk", () => {
  const map = new Map([["x-resend-monthly-quota", "7"], ["authorization", "Bearer x"]]);
  const like = { forEach: (fn) => map.forEach((v, k) => fn(v, k)) };
  assert.deepEqual(pickDiagnosticHeaders(like), { "x-resend-monthly-quota": "7" });
  assert.deepEqual(pickDiagnosticHeaders(null), {});
});

/* ---- classifyProviderError ---- */
test("classifyProviderError: 429 request-rate → rate-limit (retry)", () => {
  assert.deepEqual(classifyProviderError(429, "rate_limit_exceeded"), { kind: "rate-limit" });
  assert.deepEqual(classifyProviderError(429, undefined), { kind: "rate-limit" });
});
test("classifyProviderError: 429 quota exhaustion → quota (no retry), with scope", () => {
  assert.deepEqual(classifyProviderError(429, "daily_quota_exceeded"), { kind: "quota", scope: "daily" });
  assert.deepEqual(classifyProviderError(429, "monthly_quota_exceeded"), { kind: "quota", scope: "monthly" });
});
test("classifyProviderError: 4xx → permanent; 5xx → transient", () => {
  assert.deepEqual(classifyProviderError(422, "validation_error"), { kind: "permanent" });
  assert.deepEqual(classifyProviderError(403, "forbidden"), { kind: "permanent" });
  assert.deepEqual(classifyProviderError(503, undefined), { kind: "transient" });
});

/* ---- resendPostSend ---- */
test("successful send WITH quota headers → ok + data.id + records usage", async () => {
  const { record, calls } = capture();
  const r = await resendPostSend(KEY, { from: "a", to: "b" }, "idem1", {
    fetchImpl: async () => mkRes(200, { headers: { "x-resend-monthly-quota": "41", "x-resend-daily-quota": "2" }, body: { id: "m1" } }),
    record,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.id, "m1");
  assert.equal(r.error, null);
  // Headers are PRE-send; records the before-values + accepted units + delivery id.
  assert.deepEqual(calls, [{ monthlyUsedBeforeSend: 41, dailyUsedBeforeSend: 2, acceptedUnits: 1, deliveryId: "idem1" }]);
});

test("acceptedUnits counts to + cc + bcc (multi-recipient)", async () => {
  const { record, calls } = capture();
  await resendPostSend(KEY, { to: ["a@x", "b@x"], cc: "c@x", bcc: ["d@x"] }, "idemN", {
    fetchImpl: async () => mkRes(200, { headers: { "x-resend-monthly-quota": "10" }, body: { id: "m" } }), record,
  });
  assert.equal(calls[0].acceptedUnits, 4); // 2 to + 1 cc + 1 bcc
});

test("successful send WITHOUT quota headers → ok, nothing recorded", async () => {
  const { record, calls } = capture();
  const r = await resendPostSend(KEY, {}, "i", { fetchImpl: async () => mkRes(200, { body: { id: "m" } }), record });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0);
});

test("malformed quota header → not recorded (never treated as 0)", async () => {
  const { record, calls } = capture();
  await resendPostSend(KEY, {}, "i", { fetchImpl: async () => mkRes(200, { headers: { "x-resend-monthly-quota": "N/A" }, body: { id: "m" } }), record });
  assert.equal(calls.length, 0);
});

test("4xx provider rejection → error, permanent, no record", async () => {
  const { record, calls } = capture();
  const r = await resendPostSend(KEY, {}, "i", { fetchImpl: async () => mkRes(422, { body: { name: "validation_error", message: "bad" } }), record });
  assert.equal(r.ok, false);
  assert.equal(r.error.statusCode, 422);
  assert.equal(r.error.name, "validation_error");
  assert.deepEqual(classifyProviderError(r.error.statusCode, r.error.name), { kind: "permanent" });
  assert.equal(calls.length, 0);
});

test("request-rate 429 → error name preserved, classified rate-limit", async () => {
  const r = await resendPostSend(KEY, {}, "i", { fetchImpl: async () => mkRes(429, { body: { name: "rate_limit_exceeded", message: "slow down" } }), record: async () => {} });
  assert.equal(r.error.statusCode, 429);
  assert.deepEqual(classifyProviderError(r.error.statusCode, r.error.name), { kind: "rate-limit" });
});

test("a quota 429 does NOT record usage (only a SUCCESSFUL send counts)", async () => {
  const { record, calls } = capture();
  const r = await resendPostSend(KEY, {}, "i", { fetchImpl: async () => mkRes(429, { headers: { "x-resend-monthly-quota": "3000" }, body: { name: "monthly_quota_exceeded" } }), record });
  assert.equal(r.error.name, "monthly_quota_exceeded");
  assert.equal(calls.length, 0, "no increment on a quota rejection");
});

test("a usage-recording FAILURE after a successful send is observable (not swallowed as success)", async () => {
  const r = await resendPostSend(KEY, { to: "a@x" }, "idemF", {
    fetchImpl: async () => mkRes(200, { headers: { "x-resend-monthly-quota": "10" }, body: { id: "m" } }),
    record: async () => { const e = new Error("aborted"); e.code = "ABORTED"; throw e; },
  });
  assert.equal(r.ok, true, "the send itself still succeeded");
  assert.equal(r.usageRecordError, "ABORTED", "the recording failure is surfaced, not hidden");
});

test("5xx → transient (retry)", async () => {
  const r = await resendPostSend(KEY, {}, "i", { fetchImpl: async () => mkRes(503, { body: {} }), record: async () => {} });
  assert.deepEqual(classifyProviderError(r.error.statusCode, r.error.name), { kind: "transient" });
});

test("timeout / abort → transport (uncertain → retry with same key)", async () => {
  const r = await resendPostSend(KEY, {}, "i", {
    fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }, record: async () => {},
  });
  assert.ok(r.transport);
  assert.equal(r.timedOut, true);
  assert.equal(r.error, undefined);
});

test("network error → transport (not timed out)", async () => {
  const r = await resendPostSend(KEY, {}, "i", { fetchImpl: async () => { throw new Error("ECONNRESET"); }, record: async () => {} });
  assert.ok(r.transport);
  assert.equal(r.timedOut, false);
});

test("malformed / non-JSON success body → handled (data null, still ok)", async () => {
  const r = await resendPostSend(KEY, {}, "i", { fetchImpl: async () => mkRes(200, { headers: { "x-resend-monthly-quota": "40" }, jsonThrows: true }), record: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.data, null);
});

test("sends Idempotency-Key + User-Agent, preserves Authorization + Content-Type + signal", async () => {
  let seen;
  await resendPostSend(KEY, { from: "a" }, "idem-xyz", { fetchImpl: async (_u, opts) => { seen = opts; return mkRes(200, { body: { id: "m" } }); }, record: async () => {} });
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(seen.headers["Content-Type"], "application/json");
  assert.equal(seen.headers["Idempotency-Key"], "idem-xyz");
  assert.equal(seen.headers["User-Agent"], "IFC-Creatives-Board/1.0");
  assert.ok(seen.signal, "AbortController signal is passed for the timeout");
});
