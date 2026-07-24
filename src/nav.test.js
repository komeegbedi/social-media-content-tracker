/* Pure navigation-mapping tests (no DOM). Run: node --test src/nav.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCREENS, pathForScreen, parseLocation, parseOverlay, migrate, withParams,
  openComposeNew, openComposeEdit, openPanel, closeOverlays, fallbackPath,
  titleFor, hasOverlay, PARAM,
} from "./nav.js";

test("every screen has a canonical path and round-trips", () => {
  const paths = SCREENS.map(pathForScreen);
  assert.deepEqual(paths, ["/", "/my-day", "/workflow", "/my-work", "/team", "/admin"]);
  for (const s of SCREENS) assert.equal(parseLocation(pathForScreen(s), "").screen, s);
});

test("canonical paths parse to the right screen", () => {
  assert.equal(parseLocation("/", "").screen, "home");
  assert.equal(parseLocation("/my-day", "").screen, "myday");
  assert.equal(parseLocation("/workflow", "").screen, "board");
  assert.equal(parseLocation("/my-work", "").screen, "mine");
  assert.equal(parseLocation("/team", "").screen, "team");
  assert.equal(parseLocation("/admin", "").screen, "admin");
});

test("/home normalises to / via replace-redirect", () => {
  const s = parseLocation("/home", "");
  assert.equal(s.screen, "home");
  assert.equal(s.redirect, "/");
});

test("a trailing slash is tolerated (except root)", () => {
  assert.equal(parseLocation("/team/", "").screen, "team");
  assert.equal(parseLocation("/", "").screen, "home");
});

test("content detail route carries a decoded id", () => {
  const s = parseLocation("/content/abc123", "");
  assert.equal(s.screen, "content");
  assert.equal(s.contentId, "abc123");
  assert.equal(s.redirect, null);
  assert.equal(parseLocation("/content/a%2Fb", "").contentId, "a/b");
});

test("reserved /team/:memberId renders team and falls back to /team (never blank)", () => {
  const s = parseLocation("/team/u-77", "");
  assert.equal(s.screen, "team");        // not "notfound"
  assert.equal(s.memberId, "u-77");
  assert.equal(s.redirect, "/team");     // safe fallback, not a blank member page
});

test("unknown paths recover to / (catch-all)", () => {
  const s = parseLocation("/nope/nope", "");
  assert.equal(s.screen, "notfound");
  assert.equal(s.redirect, "/");
});

test("workflow event filter and admin section come off the query string", () => {
  assert.equal(parseLocation("/workflow", "?event=xmas_2026").event, "xmas_2026");
  assert.equal(parseLocation("/admin", "?section=people").section, "people");
  // Filters are ignored on screens they don't belong to.
  assert.equal(parseLocation("/team", "?event=x").event, null);
});

test("overlays: at most one editor and one panel; editor wins a malformed both", () => {
  assert.deepEqual(parseOverlay("?compose=new").editor, { mode: "new" });
  assert.deepEqual(parseOverlay("?edit=t9").editor, { mode: "edit", id: "t9" });
  assert.equal(parseOverlay("?panel=profile").panel, "profile");
  assert.equal(parseOverlay("?panel=bogus").panel, null);           // unknown panel ignored
  // Both an editor and a panel present → editor wins, panel suppressed.
  const both = parseOverlay("?compose=new&panel=profile");
  assert.deepEqual(both.editor, { mode: "new" });
  assert.equal(both.panel, null);
  assert.equal(hasOverlay(parseOverlay("")), false);
  assert.equal(hasOverlay(parseOverlay("?panel=search")), true);
});

test("legacy ?task= migrates once to /content/:id (replace)", () => {
  assert.deepEqual(migrate("/", "?task=t42"), { pathname: "/content/t42", search: "" });
  // No lingering legacy params in the canonical URL.
  assert.equal(migrate("/", "?task=t42").search, "");
});

test("legacy ?tab= migrates to the canonical path, incl. admin section", () => {
  assert.deepEqual(migrate("/", "?tab=board"), { pathname: "/workflow", search: "" });
  assert.deepEqual(migrate("/", "?tab=myday"), { pathname: "/my-day", search: "" });
  assert.deepEqual(migrate("/", "?tab=admin&sec=people"), { pathname: "/admin", search: "?section=people" });
  assert.deepEqual(migrate("/", "?tab=bogus"), { pathname: "/", search: "" });
});

test("migrate returns null when there is nothing legacy to convert", () => {
  assert.equal(migrate("/workflow", ""), null);
  assert.equal(migrate("/workflow", "?event=x"), null);
  assert.equal(migrate("/", "?panel=profile"), null);
});

test("overlay open helpers are mutually exclusive (one primary at a time)", () => {
  // Opening a panel clears an editor…
  assert.equal(openPanel("?compose=new", "profile"), "?panel=profile");
  // …and opening an editor clears a panel.
  assert.equal(openComposeNew("?panel=notifications"), "?compose=new");
  assert.equal(openComposeEdit("?panel=profile", "t3"), "?edit=t3");
  // Switching panels replaces, never stacks.
  assert.equal(openPanel("?panel=profile", "search"), "?panel=search");
});

test("filters (event/section) survive opening and closing an overlay", () => {
  const s1 = openComposeNew("?event=e1");
  assert.equal(new URLSearchParams(s1).get(PARAM.event), "e1");
  assert.equal(new URLSearchParams(s1).get(PARAM.compose), "new");
  const s2 = closeOverlays(s1);
  assert.equal(s2, "?event=e1");     // overlay gone, filter kept
});

test("withParams is deterministic — same intent, byte-identical string (no dup history)", () => {
  assert.equal(withParams("?panel=profile", { panel: "profile" }), "?panel=profile");
  // Key order is normalised regardless of input order.
  assert.equal(withParams("?section=people&event=e", {}), "?event=e&section=people");
  assert.equal(withParams("", { panel: null }), "");
});

test("closeOverlays on a clean URL is a no-op string (=== current), so Back doesn't loop", () => {
  assert.equal(closeOverlays(""), "");
  assert.equal(closeOverlays("?event=e1"), "?event=e1");
});

test("fallback destinations never risk leaving the app", () => {
  assert.equal(fallbackPath(parseLocation("/content/x", "")), "/workflow");
  assert.equal(fallbackPath(parseLocation("/admin", "?section=people")), "/admin");
  assert.equal(fallbackPath(parseLocation("/team/u1", "")), "/team");
  assert.equal(fallbackPath(parseLocation("/", "")), "/");
});

test("document titles reflect screen and overlay", () => {
  assert.match(titleFor(parseLocation("/team", "")), /^Team ·/);
  assert.match(titleFor(parseLocation("/", "?compose=new")), /^Plan content ·/);
  assert.match(titleFor(parseLocation("/", "?edit=t1")), /^Edit content ·/);
  assert.match(titleFor(parseLocation("/", "?panel=notifications")), /^Notifications ·/);
  assert.match(titleFor(parseLocation("/content/x", ""), "Sunday Reel"), /^Sunday Reel ·/);
});
