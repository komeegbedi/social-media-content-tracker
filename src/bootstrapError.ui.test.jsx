/* Accessible startup-error screen — copy, semantics, focus, retry, theme, WCAG contrast,
   and no leakage of internal exception details. Run: npm run test:ui */
import { describe, test, expect, beforeEach, vi } from "vitest";
import { renderBootstrapError, resolveTheme, BOOTSTRAP_COLORS } from "./bootstrapError.js";

// WCAG 2.1 relative-luminance contrast ratio for two #rrggbb colors.
function contrast(a, b) {
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = '<div id="root"></div>';
});

describe("bootstrap error UI", () => {
  test("renders the specified heading, body, and button copy", () => {
    renderBootstrapError({ onRetry: () => {} });
    expect(document.querySelector("h1").textContent).toMatch(/We couldn.t load the sign-in page/);
    expect(document.body.textContent).toMatch(/Check your connection and try again\. If the problem continues, contact an administrator\./);
    const btn = document.querySelector("button");
    expect(btn.textContent).toBe("Try again");
    expect(btn.getAttribute("type")).toBe("button");
  });

  test("is announced (role=alert, aria-live=assertive) and focuses the heading", () => {
    renderBootstrapError({ onRetry: () => {} });
    const wrap = document.querySelector('[role="alert"]');
    expect(wrap).toBeTruthy();
    expect(wrap.getAttribute("aria-live")).toBe("assertive");
    expect(document.activeElement).toBe(document.querySelector("h1"));
  });

  test("Try again invokes onRetry", () => {
    const onRetry = vi.fn();
    renderBootstrapError({ onRetry });
    document.querySelector("button").click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("does NOT expose internal exception details", () => {
    renderBootstrapError({ onRetry: () => {} }); // error is logged elsewhere, never passed in
    const t = document.body.textContent;
    for (const bad of ["Error", "stack", "undefined", "TypeError", "Firebase:", "appCheck"]) {
      expect(t).not.toContain(bad);
    }
  });

  test("theme-aware: data-theme=dark uses the dark palette", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    expect(resolveTheme(document)).toBe("dark");
    renderBootstrapError({ onRetry: () => {} });
    const wrap = document.querySelector('[role="alert"]');
    expect(wrap.style.background.replace(/\s/g, "")).toBe("rgb(20,16,25)"); // #141019
  });

  test("colours meet WCAG AA (>= 4.5:1) in both themes", () => {
    for (const theme of ["light", "dark"]) {
      const c = BOOTSTRAP_COLORS[theme];
      expect(contrast(c.heading, c.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.body, c.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.btnText, c.btnBg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
