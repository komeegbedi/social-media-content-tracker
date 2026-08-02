/* Admin content-card kebab actions (pure — no data layer, so it's unit-testable).

   Deliberately excludes any one-click "Mark posted" / "Archive" action: forcing a
   task's status (especially into Posted) outside the normal Ready-to-Post→Posted
   step is an EXCEPTIONAL jump that must go through the Administrative override panel
   — which requires a real reason and a confirmation and produces a server-authored,
   audited admin_override event. A canned-reason one-click shortcut would bypass that
   ceremony, so it does not exist. */
export const adminKebab = (t, h) => [
  { label: "Open", onClick: () => h.open(t.id) },
  { label: "Edit", onClick: () => h.edit(t) },
  { label: "Duplicate", onClick: () => h.duplicate(t) },
  { label: "Delete", danger: true, onClick: () => h.del(t.id, t.title) },
];
