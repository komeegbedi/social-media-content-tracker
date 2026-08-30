import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App, { ErrorBoundary } from "./App.jsx";
import { firebaseReady } from "./firebase";
import { initErrorCapture } from "./logging";
import { initTheme } from "./theme";
import { runBootstrap } from "./bootstrap";
import { renderBootstrapError } from "./bootstrapError";
import "./styles.css";

// Apply the saved/system theme + start capturing errors before first render.
initTheme();
initErrorCapture();

// One data router for the whole app, created ONCE outside the render tree.
// A single catch-all route renders the auth gate; the app parses the URL into
// screens + overlays via src/nav.js (the hybrid, URL-as-source-of-truth model)
// rather than a nested <Route> tree. The data router is what enables
// useBlocker (unsaved-form Back guard) further down.
const router = createBrowserRouter(
  [{ path: "*", element: <App /> }],
  { future: { v7_relativeSplatPath: true, v7_normalizeFormMethod: true } }
);

function renderApp() {
  createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <ErrorBoundary>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

// Gate the first render on the bootstrap (Firebase App Check + service construction, see
// firebase.js). Success → the normal app. Hard failure (App Check couldn't load/init, or
// Firebase config is absent) → a readable, accessible fallback whose "Try again" performs a
// genuine fresh attempt. firebaseReady is one-shot, so a reload is the correct re-attempt;
// runBootstrap's own retry (guarded against duplicate attempts) is exercised by tests.
// The caught error is logged with a sanitized code by initErrorCapture — never shown.
runBootstrap({
  attempt: () => firebaseReady,
  mount: renderApp,
  renderError: () => renderBootstrapError({ onRetry: () => window.location.reload() }),
  onError: (e) => { try { console.error("bootstrap failed", e && e.code ? e.code : "startup-error"); } catch { /* noop */ } },
});
