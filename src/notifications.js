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

import {
  UserPlusIcon, BellAlertIcon, ExclamationTriangleIcon, ClipboardDocumentCheckIcon,
  ChatBubbleLeftRightIcon, CheckCircleIcon, PaperAirplaneIcon, AtSymbolIcon,
  CheckBadgeIcon, ChartBarIcon, BellIcon,
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
  leadership:       { icon: ChartBarIcon,               label: "Leadership",        tint: "tint-neutral" },
};
export const NOTIF_FALLBACK = { icon: BellIcon, label: "Update", tint: "tint-neutral" };

// The per-type toggles a user can control. "Required" messages
// (account_approved and security notices) always send and aren't listed.
export const PREF_TYPES = [
  { key: "assigned",   label: "Assigned to content" },
  { key: "reminder",   label: "Due-date reminders" },
  { key: "overdue",    label: "Overdue alerts" },
  { key: "qa",         label: "Review requests" },
  { key: "changes",    label: "Changes requested" },
  { key: "approved",   label: "Content approved" },
  { key: "ready",      label: "Ready to post" },
  { key: "mention",    label: "Mentions" },
  { key: "leadership", label: "Leadership alerts" },
];

// Defaults for users who haven't set preferences yet: everything on.
export function defaultPrefs() {
  const perType = {};
  PREF_TYPES.forEach((t) => { perType[t.key] = true; });
  return { push: true, email: true, perType };
}

// Merge a user's saved prefs over the defaults (missing = default on).
export function effectivePrefs(user) {
  const d = defaultPrefs();
  const p = (user && user.notifPrefs) || {};
  return {
    push: p.push !== undefined ? p.push : d.push,
    email: p.email !== undefined ? p.email : d.email,
    perType: { ...d.perType, ...(p.perType || {}) },
  };
}

// Human "2h ago" from a Firestore Timestamp | Date | ms.
export function timeAgo(ts) {
  if (!ts) return "";
  const ms = ts.toMillis ? ts.toMillis() : (ts instanceof Date ? ts.getTime() : ts);
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); if (d < 7) return `${d}d ago`;
  return `${Math.round(d / 7)}w ago`;
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
