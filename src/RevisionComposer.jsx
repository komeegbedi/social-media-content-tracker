import { useState, useEffect, useRef } from "react";
import { REVISION_MAX, clampRevision, canSendRevision, revisionCharState, hasUnsentRevision } from "./data.js";

/* QA "Request changes" revision composer.

   Deliberately self-contained (no Firebase) so its interactions can be unit-tested:
   it owns the draft text + the send lifecycle and reports dirtiness / in-flight
   state UP so the parent can gate competing actions (Approve, close, navigation).
   The parent owns the route guard and the discard/approve confirmations.

   Contract:
   - onSend(note)  -> Promise. Resolve = sent (draft clears, onSent fires);
                      reject  = failed (draft is KEPT, inline error shown).
   - onSent()          fired after a successful send (parent collapses the panel).
   - onDirtyChange(b)  the draft has unsent, non-whitespace content.
   - onSendingChange(b) a request is in flight (parent disables Approve etc.). */
export default function RevisionComposer({ onSend, onSent, onDirtyChange, onSendingChange }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef(null);

  useEffect(() => { if (onDirtyChange) onDirtyChange(hasUnsentRevision(text)); }, [text]);
  useEffect(() => { if (onSendingChange) onSendingChange(sending); }, [sending]);

  // Reveal: move focus into the field and scroll it clear of the iOS keyboard.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = typeof window !== "undefined" && window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => {
      grow(el);
      el.focus({ preventScroll: true });
      if (el.scrollIntoView) el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    }, 60);   // let the panel expand before measuring/scrolling
    return () => clearTimeout(t);
  }, []);

  // Grow with content up to the CSS max-height, then it scrolls internally.
  // (iOS Safari has no reliable CSS auto-size.)
  const grow = (el) => { if (!el) return; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; };

  const cc = revisionCharState(text);
  const canSend = canSendRevision(text, { sending });

  const submit = async () => {
    if (!canSend || !onSend) return;                 // blank / whitespace / over-limit / in-flight
    setSending(true);
    setError("");
    try {
      await onSend(text.trim());
      setText("");                                   // clear ONLY on success
      if (onSent) onSent();
    } catch {
      setError("Couldn't send the request — check your connection and try again."); // draft KEPT
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="sb-rvc">
      <label className="sb-rvc-label" htmlFor="sb-rvc-note">What needs to change?</label>
      <p className="sb-rvc-help" id="sb-rvc-help">Be specific about what should be revised and why.</p>
      {/* Real multiline field. Return inserts a newline (no submit-on-Enter).
          16px text avoids iOS auto-zoom; grows to a CSS max then scrolls. */}
      <textarea
        id="sb-rvc-note" ref={ref} className="sb-rvc-ta"
        value={text} rows={5} maxLength={REVISION_MAX} disabled={sending}
        aria-describedby={"sb-rvc-help" + (error ? " sb-rvc-err" : "")}
        aria-invalid={error ? true : undefined}
        placeholder="e.g. The hook is too long — tighten the first line and swap the second image."
        onChange={(e) => { setText(clampRevision(e.target.value)); grow(e.target); }}
      />
      <div className="sb-rvc-foot">
        {cc.nearLimit
          ? <span className={"sb-rvc-count" + (cc.remaining <= 0 ? " over" : "")} aria-live="polite">{cc.remaining} left</span>
          : <span />}
      </div>
      {error && <div className="sb-rvc-err" id="sb-rvc-err" role="alert">{error}</div>}
      <button
        type="button" className="sb-btn sb-rvc-send"
        disabled={!canSend} aria-disabled={!canSend}
        onClick={submit}
      >
        {sending ? "Sending…" : "Send revision request"}
      </button>
    </div>
  );
}
