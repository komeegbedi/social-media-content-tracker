/* Save-flow race safety (rendered). Exercises useSaveFlow through a harness that
   mirrors the notification-settings dialog EXACTLY: toggles bound to state, each
   disabled while `locked`, a Save button that persists the current snapshot, and an
   aria-live status region. Proves a value can't be lost to an in-flight/after-success
   change, duplicate saves collapse, errors keep the panel open, and unmount is clean.
   Run: npm run test:ui */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { StrictMode, useState } from "react";

// Mock the app error-reporter so the hook stays firebase-free in jsdom AND we can
// assert a thrown save is logged.
const logIssue = vi.fn();
vi.mock("./logging", () => ({ logIssue: (...a) => logIssue(...a) }));

const { useSaveFlow } = await import("./useSaveFlow.js");
const { Toggle } = await import("./controls.jsx");

// A manually-resolvable promise so we can hold a save "in flight".
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Harness mirroring NotifSettings: two toggles + Save, locked disables everything.
function Harness({ onSave, onClose, closeDelay = 650 }) {
  const [p, setP] = useState({ a: true, b: false });
  const { saveState, locked, save } = useSaveFlow(onSave, onClose, closeDelay);
  return (
    <div>
      <Toggle label="Alpha" v={p.a} disabled={locked} on={() => setP((s) => ({ ...s, a: !s.a }))} />
      <Toggle label="Beta" v={p.b} disabled={locked} on={() => setP((s) => ({ ...s, b: !s.b }))} />
      <div aria-live="polite" data-testid="status">{saveState}</div>
      <button disabled={locked} onClick={() => save(p)}>
        {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Save"}
      </button>
    </div>
  );
}

const sw = (name) => screen.getByRole("switch", { name });
const saveBtn = () => screen.getByRole("button", { name: /save/i });

beforeEach(() => { vi.useFakeTimers(); logIssue.mockReset(); });
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); });

describe("useSaveFlow race safety", () => {
  test("a toggle change DURING an in-flight save is blocked (controls locked); the snapshot is preserved", async () => {
    const d = deferred();
    const onSave = vi.fn(() => d.promise);
    const onClose = vi.fn();
    render(<Harness onSave={onSave} onClose={onClose} />);

    fireEvent.click(saveBtn());                       // capture snapshot {a:true,b:false}
    expect(onSave).toHaveBeenCalledWith({ a: true, b: false });
    expect(sw("Alpha")).toBeDisabled();               // locked during saving
    expect(sw("Beta")).toBeDisabled();

    fireEvent.click(sw("Beta"));                       // attempt to flip Beta mid-save → no-op (disabled)
    await act(async () => { d.resolve(true); });       // save resolves
    expect(screen.getByTestId("status")).toHaveTextContent("saved");
    // Beta never changed the persisted payload — onSave saw the original snapshot only.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenLastCalledWith({ a: true, b: false });
  });

  test("a toggle attempt AFTER success but BEFORE auto-close is blocked; then it closes once", async () => {
    const onSave = vi.fn(async () => true);
    const onClose = vi.fn();
    render(<Harness onSave={onSave} onClose={onClose} />);
    await act(async () => { fireEvent.click(saveBtn()); });
    expect(screen.getByTestId("status")).toHaveTextContent("saved");
    expect(sw("Alpha")).toBeDisabled();               // still locked in the close window
    fireEvent.click(sw("Alpha"));                      // blocked
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(650); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("duplicate Save clicks collapse to a single submission", async () => {
    const d = deferred();
    const onSave = vi.fn(() => d.promise);
    render(<Harness onSave={onSave} onClose={vi.fn()} />);
    const btn = saveBtn();                             // same DOM node across re-renders
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);                            // second (button disabled + in-flight guard)
      fireEvent.click(btn);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => { d.resolve(true); });
  });

  test("onSave RETURNING FALSE keeps the panel open with selections intact and controls unlocked", async () => {
    const onSave = vi.fn(async () => false);          // failure
    const onClose = vi.fn();
    render(<Harness onSave={onSave} onClose={onClose} />);
    await act(async () => { fireEvent.click(saveBtn()); });
    expect(screen.getByTestId("status")).toHaveTextContent("error");
    expect(onClose).not.toHaveBeenCalled();
    expect(sw("Alpha")).not.toBeDisabled();           // unlocked so the user can retry
    expect(sw("Alpha")).toBeChecked();                // selections intact
    expect(logIssue).not.toHaveBeenCalled();          // a false return is expected, not logged
    // Retry is possible after an error.
    fireEvent.click(saveBtn());
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  test("onSave THROWING / rejecting → error (logged), unlocked, dialog stays open; a retry can succeed", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))  // first attempt rejects
      .mockResolvedValueOnce(true);                       // retry succeeds
    render(<Harness onSave={onSave} onClose={onClose} />);
    await act(async () => { fireEvent.click(saveBtn()); });
    expect(screen.getByTestId("status")).toHaveTextContent("error");
    expect(onClose).not.toHaveBeenCalled();
    expect(sw("Alpha")).not.toBeDisabled();            // controls unlocked after a rejection
    expect(logIssue).toHaveBeenCalledTimes(1);         // unexpected throw is reported
    expect(logIssue.mock.calls[0][0]).toMatchObject({ kind: "error" });
    // Retry after the rejection succeeds and closes once.
    await act(async () => { fireEvent.click(saveBtn()); });
    expect(screen.getByTestId("status")).toHaveTextContent("saved");
    await act(async () => { vi.advanceTimersByTime(650); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  test("unmounting during a save produces no delayed close and no state update", async () => {
    const d = deferred();
    const onSave = vi.fn(() => d.promise);
    const onClose = vi.fn();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<Harness onSave={onSave} onClose={onClose} />);
    fireEvent.click(saveBtn());
    unmount();                                         // leave mid-flight
    await act(async () => { d.resolve(true); });
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(onClose).not.toHaveBeenCalled();            // no close after unmount
    expect(errSpy).not.toHaveBeenCalled();             // no "set state on unmounted" warning
    errSpy.mockRestore();
  });

  test("a successful, unchanged save closes exactly once", async () => {
    const onSave = vi.fn(async () => true);
    const onClose = vi.fn();
    render(<Harness onSave={onSave} onClose={onClose} />);
    await act(async () => { fireEvent.click(saveBtn()); });
    await act(async () => { vi.advanceTimersByTime(650); });
    await act(async () => { vi.advanceTimersByTime(650); }); // no second fire
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("locked switches expose their disabled state accessibly (role=switch + disabled)", async () => {
    const d = deferred();
    render(<Harness onSave={() => d.promise} onClose={vi.fn()} />);
    expect(sw("Alpha")).toHaveAttribute("role", "switch");
    expect(sw("Alpha")).not.toBeDisabled();
    fireEvent.click(saveBtn());
    expect(sw("Alpha")).toBeDisabled();                // native disabled → announced by AT
    expect(sw("Alpha")).toHaveAttribute("aria-checked", "true");
    await act(async () => { d.resolve(true); });
  });
});

// The app renders inside <React.StrictMode>, whose dev-mode setup→cleanup→setup
// remount previously stranded a completed save on "Saving…" (the mount flag was set
// once at ref creation and never restored after the first cleanup). These exercise the
// hook under a real StrictMode tree.
describe("useSaveFlow under React.StrictMode", () => {
  const renderStrict = (props) => render(<StrictMode><Harness {...props} /></StrictMode>);

  test("a successful save reaches 'saved' and closes exactly once (not stranded on saving)", async () => {
    const onSave = vi.fn(async () => true);
    const onClose = vi.fn();
    renderStrict({ onSave, onClose });
    await act(async () => { fireEvent.click(saveBtn()); });
    expect(screen.getByTestId("status")).toHaveTextContent("saved"); // NOT stuck on "saving"
    await act(async () => { vi.advanceTimersByTime(650); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("StrictMode's simulated cleanup does not leave the hook marked unmounted", async () => {
    // If the remount left `mounted` false, this save would silently bail before 'saved'.
    const d = deferred();
    const onSave = vi.fn(() => d.promise);
    const onClose = vi.fn();
    renderStrict({ onSave, onClose });
    await act(async () => { fireEvent.click(saveBtn()); });
    expect(screen.getByTestId("status")).toHaveTextContent("saving");
    await act(async () => { d.resolve(true); });
    expect(screen.getByTestId("status")).toHaveTextContent("saved");
    await act(async () => { vi.advanceTimersByTime(650); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a rejected save under StrictMode transitions to error and does not close", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("boom"));
    const onClose = vi.fn();
    renderStrict({ onSave, onClose });
    await act(async () => { fireEvent.click(saveBtn()); });
    expect(screen.getByTestId("status")).toHaveTextContent("error");
    expect(sw("Alpha")).not.toBeDisabled();
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("duplicate rapid Save clicks under StrictMode still produce one request", async () => {
    const d = deferred();
    const onSave = vi.fn(() => d.promise);
    renderStrict({ onSave, onClose: vi.fn() });
    const btn = saveBtn();
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn); fireEvent.click(btn); });
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => { d.resolve(true); });
  });
});
