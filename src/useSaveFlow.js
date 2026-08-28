/* A small save-state machine for a modal "Save then auto-close" flow, factored out of
   the notification-settings dialog so its race-safety is unit-testable in the DOM.

   Guarantees:
     • `locked` is true from the instant a save STARTS through the brief "saved"
       auto-close window — callers disable their controls on it so a value can't change
       after the snapshot was captured (or after success, before close) and be lost.
     • duplicate submissions are ignored while a save is in flight (an in-flight ref,
       not stale state, so rapid double-clicks can't both fire).
     • the auto-close timer is cleared on unmount and no state is set after unmount.
     • BOTH failure paths — onSave() returning false AND onSave() throwing / rejecting —
       land on "error": controls unlock, selections stay intact, the dialog stays open.
     • StrictMode-safe: `mounted` is (re)set to true in the effect SETUP, so the
       dev-mode setup→cleanup→setup remount can't leave the hook marked unmounted (which
       would strand a completed save on "Saving…"). */
import { useState, useRef, useEffect, useCallback } from "react";
import { logIssue } from "./logging";

export function useSaveFlow(onSave, onClose, closeDelay = 650) {
  const [saveState, setSaveState] = useState(""); // "" | "saving" | "saved" | "error"
  const mounted = useRef(true);
  const closeTimer = useRef(null);
  const inFlight = useRef(false);

  const clearCloseTimer = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };

  useEffect(() => {
    // Set on SETUP (not just at ref creation) so StrictMode's setup→cleanup→setup
    // cycle restores `mounted` after the first cleanup flipped it false.
    mounted.current = true;
    return () => { mounted.current = false; clearCloseTimer(); };
  }, []);

  const locked = saveState === "saving" || saveState === "saved";

  const save = useCallback(async (payload) => {
    if (inFlight.current) return;               // guard against duplicate submissions
    inFlight.current = true;
    clearCloseTimer();                          // a prior success's timer must not close this retry
    setSaveState("saving");
    let ok = false;
    try {
      ok = await onSave(payload);               // may return false...
    } catch (e) {                               // ...or throw / reject — both are failures
      ok = false;
      // A thrown/rejected save is unexpected — record it (best-effort, never throws).
      logIssue({ kind: "error", action: "save flow: onSave rejected", message: (e && e.message) || String(e), stack: (e && e.stack) || "" });
    } finally {
      inFlight.current = false;                 // reset in EVERY path (success/false/throw)
    }
    if (!mounted.current) return;               // unmounted mid-save → no state, no timer
    if (!ok) { setSaveState("error"); return; } // selections stay intact; controls unlock
    setSaveState("saved");
    closeTimer.current = setTimeout(() => { if (mounted.current) onClose(); }, closeDelay);
  }, [onSave, onClose, closeDelay]);

  return { saveState, locked, save };
}
