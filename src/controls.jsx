/* Shared, firebase-free form-control primitives, so their real behaviour +
   accessibility can be exercised in the DOM (RTL/jsdom): a labelled switch, a
   compact switch with a full 44px target, and a password field with a reveal
   toggle. Presentation lives in named CSS classes (see styles.css), not inline
   styles, so focus-visible, reduced-motion, and enabled/disabled are all testable.
   Run: npm run test:ui (controls.ui.test.jsx) */
import { useState } from "react";
import { EyeIcon, EyeSlashIcon } from "@heroicons/react/24/outline";

/* A labelled on/off switch. The ENTIRE row is the target (≥44px tall on mobile),
   not just the track — you tap the label too. Exposes role=switch + aria-checked;
   the visible track never grows to meet the target. */
export function Toggle({ label, v, on, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!v}
      disabled={disabled}
      onClick={on}
      className={"sb-toggle" + (v ? " on" : "")}
    >
      <span className="sb-toggle-track" aria-hidden="true"><span className="sb-toggle-thumb" /></span>
      <span className="sb-toggle-label">{label}</span>
    </button>
  );
}

/* A COMPACT switch (used inline in dense rows, e.g. the reminder editor). The
   visible track stays 40×24, but the button carries a ≥44px hit area on mobile via
   padding — no pseudo-element guesswork. Always give it an accessible name. */
export function Switch({ on, onClick, ariaLabel, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!on}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={"sb-swbtn" + (on ? " on" : "")}
    >
      <span className="sb-sw" aria-hidden="true"><span /></span>
    </button>
  );
}

/* Password field with a Show/Hide reveal toggle. The reveal button is a real
   44×44 target on mobile and the input reserves right padding so text never runs
   under it; the eye glyph keeps its size. `labelAction` is an optional field
   action (e.g. "Forgot?") rendered OUTSIDE the <label> so it can't pollute the
   field's accessible name. Paste is never disabled. */
export function PasswordField({
  id, label, value, onChange, autoComplete, required = false, onEnter, labelAction, inputRef,
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="sb-field">
      <div className="sb-labelrow">
        <label htmlFor={id}>{label}{required && <span className="sb-req" aria-hidden="true">*</span>}</label>
        {labelAction}
      </div>
      <div className="sb-pwwrap">
        <input
          id={id}
          ref={inputRef}
          type={show ? "text" : "password"}
          required={required}
          autoComplete={autoComplete}
          value={value}
          onChange={onChange}
          placeholder="••••••••"
          onKeyDown={(e) => { if (e.key === "Enter" && onEnter) onEnter(); }}
        />
        <button
          type="button"
          className="sb-pwtoggle"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
        >
          {show ? <EyeSlashIcon className="hi hi-sm" aria-hidden="true" /> : <EyeIcon className="hi hi-sm" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
