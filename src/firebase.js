import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from "firebase/auth";
import { initializeFirestore, connectFirestoreEmulator,
  persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);

// App Check (optional hardening): only initializes when a reCAPTCHA v3 site key
// is configured, so local dev and un-provisioned deploys are unaffected. Enforce
// it per-service in the Firebase console once the key is set.
const appCheckKey = import.meta.env.VITE_FIREBASE_APPCHECK_KEY;
if (appCheckKey && typeof window !== "undefined" && import.meta.env.VITE_USE_EMULATOR !== "true") {
  try { initializeAppCheck(app, { provider: new ReCaptchaV3Provider(appCheckKey), isTokenAutoRefreshEnabled: true }); }
  catch { /* non-fatal — app still works without App Check */ }
}

export const auth = getAuth(app);
// Firestore transport + cache:
// - Auto-detect long-polling instead of the default streaming transport. On
//   Safari / iOS and flaky mobile networks the streaming channel can get stuck
//   in a half-open state after a connection drop; long-polling recovers more
//   reliably.
// - Persistent (IndexedDB) local cache in production: after the first visit,
//   data renders INSTANTLY from disk while the server syncs in the background,
//   and it works offline. Disabled against the emulator so re-seeding during
//   dev never shows stale cached data. Falls back gracefully (e.g. private
//   browsing / multiple older tabs) without breaking the app.
const _useEmulator = import.meta.env.VITE_USE_EMULATOR === "true";
export const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
  ...(_useEmulator ? {} : { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }),
});
export const googleProvider = new GoogleAuthProvider();
// Callable Cloud Functions (e.g. the admin email test) — same region as deploy.
export const functions = getFunctions(app, "northamerica-northeast1");

// Local testing: route Auth + Firestore + Functions to the Firebase Emulator Suite.
// Enable with VITE_USE_EMULATOR=true (see README → Local testing).
if (import.meta.env.VITE_USE_EMULATOR === "true") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}
