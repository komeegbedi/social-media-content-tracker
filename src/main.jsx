import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App, { ErrorBoundary } from "./App.jsx";
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

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </ErrorBoundary>
  </React.StrictMode>
);
