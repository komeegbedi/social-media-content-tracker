/* EmailUsage diagnostics (rendered) — last-observed model + real-time listener.
   Proves: states (observed / stale / not-observed / period boundaries / loading),
   live snapshot updates, out-of-order snapshot ignored, unsubscribe on unmount, no
   listener while closed, deterministic post-test re-read, and no secret/debug leakage.
   Run: npm run test:ui */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

const callFunction = vi.fn();
let snapshotCb = null;
let unsubCount = 0;
const onSnapshot = vi.fn((_ref, next) => { snapshotCb = next; return () => { unsubCount++; }; });
vi.mock("./firebase", () => ({ callFunction: (...a) => callFunction(...a), db: {} }));
vi.mock("firebase/firestore", () => ({ onSnapshot: (...a) => onSnapshot(...a), doc: () => ({}) }));

const { EmailUsage } = await import("./EmailUsage.jsx");
const { periodKeys } = await import("./emailUsageDoc.js");

const NOW = Date.now();
const CUR = periodKeys(NOW);
const OBSERVED = {
  providerAvailable: true, source: "resend", stale: false, observedVia: "send",
  monthly: { used: 40, limit: 3000, percent: 1.3 }, daily: { used: 0, limit: 100, percent: 0 }, dailyReason: null,
  lastSyncedAt: new Date(NOW - 60000).toISOString(),
  internalTelemetry: { appInitiatedThisMonth: 12, appSafetyCap: 2800 }, providerError: null,
};
const snapDoc = (over = {}) => ({
  monthly: { used: 41, limit: 3000, percent: 1.4 }, daily: { used: 1, limit: 100, percent: 1 }, dailyReason: null,
  periodMonth: CUR.month, periodDay: CUR.day, observedAt: new Date(NOW).toISOString(), observedVia: "send", source: "resend",
  providerUsageProven: true, ...over, // proven-model doc; the server stamps this only once semantics are proven
});
const deliverSnap = async (data) => { await act(async () => { snapshotCb({ exists: () => true, data: () => data }); }); };

beforeEach(() => { callFunction.mockReset(); onSnapshot.mockClear(); snapshotCb = null; unsubCount = 0; });

async function renderResolved(data) {
  callFunction.mockResolvedValue({ data });
  const utils = await act(async () => render(<EmailUsage />));
  return utils;
}

describe("states", () => {
  test("loading → message before the callable resolves", async () => {
    let resolve; callFunction.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<EmailUsage />);
    expect(screen.getByText(/loading email usage/i)).toBeInTheDocument();
    await act(async () => { resolve({ data: OBSERVED }); });
    expect(screen.queryByText(/loading email usage/i)).not.toBeInTheDocument();
  });

  test("observed → 40 / 3,000, 1.3% used, 0 / 100, 'Observed on send', View in Resend link", async () => {
    await renderResolved(OBSERVED);
    expect(screen.getByText("Observed on send")).toBeInTheDocument();
    expect(screen.getByText("40 / 3,000")).toBeInTheDocument();
    expect(screen.getByText("1.3% used")).toBeInTheDocument();
    expect(screen.getByText("0 / 100")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view in resend/i })).toHaveAttribute("href", "https://resend.com/emails");
  });

  test("app safety cap shown separately, never as a Resend limit", async () => {
    await renderResolved(OBSERVED);
    expect(screen.getByText(/app safety cap \(this app only\)/i)).toBeInTheDocument();
    expect(screen.getByText("12 / 2,800")).toBeInTheDocument();
    expect(screen.queryByText("40 / 2,800")).not.toBeInTheDocument();
  });

  test("not-observed-this-month → distinct note, no current monthly number", async () => {
    await renderResolved({ providerAvailable: false, source: "resend", stale: true, monthly: null, daily: null, dailyReason: null,
      lastSyncedAt: "2026-08-31T12:00:00.000Z", internalTelemetry: { appInitiatedThisMonth: 5, appSafetyCap: 2800 }, providerError: { code: "not-observed-this-month" } });
    expect(screen.getByText(/no resend usage observed this month yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/3,000/)).not.toBeInTheDocument();
  });

  test("midnight rollover (not-observed-today) → 'No send yet today', monthly kept", async () => {
    await renderResolved({ ...OBSERVED, daily: null, dailyReason: "not-observed-today" });
    expect(screen.getByText("40 / 3,000")).toBeInTheDocument();
    expect(screen.getByText("No send yet today")).toBeInTheDocument();
  });

  test("paid plan (not-provided) → 'Not provided by Resend'", async () => {
    await renderResolved({ ...OBSERVED, daily: null, dailyReason: "not-provided" });
    expect(screen.getByText("Not provided by Resend")).toBeInTheDocument();
  });

  test("invalid provider data → 'Unavailable' badge, no numbers/bar, app safety still shown", async () => {
    await renderResolved({
      providerAvailable: false, source: "internal-fallback", monthly: null, daily: null, dailyReason: null,
      lastSyncedAt: "2026-08-29T09:49:00.000Z", internalTelemetry: { appInitiatedThisMonth: 114, appSafetyCap: 2800 },
      providerError: { code: "invalid-provider-observation" },
    });
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Observed on send")).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't be verified/i)).toBeInTheDocument();
    expect(screen.queryByText("3,001 / 3,000")).not.toBeInTheDocument();
    // No 100% bar from the invalid provider data (the only bar is the ~4% app-safety row).
    const bars = screen.queryAllByRole("progressbar");
    expect(bars.some((b) => b.getAttribute("aria-valuenow") === "100")).toBe(false);
    expect(screen.getByText("114 / 2,800")).toBeInTheDocument();        // app safety still shown
    expect(screen.getByRole("link", { name: /view in resend/i })).toBeInTheDocument();
  });
});

describe("real-time listener", () => {
  test("a mounted panel attaches a listener and updates on a newer snapshot (no Refresh)", async () => {
    await renderResolved(OBSERVED);
    expect(onSnapshot).toHaveBeenCalledTimes(1);         // attached while open
    expect(screen.getByText("40 / 3,000")).toBeInTheDocument();
    await deliverSnap(snapDoc());                        // observedAt = NOW > OBSERVED.lastSyncedAt
    expect(screen.getByText("41 / 3,000")).toBeInTheDocument();
    expect(screen.getByText("1 / 100")).toBeInTheDocument();
  });

  test("a snapshot carrying internalTelemetry advances the app safety usage row automatically", async () => {
    await renderResolved(OBSERVED);                       // app safety = 12 / 2,800 initially
    expect(screen.getByText("12 / 2,800")).toBeInTheDocument();
    await deliverSnap(snapDoc({ internalTelemetry: { appInitiatedThisMonth: 13, appSafetyCap: 2800 } }));
    expect(screen.getByText("13 / 2,800")).toBeInTheDocument();
    expect(screen.getByText("41 / 3,000")).toBeInTheDocument(); // provider also updated
  });

  test("containment: a snapshot WITHOUT providerUsageProven → Unavailable, but app safety still advances", async () => {
    await renderResolved(OBSERVED);
    await deliverSnap(snapDoc({ providerUsageProven: false, internalTelemetry: { appInitiatedThisMonth: 20, appSafetyCap: 2800 } }));
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("41 / 3,000")).not.toBeInTheDocument(); // provider usage not shown
    expect(screen.getByText("20 / 2,800")).toBeInTheDocument();       // app-safety telemetry still live
  });

  test("an OLDER (out-of-order) snapshot is ignored — the UI does not regress", async () => {
    await renderResolved(OBSERVED);
    await deliverSnap(snapDoc({ monthly: { used: 5, limit: 3000, percent: 0.2 }, observedAt: new Date(NOW - 120000).toISOString() }));
    expect(screen.getByText("40 / 3,000")).toBeInTheDocument();
    expect(screen.queryByText("5 / 3,000")).not.toBeInTheDocument();
  });

  test("the listener unsubscribes on unmount (no listener while the panel is closed)", async () => {
    const { unmount } = await renderResolved(OBSERVED);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubCount).toBe(1);
  });

  test("no listener is attached when the panel is not rendered", () => {
    expect(onSnapshot).toHaveBeenCalledTimes(0);
  });
});

describe("post-test re-read + feedback", () => {
  test("bumping refreshToken re-reads via the callable; when usage advances the note clears", async () => {
    callFunction.mockResolvedValue({ data: OBSERVED });
    const { rerender } = await act(async () => render(<EmailUsage refreshToken={0} />));
    expect(screen.getByText("40 / 3,000")).toBeInTheDocument();
    callFunction.mockResolvedValue({ data: { ...OBSERVED, monthly: { used: 44, limit: 3000, percent: 1.5 }, lastSyncedAt: new Date(NOW + 5000).toISOString() } });
    await act(async () => { rerender(<EmailUsage refreshToken={1} />); });
    expect(screen.getByText("44 / 3,000")).toBeInTheDocument();
    expect(screen.queryByText(/updating usage/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be saved/i)).not.toBeInTheDocument();
  });

  test("a telemetry-only advance (same provider timestamp) clears the updating note", async () => {
    callFunction.mockResolvedValue({ data: OBSERVED }); // appInitiatedThisMonth 12
    const { rerender } = await act(async () => render(<EmailUsage refreshToken={0} />));
    // Callable returns same provider timestamp, but app safety usage advanced 12 → 13.
    callFunction.mockResolvedValue({ data: { ...OBSERVED, internalTelemetry: { appInitiatedThisMonth: 13, appSafetyCap: 2800 } } });
    await act(async () => { rerender(<EmailUsage refreshToken={1} />); });
    expect(screen.getByText("13 / 2,800")).toBeInTheDocument();
    expect(screen.queryByText(/updating usage/i)).not.toBeInTheDocument();
  });

  test("if nothing advances → 'Updating usage…' then, on timeout, an actionable warning", async () => {
    vi.useFakeTimers();
    try {
      callFunction.mockResolvedValue({ data: OBSERVED });
      const { rerender } = await act(async () => render(<EmailUsage refreshToken={0} />));
      callFunction.mockResolvedValue({ data: OBSERVED });                 // unchanged → not advanced
      await act(async () => { rerender(<EmailUsage refreshToken={1} />); });
      expect(screen.getByText(/updating usage/i)).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(8000); });
      expect(screen.getByText(/could not be saved/i)).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  test("a later snapshot advance clears the timeout warning", async () => {
    vi.useFakeTimers();
    try {
      callFunction.mockResolvedValue({ data: OBSERVED });
      const { rerender } = await act(async () => render(<EmailUsage refreshToken={0} />));
      callFunction.mockResolvedValue({ data: OBSERVED });
      await act(async () => { rerender(<EmailUsage refreshToken={1} />); });
      await act(async () => { vi.advanceTimersByTime(8000); });
      expect(screen.getByText(/could not be saved/i)).toBeInTheDocument();
      // a provider observation finally arrives → warning clears
      await deliverSnap(snapDoc());
      expect(screen.queryByText(/could not be saved/i)).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
});

describe("listener errors", () => {
  test("a listener permission/read error is surfaced (distinct from 'waiting for usage')", async () => {
    // Make onSnapshot invoke the error callback instead of a data callback.
    onSnapshot.mockImplementationOnce((_ref, _next, err) => { err(new Error("permission-denied")); return () => {}; });
    await renderResolved(OBSERVED);
    expect(screen.getByText(/live usage updates are unavailable/i)).toBeInTheDocument();
  });
});

test("no API key, authorization, or debug data appears in the rendered DOM", async () => {
  await renderResolved(OBSERVED);
  await deliverSnap(snapDoc());
  const html = document.body.innerHTML.toLowerCase();
  expect(html.includes("authorization")).toBe(false);
  expect(html.includes("bearer ")).toBe(false);
  expect(html.includes("re_")).toBe(false);
  expect(html.includes("_debug")).toBe(false);
});

test("technical details discloses the app-initiated telemetry + on-send limitation", async () => {
  await renderResolved(OBSERVED);
  const tech = screen.getByText("Technical details");
  expect(tech.tagName.toLowerCase()).toBe("summary");
  expect(within(tech.closest("details")).getByText(/app-initiated sends this month/i)).toBeInTheDocument();
  expect(within(tech.closest("details")).getByText(/out-of-band resend activity/i)).toBeInTheDocument();
});
