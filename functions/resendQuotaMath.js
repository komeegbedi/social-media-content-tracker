/* Pure, provider-neutral quota-header parsing + numeric validation for the DISPLAY-ONLY
   Resend usage model (resendObservationV1.js). No firebase-admin, no Firestore, no I/O →
   node-unit-testable and free of circular imports.

   Deliberately duplicates a couple of tiny validation ops rather than refactoring the
   dormant legacy resendUsage.js: this is a scoped, display-only change, and a few lines of
   duplication are preferable to widening it into a legacy refactor. Legacy code is not
   modified and never reads/writes the v1 document. */

const isNonNegInt = (n) => Number.isInteger(n) && n >= 0;
const isPosInt = (n) => Number.isInteger(n) && n > 0;

// A quota header/value → finite non-negative integer, else null (never 0 on bad input).
function parseQuotaHeader(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// One-decimal percentage; null when the limit is not a positive number.
const pct1 = (used, limit) => (limit > 0 ? Math.round((used / limit) * 1000) / 10 : null);

/* Validate ONE dimension (monthly or daily) of a proven pre-send observation against its
   plan limit. BOTH the before-send value AND the computed after-send total are checked:
     • acceptedUnits is a POSITIVE integer;
     • usedBeforeSend is a non-negative integer STRICTLY BELOW the plan limit;
     • after = usedBeforeSend + acceptedUnits must be <= the plan limit.
   A header at capacity, a header over capacity, or an after-send over capacity is
   rejected. Returns { valid, after } or { valid:false, code, reason }. */
function validateDimension(usedBeforeSend, acceptedUnits, planLimit) {
  if (!isPosInt(acceptedUnits)) return { valid: false, code: "invalid-provider-observation", reason: "units-not-positive-int" };
  if (!isNonNegInt(usedBeforeSend)) return { valid: false, code: "invalid-provider-observation", reason: "used-not-integer" };
  if (!isPosInt(planLimit)) return { valid: false, code: "invalid-provider-observation", reason: "plan-limit-invalid" };
  if (usedBeforeSend >= planLimit) return { valid: false, code: "invalid-provider-observation", reason: "used-at-or-over-capacity" };
  const after = usedBeforeSend + acceptedUnits;
  if (after > planLimit) return { valid: false, code: "invalid-provider-observation", reason: "after-over-capacity" };
  return { valid: true, after };
}

module.exports = { isNonNegInt, isPosInt, parseQuotaHeader, pct1, validateDimension };
