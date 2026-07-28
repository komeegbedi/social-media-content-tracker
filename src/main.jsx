import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App, { ErrorBoundary } from "./App.jsx";
import { firebaseReady } from "./firebase";
import { initErrorCapture } from "./logging";
import { initTheme } from "./theme";
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

// Bootstrap failed CLOSED: App Check is configured but its SDK couldn't load or
// initialize, so Auth/Firestore were never constructed. Do NOT render the normal
// app (its requests would be unattested and rejected under enforcement); show a
// minimal, safe retry screen instead.
function renderBootstrapError() {
  const root = document.getElementById("root");
  if (!root) return;
  root.textContent = "";
  const wrap = document.createElement("div");
  wrap.setAttribute("role", "alert");
  wrap.style.cssText = "min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#211b32";
  const msg = document.createElement("p");
  msg.textContent = "Couldn't start securely. Please check your connection and try again.";
  msg.style.cssText = "margin:0;font-size:15px;max-width:340px;line-height:1.5";
  const btn = document.createElement("button");
  btn.textContent = "Retry";
  btn.style.cssText = "padding:10px 24px;border-radius:10px;border:none;background:#6750c8;color:#fff;font-weight:600;font-size:14px;cursor:pointer";
  btn.addEventListener("click", () => window.location.reload());
  wrap.append(msg, btn);
  root.append(wrap);
}

// Gate the first render on the bootstrap: when App Check is configured, it
// initializes (and Auth/Firestore are constructed) BEFORE React mounts and issues
// any request — no unattested request, no mount-vs-init race. Explicit paths:
// success → normal app; hard App Check failure → bootstrap error screen.
firebaseReady.then(renderApp, renderBootstrapError);
