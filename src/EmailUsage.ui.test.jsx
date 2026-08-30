/* EmailUsage (rendered) — STAGE A build (provider accounting DISABLED for rollback safety).
   Provider totals are never rendered; a valid Stage D document/callable reads as
   Unavailable. App-safety telemetry stays visible and live. Scoped failures never block.
   The full provider-rendering behaviour is covered on the Stage D branch.
   Run: npm run test:ui */
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const callFunction = vi.fn();
let snapshotCb = null, snapshotErrCb = null, unsubCount = 0;
const onSnapshot = vi.fn((_ref, next, err) => { snapshotCb = next; snapshotErrCb = err; return () => { unsubCount++; }; });
vi.mock("./firebase", () => ({ callFunction: (...a) => callFunction(...a), db: {} }));
vi.mock("firebase/firestore", () => ({ onSnapshot: (...a) => onSnapshot(...a), doc: () => ({}) }));

const { EmailUsage } = await import("./EmailUsage.jsx");
const { periodKeys } = await import("./emailUsageDoc.js");
const NOW = Date.now();
const CUR = periodKeys(NOW);

// A fully-valid Stage D callable result / document (proven + known model + bounded totals).
const stageDCallable = (over = {}) => ({
  providerAvailable: true, providerUsageProven: true, providerUsageModel: "resend-pre-send-used-v1", source: "resend",
  monthly: { used: 44, limit: 3000, percent: 1.5 }, daily: { used: 5, limit: 100, percent: 5 }, dailyReason: null,
  lastSyncedAt: new Date(NOW).toISOString(), internalTelemetry: { appInitiatedThisMonth: 114, appSafetyCap: 2800 }, ...over,
});
const stageDDoc = (over = {}) => ({
  monthly: { used: 44, limit: 3000, percent: 1.5 }, daily: { used: 5, limit: 100, percent: 5 }, dailyReason: null,
  periodMonth: CUR.month, periodDay: CUR.day, observedAt: new Date(NOW).toISOString(), observedVia: "send",
  source: "resend", providerUsageProven: true, providerUsageModel: "resend-pre-send-used-v1",
  internalTelemetry: { appInitiatedThisMonth: 114, appSafetyCap: 2800 }, ...over,
});
const deliverSnap = async (data) => { await act(async () => { snapshotCb({ exists: () => true, data: () => data }); }); };
async function renderResolved(data) { callFunction.mockResolvedValue({ data }); return act(async () => render(<EmailUsage />)); }

beforeEach(() => { callFunction.mockReset(); onSnapshot.mockClear(); snapshotCb = null; snapshotErrCb = null; unsubCount = 0; });

test("rollback safety: a valid Stage D CALLABLE result renders Unavailable, no totals, app-safety shown", async () => {
  await renderResolved(stageDCallable());
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(screen.queryByText("44 / 3,000")).not.toBeInTheDocument();
  expect(screen.queryByText("Observed on send")).not.toBeInTheDocument();
  expect(screen.getByText("114 successful deliveries")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /view in resend/i })).toBeInTheDocument();
});

test("unverified provider state: Unavailable badge + reset-window message; no 'Not observed yet'; historical time only under Technical details", async () => {
  await renderResolved(stageDCallable()); // carries lastSyncedAt → a historical observation exists
  expect(screen.getByText("Resend account usage")).toBeInTheDocument();          // section title
  expect(screen.getByText("Unavailable")).toBeInTheDocument();                    // badge
  expect(screen.getByText(/Resend usage is temporarily unavailable while we verify when its quota counters reset/i)).toBeInTheDocument();
  // Must NOT imply nothing was ever observed, and must NOT show the historical time in the primary.
  expect(screen.queryByText("Not observed yet")).not.toBeInTheDocument();
  expect(screen.queryByText(/^Last observed/)).not.toBeInTheDocument();
  // No provider totals or bars.
  expect(screen.queryByText("44 / 3,000")).not.toBeInTheDocument();
  expect(screen.queryAllByRole("progressbar").length).toBe(0);
  // Historical time appears ONLY inside the (collapsed) Technical details.
  const hist = screen.getByText(/Historical unverified observation/i);
  expect(hist.closest("details")).not.toBeNull();
  expect(screen.getByText(/Not shown as current usage/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /view in resend/i })).toBeInTheDocument();
});

test("internal-period wording is honest — neither UTC period claims to be the authoritative Resend period", async () => {
  await renderResolved({ ...stageDCallable(), internalTelemetry: { appInitiatedThisMonth: 119, appSafetyCap: 2800, appDailyThisDay: 5, appDailyLimit: 90 } });
  expect(screen.getByText(/App email activity · UTC calendar month/i)).toBeInTheDocument();
  expect(screen.getByText("119 successful deliveries")).toBeInTheDocument();
  expect(screen.getByText(/Internal telemetry; not the Resend monthly quota/i)).toBeInTheDocument();
  expect(screen.getByText(/Daily app limit · UTC day/i)).toBeInTheDocument();
  expect(screen.getByText("5 / 90")).toBeInTheDocument();
  expect(screen.getByText(/Resend.s daily reset window is still being verified/i)).toBeInTheDocument();
  // Never claims to be the authoritative Resend period / a guaranteed provider guard.
  for (const bad of [/safety cap/i, /real guard/i, /guarantee/i]) expect(screen.queryByText(bad)).not.toBeInTheDocument();
});

test("rollback safety: a valid Stage D DOCUMENT via the listener renders Unavailable; telemetry still advances", async () => {
  await renderResolved(stageDCallable());
  await deliverSnap(stageDDoc({ internalTelemetry: { appInitiatedThisMonth: 120, appSafetyCap: 2800 } }));
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(screen.queryByText("44 / 3,000")).not.toBeInTheDocument();
  expect(screen.getByText("120 successful deliveries")).toBeInTheDocument(); // app-safety telemetry still live
});

test("Refresh does not restore provider totals (accounting disabled)", async () => {
  await renderResolved(stageDCallable());
  callFunction.mockResolvedValue({ data: stageDCallable({ monthly: { used: 45, limit: 3000, percent: 1.5 } }) });
  await act(async () => { screen.getByRole("button", { name: /refresh/i }).click(); });
  expect(screen.queryByText("45 / 3,000")).not.toBeInTheDocument();
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
});

test("a callable rejection is contained — inline error, no throw", async () => {
  callFunction.mockRejectedValue(new Error("network"));
  await act(async () => render(<EmailUsage />));
  expect(screen.getByText(/couldn't load usage just now/i)).toBeInTheDocument();
});

test("a Firestore listener error is contained — scoped status, no throw", async () => {
  await renderResolved(stageDCallable());
  await act(async () => { snapshotErrCb(new Error("permission-denied")); });
  expect(screen.getByText(/live usage updates are unavailable right now/i)).toBeInTheDocument();
});

test("the listener unsubscribes on unmount", async () => {
  const { unmount } = await renderResolved(stageDCallable());
  unmount();
  expect(unsubCount).toBe(1);
});
