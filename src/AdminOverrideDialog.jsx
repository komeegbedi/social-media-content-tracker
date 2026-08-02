import { useEffect, useRef } from "react";
import { ExclamationTriangleIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { STAGES } from "./data.js";

/* The FOCUSED "Correct workflow status" dialog (administrative override).

   Deliberately a distinct modal — NOT an inline form on the already-long content
   sheet. It only COLLECTS the correction (destination + reason); the parent runs the
   confirmation step and the audited `adminOverrideStatus` callable, so this dialog
   changes no authorization or audit behaviour. Kept free of the data layer (no
   Firebase) so its interactions are unit-testable; the caller wraps it in <Portal>,
   which makes the background inert + scroll-locked.

   The draft (to / reason) is lifted to the parent so a FAILED submit preserves it.
   A11y: role="dialog" with an accessible title + description; focus starts in the
   field, Tab is trapped within the dialog, Escape cancels, and focus is restored to
   the trigger on close. There is no form submit, so Enter never confirms. */
export default function AdminOverrideDialog({ task, to, setTo, reason, setReason, onReview, onClose }) {
  const dialogRef = useRef(null);
  const firstRef = useRef(null);
  const triggerRef = useRef(typeof document !== "undefined" ? document.activeElement : null);
  const valid = !!to && to !== task.status && !!reason.trim();

  useEffect(() => {
    firstRef.current?.focus({ preventScroll: true });
    const trigger = triggerRef.current;
    return () => { try { trigger && trigger.focus && trigger.focus(); } catch { /* trigger gone */ } };
  }, []);

  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const nodes = Array.from(dialogRef.current.querySelectorAll(
      'button,select,textarea,input,[href],[tabindex]:not([tabindex="-1"])'))
      .filter((n) => !n.disabled && n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="sb-scrim" onClick={onClose}>
      <div ref={dialogRef} className="sb-corr" role="dialog" aria-modal="true"
        aria-labelledby="sb-corr-t" aria-describedby="sb-corr-d"
        onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="sb-corr-hd">
          <span className="sb-corr-ic" aria-hidden="true"><ExclamationTriangleIcon className="hi" /></span>
          <b id="sb-corr-t" className="sb-serif">Correct workflow status</b>
          <button className="sb-x sb-corr-x" onClick={onClose} aria-label="Close"><XMarkIcon className="hi" aria-hidden="true" /></button>
        </div>
        <p id="sb-corr-d" className="sb-corr-intro">
          Use this when content is in the wrong stage or the normal workflow can't be completed.
          This bypasses the normal workflow and will be recorded as an administrative override.
        </p>
        <div className="sb-corr-cur">
          <span className="sb-corr-cur-lbl">Current status</span>
          <span className="sb-corr-cur-val">{task.status}</span>
        </div>
        <div className="sb-field">
          <label htmlFor="sb-corr-to">Move to</label>
          <select id="sb-corr-to" ref={firstRef} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Select the correct status</option>
            {STAGES.filter((s) => s !== task.status).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="sb-field">
          <label htmlFor="sb-corr-reason">Reason for correction<span className="sb-req" aria-hidden="true"> *</span></label>
          <textarea id="sb-corr-reason" className="sb-corr-reason" rows={3} maxLength={2000}
            value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="sb-corr-help"
            placeholder="Explain what happened and why this correction is needed." />
          <p id="sb-corr-help" className="sb-corr-help">Your reason will be included in the activity history and administrative audit log.</p>
        </div>
        <div className="sb-btnrow sb-corr-actions">
          <button className="sb-btn ghost" onClick={onClose}>Cancel</button>
          <button className="sb-btn gold" disabled={!valid} aria-disabled={!valid} onClick={onReview}>Review correction</button>
        </div>
      </div>
    </div>
  );
}
