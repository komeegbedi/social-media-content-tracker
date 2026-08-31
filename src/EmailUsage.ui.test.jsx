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
const TELE4 = { appInitiatedThisMonth: 114, appSafetyCap: 2800, appDailyThisDay: 5, appDailyLimit: 90 };
const v1Callable = (over = {}) => ({
  providerAvailable: true, providerUsageProven: true, model: MODEL, source: "resend-send-response",
  monthly: { used: 44, limit: 3000, percent: 1.5 }, daily: { used: 5, limit: 100, percent: 5 }, dailyReason: null,
  lastSyncedAt: iso(NOW), internalTelemetry: { ...TELE4 }, ...over,
});
const v1Doc = (over = {}) => ({
  model: MODEL, providerUsageProven: true,
  monthly: { used: 44, limit: 3000, percent: 1.5 }, daily: { used: 5, limit: 100, percent: 5 }, dailyReason: null,
  observedAt: iso(NOW), source: "resend-send-response",
  internalTelemetry: { ...TELE4 }, ...over,
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
    providerError: { code: "not-observed" }, internalTelemetry: { appInitiatedThisMonth: 0, appSafetyCap: 2800, appDailyThisDay: 0, appDailyLimit: 90 } });
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

test("a callable rejection on initial load is contained — inline error, no throw", async () => {
  callFunction.mockRejectedValue(new Error("network"));
  await act(async () => render(<EmailUsage />));
  expect(screen.getByText(/couldn.t load saved Resend usage\. Try again\./i)).toBeInTheDocument();
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

/* ---- P0/P1 hardening ---- */
test("the 'View in Resend' link points to /settings/usage", async () => {
  await renderResolved(v1Callable());
  const link = screen.getByRole("link", { name: /view in resend/i });
  expect(link.getAttribute("href")).toBe("https://resend.com/settings/usage");
});

test("never crashes on a malformed doc {used:42, limit:undefined} → Unavailable, no totals/bars", async () => {
  // Initial callable is not-observed; then a MALFORMED listener doc arrives.
  await renderResolved({ providerAvailable: false, providerUsageProven: false, monthly: null,
    providerError: { code: "not-observed" }, internalTelemetry: { ...TELE4 } });
  await deliverSnap({ model: MODEL, providerUsageProven: true, monthly: { used: 42, limit: undefined },
    daily: null, dailyReason: "not-provided", observedAt: iso(NOW + 1000), source: "resend-send-response",
    internalTelemetry: { ...TELE4 } });
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(screen.queryByText("42 / 3,000")).not.toBeInTheDocument();
  expect(screen.queryAllByRole("progressbar").length).toBe(0);
});

test("Refresh and live snapshot render IDENTICAL four-field telemetry; daily telemetry survives Refresh", async () => {
  await renderResolved(v1Callable());
  expect(screen.getByText("114 successful deliveries")).toBeInTheDocument();
  expect(screen.getByText("5 / 90")).toBeInTheDocument();               // daily app telemetry (four-field)
  // Refresh re-reads the callable (four-field telemetry) — daily row must NOT disappear.
  callFunction.mockResolvedValue({ data: v1Callable({ lastSyncedAt: iso(NOW + 120000) }) });
  await act(async () => { screen.getByRole("button", { name: /reload saved usage/i }).click(); });
  expect(screen.getByText("114 successful deliveries")).toBeInTheDocument();
  expect(screen.getByText("5 / 90")).toBeInTheDocument();               // still present after Refresh
  // A live snapshot carrying the same four-field telemetry renders the same daily value.
  await deliverSnap(v1Doc({ observedAt: iso(NOW + 180000) }));
  expect(screen.getByText("5 / 90")).toBeInTheDocument();
});

test("readability: meaningful secondary copy uses the semantic class, not inline 12px", async () => {
  await renderResolved(v1Callable());
  const stamp = screen.getByText(/Updated .* after an app email was accepted\./);
  expect(stamp.className).toContain("sb-usage-help");
  expect(stamp.getAttribute("style")).toBeNull();                       // no inline font-size override
});

/* ---- P0/P1: read-failed vs not-observed, failed refresh, deletion, source, telemetry ---- */
test("initial read failure shows a distinct message (not 'No Resend usage observed yet')", async () => {
  await renderResolved({ providerAvailable: false, providerUsageProven: false, monthly: null,
    providerError: { code: "read-failed" }, internalTelemetry: { ...TELE4 } });
  expect(screen.getByText(/Couldn’t load saved Resend usage\. Try again\.|Couldn't load saved Resend usage\. Try again\./)).toBeInTheDocument();
  expect(screen.queryByText(/No Resend usage observed yet/)).not.toBeInTheDocument();
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
});

test("a FAILED Refresh preserves the shown observation (still 'Last observed') + non-destructive warning", async () => {
  await renderResolved(v1Callable());
  expect(screen.getByText("44 / 3,000")).toBeInTheDocument();
  // Refresh now returns a transient read failure.
  callFunction.mockResolvedValue({ data: { providerAvailable: false, providerUsageProven: false, monthly: null,
    providerError: { code: "read-failed" }, internalTelemetry: { ...TELE4 } } });
  await act(async () => { screen.getByRole("button", { name: /reload saved usage/i }).click(); });
  expect(screen.getByText("44 / 3,000")).toBeInTheDocument();           // observation preserved
  expect(screen.getByText("Last observed")).toBeInTheDocument();         // not relabeled
  expect(screen.getByText(/Couldn’t refresh Resend usage just now\.|Couldn't refresh Resend usage just now\./)).toBeInTheDocument();
});

test("listener DELETION of the v1 doc transitions to not-observed (telemetry preserved)", async () => {
  await renderResolved(v1Callable());
  expect(screen.getByText("44 / 3,000")).toBeInTheDocument();
  await act(async () => { snapshotCb({ exists: () => false, data: () => undefined }); });
  expect(screen.queryByText("44 / 3,000")).not.toBeInTheDocument();
  expect(screen.getByText(/No Resend usage observed yet/)).toBeInTheDocument();
  expect(screen.getByText("114 successful deliveries")).toBeInTheDocument(); // telemetry preserved
});

test("a wrong source value fails closed to Unavailable", async () => {
  await renderResolved(v1Callable({ source: "spoofed" }));
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(screen.queryByText("44 / 3,000")).not.toBeInTheDocument();
});

test("no fabricated daily limit: incomplete telemetry hides the daily app row entirely", async () => {
  // 2-field telemetry → sanitized to null → no app rows, and NO fabricated '/ 90'.
  await renderResolved(v1Callable({ internalTelemetry: { appInitiatedThisMonth: 5, appSafetyCap: 2800 } }));
  expect(screen.queryByText(/Daily app limit · UTC day/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/\/ 90/)).not.toBeInTheDocument();
});

test("Technical details cannot crash for any malformed source / error-code type", async () => {
  // Malformed CALLABLE result: object source + object providerError.code → sanitized → safe.
  await renderResolved({ providerAvailable: true, providerUsageProven: true, model: MODEL,
    source: { evil: true }, monthly: { used: 44, limit: 3000, percent: 1.5 }, daily: null, dailyReason: "not-provided",
    lastSyncedAt: iso(NOW), internalTelemetry: { ...TELE4 }, providerError: { code: { evil: true } } });
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(screen.queryByText("44 / 3,000")).not.toBeInTheDocument();
  expect(screen.getByText("Technical details")).toBeInTheDocument();     // details block rendered, no throw
  expect(screen.getByText(/Data source:/)).toBeInTheDocument();
  // A malformed LISTENER doc (array source, object model/blocks/timestamp) must also not crash.
  await deliverSnap({ model: {}, providerUsageProven: true, source: [], monthly: { used: {}, limit: [] },
    observedAt: {}, dailyReason: {}, internalTelemetry: { ...TELE4 } });
  expect(screen.getByText("Unavailable")).toBeInTheDocument();           // still mounted
  expect(screen.queryAllByRole("progressbar").length).toBe(0);
});

/* ---- post-send feedback state machine: the false "could not be saved" fix ----
   The failure warning is driven ONLY by an authoritative server `recordError`, never by a
   timeout. Success (incl. a listener update that lands before the callback) never warns. */
const NOT_SAVED = /Email was sent, but the usage observation could not be saved/;
async function renderPanel(over = {}) {
  callFunction.mockResolvedValue({ data: { providerAvailable: false, providerUsageProven: false, monthly: null,
    providerError: { code: "not-observed" }, internalTelemetry: { ...TELE4 } } });
  let utils;
  await act(async () => { utils = render(<EmailUsage refreshToken={0} recordError={null} {...over} />); });
  return utils;
}

test("listener update arrives BEFORE the post-send callback → success, no false 'could not be saved'", async () => {
  const utils = await renderPanel();
  await deliverSnap(v1Doc());                                   // observation lands first
  expect(screen.getByText("44 / 3,000")).toBeInTheDocument();
  callFunction.mockResolvedValue({ data: v1Callable() });        // …then the send callback fires
  await act(async () => { utils.rerender(<EmailUsage refreshToken={1} recordError={null} />); });
  expect(screen.queryByText(NOT_SAVED)).not.toBeInTheDocument();
  expect(screen.getByText("Last observed")).toBeInTheDocument();
  expect(screen.getByText("44 / 3,000")).toBeInTheDocument();
});

test("success callback arrives BEFORE the listener update → success, no false warning", async () => {
  const utils = await renderPanel();
  callFunction.mockResolvedValue({ data: v1Callable() });
  await act(async () => { utils.rerender(<EmailUsage refreshToken={1} recordError={null} />); });
  await deliverSnap(v1Doc());
  expect(screen.queryByText(NOT_SAVED)).not.toBeInTheDocument();
  expect(screen.getByText("Last observed")).toBeInTheDocument();
});

test("an explicit usageRecordError DOES show the failure warning", async () => {
  const utils = await renderPanel();
  callFunction.mockResolvedValue({ data: v1Callable() });
  await act(async () => { utils.rerender(<EmailUsage refreshToken={1} recordError={"record-failed"} />); });
  expect(screen.getByText(NOT_SAVED)).toBeInTheDocument();
});

test("successful recording never shows the failure warning after any elapsed time (no timer)", async () => {
  vi.useFakeTimers();
  try {
    const utils = await renderPanel();
    callFunction.mockResolvedValue({ data: v1Callable() });
    await act(async () => { utils.rerender(<EmailUsage refreshToken={1} recordError={null} />); });
    await act(async () => { vi.advanceTimersByTime(30000); });   // 30s — nothing may invent a failure
    expect(screen.queryByText(NOT_SAVED)).not.toBeInTheDocument();
  } finally { vi.useRealTimers(); }
});

test("a callable/listener failure stays DISTINCT from a recording failure", async () => {
  const utils = await renderPanel();
  await deliverSnap(v1Doc());                                    // valid observation shown
  callFunction.mockResolvedValue({ data: { providerAvailable: false, providerUsageProven: false, monthly: null,
    providerError: { code: "read-failed" }, internalTelemetry: { ...TELE4 } } });
  await act(async () => { screen.getByRole("button", { name: /reload saved usage/i }).click(); });
  expect(screen.getByText(/Couldn.t refresh Resend usage just now/)).toBeInTheDocument();
  expect(screen.queryByText(NOT_SAVED)).not.toBeInTheDocument(); // NOT the record-failure copy
});

test("no stale attempt overwrites a newer one; unmount during a pending send is clean", async () => {
  const utils = await renderPanel();
  // Attempt 1 (success) with a DEFERRED callable, so its resolution lands AFTER attempt 2.
  let resolve1;
  callFunction.mockReturnValueOnce(new Promise((r) => { resolve1 = () => r({ data: v1Callable() }); }));
  await act(async () => { utils.rerender(<EmailUsage refreshToken={1} recordError={null} />); }); // note "updating", load pending
  callFunction.mockResolvedValue({ data: v1Callable() });
  await act(async () => { utils.rerender(<EmailUsage refreshToken={2} recordError={"record-failed"} />); }); // note "record-failed"
  expect(screen.getByText(NOT_SAVED)).toBeInTheDocument();
  await act(async () => { resolve1(); });                        // stale attempt 1 resolves late…
  expect(screen.getByText(NOT_SAVED)).toBeInTheDocument();       // …and must NOT clear the newer warning
  expect(() => utils.unmount()).not.toThrow();                   // unmount with async settled — no throw
});
