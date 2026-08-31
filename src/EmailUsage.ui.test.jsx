/* EmailUsage (rendered) — DISPLAY-ONLY v1 build. A proven v1 observation renders
   "Last observed" totals and auto-updates via the emailUsageV1 listener without Refresh.
   Unknown/unproven data fails closed to Unavailable; app-safety telemetry stays visible
   and live. Refresh only re-reads stored state. Run: npm run test:ui */
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const callFunction = vi.fn();
let snapshotCb = null, snapshotErrCb = null, unsubCount = 0;
const onSnapshot = vi.fn((_ref, next, err) => { snapshotCb = next; snapshotErrCb = err; return () => { unsubCount++; }; });
vi.mock("./firebase", () => ({ callFunction: (...a) => callFunction(...a), db: {} }));
vi.mock("firebase/firestore", () => ({ onSnapshot: (...a) => onSnapshot(...a), doc: () => ({}) }));

const { EmailUsage } = await import("./EmailUsage.jsx");
const MODEL = "resend-pre-send-used-v1";
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// A fully-valid v1 callable result (getEmailUsage) and listener document.
const v1Callable = (over = {}) => ({
  providerAvailable: true, providerUsageProven: true, model: MODEL, source: "resend-send-response",
  monthly: { used: 44, limit: 3000, percent: 1.5 }, daily: { used: 5, limit: 100, percent: 5 }, dailyReason: null,
  lastSyncedAt: iso(NOW), internalTelemetry: { appInitiatedThisMonth: 114, appSafetyCap: 2800 }, ...over,
});
const v1Doc = (over = {}) => ({
  model: MODEL, providerUsageProven: true,
  monthly: { used: 44, limit: 3000, percent: 1.5 }, daily: { used: 5, limit: 100, percent: 5 }, dailyReason: null,
  observedAt: iso(NOW), source: "resend-send-response",
  internalTelemetry: { appInitiatedThisMonth: 114, appSafetyCap: 2800 }, ...over,
});
const deliverSnap = async (data) => { await act(async () => { snapshotCb({ exists: () => true, data: () => data }); }); };
async function renderResolved(data) { callFunction.mockResolvedValue({ data }); return act(async () => render(<EmailUsage />)); }

beforeEach(() => { callFunction.mockReset(); onSnapshot.mockClear(); snapshotCb = null; snapshotErrCb = null; unsubCount = 0; });

test("a proven v1 callable renders 'Last observed' totals + timestamp + app-safety", async () => {
  await renderResolved(v1Callable());
  expect(screen.getByText("Resend account usage")).toBeInTheDocument();
  expect(screen.getByText("Last observed")).toBeInTheDocument();
  expect(screen.getByText("44 / 3,000")).toBeInTheDocument();
  expect(screen.getByText("5 / 100")).toBeInTheDocument();
  expect(screen.getByText(/Updated .* after an app email was accepted\./)).toBeInTheDocument();
  expect(screen.getByText(/Resend updates here after this app sends an email\./)).toBeInTheDocument();
  expect(screen.getByText("114 successful deliveries")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /view in resend/i })).toBeInTheDocument();
});

test("live auto-update: a newer emailUsageV1 snapshot advances totals WITHOUT Refresh", async () => {
  await renderResolved(v1Callable());
  expect(screen.getByText("44 / 3,000")).toBeInTheDocument();
  await deliverSnap(v1Doc({ monthly: { used: 60, limit: 3000, percent: 2 }, observedAt: iso(NOW + 60000) }));
  expect(screen.getByText("60 / 3,000")).toBeInTheDocument();
  expect(screen.queryByText("44 / 3,000")).not.toBeInTheDocument();
});

test("daily NOT provided → the daily row is retained with an explicit reason (never hidden)", async () => {
  await renderResolved(v1Callable({ daily: null, dailyReason: "not-provided" }));
  expect(screen.getByText("Daily usage")).toBeInTheDocument();
  expect(screen.getByText("Not provided")).toBeInTheDocument();
  expect(screen.getByText(/Resend did not provide a daily counter for this send\./)).toBeInTheDocument();
});

test("daily INVALID → explicit invalid copy (not collapsed to not-provided)", async () => {
  await renderResolved(v1Callable({ daily: null, dailyReason: "invalid" }));
  expect(screen.getByText("Daily usage")).toBeInTheDocument();
  expect(screen.getByText(/Daily usage was unavailable for this observation\./)).toBeInTheDocument();
});

test("no observation yet → 'No Resend usage observed yet'; app-safety still shown", async () => {
  await renderResolved({ providerAvailable: false, providerUsageProven: false, monthly: null,
    providerError: { code: "not-observed" }, internalTelemetry: { appInitiatedThisMonth: 0, appSafetyCap: 2800 } });
  expect(screen.getByText(/No Resend usage observed yet/)).toBeInTheDocument();
  expect(screen.queryByText("Last observed")).not.toBeInTheDocument();
  expect(screen.getByText(/successful deliveries/)).toBeInTheDocument();
});

test("unknown/unproven model fails closed to Unavailable (no totals)", async () => {
  await renderResolved(v1Callable({ model: "resend-future-v2" }));
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(screen.queryByText("44 / 3,000")).not.toBeInTheDocument();
  expect(screen.queryAllByRole("progressbar").length).toBe(0);
});

test("app telemetry keeps its explicit UTC labels, separate from provider usage", async () => {
  await renderResolved(v1Callable({ internalTelemetry: { appInitiatedThisMonth: 119, appSafetyCap: 2800, appDailyThisDay: 5, appDailyLimit: 90 } }));
  expect(screen.getByText(/App email activity · UTC calendar month/i)).toBeInTheDocument();
  expect(screen.getByText("119 successful deliveries")).toBeInTheDocument();
  expect(screen.getByText(/Daily app limit · UTC day/i)).toBeInTheDocument();
  expect(screen.getByText("5 / 90")).toBeInTheDocument();
});

test("Refresh re-reads stored state ('Reload saved usage'); never claims to contact Resend", async () => {
  await renderResolved(v1Callable());
  const btn = screen.getByRole("button", { name: /reload saved usage/i });
  expect(btn).toBeInTheDocument();
  expect(btn.getAttribute("title")).toBe("Reload saved usage");
  callFunction.mockResolvedValue({ data: v1Callable({ monthly: { used: 70, limit: 3000, percent: 2.3 }, lastSyncedAt: iso(NOW + 120000) }) });
  await act(async () => { btn.click(); });
  expect(callFunction).toHaveBeenCalledWith("getEmailUsage", {});
  expect(screen.getByText("70 / 3,000")).toBeInTheDocument();
});

test("no forbidden internal fields are ever in the DOM", async () => {
  await renderResolved(v1Callable());
  for (const bad of [/monthlyUsedBeforeSend/i, /acceptedUnits/i, /deliveryId/i, /idempotency/i, /Bearer /i, /@example\.com/i]) {
    expect(screen.queryByText(bad)).not.toBeInTheDocument();
  }
});

test("a callable rejection is contained — inline error, no throw", async () => {
  callFunction.mockRejectedValue(new Error("network"));
  await act(async () => render(<EmailUsage />));
  expect(screen.getByText(/couldn't load usage just now/i)).toBeInTheDocument();
});

test("a Firestore listener error is contained — scoped status, no throw", async () => {
  await renderResolved(v1Callable());
  await act(async () => { snapshotErrCb(new Error("permission-denied")); });
  expect(screen.getByText(/live usage updates are unavailable right now/i)).toBeInTheDocument();
});

test("the listener unsubscribes on unmount", async () => {
  const { unmount } = await renderResolved(v1Callable());
  unmount();
  expect(unsubCount).toBe(1);
});
