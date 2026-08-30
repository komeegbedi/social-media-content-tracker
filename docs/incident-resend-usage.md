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

### Proven vs unproven (corrected flag semantics)
Separate the header MEANING from the reset PERIOD:
- `QUOTA_HEADER_MODEL_PROVEN = true` — the quota headers are USED counters, observed BEFORE the
  accepted send is added (Model A, confirmed by the controlled observation).
- `MONTHLY_PERIOD_PROVEN = false` — the monthly reset boundary is unknown.
- `DAILY_PERIOD_PROVEN = false` — the daily reset boundary is unknown.
- `PROVIDER_PERIOD_BASED_ENFORCEMENT_ENABLED = false` — no reset-dependent provider logic is active.

Production may temporarily retain `HEADER_SEMANTICS_PROVEN = false` as a containment/deployment gate,
but that single flag name now CONFLATES a proven header meaning with unproven reset periods. Do not
flip or rename the production code in this task; the four booleans above are the accurate model.

### Resulting engineering constraints (enforced)
1. Production keeps `HEADER_SEMANTICS_PROVEN = false` (Stage A.1). The Stage D WIP branch is gated
   OFF (`PROVIDER_*_PERIOD_PROVEN = false`) and must not merge or deploy while the boundary is
   unknown.
2. Resend account usage displays **Unavailable** (client rejects every provider model).
3. **No UTC assumption for Resend.** Internal `email-YYYY-MM` / `emailDaily-YYYY-MM-DD` are
   application-owned, UTC-labelled, and are NOT claimed to align with Resend's period.
4. **Provider-derived exhaustion policy (corrected):** the app-owned **90-recipient-per-UTC-day**
   limit and the app-owned monthly counter are preserved. A real Resend `daily_quota_exceeded` /
   `monthly_quota_exceeded` (429) **terminates the current delivery** (`suppressed_quota_limit`,
   reservation released). It **must NOT** create or enforce a durable provider-derived exhaustion
   marker whose expiration depends on an unverified reset boundary. Any longer suppression must
   have a **verified expiration** (a stored expiry timestamp) or require an **explicitly authorized
   probe** — never a UTC-period marker, never silent repeated probes.
5. A provider marker that `reserve()` uses to DENY sends is **enforcement, not "advisory"** — it
   must be described and bounded as such. (The prior "advisory" wording was wrong; see the audit.)

### Reserve-gate audit — every condition touched by provider quota markers
`reserve()` deny order (functions/emailQuota.js) and the source of each condition:

| # | Condition | Source | Provider-derived? | Effect | Violates current-delivery-only? |
|---|---|---|---|---|---|
| 1 | `resend_monthly_exhausted` (`gate.monthlyExhausted`) | `markMonthlyExhausted` on a 429 → `monthlyExhaustedMonth == <UTC month>` | **Yes** | denies **all** sends for the **rest of the UTC month** | **YES** |
| 2 | `monthly_limit` (`mUsed >= mLimit`) | app `sentCount+reservedCount` vs 2,800 (UTC month) | No (app-owned) | denies at the app monthly cap | No |
| 3 | `resend_account_limit` (`accountProjected > plan`) | `gate.monthlyUsed` (provider header) | Yes, but **inert in production** — `monthlyUsed` is null unless `HEADER_SEMANTICS_PROVEN && PROVIDER_PERIOD_PROVEN` | never fires in prod | No (inert) |
| 4 | `resend_daily_exhausted` (`gate.dailyExhausted`) | `markDailyExhausted` on a 429 → `dailyExhaustedDay == <UTC day>` | **Yes** | denies **all** sends for the **rest of the UTC day** | **YES** |
| 5 | `daily_limit` (`dUsed >= dLimit`) | app `sentCount+reservedCount` vs 90 (UTC day) | No (app-owned) | denies at the app daily cap | No |
| 6 | `quota_95_noncritical` / `quota_85_low` | `usedPct = mUsed/mLimit` (app monthly) | No (app-owned) | priority gating on the app monthly % | No |

`readResendGate` returns `monthlyExhausted`/`dailyExhausted` **unconditionally** (only `monthlyUsed`
is gated by the accounting flags), so conditions **1 and 4 are enforced even in production**, where
provider accounting is otherwise disabled.

### Does current production code violate the current-delivery-only policy?
**Yes (latent).** A single real 429 `daily_quota_exceeded` sets `dailyExhaustedDay = <today UTC>`,
and every subsequent `reserve()` that UTC day is denied `resend_daily_exhausted` until UTC midnight
— an **unverified** boundary. The monthly case suppresses for the rest of the UTC month. No such
marker is currently set in production (`systemUsage/resendQuota` has neither field), so nothing is
being suppressed **right now**, but the code path would create the violation on the next real
quota 429. The prior report calling the UTC-month marker "advisory" was therefore incorrect.

### Remediation — Option A (RECOMMENDED, strict current-delivery-only; code-only, NOT implemented)
On a real `daily_quota_exceeded` / `monthly_quota_exceeded` (429): release the reservation, settle
the current delivery as `suppressed_quota_limit` (terminal, no retry — already the behavior), emit
the existing deduplicated operational alert — and **do NOT write a provider-derived daily/monthly
exhaustion marker**. While `PROVIDER_PERIOD_BASED_ENFORCEMENT_ENABLED = false`, `reserve()` **ignores**
all legacy provider exhaustion markers **without deleting** them. App-owned monthly cap (2,800/UTC
month), 90-per-UTC-day cap, and priority gates are preserved. Later normal deliveries may
INDEPENDENTLY hit another quota 429 — these are organic sends, **not probes**; there are no retries
for the same quota-rejected delivery.

**Files / functions affected (Option A):**
- `functions/emailService.js` — in the `_deliver` quota-429 branch, REMOVE the `markDailyExhausted`
  / `markMonthlyExhausted` calls. Keep the reservation release, the `suppressed_quota_limit` settle,
  and `alertAdmins` (daily / monthly-100%). No retry (unchanged).
- `functions/emailQuota.js` — `readResendGate`: gate `monthlyExhausted` / `dailyExhausted` on
  `PROVIDER_PERIOD_BASED_ENFORCEMENT_ENABLED` so both return `false` while enforcement is disabled
  (legacy `monthlyExhaustedMonth` / `dailyExhaustedDay` fields are IGNORED, never deleted). The
  `reserve()` deny conditions #1/#4 then never fire. `markDaily/MonthlyExhausted` become unused —
  keep as documented legacy no-callers, or remove them + their exports.
- Tests: `test/quota-suppression.test.js`, `test/email-quota.test.js` (+ any that assert marker
  writes/denials).

**Compatibility for legacy markers:** any pre-existing `monthlyExhaustedMonth` / `dailyExhaustedDay`
in `systemUsage/resendQuota` is **ignored** (not read into a deny) and **not deleted** — a passive,
non-destructive migration. (Production currently has neither field set, so this is a no-op there.)

**Alert & delivery-state behavior:** delivery → released + `suppressed_quota_limit` (terminal, no
retry). Alert → the existing per-UTC-period deduped `admin_delivery_health` alert (daily / monthly
100%) still fires for operational visibility (this is an alert dedupe, NOT an enforcement marker).
No provider exhaustion marker is written; nothing suppresses subsequent deliveries.

**Tests required (Option A):**
- 429 daily → current delivery `suppressed_quota_limit` + released; **no** `dailyExhaustedDay` written;
  deduped daily alert fired; returns suppressed (no retry). Same for monthly (+ monthly-100% alert).
- `reserve()` with a pre-existing legacy `dailyExhaustedDay` / `monthlyExhaustedMonth` present while
  enforcement disabled → **allowed** (marker ignored); the marker fields are **not** deleted.
- **Concurrent reservations** after a 429: N deliveries each governed only by the app caps (90/day,
  2,800/month) — none blocked by a provider marker; a later organic send that itself hits 429 is
  suppressed on its own (not labelled a probe); concurrency near the app cap still cannot overshoot.
- App-owned caps + priority gates unchanged.

### Remediation — Option B (design ONLY; do NOT implement/recommend without explicit authorization)
An explicitly-authorized **circuit breaker** for provider quota exhaustion. Requires the user to
authorize automatic or administrator-controlled probing before any implementation.
- **State machine:** `closed → open → half-open → closed | open`, persisted on a Firestore doc,
  mutated only inside a **transaction**.
- **open:** entered on a quota 429; stores an **"application cooldown"** timestamp (labelled exactly
  that — never "verified expiration" or "provider reset").
- **half-open:** after the cooldown, exactly **one** delivery atomically claims a **probe lease** in a
  transaction (state=open ∧ now≥cooldown ∧ no active lease → set half-open, `leaseOwner=deliveryId`,
  `leaseUntil`). Only the lease owner may send; **all other concurrent deliveries remain denied**
  while the lease is active.
- **Probe outcomes:** success (2xx) → `closed`; quota 429 → `open` with a new application cooldown;
  request-rate 429 (`rate_limit_exceeded`) → NOT a quota signal → release lease, remain `open`, retry
  rate-limit via the existing path, do not reset the breaker; timeout / uncertain network → keep the
  SAME idempotency key (Resend dedupes), treat as uncertain → do not reset; the lease self-releases at
  `leaseUntil`; crashed lease owner / lease expiration → `leaseUntil` frees the lease (reconcile
  backstop) → back to `open` for the next cooldown. One probe per cooldown, never concurrent probes.
- Same delivery **idempotency key** throughout. Application cooldown is always labelled "application
  cooldown."

### Recommendation — Option A vs. waiting for Resend Support
**Prepare Option A now** (pending your authorization to change code + a Hosting/Functions deploy).
Option A removes the latent violation, does **not** depend on the unknown reset boundary, keeps
app-owned enforcement + operational alerts, and never suppresses on an unverified boundary. The
violation is currently **latent** (no marker set in production; it would only trigger on the next
real quota 429), so this is not an emergency — but Option A is the correct, boundary-independent
code fix and should not wait on Support. **Defer Option B** until Resend Support provides the reset
boundary AND you explicitly authorize probing; until then, Option A's strict current-delivery-only
containment is the honest behavior.

### Exact information still required from human Resend Support (corrected)
- The **monthly** quota reset rule (calendar month / signup anniversary / billing-cycle anniversary /
  other) with the exact reset instant and timezone.
- The **daily** quota reset rule: fixed clock reset (which timezone, e.g. UTC midnight) vs rolling 24h.
- Whether a **quota-exceeded (429)** response — or any API surface — can return the **next reset /
  retry timestamp** for the monthly and daily quotas.
- Can **API-key rotation** ever create a new quota bucket within the same team?
- Does the **Usage dashboard aggregate all sent and received activity across every API key** in the team?
- Can Support identify **why our application recorded 119 successful deliveries while the dashboard
  showed 49**, including the exact period boundaries applied to each counter?

Until human Support answers these, provider monthly/daily accounting stays Unavailable, no
reset-dependent enforcement is active, and the exhaustion-marker remediation above is not implemented.
