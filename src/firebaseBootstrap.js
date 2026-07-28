/* ===================================================================
   Pure helpers for deferring optional Firebase services.

   No SDK imports here, so this is unit-testable without a browser or a live
   Firebase app. The real wiring (which SDK modules to import, how to init) lives
   in firebase.js / push.js and injects its side effects into these.
   =================================================================== */

// Memoize a dynamic import's SUCCESS. A rejection is NOT cached, so a
// retry/reload can re-attempt (e.g. a chunk that failed to load once offline).
// Concurrent callers share the single in-flight promise.
export function memoizeImport(loader) {
  let promise = null;
  const get = () => {
    if (!promise) promise = Promise.resolve().then(loader).catch((e) => { promise = null; throw e; });
    return promise;
  };
  get.reset = () => { promise = null; }; // test hook
  return get;
}

// Decide whether/how to initialize App Check from the environment. Pure.
//   { init:false, reason } | { init:true, debug }
export function appCheckPlan({ key, useEmulator, hasWindow, debug }) {
  if (!hasWindow) return { init: false, reason: "no-window" };
  if (useEmulator) return { init: false, reason: "emulator" };       // emulator doesn't enforce App Check
  if (!key) return { init: false, reason: "no-key" };                // nothing configured → don't load the chunk
  return { init: true, debug: !!debug };
}

// Startup bootstrap: initialize App Check FIRST (when configured), THEN construct
// Auth/Firestore — so no attested service is even built before attestation exists
// (Firebase's own requirement). firebase/app-check is dynamically imported, so it
// stays out of the initial bundle and never loads when no key is configured.
// Fail-closed semantics:
//   - plan.init false → constructServices() runs (nothing to attest).
//   - loadAppCheck / initAppCheck throw (chunk can't load / init fails) → the error
//     PROPAGATES and constructServices is NEVER called: main renders a bootstrap
//     error screen, the app never mounts, and no unattested request is issued.
//   - firstToken fetch rejects → SOFT: the SDK is initialized and retries a token
//     per request; onTokenWarn fires and we still constructServices (render normally).
// Deps: { setDebug, loadAppCheck, initAppCheck, firstToken, onTokenWarn, constructServices }.
export async function bootstrapFirebase(plan, deps) {
  if (plan.init) {
    if (plan.debug) deps.setDebug();
    const mod = await deps.loadAppCheck();       // hard — throws before any service is built
    const instance = deps.initAppCheck(mod);     // hard — throws before any service is built
    try { await deps.firstToken(mod, instance); }
    catch (e) { if (deps.onTokenWarn) deps.onTokenWarn(e); } // soft — SDK is live, retries per request
  }
  deps.constructServices();                       // Auth + Firestore, AFTER App Check init
}

// Push should only load the Messaging SDK when it can actually deliver: a VAPID
// key is configured, the browser supports it, AND permission is already granted.
// This keeps the Messaging chunk off ordinary authenticated startup. Pure.
export function pushEnabled({ hasVapid, supported, permission }) {
  return !!hasVapid && !!supported && permission === "granted";
}

// The device's push availability, from already-resolved feature flags. Pure.
export function pushAvailability({ iosNeedsInstall, supported, hasVapid, permission }) {
  if (iosNeedsInstall) return "ios-needs-install";
  if (!supported) return "unsupported";
  if (!hasVapid) return "not-configured";
  return permission; // "default" | "granted" | "denied"
}

// Set up a subscription whose module loads asynchronously (deferred import), while
// returning a SYNCHRONOUS cleanup immediately. If cleanup runs before the async
// subscription is ready, the subscription is torn down as soon as it resolves —
// no leak when a component unmounts during the import. `setup` resolves to the
// SDK's unsubscribe fn (or null/undefined when there's nothing to subscribe to).
export function foregroundSubscription(setup) {
  let unsub = null;
  let cancelled = false;
  Promise.resolve().then(setup).then((u) => {
    if (cancelled) { if (typeof u === "function") u(); }  // unmounted before ready → tear down now
    else unsub = u;
  }).catch(() => {});
  return () => { cancelled = true; if (typeof unsub === "function") { unsub(); unsub = null; } };
}
