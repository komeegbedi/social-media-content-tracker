/* Loading primitives — accessibility + behaviour contracts (src/loading.jsx).
   Run: npm run test:ui */
import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BusyButton, Progress, Spinner, Skeleton } from "./loading.jsx";

describe("BusyButton", () => {
  test("resting: normal button, no aria-busy, action label readable", () => {
    render(<BusyButton onClick={() => {}}>Send request</BusyButton>);
    const btn = screen.getByRole("button", { name: "Send request" });
    expect(btn).not.toHaveAttribute("aria-busy");
    expect(btn).not.toBeDisabled();
  });

  test("busy: aria-busy=true, disabled (no repeat submit), action label still exposed to AT", () => {
    render(<BusyButton busy busyLabel="Sending…" actionLabel="Send request" onClick={() => {}}>Send request</BusyButton>);
    // Accessible name is the ACTION, not the transient busy word.
    const btn = screen.getByRole("button", { name: "Send request" });
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toBeDisabled();
    // The visible busy word is present but hidden from the a11y tree.
    expect(screen.getByText("Sending…")).toBeInTheDocument();
  });

  test("busy prevents the click handler from firing again (disabled)", () => {
    const onClick = vi.fn();
    render(<BusyButton busy busyLabel="Saving…" actionLabel="Save" onClick={onClick}>Save</BusyButton>);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  test("never collapses to icon-only: the resting label stays in the DOM while busy (width holder)", () => {
    const { container } = render(
      <BusyButton busy busyLabel="Importing…" actionLabel="Import 48 tasks" onClick={() => {}}>Import 48 tasks</BusyButton>);
    const label = container.querySelector(".sb-busybtn-label");
    expect(label).not.toBeNull();
    expect(label.textContent).toBe("Import 48 tasks"); // present → holds width, not removed
  });

  test("error recovery: flipping busy back to false restores the original control", () => {
    const { rerender } = render(<BusyButton busy actionLabel="Save" busyLabel="Saving…">Save</BusyButton>);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    rerender(<BusyButton busy={false} actionLabel="Save" busyLabel="Saving…">Save</BusyButton>);
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute("aria-busy");
  });
});

describe("Progress (determinate)", () => {
  test("exposes progressbar semantics: valuemin/max/now + human valuetext + visible text", () => {
    render(<Progress value={12} max={48} label="Importing 12 of 48" />);
    const bar = screen.getByRole("progressbar", { name: "Importing 12 of 48" });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "48");
    expect(bar).toHaveAttribute("aria-valuenow", "12");
    expect(bar).toHaveAttribute("aria-valuetext", "Importing 12 of 48");
    // VISIBLE progress text (not only ARIA)
    expect(screen.getByText("Importing 12 of 48")).toBeInTheDocument();
  });

  test("fill width tracks the ratio and clamps at 100%; valuenow never exceeds max", () => {
    const { container, rerender } = render(<Progress value={24} max={48} label="24 of 48" />);
    expect(container.querySelector(".sb-loadprogress-fill").style.width).toBe("50%");
    rerender(<Progress value={60} max={48} label="done" />);
    const bar = screen.getByRole("progressbar");
    expect(container.querySelector(".sb-loadprogress-fill").style.width).toBe("100%");
    // over-reported value is clamped for aria-valuenow, not just visually
    expect(bar).toHaveAttribute("aria-valuenow", "48");
    expect(bar).toHaveAttribute("aria-valuemax", "48");
  });

  test("surfaces a failure count when provided", () => {
    render(<Progress value={10} max={48} label="Importing 10 of 48" note="2 failed" tone="error" />);
    expect(screen.getByText("2 failed")).toBeInTheDocument();
  });

  test("guards divide-by-zero (max 0 → 0%, valuemax 0 intentional)", () => {
    const { container } = render(<Progress value={0} max={0} label="Preparing…" />);
    expect(container.querySelector(".sb-loadprogress-fill").style.width).toBe("0%");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "0");
  });
});

describe("Spinner", () => {
  test("decorative by default (aria-hidden, no role)", () => {
    const { container } = render(<Spinner />);
    const s = container.querySelector(".sb-spin-inline");
    expect(s).toHaveAttribute("aria-hidden", "true");
    expect(s).not.toHaveAttribute("role");
  });
  test("labelled → announces itself as a status", () => {
    render(<Spinner label="Loading" />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });
});

describe("Skeleton", () => {
  test("renders the requested number of placeholder lines, hidden from AT", () => {
    const { container } = render(<Skeleton lines={4} />);
    expect(container.querySelector(".sb-skel")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll(".sb-skel-line")).toHaveLength(4);
  });
});
