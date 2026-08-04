import { useEffect, useRef, useState } from "react";
import { ExclamationTriangleIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { STAGES } from "./data.js";

const NO_OP_MESSAGE = "Choose a status different from the current status.";

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
export default function AdminOverrideDialog({ task, to, setTo, reason, setReason, requestedChanges, setRequestedChanges, onReview, onClose }) {
  const dialogRef = useRef(null);
  const firstRef = useRef(null);
  const triggerRef = useRef(typeof document !== "undefined" ? document.activeElement : null);
  // Sending content back for revision needs actionable instructions for the owner
  // (requestedChanges) IN ADDITION to the administrative audit reason.
  const [noopError, setNoopError] = useState("");
  const needsRevision = to === "Changes Requested";
  // A destination MUST differ from the (canonical, stored) current task status.
  const valid = !!to && to !== task.status && !!reason.trim()
    && (!needsRevision || !!(requestedChanges || "").trim());

  useEffect(() => {
    firstRef.current?.focus({ preventScroll: true });
    const trigger = triggerRef.current;
    return () => { try { trigger && trigger.focus && trigger.focus(); } catch { /* trigger gone */ } };
  }, []);

  // Concurrency: if the task's current status changes (another user/process) to
  // match the selected destination, clear the now-stale selection and prompt again.
  useEffect(() => {
    if (to && to === task.status) { setTo(""); setNoopError(NO_OP_MESSAGE); }
  }, [task.status, to]);

  // Defensive: the current status is excluded from the selector, but never let a
  // stale/equal destination open the confirmation.
  const review = () => {
    if (!to || to === task.status) { setNoopError(NO_OP_MESSAGE); return; }
    if (!valid) return;
    setNoopError("");
    onReview();
  };

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
          <select id="sb-corr-to" ref={firstRef} value={to}
            onChange={(e) => { setTo(e.target.value); setNoopError(""); }}
            aria-describedby={noopError ? "sb-corr-noop" : undefined}>
            <option value="">Select the correct status</option>
            {STAGES.filter((s) => s !== task.status).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {noopError && <p id="sb-corr-noop" className="sb-lerr" role="alert" style={{ marginTop: 8, marginBottom: 0 }}>{noopError}</p>}
        </div>
        {needsRevision && (
          <div className="sb-field">
            <label htmlFor="sb-corr-rc">What needs to change?<span className="sb-req" aria-hidden="true"> *</span></label>
            <textarea id="sb-corr-rc" className="sb-corr-reason" rows={3} maxLength={2000}
              value={requestedChanges || ""} onChange={(e) => setRequestedChanges(e.target.value)} aria-describedby="sb-corr-rc-help"
              placeholder="For example: Shorten the opening to three seconds and replace the final title card." />
            <p id="sb-corr-rc-help" className="sb-corr-help">Give the content owner clear, actionable instructions for the revision.</p>
          </div>
        )}
        <div className="sb-field">
          <label htmlFor="sb-corr-reason">Reason for administrative override<span className="sb-req" aria-hidden="true"> *</span></label>
          <textarea id="sb-corr-reason" className="sb-corr-reason" rows={3} maxLength={2000}
            value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="sb-corr-help"
            placeholder="Why is this correction being made outside the normal QA review process?" />
          <p id="sb-corr-help" className="sb-corr-help">Explain why this correction is being made outside the normal QA review process. This is recorded in the administrative audit log.</p>
        </div>
        <div className="sb-btnrow sb-corr-actions">
          <button className="sb-btn ghost" onClick={onClose}>Cancel</button>
          <button className="sb-btn gold" disabled={!valid} aria-disabled={!valid} onClick={review}>Review correction</button>
        </div>
      </div>
    </div>
  );
}
