import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/* Fail the PRODUCTION build if the Firebase web config is missing. `.env` is gitignored,
   so a build from a fresh checkout/worktree without it would compile an EMPTY firebaseConfig
   and no App Check key — shipping a bundle that fails closed at startup ("Couldn't load the
   sign-in page"). This guard turns that into a loud build-time error instead of a broken
   deploy. Only enforced for `vite build` in production mode; dev/test/emulator are exempt. */
function requireFirebaseConfig() {
  return {
    name: "require-firebase-config",
    config(_config, { command, mode }) {
      if (command !== "build" || mode !== "production") return;
      const env = loadEnv(mode, process.cwd(), "");
      const required = ["VITE_FIREBASE_API_KEY", "VITE_FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_PROJECT_ID", "VITE_FIREBASE_APP_ID"];
      const missing = required.filter((k) => !env[k] || !String(env[k]).trim());
      if (missing.length) {
        throw new Error(
          `Production build aborted — missing Firebase config: ${missing.join(", ")}.\n` +
          `Ensure a populated .env is present in the build directory (it is gitignored, so a clean ` +
          `worktree/CI checkout will not have it). A config-less bundle breaks login at startup.`
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [requireFirebaseConfig(), react()],
});
