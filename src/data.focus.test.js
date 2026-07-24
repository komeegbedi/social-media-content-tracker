/* Tests for the canonical "Your focus" selector (attentionItems) — the same
   pure function Home and My Day both use on desktop and mobile. Run with:
     node --test src/data.focus.test.js
   These lock in the focus rules and guard against the empty-state / count bugs
   (determinism, posted/archived exclusion, ownership + next-action gating). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionItems } from "./data.js";

// A local-midnight ISO date `offset` days from today — matches how the app
// stores postDate and how daysTo() parses it (Safari-safe "YYYY-MM-DD").
const iso = (offset) => {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const me = { name: "Jordan Lee" };
const other = "Sam Rivers";
const task = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2),
  title: "A piece", owner: me.name, support: [], status: "In Progress",
  postDate: iso(1), priority: "Medium", ...over,
});
const ids = (list) => list.map((t) => t.id).sort();

test("deterministic: same inputs always yield the same output", () => {
  const tasks = [task({ id: "a" }), task({ id: "b", status: "In Review" }),
                 task({ id: "c", owner: other, support: [] })];
  const first = attentionItems(tasks, me);
  const second = attentionItems(tasks, me);
  assert.deepEqual(first, second);
});

test("owner with an active (In Progress) task sees it", () => {
  const out = attentionItems([task({ id: "own", status: "In Progress" })], me);
  assert.deepEqual(ids(out), ["own"]);
});

test("support crew member is included (owner OR crew)", () => {
  const t = task({ id: "sup", owner: other, support: [{ name: me.name, role: "edit" }] });
  assert.deepEqual(ids(attentionItems([t], me)), ["sup"]);
});

test("a task the user has no part in is excluded", () => {
  const t = task({ id: "none", owner: other, support: [{ name: "Pat Kim" }] });
  assert.deepEqual(attentionItems([t], me), []);
});

test("Posted tasks are excluded (auto-archived)", () => {
  const t = task({ id: "posted", status: "Posted", postDate: iso(-1) });
  assert.deepEqual(attentionItems([t], me), []);
});

test("owner of a far-future Planned task with no next action is excluded", () => {
  const t = task({ id: "calm", status: "Planned", postDate: iso(30) });
  assert.deepEqual(attentionItems([t], me), []);
});

test("due tomorrow is included even when Planned", () => {
  const t = task({ id: "tom", status: "Planned", postDate: iso(1) });
  assert.deepEqual(ids(attentionItems([t], me)), ["tom"]);
});

test("Changes Requested and In Review are included", () => {
  const out = attentionItems([
    task({ id: "chg", status: "Changes Requested", postDate: iso(20) }),
    task({ id: "rev", status: "In Review", postDate: iso(20) }),
  ], me);
  assert.deepEqual(ids(out), ["chg", "rev"]);
});

test("overdue outranks due-soon in the ordering", () => {
  const out = attentionItems([
    task({ id: "soon", status: "In Progress", postDate: iso(2) }),
    task({ id: "over", status: "In Progress", postDate: iso(-3) }),
  ], me);
  assert.equal(out[0].id, "over");
});

test("empty task list yields an empty focus list (not an error)", () => {
  assert.deepEqual(attentionItems([], me), []);
});
