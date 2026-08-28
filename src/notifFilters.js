/* Notification Center filter catalog + the pure filtering function.
   Kept DOM-free and firebase-free so the exact logic the drawer uses is
   node-unit-testable (like nav.js / notificationPolicy.js). App.jsx is a thin
   adapter that renders these tabs and calls filterNotifications(). */

// Each filter maps a chip to the notification TYPES it shows. `more:true` tucks it
// under the "More" overflow. "all"/"unread" are structural (no `types`).
export const NOTIF_FILTERS = [
  { id: "all",       label: "All" },
  { id: "unread",    label: "Unread" },
  { id: "assigned",  label: "Assignments", types: ["assigned"] },
  { id: "reviews",   label: "Reviews",     types: ["qa"] },
  { id: "reminders", label: "Reminders",   types: ["reminder", "overdue"] },
  { id: "changes",   label: "Changes",     types: ["changes"], more: true },
  { id: "approvals", label: "Approvals",   types: ["approved", "ready", "account_approved"], more: true },
  // System = account/org + delivery-health notices (leadership digest, mentions,
  // and the admin-only notification-delivery alerts).
  { id: "system",    label: "System",      types: ["leadership", "mention", "admin_delivery_health"], more: true },
];
export const NOTIF_PRIMARY = NOTIF_FILTERS.filter((f) => !f.more);
export const NOTIF_MORE = NOTIF_FILTERS.filter((f) => f.more);

// Apply a filter id to a loaded page of notification docs. Unknown id → "All".
export function filterNotifications(items, filterId) {
  const active = NOTIF_FILTERS.find((f) => f.id === filterId) || NOTIF_FILTERS[0];
  if (active.id === "all") return items;
  if (active.id === "unread") return items.filter((n) => !n.read);
  return items.filter((n) => (active.types || []).includes(n.type));
}
