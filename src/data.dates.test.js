/* Date validation for the content planner.
   Run with: node --test src/data.dates.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dateIssues, isRealDate, todayStr } from "./data.js";

const shift = (n) => { const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const T = todayStr();

test("todayStr is the LOCAL calendar day, not the UTC one", () => {
  const d = new Date();
  assert.equal(T, `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);
  assert.match(T, /^\d{4}-\d{2}-\d{2}$/);
});

test("post date must be on or after the shoot date", () => {
  const bad = { type:"Reel", shootDate: shift(5), postDate: shift(2) };
  assert.equal(dateIssues(bad), "Post date must be on or after the shoot date.");
  // Same day is fine — shoot and post can happen together.
  assert.equal(dateIssues({ type:"Reel", shootDate: shift(5), postDate: shift(5) }), "");
  assert.equal(dateIssues({ type:"Reel", shootDate: shift(2), postDate: shift(9) }), "");
});

test("graphics have no shoot date, so the ordering rule doesn't apply to them", () => {
  // A stale shootDate left over from a type switch must not block a Poster.
  assert.equal(dateIssues({ type:"Poster", shootDate: shift(9), postDate: shift(2) }), "");
});

test("new dates cannot be in the past", () => {
  assert.equal(dateIssues({ type:"Reel", shootDate: shift(-1), postDate: shift(5) }),
    "Shoot date can't be in the past.");
  assert.equal(dateIssues({ type:"Poster", postDate: shift(-1) }),
    "Post date can't be in the past.");
  // Today itself is allowed — same-day content is normal.
  assert.equal(dateIssues({ type:"Reel", shootDate: T, postDate: T }), "");
});

test("editing an old task doesn't get blocked by its own past dates", () => {
  const saved = { type:"Reel", shootDate: shift(-30), postDate: shift(-20) };
  // Reopening it and changing something unrelated must still be savable.
  assert.equal(dateIssues({ ...saved, title:"renamed" }, saved), "");
  // But moving a date INTO the past is still refused.
  assert.equal(dateIssues({ ...saved, postDate: shift(-5) }, saved),
    "Post date can't be in the past.");
  // And moving it forward is fine.
  assert.equal(dateIssues({ ...saved, shootDate: shift(1), postDate: shift(3) }, saved), "");
  // Ordering is still enforced on already-past dates.
  assert.equal(dateIssues({ ...saved, postDate: shift(-40) }, { ...saved, postDate: shift(-40) }),
    "Post date must be on or after the shoot date.");
});

test("impossible calendar days are rejected, not silently rolled over", () => {
  assert.equal(isRealDate("2026-02-31"), false);   // Date() would roll this to Mar 3
  assert.equal(isRealDate("2026-13-01"), false);
  assert.equal(isRealDate("2026-00-10"), false);
  assert.equal(isRealDate("2026-2-1"), false);     // must be zero-padded
  assert.equal(isRealDate("not a date"), false);
  assert.equal(isRealDate(""), false);
  assert.equal(isRealDate(null), false);
  assert.equal(isRealDate("2024-02-29"), true);    // real leap day
  assert.equal(isRealDate("2026-12-31"), true);
  assert.equal(dateIssues({ type:"Reel", shootDate:"2026-02-31", postDate: shift(5) }),
    "Shoot date isn't a real date.");
});

test("a mistyped year is caught before it becomes a reminder in the year 2206", () => {
  assert.equal(dateIssues({ type:"Poster", postDate:"2206-04-01" }), "Check the year on the post date.");
  // A genuine long-range plan (next year) is left alone.
  assert.equal(dateIssues({ type:"Poster", postDate: shift(300) }), "");
});

test("empty and partial forms never throw", () => {
  assert.equal(dateIssues(), "");
  assert.equal(dateIssues({}), "");
  assert.equal(dateIssues(null, null), "");
  assert.equal(dateIssues({ type:"Reel" }), "");
  assert.equal(dateIssues({ type:"Reel", shootDate: shift(3) }), "");   // post date not set yet
});
