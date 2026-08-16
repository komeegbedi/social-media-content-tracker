/* AdminEvents archive/restore FEEDBACK (rendered). Deterministically proves the
   success + failure UI without a live emulator: a failing restore surfaces a
   role=alert, leaves the record archived (retryable), and never throws unhandled.
   Run: npm run test:ui */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock the Firestore layer so we control whether the write succeeds or fails.
const updateDoc = vi.fn();
vi.mock("./firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  collection: () => ({}), doc: () => ({}), addDoc: vi.fn(), serverTimestamp: () => "ts",
  updateDoc: (...a) => updateDoc(...a),
}));

const { AdminEvents } = await import("./AdminScreen.jsx");

const archivedSeries = [{
  id: "e1", name: "Praise Night", emoji: "🎤", frequency: "monthly-weekday",
  interval: 1, anchorDate: "2026-09-04", active: true, showOnHome: true, archived: true,
}];
const mixedSeries = [
  { id: "e1", name: "Praise Night", frequency: "monthly-weekday", interval: 1, anchorDate: "2026-09-04", active: true, showOnHome: true, archived: true },
  { id: "e2", name: "Youth Vigil", frequency: "monthly-weekday", interval: 1, anchorDate: "2026-09-11", active: true, showOnHome: true, archived: false },
];

beforeEach(() => updateDoc.mockReset());

describe("AdminEvents Active/Archived views", () => {
  test("explicit Active/Archived toggle buttons: aria-pressed states are mutually exclusive, names carry counts", () => {
    render(<AdminEvents series={mixedSeries} />);
    const active = screen.getByRole("button", { name: /Active events \(1\)/ });
    const archived = screen.getByRole("button", { name: /Archived events \(1\)/ });
    // Active is pressed by default; Archived is not (explicit states, not an inverse toggle).
    expect(active).toHaveAttribute("aria-pressed", "true");
    expect(archived).toHaveAttribute("aria-pressed", "false");
    // Selecting Archived flips the pressed states and shows the archived row.
    fireEvent.click(archived);
    expect(screen.getByRole("button", { name: /Archived events \(1\)/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Active events \(1\)/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Praise Night")).toBeInTheDocument();
  });
});

describe("AdminEvents restore feedback", () => {
  test("a FAILED restore shows a role=alert error and keeps the archived row (retryable)", async () => {
    updateDoc.mockRejectedValueOnce(new Error("permission-denied"));
    render(<AdminEvents series={archivedSeries} />);
    fireEvent.click(screen.getByRole("button", { name: /Archived events/ }));       // open Archived view
    const restore = screen.getByRole("button", { name: /Restore event/i });
    fireEvent.click(restore);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn't restore/i);
    // The row is still there and the Restore control is back — the admin can retry.
    expect(screen.getByText("Praise Night")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Restore event/i })).toBeInTheDocument();
  });

  test("a SUCCESSFUL restore shows a status message, not an alert", async () => {
    updateDoc.mockResolvedValueOnce(undefined);
    render(<AdminEvents series={archivedSeries} />);
    fireEvent.click(screen.getByRole("button", { name: /Archived events/ }));
    fireEvent.click(screen.getByRole("button", { name: /Restore event/i }));

    await waitFor(() => expect(screen.getByText(/restored/i)).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();   // success is role=status, not alert
  });
});
