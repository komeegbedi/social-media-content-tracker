/* ===================================================================
   Notifications — client hooks + preference helpers.

   Notification docs are WRITTEN server-side (Cloud Functions, Slice 3);
   the client only reads its own, marks them read, and manages per-user
   delivery preferences. Kept dependency-light so the preference helpers
   can be unit-tested in Node like data.js.
   =================================================================== */
import { useEffect, useState, useCallback } from "react";
import {
  collection, query, where, orderBy, limit as fbLimit,
  onSnapshot, doc, updateDoc, writeBatch,
} from "firebase/firestore";
import { db } from "./firebase";
import { logIssue } from "./logging";
import { formatRelativeShort } from "./dateFormat.js";

import {
  UserPlusIcon, BellAlertIcon, ExclamationTriangleIcon, ClipboardDocumentCheckIcon,
  ChatBubbleLeftRightIcon, CheckCircleIcon, PaperAirplaneIcon, AtSymbolIcon,
  CheckBadgeIcon, ChartBarIcon, BellIcon, ClockIcon,
} from "@heroicons/react/24/outline";

// Display metadata per notification type: Heroicon component ref + label +
// tint class for the soft icon background (rendered by the Notification Center).
export const NOTIF_META = {
  assigned:         { icon: UserPlusIcon,               label: "Assignment",        tint: "tint-primary" },
  reminder:         { icon: BellAlertIcon,              label: "Reminder",          tint: "tint-primary" },
  overdue:          { icon: ExclamationTriangleIcon,    label: "Overdue",           tint: "tint-danger" },
  qa:               { icon: ClipboardDocumentCheckIcon, label: "Review",            tint: "tint-info" },
  changes:          { icon: ChatBubbleLeftRightIcon,    label: "Changes requested", tint: "tint-warning" },
  approved:         { icon: CheckCircleIcon,            label: "Approved",          tint: "tint-success" },
  ready:            { icon: PaperAirplaneIcon,          label: "Ready to post",     tint: "tint-success" },
  mention:          { icon: AtSymbolIcon,               label: "Mention",           tint: "tint-info" },
  account_approved: { icon: CheckBadgeIcon,             label: "Account",           tint: "tint-success" },
  account_pending:  { icon: UserPlusIcon,               label: "Approval needed",   tint: "tint-primary" },
  leadership:       { icon: ChartBarIcon,               label: "Leadership",        tint: "tint-neutral" },
  weeklyTaskCheck:  { icon: ClockIcon,                  label: "Weekly check-in",   tint: "tint-primary" },
  admin_delivery_health: { icon: ExclamationTriangleIcon, label: "Delivery alert",  tint: "tint-warning" },
};
export const NOTIF_FALLBACK = { icon: BellIcon, label: "Update", tint: "tint-neutral" };

// The preference DATA + helpers live in the pure, node-testable notificationPolicy
// module (so the UI and delivery share one source and stay node-unit-testable);
// re-exported here so app code keeps its single `./notifications` import surface.
export { NOTIF_SECTIONS, PREF_TYPES, defaultPrefs, effectivePrefs } from "./notificationPolicy.js";

// Human "2h ago" from a Firestore Timestamp | Date | ms.
// Compact "3d ago" relative time — centralised in the Intl date layer.
export function timeAgo(ts) {
  return formatRelativeShort(ts, { fallback: "" });
}

/* Live-subscribe to my notifications, newest first, paginated via "load more".
   Empty until the backend (Slice 3) starts writing docs. */
export function useNotifications(uid, pageSize = 20) {
  const [items, setItems] = useState([]);
  const [count, setCount] = useState(pageSize);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (!uid) { setItems([]); setHasMore(false); return; }
    const q = query(
      collection(db, "notifications"),
      where("uid", "==", uid),
      orderBy("createdAt", "desc"),
      fbLimit(count),
    );
    return onSnapshot(q,
      (snap) => { setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))); setHasMore(snap.size === count); },
      (err) => logIssue({ kind: "error", action: "notifications read failed", message: err.message, code: err.code }),
    );
  }, [uid, count]);

  const unread = items.reduce((n, x) => n + (x.read ? 0 : 1), 0);
  const loadMore = useCallback(() => setCount((c) => c + pageSize), [pageSize]);
  const markRead = useCallback((id) => {
    updateDoc(doc(db, "notifications", id), { read: true }).catch(() => {});
  }, []);
  const markAllRead = useCallback(() => {
    const unreadItems = items.filter((n) => !n.read);
    if (!unreadItems.length) return;
    const batch = writeBatch(db);
    unreadItems.forEach((n) => batch.update(doc(db, "notifications", n.id), { read: true }));
    batch.commit().catch(() => {});
  }, [items]);

  return { items, unread, hasMore, loadMore, markRead, markAllRead };
}
