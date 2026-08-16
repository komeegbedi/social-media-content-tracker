import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom doesn't implement window.scrollTo — the scroll-lock code (Portal) calls it
// on close, which otherwise prints "Error: Not implemented: window.scrollTo" to
// stderr. Stub it so test output stays clean (behaviour is asserted via inert/lock).
if (!window.scrollTo || !vi.isMockFunction(window.scrollTo)) {
  window.scrollTo = vi.fn();
}

// Unmount and reset the DOM between tests.
afterEach(() => cleanup());
