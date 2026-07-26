/* History-integration tests for the REAL navigation adapter (src/navHooks.js)
   driven under jsdom + a react-router memory router. Exercises push/back/
   forward, overlay-close-via-Back, legacy migration, blocked navigation with
   discard-and-proceed, and no-duplicate-entry behaviour.

   node --test doesn't transform JSX, so components are built with
   React.createElement. jsdom globals are installed BEFORE React is imported.
   Run: node --test src/nav.integration.test.js */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// --- jsdom DOM environment, installed before any React import ---------------
const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div><div class="sb-content"></div></body></html>',
  { url: "https://app.test/", pretendToBeVisual: true }
);
const g = globalThis;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
for (const k of ["HTMLElement", "Node", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  if (!g[k]) g[k] = dom.window[k];
g.IS_REACT_ACT_ENVIRONMENT = true;

// Imported after the DOM exists.
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react-dom/test-utils");
const { createMemoryRouter, RouterProvider, useBlocker } = await import("react-router-dom");
const { useNav, useDirtyNavGuard } = await import("./navHooks.js");
const { migrate } = await import("./nav.js");

const h = React.createElement;
const cap = { nav: null, blocker: null };

// A harness that surfaces the live useNav() result + parsed screen/overlay.
function Harness() {
  const R = useNav();
  cap.nav = R;
  const n = R.nav;
  return h("div", null,
    h("span", { id: "screen" }, n.screen),
    h("span", { id: "panel" }, n.overlay.panel || ""),
    h("span", { id: "editor" }, n.overlay.editor ? n.overlay.editor.mode : ""),
    h("span", { id: "content" }, n.contentId || ""),
    h("span", { id: "loc" }, R.location.pathname + R.location.search)
  );
}

// Harness with the real unsaved-changes blocker predicate.
let dirty = false;
function DirtyHarness() {
  const R = useNav();
  cap.nav = R;
  cap.blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search)
  );
  return h("span", { id: "loc" }, R.location.pathname + R.location.search);
}

// Harness driving the REAL pending-navigation guard (useDirtyNavGuard). Dirtiness
// is component state so the guard's blocker predicate re-evaluates on change.
function GuardHarness() {
  const R = useNav();
  const [d, setD] = React.useState(false);
  cap.nav = R;
  cap.setDirty = setD;
  cap.guard = useDirtyNavGuard(d);
  return h("span", { id: "loc" }, R.location.pathname + R.location.search);
}

function mount(Comp, entries = ["/"]) {
  const router = createMemoryRouter([{ path: "*", element: h(Comp) }], {
    initialEntries: entries, initialIndex: entries.length - 1,
  });
  const root = createRoot(document.getElementById("root"));
  act(() => { root.render(h(RouterProvider, { router })); });
  return { router, root };
}
const text = (id) => document.getElementById(id).textContent;
const run = (fn) => act(() => { fn(); });

beforeEach(() => { dirty = false; cap.nav = null; cap.blocker = null; window.history.replaceState(null, ""); });

test("push navigation moves through screens and records history", () => {
  const { router, root } = mount(Harness);
  assert.equal(text("screen"), "home");
  run(() => cap.nav.goScreen("team"));
  assert.equal(text("screen"), "team");
  assert.equal(router.state.location.pathname, "/team");
  run(() => cap.nav.openContent("t1"));
  assert.equal(text("screen"), "content");
  assert.equal(text("content"), "t1");
  act(() => root.unmount());
});

test("Home → Team → Content → Back → Back walks the real path in reverse", () => {
  const { router, root } = mount(Harness);
  run(() => cap.nav.goScreen("team"));
  run(() => cap.nav.openContent("c9"));
  assert.equal(text("screen"), "content");
  run(() => router.navigate(-1));            // browser Back
  assert.equal(text("screen"), "team");
  run(() => router.navigate(-1));            // Back again
  assert.equal(text("screen"), "home");
  act(() => root.unmount());
});

test("Forward works after Back", () => {
  const { router, root } = mount(Harness);
  run(() => cap.nav.goScreen("myday"));
  run(() => router.navigate(-1));
  assert.equal(text("screen"), "home");
  run(() => router.navigate(1));             // browser Forward
  assert.equal(text("screen"), "myday");
  act(() => root.unmount());
});

test("an overlay closes on Back before leaving the underlying page", () => {
  const { router, root } = mount(Harness);
  run(() => cap.nav.goScreen("board"));
  run(() => cap.nav.openPanel("notifications"));
  assert.equal(text("panel"), "notifications");
  assert.equal(text("screen"), "board");     // underlying page still Workflow
  run(() => router.navigate(-1));            // Back closes the overlay…
  assert.equal(text("panel"), "");
  assert.equal(text("screen"), "board");     // …and we're still on Workflow, not gone
  act(() => root.unmount());
});

test("only one primary panel renders at a time; Back follows the actual path", () => {
  const { router, root } = mount(Harness);
  run(() => cap.nav.openPanel("profile"));
  assert.equal(text("panel"), "profile");
  run(() => cap.nav.openPanel("search"));
  assert.equal(text("panel"), "search");     // only ONE panel is ever shown
  // Each open was a distinct action, so Back retraces them — never shows two
  // panels at once, and never skips one.
  run(() => router.navigate(-1));
  assert.equal(text("panel"), "profile");
  run(() => router.navigate(-1));
  assert.equal(text("panel"), "");
  act(() => root.unmount());
});

test("legacy ?task= entry migrates to /content/:id via replace (no back-loop)", () => {
  const { router, root } = mount(Harness, ["/?task=t42"]);
  // Simulate the mount-time migration the app performs.
  const m = migrate(router.state.location.pathname, router.state.location.search);
  run(() => cap.nav.replace(m.pathname + (m.search || "")));
  assert.equal(text("screen"), "content");
  assert.equal(text("content"), "t42");
  // Replaced, so there's no legacy entry to fall back into.
  assert.equal(router.state.location.pathname, "/content/t42");
  act(() => root.unmount());
});

test("legacy ?tab=admin&sec=people migrates to /admin?section=people", () => {
  const { router, root } = mount(Harness, ["/?tab=admin&sec=people"]);
  const m = migrate(router.state.location.pathname, router.state.location.search);
  run(() => cap.nav.replace(m.pathname + (m.search || "")));
  assert.equal(text("screen"), "admin");
  assert.equal(router.state.location.pathname + router.state.location.search, "/admin?section=people");
  act(() => root.unmount());
});

test("direct entry to /content/:id, then goBack, falls back to /workflow (never off-app)", () => {
  const { router, root } = mount(Harness, ["/content/deep"]);
  assert.equal(text("screen"), "content");
  run(() => cap.nav.goBack());               // no in-app history behind us
  assert.equal(router.state.location.pathname, "/workflow");
  act(() => root.unmount());
});

test("no duplicate entries: navigating to the current screen/overlay is a no-op", () => {
  const { router, root } = mount(Harness);
  run(() => cap.nav.goScreen("team"));
  const key1 = router.state.location.key;
  run(() => cap.nav.goScreen("team"));       // same path → guarded no-op
  assert.equal(router.state.location.key, key1, "same-screen nav must not push a new entry");
  run(() => cap.nav.openPanel("profile"));
  const key2 = router.state.location.key;
  run(() => cap.nav.openPanel("profile"));   // same panel → no-op
  assert.equal(router.state.location.key, key2, "same-panel nav must not push a new entry");
  act(() => root.unmount());
});

test("dirty form blocks in-app navigation; Discard proceeds without a duplicate entry", () => {
  const { router, root } = mount(DirtyHarness, ["/workflow"]);
  dirty = true;
  run(() => cap.nav.goScreen("team"));       // attempt to leave with unsaved changes
  assert.equal(cap.blocker.state, "blocked");
  assert.equal(router.state.location.pathname, "/workflow", "navigation is paused, not applied");
  // Discard → proceed completes the SAME pending navigation.
  run(() => cap.blocker.proceed());
  assert.equal(router.state.location.pathname, "/team");
  act(() => root.unmount());
});

test("dirty form: Keep editing cancels the navigation and stays put", () => {
  const { router, root } = mount(DirtyHarness, ["/workflow"]);
  dirty = true;
  run(() => cap.nav.goScreen("home"));
  assert.equal(cap.blocker.state, "blocked");
  run(() => cap.blocker.reset());            // "Keep editing"
  assert.equal(cap.blocker.state, "unblocked");
  assert.equal(router.state.location.pathname, "/workflow");
  act(() => root.unmount());
});

test("a clean form never blocks", () => {
  const { router, root } = mount(DirtyHarness, ["/workflow"]);
  dirty = false;
  run(() => cap.nav.goScreen("team"));
  assert.equal(router.state.location.pathname, "/team");
  assert.ok(cap.blocker.state !== "blocked");
  act(() => root.unmount());
});

test("launcher → destination replaces the launcher: Back returns to the underlying page", () => {
  const { router, root } = mount(Harness, ["/workflow"]);
  // Open the notifications drawer (a launcher) — this pushes an entry.
  run(() => cap.nav.openPanel("notifications"));
  assert.equal(text("panel"), "notifications");
  assert.equal(text("screen"), "board");
  // Selecting a notification LAUNCHES the destination, replacing the drawer entry.
  run(() => cap.nav.launch({ pathname: "/content/t1", search: "" }));
  assert.equal(text("screen"), "content");
  assert.equal(text("content"), "t1");
  // Back returns to Workflow — the drawer does NOT reopen (the reported bug).
  run(() => router.navigate(-1));
  assert.equal(text("screen"), "board");
  assert.equal(text("panel"), "", "the notification drawer must not resurrect on Back");
  act(() => root.unmount());
});

test("launcher screen jump (profile → Team) replaces: Back returns to the underlying page", () => {
  const { router, root } = mount(Harness, ["/workflow"]);
  run(() => cap.nav.openPanel("profile"));      // profile sheet launcher
  assert.equal(text("panel"), "profile");
  run(() => cap.nav.launchScreen("team"));       // jump to a primary destination
  assert.equal(text("screen"), "team");
  run(() => router.navigate(-1));
  assert.equal(text("screen"), "board");         // back to Workflow, not the sheet
  assert.equal(text("panel"), "");
  act(() => root.unmount());
});

test("a PRIMARY surface still pushes: opening a task from My Work returns to My Work", () => {
  const { router, root } = mount(Harness, ["/my-work"]);
  run(() => cap.nav.openContent("t9"));          // primary drill-down, not a launcher
  assert.equal(text("screen"), "content");
  run(() => router.navigate(-1));
  assert.equal(text("screen"), "mine", "task detail returns to its origin, not forced to Workflow");
  act(() => root.unmount());
});

// React Router's BrowserRouter stamps history.state.idx (the "can we unwind?"
// signal); the in-memory test router doesn't, so we simulate it. Depth > 0 =
// in-session (there are entries behind us); 0 = cold/direct entry.
const setHistoryDepth = (idx) => window.history.replaceState({ idx }, "");

test("Task↔Edit loop is broken: Cancel Edit → Detail, Close Detail → filtered Workflow", () => {
  const { root } = mount(Harness, ["/workflow?filter=overdue"]);
  setHistoryDepth(5);
  run(() => cap.nav.openContent("t1"));        // → Task Detail (push)
  assert.equal(text("screen"), "content");
  run(() => cap.nav.openComposeEdit("t1"));    // → Edit, pushed over the detail
  assert.equal(text("editor"), "edit");
  // Cancel Edit → unwind to Task Detail. NOT a fresh detail entry, NOT a loop.
  run(() => cap.nav.closeOverlay());
  assert.equal(text("screen"), "content");
  assert.equal(text("editor"), "", "the editor is gone from the active path");
  // Close Task Detail → the ORIGINAL filtered Workflow, filter intact.
  run(() => cap.nav.goBack());
  assert.equal(text("screen"), "board");
  assert.equal(text("loc"), "/workflow?filter=overdue", "overdue filter preserved");
  act(() => root.unmount());
});

test("Task Detail never returns to the Edit that was just cancelled", () => {
  const { root } = mount(Harness, ["/workflow"]);
  setHistoryDepth(5);
  run(() => cap.nav.openContent("t1"));
  run(() => cap.nav.openComposeEdit("t1"));
  run(() => cap.nav.closeOverlay());           // Cancel → Detail
  run(() => cap.nav.goBack());                 // Close Detail → Workflow (NOT Edit)
  assert.equal(text("screen"), "board");
  assert.equal(text("editor"), "");
  act(() => root.unmount());
});

test("repeated Cancel does not alternate between Detail and Edit", () => {
  const { root } = mount(Harness, ["/workflow"]);
  setHistoryDepth(5);
  run(() => cap.nav.openContent("t1"));
  run(() => cap.nav.openComposeEdit("t1"));
  run(() => cap.nav.closeOverlay());           // → Detail
  assert.equal(text("editor"), "");
  run(() => cap.nav.closeOverlay());           // nothing open → no-op (stays on Detail)
  assert.equal(text("screen"), "content");
  assert.equal(text("editor"), "");
  run(() => cap.nav.closeOverlay());           // still a no-op
  assert.equal(text("screen"), "content");
  act(() => root.unmount());
});

test("browser Back unwinds Edit → Detail → filtered Workflow", () => {
  const { router, root } = mount(Harness, ["/workflow?filter=overdue"]);
  run(() => cap.nav.openContent("t1"));
  run(() => cap.nav.openComposeEdit("t1"));
  run(() => router.navigate(-1));              // browser Back → Detail
  assert.equal(text("screen"), "content"); assert.equal(text("editor"), "");
  run(() => router.navigate(-1));              // browser Back → filtered Workflow
  assert.equal(text("loc"), "/workflow?filter=overdue");
  act(() => root.unmount());
});

test("direct /content/:id?edit → Cancel → Detail → Close → Workflow fallback", () => {
  const { root } = mount(Harness, ["/content/t7?edit=t7"]);
  setHistoryDepth(0);                          // cold entry: nothing behind us
  assert.equal(text("editor"), "edit");
  run(() => cap.nav.closeOverlay());           // no back → replace with the detail
  assert.equal(text("screen"), "content");
  assert.equal(text("editor"), "");
  assert.equal(text("loc"), "/content/t7");
  run(() => cap.nav.goBack());                 // no back → logical fallback
  assert.equal(text("loc"), "/workflow");
  act(() => root.unmount());
});

test("dirty Cancel → Discard returns to Task Detail in ONE action (no second Back)", () => {
  const { router, root } = mount(GuardHarness, ["/content/t1"]);
  setHistoryDepth(5);
  run(() => cap.nav.openComposeEdit("t1"));     // detail → edit (real history)
  run(() => cap.setDirty(true));
  run(() => cap.nav.closeOverlay());            // Cancel = navigate(-1) → blocked
  assert.equal(cap.guard.blocked, true);
  assert.equal(router.state.location.search, "?edit=t1", "held on Edit while dirty");
  run(() => cap.guard.discard());               // Discard → completes the SAME nav once
  assert.equal(router.state.location.search, "", "returned to Task Detail immediately");
  act(() => root.unmount());
});

test("dirty hardware/browser Back → Discard completes the Back in one press", () => {
  const { router, root } = mount(GuardHarness, ["/workflow?filter=overdue"]);
  setHistoryDepth(5);
  run(() => cap.nav.openContent("t1"));         // → Task Detail
  run(() => cap.nav.openComposeEdit("t1"));     // → Edit
  run(() => cap.setDirty(true));
  run(() => router.navigate(-1));               // hardware/browser Back (POP) → blocked
  assert.equal(cap.guard.blocked, true);
  assert.equal(router.state.location.search, "?edit=t1", "Back held while dirty");
  run(() => cap.guard.discard());               // Discard → the Back completes once
  assert.equal(router.state.location.pathname, "/content/t1");
  assert.equal(router.state.location.search, "", "landed on Task Detail, no second Back");
  act(() => root.unmount());
});

test("dirty Back → Keep editing stays in Edit", () => {
  const { router, root } = mount(GuardHarness, ["/content/t1"]);
  setHistoryDepth(5);
  run(() => cap.nav.openComposeEdit("t1"));
  run(() => cap.setDirty(true));
  run(() => router.navigate(-1));               // blocked
  assert.equal(cap.guard.blocked, true);
  run(() => cap.guard.keep());                  // Keep editing
  assert.equal(cap.guard.blocked, false);
  assert.equal(router.state.location.search, "?edit=t1", "still editing");
  act(() => root.unmount());
});

test("a PUSH away while dirty (e.g. sidebar) → Discard lands on the intended target", () => {
  const { router, root } = mount(GuardHarness, ["/content/t1"]);
  setHistoryDepth(5);
  run(() => cap.setDirty(true));
  run(() => cap.nav.goScreen("team"));          // PUSH to /team → blocked
  assert.equal(cap.guard.blocked, true);
  run(() => cap.guard.discard());               // completes the intended forward nav
  assert.equal(router.state.location.pathname, "/team", "went where the user intended");
  act(() => root.unmount());
});

test("a clean form never blocks Cancel", () => {
  const { router, root } = mount(GuardHarness, ["/content/t1"]);
  setHistoryDepth(5);
  run(() => cap.nav.openComposeEdit("t1"));
  run(() => cap.nav.closeOverlay());            // clean → unwinds straight to detail
  assert.equal(cap.guard.blocked, false);
  assert.equal(router.state.location.search, "", "Task Detail");
  act(() => root.unmount());
});

test("Forward-after-Cancel policy = Model A (unwind): Forward re-reveals a FRESH editor", () => {
  // DECISION: Cancel unwinds (navigate -1), leaving Edit as a forward entry, so
  // browser Forward re-reveals it. This is the deliberate policy: it's the only
  // model that keeps Back correct (Edit→Detail→Workflow) AND never creates a
  // duplicate Task Detail entry. The re-revealed editor is FRESH (re-keyed by
  // task id, re-read from the task) — never stale — and Forward simply redoes
  // the Back-style Cancel, which is standard, symmetric browser behaviour.
  const { router, root } = mount(Harness, ["/workflow"]);
  setHistoryDepth(5);
  run(() => cap.nav.openContent("t1"));
  run(() => cap.nav.openComposeEdit("t1"));     // → Edit
  run(() => cap.nav.closeOverlay());            // Cancel → unwind to Detail
  assert.equal(text("editor"), "");
  assert.equal(text("screen"), "content");
  run(() => router.navigate(1));                // browser Forward
  assert.equal(text("editor"), "edit", "Forward redoes the unwound Cancel");
  // And Back from the re-revealed editor still returns to Detail (Back stays correct).
  run(() => router.navigate(-1));
  assert.equal(text("editor"), "");
  assert.equal(text("screen"), "content");
  act(() => root.unmount());
});
