/* Regression tests for the lazy-screen loading fallback ("Loading Admin…").
   Locks in the centering fix: reusable class, no inline offset styles, accessible.
   Run: npm run test:ui */
import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ScreenFallback from "./ScreenFallback.jsx";

describe("ScreenFallback", () => {
  test("is an accessible status announcing the labelled loading state", () => {
    render(<ScreenFallback label="Admin" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/^Loading Admin…$/);
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  test("centers via the reusable class — NOT inline offset styles (the bug)", () => {
    render(<ScreenFallback label="Admin" />);
    const status = screen.getByRole("status");
    expect(status).toHaveClass("sb-screen-loading");
    // The previous bug centered with inline styles; there must be no inline layout now.
    expect(status.getAttribute("style")).toBeNull();
  });

  test("the spinner is decorative and has no inline positioning", () => {
    render(<ScreenFallback label="Admin" />);
    const spin = screen.getByRole("status").querySelector(".sb-spin");
    expect(spin).toBeTruthy();
    expect(spin).toHaveAttribute("aria-hidden", "true");
    expect(spin.getAttribute("style")).toBeNull();
  });

  test("falls back to a bare 'Loading…' with no label", () => {
    render(<ScreenFallback />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Loading…$/);
  });
});
