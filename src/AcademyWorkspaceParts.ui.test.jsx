/* Authoring workspace building blocks (RTL + jsdom): keyboard reordering with
   undo-able results, the formatting toolbar (no Markdown knowledge needed),
   and resource links (URL first, fallback names, custom names kept).
   Pointer drag is covered in the real-browser journeys. Run: npm run test:ui */
import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React, { useState } from "react";

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn() }));
const fetchLinkMetadata = vi.fn();
vi.mock("./academyData.js", () => ({
  fetchLinkMetadata: (...a) => fetchLinkMetadata(...a),
  loadCourseWorkspace: vi.fn(), saveCourseDraft: vi.fn(), cleanupDraftImages: vi.fn(), useDraftHead: () => ({ data: null }),
  useImageUrl: () => ({ url: null, error: false }),
}));

import { SortableList, DragHandle } from "./academySortable.jsx";
import { RichTextField, LinkList, saveErrorText } from "./academyWorkspaceParts.jsx";
import { markdownToHtml } from "./academyRichText.js";
if (!window.matchMedia) window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
import { moveId, outlineRows, outlineSpan, outlineCanDrop, moduleIndexFromSlot, moveModule } from "./academyOrder.js";

function List({ initial, onMoved }) {
  const [items, setItems] = useState(initial.map((t) => ({ id: t, t })));
  return (
    <SortableList items={items} getLabel={(x) => x.t} onMove={(id, to) => { const ids = moveId(items.map((x) => x.id), id, to); setItems(ids.map((i) => items.find((x) => x.id === i))); onMoved?.(ids); }}
      renderItem={(x, { handle }) => <div><DragHandle handle={handle} /><span data-testid="row">{x.t}</span></div>} />
  );
}
const rows = () => screen.getAllByTestId("row").map((e) => e.textContent);

describe("SortableList — keyboard", () => {
  test("Space lifts, arrows move, Space drops; the move is announced and reported by stable id", () => {
    const onMoved = vi.fn();
    render(<List initial={["A", "B", "C", "D"]} onMoved={onMoved} />);
    const handle = screen.getAllByRole("button")[3];            // D's handle
    expect(handle).toHaveAttribute("aria-describedby");
    handle.focus();
    fireEvent.keyDown(handle, { key: " " });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: " " });
    expect(rows()).toEqual(["D", "A", "B", "C"]);
    expect(onMoved).toHaveBeenCalledWith(["D", "A", "B", "C"]);
    expect(screen.getByRole("status").textContent).toMatch(/D/);
  });
  test("Escape cancels a lifted item without moving it", () => {
    render(<List initial={["A", "B", "C"]} />);
    const handle = screen.getAllByRole("button")[0];
    handle.focus();
    fireEvent.keyDown(handle, { key: " " });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    fireEvent.keyDown(handle, { key: "Escape" });
    expect(rows()).toEqual(["A", "B", "C"]);
  });
});

function Outline({ onModules }) {
  const [mods, setMods] = useState([{ id: "m1", title: "Basics", lessonIds: ["a", "b"] }, { id: "m2", title: "More", lessonIds: ["c"] }]);
  const rows = outlineRows(mods, { showHeaders: true });
  return (
    <SortableList items={rows} getLabel={(r) => r.type === "module" ? r.title : r.id} spanOf={(r, i, all) => outlineSpan(all, i)} canDropAt={outlineCanDrop}
      onMove={(id, slot) => { const r = rows.find((x) => x.id === id); if (r.type !== "module") return; const next = moveModule(mods, r.moduleId, moduleIndexFromSlot(rows, r.moduleId, slot)); setMods(next); onModules(next); }}
      renderItem={(r, { handle }) => <div><DragHandle handle={handle} /><span data-testid="row">{r.type === "module" ? `#${r.title}` : r.id}</span></div>} />
  );
}
describe("SortableList — section blocks", () => {
  test("a section moves with all its items, only to section boundaries (keyboard)", () => {
    const onModules = vi.fn();
    render(<Outline onModules={onModules} />);
    const handle = screen.getByRole("button", { name: "Reorder More" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(screen.getByRole("status").textContent).toMatch(/and its 1 item/);
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });            // already at the first allowed slot
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(rows()).toEqual(["#More", "c", "#Basics", "a", "b"]);
    expect(onModules.mock.calls[0][0].map((m) => m.lessonIds)).toEqual([["c"], ["a", "b"]]);   // same ids, membership intact
  });
  test("dropping where it started reports no move", () => {
    const onModules = vi.fn();
    render(<Outline onModules={onModules} />);
    const handle = screen.getByRole("button", { name: "Reorder Basics" });
    handle.focus();
    fireEvent.keyDown(handle, { key: " " });
    fireEvent.keyDown(handle, { key: " " });
    expect(onModules).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(/not moved/);
  });
});

function Rich({ initial = "", format: initialFormat = 2, onChange }) {
  const [v, setV] = useState(initial);
  const [fmt, setFmt] = useState(initialFormat);
  return <><RichTextField id="rt" label="Lesson text" value={v} format={fmt} onChange={(x, f) => { setV(x); setFmt(f); onChange?.(x, f); }} />
    <output data-testid="md">{v}</output><output data-testid="fmt">{fmt}</output></>;
}
describe("RichTextField (visual editor + labelled source view)", () => {
  test("formatted by default: existing Markdown renders as formatting, no raw # or ** — and opening it writes nothing", () => {
    const onChange = vi.fn();
    render(<Rich initial={"# Setup\n\nUse **one** light.\n\n- key\n- fill"} format={1} onChange={onChange} />);
    const ed = screen.getByRole("textbox", { name: "Lesson text" });
    expect(ed).toHaveAttribute("contenteditable", "true");
    expect(ed.querySelector("h3").textContent).toBe("Setup");
    expect(ed.querySelector("strong").textContent).toBe("one");
    expect(ed.querySelectorAll("li")).toHaveLength(2);
    expect(ed.textContent).not.toMatch(/\*\*|#/);
    expect(onChange).not.toHaveBeenCalled();
    for (const name of ["Bold (Ctrl+B)", "Italic (Ctrl+I)", "Heading", "Bulleted list", "Numbered list", "Link (Ctrl+K)"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });
  test("typing in the formatted view stores the same safe Markdown subset", () => {
    const onChange = vi.fn();
    render(<Rich onChange={onChange} />);
    const ed = screen.getByRole("textbox", { name: "Lesson text" });
    ed.innerHTML = "<p>Hello <b>bold</b> <a href=\"https://example.com/x\">guide</a></p><ul><li>one</li></ul><p><a href=\"javascript:alert(1)\">bad</a></p>";
    fireEvent.input(ed);
    expect(onChange).toHaveBeenLastCalledWith("Hello **bold** [guide](https://example.com/x)\n\n- one\n\nbad", 2);
  });
  test("text the visual view can't show exactly opens in the Markdown source view, unchanged, and stays there", () => {
    const tricky = "See [the form](mailto:team@example.org) for details.";
    const onChange = vi.fn();
    render(<Rich initial={tricky} format={1} onChange={onChange} />);
    const ta = screen.getByRole("textbox", { name: "Lesson text" });
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta.value).toBe(tricky);
    expect(screen.getByText(/stays exactly as written|exactly as written/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to formatted view" }));
    expect(screen.getByRole("textbox", { name: "Lesson text" }).tagName).toBe("TEXTAREA");
    expect(screen.getByText(/stays in source view/)).toHaveAttribute("role", "status");
    expect(onChange).not.toHaveBeenCalled();
  });
  test("source view is secondary and explicit; switching back renders the edit", () => {
    render(<Rich initial="Plain words" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
    const ta = screen.getByRole("textbox", { name: "Lesson text" });
    fireEvent.change(ta, { target: { value: "Plain **strong** words" } });
    expect(screen.getByTestId("md").textContent).toBe("Plain **strong** words");
    fireEvent.click(screen.getByRole("button", { name: "Back to formatted view" }));
    expect(screen.getByRole("textbox", { name: "Lesson text" }).querySelector("strong").textContent).toBe("strong");
  });
  test("literal characters typed in the formatted view stay literal through source view and back", () => {
    const onChange = vi.fn();
    render(<Rich onChange={onChange} />);
    let ed = screen.getByRole("textbox", { name: "Lesson text" });
    ed.innerHTML = "<p>Rate it *5 stars* or [skip] — snake_case `ok`</p>";
    fireEvent.input(ed);
    const md = onChange.mock.lastCall[0];
    expect(md).toBe("Rate it \\*5 stars\\* or \\[skip\\] — snake\\_case \\`ok\\`");
    fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
    expect(screen.getByRole("textbox", { name: "Lesson text" }).value).toBe(md);
    fireEvent.click(screen.getByRole("button", { name: "Back to formatted view" }));
    ed = screen.getByRole("textbox", { name: "Lesson text" });
    expect(ed.textContent).toBe("Rate it *5 stars* or [skip] — snake_case `ok`");
    expect(ed.querySelector("em,strong,code,a")).toBeNull();
  });
  test("formatting applied in source view shows as formatting in the visual view (and vice versa stays stable)", () => {
    const onChange = vi.fn();
    render(<Rich initial="Plain" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Lesson text" }), { target: { value: "**Bold** and \\*literal\\* [link](https://example.com)" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to formatted view" }));
    const ed = screen.getByRole("textbox", { name: "Lesson text" });
    expect(ed.querySelector("strong").textContent).toBe("Bold");
    expect(ed.querySelector("a").getAttribute("href")).toBe("https://example.com");
    expect(ed.textContent).toBe("Bold and *literal* link");
    fireEvent.input(ed);                                                    // re-save from visual: identical
    expect(onChange.mock.lastCall[0]).toBe("**Bold** and \\*literal\\* [link](https://example.com)");
  });
  test("LEGACY text with backslashes: shows exactly as before; opening, focusing and blurring write nothing", () => {
    const onChange = vi.fn();
    render(<Rich initial={"Save to C:\\Users\\me — type \\* to multiply"} format={1} onChange={onChange} />);
    const ed = screen.getByRole("textbox", { name: "Lesson text" });
    expect(ed.textContent).toBe("Save to C:\\Users\\me — type \\* to multiply");
    fireEvent.focus(ed); fireEvent.blur(ed);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("fmt").textContent).toBe("1");
  });
  test("LEGACY text edited in the visual view is converted to v2 with the same visible meaning", () => {
    const onChange = vi.fn();
    render(<Rich initial={"# Learn C#\n\nPath C:\\Users and *styled*"} format={1} onChange={onChange} />);
    const ed = screen.getByRole("textbox", { name: "Lesson text" });
    const before = ed.innerHTML;
    expect(ed.querySelector("h3").textContent).toBe("Learn C");               // the legacy rule, as learners see it today
    fireEvent.input(ed);                                                      // an edit (no visible change)
    const [md, fmt] = onChange.mock.lastCall;
    expect(fmt).toBe(2);
    const reopened = document.createElement("div"); reopened.innerHTML = markdownToHtml(md, 2);
    expect(reopened.innerHTML).toBe(before);                                 // identical rendering after conversion
  });
  test("LEGACY text edited in SOURCE view keeps its format (meaning unchanged); switching views preserves text and formatting", () => {
    const onChange = vi.fn();
    render(<Rich initial={"Use \\* for **bold** notes"} format={1} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
    const ta = screen.getByRole("textbox", { name: "Lesson text" });
    expect(ta.value).toBe("Use \\* for **bold** notes");
    fireEvent.change(ta, { target: { value: "Use \\* for **bold** notes!" } });
    expect(onChange.mock.lastCall).toEqual(["Use \\* for **bold** notes!", 1]);
    fireEvent.click(screen.getByRole("button", { name: "Back to formatted view" }));
    const ed = screen.getByRole("textbox", { name: "Lesson text" });
    expect(ed.textContent).toBe("Use \\* for bold notes!");                   // legacy meaning: the backslash shows
    expect(ed.querySelector("strong").textContent).toBe("bold");
  });

});

function Links({ onItems }) {
  const [items, setItems] = useState([]);
  return <LinkList id="ll" label="Resources" items={items} onChange={(v) => { setItems(v); onItems?.(v); }} />;
}
describe("LinkList", () => {
  test("metadata that returns before a re-render never drops the new link", async () => {
    fetchLinkMetadata.mockResolvedValueOnce({ available: true, title: "Fast title" });
    render(<Links />);
    const input = screen.getByLabelText("Paste a link");
    fireEvent.change(input, { target: { value: "https://example.org/a" } });
    await act(async () => { fireEvent.submit(input.closest("form")); });
    expect(screen.getByRole("link", { name: "Fast title" })).toBeInTheDocument();
  });
  test("URL first: the card appears immediately with a fallback name, then the fetched title fills in", async () => {
    let resolve; fetchLinkMetadata.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<Links />);
    expect(screen.queryByLabelText(/Label/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Paste a link"), { target: { value: "https://cdn.example.org/packs/Film_LUTs.zip" } });
    fireEvent.submit(screen.getByLabelText("Paste a link").closest("form"));
    expect(screen.getByRole("link", { name: "Film LUTs.zip" })).toBeInTheDocument();
    expect(screen.getByText("Looking up…")).toBeInTheDocument();
    await act(async () => { resolve({ available: true, title: "Free film LUT pack", siteName: "Example", fileType: "ZIP" }); });
    expect(screen.getByRole("link", { name: "Free film LUT pack" })).toBeInTheDocument();
  });
  test("a private link keeps its fallback name and is flagged; rename sticks; duplicates and unsafe links are refused", async () => {
    fetchLinkMetadata.mockResolvedValueOnce({ available: false, restricted: true, reason: "restricted" });
    const onItems = vi.fn();
    render(<Links onItems={onItems} />);
    const input = screen.getByLabelText("Paste a link");
    fireEvent.change(input, { target: { value: "https://docs.google.com/document/d/abc/edit" } });
    await act(async () => { fireEvent.submit(input.closest("form")); });
    expect(await screen.findByText(/Private link/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Rename/ }));
    fireEvent.change(screen.getByLabelText("Link name"), { target: { value: "Shot list" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onItems.mock.lastCall[0][0]).toMatchObject({ label: "Shot list", custom: true, url: "https://docs.google.com/document/d/abc/edit" });
    fireEvent.change(input, { target: { value: "https://docs.google.com/document/d/abc/edit" } });
    fireEvent.submit(input.closest("form"));
    expect(screen.getByRole("alert")).toHaveTextContent("already here");
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(input.closest("form"));
    expect(screen.getByRole("alert")).toHaveTextContent("full web address");
  });
});

describe("v6.11: save errors in words people can act on", () => {
  test("a rules refusal never shows engine text", () => {
    const raw = "evaluation error at L925:24 for 'update' @ L925, false for 'update' @ L925";
    expect(saveErrorText(raw)).toBe("the server refused the change. You may no longer have editing access, or its category is being deleted");
    expect(saveErrorText("Missing or insufficient permissions.")).toMatch(/^the server refused the change/);
    expect(saveErrorText("Network request failed.")).toBe("Network request failed");
    expect(saveErrorText("")).toBe("");
  });
});
