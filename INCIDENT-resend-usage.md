# P0 Incident — Resend Email Usage shows impossible `3,001 / 3,000`

**Status:** Containment + accounting-unit fixes implemented and fully tested. **Nothing deployed. No production data mutated. No production test email sent.** Each stage below is gated on your explicit authorization.

**Two earlier conclusions were overstated and are now corrected:**
1. The code shows a *mechanism* by which `3000 + 1 → 3001`, but **not** that the header actually contained `3000` or what that header means. Header semantics remain **unproven** (no production response/Firestore history available from this session).
2. `114` being published transactionally as `sentCount + 1` proves **consistency**, not that `114` is the correct *unit*. It has **not** been reconciled against production records, and a message-based safety counter is unsafe if Resend counts each recipient.

---

## 1. Root cause (mechanism — proven from code)

`functions/resendUsage.js` `applyObservation()` computed the monthly total as a monotonic floor with **no plan-capacity validation**:

```js
const monthlyUsed = Math.max(monthlyUsedBeforeSend + units, prevMonthly + units);
```

If `x-resend-monthly-quota` carried a value equal to plan capacity (`3000`) and it was treated as *used-before-send*, `+1` recipient produced `3001`, and `Math.max` latched it permanently. **This explains how the value is reachable; it does not prove the header contained 3000 or means "used".**

## 2. Source of `3,001` — reconciliation REQUIRED (not yet possible here)

Candidate origins: (a) a header value of `3000`; (b) a previously cached `3000` promoted by the local floor; (c) the monotonic `Math.max` latching a one-time bad reading; (d) a replay; (e) another writer. **Distinguishing these requires production access I do not have in this session.** The exact procedure to settle it is in §10. What is certain from code: `3001 > planLimit(3000)` is structurally impossible, so it came from adding to a value already at/above capacity.

## 3. Header semantics — UNPROVEN; interim behavior is "Unavailable"

I will not assert Model A (used) / B (remaining) / C (capacity-only). A value merely inside `[0, planLimit]` is **not** evidence it is a usage count. Until one controlled production observation proves the model, the system now **refuses to interpret the headers as usage** (see Stage 1). To settle it, `functions/emailService.js` logs the allowlisted response headers server-side on every send (`pickDiagnosticHeaders` — quota/rate names only, never auth/cookies/recipients; unit-tested). Fill in §10's table from that log after an authorized send.

## 4. Was email suppressed / were reservations blocked?

- The **usage path never sets exhaustion markers** — only a real `429 quota_exceeded` does. So the poison did not mark the month exhausted.
- The **reserve gate** *did* read the poisoned value while it was fresh (< ~15 min), and `3001 ≥ cap` would deny with `resend_account_limit` — a temporary suppression window (possible terminal `suppressed_quota_limit` deliveries for sends attempted then).
- **Fixed (Stage 1):** `readResendGate` now ignores header-derived usage entirely while semantics are unproven, so the provider header can never block email. Internal safety caps still enforce; real 429 markers still suppress.

## 5. Were exhaustion / threshold alerts wrongly created?

- **Threshold alerts (70/85/95/100):** at `pct = 100` the **100% alert very likely FIRED** from the invalid reading (deduped once per month). Consider it spurious for this month; verify via the `notifyUsers` ids in §7.
- **Durable exhaustion marker:** **not** wrongly set (only a real 429 sets it).
- **Fixed:** with Stage 1, provider observations are never persisted, so no provider-derived alert can fire until semantics are proven.

## 6. Is `114` messages or recipients? — it is **messages**, and that unit was unsafe

`settleReservation` published `appInitiatedThisMonth = sentCount + 1` on each successful send — a **message count**. Resend counts **recipients**. For this app the two coincide *only* because every current send path (`sendNotificationEmail`, `sendDigestEmail`, `sendTest`) targets a **single `to`** — so message-count ≈ recipient-count today. But the counter was structurally wrong for any multi-recipient send, which would under-count against the safety cap that exists to protect the Resend quota.

**Corrected (Stage 2):** the safety cap now reserves/settles/releases in **accepted-recipient units** (§8). The panel label is now **“App safety usage · accepted recipients”**, and the published telemetry carries `unit: "accepted-recipients"`.

**Whether to display messages or recipients:** display **recipients**, because the cap's job is to protect the Resend quota, which is billed/counted per recipient. Displaying messages would let a burst of multi-recipient sends silently approach the real limit while the panel looked calm.

## 7. Corrected data model — two stages, defense in depth

**Stage 1 — Containment (interim: provider usage Unavailable).** A single reviewed constant `HEADER_SEMANTICS_PROVEN = false` (code-only; never an env toggle) disables provider accounting end to end:
- `recordObservedUsage` persists **nothing** (no cache/public/receipt/alert); the diagnostic header log still runs.
- `getResendQuotaUsage` returns `providerAvailable:false`, code `provider-usage-unverified` (telemetry still returned).
- `readResendGate` ignores header-derived usage (no provider-derived suppression).
- Client `presentEmailUsageDoc` shows provider usage only when the server stamps `providerUsageProven` — so any stale/pre-fix doc renders Unavailable.
- Still validated (for when the flag flips): `validateObservation` rejects `used+units > plan`; `cachedUsageValid`; self-healing floor ignores a poisoned `prevMonthly`.

**Stage 2 — Accounting-unit correction.** Safety cap now counts accepted recipients (§8).

## 8. Safety-unit correction (Stage 2) — recipient-atomic reserve/settle

- `quotaUnits(payload)` counts **distinct** recipients across to/cc/bcc, normalized (trim + domain-lowercase) and de-duplicated — matching Resend's per-recipient, dedup accounting.
- `_deliver` computes `units` from the payload **before** reserving (`max(1, quotaUnits)`).
- `reserve({…, units})` reserves `units` atomically; persists `reservedUnits` on the delivery doc.
- `settleReservation` reads `reservedUnits` back and settles/releases **exactly** that many — replay-safe (guarded by `reserved && !settled`), idempotent, legacy single-unit safe.
- `to/cc/bcc` de-dup so the same address counts once.
- Notifications, digests, and test emails all use the same unit definition.

**Migration:** because every current app send targets a single recipient, historical `sentCount` (≈114) already equals the recipient count, so **no reset/migration is required** for the current period; going forward multi-recipient sends count correctly. This should be **confirmed** against production records (§11) before relying on it; if any multi-recipient send occurred this month, label the current period "partial" rather than silently rewriting counts.

## 9. UI fail-safe

Invalid **or** unverified provider data → **"Unavailable"** badge (never green, never a 100% bar), no monthly/daily rows, an honest message, **View in Resend** and app-safety telemetry retained, error code in Technical details. Refresh stays honest (re-reads cache; never contacts Resend).

## 10. Evidence table — to complete after ONE authorized controlled send

Procedure: record the Resend dashboard monthly+daily immediately before; send exactly one email to exactly one recipient; correlate by the hashed delivery id in the `resend response headers (diagnostic)` log; record the allowlisted header names+values; record the dashboard immediately after; determine pre- vs post-send and used/remaining/capacity/throttle.

| Signal  | Dashboard before | Response header (name = value) | Dashboard after | Proven meaning |
|---------|-----------------:|-------------------------------:|----------------:|----------------|
| Monthly |                  |                                |                 |                |
| Daily   |                  |                                |                 |                |

**Do not implement Model A/B/C until this table proves the model.** Only then flip `HEADER_SEMANTICS_PROVEN` (with the correct model + `providerUsageProven` stamping) in a reviewed change.

## 11. Production reconciliation — REQUIRED, needs access I don't have here

I cannot read production Firestore/logs/revisions from this session. Run these (Console or a read-only admin script) and paste results back:

**Poisoned value (§2):**
- `systemUsage/resendQuota` — `monthlyUsed`, `observedAt`, `periodMonth`, `updatedAt`, `alertedThresholds`, exhaustion markers.
- `adminDiagnostics/emailUsage` — provider fields + `internalTelemetry`.
- The `emailDeliveries/{id}` whose `usageAppliedAt` ≈ the poison time — `usageAppliedUnits`, `reserved/settled`.
- The function **revision/commit** live at that timestamp (Cloud Run revision) — confirm it predates this fix.

**`114` (§6), for the current UTC month:** monthly `sentCount`; count of settled `status == "sent"` deliveries; unique delivery ids; sum of `reservedUnits` (recipient units); `failedCount`; suppressed count; released reservations; replays/retries; test emails; and prior-period docs. **Report both** the successful **message** count and the successful **accepted-recipient** count; they should match iff every send was single-recipient.

## 12. Cache-repair plan (documented — dry-run only, NOT executed)

`functions/scripts/repair-resend-usage.js` — dry-run by default; `--commit` requires explicit authorization. Its **dry run reports**: docs it would back up; fields it would clear; **exhaustion markers it inspects** (and whether active this period); **alerts that may have fired** (`alertedThresholds` + the `emailquota_*` notifyUsers ids); **internal telemetry it preserves**; and that it is **idempotent**. It never fabricates a number and never copies the unverified dashboard figure; provider usage becomes "not observed". With Stage 1 deployed, the display is already safe, so repair is optional (reset the panel before the next send, or if no send is expected soon). **Do not run `--commit` until header semantics and the accounting unit are established.**

## 13. Test results (exact)

```
functions   148 pass / 0 fail   (npm run test:functions)
pure        438 pass / 0 fail   (npm test)
UI          159 pass / 0 fail   (npm run test:ui, 14 files)
emulator    226 pass / 0 fail   (node --test --test-concurrency=1 test/*.test.js)
build       ✓ vite               (npm run build)
git diff --check  clean
```
Regression coverage added/updated for every item in your list:
- capacity header `3000` never interpreted as usage without proven semantics (`validateObservation`, containment gate);
- a **bounded but semantically-unknown** value is rejected (containment: `recordObservedUsage` persists nothing; `getResendQuotaUsage` → `provider-usage-unverified`; gate ignores it);
- invalid/unverified provider data cannot suppress email (`readResendGate`, reserve tests);
- a real **429** still suppresses correctly (`quota-suppression` tests, unchanged path);
- one message to **three recipients reserves and settles three** safety units; multi-recipient failure releases all units; concurrent 3-unit sends can't overshoot the cap;
- duplicate/replayed delivery ids don't double-count (usage + safety);
- displayed internal count matches the persisted accounting unit (e2e telemetry + `unit`);
- poisoned/unverified provider data renders **Unavailable** in the UI (component + listener);
- the diagnostic logger exposes **no** sensitive info (`pickDiagnosticHeaders` secrecy test).

## 14. Files changed (by stage)

**Stage 1 — Containment** (safe to ship first):
- `functions/resendUsage.js` — `HEADER_SEMANTICS_PROVEN` gate in `recordObservedUsage` + `getResendQuotaUsage` (injectable `provenSemantics` for tests); validation/self-heal retained.
- `functions/emailQuota.js` — `readResendGate` ignores header-derived usage while unproven.
- `functions/emailService.js` — `pickDiagnosticHeaders` allowlist + server-only diagnostic log.
- `src/emailUsageDoc.js` — client gate on `providerUsageProven`; `provider-usage-unverified`.
- `src/EmailUsage.jsx` — Unavailable badge + message for the unverified state.
- `firestore.rules` — admin-only read of `adminDiagnostics/emailUsage`.
- Tests: `functions/resendUsage.test.js`, `functions/resendPost.test.js`, `src/emailUsageDoc.test.js`, `src/EmailUsage.ui.test.jsx`, `test/resend-usage.test.js`, `test/email-usage-publish.test.js`, `test/email-usage-e2e.test.js`, `test/email-quota.test.js`.

**Stage 2 — Accounting unit** (ship after Stage 1):
- `functions/emailService.js` — `quotaUnits` dedup; `_deliver` computes units before reserve.
- `functions/emailQuota.js` — `reserve` reserves N units + persists `reservedUnits`; `settleReservation` settles/releases N; telemetry in recipient units.
- `src/EmailUsage.jsx` — label “App safety usage · accepted recipients”.
- Tests: `functions/emailService.test.js`, `test/email-quota.test.js`, `test/email-usage-*.test.js`.

**Repair tooling:** `functions/scripts/repair-resend-usage.js` (dry-run).

## 15. Staged deployment & rollback plan (each stage = separate authorization)

- **Stage A — Containment.** Deploy functions + hosting + rules. Effect: panel shows **Unavailable** (honest), provider poison cannot display/suppress/alert; internal safety intact; real 429 still suppresses. **Rollback:** redeploy previous revision; no data migration involved (nothing is written to provider fields).
- **Stage B — Cache repair (optional).** `node functions/scripts/repair-resend-usage.js` (dry-run) → review → `--commit` only if you want the panel reset to "not observed" before the next send. **Rollback:** restore from the `*_backup_<ISO>` docs the script writes.
- **Stage C — Prove semantics.** One controlled single-recipient production send; complete §10 from logs; complete §11 reconciliation. No code ships in this stage.
- **Stage D — Enable proven provider accounting.** Only after C: implement the proven model, set `HEADER_SEMANTICS_PROVEN = true`, stamp `providerUsageProven`. Deploy. **Rollback:** flip the constant back to `false` and redeploy — the read/gate/client all fall back to Unavailable safely.

**Completion criterion (unchanged):** not done until the production panel shows a valid value matching the Resend dashboard after a controlled successful send — or clearly shows provider usage as **unavailable** if Resend exposes no authoritative usage.
