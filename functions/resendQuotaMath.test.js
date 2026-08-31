/* Pure quota math for the display-only v1 model. Run: node --test functions/resendQuotaMath.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseQuotaHeader, pct1, validateDimension, isNonNegInt, isPosInt } = require("./resendQuotaMath");

test("parseQuotaHeader: digits → int; anything else → null (never 0)", () => {
  assert.equal(parseQuotaHeader("42"), 42);
  assert.equal(parseQuotaHeader(" 7 "), 7);
  assert.equal(parseQuotaHeader("0"), 0);
  assert.equal(parseQuotaHeader(null), null);
  assert.equal(parseQuotaHeader(""), null);
  assert.equal(parseQuotaHeader("12x"), null);
  assert.equal(parseQuotaHeader("-3"), null);
  assert.equal(parseQuotaHeader("3.5"), null);
});

test("pct1: one-decimal percent; null when limit ≤ 0", () => {
  assert.equal(pct1(3000, 3000), 100);
  assert.equal(pct1(1, 3000), 0);
  assert.equal(pct1(1500, 3000), 50);
  assert.equal(pct1(5, 0), null);
});

test("int guards", () => {
  assert.equal(isNonNegInt(0), true);
  assert.equal(isNonNegInt(-1), false);
  assert.equal(isPosInt(1), true);
  assert.equal(isPosInt(0), false);
});

/* ---- required boundary cases (directive 6) ---- */
test("monthly 2999 + 1 → valid, after 3000 (exactly at plan)", () => {
  const r = validateDimension(2999, 1, 3000);
  assert.equal(r.valid, true);
  assert.equal(r.after, 3000);
});
test("monthly 2999 + 2 → rejected (after over capacity)", () => {
  const r = validateDimension(2999, 2, 3000);
  assert.equal(r.valid, false);
  assert.equal(r.reason, "after-over-capacity");
});
test("header exactly at capacity (3000) → rejected (used at-or-over capacity)", () => {
  const r = validateDimension(3000, 1, 3000);
  assert.equal(r.valid, false);
  assert.equal(r.reason, "used-at-or-over-capacity");
});
test("header over capacity (3001, poisoned) → rejected", () => {
  assert.equal(validateDimension(3001, 1, 3000).valid, false);
});
test("daily 99 + 1 → valid, after 100", () => {
  const r = validateDimension(99, 1, 100);
  assert.equal(r.valid, true);
  assert.equal(r.after, 100);
});
test("daily 99 + 2 → rejected", () => {
  assert.equal(validateDimension(99, 2, 100).valid, false);
});
test("acceptedUnits ≤ 0 → rejected", () => {
  assert.equal(validateDimension(10, 0, 3000).reason, "units-not-positive-int");
  assert.equal(validateDimension(10, -1, 3000).reason, "units-not-positive-int");
});
test("non-integer used → rejected (never fabricated)", () => {
  assert.equal(validateDimension(null, 1, 3000).reason, "used-not-integer");
  assert.equal(validateDimension(1.5, 1, 3000).reason, "used-not-integer");
});
