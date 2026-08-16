/* P0-C — REAL wiring regression for the notification hand-off (the invisible
   modal lock). Unlike overlay.ui.test.jsx (which drives a synthetic Scene) and
   nav.test.js (which tests URL helpers), this renders the ACTUAL NotifPanelShell
   inside a host that mirrors App/Board's real wiring:

     • NotifCenter is mounted ONLY while ?panel=notifications is in the URL
       (notifOpen = nav.overlay.panel === "notifications");
     • the real "Notification settings" button lives in the shell and goes through
       the 180ms exit transition;
     • the Settings launcher is the real openLocalFromPanel: open the local modal,
       then dismissPanel() (REPLACE-drop the ?panel query) using the real useNav.

   That chain is exactly what the regression broke: onSettings used to leave the
   panel mounted, so its <Portal> kept #root inert + the body scroll-locked while
   invisible. The destination is a genuine <Portal> modal (NOT a fake NotifCenter),
   so we can prove the lock migrates to it and releases when it closes.

   Run: npm run test:ui */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useNav } from "./navHooks.js";
import { NotifPanelShell } from "./notifShell.jsx";
import { Portal } from "./overlay.jsx";

// jsdom has no #root by default; the inert lock targets it. Render the host INTO
// #root so the underlying "Team" page is what gets inert-locked, while the
// Portal escapes to document.body (exactly as in the app).
let warnSpy;
beforeEach(() => {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  // jsdom implements neither: releaseBackgroundLock restores scroll on unlock.
  window.scrollTo = () => {};
  // navHooks' dev-only cycle guard keys off module-scoped history that leaks
  // across these 5 sibling tests (each toggles the same /team ↔ ?panel URL), so
  // it can false-positive here. Silence only that telemetry line.
  warnSpy = vi.spyOn(console, "warn").mockImplementation((msg, ...rest) => {
    if (typeof msg === "string" && msg.includes("[nav] history cycle")) return;
    return console.info(msg, ...rest);
  });
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); warnSpy?.mockRestore(); });

const inert = () => document.getElementById("root").hasAttribute("inert");
const bodyLocked = () => document.body.style.position === "fixed";
const scrim = () => document.querySelector(".sb-scrim-right");
const locText = () => screen.getByTestId("loc").textContent;

// A genuine destination modal — a real <Portal modal>, not a fake NotifCenter.
function SettingsModal({ onClose }) {
  return (
    <Portal>
      <div role="dialog" aria-modal="true" aria-label="Notification settings">
        <button onClick={onClose}>Close settings</button>
      </div>
    </Portal>
  );
}

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="loc">{loc.pathname + loc.search}</span>;
}

// Mirrors Board's real wiring around NotifCenter.
function Host() {
  const R = useNav();
  const notifOpen = R.nav.overlay.panel === "notifications";
  const [settingsOpen, setSettingsOpen] = useState(false);
  // openLocalFromPanel: open a local modal, THEN REPLACE-drop ?panel so the
  // source panel unmounts and its Portal releases the lock naturally.
  const openLocalFromPanel = (openFn) => { openFn(); R.dismissPanel(); };
  return (
    <div id="page">
      <LocationProbe />
      <button onClick={() => {}}>Team action</button>
      {notifOpen && (
        <NotifPanelShell
          onClose={() => R.dismissPanel()}
          onSettings={() => openLocalFromPanel(() => setSettingsOpen(true))}
          unread={2}
          onMarkAllRead={() => {}}
        >
          {() => <div className="sb-notiflist"><button>A notification</button></div>}
        </NotifPanelShell>
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <button onClick={() => R.navigate(-1)}>Nav back</button>
    </div>
  );
}

function renderAt(entries, index) {
  const root = document.getElementById("root");
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Host />
    </MemoryRouter>,
    { container: root, baseElement: document.body }
  );
}

// Advance past the 180ms exit transition and flush effects.
const settle = () => act(() => { vi.advanceTimersByTime(200); });

describe("NotifCenter → Settings hand-off (real wiring)", () => {
  test("full lifecycle: panel locks, Settings launcher migrates the lock, close releases it, Back does not resurrect", () => {
    // 1. begin on /team?panel=notifications (pushed on top of /team)
    renderAt(["/team", "/team?panel=notifications"], 1);

    // 2. the actual Notifications panel rendered
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    // 3. #root inert + body scroll-locked
    expect(inert()).toBe(true);
    expect(bodyLocked()).toBe(true);

    // 4. click the REAL "Notification settings" control
    fireEvent.click(screen.getByRole("button", { name: "Notification settings" }));
    // 5. advance/complete the 180ms exit transition
    settle();

    // 6. ?panel=notifications removed (dropped via REPLACE, stayed on /team)
    expect(locText()).toBe("/team");
    // 7. the Notifications dialog AND its scrim unmounted
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(scrim()).toBeNull();
    // 8. Notification Settings is visible
    expect(screen.getByRole("dialog", { name: "Notification settings" })).toBeInTheDocument();
    // ...and the lock persisted through the hand-off (destination is a modal)
    expect(inert()).toBe(true);
    expect(bodyLocked()).toBe(true);

    // 9. close Notification Settings
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    settle();

    // 10. #root no longer inert  11. body lock styles cleared
    expect(inert()).toBe(false);
    expect(bodyLocked()).toBe(false);
    expect(document.body.style.position).toBe("");
    expect(document.body.style.top).toBe("");

    // 12. a real underlying Team control is focusable/interactive again
    const teamBtn = within(document.getElementById("page")).getByRole("button", { name: "Team action" });
    act(() => teamBtn.focus());
    expect(document.activeElement).toBe(teamBtn);

    // 13. Back returns to /team WITHOUT resurrecting Notifications or Profile
    fireEvent.click(screen.getByRole("button", { name: "Nav back" }));
    settle();
    expect(locText()).toBe("/team");
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Profile menu" })).toBeNull();
    expect(inert()).toBe(false);
  });

  test("X close: fades out, drops ?panel, releases the lock, lands on /team", () => {
    renderAt(["/team", "/team?panel=notifications"], 1);
    expect(inert()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    settle();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(scrim()).toBeNull();
    expect(locText()).toBe("/team");
    expect(inert()).toBe(false);
    expect(bodyLocked()).toBe(false);
  });

  test("Escape: fades out, drops ?panel, releases the lock", () => {
    renderAt(["/team", "/team?panel=notifications"], 1);
    expect(inert()).toBe(true);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    settle();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(locText()).toBe("/team");
    expect(inert()).toBe(false);
    expect(bodyLocked()).toBe(false);
  });

  test("scrim dismissal: mousedown on the scrim fades out and releases the lock", () => {
    renderAt(["/team", "/team?panel=notifications"], 1);
    expect(inert()).toBe(true);
    fireEvent.mouseDown(scrim());
    settle();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(locText()).toBe("/team");
    expect(inert()).toBe(false);
    expect(bodyLocked()).toBe(false);
  });

  test("direct-entry URL with no usable in-app history: closing still lands on /team, never resurrects", () => {
    // index 0 — the panel URL is the FIRST entry (deep link / refresh), nothing behind it.
    renderAt(["/team?panel=notifications"], 0);
    expect(inert()).toBe(true);
    // Settings hand-off from a cold entry
    fireEvent.click(screen.getByRole("button", { name: "Notification settings" }));
    settle();
    expect(locText()).toBe("/team");
    expect(screen.getByRole("dialog", { name: "Notification settings" })).toBeInTheDocument();
    // close destination
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    settle();
    expect(inert()).toBe(false);
    expect(bodyLocked()).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    // Back from a cold entry must not surface a stale panel
    fireEvent.click(screen.getByRole("button", { name: "Nav back" }));
    settle();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(inert()).toBe(false);
  });
});
