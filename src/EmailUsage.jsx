/* Admin email-usage diagnostics. Resend reports account quota only on SEND (its
   GET /emails carries no usage), so the panel shows the LAST OBSERVED usage — captured
   from POST /emails responses on every send and cached server-side, then published to a
   sanitized adminDiagnostics/emailUsage doc IN THE SAME TRANSACTION.

   Live updates: while the panel is open it subscribes to that doc (onSnapshot) and
   applies only snapshots NEWER than what's rendered, so the totals advance automatically
   after any app send (notification, digest, test) without clicking Refresh. The admin
   callable is the initial-load + manual-recovery path. Refresh re-reads the latest
   observation — it does NOT contact Resend. The app's safety cap is shown separately and
   never as a Resend limit. Extracted from App.jsx so its states are DOM-testable. */
import { useState, useEffect, useCallback, useRef } from "react";
import { onSnapshot, doc } from "firebase/firestore";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { callFunction, db } from "./firebase";
import { presentEmailUsageDoc, normalizeCallableUsage } from "./emailUsageDoc.js";

const RESEND_DASHBOARD = "https://resend.com/emails";
const DEFAULT_TELE = { appInitiatedThisMonth: null, appSafetyCap: null };

const fmtSync = (iso) => { try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return ""; } };
const syncedMs = (u) => (u && u.lastSyncedAt ? Date.parse(u.lastSyncedAt) : NaN);
const totalsLine = (u) => {
  if (!u || !u.providerAvailable || !u.monthly) return "";
  const d = u.daily ? `, ${u.daily.used} of ${u.daily.limit} daily` : "";
  return `Resend usage: ${u.monthly.used} of ${u.monthly.limit} monthly${d}.`;
};

// One labelled usage row: value/limit on one line, a progress bar, then "% used".
export function UsageRow({ label, block, note, naLabel = "Not provided by Resend" }) {
  if (!block) return (
    <div className="sb-usagerow">
      <div className="sb-usagerow-head"><span>{label}</span><b className="sb-usagerow-na">{naLabel}</b></div>
    </div>
  );
  const pct = typeof block.percent === "number" ? block.percent : 0;
  const tone = pct >= 100 ? "crit" : pct >= 85 ? "warn" : "ok";
  return (
    <div className="sb-usagerow">
      <div className="sb-usagerow-head"><span>{label}</span><b>{block.used.toLocaleString()} / {block.limit.toLocaleString()}</b></div>
      <div className={"sb-usagebar tone-" + tone} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${label}: ${pct}% used`}>
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="sb-usagerow-foot">{pct}% used{note ? ` · ${note}` : ""}</div>
    </div>
  );
}

// refreshToken: bumped by the parent after a successful test send → deterministic re-read.
export function EmailUsage({ refreshToken = 0 }) {
  const [usage, setUsage] = useState(null);   // view model | null (loading)
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");       // "" | "updating" | "sent-not-updated"
  const usageRef = useRef(null);
  useEffect(() => { usageRef.current = usage; }, [usage]);

  // Take the newer of two view models by lastSyncedAt, preserving internalTelemetry
  // (the sanitized live doc carries no telemetry; only the callable does).
  const applyNewer = useCallback((next, keepTeleFrom) => {
    setUsage((prev) => {
      const prevMs = syncedMs(prev), nextMs = syncedMs(next);
      const tele = (next.internalTelemetry) || (keepTeleFrom && keepTeleFrom.internalTelemetry) || (prev && prev.internalTelemetry) || DEFAULT_TELE;
      if (prev && Number.isFinite(prevMs) && Number.isFinite(nextMs) && nextMs < prevMs) {
        // Older than what's shown → don't regress; keep provider, take any newer telemetry.
        return { ...prev, internalTelemetry: tele };
      }
      return { ...next, internalTelemetry: tele };
    });
  }, []);

  // Initial load + manual Refresh + post-test re-read. Reads the cache via the callable
  // (never contacts Resend). The callable result is passed through the SAME trust boundary
  // as the listener (normalizeCallableUsage → providerUsageProven===true) so an old/mixed-
  // version callable can never make the panel render unproven provider totals (e.g. 3001).
  // Snapshot ordering is handled by applyNewer.
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const { data } = await callFunction("getEmailUsage", {});
      const norm = normalizeCallableUsage(data);
      applyNewer(norm, norm);
    } catch (e) {
      setUsage((prev) => prev || { providerAvailable: false, source: "internal-fallback", monthly: null, daily: null,
        dailyReason: null, lastSyncedAt: null, stale: true, internalTelemetry: DEFAULT_TELE, providerError: { code: "call-failed" } });
    } finally { setBusy(false); }
  }, [applyNewer]);

  useEffect(() => { load().catch(() => {}); }, [load]);

  // Live subscription — only while the panel is mounted (unsubscribes on unmount). Both
  // provider-observation AND internal-telemetry writes arrive here; a read error is
  // surfaced (distinct from "waiting for usage").
  const [listenerError, setListenerError] = useState(false);
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "adminDiagnostics", "emailUsageV1"),
      (snap) => { setListenerError(false); if (snap.exists()) applyNewer(presentEmailUsageDoc(snap.data())); },
      () => { setListenerError(true); });
    return () => unsub();
  }, [applyNewer]);

  // Deterministic feedback after a successful "Send test email": show "Updating usage…"
  // and wait for EITHER provider usage OR app-safety telemetry to advance (via the live
  // listener or the callable re-read). If nothing advances within the timeout, surface an
  // actionable warning instead of a message that lingers forever. The baseline captures
  // what "advanced" means. Cleared automatically once usage moves.
  const firstToken = useRef(refreshToken);
  const testBaseline = useRef(null);
  const testTimer = useRef(null);
  useEffect(() => () => clearTimeout(testTimer.current), []);
  useEffect(() => {
    if (refreshToken === firstToken.current) return; // ignore initial mount value
    const u = usageRef.current;
    testBaseline.current = { syncedMs: syncedMs(u), appSent: (u && u.internalTelemetry && u.internalTelemetry.appInitiatedThisMonth) ?? null };
    setNote("updating");
    load().catch(() => {});
    clearTimeout(testTimer.current);
    testTimer.current = setTimeout(() => { setNote((n) => (n === "updating" ? "not-saved" : n)); }, 8000);
  }, [refreshToken, load]);

  // Clear the "updating"/"not-saved" state as soon as usage advances past the baseline.
  useEffect(() => {
    const b = testBaseline.current;
    if (!b || (note !== "updating" && note !== "not-saved")) return;
    const nowSynced = syncedMs(usage);
    const advancedProvider = Number.isFinite(nowSynced) && (!Number.isFinite(b.syncedMs) || nowSynced > b.syncedMs);
    const nowApp = usage && usage.internalTelemetry ? usage.internalTelemetry.appInitiatedThisMonth : null;
    const advancedApp = typeof nowApp === "number" && (b.appSent == null || nowApp > b.appSent);
    if (advancedProvider || advancedApp) { setNote(""); clearTimeout(testTimer.current); testBaseline.current = null; }
  }, [usage, note]);

  const tele = (usage && usage.internalTelemetry) || {};
  const appSent = tele.appInitiatedThisMonth;                       // UTC-calendar-month telemetry (NOT a provider cap)
  const appDaily = typeof tele.appDailyThisDay === "number" ? tele.appDailyThisDay : null;
  const appDailyLimit = tele.appDailyLimit || 90;                   // the REAL enforced daily guard
  const synced = usage && usage.lastSyncedAt ? fmtSync(usage.lastSyncedAt) : null;

  const errCode = usage && usage.providerError && usage.providerError.code;
  const invalid = errCode === "invalid-provider-observation" || errCode === "provider-usage-unverified";
  const badge = !usage ? null
    : usage.providerAvailable ? { label: "Last observed", cls: "ok" } // visible text, not color-only
    : invalid ? { label: "Unavailable", cls: "err" }                 // never green, never a 100% bar
    : { label: "Not observed yet", cls: "warn" };

  return (
    <section className="sb-emailusage" aria-label="Email usage">
      <div className="sb-usage-hd">
        <span className="sb-mlabel" style={{ margin: 0 }}>Email usage</span>
        <a className="sb-usage-extlink" href={RESEND_DASHBOARD} target="_blank" rel="noopener noreferrer">
          View in Resend <ArrowTopRightOnSquareIcon className="hi hi-sm" aria-hidden="true" />
        </a>
      </div>

      {/* Polite live announcement of the current totals (updates automatically on send). */}
      <div className="sb-visually-hidden" aria-live="polite">{totalsLine(usage)}</div>

      {usage === null ? (
        <div className="sb-sub" style={{ fontSize: 12 }} aria-live="polite">Loading email usage…</div>
      ) : (
        <>
          {badge && (
            <div className="sb-usage-badgerow">
              <span className="sb-mlabel" style={{ margin: 0, fontWeight: 600 }}>Resend account usage</span>
              <span className={"sb-usage-badge " + badge.cls}>{badge.label}</span>
            </div>
          )}

          {usage.providerAvailable ? (
            <div className="sb-usage-live">
              <UsageRow label="Monthly usage" block={usage.monthly} />
              {/* Daily row is ALWAYS shown — a valid block, or an explicit reason (never hidden). */}
              {usage.daily ? (
                <UsageRow label="Daily usage" block={usage.daily} />
              ) : (
                <div className="sb-usagerow">
                  <div className="sb-usagerow-head"><span>Daily usage</span><b className="sb-usagerow-na">Not provided</b></div>
                  <div className="sb-usagerow-foot">
                    {usage.dailyReason === "invalid"
                      ? "Daily usage was unavailable for this observation."
                      : "Resend did not provide a daily counter for this send."}
                  </div>
                </div>
              )}
              <div className="sb-usage-note" role="note">
                Resend updates here after this app sends an email. Other Resend activity appears after the next app send.
              </div>
            </div>
          ) : (
            <div className="sb-usage-note" role="status">
              {(() => {
                const code = usage.providerError && usage.providerError.code;
                if (code === "call-failed") return "Couldn't load usage just now. Try again.";
                if (code === "provider-usage-unverified") return "Resend account usage couldn't be verified; an unrecognized reading was ignored. App safety usage below is unaffected.";
                if (code === "invalid-provider-observation") return "Resend account usage couldn't be verified (an invalid reading was ignored). App safety usage below is unaffected.";
                return "No Resend usage observed yet. Send an email through this app to load it.";
              })()}
            </div>
          )}

          {note === "updating" && <div className="sb-sub" style={{ fontSize: 12 }} aria-live="polite">Updating usage…</div>}
          {note === "not-saved" && <div className="sb-usage-quiet" role="status">Email was sent, but the usage observation could not be saved. Check function logs.</div>}
          {listenerError && note !== "not-saved" && <div className="sb-usage-quiet" role="status">Live usage updates are unavailable right now (check your admin access). Use Refresh to re-read.</div>}

          {/* The app's OWN safety cap — clearly separate from the Resend account limit. */}
          {/* Internal app telemetry — NOT the Resend monthly quota. The monthly count is
              scoped to the UTC CALENDAR MONTH, which is not aligned with Resend's (unknown)
              provider reset boundary, so it is telemetry only, never a provider safety cap.
              The daily app limit below is UTC-day scoped; Resend's daily reset window is
              still unverified, so it is internal enforcement, not a guaranteed provider guard. */}
          <div className="sb-usagerow">
            <div className="sb-usagerow-head"><span>App email activity · UTC calendar month</span>
              <b>{appSent == null ? "—" : `${appSent.toLocaleString()} successful deliveries`}</b></div>
            <div className="sb-usagerow-foot">Internal telemetry; not the Resend monthly quota.</div>
          </div>
          {appDaily != null && (
            <div className="sb-usagerow">
              <div className="sb-usagerow-head"><span>Daily app limit · UTC day</span><b>{appDaily.toLocaleString()} / {appDailyLimit.toLocaleString()}</b></div>
              <div className="sb-usagerow-foot">Internal enforcement. Resend’s daily reset window is still being verified.</div>
            </div>
          )}

          <div className="sb-usage-foot">
            <span className="sb-sub" style={{ fontSize: 12 }}>
              {usage.providerAvailable && synced ? `Updated ${synced} after an app email was accepted.` : ""}
            </span>
            <button type="button" className="sb-usage-refresh" onClick={() => load()} disabled={busy}
              aria-label="Reload saved usage" title="Reload saved usage">
              {busy ? "Refreshing…" : "Refresh"}</button>
          </div>

          <details className="sb-usage-tech">
            <summary>Technical details</summary>
            <div className="sb-sub" style={{ fontSize: 12 }}>
              App-initiated sends this month (this app only): <b>{appSent == null ? "—" : appSent.toLocaleString()}</b><br />
              Resend reports account usage only on SEND, so this advances when THIS app sends email
              (notifications, digests, test emails). Out-of-band Resend activity is reflected on the
              next successful app send. Refresh re-reads the latest observation and does not contact Resend.<br />
              {!usage.providerAvailable && synced ? <>Historical unverified observation: <b>{synced}</b>. Not shown as current usage.<br /></> : null}
              Data source: <b>{usage.source}</b>{usage.providerError ? <> · {usage.providerError.code}</> : null}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
