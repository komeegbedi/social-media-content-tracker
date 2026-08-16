/* Loading state for a lazy-loaded screen (e.g. the Admin chunk).

   Presentation lives entirely in the reusable `.sb-screen-loading` class (no inline
   layout styles, no hard-coded offsets) so it centers within its container — the
   content column of the app shell — as ONE inline group of spinner + label, both
   horizontally and vertically. Kept free of the data layer so it is unit-testable.

   Accessibility: role="status" + aria-live="polite" announces the loading state; the
   spinner is decorative (aria-hidden); the visible text carries the meaning. */
export default function ScreenFallback({ label = "" }) {
  return (
    <div className="sb-screen-loading" role="status" aria-live="polite">
      <span className="sb-spin" aria-hidden="true" />
      <span className="sb-screen-loading-txt">Loading{label ? ` ${label}` : ""}…</span>
    </div>
  );
}
