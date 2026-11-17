/* Anchored menu: placement maths + keyboard/focus/dismissal behaviour.
   Real clipping/positioning is verified in the browser journeys.
   Run: npm run test:ui */
import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import { placeMenu, MenuButton } from "./academyMenu.jsx";

// jsdom has no matchMedia; desktop (non-sheet) layout
if (!window.matchMedia) window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

const vp = { width: 1440, height: 900 };
describe("placeMenu", () => {
  test("opens below when it fits, above when it doesn't, and scrolls itself only when neither side fits", () => {
    const menu = { width: 280, height: 300 };
    expect(placeMenu({ anchor: { top: 100, bottom: 136, left: 40, right: 200 }, menu, viewport: vp })).toMatchObject({ side: "below", top: 140, maxHeight: null });
    const up = placeMenu({ anchor: { top: 800, bottom: 836, left: 40, right: 200 }, menu, viewport: vp });
    expect(up).toMatchObject({ side: "above", maxHeight: null });
    expect(up.top + menu.height).toBeLessThanOrEqual(800);
    const tight = placeMenu({ anchor: { top: 300, bottom: 336, left: 40, right: 200 }, menu: { width: 280, height: 1200 }, viewport: vp });
    expect(tight.side).toBe("below");
    expect(tight.maxHeight).toBeLessThanOrEqual(vp.height - 336);
  });
  test("stays inside the viewport horizontally; end-aligned menus line up with the trigger's end", () => {
    expect(placeMenu({ anchor: { top: 10, bottom: 40, left: 1400, right: 1436 }, menu: { width: 280, height: 100 }, viewport: vp }).left).toBe(1440 - 280 - 8);
    expect(placeMenu({ anchor: { top: 10, bottom: 40, left: 500, right: 536 }, menu: { width: 280, height: 100 }, viewport: vp, align: "end" }).left).toBe(536 - 280);
    expect(placeMenu({ anchor: { top: 10, bottom: 40, left: -20, right: 10 }, menu: { width: 280, height: 100 }, viewport: vp }).left).toBe(8);
  });
});

function Demo({ onPick }) {
  return (
    <div>
      <button>elsewhere</button>
      <div style={{ overflow: "hidden", height: 20 }} data-testid="clipper">
        <MenuButton label="Add content" renderTrigger={({ ref, toggle, props }) => <button ref={ref} onClick={toggle} {...props}>Add content</button>}>
          {(close) => ["Video", "Written lesson", "Exercise"].map((k) => <button key={k} role="menuitem" onClick={() => { close(); onPick(k); }}>{k}</button>)}
        </MenuButton>
      </div>
    </div>
  );
}
const raf = () => act(async () => { await new Promise((r) => requestAnimationFrame(r)); });

describe("AnchoredMenu", () => {
  test("renders in a portal (outside the clipping container), focuses the first item, arrows move focus", async () => {
    render(<Demo onPick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    await raf();
    const menu = screen.getByRole("menu", { name: "Add content" });
    expect(screen.getByTestId("clipper").contains(menu)).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Video" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Written lesson" }));
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Exercise" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Video" }));
    expect(screen.getByRole("button", { name: "Add content" })).toHaveAttribute("aria-expanded", "true");
  });
  test("Escape closes and returns focus to the trigger", async () => {
    render(<Demo onPick={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Add content" });
    fireEvent.click(trigger);
    await raf();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await raf();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
  test("outside click closes without pulling focus back; choosing an item calls it once and closes", async () => {
    const onPick = vi.fn();
    render(<Demo onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    await raf();
    const other = screen.getByRole("button", { name: "elsewhere" });
    fireEvent.pointerDown(other); other.focus();
    await raf();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(other);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    await raf();
    fireEvent.click(screen.getByRole("menuitem", { name: "Exercise" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("Exercise");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
