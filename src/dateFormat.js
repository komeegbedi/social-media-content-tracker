/* Centralised, locale-aware date/time presentation (Intl). Firebase-free +
   pure, so it is unit-testable with an explicit locale/time zone. This layer
   changes ONLY how dates are DISPLAYED — never how they are stored, compared,
   sorted, or used in recurrence/import. ISO keys, <input type="date"> values,
   Firestore Timestamps, and server timestamps are untouched.

   DATE-ONLY POLICY (documented, one choice — TIMEZONE-INVARIANT):
   Calendar-only values ("YYYY-MM-DD", e.g. a post/due date) represent an ABSTRACT
   CALENDAR DAY, not an instant. We (1) validate the y/m/d components and reject
   impossible dates (Feb 31, month 13, …), (2) construct the instant at UTC
   midnight, and (3) ALWAYS format date-only values in the SAME fixed zone (UTC),
   ignoring any caller `timeZone`. So "2026-08-11" renders as August 11 in EVERY
   process time zone and under EVERY explicit formatting timeZone — the calendar
   day can never shift. Real INSTANTS (Firestore Timestamps / Date instants) still
   honour the requested/viewer time zone so legitimate zone differences show.

   Run: TZ=UTC node --test src/dateFormat.test.js (also under Winnipeg / Tokyo) */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NEUTRAL_TZ = "UTC";

// "YYYY-MM-DD" → a Date at UTC midnight of that calendar day, or null. Rejects
// anything that isn't a clean date-only string AND any IMPOSSIBLE calendar date:
// after constructing, the round-tripped y/m/d must equal the requested components
// (so "2026-02-31" → null, never a silently-rolled March 3).
export function parseDateOnly(s) {
  if (typeof s !== "string" || !DATE_ONLY.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

// Resolve any supported value to { d, dateOnly }. Date-only strings → UTC-midnight
// + dateOnly:true (format in the neutral zone). Everything else is an INSTANT.
function resolve(v) {
  if (v == null || v === "") return { d: null, dateOnly: false };
  if (typeof v === "string" && DATE_ONLY.test(v)) return { d: parseDateOnly(v), dateOnly: true };
  let d = null;
  if (typeof v === "object" && typeof v.toMillis === "function") d = new Date(v.toMillis());
  else if (typeof v === "object" && typeof v.toDate === "function") d = new Date(v.toDate());
  else if (v instanceof Date) d = v;
  else if (typeof v === "number") d = new Date(v);
  else if (typeof v === "string") d = new Date(v);
  return { d: d && !Number.isNaN(d.getTime()) ? d : null, dateOnly: false };
}

// Back-compat: a plain Date|null for callers that only need an instant.
function toDate(v) { return resolve(v).d; }

// null/invalid never surface "Invalid Date" — callers get this instead.
const FALLBACK = "—";

function fmtWith(v, opts, { locale, timeZone, fallback = FALLBACK } = {}) {
  const { d, dateOnly } = resolve(v);
  if (!d) return fallback;
  // Date-only: force the neutral zone so an explicit timeZone can't shift the
  // calendar day. Instants: honour the requested/viewer zone.
  const tz = dateOnly ? NEUTRAL_TZ : timeZone;
  try {
    return new Intl.DateTimeFormat(locale, tz ? { ...opts, timeZone: tz } : opts).format(d);
  } catch {
    return fallback;
  }
}

/* Month + day, e.g. "Aug 11" / "11 août" / "١١ أغسطس". */
export function formatShortDate(v, o = {}) {
  return fmtWith(v, { month: "short", day: "numeric" }, o);
}

/* Full date, e.g. "August 11, 2026". */
export function formatDate(v, o = {}) {
  return fmtWith(v, { year: "numeric", month: "long", day: "numeric" }, o);
}

/* An event date, e.g. "Aug 11, 2026" — locale-ordered, no hand-built English
   ordinal (replaces the old `${month} ${ordinal(day)}, ${year}`). */
export function formatEventDate(v, o = {}) {
  return fmtWith(v, { year: "numeric", month: "short", day: "numeric" }, o);
}

/* An instant (timestamp) in the viewer's local time zone by default. */
export function formatDateTime(v, o = {}) {
  return fmtWith(v, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }, o);
}

/* A reminder's date + time. The fire time (9:00 AM Winnipeg) is a PRODUCT CONSTANT
   — callers pass a Date whose UTC wall-clock is the calendar day at 09:00. We
   format date+time in the neutral zone so it's tz-invariant AND locale-aware
   (AM/PM, "9 h 00", Arabic numerals), replacing the old hard-coded " at 9:00 AM". */
export function formatReminderDateTime(v, o = {}) {
  const d = v instanceof Date ? v : resolve(v).d;
  if (!d || Number.isNaN(d.getTime())) return o.fallback ?? FALLBACK;
  try {
    return new Intl.DateTimeFormat(o.locale, {
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZone: NEUTRAL_TZ,
    }).format(d);
  } catch { return o.fallback ?? FALLBACK; }
}

// Local calendar-day difference (today = 0, tomorrow = 1, yesterday = -1) for a
// date-only value — used to pick due-date phrasing. Calendar-safe.
export function calendarDaysUntil(s, ref = new Date()) {
  const d = parseDateOnly(typeof s === "string" ? s : "");
  if (!d) return null;
  // Compare as UTC-midnight of each side's CALENDAR day (ref's local calendar day
  // → UTC midnight), so the difference is a pure calendar-day count, tz-invariant.
  const refUtc = Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate());
  return Math.round((d.getTime() - refUtc) / 86400000);
}

/* A due-date label for a calendar-only date: "Due today/tomorrow/yesterday",
   "Due <weekday>" within a week, otherwise "Due <month day>". Locale month +
   weekday names; no manual pluralisation. */
export function formatDueDate(s, o = {}) {
  const n = calendarDaysUntil(s);
  if (n === null) return o.fallback ?? FALLBACK;
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  if (n === -1) return "Due yesterday";
  if (n > 0 && n <= 6) return "Due " + fmtWith(s, { weekday: "long" }, o);
  return "Due " + formatShortDate(s, o);
}

// Pick the largest whole unit for a signed day/second delta. Deterministic
// thresholds: <60s → seconds, <60m → minutes, <24h → hours, <7d → days,
// <5w → weeks, <12mo → months, else years.
function relUnit(diffMs) {
  const s = Math.round(diffMs / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return [s, "second"];
  const m = Math.round(s / 60); if (Math.abs(m) < 60) return [m, "minute"];
  const h = Math.round(m / 60); if (Math.abs(h) < 24) return [h, "hour"];
  const d = Math.round(h / 24); if (Math.abs(d) < 7) return [d, "day"];
  const w = Math.round(d / 7); if (Math.abs(w) < 5) return [w, "week"];
  const mo = Math.round(d / 30); if (Math.abs(mo) < 12) return [mo, "month"];
  return [Math.round(d / 365), "year"];
}

/* Locale relative time via Intl.RelativeTimeFormat: "3 days ago", "in 2 days",
   "tomorrow", "yesterday". Correct sign + singular/plural for free. `now` is
   injectable for deterministic tests. Zero collapses to "now". */
export function formatRelativeTime(v, o = {}) {
  const d = toDate(v);
  if (!d) return o.fallback ?? FALLBACK;
  const now = o.now instanceof Date ? o.now.getTime() : (typeof o.now === "number" ? o.now : Date.now());
  const diff = d.getTime() - now;
  const [value, unit] = relUnit(diff);
  if (value === 0 && unit === "second") return o.locale ? new Intl.RelativeTimeFormat(o.locale, { numeric: "auto" }).format(0, "second") : "now";
  try {
    return new Intl.RelativeTimeFormat(o.locale, { numeric: "auto" }).format(value, unit);
  } catch {
    return o.fallback ?? FALLBACK;
  }
}

/* A compact, abbreviated "ago" for dense chrome (e.g. "3d ago") — no plural
   assembly. Pair with formatRelativeTime for a fuller accessible label. */
export function formatRelativeShort(v, o = {}) {
  const d = toDate(v);
  if (!d) return o.fallback ?? "";
  const s = Math.round(((o.now ?? Date.now()) - d.getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const dd = Math.round(h / 24); if (dd < 7) return `${dd}d ago`;
  return `${Math.round(dd / 7)}w ago`;
}

/* A date range: "Aug 11 – 14" / "Aug 11 – Sep 2, 2026". Uses Intl's native range
   formatter where available; falls back to a joined pair otherwise. */
export function formatDateRange(a, b, o = {}) {
  const ra = resolve(a), rb = resolve(b);
  if (!ra.d && !rb.d) return o.fallback ?? FALLBACK;
  if (!ra.d) return formatShortDate(b, o);
  if (!rb.d) return formatShortDate(a, o);
  const opts = { year: "numeric", month: "short", day: "numeric" };
  // If EITHER endpoint is a calendar-only date, format the range in the neutral
  // zone so neither end shifts a day; instants use the caller's zone.
  const tz = (ra.dateOnly || rb.dateOnly) ? NEUTRAL_TZ : o.timeZone;
  try {
    const f = new Intl.DateTimeFormat(o.locale, tz ? { ...opts, timeZone: tz } : opts);
    if (typeof f.formatRange === "function") return f.formatRange(ra.d, rb.d);
  } catch { /* fall through */ }
  return `${formatShortDate(a, o)} – ${formatShortDate(b, o)}`;
}

/* A date-relative day phrase via Intl.RelativeTimeFormat: enCount is NOT used for
   these — the platform localizes plural + wording per locale for free.
   formatRelativeDays(2) → "in 2 days" / "dans 2 jours" / "خلال يومين";
   (−1) → "yesterday"; (0) → "today". */
export function formatRelativeDays(n, o = {}) {
  if (typeof n !== "number" || !Number.isFinite(n)) return o.fallback ?? FALLBACK;
  try { return new Intl.RelativeTimeFormat(o.locale, { numeric: "auto" }).format(n, "day"); }
  catch { return o.fallback ?? FALLBACK; }
}

/* ENGLISH-ONLY count phrase. This deliberately uses ENGLISH plural rules with
   ENGLISH nouns — it does NOT localize (that would require full localized message
   forms per locale/category). Use it only inside English product copy (e.g. the
   reminder editor's "3 days before"). For anything user-locale-facing and
   date-relative, use formatRelativeDays / formatRelativeTime instead. */
const EN_PLURALS = {
  day: ["day", "days"], task: ["task", "tasks"], piece: ["piece", "pieces"],
  thing: ["thing", "things"], result: ["result", "results"], status: ["status", "statuses"],
};
export function enCount(n, noun) {
  const cat = new Intl.PluralRules("en").select(n);   // fixed English rules
  const forms = EN_PLURALS[noun];
  if (!forms) return `${n} ${noun}`;
  return `${n} ${cat === "one" ? forms[0] : forms[1]}`;
}
