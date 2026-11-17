/* Round 6: the ONE account menu (opened by the avatar on phones, the sidebar profile
   button on desktop). Identity on top, appearance first, every setting reachable
   exactly once, permissions unchanged, the pending-approvals count explained,
   and it closes cleanly. */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import React from "react";
import { AppMenu } from "./AppMenu.jsx";

const Icon = () => <svg />;
const OPTS = [{ key: "system", label: "Match system", Icon }, { key: "light", label: "Light", Icon }, { key: "dark", label: "Dark", Icon }];
const base = (over = {}) => ({
  me: { name: "Sam Learner", email: "sam@example.com" }, roleLabel: "Member",
  appearance: "system", appearanceOptions: OPTS, onAppearance: vi.fn(), onClose: vi.fn(), onNewContent: vi.fn(),
  onGoTab: vi.fn(), onNotifPrefs: vi.fn(), onWhatsNew: vi.fn(), onFeatureRequest: vi.fn(), onReport: vi.fn(), onSignOut: vi.fn(), ...over,
});

// phone width: (min-width:900px) does not match, so the menu is modal
beforeEach(() => { window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }); });

describe("AppMenu (account menu)", () => {
  test("identity at the top: name, role and email", () => {
    render(<AppMenu {...base()} />);
    const dlg = screen.getByRole("dialog", { name: "Account menu" });
    expect(dlg).toHaveAttribute("aria-modal", "true");
    expect(within(dlg).getByText("Sam Learner")).toBeInTheDocument();
    expect(within(dlg).getByText("sam@example.com")).toBeInTheDocument();
    expect(dlg.textContent).toMatch(/Member/);
  });
  test("appearance is a labelled radio group before the other settings; choosing calls back with the key", () => {
    const p = base({ appearance: "dark" });
    render(<AppMenu {...p} />);
    const dlg = screen.getByRole("dialog", { name: "Account menu" });
    expect(screen.getByRole("group", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(p.onAppearance).toHaveBeenCalledWith("light");
    const all = dlg.querySelectorAll("input[type=radio], button.sb-drawer-item");
    expect(all[0].type).toBe("radio");
  });
  test("Notification preferences opens the settings form (not the inbox), after the sheet slides away", () => {
    vi.useFakeTimers();
    const p = base();
    render(<AppMenu {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Notification preferences" }));
    expect(p.onNotifPrefs).not.toHaveBeenCalled();            // the sheet is closing first
    act(() => { vi.advanceTimersByTime(250); });
    expect(p.onNotifPrefs).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  test("a member: each item once; no Search, no Profile duplicate, no Admin, no New content", () => {
    render(<AppMenu {...base()} />);
    for (const n of ["Notification preferences", "Team", "What's new", "Submit feature request", "Report an issue", "Sign out"]) {
      expect(screen.getAllByRole("button", { name: n })).toHaveLength(1);
    }
    expect(screen.queryByRole("button", { name: /^Search/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Profile/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Admin/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /New content/ })).toBeNull();
  });
  test("an admin: Admin with the pending-approvals count in its accessible name; New content when allowed", () => {
    const p = base({ isAdmin: true, canCreate: true, pendingCount: 2, roleLabel: "Admin" });
    render(<AppMenu {...p} />);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Admin, 2 accounts waiting for approval" }));
    act(() => { vi.advanceTimersByTime(250); });
    expect(p.onGoTab).toHaveBeenCalledWith("admin");
    vi.useRealTimers();
    const q = base({ isAdmin: true, canCreate: true, pendingCount: 2, roleLabel: "Admin" });
    const r = render(<AppMenu {...q} />);
    vi.useFakeTimers();
    fireEvent.click(within(r.container.ownerDocument.body).getAllByRole("button", { name: /^New content/ }).at(-1));
    act(() => { vi.advanceTimersByTime(250); });
    expect(q.onNewContent).toHaveBeenCalled();
    vi.useRealTimers();
  });
  test("groups: preferences, management, help; Sign out sits last, after a separator", () => {
    render(<AppMenu {...base()} />);
    expect(screen.getByRole("group", { name: "Preferences" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Manage" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Help" })).toBeInTheDocument();
    const items = [...screen.getByRole("dialog").querySelectorAll("button.sb-drawer-item")];
    expect(items.at(-1).textContent).toMatch(/Sign out/);
    expect(items.at(-1).previousElementSibling.className).toMatch(/sb-appmenu-sep/);
  });
  test("phones: a bottom sheet with a drag handle; Close and Escape slide it away, then close", () => {
    vi.useFakeTimers();
    const p = base();
    const { unmount } = render(<AppMenu {...p} />);
    const dlg = screen.getByRole("dialog", { name: "Account menu" });
    expect(dlg.className).toMatch(/sb-bsheet/);
    expect(dlg.querySelector(".sb-grab")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close account menu" }));
    expect(document.querySelector(".sb-scrim").className).toMatch(/closing/);
    act(() => { vi.advanceTimersByTime(250); });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    unmount();
    const q = base();
    render(<AppMenu {...q} />);
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => { vi.advanceTimersByTime(250); });
    expect(q.onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  test("reduced motion: closes at once", () => {
    window.matchMedia = (q) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
    vi.useFakeTimers();
    const p = base();
    render(<AppMenu {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Close account menu" }));
    act(() => { vi.advanceTimersByTime(1); });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  test("dragging the header down past the threshold dismisses; a drag that starts on a button doesn't", () => {
    vi.useFakeTimers();
    const p = base();
    render(<AppMenu {...p} />);
    const hd = document.querySelector(".sb-appmenu-hd");
    // starts on the Close button: ignored
    const btn = screen.getByRole("button", { name: "Close account menu" });
    fireEvent.touchStart(btn, { touches: [{ clientY: 100 }] }); fireEvent.touchMove(hd, { touches: [{ clientY: 400 }] }); fireEvent.touchEnd(hd);
    act(() => { vi.advanceTimersByTime(250); });
    expect(p.onClose).not.toHaveBeenCalled();
    // starts on the header itself: dismisses
    fireEvent.touchStart(hd.querySelector(".sb-appmenu-who"), { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(hd, { touches: [{ clientY: 300 }] });
    fireEvent.touchEnd(hd);
    act(() => { vi.advanceTimersByTime(250); });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
