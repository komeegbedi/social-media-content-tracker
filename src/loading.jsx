/* Loading-state primitives — ONE component per genuine async pattern, kept
   firebase-free so they're unit-testable and shared across App.jsx + AdminScreen.

   The six patterns and where each lives:
     1. screen / route fallback ....... ScreenFallback.jsx (Suspense fallback)
     2. content skeleton .............. Skeleton (final shape known)
     3. inline spinner ................ Spinner (compact controls)
     4. stable-width button busy ...... BusyButton
     5. determinate progress .......... Progress (total known → "12 of 48")
     6. background op, non-blocking ... existing withFeedback toast (App.jsx)

   None of these introduce a fake delay — they reflect real pending work only. */
import { forwardRef } from "react";

/* (3) Inline spinner for a compact control or a small pending region. Decorative
   by default (a sibling label carries the meaning); pass `label` to have it
   announce itself as a status. Under reduced motion the shared `.sb-spin-inline`
   rule swaps the animation for a static ring (see styles.css). */
export function Spinner({ size = 16, className = "", label }) {
  return (
    <span
      className={"sb-spin-inline " + className}
      style={{ width: size, height: size }}
      role={label ? "status" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : "true"}
    />
  );
}

/* (4) A button whose width never changes when it becomes busy and which never
   collapses into an unexplained icon. While busy it:
     • keeps the resting label in the accessibility tree (opacity, not display),
       so screen readers still hear the action;
     • also mirrors that action into aria-label + sets aria-busy=true;
     • is disabled, preventing repeat submission;
     • shows a visible spinner + short busy word (never icon-only).
   Error recovery is the caller's job: set busy back to false and the original
   control is restored exactly as it was. */
export const BusyButton = forwardRef(function BusyButton(
  { busy = false, busyLabel, children, className = "sb-btn", disabled,
    actionLabel, "aria-label": ariaLabel, ...rest },
  ref
) {
  const restingLabel = actionLabel || (typeof children === "string" ? children : ariaLabel);
  return (
    <button
      ref={ref}
      className={className + " sb-busybtn" + (busy ? " is-busy" : "")}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      aria-label={busy ? restingLabel : ariaLabel}
      {...rest}
    >
      <span className="sb-busybtn-label">{children}</span>
      {busy && (
        <span className="sb-busybtn-busy" aria-hidden="true">
          <span className="sb-spin-inline" style={{ width: 15, height: 15 }} />
          {busyLabel ? <span>{busyLabel}</span> : null}
        </span>
      )}
    </button>
  );
});

/* (5) Determinate progress for work whose total is known up front (bulk import).
   Real progressbar semantics: role=progressbar with aria-valuemin/max/now and a
   human aria-valuetext, plus VISIBLE progress text ("Importing 12 of 48") and an
   optional failure count. `tone` colours the fill on completion/failure. */
export function Progress({ value = 0, max = 0, label, note, tone = "" }) {
  // Clamp so aria-valuenow / the fill can never exceed max, even if a caller
  // over-reports (e.g. done+failed drifting past total).
  const safeMax = Math.max(0, max);
  const clamped = Math.min(Math.max(0, value), safeMax || value);
  const pct = safeMax > 0 ? Math.min(100, Math.round((clamped / safeMax) * 100)) : 0;
  return (
    <div className={"sb-loadprogress" + (tone ? " " + tone : "")}>
      <div className="sb-loadprogress-head">
        <span className="sb-loadprogress-label">{label}</span>
        {note ? <span className="sb-loadprogress-note">{note}</span> : null}
      </div>
      <div
        className="sb-loadprogress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={clamped}
        aria-valuetext={label}
      >
        <div className="sb-loadprogress-fill" style={{ width: pct + "%" }} />
      </div>
    </div>
  );
}

/* (2) Content skeleton for when the FINAL shape is known (list rows, cards). Pure
   presentation; `aria-hidden` because the surrounding region already announces
   "loading" via role=status. Shimmer is disabled under reduced motion in CSS. */
export function Skeleton({ lines = 3, className = "" }) {
  return (
    <div className={"sb-skel " + className} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} className="sb-skel-line" />
      ))}
    </div>
  );
}
