#!/usr/bin/env node
/* One-shot, idempotent, auditable repair for a POISONED Resend usage cache
   (e.g. a structurally impossible monthlyUsed like 3001 / 3000 latched by the
   pre-validation monotonic floor). See INCIDENT-resend-usage.md.

   SAFETY / DESIGN
     • Read-only by default. Prints what it WOULD do. Pass --commit to write.
     • Backs up BOTH the private cache and the sanitized public doc to
       systemUsage/resendQuota_backup_<ISO> and adminDiagnostics/emailUsage_backup_<ISO>
       BEFORE any mutation.
     • Clears ONLY the corrupted provider fields. It NEVER fabricates a usage number
       and NEVER copies the unverified dashboard figure. Provider usage is set to
       "not observed" so the next VALID send re-establishes the truth (the deployed
       apply Observation now self-heals a poisoned floor, so this is belt-and-suspenders).
     • PRESERVES internal telemetry (appInitiatedThisMonth / appSafetyCap), period keys,
       and alert dedupe state — those are app-owned and were not corrupted.
     • Idempotent: if the cache is already valid, it makes no changes.
     • Does NOT touch exhaustion markers — recordObservedUsage never set them; only a
       real 429 does, and this incident produced none.

   RUN (only after explicit authorization):
     node functions/scripts/repair-resend-usage.js                 # dry run (default)
     node functions/scripts/repair-resend-usage.js --commit        # apply
   Requires GOOGLE_APPLICATION_CREDENTIALS (or `firebase login`) for the prod project. */

const admin = require("firebase-admin");
const { PLAN_MONTHLY_LIMIT, PLAN_DAILY_LIMIT, CACHE_DOC, PUBLIC_DOC } = require("../resendUsage");

const COMMIT = process.argv.includes("--commit");
const isNonNegInt = (n) => Number.isInteger(n) && n >= 0;

function cacheIsPoisoned(d) {
  if (!d) return false;
  const m = Number(d.monthlyUsed), day = Number(d.dailyUsed);
  if (d.monthlyUsed != null && (!isNonNegInt(m) || m > PLAN_MONTHLY_LIMIT)) return true;
  if (d.dailyUsed != null && (!isNonNegInt(day) || day > PLAN_DAILY_LIMIT)) return true;
  return false;
}

(async () => {
  admin.initializeApp();
  const db = admin.firestore();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const cacheRef = db.doc(CACHE_DOC);
  const pubRef = db.doc(PUBLIC_DOC);
  const [cacheSnap, pubSnap] = await Promise.all([cacheRef.get(), pubRef.get()]);
  const cache = cacheSnap.exists ? cacheSnap.data() : null;
  const pub = pubSnap.exists ? pubSnap.data() : null;

  console.log("cache", CACHE_DOC, JSON.stringify(cache));
  console.log("public", PUBLIC_DOC, JSON.stringify(pub));

  if (!cacheIsPoisoned(cache)) {
    console.log("Cache is not poisoned — nothing to repair (idempotent no-op).");
    process.exit(0);
  }

  // Clear ONLY corrupted provider fields; keep app-owned state intact.
  const clearedCache = {
    ...cache,
    monthlyUsed: admin.firestore.FieldValue.delete(),
    dailyUsed: admin.firestore.FieldValue.delete(),
    observedAt: admin.firestore.FieldValue.delete(),
    repairedAt: new Date().toISOString(),
    repairedReason: "invalid-provider-observation (poisoned monthly/daily floor)",
  };
  const clearedPublic = {
    monthly: admin.firestore.FieldValue.delete(),
    daily: admin.firestore.FieldValue.delete(),
    dailyReason: admin.firestore.FieldValue.delete(),
    observedAt: admin.firestore.FieldValue.delete(),
    observedVia: admin.firestore.FieldValue.delete(),
    providerError: { code: "invalid-provider-observation" }, // panel shows "Unavailable"
    // internalTelemetry deliberately left untouched (app-safety row keeps working).
  };

  if (!COMMIT) {
    const period = new Date().toISOString();
    const curMonth = period.slice(0, 7), curDay = period.slice(0, 10);
    console.log("\n===== DRY RUN (no writes) =====");
    console.log("Would BACK UP:");
    console.log("   •", `systemUsage/resendQuota  → systemUsage/resendQuota_backup_${stamp}`);
    console.log("   •", `adminDiagnostics/emailUsage → adminDiagnostics/emailUsage_backup_${stamp}`);
    console.log("Would CLEAR (only corrupted provider fields):");
    console.log("   • cache:  monthlyUsed, dailyUsed, observedAt");
    console.log("   • public: monthly, daily, dailyReason, observedAt, observedVia; set providerError.code=invalid-provider-observation");
    console.log("EXHAUSTION MARKERS inspected (NOT modified — only a real 429 sets these):");
    console.log("   • monthlyExhaustedMonth:", cache.monthlyExhaustedMonth ?? "(none)",
      cache.monthlyExhaustedMonth === curMonth ? "  ⚠ ACTIVE for current month" : "");
    console.log("   • dailyExhaustedDay:", cache.dailyExhaustedDay ?? "(none)",
      cache.dailyExhaustedDay === curDay ? "  ⚠ ACTIVE for today" : "");
    console.log("ALERTS that may have fired from the poisoned value (review notifyUsers docs):");
    console.log("   • alertedThresholds on cache:", JSON.stringify(cache.alertedThresholds ?? []));
    console.log("   • notifyUsers ids to inspect: emailquota_{70,85,95,100}_" + curMonth);
    console.log("INTERNAL TELEMETRY preserved (app-owned, NOT corrupted):");
    console.log("   • public.internalTelemetry:", JSON.stringify(pub && pub.internalTelemetry || null));
    console.log("IDEMPOTENT:", "yes — re-running after repair is a no-op (cache no longer poisoned).");
    console.log("Provider usage will read as 'not observed'; the next VALID send re-establishes it.");
    console.log("\nRe-run with --commit to apply (requires explicit authorization).");
    process.exit(0);
  }

  await db.doc(`systemUsage/resendQuota_backup_${stamp}`).set(cache || {});
  if (pub) await db.doc(`adminDiagnostics/emailUsage_backup_${stamp}`).set(pub);
  await cacheRef.set(clearedCache, { merge: true });
  await pubRef.set(clearedPublic, { merge: true });
  console.log("\nRepair committed. Backups written. Provider usage set to 'not observed';",
    "next valid send re-establishes it.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
