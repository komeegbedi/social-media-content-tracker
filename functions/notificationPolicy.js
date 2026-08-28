/* Notification eligibility — BACKEND MIRROR of src/notificationPolicy.js.
   The delivery system (weeklyTaskCheck targeting, safety filters) and the settings
   UI must agree on who a notification type is for. A drift test
   (functions/notificationPolicy.test.js) runs both files over the same user matrix
   and asserts identical results, so they can never diverge. Keep the capability
   atoms and NOTIF_APPLIES below identical in logic to the ESM source. */

const active = (u) => !!u && u.disabled !== true;
const approved = (u) => !!u && (u.status === "approved" || u.role === "admin");
const eligible = (u) => active(u) && approved(u);
const isQa = (u) => eligible(u) && u.qa === true;
const isAdmin = (u) => !!u && u.role === "admin" && active(u);
const isProduction = (u) => eligible(u) && u.qa !== true;
const hasCaptions = (u) => isProduction(u) && u.captions === true;
const isLead = (u) => !!u && u.lead === true;

const NOTIF_APPLIES = {
  assigned:        isProduction,
  reminder:        isProduction,
  overdue:         isProduction,
  changes:         isProduction,
  approved:        isProduction,
  weeklyTaskCheck: isProduction,
  qa:              isQa,
  ready:           hasCaptions,
  leadership:      (u) => eligible(u) && (isLead(u) || isAdmin(u)),
  mention:         eligible,
};

// Required / internal types: always sent (bypass prefs) but still enforce account
// eligibility + recipient capability. Keep in sync with src/notificationPolicy.js.
const REQUIRED_APPLIES = {
  account_approved:      eligible,
  account_pending:       isAdmin,
  admin_override:        eligible,
  review_info:           isAdmin,
  admin_delivery_health: isAdmin,
};

function notifTypeApplies(type, user) {
  const p = NOTIF_APPLIES[type];
  return p ? !!p(user) : false;
}
function applicableNotifTypes(user) {
  return Object.keys(NOTIF_APPLIES).filter((t) => notifTypeApplies(t, user));
}
function isKnownNotifType(type) { return !!(NOTIF_APPLIES[type] || REQUIRED_APPLIES[type]); }
function isControllableType(type) { return !!NOTIF_APPLIES[type]; }

// THE authoritative delivery gate (mirrors src): account eligibility for every type
// + the per-type capability. Unknown type → never eligible (fail safe).
function recipientEligible(type, user) {
  if (!eligible(user)) return false;
  if (NOTIF_APPLIES[type]) return !!NOTIF_APPLIES[type](user);
  if (REQUIRED_APPLIES[type]) return !!REQUIRED_APPLIES[type](user);
  return false;
}

// Active, approved, production-eligible (never QA) — base target for production-side
// notifications (weekly check-in, overdue).
const isProductionEligible = (u) => isProduction(u);

module.exports = {
  NOTIF_APPLIES, REQUIRED_APPLIES, notifTypeApplies, applicableNotifTypes,
  isKnownNotifType, isControllableType, recipientEligible, isProductionEligible,
};
