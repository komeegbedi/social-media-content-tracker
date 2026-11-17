/* The account menu — ONE menu for the whole app (round 6). Opened by the profile
   avatar in the mobile header and by the profile button in the desktop sidebar,
   so the two can't drift apart again. Firebase-free (values + actions come in as
   props) so its behaviour can be exercised in the DOM.

   Phones: the shared bottom sheet (overlay.jsx useSheet), the same one the
   notification panel uses: slides up, drag down from the handle or header to
   dismiss, slides down on close. Desktop: a lightweight, non-modal popover
   rising from the sidebar profile button. URL-backed (?panel=profile) like
   Notifications/Search: one overlay at a time, browser Back closes it, other URL
   parameters (e.g. ?path=) are kept. Close / Escape / a tap outside close it and
   the Portal returns focus to the trigger. */
import { useEffect } from "react";
import {
  XMarkIcon, PlusIcon, UserGroupIcon, Cog6ToothIcon, BellAlertIcon,
  SparklesIcon, LightBulbIcon, ExclamationTriangleIcon, ArrowRightStartOnRectangleIcon,
} from "@heroicons/react/24/outline";
import { Portal, useMediaQuery, useSheet } from "./overlay.jsx";
import { initials } from "./data.js";

function Item({ icon: Icon, children, onClick, danger = false, state = null, label }) {
  return (
    <button type="button" className={"sb-drawer-item" + (danger ? " danger" : "")} onClick={onClick} aria-label={label}>
      <span className="i"><Icon className="hi" aria-hidden="true" /></span>{children}{state}
    </button>
  );
}

export function AppMenu({
  me, roleLabel = "Member", isAdmin = false, canCreate = false, pendingCount = 0,
  appearance = "system", appearanceOptions = [], onAppearance,
  whatsNewIsNew = false,
  onClose, onNewContent, onGoTab, onNotifPrefs, onWhatsNew, onFeatureRequest, onReport, onSignOut,
}) {
  const isDesktop = useMediaQuery("(min-width:900px)");
  const sheet = useSheet(onClose);
  // Phones close through the sheet (slide down); desktop closes at once.
  const close = isDesktop ? onClose : () => sheet.finish();
  const act = (fn) => (isDesktop || !fn ? fn : (...a) => sheet.finish(() => fn(...a)));
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isDesktop]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Portal modal={!isDesktop}>
      <div className={"sb-scrim sb-scrim-anchored" + (isDesktop ? " sb-menuscrim" : " sb-bscrim") + (sheet.closing ? " closing" : "")} onMouseDown={close}>
        <div className={"sb-appmenu" + (isDesktop ? "" : " sb-bsheet")} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal={isDesktop ? undefined : "true"} aria-label="Account menu"
          style={isDesktop ? undefined : sheet.sheetStyle}>
          {!isDesktop && <div className="sb-grab" {...sheet.handleProps} aria-hidden="true"><span /></div>}
          <div className="sb-appmenu-hd" {...(isDesktop ? {} : sheet.headerProps)}>
            <span className="sb-av sb-appmenu-av" aria-hidden="true">{initials(me?.name || "")}</span>
            <div className="sb-appmenu-who">
              <div className="nm"><bdi>{me?.name}</bdi></div>
              <div className="rl">{roleLabel}{me?.email ? <> · <bdi>{me.email}</bdi></> : null}</div>
            </div>
            <button type="button" className="sb-drawer-close" onClick={close} aria-label="Close account menu"><XMarkIcon className="hi" aria-hidden="true" /></button>
          </div>
          <div className="sb-appmenu-body">
            <div className="sb-appmenu-group" role="group" aria-labelledby="sb-appmenu-prefs">
              <div className="sb-appmenu-label" id="sb-appmenu-prefs">Preferences</div>
              <fieldset className="sb-appearance">
                <legend className="sb-vh">Appearance</legend>
                <div className="sb-appearance-opts">
                  {appearanceOptions.map(({ key, label, Icon }) => (
                    <label key={key} className={"sb-appearance-opt" + (appearance === key ? " on" : "")}>
                      <input type="radio" name="sb-appearance" value={key} checked={appearance === key} onChange={() => onAppearance(key)} />
                      <Icon className="hi hi-sm" aria-hidden="true" /><span>{label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {onNotifPrefs && <Item icon={BellAlertIcon} onClick={act(onNotifPrefs)}>Notification preferences</Item>}
            </div>
            <div className="sb-appmenu-group" role="group" aria-labelledby="sb-appmenu-manage">
              <div className="sb-appmenu-label" id="sb-appmenu-manage">Manage</div>
              {canCreate && onNewContent && <Item icon={PlusIcon} onClick={act(onNewContent)} state={<span className="sb-drawer-state">Workflow</span>}>New content</Item>}
              <Item icon={UserGroupIcon} onClick={act(() => onGoTab("team"))}>Team</Item>
              {isAdmin && (
                <Item icon={Cog6ToothIcon} onClick={act(() => onGoTab("admin"))}
                  label={pendingCount > 0 ? `Admin, ${pendingCount} account${pendingCount === 1 ? "" : "s"} waiting for approval` : undefined}
                  state={pendingCount > 0 ? <span className="sb-drawer-state sb-countpill">{pendingCount}</span> : null}>Admin</Item>
              )}
            </div>
            <div className="sb-appmenu-group" role="group" aria-labelledby="sb-appmenu-help">
              <div className="sb-appmenu-label" id="sb-appmenu-help">Help</div>
              <Item icon={SparklesIcon} onClick={act(onWhatsNew)} state={whatsNewIsNew ? <span className="sb-newbadge">New</span> : null}>What's new</Item>
              {onFeatureRequest && <Item icon={LightBulbIcon} onClick={act(onFeatureRequest)}>Submit feature request</Item>}
              <Item icon={ExclamationTriangleIcon} onClick={act(onReport)}>Report an issue</Item>
            </div>
            <div className="sb-appmenu-sep" role="presentation" />
            <Item icon={ArrowRightStartOnRectangleIcon} onClick={act(onSignOut)} danger>Sign out</Item>
          </div>
        </div>
      </div>
    </Portal>
  );
}
