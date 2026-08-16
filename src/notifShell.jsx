/* The notification panel / transition SHELL — deliberately firebase-free so the
   real hand-off wiring can be exercised under jsdom (RTL) without pulling in
   Firestore. This is the P0-C surface.

   It owns the drawer chrome (a right-side <Portal> modal: scrim + grab handle +
   header with the real Settings + Close controls + drag-to-dismiss) and the
   exit-transition hand-off:

       finish(action) → mark the panel "closing" (fade) → after NOTIF_EXIT_MS run
       `action` (or onClose).

   The Settings button and the X BOTH go through finish, so the fade is never
   skipped. Crucially, when this panel is URL-backed (mounted only while
   `?panel=notifications` is present), `onSettings` must DROP that query — then
   this component unmounts and its <Portal> releases the #root inert + body
   scroll-lock naturally. That is the fix for the invisible-lock regression: the
   source overlay actually unmounts rather than being hidden.

   The data-driven body (filter chips + notification list) is supplied by the
   caller as a render function that receives { finish } so a notification tap can
   fade out before navigating: open(n) → finish(() => onNavigate(dest)). */
import { useState, useEffect, useRef } from "react";
import { Cog6ToothIcon, XMarkIcon, CheckCircleIcon } from "@heroicons/react/24/outline";
import { Portal, useSheetDrag } from "./overlay.jsx";

export const NOTIF_EXIT_MS = 180;

export function NotifPanelShell({
  onClose, onSettings, unread = 0, onMarkAllRead,
  ariaLabel = "Notifications", children,
}) {
  // Animate the drawer out before closing / navigating, so the hand-off to the
  // destination isn't a hard cut. `finish(action)` fades, then runs the action.
  const [closing, setClosing] = useState(false);
  const closeT = useRef(null);
  useEffect(() => () => clearTimeout(closeT.current), []);
  const finish = (action) => {
    if (closing) return;
    setClosing(true);
    clearTimeout(closeT.current);
    closeT.current = setTimeout(() => (action || onClose)(), NOTIF_EXIT_MS);
  };
  const drag = useSheetDrag(onClose);
  // Escape fades out too (never a hard cut, and never a second unmount path).
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") finish(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closing]); // eslint-disable-line react-hooks/exhaustive-deps
  // Background scroll-lock + inert are handled centrally by <Portal> (body fixed
  // at the current offset), so no separate overflow lock here — a second,
  // differently-managed body mutation is exactly what risks a stuck page.
  return (
    <Portal>
      <div className={"sb-scrim sb-scrim-right" + (closing ? " closing" : "")} onMouseDown={() => finish()}>
        <div className="sb-notifpanel" onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={ariaLabel} style={drag.sheetStyle}>
          <div className="sb-grab" {...drag.handleProps}><span/></div>
          <div className="sb-notifhd">
            <div className="sb-notifttl">
              <b className="sb-serif" style={{fontSize:17}}>Notifications</b>
              {unread > 0 && <span className="sb-unreadct">{unread} unread</span>}
            </div>
            <div className="sb-notifhd-actions">
              {unread > 0 && onMarkAllRead && <button className="sb-markall" onClick={onMarkAllRead}>
                <CheckCircleIcon className="hi hi-sm" aria-hidden="true"/> Mark all read</button>}
              <button className="sb-iconbtn" onClick={() => finish(onSettings)} aria-label="Notification settings"><Cog6ToothIcon className="hi" aria-hidden="true"/></button>
              <button className="sb-x" onClick={() => finish()} aria-label="Close"><XMarkIcon className="hi" aria-hidden="true" /></button>
            </div>
          </div>
          {typeof children === "function" ? children({ finish }) : children}
        </div>
      </div>
    </Portal>
  );
}
