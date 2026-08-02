import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from "firebase/auth";
import { initializeFirestore, connectFirestoreEmulator,
  persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { memoizeImport, appCheckPlan, bootstrapFirebase } from "./firebaseBootstrap";
// firebase/functions, firebase/messaging AND firebase/app-check are all loaded
// dynamically (getFunctionsInstance/callFunction, push.js, and the bootstrap
// below), so they stay out of the initial bundle — app-check only loads when a
// reCAPTCHA key is configured.

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
const _useEmulator = import.meta.env.VITE_USE_EMULATOR === "true";
const _appCheckKey = import.meta.env.VITE_FIREBASE_APPCHECK_KEY;

// Auth + Firestore are LIVE BINDINGS assigned only AFTER App Check init (in the
// bootstrap below), so no attested service is constructed before attestation
// exists. Importers get live bindings; no consumer runs before firebaseReady
// resolves (main.jsx gates rendering on it), so these are always assigned by use.
export let auth;
export let db;
export const googleProvider = new GoogleAuthProvider();

function constructServices() {
  auth = getAuth(app);
  // Firestore transport + cache:
  // - Auto-detect long-polling (Safari/iOS + flaky networks recover more reliably).
  // - Persistent (IndexedDB) local cache in production for instant, offline-capable
  //   loads; disabled against the emulator so re-seeding never shows stale data.
  db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    ...(_useEmulator ? {} : { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }),
  });
  if (_useEmulator) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }
}

/* Startup bootstrap — the promise main.jsx renders behind.

   When a reCAPTCHA key is configured we dynamically import firebase/app-check and
   initialize it BEFORE constructing Auth/Firestore, so no request is ever
   unattested. FAIL-CLOSED: if the app-check chunk can't load or initializeAppCheck
   throws, this REJECTS and Auth/Firestore are never constructed — main.jsx shows a
   bootstrap error screen (the app never mounts). A first-token blip is soft: the
   SDK is initialized and retries per request, so we proceed and render.

   No key / emulator → nothing to attest; services construct and it resolves fast.

   Debug provider: VITE_FIREBASE_APPCHECK_DEBUG=true uses App Check's debug token in
   a real (non-emulator) dev/staging build — PRINTED TO THE CONSOLE for you to
   register in the Firebase console, never hard-coded/committed. */
const _plan = appCheckPlan({
  key: _appCheckKey, useEmulator: _useEmulator,
  hasWindow: typeof window !== "undefined",
  debug: import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG === "true",
});
export const firebaseReady = bootstrapFirebase(_plan, {
  setDebug: () => { self.FIREBASE_APPCHECK_DEBUG_TOKEN = true; },
  loadAppCheck: () => import("firebase/app-check"),
  initAppCheck: (m) => m.initializeAppCheck(app, { provider: new m.ReCaptchaV3Provider(_appCheckKey), isTokenAutoRefreshEnabled: true }),
  firstToken: (m, ac) => m.getToken(ac, false),
  onTokenWarn: (e) => { try { console.warn("App Check first token failed; the SDK will retry per request.", e && e.message); } catch {} },
  constructServices,
});

/* Callable Cloud Functions — loaded on first use so firebase/functions stays out
   of the initial bundle. Memoized on success; a failed import isn't cached, so a
   retry re-imports. */
export const getFunctionsInstance = memoizeImport(async () => {
  const { getFunctions, connectFunctionsEmulator } = await import("firebase/functions");
  const fns = getFunctions(app, "northamerica-northeast1");
  if (_useEmulator) connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  return fns;
});

/* Invoke a callable, loading firebase/functions (getFunctions AND httpsCallable)
   on demand. httpsCallable must be imported here too — importing it statically
   anywhere pulls the whole functions SDK into the initial bundle. Rejections
   propagate unchanged (same HttpsError .code the callers already map). */
export async function callFunction(name, payload) {
  const [{ httpsCallable }, fns] = await Promise.all([import("firebase/functions"), getFunctionsInstance()]);
  return httpsCallable(fns, name)(payload);
}
