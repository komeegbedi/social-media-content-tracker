/* Regression tests for the overlay accessibility machinery (Portal) and the
   modal/non-modal distinction that the desktop Profile popover vs mobile Profile
   sheet rely on. Run: npm run test:ui */
import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Portal, useMediaQuery, resetUrlToCanonical } from "./overlay.jsx";

// jsdom has no #root by default; the inert lock targets it.
beforeEach(() => {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
});

function ModalDialog({ modal = true, label = "Test dialog" }) {
  return (
    <Portal modal={modal}>
      <div role="dialog" aria-modal={modal ? "true" : undefined} aria-label={label}>
        <button>First</button>
        <button>Middle</button>
        <button>Last</button>
      </div>
    </Portal>
  );
}

describe("Portal — modal", () => {
  test("makes the app root inert and restores it on close", async () => {
    const root = document.getElementById("root");
    const { unmount } = render(<ModalDialog />, { container: root, baseElement: document.body });
    // acquireOverlay runs in a layout effect
    await waitFor(() => expect(root.hasAttribute("inert")).toBe(true));
    unmount();
    expect(root.hasAttribute("inert")).toBe(false);
  });

  test("restores focus to the triggering control on close", async () => {
    const root = document.getElementById("root");
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    root.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger); // Portal captures this as prevFocus

    const { unmount } = render(<ModalDialog />, { baseElement: document.body });
    // simulate focus having entered the dialog (jsdom's rAF/layout is unreliable)
    screen.getAllByRole("button", { name: /First|Middle|Last/ })[1].focus();
    expect(document.activeElement).not.toBe(trigger);
    unmount();
    expect(document.activeElement).toBe(trigger); // ...restored to the trigger
  });

  test("traps Tab within the dialog (wraps last → first)", () => {
    render(<ModalDialog />, { baseElement: document.body });
    const buttons = screen.getAllByRole("button");
    // jsdom does no layout, so offsetParent is always null — make the buttons
    // report as visible so the trap's visibility filter behaves as in a browser.
    buttons.forEach((b) => Object.defineProperty(b, "offsetParent", { get: () => document.body, configurable: true }));
    const last = buttons[buttons.length - 1];
    last.focus();
    // Drive the trap's document keydown handler directly.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[0]); // wrapped to first, not out of the dialog
  });
});

describe("Portal — non-modal", () => {
  test("does NOT make the app root inert (background stays live)", async () => {
    const root = document.getElementById("root");
    render(<ModalDialog modal={false} />, { container: root, baseElement: document.body });
    // give layout effects a tick
    await act(async () => { await Promise.resolve(); });
    expect(root.hasAttribute("inert")).toBe(false);
  });

  test("still returns focus to the trigger on close", async () => {
    const root = document.getElementById("root");
    const trigger = document.createElement("button");
    root.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(<ModalDialog modal={false} />, { baseElement: document.body });
    await act(async () => { await Promise.resolve(); });
    unmount();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Portal — nested modals", () => {
  test("only the topmost modal is inert-locked once, released fully on close", async () => {
    const root = document.getElementById("root");
    function Nested() {
      return (<><ModalDialog label="Outer" /><ModalDialog label="Inner" /></>);
    }
    const { unmount } = render(<Nested />, { baseElement: document.body });
    await waitFor(() => expect(root.hasAttribute("inert")).toBe(true));
    // two modals share one inert lock (idempotent Set) — closing both releases it
    unmount();
    expect(root.hasAttribute("inert")).toBe(false);
  });
});

describe("useMediaQuery (drives desktop popover vs mobile sheet)", () => {
  function Harness() {
    const desktop = useMediaQuery("(min-width:900px)");
    // mirrors ProfileDrawer: modal on mobile, non-modal (no aria-modal) on desktop
    return (
      <Portal modal={!desktop}>
        <div role="dialog" aria-modal={desktop ? undefined : "true"} aria-label="Profile menu">
          <button>Item</button>
        </div>
      </Portal>
    );
  }
  test("desktop → non-modal (no aria-modal); mobile → modal (aria-modal=true)", async () => {
    // desktop
    window.matchMedia = vi.fn().mockImplementation((q) => ({
      matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {},
    }));
    const d = render(<Harness />, { baseElement: document.body });
    expect(screen.getByRole("dialog", { name: "Profile menu" })).not.toHaveAttribute("aria-modal");
    d.unmount();
    // mobile
    window.matchMedia = vi.fn().mockImplementation((q) => ({
      matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {},
    }));
    render(<Harness />, { baseElement: document.body });
    expect(screen.getByRole("dialog", { name: "Profile menu" })).toHaveAttribute("aria-modal", "true");
  });
});

describe("resetUrlToCanonical (auth URL cleanup)", () => {
  test("replaces a transient-overlay URL with the canonical route", () => {
    window.history.replaceState(null, "", "/team?panel=profile");
    expect(window.location.pathname + window.location.search).toBe("/team?panel=profile");
    resetUrlToCanonical();
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
  });
});

/* P0-C — the invisible Notifications lock. A URL-backed panel (NotifCenter) that
   launches a local modal (Notification Settings) MUST unmount so its Portal
   releases #root inert + the body scroll-lock. These lock in the invariant that
   URL/overlay/lock state agree: the source panel unmounting is what frees the
   page, and a delayed (animated "closing") unmount still frees it. */
describe("Portal — launcher handoff releases the lock (notification-lock regression)", () => {
  function Scene({ show }) {
    // show: "panel" (source), "settings" (destination), or "none"
    if (show === "panel") return <Portal modal><div role="dialog" aria-modal="true" aria-label="Notifications"><button>x</button></div></Portal>;
    if (show === "settings") return <Portal modal><div role="dialog" aria-modal="true" aria-label="Notification settings"><button>x</button></div></Portal>;
    return null;
  }
  const inert = () => document.getElementById("root").hasAttribute("inert");
  const bodyLocked = () => document.body.style.position === "fixed";

  test("source panel → settings → close: inert + scroll-lock released only at the end", async () => {
    const root = document.getElementById("root");
    const { rerender, unmount } = render(<Scene show="panel" />, { container: root, baseElement: document.body });
    await waitFor(() => expect(inert()).toBe(true));
    expect(bodyLocked()).toBe(true);
    // launcher: source panel UNMOUNTS, settings modal mounts (still a modal → still locked)
    rerender(<Scene show="settings" />);
    await waitFor(() => expect(inert()).toBe(true));
    expect(bodyLocked()).toBe(true);
    // close settings → nothing open → lock fully released
    rerender(<Scene show="none" />);
    expect(inert()).toBe(false);
    expect(bodyLocked()).toBe(false);
    unmount();
  });

  test("a delayed 'closing' unmount (animation) still releases the lock (fake timers)", () => {
    vi.useFakeTimers();
    try {
      const root = document.getElementById("root");
      // mimic NotifCenter.finish(): stay mounted through a 180ms closing animation,
      // then unmount. The lock must be gone once the timer fires and it unmounts.
      function Closing() {
        const [open, setOpen] = useState(true);
        // schedule the unmount like finish() does
        useState(() => { setTimeout(() => setOpen(false), 180); return 0; });
        return open ? <Portal modal><div role="dialog" aria-modal="true" aria-label="Notifications" /></Portal> : null;
      }
      act(() => { render(<Closing />, { container: root, baseElement: document.body }); });
      // layout effects + rAF flush under fake timers
      act(() => { vi.advanceTimersByTime(20); });
      expect(inert()).toBe(true);           // still locked while "closing"
      act(() => { vi.advanceTimersByTime(200); }); // animation completes → unmount
      expect(inert()).toBe(false);          // lock released by the unmount
      expect(bodyLocked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
