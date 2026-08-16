/* Profile menu — extracted firebase-free so its close behaviour + lock lifecycle
   can be exercised in the DOM. Desktop = a non-modal anchored popover (background
   stays live, no aria-modal/trap); mobile = a modal bottom sheet.

   It now has an EXPLICIT Close control in a STICKY header, so on a short/landscape
   viewport (where the menu scrolls internally) the close stays reachable and never
   scrolls off-screen. Drag-to-dismiss + scrim + Escape remain as enhancements.
   App-level values (appearance label/icon, "what's new" freshness, sign-out) are
   passed in as props so this file needs no firebase. */
import { useEffect, useRef } from "react";
import {
  XMarkIcon, UserGroupIcon, Cog6ToothIcon, BellAlertIcon, LightBulbIcon,
  ExclamationTriangleIcon, BellIcon, ArrowRightStartOnRectangleIcon, SparklesIcon,
} from "@heroicons/react/24/outline";
import { Portal, useSheetDrag, useMediaQuery } from "./overlay.jsx";
import { initials } from "./data.js";

export function ProfileDrawer({
  me, isAdmin, unread = 0, pendingCount = 0,
  appearanceLabel, PrefIcon, whatsNewIsNew = false,
  onClose, onSignOut, onNotifications, onNotifPrefs, onWhatsNew,
  onFeatureRequest, onReport, onAppearance, onGoTab,
}) {
  const drag = useSheetDrag(onClose);
  const isDesktop = useMediaQuery("(min-width:900px)");
  const drawerRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal modal={!isDesktop}>
    <div className="sb-scrim sb-scrim-anchored" onMouseDown={onClose}>
      <div ref={drawerRef} className="sb-drawer" onMouseDown={e=>e.stopPropagation()} style={drag.sheetStyle}
        role="dialog" aria-modal={isDesktop ? undefined : "true"} aria-label="Profile menu">
        {/* Sticky header: drag handle (enhancement) + an explicit Close control
            that stays put while the menu body scrolls. The close never overlaps
            the user identity block below it. */}
        <div className="sb-drawer-hd">
          <div className="sb-grab" {...drag.handleProps}><span/></div>
          <button type="button" className="sb-drawer-close" onClick={onClose} aria-label="Close profile menu">
            <XMarkIcon className="hi" aria-hidden="true" />
          </button>
        </div>
        <div className="sb-drawer-user">
          <span className="sb-av" style={{width:46,height:46,fontSize:16}}>{initials(me.name)}</span>
          <div style={{minWidth:0}}>
            <div className="nm"><bdi>{me.name}</bdi></div>
            <div className="rl">{isAdmin?"Admin":"Member"} · <bdi>{me.email}</bdi></div>
          </div>
        </div>
        {onGoTab && <button className="sb-drawer-item" onClick={()=>onGoTab("team")}>
          <span className="i"><UserGroupIcon className="hi" aria-hidden="true"/></span>Team
        </button>}
        {onGoTab && isAdmin && <button className="sb-drawer-item" onClick={()=>onGoTab("admin")}>
          <span className="i"><Cog6ToothIcon className="hi" aria-hidden="true"/></span>Admin
          {pendingCount>0 && <span className="sb-drawer-state">{pendingCount}</span>}
        </button>}
        {onNotifPrefs && <button className="sb-drawer-item" onClick={onNotifPrefs}>
          <span className="i"><BellAlertIcon className="hi" aria-hidden="true"/></span>Notification preferences
        </button>}
        {onWhatsNew && <button className="sb-drawer-item" onClick={onWhatsNew}>
          <span className="i"><SparklesIcon className="hi" aria-hidden="true"/></span>What's new
          {whatsNewIsNew && <span className="sb-newbadge">New</span>}
        </button>}
        {onFeatureRequest && <button className="sb-drawer-item" onClick={onFeatureRequest}>
          <span className="i"><LightBulbIcon className="hi" aria-hidden="true"/></span>Submit feature request
        </button>}
        <button className="sb-drawer-item" onClick={onAppearance}>
          <span className="i"><PrefIcon className="hi" aria-hidden="true"/></span>Appearance
          <span className="sb-drawer-state">{appearanceLabel}</span>
        </button>
        <button className="sb-drawer-item" onClick={onNotifications}>
          <span className="i"><BellIcon className="hi" aria-hidden="true"/></span>Notifications
          {unread>0 && <span className="sb-drawer-state">{unread>9?"9+":unread}</span>}
        </button>
        <button className="sb-drawer-item" onClick={onReport}>
          <span className="i"><ExclamationTriangleIcon className="hi" aria-hidden="true"/></span>Report an issue
        </button>
        <button className="sb-drawer-item danger" onClick={onSignOut}>
          <span className="i"><ArrowRightStartOnRectangleIcon className="hi" aria-hidden="true"/></span>Sign out
        </button>
        <div className="sb-brandfoot"><b>IFC Creatives Board</b>Built for the IFC Creative Team.</div>
      </div>
    </div>
    </Portal>
  );
}
