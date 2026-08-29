# Incident: Resend Email Usage showed impossible `3,001 / 3,000`

Living record of the remediation. This file is committed in stages alongside the code.

## Root cause (mechanism — proven from code)
`functions/resendUsage.js applyObservation()` used a monotonic floor with **no plan-capacity
validation**: `monthlyUsed = max(monthlyUsedBeforeSend + units, prevMonthly + units)`. If the
`x-resend-monthly-quota` header (value equal to plan capacity, `3000`) was treated as pre-send
*used*, `+1` recipient produced `3001`, and `Math.max` latched it permanently. The code showing
this is **not** proof the header contained `3000` or that it means "used" — header semantics
remain **unproven** (§ deferred).

## Stage A — Production containment (THIS COMMIT)
Goal: make the poison impossible to display, suppress with, or alert from — without asserting any
unproven interpretation of the provider headers. Internal safety enforcement and real `429`
quota-exceeded behavior are unchanged.

- `HEADER_SEMANTICS_PROVEN = false` (reviewed code constant, never an env toggle).
- **Refuse to persist** ambiguous provider observations: `recordObservedUsage` writes nothing
  (a value merely inside `[0, planLimit]` is not evidence it is a usage count).
- **Read model** returns `providerAvailable:false`, code `provider-usage-unverified`.
- **Reserve gate** ignores header-derived usage → no provider-derived suppression.
- **Server-only diagnostic** logs an ALLOWLISTED set of quota/rate headers
  (`pickDiagnosticHeaders`) so the true semantics can be proven from a real send — never auth,
  cookies, keys, or recipients.
- **Client** shows provider usage only when the server stamps `providerUsageProven`; the
  "Unavailable" UI state removes the percentage bars and the valid-observation badge. Independent
  internal app-safety telemetry remains visible, as does "View in Resend".
- **Compatibility signal for stale frontends:** hosting serves `index.html` as
  `no-cache, must-revalidate` and the only service worker (`firebase-messaging-sw.js`) does NOT
  precache the app shell, so a reload always loads the new bundle. The residual risk is a tab left
  **open** across the deploy whose already-loaded listener would keep rendering the poisoned
  public doc. To close it, a successful post-deploy send **neutralizes** the provider fields in the
  sanitized panel doc (`monthly:null`, `providerUsageProven:false`), so even an old bundle reads it
  as unavailable.
- **Firestore rule:** `adminDiagnostics/{id}` is admin-read, no client write.
- Still validated for when the flag flips (dormant): `validateObservation`, `cachedUsageValid`,
  and a self-healing floor that ignores a poisoned `prevMonthly`.

At this commit the app compiles and functions with the existing **message-based** internal
accounting while provider usage is safely unavailable.

## Stage B — Accepted-recipient safety accounting (NEXT COMMIT)
The internal safety cap currently counts **messages**; the Resend quota counts **recipients**.
Stage B makes reserve/settle/release operate in accepted-recipient units. Documented in this file
when that commit lands.

## Deferred (require explicit authorization / production access — NOT in these commits)
- Prove header semantics from one controlled production send (fill the evidence table).
- Reconcile the poisoned value and the internal count against production records.
- Cache repair (`functions/scripts/repair-resend-usage.js`, dry-run only).
- Deploy Stage A; later enable proven provider accounting (Stage D: flip the constant + implement
  the proven model + stamp `providerUsageProven`).

**Completion criterion:** not done until the production panel shows a valid value matching the
Resend dashboard after a controlled send — or clearly shows provider usage as unavailable.
