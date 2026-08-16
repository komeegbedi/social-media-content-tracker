/* Trash-exclusion CONSUMER contracts (src/data.js). Firebase-free.

   The boundary (visibleTasks) is only meaningful if the real selectors, fed the
   filtered set, behave as if trashed tasks never existed. For each active consumer
   we assert: selector(visibleTasks([...active, trashedClone])) deep-equals
   selector(active). A trashed clone of an ACTIVE task (same fields + deletedAt)
   would change every count/queue/load if it leaked — so equality proves exclusion.

   (Reminder scheduling, leadership digest, and trusted backend assignment are proven
   separately against the emulator in test/reminders*.test.js, test/bulk-assign.test.js
   and test/task-detach.test.js.)

   Run: node --test src/data.trash.consumers.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  visibleTasks, dashboardMetrics, attentionItems, reviewQueue, qaQueue, postQueue,
  reviewMetrics, personLoad, pendingMatches, searchTasks, myWorkSections,
  adminHealth, occurrenceContentCount,
} from "./data.js";

// A realistic active board that lights up every selector.
const users = [
  { id: "u1", name: "Alex", role: "member", status: "approved", skills: ["shoot", "edit"] },
  { id: "u2", name: "Quinn", role: "member", status: "approved", qa: true },
];
const me = { id: "u1", name: "Alex", role: "member", status: "approved" };
const active = [
  { id: "a", title: "Reel A", type: "Reel", status: "In Progress", owner: "Alex", postDate: "2000-01-01", support: [] },
  { id: "b", title: "Reel B", type: "Reel", status: "In Review", owner: "Alex", postDate: "2099-01-01", support: [{ name: "Alex", role: "edit" }] },
  { id: "c", title: "Graphic C", type: "Graphic", status: "Approved", owner: "Quinn", postDate: "2099-02-01", support: [] },
  { id: "d", title: "Promo D", type: "Reel", status: "Ready to Post", owner: "Pending", ownerSuggested: "Alex", postDate: "2099-03-01", support: [] },
];
// A trashed CLONE of an active task: identical fields (so it would change every
// metric if counted), plus the deletedAt marker.
const trashedClone = { ...active[0], id: "a-trash", deletedAt: { seconds: 1 }, deletedBy: "x", deletedByName: "X" };
const mixed = [...active, trashedClone];
const filtered = visibleTasks(mixed);

// Each entry: [name, fn(tasks)] — invoked once on `active`, once on `filtered`.
const consumers = [
  ["dashboardMetrics", (t) => dashboardMetrics(t, users)],
  ["attentionItems", (t) => attentionItems(t, me)],
  ["reviewQueue", (t) => reviewQueue(t)],
  ["qaQueue", (t) => qaQueue(t)],
  ["postQueue", (t) => postQueue(t)],
  ["reviewMetrics", (t) => reviewMetrics(t)],
  ["personLoad(Alex)", (t) => personLoad(users[0], t)],
  ["pendingMatches(Alex)", (t) => pendingMatches(me, t)],
  ["searchTasks('Reel')", (t) => searchTasks(t, "Reel")],
  ["myWorkSections", (t) => myWorkSections(t, me)],
  ["adminHealth", (t) => adminHealth(t, users)],
  ["occurrenceContentCount", (t) => occurrenceContentCount({ tasks: [], key: "k" }, t)],
];

for (const [name, fn] of consumers) {
  test(`${name}: a trashed task past the boundary changes nothing`, () => {
    assert.deepEqual(fn(filtered), fn(active),
      `${name} must treat visibleTasks([...active, trashed]) identically to active`);
  });
}

test("sanity: the trashed clone WOULD change results if it leaked (guards a false pass)", () => {
  // If the boundary were removed (raw mixed set), at least one selector must differ —
  // otherwise the equality above proves nothing.
  const leaked = dashboardMetrics(mixed, users);
  const clean = dashboardMetrics(active, users);
  assert.notDeepEqual(leaked, clean, "the trashed clone is impactful, so exclusion is meaningful");
});
