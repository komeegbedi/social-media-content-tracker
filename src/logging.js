/* ===================================================================
   Error logging + issue reporting.

   Everything (auto-captured runtime errors AND user-filed reports) is
   written to the Firestore `issues` collection so admins can review it
   in-app (Admin → Issues). Writes are best-effort: if logging itself
   fails we fall back to the console and never throw, so error handling
   can't cause a second error.
   =================================================================== */
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db, auth } from "./firebase";

// The app is a single page with tab-based navigation (no router), so we track
// the "current view" in a module variable and stamp it onto every issue. The
// UI calls setView() whenever the active screen changes.
let currentView = "login";
export const setView = (v) => { currentView = v; };
export const getView = () => currentView;

// Shared device/context block attached to every issue.
function context() {
  const u = auth.currentUser;
  return {
    uid: u?.uid || "anonymous",
    email: u?.email || "",
    route: currentView,
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    viewport: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : "",
    url: typeof location !== "undefined" ? location.href : "",
  };
}

// Core writer. `kind` is "error" (auto-captured) or "report" (user-filed).
// Returns true on success. Never throws.
export async function logIssue({ kind, message = "", stack = "", action = "", taskId = "", note = "", code = "" }) {
  // We can only write when signed in (rules require it + uid must match).
  if (!auth.currentUser) {
    console.warn("[issue not logged — no signed-in user]", { kind, message, note });
    return false;
  }
  try {
    await addDoc(collection(db, "issues"), {
      kind,
      message: String(message).slice(0, 2000),
      stack: String(stack).slice(0, 6000),
      action: String(action).slice(0, 300),
      code: String(code).slice(0, 200),
      taskId,
      note: String(note).slice(0, 2000),
      status: "open",
      ...context(),
      createdAt: serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.error("[failed to log issue]", e, { kind, message });
    return false;
  }
}

// Convenience for user-filed reports.
export const reportIssue = ({ note, action = "", taskId = "" }) =>
  logIssue({ kind: "report", note, action, taskId });

// Feature requests reuse the issues pipeline (kind: "feature_request") with
// structured fields; rules already scope create-to-own-uid and admin triage.
export async function submitFeatureRequest({ title, description = "", problem = "", beneficiary = "", link = "" }) {
  if (!auth.currentUser) return false;
  try {
    await addDoc(collection(db, "issues"), {
      kind: "feature_request",
      title: String(title).slice(0, 200),
      note: String(title).slice(0, 200),
      description: String(description).slice(0, 2000),
      problem: String(problem).slice(0, 1000),
      beneficiary: String(beneficiary).slice(0, 300),
      link: String(link).slice(0, 500),
      message: "", stack: "", action: "feature request", code: "", taskId: "",
      status: "open",
      sourceVersion: "1.1.2",
      ...context(),
      createdAt: serverTimestamp(),
    });
    return true;
  } catch (e) { console.error("[feature request failed]", e); return false; }
}

// Register global handlers so uncaught errors and unhandled promise
// rejections are captured automatically. Guarded so it only runs once.
let installed = false;
export function initErrorCapture() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (e) => {
    // Cross-origin scripts (browser extensions, Google's sign-in script, etc.)
    // report as an opaque "Script error." with no filename and no Error object
    // — the browser hides all detail for security. These are unactionable and
    // aren't our code, so skip them rather than clutter the Issues log.
    const opaque = !e.error && !e.filename && (!e.message || e.message === "Script error.");
    if (opaque) {
      console.debug("[ignored cross-origin script error]", e.message);
      return;
    }
    logIssue({
      kind: "error",
      message: e.message || "Uncaught error",
      stack: e.error?.stack || "",
      action: "uncaught error",
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    logIssue({
      kind: "error",
      message: reason?.message || String(reason) || "Unhandled promise rejection",
      stack: reason?.stack || "",
      code: reason?.code || "",
      action: "unhandled promise rejection",
    });
  });
}
