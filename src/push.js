/* ===================================================================
   Web push (Firebase Cloud Messaging) — client side.

   Requests permission (only after the user opts in), fetches an FCM
   token, and stores it under users/{uid}/fcmTokens so the backend can
   deliver push. iOS/iPadOS only allow web push for apps added to the
   Home Screen, so we detect that and guide the user first.
   =================================================================== */
import { getMessaging, getToken, onMessage, isSupported } from "firebase/messaging";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { app, db } from "./firebase";
import { logIssue } from "./logging";

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY || "";
const SW_URL = "/firebase-messaging-sw.js";

// Public web config, forwarded to the service worker via query string.
const swConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export function isIOS() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    // iPadOS 13+ reports as desktop Safari but has touch points.
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
export function isStandalone() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
const permission = () => (typeof Notification !== "undefined" ? Notification.permission : "unsupported");

let _supported = null;
async function pushSupported() {
  if (_supported !== null) return _supported;
  try { _supported = (await isSupported()) && "serviceWorker" in navigator && "Notification" in window; }
  catch { _supported = false; }
  return _supported;
}

/* The device's push availability, driving which UI to show:
   "ios-needs-install" | "unsupported" | "not-configured" | "default" | "granted" | "denied" */
export async function pushState() {
  if (isIOS() && !isStandalone()) return "ios-needs-install";
  if (!(await pushSupported())) return "unsupported";
  if (!VAPID_KEY) return "not-configured";
  return permission();
}

async function registerSW() {
  const qs = new URLSearchParams(swConfig).toString();
  return navigator.serviceWorker.register(`${SW_URL}?${qs}`, { scope: "/" });
}

/* Ask permission, get an FCM token, and store it for this device.
   Returns { ok, reason?, token? }. */
export async function enablePush(uid) {
  if (!VAPID_KEY) return { ok: false, reason: "not-configured" };
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: perm };
    const reg = await registerSW();
    const token = await getToken(getMessaging(app), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) return { ok: false, reason: "no-token" };
    await setDoc(doc(db, "users", uid, "fcmTokens", token), {
      token, ua: (navigator.userAgent || "").slice(0, 300),
      createdAt: serverTimestamp(), lastSeen: serverTimestamp(),
    }, { merge: true });
    return { ok: true, token };
  } catch (e) {
    logIssue({ kind: "error", action: "enable push", message: e.message, code: e.code });
    return { ok: false, reason: "error" };
  }
}

// Foreground messages (app open) → surface via callback. Safe no-op if unsupported.
export async function listenForeground(cb) {
  if (!(await pushSupported())) return () => {};
  try { return onMessage(getMessaging(app), cb); }
  catch { return () => {}; }
}
