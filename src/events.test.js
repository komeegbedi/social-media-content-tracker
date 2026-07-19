/* Unit tests for the recurrence engine (src/events.js).
   Pure logic — run with:  node --test src/events.test.js
   No test framework dependency beyond Node's built-in `node:test`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOccurrences, isoDate, EVENT_SERIES } from "./events.js";

const D = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const ruleOf = (id) => EVENT_SERIES.find((s) => s.id === id).rule;
const nextISO = (rule, from, n = 1) => nextOccurrences(rule, D(from), n).map(isoDate);

/* ---- Cross Over Service: last calendar day of every month ---- */
test("Cross Over lands on the last day across month lengths", () => {
  const r = ruleOf("cross-over-service");
  // 31-day, 30-day, and Feb (non-leap 2027, leap 2028)
  assert.deepEqual(nextISO(r, "2026-07-01", 4),
    ["2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31"]);
  assert.deepEqual(nextISO(r, "2027-02-01"), ["2027-02-28"]);
  assert.deepEqual(nextISO(r, "2028-02-01"), ["2028-02-29"]); // leap year
});

test("Cross Over on the 31st itself still returns today", () => {
  assert.deepEqual(nextISO(ruleOf("cross-over-service"), "2026-07-31"), ["2026-07-31"]);
});

/* ---- Praise & Testimony Night: last Friday, series starts Aug 28 2026 ---- */
test("Praise & Testimony Night starts Aug 28 2026, then last Friday monthly", () => {
  const r = ruleOf("praise-testimony-night");
  // July 31 is before the start anchor, so the first occurrence is Aug 28.
  // Then Sep 25, Oct 30, Nov 27 (last Fridays).
  assert.deepEqual(nextISO(r, "2026-07-01", 4),
    ["2026-08-28", "2026-09-25", "2026-10-30", "2026-11-27"]);
});

/* ---- Bi-Monthly Mini Vigil: 3rd Friday, every other month, from Aug 21 2026 ---- */
test("Mini Vigil anchors to Fri Aug 21 2026 and runs every 2 months", () => {
  const r = ruleOf("bi-monthly-mini-vigil");
  // From before the anchor, the first occurrence is the reference date.
  assert.deepEqual(nextISO(r, "2026-06-01"), ["2026-08-21"]);
  assert.deepEqual(nextISO(r, "2026-07-15"), ["2026-08-21"]);
});

test("Mini Vigil stays every-other-month across the year boundary", () => {
  const r = ruleOf("bi-monthly-mini-vigil");
  // Aug 2026 → Oct → Dec → Feb 2027 → Apr → Jun (3rd Fridays)
  assert.deepEqual(nextISO(r, "2026-08-01", 6),
    ["2026-08-21", "2026-10-16", "2026-12-18", "2027-02-19", "2027-04-16", "2027-06-18"]);
});

test("Mini Vigil skips the off-phase months entirely", () => {
  const r = ruleOf("bi-monthly-mini-vigil");
  // Sep is off-phase, so from Sep the next hit is Oct 2026.
  assert.deepEqual(nextISO(r, "2026-09-01"), ["2026-10-16"]);
  // No occurrence before the start reference.
  assert.deepEqual(nextISO(r, "2026-02-01"), ["2026-08-21"]);
});

/* ---- yearly rules (birthdays / holidays) ---- */
test("Yearly birthday rolls to next year when past", () => {
  const r = { type: "yearlyDate", month: 4, day: 17 };
  assert.deepEqual(nextISO(r, "2026-05-01"), ["2027-04-17"]);
  assert.deepEqual(nextISO(r, "2026-04-17"), ["2026-04-17"]); // on the day
});

test("Mother's Day = 2nd Sunday of May", () => {
  const r = ruleOf("mothers-day");
  assert.deepEqual(nextISO(r, "2026-01-01"), ["2026-05-10"]);
});

/* ---- exceptions & one-off overrides ---- */
test("Exceptions remove a scheduled occurrence", () => {
  const r = { type: "monthlyLastDay", exceptions: ["2026-08-31"] };
  assert.deepEqual(nextISO(r, "2026-08-01", 2), ["2026-09-30", "2026-10-31"]);
});

test("Overrides move a scheduled occurrence to a new date", () => {
  const r = { type: "monthlyLastDay", overrides: { "2026-08-31": "2026-08-30" } };
  assert.deepEqual(nextISO(r, "2026-08-01"), ["2026-08-30"]);
});

/* ---- occurrence identity ---- */
test("Every series produces a stable occurrence id", () => {
  const [occ] = nextOccurrences(ruleOf("cross-over-service"), D("2026-07-01"), 1);
  assert.equal(`cross-over-service_${isoDate(occ)}`, "cross-over-service_2026-07-31");
});
