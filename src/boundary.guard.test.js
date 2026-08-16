/* SOURCE GUARD for the Trash exclusion boundary (src/App.jsx).

   The boundary is only real if raw `tasks` (the full array, INCLUDING trashed) is
   confined to a short, reviewed allowlist and every ACTIVE surface consumes
   `activeTasks`. This test reads the source and fails if a new raw-`tasks` leak is
   introduced — so a comment claiming "one boundary" can't drift from reality.

   THE ALLOWLIST — the only legitimate raw-`tasks` reads in the Board component:
     1. `const tasks = useMemo(...tasksRaw.map...)`   — the source array itself
     2. `visibleTasks(tasks)` / `trashedTasks(tasks)` — the boundary + Trash view
     3. `tasks.find(t => t.id === openId)` (openTask)  — deep-link/recovery lookup
        (must see trashed content to render the admin recovery notice)
     4. document-title resolution                      — trash-aware (non-admins
        never get a trashed title; see the isDeleted guard in the effect)
     5. per-id writes `doc(db, "tasks", <id>)`         — act on one explicit task,
        gated by Firestore rules, not a read of the active set

   Everything else — assignment, capacity, search, editor workload, dashboards —
   MUST use activeTasks.

   Run: node --test src/boundary.guard.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "App.jsx"), "utf8");

test("the single exclusion boundary exists", () => {
  assert.match(src, /const activeTasks = useMemo\(\(\) => visibleTasks\(tasks\)/);
  assert.match(src, /trashed=\{trashedTasks\(tasks\)\}/, "Admin receives the trashed set separately");
});

test("every ACTIVE surface consumes activeTasks, never raw tasks", () => {
  for (const comp of ["Home", "MyDay", "BoardList", "Mine", "Team", "GlobalSearch"]) {
    const m = src.match(new RegExp(`<${comp} tasks=\\{([^}]+)\\}`));
    assert.ok(m, `<${comp}> renders with a tasks prop`);
    assert.equal(m[1], "activeTasks", `<${comp}> must be fed activeTasks (got ${m[1]})`);
  }
  // Admin's primary list is active; its Trash view gets trashed separately.
  assert.match(src, /<Admin users=\{allUsers\} tasks=\{activeTasks\}/);
});

test("the editor never receives raw tasks for workload, and never opens on Trash", () => {
  assert.ok(!/allTasks=\{tasks\}/.test(src), "allTasks must be activeTasks, not raw tasks");
  assert.match(src, /allTasks=\{activeTasks\}/);
  // Edit target resolves from activeTasks only (a trashed id → undefined → no editor).
  assert.match(src, /editTaskObj = editTask && editTask !== "new" \? activeTasks\.find/);
  assert.ok(!/task=\{editTask==="new"\?null:tasks\.find/.test(src), "old raw-tasks edit resolution is gone");
});

test("assignment suggestion uses activeTasks (no trashed pending-import matches)", () => {
  assert.match(src, /pendingMatches\(user, activeTasks\)/);
  assert.ok(!/pendingMatches\(user, tasks\)/.test(src), "raw-tasks pendingMatches leak is gone");
});

test("document title is trash-aware (no title leak to non-admins)", () => {
  // The title effect must gate a trashed task's title behind isAdmin.
  const eff = src.slice(src.indexOf("Keep the document title in sync"), src.indexOf("Route-aware scroll restoration"));
  assert.match(eff, /isDeleted\(t\)/, "title resolution checks isDeleted");
  assert.match(eff, /isAdmin \? t\.title : null/, "trashed title is admin-only");
});

test("a non-admin on KNOWN trashed content gets Trash-specific copy (Option A), not a false access error", () => {
  // The render must route non-admin trashed → TrashedContentUnavailable, and only
  // genuinely-missing content → MissingContent (which mentions access).
  assert.match(src, /openTrashed && !isAdmin && \(\s*<TrashedContentUnavailable/,
    "non-admin trashed content uses the Trash-specific notice");
  assert.match(src, /nav\.screen==="content" && !openVisible && !openTrashed && tasksLoaded/,
    "MissingContent only fires when the content is NOT known-trashed");
  // The Trash-specific notice states it's in Trash and never says 'access'.
  const notice = src.slice(src.indexOf("function TrashedContentUnavailable"), src.indexOf("function MissingContent"));
  assert.match(notice, /This content is in Trash/);
  assert.ok(!/access/i.test(notice), "the Trash notice must not imply an access problem");
});
