/* SaveBanner — auto-dismiss + pause-on-focus behaviour (rendered, fake timers).
   Proves an Undo toast is NOT snatched away while focused, resumes after focus
   leaves, invokes the real action exactly once, and shows an error replacing a
   prior success. Run: npm run test:ui */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SaveBanner } from "./saveBanner.jsx";

beforeEach(() => vi.useFakeTimers());
// Flush any still-armed dismiss timer INSIDE act() so the resulting state update
// (setLeaving) never fires outside React's batching → no act() warning.
afterEach(() => { act(() => vi.runOnlyPendingTimers()); vi.useRealTimers(); });

const undoBanner = (onClick) => ({ msg: "Content moved to Trash", kind: "ok", action: { label: "Undo", onClick } });

describe("SaveBanner Undo", () => {
  test("focusing Undo pauses auto-dismiss; it dismisses only after focus leaves", () => {
    const onClose = vi.fn();
    render(<SaveBanner banner={undoBanner(() => {})} onClose={onClose} />);
    const undo = screen.getByRole("button", { name: "Undo" });

    // Focus Undo, then advance WELL past the 6s action hold — banner must remain.
    fireEvent.focus(undo);
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText("Content moved to Trash")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Move focus OUT of the banner → resume with a fresh generous window; after it
    // plus the fade, the banner closes. (Action banners resume with their full hold.)
    fireEvent.blur(undo, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(6000 + 220));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("focus moving between Undo and Dismiss does NOT restart the countdown", () => {
    const onClose = vi.fn();
    render(<SaveBanner banner={undoBanner(() => {})} onClose={onClose} />);
    const undo = screen.getByRole("button", { name: "Undo" });
    const dismiss = screen.getByRole("button", { name: "Dismiss" });

    fireEvent.focus(undo);
    // blur Undo but relatedTarget is Dismiss — still inside the banner → no resume.
    fireEvent.blur(undo, { relatedTarget: dismiss });
    fireEvent.focus(dismiss);
    act(() => vi.advanceTimersByTime(10000));
    expect(onClose).not.toHaveBeenCalled();   // still paused, not dismissed
  });

  test("clicking Undo invokes the real action exactly once and closes", () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    render(<SaveBanner banner={undoBanner(onClick)} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a plain success auto-dismisses after its hold", () => {
    const onClose = vi.fn();
    render(<SaveBanner banner={{ msg: "Saved", kind: "ok", action: null }} onClose={onClose} />);
    act(() => vi.advanceTimersByTime(4300 + 220));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a pending banner never auto-dismisses", () => {
    const onClose = vi.fn();
    render(<SaveBanner banner={{ msg: "Moving to Trash…", kind: "pending", action: null }} onClose={onClose} />);
    act(() => vi.advanceTimersByTime(60000));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull(); // no dismiss on pending
  });

  test("an error banner replacing a success shows the error and its own countdown", () => {
    const onClose = vi.fn();
    const { rerender } = render(<SaveBanner banner={{ msg: "Content restored", kind: "ok", action: null }} onClose={onClose} />);
    rerender(<SaveBanner banner={{ msg: "Couldn't restore — it's still in Trash.", kind: "err", action: null }} onClose={onClose} />);
    expect(screen.getByText("Couldn't restore — it's still in Trash.")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4300 + 220));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
