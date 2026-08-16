import { useEffect, useRef, useState } from "react";
import { XMarkIcon, CheckCircleIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";

/* The global save/undo toast. Owns its OWN auto-dismiss timers so the pause/resume
   behavior is wired to the rendered element (not orphaned helpers on the parent):

   - "pending" kind never auto-dismisses (it's replaced by a result).
   - "ok"/"err" auto-dismiss after a hold — longer when there's an action to click.
   - Hover OR keyboard focus PAUSES the countdown so an Undo is never snatched away;
     leaving (pointer out / focus out of the WHOLE banner) resumes with a fresh,
     generous window. Focus moving between Undo and Dismiss stays inside the banner,
     so it does NOT restart the timer.
   - Both timers are cleared on unmount and whenever the banner changes, so a stale
     leave-timer can never dismiss a newer banner.
   - Closing (Dismiss or Undo) never affects the underlying operation. */
const HOLD_ACTION = 6000;
const HOLD_PLAIN = 4300;
const RESUME_MIN = 3000;
const LEAVE_MS = 220;   // matches the CSS fade-out

export function SaveBanner({ banner, onClose }) {
  const dismissT = useRef(null);
  const leaveT = useRef(null);
  const holdRef = useRef(HOLD_PLAIN);
  const [leaving, setLeaving] = useState(false);

  const clearTimers = () => { clearTimeout(dismissT.current); clearTimeout(leaveT.current); };
  const startDismiss = (delay) => {
    clearTimeout(dismissT.current);
    dismissT.current = setTimeout(() => {
      setLeaving(true);
      leaveT.current = setTimeout(() => onClose(), LEAVE_MS);
    }, delay);
  };

  // (Re)arm the countdown whenever a new banner arrives. Pending banners never
  // auto-dismiss. Cleanup runs on every change + unmount, so timers never leak.
  const key = banner ? `${banner.kind}|${banner.msg}|${banner.action ? banner.action.label : ""}` : null;
  useEffect(() => {
    clearTimers();
    setLeaving(false);
    if (!banner || banner.kind === "pending") return clearTimers;
    holdRef.current = banner.action ? HOLD_ACTION : HOLD_PLAIN;
    startDismiss(holdRef.current);
    return clearTimers;
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!banner) return null;

  const pause = () => clearTimers();                 // hover / focus enters
  const resume = () => { if (!leaving && banner.kind !== "pending") startDismiss(Math.max(RESUME_MIN, holdRef.current)); };
  const onBlurBanner = (e) => {
    // Only resume when focus actually left the banner — moving between Undo and
    // Dismiss keeps focus inside, so the countdown must NOT restart.
    if (!e.currentTarget.contains(e.relatedTarget)) resume();
  };

  return (
    <div className={"sb-savebanner " + banner.kind + (leaving ? " leaving" : "")}
      role="status" aria-live="polite"
      onMouseEnter={pause} onMouseLeave={resume}
      onFocus={pause} onBlur={onBlurBanner}>
      {banner.kind === "pending"
        ? <span className="sb-banner-spin" aria-hidden="true" />
        : banner.kind === "err"
        ? <ExclamationTriangleIcon className="hi hi-sm" aria-hidden="true" />
        : <CheckCircleIcon className="hi hi-sm" aria-hidden="true" />}
      <span className="sb-banner-msg">{banner.msg}</span>
      {banner.action && <button className="sb-banner-action"
        onClick={() => { const a = banner.action; onClose(); a.onClick(); }}>{banner.action.label}</button>}
      {banner.kind !== "pending" && <button className="sb-x" onClick={onClose} aria-label="Dismiss">
        <XMarkIcon className="hi" aria-hidden="true" /></button>}
    </div>
  );
}
