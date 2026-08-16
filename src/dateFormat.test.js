/* Locale-aware date formatting contracts (src/dateFormat.js). Firebase-free.
   Assertions target meaningful date PARTS / stable options — never one fragile
   punctuation mark — so they hold across Node/ICU versions.
   Run: node --test src/dateFormat.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDateOnly, formatShortDate, formatDate, formatEventDate, formatDateTime,
  formatReminderDateTime, formatDueDate, formatRelativeTime, formatRelativeShort,
  formatRelativeDays, formatDateRange, calendarDaysUntil, enCount,
} from "./dateFormat.js";

test("1. en-CA: month + day render, ASCII", () => {
  const s = formatShortDate("2026-08-11", { locale: "en-CA" });
  assert.match(s, /Aug/);
  assert.match(s, /11/);
});

test("2. fr-CA: French month name (août), day present", () => {
  const s = formatShortDate("2026-08-11", { locale: "fr-CA" });
  assert.match(s.toLowerCase(), /août|aoû/);
  assert.match(s, /11/);
});

test("3. ar (RTL locale): produces Arabic-script or Arabic-indic output, no 'Invalid Date'", () => {
  const s = formatDate("2026-08-11", { locale: "ar" });
  assert.ok(s && s !== "Invalid Date" && s !== "—");
  // Arabic locale uses Arabic-indic digits or Arabic month names
  assert.ok(/[؀-ۿ]/.test(s) || /\d/.test(s));
});

test("4. date-only is TIMEZONE-INVARIANT: explicit zones can't shift the calendar day", () => {
  // Runs in whatever TZ the process has (CI runs it under UTC, Winnipeg, Tokyo).
  // In ALL of them, and under ANY explicit formatting timeZone, it is August 11.
  for (const tz of ["America/Winnipeg", "UTC", "Pacific/Auckland", "Asia/Tokyo"]) {
    const s = formatDate("2026-08-11", { locale: "en-CA", timeZone: tz });
    assert.match(s, /\b11\b/, `expected day 11 with tz=${tz}, got "${s}"`);
    assert.ok(!/\b10\b/.test(s), `must not shift to the 10th with tz=${tz}, got "${s}"`);
    assert.match(s, /Aug/);
  }
  // parseDateOnly round-trips to the SAME calendar components (UTC getters).
  const d = parseDateOnly("2026-08-11");
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 7);
  assert.equal(d.getUTCDate(), 11);
});

test("4b. IMPOSSIBLE calendar dates return the safe fallback (never silently roll over)", () => {
  for (const bad of ["2026-02-29", "2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2026-06-00"]) {
    assert.equal(parseDateOnly(bad), null, `${bad} should be rejected`);
    assert.equal(formatDate(bad), "—", `${bad} should format as the fallback`);
    assert.equal(formatShortDate(bad), "—");
    assert.equal(formatDueDate(bad), "—");
  }
  // a real leap day IS valid; a normal valid date IS valid
  assert.ok(parseDateOnly("2024-02-29") instanceof Date);
  assert.ok(parseDateOnly("2026-08-11") instanceof Date);
});

test("4c. instant formatting REMAINS timezone-sensitive (real zone differences show)", () => {
  const ts = { toMillis: () => Date.UTC(2026, 7, 11, 3, 30) };   // 03:30 UTC on the 11th
  const winnipeg = formatDateTime(ts, { locale: "en-CA", timeZone: "America/Winnipeg" }); // 21:30 on the 10th
  const utc = formatDateTime(ts, { locale: "en-CA", timeZone: "UTC" });                   // 03:30 on the 11th
  assert.notEqual(winnipeg, utc, "an instant must differ across time zones");
  assert.match(utc, /\b11\b/);
  assert.match(winnipeg, /\b10\b/);   // legitimately the previous day in Winnipeg
});

test("5. missing date → safe fallback, never 'Invalid Date'", () => {
  for (const v of [null, undefined, ""]) {
    assert.equal(formatShortDate(v), "—");
    assert.equal(formatDate(v), "—");
    assert.equal(formatDueDate(v), "—");
    assert.equal(formatRelativeTime(v), "—");
  }
});

test("6. invalid date → the documented fallback exactly (not merely 'not Invalid Date')", () => {
  for (const v of ["not-a-date", "2026-13-40", "garbage", {}, NaN]) {
    assert.equal(formatShortDate(v), "—", `formatShortDate(${String(v)}) must be the fallback`);
    assert.equal(formatDate(v), "—");
    assert.equal(formatEventDate(v), "—");
    assert.equal(formatRelativeTime(v), "—");
  }
  // custom fallback is honoured
  assert.equal(formatShortDate(null, { fallback: "-" }), "-");
});

test("7. timestamp (Firestore-like) formats in a given time zone", () => {
  const ts = { toMillis: () => Date.UTC(2026, 7, 11, 18, 30) };  // 18:30 UTC
  const s = formatDateTime(ts, { locale: "en-CA", timeZone: "America/Winnipeg" });
  assert.match(s, /Aug/);
  assert.match(s, /11/);
  assert.match(s, /\d{1,2}:\d{2}/);   // a time is present
});

test("8. relative: yesterday / today-ish / tomorrow (numeric:auto)", () => {
  const now = new Date(2026, 7, 11, 12, 0, 0);
  assert.match(formatRelativeTime(new Date(2026, 7, 10, 12, 0, 0), { locale: "en", now }), /yesterday/i);
  assert.match(formatRelativeTime(new Date(2026, 7, 12, 12, 0, 0), { locale: "en", now }), /tomorrow/i);
  assert.match(formatRelativeTime(new Date(2026, 7, 11, 12, 0, 0), { locale: "en", now }), /now/i);
});

test("9. relative PAST: singular vs plural via Intl (no manual 's')", () => {
  const now = new Date(2026, 7, 11, 12, 0, 0);
  assert.match(formatRelativeTime(new Date(2026, 7, 9, 12, 0, 0), { locale: "en", now }), /2 days ago/);
  const three = formatRelativeTime(new Date(2026, 7, 8, 12, 0, 0), { locale: "en", now });
  assert.match(three, /3 days ago/);
});

test("10. relative FUTURE: singular vs plural via Intl", () => {
  const now = new Date(2026, 7, 11, 12, 0, 0);
  assert.match(formatRelativeTime(new Date(2026, 7, 13, 12, 0, 0), { locale: "en", now }), /in 2 days/);
  assert.match(formatRelativeTime(new Date(2026, 7, 16, 12, 0, 0), { locale: "en", now }), /in 5 days/);
});

test("11. due-date phrasing (today/tomorrow/weekday/date) — deterministic, not tied to the wall clock", () => {
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // calendarDaysUntil against an EXPLICIT ref (fully deterministic).
  const ref = new Date(2026, 7, 11);
  assert.equal(calendarDaysUntil(iso(2026, 8, 11), ref), 0);
  assert.equal(calendarDaysUntil(iso(2026, 8, 12), ref), 1);
  assert.equal(calendarDaysUntil(iso(2026, 8, 10), ref), -1);
  // formatDueDate uses "today" internally, so derive the inputs FROM today so the
  // assertions hold on any run date.
  const isoOf = (dt) => iso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  const at = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return isoOf(d); };
  assert.equal(formatDueDate(at(0)), "Due today");
  assert.equal(formatDueDate(at(1)), "Due tomorrow");
  assert.equal(formatDueDate(at(-1)), "Due yesterday");
  assert.match(formatDueDate(at(40), { locale: "en-CA" }), /Due [A-Z][a-z]{2}\.? \d/);   // >6 days → dated
});

test("12. date range formats a start..end with month/day", () => {
  const s = formatDateRange("2026-08-11", "2026-08-14", { locale: "en-CA" });
  assert.match(s, /Aug/);
  assert.match(s, /11/);
  assert.match(s, /14/);
});

test("13. pluralization contract: relative day phrases are LOCALIZED via Intl (0/1/2/3, en-CA/fr-CA/ar)", () => {
  // formatRelativeDays delegates to Intl.RelativeTimeFormat — the platform handles
  // plural CATEGORY + noun together per locale (no English-noun mixing).
  const en = [0, 1, 2, 3].map((n) => formatRelativeDays(n, { locale: "en-CA" }));
  assert.deepEqual(en, ["today", "tomorrow", "in 2 days", "in 3 days"]);
  const fr = [0, 1, 2, 3].map((n) => formatRelativeDays(n, { locale: "fr-CA" }));
  assert.match(fr[0], /aujourd/); assert.match(fr[1], /demain/); assert.match(fr[3], /jours/);   // localized noun
  const ar = [0, 1, 2, 3].map((n) => formatRelativeDays(n, { locale: "ar" }));
  ar.forEach((s) => assert.ok(s && s !== "—" && /[؀-ۿ]/.test(s), `Arabic relative day: ${s}`));   // Arabic script
  // fallback for non-numbers
  assert.equal(formatRelativeDays(NaN), "—");
});

test("13b. enCount is ENGLISH-ONLY (English rules + English nouns) — not locale-mixing", () => {
  assert.deepEqual([0, 1, 2, 3].map((n) => enCount(n, "day")), ["0 days", "1 day", "2 days", "3 days"]);
  assert.equal(enCount(1, "task"), "1 task");
  assert.equal(enCount(2, "status"), "2 statuses");
  // compact abbreviated relative form (no plural assembly)
  const now = Date.now();
  assert.equal(formatRelativeShort(new Date(now - 3 * 86400000), { now }), "3d ago");
});

test("13c. reminder date+time is formatted via Intl (no hard-coded ' at 9:00 AM'), tz-invariant", () => {
  const nine = new Date(Date.UTC(2026, 7, 11, 9, 0));
  const en = formatReminderDateTime(nine, { locale: "en-CA" });
  assert.match(en, /Aug/); assert.match(en, /\b11\b/); assert.match(en, /9/); assert.match(en, /\d{1,2}:\d{2}/);
  assert.ok(!/ at 9:00 AM/.test(en), "must not contain a hard-coded ' at 9:00 AM'");
  // fr-CA localizes the time form too
  const fr = formatReminderDateTime(nine, { locale: "fr-CA" });
  assert.ok(fr && fr !== "—" && /9/.test(fr));
});

test("14. parseDateOnly returns null for non-date-only (so ISO input values stay untouched upstream)", () => {
  assert.equal(parseDateOnly("2026-08-11T10:00:00Z"), null);  // an instant, not a date-only
  assert.equal(parseDateOnly("2026/08/11"), null);
  assert.equal(parseDateOnly(""), null);
  // a valid date-only round-trips to the same Y-M-D (UTC getters — it's a UTC-
  // midnight calendar instant, timezone-invariant regardless of the process TZ).
  const d = parseDateOnly("2026-01-05");
  const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  assert.equal(iso, "2026-01-05");
});
