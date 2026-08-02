/* Proves the admin content-card menu offers NO one-click "mark posted" / "archive"
   shortcut — forcing a status must go through the Administrative override panel
   (reason + confirmation), never a canned-reason quick action.
   Run: node --test src/adminActions.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { adminKebab } from "./adminActions.js";

const noop = () => {};
const handlers = { open: noop, edit: noop, duplicate: noop, del: noop };

test("no one-click shortcut bypasses the override ceremony (any status)", () => {
  for (const status of ["Planned", "In Progress", "In Review", "Changes Requested", "Approved", "Ready to Post", "Posted"]) {
    const labels = adminKebab({ id: "t1", title: "Reel", status }, handlers).map((a) => a.label.toLowerCase());
    for (const forbidden of ["mark posted", "mark as posted", "archive"]) {
      assert.ok(!labels.includes(forbidden), `"${forbidden}" must NOT be an admin shortcut (status: ${status})`);
    }
    // The safe management actions are still present.
    assert.deepEqual(labels, ["open", "edit", "duplicate", "delete"]);
  }
});
