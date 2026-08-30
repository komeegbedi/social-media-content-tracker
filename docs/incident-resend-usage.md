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

## Resend quota reset boundary — Support findings (FINAL, provider accounting stays disabled)

Resend's Docs AI confirmed the public documentation does **not** specify the exact monthly or
daily quota reset boundaries. Provider monthly accounting therefore remains **disabled**; the
panel shows Resend account usage as **Unavailable**.

### Known facts (documented by Resend)
- `x-resend-monthly-quota` and `x-resend-daily-quota` report **used** quota (Model A — confirmed
  by our controlled production observation: header = pre-send used; post-send = header + accepted
  recipients).
- Free transactional limits: **3,000 / month**, **100 / day**.
- Quotas are **account/team-wide**, not scoped to an API key or sending domain.
- **Every To/CC/BCC recipient counts** (each recipient is a unit).
- `ratelimit-reset` / `retry-after` concern **API request throttling**, not monthly/daily email
  quota resets.
- **No** documented quota-exceeded response field provides the **next reset timestamp**.

### Remaining unknowns (block provider accounting)
- Whether **monthly** usage follows a UTC calendar month, signup anniversary, billing-cycle
  anniversary, or another window.
- Whether **daily** usage resets at **UTC midnight** or uses a **rolling 24-hour** window.
  (Our existing logs are inconclusive: no pre-midnight Aug-29 header exists to compare against the
  Aug-30 `daily=0`.)

### Resulting engineering constraints (enforced)
1. `HEADER_SEMANTICS_PROVEN` stays **false** in the deployed/production configuration; Stage A.1 is
   production behavior. (The Stage D WIP branch, unmerged and undeployed, records the proven header
   meaning but keeps `PROVIDER_MONTHLY_PERIOD_PROVEN`/`PROVIDER_DAILY_PERIOD_PROVEN` **false**, so
   ALL provider accounting is gated OFF there too — it must not merge or deploy while the reset
   boundary is unknown.)
2. Provider account usage is displayed as **Unavailable** (client rejects every provider model).
3. **Do not assume UTC periods for Resend.** The internal `email-YYYY-MM` / `emailDaily-YYYY-MM-DD`
   documents are **application-owned**, UTC-labelled, and are **not** claimed to align with Resend's
   period.
4. **No durable monthly or daily provider-exhaustion markers** that depend on an unverified reset
   boundary. (The existing UTC-month `monthlyExhaustedMonth` self-clears at the UTC month boundary
   and is treated as advisory only; the daily marker + the 90/day internal limit are the operative
   guard.)
5. A real quota **429** may terminate the **current delivery**; any **longer** suppression must have
   a **verified expiration** or require an **explicitly authorized probe** — never silent repeated
   probes, never a marker that can only self-clear by an observation the marker itself blocks.
6. Internal telemetry is honestly labelled: "App email activity · UTC calendar month /
   N successful deliveries / Internal telemetry; not the Resend monthly quota." and "Daily app
   limit · UTC day / X / 90 / Internal enforcement. Resend's daily reset window is still being
   verified." — application-owned enforcement, never presented as the authoritative Resend period.

### Exact information still required from human Resend Support (before any Stage D work)
- The **monthly** quota reset rule for the Free transactional plan: calendar month, signup
  anniversary, billing-cycle anniversary, or other — with the exact reset instant and timezone.
- The **daily** quota reset rule: fixed clock reset (and which timezone, e.g. UTC midnight) vs a
  rolling 24-hour window.
- Whether a **quota-exceeded (429)** response (or any API surface) can return the **next reset /
  retry timestamp** for the monthly and daily quotas.
- Confirmation of how usage is attributed across account **API-key changes** within the same team
  (to close the residual 119-vs-49 reconciliation), and whether inbound/received email is included
  in the dashboard usage figure.

Until these are answered by human Support, provider monthly/daily accounting stays **Unavailable**
and no reset-dependent logic is implemented or deployed.
