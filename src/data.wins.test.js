/* Tests for recentWins — one accomplishment = one card, never two titles joined.
   Run with: node --test src/data.wins.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recentWins } from "./data.js";

const ev = (type, at) => ({ type, at });

test("a linked recurring event never gets concatenated onto the task title", () => {
  const tasks = [{
    id: "t1", title: "Pastor Tope's Birthday Poster", type: "Poster", status: "Posted",
    relatedEvent: "Pastor Tope's Birthday",           // must NOT appear in the win
    activity: [ev("posted", 1000)],
  }];
  const [win] = recentWins(tasks);
  assert.equal(win.title, "Pastor Tope's Birthday Poster");
  assert.equal(win.action, "Posted");
  assert.ok(!("text" in win), "no pre-baked concatenated string");
  assert.ok(!JSON.stringify(win).includes("·"), "titles are never joined by a bullet");
});

test("one completed piece of content produces exactly one win", () => {
  const tasks = [{
    id: "t1", title: "Women's Meeting Poster", status: "Posted",
    // repeated/!multiple completion events for the SAME content
    activity: [ev("approved", 900), ev("posted", 1000), ev("posted", 1100)],
  }];
  const wins = recentWins(tasks);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].action, "Posted");     // Posted beats an earlier Approved
  assert.equal(wins[0].at, 1100);             // and keeps the latest completion
});

test("approved-only content shows as Approved; nothing completed shows no win", () => {
  const wins = recentWins([
    { id: "a", title: "Young & Prime Adult Ignite", activity: [ev("approved", 500)] },
    { id: "b", title: "Not started", activity: [ev("started", 400)] },
    { id: "c", title: "No activity at all" },
  ]);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].title, "Young & Prime Adult Ignite");
  assert.equal(wins[0].action, "Approved");
});

test("wins are newest-first and respect the limit", () => {
  const tasks = [
    { id: "old",  title: "Old",  activity: [ev("posted", 100)] },
    { id: "new",  title: "New",  activity: [ev("posted", 300)] },
    { id: "mid",  title: "Mid",  activity: [ev("posted", 200)] },
  ];
  assert.deepEqual(recentWins(tasks).map(w => w.title), ["New", "Mid", "Old"]);
  assert.deepEqual(recentWins(tasks, 2).map(w => w.title), ["New", "Mid"]);
});

test("two different tasks for the same event stay two distinct wins", () => {
  const tasks = [
    { id: "p", title: "Cross Over Poster", relatedEvent: "Cross Over Service", activity: [ev("posted", 200)] },
    { id: "r", title: "Cross Over Reel",   relatedEvent: "Cross Over Service", activity: [ev("posted", 100)] },
  ];
  const wins = recentWins(tasks);
  assert.equal(wins.length, 2);                       // genuinely two accomplishments
  assert.deepEqual(wins.map(w => w.title), ["Cross Over Poster", "Cross Over Reel"]);
});
