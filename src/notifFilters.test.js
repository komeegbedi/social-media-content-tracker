/* Notification Center filters — pure. Run: node --test src/notifFilters.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NOTIF_FILTERS, filterNotifications } from "./notifFilters.js";

const ITEMS = [
  { id: "1", type: "assigned", read: false },
  { id: "2", type: "qa", read: true },
  { id: "3", type: "leadership", read: false },
  { id: "4", type: "mention", read: true },
  { id: "5", type: "admin_delivery_health", read: false },
  { id: "6", type: "reminder", read: true },
  { id: "7", type: "overdue", read: false },
];
const ids = (arr) => arr.map((n) => n.id);

test("System filter includes admin_delivery_health (delivery alerts are System notices)", () => {
  const system = NOTIF_FILTERS.find((f) => f.id === "system");
  assert.ok(system.types.includes("admin_delivery_health"));
  assert.deepEqual(ids(filterNotifications(ITEMS, "system")), ["3", "4", "5"]);
});

test("All / Unread are structural; type filters match only their types", () => {
  assert.deepEqual(ids(filterNotifications(ITEMS, "all")), ids(ITEMS));
  assert.deepEqual(ids(filterNotifications(ITEMS, "unread")), ["1", "3", "5", "7"]);
  assert.deepEqual(ids(filterNotifications(ITEMS, "reminders")), ["6", "7"]); // reminder + overdue
  assert.deepEqual(ids(filterNotifications(ITEMS, "reviews")), ["2"]);
});

test("unknown filter id falls back to All", () => {
  assert.deepEqual(ids(filterNotifications(ITEMS, "nope")), ids(ITEMS));
});

test("existing filters are unchanged (no type moved buckets)", () => {
  const byId = Object.fromEntries(NOTIF_FILTERS.map((f) => [f.id, f.types]));
  assert.deepEqual(byId.assigned, ["assigned"]);
  assert.deepEqual(byId.reviews, ["qa"]);
  assert.deepEqual(byId.reminders, ["reminder", "overdue"]);
  assert.deepEqual(byId.changes, ["changes"]);
  assert.deepEqual(byId.approvals, ["approved", "ready", "account_approved"]);
  assert.deepEqual(byId.system, ["leadership", "mention", "admin_delivery_health"]);
});
