/* ===================================================================
   Ministry events — birthdays, holidays, and recurring services —
   surfaced on Home so the team can plan content early.

   v1.1: a real recurrence ENGINE replaces hardcoded dates. Each series
   (Cross Over Service, Praise & Testimony Night, the bi-monthly vigil,
   birthdays, holidays) is described by a `rule`, and the engine computes
   the next real occurrence. Every occurrence carries a stable
   `eventSeriesId` + `eventOccurrenceId` (`series_YYYY-MM-DD`) so content
   is linked to ONE specific occurrence, never to the series by name.

   Pure logic (no React/Firebase) — Node-unit-testable like data.js.
   A full Firestore-backed events admin is a later slice; the rule shapes
   below are chosen so series can migrate to Firestore without rework.
   =================================================================== */

const pad = (n) => String(n).padStart(2, "0");
// Local-date ISO (YYYY-MM-DD) — no UTC shift, so a date stays on its day.
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

/* ---- calendar primitives ---- */
// Last calendar day of a month (month is 1-12).
function lastDayOfMonth(year, month) { return new Date(year, month, 0); }

// nth weekday of a month: weekday 0=Sun … 6=Sat, n is 1-based. Returns null
// when that nth weekday doesn't exist (e.g. a 5th Friday).
function nthWeekday(year, month, weekday, n) {
  const first = new Date(year, month - 1, 1);
  const day = 1 + ((weekday - first.getDay() + 7) % 7) + (n - 1) * 7;
  const d = new Date(year, month - 1, day);
  return d.getMonth() === month - 1 ? d : null;
}

// Last given weekday of a month (e.g. last Friday).
function lastWeekdayOfMonth(year, month, weekday) {
  const last = lastDayOfMonth(year, month);
  const back = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month - 1, last.getDate() - back);
}

/* ---- the recurrence engine ----
   Rule types:
     yearlyDate        {month, day}                 — birthdays, fixed holidays
     yearlyNthWeekday  {month, weekday, nth}         — Mother's/Father's Day
     monthlyDate       {day}                         — Nth calendar day (clamped)
     monthlyLastDay    {}                            — Cross Over Service
     monthlyLastWeekday{weekday}                     — Praise & Testimony Night
     monthlyNthWeekday {weekday, nth}                — 3rd-Friday style
   Modifiers (monthly* only): everyX + anchor {year,month} for cadence phase.
   Shared: start / end (ISO), exceptions [ISO], overrides { ISO: ISO }.        */

// The occurrence a rule lands on within one specific month (ignoring cadence).
function occurrenceInMonth(rule, year, month) {
  switch (rule.type) {
    case "yearlyDate":
      return month === rule.month ? new Date(year, month - 1, rule.day) : null;
    case "yearlyNthWeekday":
      return month === rule.month ? nthWeekday(year, month, rule.weekday, rule.nth) : null;
    case "monthlyDate": {
      const dim = lastDayOfMonth(year, month).getDate();
      return new Date(year, month - 1, Math.min(rule.day, dim));
    }
    case "monthlyLastDay":
      return lastDayOfMonth(year, month);
    case "monthlyLastWeekday":
      return lastWeekdayOfMonth(year, month, rule.weekday);
    case "monthlyNthWeekday":
      return nthWeekday(year, month, rule.weekday, rule.nth);
    default:
      return null;
  }
}

// Is (year, month) in cadence phase for an every-X-months rule?
function inPhase(rule, year, month) {
  const everyX = rule.everyX || 1;
  if (everyX === 1) return true;
  const a = rule.anchor;
  if (!a) return true;
  const months = (year - a.year) * 12 + (month - a.month);
  return (((months % everyX) + everyX) % everyX) === 0;
}

/* Next `count` occurrences of a rule on or after `from` (a midnight Date).
   Walks month by month, honouring cadence, start/end, exceptions and
   one-off overrides. Safety-capped so a misconfigured rule can't loop. */
export function nextOccurrences(rule, from, count = 1) {
  const start = rule.start ? parseISO(rule.start) : null;
  const end = rule.end ? parseISO(rule.end) : null;
  const out = [];
  let year = from.getFullYear();
  let month = from.getMonth() + 1;

  for (let i = 0; i < 240 && out.length < count; i++) {
    if (inPhase(rule, year, month)) {
      let d = occurrenceInMonth(rule, year, month);
      if (d) {
        d.setHours(0, 0, 0, 0);
        const scheduledKey = isoDate(d);
        // One-off override: this scheduled date moved to another date.
        let eff = rule.overrides && rule.overrides[scheduledKey]
          ? parseISO(rule.overrides[scheduledKey]) : d;
        const excluded = rule.exceptions && rule.exceptions.includes(scheduledKey);
        const okStart = !start || eff >= start;
        const okEnd = !end || eff <= end;
        if (!excluded && okStart && okEnd && eff >= from) out.push(eff);
      }
    }
    month++; if (month > 12) { month = 1; year++; }
  }
  return out;
}

/* ===================================================================
   SERIES CONFIG
   =================================================================== */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Recurring annual birthdays: [name, month (1-12), day].
const BIRTHDAYS = [
  ["Pastor Esther", 4, 17],
  ["Dr. Oluwasegun", 4, 26],
  ["Pastor David", 5, 1],
  ["Pastor Tope", 7, 19],
  ["Rev. Dr. Sunday Olukoju", 8, 19],
  ["Pastor Dami", 10, 12],
  ["Rev. Dr. Deborah Olukoju", 10, 31],
  ["Pastor Vera", 11, 11],
];

// annual: true → one occurrence a year (legacy name-matching is safe for
// content counts). Recurring services are annual:false — content must link
// by occurrence id so July's event doesn't count August's content.
export const EVENT_SERIES = [
  ...BIRTHDAYS.map(([name, m, d]) => ({
    id: `${slug(name)}-birthday`, name: `${name}'s Birthday`, kind: "birthday", annual: true,
    rule: { type: "yearlyDate", month: m, day: d },
  })),
  { id: "mothers-day", name: "Mother's Day", kind: "holiday", annual: true,
    rule: { type: "yearlyNthWeekday", month: 5, weekday: 0, nth: 2 } },
  { id: "fathers-day", name: "Father's Day", kind: "holiday", annual: true,
    rule: { type: "yearlyNthWeekday", month: 6, weekday: 0, nth: 3 } },

  // Recurring ministry services.
  { id: "cross-over-service", name: "Cross Over Service", kind: "service", annual: false,
    rule: { type: "monthlyLastDay" } },
  // Last Friday of every month, with the series starting from the reference
  // occurrence Fri Aug 28 2026 (so earlier months aren't shown).
  { id: "praise-testimony-night", name: "Praise & Testimony Night", kind: "service", annual: false,
    rule: { type: "monthlyLastWeekday", weekday: 5, start: "2026-08-28" } },
  // 3rd Friday of every OTHER month, anchored to the reference occurrence
  // Fri Aug 21 2026, so the series runs Aug/Oct/Dec 2026, Feb 2027, …
  { id: "bi-monthly-mini-vigil", name: "Bi-Monthly Mini Vigil", kind: "vigil", annual: false,
    rule: { type: "monthlyNthWeekday", weekday: 5, nth: 3, everyX: 2,
            anchor: { year: 2026, month: 8 }, start: "2026-08-21" } },
];

// Shape a raw occurrence Date into the object the app consumes.
function toOccurrence(series, date, today, prepLead) {
  const daysAway = Math.round((date - today) / 86400000);
  return {
    kind: series.kind,
    name: series.name,
    annual: series.annual,
    date,
    eventSeriesId: series.id,
    eventOccurrenceId: `${series.id}_${isoDate(date)}`,
    eventOccurrenceDate: date,
    daysAway,
    prepInDays: Math.max(0, daysAway - prepLead),
    prepNow: daysAway <= prepLead,
  };
}

/* Upcoming events, soonest first — the NEXT occurrence of each series.
   `prepLead` = days before an event that content prep should start. */
export function upcomingEvents(limit = 5, prepLead = 15) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return EVENT_SERIES
    .map((s) => {
      const [next] = nextOccurrences(s.rule, today, 1);
      return next ? toOccurrence(s, next, today, prepLead) : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.daysAway - b.daysAway)
    .slice(0, limit);
}

/* Search across all ministry events — for the global "find anything" search. */
export function searchEvents(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  return upcomingEvents(99).filter((e) => {
    const h = `${e.name} ${e.kind}`.toLowerCase();
    return terms.every((term) => h.includes(term));
  });
}
