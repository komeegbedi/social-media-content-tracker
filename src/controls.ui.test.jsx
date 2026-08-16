/* Rendered behaviour tests (real DOM, RTL + jsdom) for the shared control
   primitives — NOT regex source guards. Run: npm run test:ui */
import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Toggle, Switch, PasswordField } from "./controls.jsx";

describe("Toggle (labelled switch)", () => {
  test("exposes role=switch with the visible label as its accessible name", () => {
    render(<Toggle label="Available for assignment" v={false} on={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Available for assignment" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveClass("sb-toggle");              // carries the ≥44px min-height rule
  });

  test("aria-checked reflects state and click activates the handler", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<Toggle label="QA reviewer" v={false} on={onToggle} />);
    fireEvent.click(screen.getByRole("switch", { name: "QA reviewer" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<Toggle label="QA reviewer" v={true} on={onToggle} />);
    expect(screen.getByRole("switch", { name: "QA reviewer" })).toHaveAttribute("aria-checked", "true");
  });

  test("activates with the keyboard (Space and Enter) since it is a native button", async () => {
    const onToggle = vi.fn();
    render(<Toggle label="Deprioritize" v={false} on={onToggle} />);
    const sw = screen.getByRole("switch", { name: "Deprioritize" });
    sw.focus();
    await userEvent.keyboard("[Space]");
    await userEvent.keyboard("[Enter]");
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  test("disabled: not activatable", () => {
    const onToggle = vi.fn();
    render(<Toggle label="Locked" v={false} on={onToggle} disabled />);
    const sw = screen.getByRole("switch", { name: "Locked" });
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("Switch (compact)", () => {
  test("role=switch, accessible name from aria-label, toggles, and wraps the compact track", () => {
    const onClick = vi.fn();
    const { container, rerender } = render(<Switch on={false} ariaLabel="Reminder enabled" onClick={onClick} />);
    const sw = screen.getByRole("switch", { name: "Reminder enabled" });
    expect(sw).toHaveClass("sb-swbtn");               // the ≥44px target...
    expect(container.querySelector(".sb-swbtn .sb-sw")).not.toBeNull();  // ...wraps the 40x24 visual track
    fireEvent.click(sw);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Switch on={true} ariaLabel="Reminder enabled" onClick={onClick} />);
    expect(screen.getByRole("switch", { name: "Reminder enabled" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("PasswordField", () => {
  function Harness() {
    const [pw, setPw] = useState("secret123");
    return <PasswordField id="pw" label="Password" required value={pw} autoComplete="current-password" onChange={(e) => setPw(e.target.value)} />;
  }

  test("label is programmatically associated with the input", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Password/);      // resolves via htmlFor/id
    expect(input).toHaveAttribute("id", "pw");
    expect(input).toHaveAttribute("autocomplete", "current-password");
    expect(input).toBeRequired();
  });

  test("reveal toggles type + its accessible name (Show ↔ Hide) and preserves the value", async () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Password/);
    expect(input).toHaveAttribute("type", "password");
    const reveal = screen.getByRole("button", { name: "Show password" });
    await userEvent.click(reveal);
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toBeInTheDocument();
    expect(input).toHaveValue("secret123");               // value preserved across reveal
    await userEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input).toHaveAttribute("type", "password");
  });

  test("paste is NOT blocked (no onPaste preventer)", async () => {
    render(<Harness />);
    const input = screen.getByLabelText(/Password/);
    // jsdom: a paste event is not cancelled by the component
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
