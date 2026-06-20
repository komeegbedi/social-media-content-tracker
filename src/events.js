/* ===================================================================
   Ministry events — pastor birthdays + key dates — surfaced on Home so the
   team can plan content early. (A full Events page is a later slice; this is
   the lightweight "what's coming up" feed.)
   =================================================================== */

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

// nth weekday of a month: weekday 0=Sun … 6=Sat, n is 1-based.
function nthWeekday(year, month, weekday, n) {
  const first = new Date(year, month - 1, 1);
  const day = 1 + ((weekday - first.getDay() + 7) % 7) + (n - 1) * 7;
  return new Date(year, month - 1, day);
}

// Next occurrence of an annual month/day on or after `from`.
function nextAnnual(month, day, from) {
  const y = from.getFullYear();
  let d = new Date(y, month - 1, day);
  if (d < from) d = new Date(y + 1, month - 1, day);
  return d;
}

/* Upcoming events, soonest first. `prepLead` = how many days before an event
   content prep should start, so we can say "start prep now" / "prep in N days". */
export function upcomingEvents(limit = 5, prepLead = 15) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const evts = BIRTHDAYS.map(([name, m, d]) =>
    ({ kind: "birthday", name: `${name}'s Birthday`, date: nextAnnual(m, d, today) }));

  // Computed holidays: Mother's Day (2nd Sun May), Father's Day (3rd Sun June).
  [["Mother's Day", 5, 0, 2], ["Father's Day", 6, 0, 3]].forEach(([name, m, wd, n]) => {
    let dt = nthWeekday(today.getFullYear(), m, wd, n);
    if (dt < today) dt = nthWeekday(today.getFullYear() + 1, m, wd, n);
    evts.push({ kind: "holiday", name, date: dt });
  });

  return evts
    .map((e) => {
      const daysAway = Math.round((e.date - today) / 86400000);
      return { ...e, daysAway, prepInDays: Math.max(0, daysAway - prepLead), prepNow: daysAway <= prepLead };
    })
    .sort((a, b) => a.daysAway - b.daysAway)
    .slice(0, limit);
}
