import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/* Component/interaction tests (React Testing Library + jsdom).
   Kept separate from the node --test suite: only *.ui.test.jsx files run here,
   so the two runners never trip over each other. */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.ui.test.jsx"],
    setupFiles: ["./src/test-setup.js"],
  },
});
