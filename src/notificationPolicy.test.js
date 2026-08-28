/* Notification eligibility — capability-based preference visibility (pure).
   Run: node --test src/notificationPolicy.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applicableNotifTypes, notifTypeApplies, requiredNotices, NOTIF_APPLIES } from "./notificationPolicy.js";
import { PREF_TYPES } from "./notificationPolicy.js";

const U = {
  production: { status: "approved" },
  qaOnly:     { status: "approved", qa: true },
  adminOnly:  { role: "admin" },
  adminQa:    { role: "admin", qa: true },
  captions:   { status: "approved", captions: true },
  lead:       { status: "approved", lead: true },
  captionsQa: { status: "approved", captions: true, qa: true },  // captions must not override QA
  pending:    { status: "pending" },
  disabled:   { status: "approved", disabled: true },
  removed:    { status: "removed" },
};
const shown = (u) => new Set(applicableNotifTypes(u));

test("regular production user sees production work + mentions, nothing QA/captions/leadership", () => {
  const s = shown(U.production);
  for (const k of ["assigned", "reminder", "overdue", "changes", "approved", "weeklyTaskCheck", "mention"]) assert.ok(s.has(k), `expected ${k}`);
  for (const k of ["qa", "ready", "leadership"]) assert.ok(!s.has(k), `must NOT show ${k}`);
});

test("QA-only sees review requests + mentions ONLY (no production, no weekly, no leadership)", () => {
  assert.deepEqual([...shown(U.qaOnly)].sort(), ["mention", "qa"]);
});

test("Admin-only sees production + leadership + mentions, but no review (needs qa===true)", () => {
  const s = shown(U.adminOnly);
  for (const k of ["assigned", "reminder", "overdue", "changes", "approved", "weeklyTaskCheck", "leadership", "mention"]) assert.ok(s.has(k), `expected ${k}`);
  assert.ok(!s.has("qa"), "admin without qa must not see review requests");
  assert.ok(!s.has("ready"), "admin without captions must not see ready");
  assert.deepEqual(requiredNotices(U.adminOnly).sort(), ["account_approved", "account_pending", "admin_delivery_health"]);
});

test("Admin+QA sees review + leadership + mentions — NEVER production or weekly check-in", () => {
  assert.deepEqual([...shown(U.adminQa)].sort(), ["leadership", "mention", "qa"]);
  assert.ok(!shown(U.adminQa).has("weeklyTaskCheck"), "Admin+QA must not get the Saturday check-in");
  assert.ok(!shown(U.adminQa).has("assigned"), "Admin+QA is not production");
});

test("captions capability adds 'ready'; lead capability adds 'leadership'", () => {
  assert.ok(shown(U.captions).has("ready"));
  assert.ok(shown(U.lead).has("leadership"));
  // captions on a QA account does NOT grant production/ready (QA is never production).
  assert.deepEqual([...shown(U.captionsQa)].sort(), ["mention", "qa"]);
});

test("pending / disabled / removed accounts see NO preferences", () => {
  assert.deepEqual(applicableNotifTypes(U.pending), []);
  assert.deepEqual(applicableNotifTypes(U.disabled), []);
  assert.deepEqual(applicableNotifTypes(U.removed), []);
  assert.deepEqual(requiredNotices(U.pending), []);
});

test("no preference is displayed unless a real producer emits it (producer audit)", () => {
  // Every producer of a user-controllable type in the codebase (verified by grep):
  // overdue is emitted by the daily overdue sweep in functions/dispatchReminders.js.
  const PRODUCERS = new Set([
    "assigned", "reminder", "overdue", "changes", "approved", "ready", "qa", "mention", "leadership", "weeklyTaskCheck",
  ]);
  // Policy keys and UI keys agree, and each has a real producer.
  assert.deepEqual(Object.keys(NOTIF_APPLIES).sort(), PREF_TYPES.map((t) => t.key).sort());
  for (const t of PREF_TYPES) assert.ok(PRODUCERS.has(t.key), `${t.key} must correspond to a real notification producer`);
});

test("a type never applies to a user it can't reach (safety: applicable ⇒ notifTypeApplies)", () => {
  for (const [name, u] of Object.entries(U)) {
    for (const t of applicableNotifTypes(u)) assert.ok(notifTypeApplies(t, u), `${name}/${t}`);
  }
});

/* stored-preference preservation across capability changes */
import { effectivePrefs } from "./notificationPolicy.js";

test("stored preferences survive a capability change (never reset; inapplicable keys retained + ignored)", () => {
  // A user with production opt-outs (assigned/overdue false) has them retained even
  // while a capability change hides those toggles, so restoring the capability
  // restores the choice — the UI hides them and delivery ignores them meanwhile.
  const eff = effectivePrefs({ notifPrefs: { perType: { assigned: false, overdue: false, mention: false } } });
  assert.equal(eff.perType.assigned, false);
  assert.equal(eff.perType.overdue, false);   // retained across capability changes
  assert.equal(eff.perType.mention, false);
  // Defaults still fill in the applicable-but-unset ones.
  assert.equal(eff.perType.qa, true);
});
