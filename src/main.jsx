import React from "react";
import { createRoot } from "react-dom/client";
import App, { ErrorBoundary } from "./App.jsx";
import { initErrorCapture } from "./logging";
import { initTheme } from "./theme";
import "./styles.css";

// Apply the saved/system theme + start capturing errors before first render.
initTheme();
initErrorCapture();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
