/* Contextual link editor: selection analysis, link actions (DOM fallbacks —
   jsdom has no execCommand; the browser path is verified in a real browser),
   and the RichTextField popover flow. Run: npm run test:ui */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React, { useState } from "react";

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn() }));
vi.mock("./academyData.js", () => ({ fetchLinkMetadata: vi.fn(), loadCourseWorkspace: vi.fn(), saveCourseDraft: vi.fn(), cleanupDraftImages: vi.fn(), useDraftHead: () => ({ data: null }), useImageUrl: () => ({ url: null }) }));
if (!window.matchMedia) window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

import { linkContext, updateLink, removeLink, createLink, unlinkRange } from "./academyLinkEditor.jsx";
import { RichTextField } from "./academyWorkspaceParts.jsx";
import { htmlToMarkdown } from "./academyRichText.js";

const mount = (html) => { const el = document.createElement("div"); el.contentEditable = "true"; el.innerHTML = html; document.body.appendChild(el); return el; };
const rangeIn = (node, start, end = start) => { const r = document.createRange(); r.setStart(node, start); r.setEnd(node, end); return r; };
beforeEach(() => { document.body.innerHTML = ""; });

describe("linkContext", () => {
  test("caret inside a link, a partial selection inside it, or the whole link → edit that link", () => {
    const root = mount('<p>See <a href="https://example.com/a">the <b>full</b> guide</a> now</p>');
    const a = root.querySelector("a");
    const t = a.firstChild;                               // "the "
    expect(linkContext(root, rangeIn(t, 2))).toMatchObject({ mode: "edit", anchor: a, href: "https://example.com/a", text: "the full guide" });
    expect(linkContext(root, rangeIn(t, 0, 3)).mode).toBe("edit");
    const whole = document.createRange(); whole.selectNode(a);
    expect(linkContext(root, whole)).toMatchObject({ mode: "edit", anchor: a });
  });
  test("plain text → create; a selection spanning two links, or link + unlinked text → mixed (explicit)", () => {
    const root = mount('<p>Plain <a href="https://a.example">one</a> and <a href="https://b.example">two</a> end</p>');
    const p = root.firstChild;
    expect(linkContext(root, rangeIn(p.firstChild, 0, 5))).toMatchObject({ mode: "create", collapsed: false, text: "Plain" });
    const both = document.createRange(); both.setStart(p.childNodes[1].firstChild, 0); both.setEnd(p.childNodes[3].firstChild, 3);
    expect(linkContext(root, both)).toMatchObject({ mode: "mixed" });
    expect(linkContext(root, both).links).toHaveLength(2);
    const mixed = document.createRange(); mixed.setStart(p.firstChild, 0); mixed.setEnd(p.childNodes[1].firstChild, 3);
    expect(linkContext(root, mixed)).toMatchObject({ mode: "mixed", hasUnlinked: true });
  });
});

describe("link actions keep content intact", () => {
  test("update URL: same anchor, formatting inside kept, no nesting, neighbours untouched", () => {
    const root = mount('<p>Before <a href="https://old.example/x"><b>bold</b> text</a> after</p>');
    updateLink(root, root.querySelector("a"), "https://new.example/y");
    expect(root.querySelectorAll("a")).toHaveLength(1);
    expect(root.querySelector("a a")).toBeNull();
    expect(root.querySelector("a").getAttribute("href")).toBe("https://new.example/y");
    expect(root.querySelector("a b").textContent).toBe("bold");
    expect(root.textContent).toBe("Before bold text after");
  });
  test("update display text: replaced once, not duplicated", () => {
    const root = mount('<p>A <a href="https://x.example">old</a> B</p>');
    updateLink(root, root.querySelector("a"), "https://x.example", "new label");
    expect(root.textContent).toBe("A new label B");
    expect(root.querySelectorAll("a")).toHaveLength(1);
  });
  test("remove: text and inline formatting stay", () => {
    const root = mount('<p>Go <a href="https://x.example"><i>here</i> now</a>.</p>');
    removeLink(root, root.querySelector("a"));
    expect(root.querySelector("a")).toBeNull();
    expect(root.querySelector("i").textContent).toBe("here");
    expect(root.textContent).toBe("Go here now.");
  });
  test("create with no selection: text defaults to the address", () => {
    const root = mount("<p>End</p>");
    createLink(root, rangeIn(root.firstChild.firstChild, 3), "https://x.example/p");
    expect(root.querySelector("a").textContent).toBe("https://x.example/p");
  });
  test("mixed: removing links in the selection keeps all text", () => {
    const root = mount('<p><a href="https://a.example">one</a> and <a href="https://b.example">two</a></p>');
    const r = document.createRange(); r.selectNodeContents(root.firstChild);
    unlinkRange(root, r, [...root.querySelectorAll("a")]);
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toBe("one and two");
  });
});

function Rich({ initial, format = 2, onChange }) {
  const [v, setV] = useState(initial); const [f, setF] = useState(format);
  return <RichTextField id="rt" label="Lesson text" value={v} format={f} onChange={(x, ff) => { setV(x); setF(ff); onChange(x, ff); }} />;
}
const putCaret = (node, offset) => { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rangeIn(node, offset)); };

describe("RichTextField link popover", () => {
  test("caret in a link + Ctrl+K: populated Edit link; Cancel changes nothing; Update rewrites only the href", async () => {
    const onChange = vi.fn();
    render(<Rich initial="Read [the guide](https://example.com/old) today" onChange={onChange} />);
    const ed = screen.getByRole("textbox", { name: "Lesson text" });
    putCaret(ed.querySelector("a").firstChild, 2);
    fireEvent.keyDown(ed, { key: "k", ctrlKey: true });
    const dlg = await screen.findByRole("dialog", { name: "Edit link" });
    expect(screen.getByLabelText("Web address").value).toBe("https://example.com/old");
    expect(screen.getByLabelText("Text to show").value).toBe("the guide");
    for (const name of ["Update link", "Open link", "Remove link", "Cancel"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(dlg).not.toBeInTheDocument();
    putCaret(ed.querySelector("a").firstChild, 2);
    fireEvent.keyDown(ed, { key: "k", metaKey: true });
    fireEvent.change(await screen.findByLabelText("Web address"), { target: { value: "example.com/new" } });
    fireEvent.submit(screen.getByRole("dialog", { name: "Edit link" }));
    expect(onChange).toHaveBeenLastCalledWith("Read [the guide](https://example.com/new) today", 2);
  });
  test("clicking a link while authoring opens the editor instead of navigating; Open link is safe", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<Rich initial="See [docs](https://example.com/d)" onChange={vi.fn()} />);
    const a = screen.getByRole("textbox", { name: "Lesson text" }).querySelector("a");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => { a.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    await screen.findByRole("dialog", { name: "Edit link" });
    fireEvent.click(screen.getByRole("button", { name: "Open link" }));
    expect(open).toHaveBeenCalledWith("https://example.com/d", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });
  test("Remove link keeps the text; invalid or executable addresses are refused inline", async () => {
    const onChange = vi.fn();
    render(<Rich initial="A [**bold** link](https://x.example) here" onChange={onChange} />);
    const ed = screen.getByRole("textbox", { name: "Lesson text" });
    putCaret(ed.querySelector("a strong").firstChild, 1);
    fireEvent.keyDown(ed, { key: "k", ctrlKey: true });
    fireEvent.change(await screen.findByLabelText("Web address"), { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(screen.getByRole("dialog", { name: "Edit link" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/isn't a web address/);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove link" }));
    expect(onChange).toHaveBeenLastCalledWith("A **bold** link here", 2);
  });
  test("new link with no selection: display text + address; Escape cancels without writing", async () => {
    const onChange = vi.fn();
    render(<Rich initial="Hello" onChange={onChange} />);
    const ed = screen.getByRole("textbox", { name: "Lesson text" });
    putCaret(ed.querySelector("p").firstChild, 5);
    fireEvent.click(screen.getByRole("button", { name: "Link (Ctrl+K)" }));
    const dlg = await screen.findByRole("dialog", { name: "Add link" });
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    putCaret(ed.querySelector("p").firstChild, 5);
    fireEvent.click(screen.getByRole("button", { name: "Link (Ctrl+K)" }));
    fireEvent.change(await screen.findByLabelText(/Text to show/), { target: { value: "our site" } });
    fireEvent.change(screen.getByLabelText("Web address"), { target: { value: "https://example.org" } });
    fireEvent.submit(screen.getByRole("dialog", { name: "Add link" }));
    expect(onChange.mock.lastCall[0]).toBe("Hello[our site](https://example.org)");
  });
  test("LEGACY text: opening and cancelling the link editor writes nothing and converts nothing", async () => {
    const onChange = vi.fn();
    render(<Rich initial={"C:\\Users and [x](https://x.example)"} format={1} onChange={onChange} />);
    const ed = screen.getByRole("textbox", { name: "Lesson text" });
    putCaret(ed.querySelector("a").firstChild, 0);
    fireEvent.keyDown(ed, { key: "k", ctrlKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    fireEvent.blur(ed);
    expect(onChange).not.toHaveBeenCalled();
    expect(htmlToMarkdown(ed)).toContain("C:\\\\Users");                    // shown as before (literal backslash)
  });
});
