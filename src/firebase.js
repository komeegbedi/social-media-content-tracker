import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from "firebase/auth";
import { initializeFirestore, connectFirestoreEmulator } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Auto-detect long-polling instead of the default streaming transport. On
// Safari / iOS and flaky mobile networks the streaming channel can get stuck in
// a half-open state after a connection drop; long-polling recovers more
// reliably.
export const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
export const googleProvider = new GoogleAuthProvider();

// Local testing: route Auth + Firestore to the Firebase Emulator Suite.
// Enable with VITE_USE_EMULATOR=true (see README → Local testing).
if (import.meta.env.VITE_USE_EMULATOR === "true") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}
