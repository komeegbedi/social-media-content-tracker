/* Rendered RTL behaviour tests (real DOM under a dir="rtl" ancestor) for the
   extracted, firebase-free primitives — proving direction doesn't break the
   overlay lock lifecycle or a form control's behaviour. Pixel geometry is checked
   live in the browser, not here. Run: npm run test:ui */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PasswordField } from "./controls.jsx";
import { Portal } from "./overlay.jsx";
import { useState } from "react";

beforeEach(() => {
  document.documentElement.setAttribute("dir", "rtl");
  document.body.innerHTML = "";
  const root = document.createElement("div"); root.id = "root"; document.body.appendChild(root);
  window.scrollTo = () => {};
});
afterEach(() => { document.documentElement.removeAttribute("dir"); vi.restoreAllMocks(); });

describe("under dir=rtl", () => {
  test("PasswordField reveal still toggles type + name and preserves the value", async () => {
    function H() { const [v, setV] = useState("secret"); return <PasswordField id="pw" label="Password" value={v} onChange={(e)=>setV(e.target.value)} />; }
    render(<H />);
    const input = screen.getByLabelText(/Password/);
    expect(input).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveValue("secret");
    expect(document.documentElement.dir).toBe("rtl");   // still RTL
  });

  test("a modal Portal still acquires + releases inert/scroll-lock in RTL", () => {
    const root = document.getElementById("root");
    function Dlg({ open }) { return open ? <Portal modal><div role="dialog" aria-modal="true" aria-label="X"><button>ok</button></div></Portal> : null; }
    const { rerender } = render(<Dlg open />, { container: root, baseElement: document.body });
    expect(root.hasAttribute("inert")).toBe(true);
    expect(document.body.style.position).toBe("fixed");
    rerender(<Dlg open={false} />);
    expect(root.hasAttribute("inert")).toBe(false);
    expect(document.body.style.position).toBe("");
  });
});
