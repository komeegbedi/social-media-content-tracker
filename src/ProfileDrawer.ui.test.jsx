/* Rendered test for the Profile menu's EXPLICIT close control + lock lifecycle.
   Renders the real ProfileDrawer inside a host mirroring App's wiring (mounted
   while ?panel=profile; onClose = the real useNav().dismissPanel), so we prove the
   button removes the panel, unmounts the dialog, and releases inert + scroll-lock.
   Run: npm run test:ui */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useNav } from "./navHooks.js";
import { ProfileDrawer } from "./ProfileDrawer.jsx";

beforeEach(() => {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  window.scrollTo = () => {};
  window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => vi.restoreAllMocks());

const inert = () => document.getElementById("root").hasAttribute("inert");
const bodyLocked = () => document.body.style.position === "fixed";
const Icon = () => <svg aria-hidden="true" />;

function LocationProbe() { const l = useLocation(); return <span data-testid="loc">{l.pathname + l.search}</span>; }

function Host() {
  const R = useNav();
  const open = R.nav.overlay.panel === "profile";
  return (
    <div id="page">
      <LocationProbe />
      <button>Team page control</button>
      {open && (
        <ProfileDrawer
          me={{ name: "Jane Doe", email: "jane@example.com" }}
          isAdmin
          appearanceLabel="System"
          PrefIcon={Icon}
          onClose={() => R.dismissPanel()}
          onSignOut={() => {}}
          onNotifications={() => {}}
          onAppearance={() => {}}
          onReport={() => {}}
        />
      )}
    </div>
  );
}

function renderAt(entries, index) {
  const root = document.getElementById("root");
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Host /></MemoryRouter>,
    { container: root, baseElement: document.body }
  );
}

describe("Profile menu — explicit close", () => {
  test("exposes a visible 'Close profile menu' button (mobile = modal: inert + scroll-lock held)", () => {
    // mobile: matchMedia(min-width:900) => false, so aria-modal + Portal lock
    renderAt(["/team", "/team?panel=profile"], 1);
    expect(screen.getByRole("dialog", { name: "Profile menu" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close profile menu" })).toBeInTheDocument();
    expect(inert()).toBe(true);
    expect(bodyLocked()).toBe(true);
  });

  test("clicking Close removes ?panel, unmounts the dialog, and releases inert + body lock", () => {
    renderAt(["/team", "/team?panel=profile"], 1);
    fireEvent.click(screen.getByRole("button", { name: "Close profile menu" }));
    expect(screen.getByTestId("loc").textContent).toBe("/team");             // panel removed
    expect(screen.queryByRole("dialog", { name: "Profile menu" })).toBeNull(); // unmounted
    expect(inert()).toBe(false);                                             // inert released
    expect(bodyLocked()).toBe(false);                                       // scroll-lock released
  });

  test("focus returns to the triggering control after close", () => {
    // Append the trigger to document.body (NOT #root, which the render replaces) so
    // it survives; the Portal captures it as prevFocus and restores it on unmount.
    const trigger = document.createElement("button");
    trigger.textContent = "Profile trigger";
    document.body.appendChild(trigger);
    trigger.focus();
    renderAt(["/team", "/team?panel=profile"], 1);
    fireEvent.click(screen.getByRole("button", { name: "Close profile menu" }));
    expect(document.activeElement).toBe(trigger);   // focus returned to the trigger
  });
});
