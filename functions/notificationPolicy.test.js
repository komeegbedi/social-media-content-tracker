/* Notification policy — backend mirror + FULL anti-drift with the frontend source.
   Compares every policy surface (catalogs, predicates, eligibility gate) across the
   whole capability matrix so the settings UI and the delivery system can never
   disagree about who a notification type is for.
   Run: node --test functions/notificationPolicy.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const cjs = require("./notificationPolicy");

// A broad matrix of overlapping-capability user shapes.
const bools = [undefined, true, false];
const USERS = [];
for (const role of [undefined, "admin", "member"])
  for (const status of [undefined, "approved", "pending", "removed"])
    for (const qa of bools)
      for (const captions of bools)
        for (const lead of bools)
          for (const disabled of bools)
            USERS.push({ role, status, qa, captions, lead, disabled });

test("catalogs match: NOTIF_APPLIES, REQUIRED_APPLIES, and the union of known types", async () => {
  const esm = await import("../src/notificationPolicy.js");
  assert.deepEqual(Object.keys(cjs.NOTIF_APPLIES).sort(), Object.keys(esm.NOTIF_APPLIES).sort(), "controllable catalog drift");
  assert.deepEqual(Object.keys(cjs.REQUIRED_APPLIES).sort(), Object.keys(esm.REQUIRED_APPLIES).sort(), "required catalog drift");
  const union = (m) => [...new Set([...Object.keys(m.NOTIF_APPLIES), ...Object.keys(m.REQUIRED_APPLIES)])].sort();
  assert.deepEqual(union(cjs), union(esm), "union of known types drift");
});

test("isKnownNotifType / isControllableType / notifTypeApplies / recipientEligible mirror for EVERY user + type", async () => {
  const esm = await import("../src/notificationPolicy.js");
  // Every known type on both sides + a couple of deliberately-unknown types.
  const types = [
    ...new Set([...Object.keys(cjs.NOTIF_APPLIES), ...Object.keys(cjs.REQUIRED_APPLIES),
      ...Object.keys(esm.NOTIF_APPLIES), ...Object.keys(esm.REQUIRED_APPLIES)]),
    "mystery", "account_deleted", "",
  ];
  for (const t of types) {
    assert.equal(cjs.isKnownNotifType(t), esm.isKnownNotifType(t), `isKnownNotifType(${t})`);
    assert.equal(cjs.isControllableType(t), esm.isControllableType(t), `isControllableType(${t})`);
    for (const u of USERS) {
      assert.equal(cjs.notifTypeApplies(t, u), esm.notifTypeApplies(t, u), `notifTypeApplies(${t}) for ${JSON.stringify(u)}`);
      assert.equal(cjs.recipientEligible(t, u), esm.recipientEligible(t, u), `recipientEligible(${t}) for ${JSON.stringify(u)}`);
    }
  }
});

test("applicableNotifTypes mirrors for every user", async () => {
  const esm = await import("../src/notificationPolicy.js");
  for (const u of USERS)
    assert.deepEqual(cjs.applicableNotifTypes(u), esm.applicableNotifTypes(u), `applicable differ for ${JSON.stringify(u)}`);
});

test("unknown types are never eligible on either side (fail safe)", async () => {
  const esm = await import("../src/notificationPolicy.js");
  for (const u of USERS.slice(0, 20)) {
    assert.equal(cjs.recipientEligible("mystery", u), false);
    assert.equal(esm.recipientEligible("mystery", u), false);
  }
});

test("required-notice behavior for regular / QA / admin / Admin+QA / pending / disabled / removed", async () => {
  const { requiredNotices } = await import("../src/notificationPolicy.js");
  const P = {
    regular:  { status: "approved" },
    qa:       { status: "approved", qa: true },
    admin:    { role: "admin" },
    adminQa:  { role: "admin", qa: true },
    pending:  { status: "pending" },
    disabled: { status: "approved", disabled: true },
    removed:  { status: "removed" },
  };
  const req = (u) => requiredNotices(u).sort();
  // Regular + QA: account/security only (no admin delivery-health).
  assert.deepEqual(req(P.regular), ["account_approved"]);
  assert.deepEqual(req(P.qa), ["account_approved"]);
  // Admin + Admin+QA: also account_pending + admin_delivery_health.
  assert.deepEqual(req(P.admin), ["account_approved", "account_pending", "admin_delivery_health"]);
  assert.deepEqual(req(P.adminQa), ["account_approved", "account_pending", "admin_delivery_health"]);
  // Ineligible accounts receive no required notices at all.
  assert.deepEqual(req(P.pending), []);
  assert.deepEqual(req(P.disabled), []);
  assert.deepEqual(req(P.removed), []);
});

test("isProductionEligible: approved + active + NOT qa (Admin+QA excluded)", () => {
  assert.equal(cjs.isProductionEligible({ status: "approved" }), true);
  assert.equal(cjs.isProductionEligible({ role: "admin" }), true);              // non-QA admin
  assert.equal(cjs.isProductionEligible({ status: "approved", qa: true }), false);
  assert.equal(cjs.isProductionEligible({ role: "admin", qa: true }), false);   // Admin+QA
  assert.equal(cjs.isProductionEligible({ status: "approved", disabled: true }), false);
  assert.equal(cjs.isProductionEligible({ status: "pending" }), false);
  assert.equal(cjs.isProductionEligible({ status: "removed" }), false);
});
