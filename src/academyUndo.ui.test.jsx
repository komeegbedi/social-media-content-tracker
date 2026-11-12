/* Regression: single-step Undo + reorder persistence (the old code offered Undo
   again after undoing, toggling forever, and reset optimistic order on a timer).
   Run: npm run test:ui */
import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React, { useRef, useState } from "react";
import { useUndo, useReorder, recordMove, sameIds } from "./academyUndo.jsx";
import { moveId } from "./academyOrder.js";

const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

/* A list whose "server" is controllable: persist() returns pending promises we
   settle by hand; `observed` follows successful writes (like Firestore). */
function Harness({ persistImpl, initial = ["a", "b", "c", "d"] }) {
  const [observed, setObserved] = useState(initial);
  const obsRef = useRef(observed); obsRef.current = observed;
  const undo = useUndo();
  const order = useReorder(observed, async (ids) => { await persistImpl(ids); setObserved(ids); });
  const move = (id, to) => recordMove({ before: order.shown, after: moveId(order.shown, id, to), label: id, save: order.save, current: () => obsRef.current, undo });
  return (
    <div>
      <output data-testid="shown">{order.shown.join("")}</output>
      <output data-testid="saved">{observed.join("")}</output>
      <output data-testid="phase">{order.state.phase}</output>
      <output data-testid="errmsg">{order.state.message || ""}</output>
      <button onClick={() => move("d", 0)}>move d to top</button>
      <button onClick={() => move("a", 3)}>move a to bottom</button>
      <button onClick={() => move("b", 1)}>no-op</button>
      <button onClick={() => setObserved(["c", "a", "b", "d"])}>someone else reorders</button>
      {order.state.phase === "error" && <button onClick={() => order.retry().catch(() => {})}>retry save</button>}
      {undo.node}
    </div>
  );
}
const shown = () => screen.getByTestId("shown").textContent;
// The app runs under React.StrictMode (double mount in development) — so do these tests.
const strictRender = (ui) => render(<React.StrictMode>{ui}</React.StrictMode>);
const saved = () => screen.getByTestId("saved").textContent;

describe("single-step Undo", () => {
  test("a move offers ONE Undo; undoing restores the previous order once and offers no further Undo", async () => {
    const persist = vi.fn(async () => {});
    strictRender(<Harness persistImpl={persist} />);
    await act(async () => { fireEvent.click(screen.getByText("move d to top")); });
    expect([shown(), saved()]).toEqual(["dabc", "dabc"]);
    expect(screen.getByText("Moved “d”.")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect([shown(), saved()]).toEqual(["abcd", "abcd"]);
    expect(screen.getByText("Move undone.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();          // no toggle loop
    expect(persist).toHaveBeenCalledTimes(2);
  });
  test("rapid double clicks on Undo run it once; the button is disabled while pending", async () => {
    let gate = null;
    const persist = vi.fn((ids) => (ids.join("") === "abcd" ? (gate = deferred()).p : Promise.resolve()));
    strictRender(<Harness persistImpl={persist} />);
    await act(async () => { fireEvent.click(screen.getByText("move d to top")); });
    const btn = screen.getByRole("button", { name: "Undo" });
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn); fireEvent.click(btn); });
    expect(screen.getByRole("button", { name: "Undoing…" })).toBeDisabled();
    expect(persist.mock.calls.filter(([ids]) => ids.join("") === "abcd")).toHaveLength(1);
    await act(async () => { gate.resolve(); });
    expect(saved()).toBe("abcd");
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  });
  test("a new move replaces the previous undo opportunity; a no-op drag offers nothing", async () => {
    strictRender(<Harness persistImpl={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByText("no-op")); });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByText("move d to top")); });
    await act(async () => { fireEvent.click(screen.getByText("move a to bottom")); });
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    expect(screen.getByText("Moved “a”.")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(saved()).toBe("dabc");                                                   // only the LAST move reversed
  });
  test("failed undo: truthful error, safe 'Try again', no duplicate writes", async () => {
    let fail = true;
    const persist = vi.fn(async (ids) => { if (ids.join("") === "abcd" && fail) throw new Error("Network unavailable"); });
    strictRender(<Harness persistImpl={persist} />);
    await act(async () => { fireEvent.click(screen.getByText("move d to top")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(screen.getByText("Couldn't undo: the connection dropped.")).toBeInTheDocument();
    expect(saved()).toBe("dabc");
    fail = false;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(saved()).toBe("abcd");
    expect(screen.getByText("Move undone.")).toBeInTheDocument();
  });
  test("a stale undo (someone else reordered since) is refused instead of overwriting their order", async () => {
    const persist = vi.fn(async () => {});
    strictRender(<Harness persistImpl={persist} />);
    await act(async () => { fireEvent.click(screen.getByText("move d to top")); });
    await act(async () => { fireEvent.click(screen.getByText("someone else reorders")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    expect(saved()).toBe("cabd");
    expect(screen.getByText(/can't be undone safely/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Undo|Try again/ })).toBeNull();
    expect(persist).toHaveBeenCalledTimes(1);
  });
  test("dismissing clears the toast", async () => {
    strictRender(<Harness persistImpl={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByText("move d to top")); });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Moved “d”.")).toBeNull();
  });
});

describe("reorder persistence", () => {
  test("a slow save never snaps the list back; overlapping moves are serialized and coalesced to the latest", async () => {
    const calls = []; const gates = [];
    const persist = (ids) => { calls.push(ids.join("")); const g = deferred(); gates.push(g); return g.p; };
    strictRender(<Harness persistImpl={persist} />);
    await act(async () => { fireEvent.click(screen.getByText("move d to top")); });    // write 1 in flight
    expect(shown()).toBe("dabc");
    await act(async () => { fireEvent.click(screen.getByText("move a to bottom")); }); // queued
    await act(async () => { fireEvent.click(screen.getByText("move d to top")); });    // supersedes the queued one
    expect(calls).toEqual(["dabc"]);                                                    // nothing overlapped
    await act(async () => { gates[0].resolve(); });
    expect(calls.length).toBe(2);                                                       // only the latest queued order
    expect(shown()).toBe(calls[1]);
    await act(async () => { gates[1].resolve(); });
    expect(screen.getByTestId("phase").textContent).toBe("idle");
    expect(shown()).toBe(saved());
  });
  test("a failed move shows the saved order, withdraws its Undo, and Retry writes it once", async () => {
    let fail = true;
    const persist = vi.fn(async () => { if (fail) throw Object.assign(new Error("PERMISSION_DENIED: evaluation error at L833:24"), { code: "permission-denied" }); });
    strictRender(<Harness persistImpl={persist} />);
    await act(async () => { fireEvent.click(screen.getByText("move d to top")); });
    expect(screen.getByTestId("phase").textContent).toBe("error");
    expect(screen.getByTestId("errmsg").textContent).toMatch(/server didn't accept the change/);
    expect(document.body.textContent).not.toMatch(/L833|evaluation error/);
    expect(shown()).toBe("abcd");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    fail = false;
    await act(async () => { fireEvent.click(screen.getByText("retry save")); });
    expect([shown(), saved()]).toEqual(["dabc", "dabc"]);
    expect(persist).toHaveBeenCalledTimes(2);
  });
  test("sameIds", () => {
    expect(sameIds(["a"], ["a"])).toBe(true);
    expect(sameIds(["a", "b"], ["b", "a"])).toBe(false);
  });
});
