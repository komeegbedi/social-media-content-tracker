/* Tests for the email helpers: recipient normalization/validation + provider
   error classification. Run with: node --test functions/emailService.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeEmail, validEmail, classifyResend, quotaUnits, testOutcome } = require("./emailService");

/* ---- test-send response contract: the bounded usageRecordError signal ---- */
test("successful recorded send → messageId, NO usageRecordError (null)", () => {
  const r = testOutcome({ status: "sent", providerMessageId: "m1", usageRecordError: null });
  assert.deepEqual(r, { messageId: "m1", usageRecordError: null });
});
test("accepted send + observation WRITE failure → bounded 'record-failed'; email still sent", () => {
  const r = testOutcome({ status: "sent", providerMessageId: "m2", usageRecordError: "ABORTED" });
  assert.equal(r.messageId, "m2", "email remains successful (messageId present)");
  assert.equal(r.usageRecordError, "record-failed");
});
test("raw internal error text is NEVER exposed — any code collapses to exactly 'record-failed'", () => {
  for (const raw of ["ABORTED", "DEADLINE_EXCEEDED", "FirebaseError: 7 PERMISSION_DENIED: ...", "record-failed"]) {
    const r = testOutcome({ status: "sent", providerMessageId: "m", usageRecordError: raw });
    assert.equal(r.usageRecordError, "record-failed", `raw "${raw}" must not leak`);
  }
});
test("missing/invalid quota headers are NOT a save failure (res.usageRecordError null → null)", () => {
  // _deliver leaves usageRecordError null when headers were missing/invalid (no record attempted).
  const r = testOutcome({ status: "sent", providerMessageId: "m3", usageRecordError: null });
  assert.equal(r.usageRecordError, null);
});
test("emulator skip is unchanged (no usageRecordError field forced)", () => {
  const r = testOutcome({ status: "skipped", reason: "emulator" });
  assert.deepEqual(r, { messageId: "", skipped: true, reason: "emulator" });
});
test("quota rejection still throws a classified emailCode (unchanged)", () => {
  for (const [reason, code] of [["monthly_quota_exceeded", "monthly-quota"], ["daily_quota_exceeded", "daily-quota"], ["quota_95_noncritical", "rate-limit"]]) {
    let threw = null;
    try { testOutcome({ status: "suppressed", reason }); } catch (e) { threw = e; }
    assert.ok(threw, `${reason} should throw`);
    assert.equal(threw.emailCode, code);
  }
});

test("quotaUnits counts every to/cc/bcc address (string or array); ignores absent", () => {
  assert.equal(quotaUnits({ to: "a@x" }), 1);
  assert.equal(quotaUnits({ to: ["a@x", "b@x"] }), 2);
  assert.equal(quotaUnits({ to: "a@x", cc: "c@x", bcc: ["d@x", "e@x"] }), 4);
  assert.equal(quotaUnits({ to: ["a@x", "", null] }), 1);   // blanks ignored
  assert.equal(quotaUnits({}), 0);
  assert.equal(quotaUnits(null), 0);
});

test("normalizeEmail trims and lowercases the (case-insensitive) domain", () => {
  assert.equal(normalizeEmail("  Name@Example.COM "), "Name@example.com");
  assert.equal(normalizeEmail("x@Y.Co"), "x@y.co");
  assert.equal(normalizeEmail("plain"), "plain");
  assert.equal(normalizeEmail(""), "");
  assert.equal(normalizeEmail(null), "");
});

test("validEmail accepts real addresses, rejects malformed / display-name-only", () => {
  assert.equal(validEmail("a@b.co"), true);
  assert.equal(validEmail("name.surname@example.com"), true);
  assert.equal(validEmail("John Doe"), false);       // display-name only
  assert.equal(validEmail("no-at-sign"), false);
  assert.equal(validEmail("a@b"), false);            // no TLD
  assert.equal(validEmail("a b@c.co"), false);       // space
  assert.equal(validEmail(""), false);
  assert.equal(validEmail(null), false);
});

test("classifyResend maps provider errors to stable, non-sensitive codes", () => {
  assert.equal(classifyResend({ statusCode: 429 }), "rate-limit");
  assert.equal(classifyResend({ statusCode: 500 }), "temporary");
  assert.equal(classifyResend({ statusCode: 503 }), "temporary");
  assert.equal(classifyResend({ statusCode: 403, message: "domain is not verified" }), "unverified-sender");
  assert.equal(classifyResend({ statusCode: 422, message: "Invalid `to` field" }), "invalid-email");
  assert.equal(classifyResend({ statusCode: 400, message: "some other rejection" }), "provider-rejected");
});
