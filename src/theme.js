/* ===================================================================
   Light / dark theme.
   - Default follows the OS (prefers-color-scheme).
   - A manual choice is remembered in localStorage and wins over the OS.
   - applyTheme() sets data-theme on <html>; the CSS variables in styles.css
     do the rest. Call initTheme() before first render to avoid a flash.
   =================================================================== */
const KEY = "sb-theme";
const prefersDark = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

export const getStored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

// The effective theme: an explicit stored choice, else the OS preference.
export function getTheme() {
  const s = getStored();
  if (s === "light" || s === "dark") return s;
  return prefersDark() ? "dark" : "light";
}

function applyTheme(theme) {
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-theme", theme);
}

// A brief colour cross-fade on theme change: add a class to <html> that enables
// colour transitions for ~250ms, then remove it — no permanent transitions and
// no full-page flash. Skipped when the user prefers reduced motion.
let _themeAnimTimer;
function themeCrossfade() {
  if (typeof document === "undefined") return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = document.documentElement;
  el.classList.add("theme-anim");
  clearTimeout(_themeAnimTimer);
  _themeAnimTimer = setTimeout(() => el.classList.remove("theme-anim"), 260);
}

// theme: "light" | "dark" | "system" (system clears the stored override).
export function setTheme(theme) {
  try { theme === "system" ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, theme); } catch { /* ignore */ }
  themeCrossfade();
  applyTheme(getTheme());
  return getTheme();
}

export function initTheme() {
  applyTheme(getTheme());
  // Track OS changes while the user hasn't set an explicit preference.
  if (typeof window !== "undefined") {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (!getStored()) applyTheme(getTheme());
    });
  }
}
