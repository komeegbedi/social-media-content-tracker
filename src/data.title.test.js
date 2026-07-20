/* Tests for formatContentTitle — proper Title Case for content/task titles.
   Run with: node --test src/data.title.test.js
   Mirrored (and must stay in sync) with functions/lib.js. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatContentTitle } from "./data.js";

const cases = [
  // lowercase → Title Case
  ["women's meeting posters", "Women's Meeting Posters"],
  ["pastor's birthday reel", "Pastor's Birthday Reel"],
  ["cross over service", "Cross Over Service"],
  // hyphenated words
  ["behind-the-scenes setup", "Behind-the-Scenes Setup"],
  // numbers / ordinals preserved
  ["june 21st sermon short", "June 21st Sermon Short"],
  // abbreviations with periods + apostrophes
  ["rev. dr. sunday olukoju's birthday", "Rev. Dr. Sunday Olukoju's Birthday"],
  // acronyms preserved, minor word ("for") stays lowercase mid-title
  ["QA review for easter poster", "QA Review for Easter Poster"],
  ["qa review for easter poster", "QA Review for Easter Poster"],
  // platform names
  ["instagram teaser for youtube premiere", "Instagram Teaser for YouTube Premiere"],
  // already correctly formatted (idempotent)
  ["Women's Meeting Posters", "Women's Meeting Posters"],
  // mixed / shouting case normalises
  ["SUNDAY WELCOME REEL", "Sunday Welcome Reel"],
  ["sUnDaY wElCoMe", "Sunday Welcome"],
  // minor word is capitalised when it's the first OR last word
  ["the welcome", "The Welcome"],
  ["all about the vision", "All About the Vision"],
];

for (const [input, expected] of cases) {
  test(`"${input}" → "${expected}"`, () => {
    assert.equal(formatContentTitle(input), expected);
  });
}

test("empty / null / undefined are safe", () => {
  assert.equal(formatContentTitle(""), "");
  assert.equal(formatContentTitle("   "), "");
  assert.equal(formatContentTitle(null), "");
  assert.equal(formatContentTitle(undefined), "");
});

test("is idempotent (formatting twice == formatting once)", () => {
  const once = formatContentTitle("rev. dr. sunday olukoju's birthday");
  assert.equal(formatContentTitle(once), once);
});

test("collapses nothing / preserves internal spacing tokens", () => {
  assert.equal(formatContentTitle("  spaced   out  "), "Spaced   Out");
});
