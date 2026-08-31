/* Accessible startup-failure screen, rendered as raw DOM because it must work even when
   React / the app bundle can't safely mount. Theme-aware (reads <html data-theme>, falls
   back to prefers-color-scheme), WCAG-AA contrast, keyboard-focusable, announced via
   role="alert", heading focused on failure. It NEVER exposes internal exception details —
   the caught error is logged elsewhere with a sanitized code, not shown to the user.

   Colours are exported so the contrast ratios are unit-tested. Applied inline so the
   screen renders correctly even if styles.css failed to load. */

// role="alert" containers are announced assertively; these palettes are verified ≥ 4.5:1
// (body/heading vs surface, button text vs button) by bootstrapError.test.jsx.
export const BOOTSTRAP_COLORS = {
  light: { surface: "#ffffff", heading: "#1b1533", body: "#3b3557", btnBg: "#5b46c6", btnText: "#ffffff", focus: "#5b46c6" },
  dark:  { surface: "#141019", heading: "#f4f1fb", body: "#cbc4de", btnBg: "#8f79f2", btnText: "#141019", focus: "#b9a8ff" },
};

export function resolveTheme(doc) {
  try {
    const attr = doc.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
    if (doc.defaultView && doc.defaultView.matchMedia && doc.defaultView.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  } catch { /* fall through */ }
  return "light";
}

/* Render the sign-in bootstrap error. `onRetry` runs a genuine re-attempt (see bootstrap.js).
   Returns the container. `doc` is injectable for tests. */
export function renderBootstrapError({ onRetry, doc = typeof document !== "undefined" ? document : null } = {}) {
  if (!doc) return null;
  const root = doc.getElementById("root") || doc.body;
  if (!root) return null;
  const c = BOOTSTRAP_COLORS[resolveTheme(doc)];

  root.textContent = "";
  const wrap = doc.createElement("div");
  wrap.setAttribute("role", "alert");
  wrap.setAttribute("aria-live", "assertive");
  wrap.style.cssText = `min-height:100vh;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px 24px;text-align:center;background:${c.surface};color:${c.body};font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif`;

  const card = doc.createElement("div");
  card.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:12px;max-width:26rem;width:100%";

  const h = doc.createElement("h1");
  h.textContent = "We couldn’t load the sign-in page";
  h.tabIndex = -1; // focusable programmatically, not in the tab order
  h.style.cssText = `margin:0;font-size:20px;line-height:1.3;font-weight:700;color:${c.heading};outline:none`;

  const p = doc.createElement("p");
  p.textContent = "Check your connection and try again. If the problem continues, contact an administrator.";
  p.style.cssText = `margin:0;font-size:15px;line-height:1.55;color:${c.body}`;

  const btn = doc.createElement("button");
  btn.type = "button";
  btn.textContent = "Try again";
  btn.style.cssText = `margin-top:4px;padding:11px 26px;border-radius:10px;border:none;background:${c.btnBg};color:${c.btnText};font-weight:600;font-size:15px;cursor:pointer`;
  btn.addEventListener("focus", () => { btn.style.boxShadow = `0 0 0 3px ${c.surface}, 0 0 0 5px ${c.focus}`; });
  btn.addEventListener("blur", () => { btn.style.boxShadow = "none"; });
  btn.addEventListener("click", () => { if (typeof onRetry === "function") onRetry(); });

  card.append(h, p, btn);
  wrap.append(card);
  root.append(wrap);
  try { h.focus(); } catch { /* focus best-effort */ }
  return wrap;
}
