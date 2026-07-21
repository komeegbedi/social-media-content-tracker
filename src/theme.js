/* ===================================================================
   Appearance preference — "system" | "light" | "dark".

   - The PREFERENCE (what the user chose) is persisted, not just the
     resolved theme. "system" follows the OS live via matchMedia.
   - localStorage holds the preference for a fast, flash-free boot and as a
     pre-auth fallback; App.jsx mirrors it to the user's Firestore profile so
     it follows them across devices.
   - applyResolved() sets data-theme on <html>; the CSS variables in
     styles.css do the rest. Call initTheme() before first render.
   =================================================================== */
const KEY = "sb-appearance";
const PREFS = ["system", "light", "dark"];

const mql = () =>
  (typeof window !== "undefined" && window.matchMedia)
    ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const osDark = () => { const m = mql(); return m ? m.matches : false; };

// The stored preference (defaults to "system"). Legacy "sb-theme" values
// ("light"/"dark") are honoured once so existing users don't get reset.
export function getThemePref() {
  try {
    const v = localStorage.getItem(KEY);
    if (PREFS.includes(v)) return v;
    const legacy = localStorage.getItem("sb-theme");
    if (legacy === "light" || legacy === "dark") return legacy;
  } catch { /* private mode */ }
  return "system";
}

// Resolve a preference to a concrete theme.
export const resolvePref = (pref) => (pref === "light" || pref === "dark") ? pref : (osDark() ? "dark" : "light");
// The theme currently applied to <html>.
export const resolvedTheme = () => resolvePref(getThemePref());

function applyResolved(theme) {
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-theme", theme);
}

// A brief colour cross-fade on change (skipped under reduced-motion).
let _animTimer;
function crossfade() {
  if (typeof document === "undefined") return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = document.documentElement;
  el.classList.add("theme-anim");
  clearTimeout(_animTimer);
  _animTimer = setTimeout(() => el.classList.remove("theme-anim"), 260);
}

// Subscribers notified when the RESOLVED theme changes (manual set OR an OS
// change while in "system" mode) so React can re-render icons/labels.
const _subs = new Set();
export function subscribeTheme(cb) { _subs.add(cb); return () => _subs.delete(cb); }
function notify() { const t = resolvedTheme(); _subs.forEach((cb) => { try { cb(t); } catch { /* ignore */ } }); }

// The OS listener is attached ONLY while the preference is "system", and
// removed when the user picks Light/Dark (or on teardown).
let _osHandler = null;
function bindOsListener(active) {
  const m = mql();
  if (!m) return;
  if (active && !_osHandler) {
    _osHandler = () => { applyResolved(resolvedTheme()); notify(); };
    m.addEventListener("change", _osHandler);
  } else if (!active && _osHandler) {
    m.removeEventListener("change", _osHandler);
    _osHandler = null;
  }
}

// Set (and persist locally) the appearance preference. Returns the resolved theme.
export function setThemePref(pref) {
  if (!PREFS.includes(pref)) pref = "system";
  try { localStorage.setItem(KEY, pref); localStorage.removeItem("sb-theme"); } catch { /* ignore */ }
  crossfade();
  bindOsListener(pref === "system");
  applyResolved(resolvePref(pref));
  notify();
  return resolvedTheme();
}

// Apply the stored preference before first paint (no flash) and wire the OS
// listener if we're in "system" mode.
export function initTheme() {
  const pref = getThemePref();
  applyResolved(resolvePref(pref));
  bindOsListener(pref === "system");
}

// Remove the OS listener + subscribers (component unmount / teardown).
export function teardownTheme() { bindOsListener(false); _subs.clear(); }
