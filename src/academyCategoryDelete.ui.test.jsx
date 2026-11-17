/* v6.10 — category deletion dialog: choices, bulk actions, no destination, review wording. */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor, act } from "@testing-library/react";
import React from "react";

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn(), reportIssue: vi.fn(async () => true) }));
const state = vi.hoisted(() => ({ contents: null, impl: {}, calls: [] }));
vi.mock("./academyData.js", () => new Proxy({
  categoryContents: async () => state.contents,
  pathsUsingCourse: async (...a) => (state.impl.pathsUsingCourse ? state.impl.pathsUsingCourse(...a) : [{ id: "px", title: "Path elsewhere" }]),
  pathsUsingGuide: async (...a) => (state.impl.pathsUsingGuide ? state.impl.pathsUsingGuide(...a) : [{ id: "py", title: "Path using a tip" }]),
  coursesRecommending: async (...a) => (state.impl.coursesRecommending ? state.impl.coursesRecommending(...a) : [{ id: "k", title: "Recommender" }]),
  lockCategoryForDeletion: async (args) => { state.calls.push(["lock", args]); return state.impl.lock ? state.impl.lock(args) : { ok: true }; },
  useImageUrl: () => ({ url: null, error: false }),
}, { get: (t, k) => (k in t ? t[k] : (k === "then" ? undefined : vi.fn(async () => ({ ok: true })))) }));
vi.mock("./AcademyManage.jsx", () => ({ CoverThumb: () => <span data-testid="cover" /> }));
vi.mock("./academyShared.jsx", () => ({ AppLink: ({ children }) => children, VideoThumb: () => <span data-testid="thumb" /> }));

import { CategoryDeleteDialog } from "./academyCategoryDelete.jsx";

const row = (id, title, status = "published", extra = {}) => ({ id, title, status, cover: null, fp: id, liveIn: true, draftIn: false, draftConflict: false, publishedElsewhere: false, ...extra });
beforeEach(() => {
  sessionStorage.clear(); state.impl = {}; state.calls = [];
  state.contents = { ids: ["photo"], exists: true, lock: null, cover: null,
    courses: [row("a", "Alpha"), row("b", "Beta", "draft-only"), row("c", "Gamma", "archived"), row("d", "Delta", "published-edits")],
    guides: [{ id: "g", title: "Guide one", type: "guide", kind: "text", status: "published", fp: "g" }, { id: "h", title: "Video tip", type: "guide", kind: "video", status: "draft-only", fp: "h" }],
    paths: [{ id: "p", title: "Path one" }] };
});
const cats = [{ id: "photo", label: "Photography" }, { id: "film", label: "Filmmaking" }, { id: "hid", label: "Secret", hidden: true }];
const open = (props = {}) => render(<CategoryDeleteDialog me={{ id: "admin" }} catId="photo" label="Photography" categories={cats} R={{ navigate: vi.fn() }} onClose={vi.fn()} onDone={vi.fn()} {...props} />);

describe("choose", () => {
  test("three options (scope explicit), none preselected; Cancel focused; learning paths need their own explicit choice", async () => {
    open();
    await screen.findByRole("radio", { name: /Move all content to another category/ });
    expect(screen.getAllByRole("radio").every((r) => !r.checked)).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Review…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /Move all content to another category/ }));
    fireEvent.change(screen.getByLabelText("Move everything to"), { target: { value: "film" } });
    expect(screen.getByRole("button", { name: "Review…" })).toBeDisabled();                       // the learning path still needs its own choice
    expect(screen.getByText(/Choose a category for the learning path “Path one”/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Use “Filmmaking” for all of them/ }));
    expect(screen.getByRole("button", { name: "Review…" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    expect(await screen.findByText("Move 4 courses and 2 resources. Delete the category “Photography”.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move 4 courses and 2 resources and delete category" })).toBeInTheDocument();
  });
  test("per course: bulk actions say how many rows they affect; hidden destinations are explained; rows can override", async () => {
    open();
    fireEvent.click(await screen.findByRole("radio", { name: /Choose individually/ }));
    fireEvent.change(screen.getByLabelText(/Move to \(unless you choose otherwise below\)/), { target: { value: "hid" } });
    expect(screen.getByText(/“Secret” is hidden, so learners won't see anything moved there/)).toBeInTheDocument();
    expect(screen.getByText("Courses (4)")).toBeInTheDocument(); expect(screen.getByText("Tips & resources (2)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" })); fireEvent.click(screen.getByRole("checkbox", { name: "Select Beta" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(screen.getByLabelText("What happens to Alpha")).toHaveValue("delete");
    expect(screen.getByLabelText("What happens to Gamma")).toHaveValue("");                        // untouched rows stay unresolved
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByText("6 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    fireEvent.change(screen.getByLabelText("What happens to Gamma"), { target: { value: "move" } });
    fireEvent.change(screen.getByLabelText("Move Gamma to"), { target: { value: "film" } });
    fireEvent.change(screen.getByLabelText("What happens to Delta"), { target: { value: "move" } });
    fireEvent.change(screen.getByLabelText("What happens to Guide one"), { target: { value: "move" } });
    fireEvent.change(screen.getByLabelText("What happens to Video tip"), { target: { value: "delete" } });
    fireEvent.change(screen.getByLabelText("Category for Path one"), { target: { value: "__none" } });
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    await screen.findByText("Move 2 courses and 1 resource. Delete 2 courses and 1 resource. Delete the category “Photography”.");
    expect(screen.getByRole("button", { name: "Move 2 courses and 1 resource and delete 2 courses and 1 resource" })).toBeInTheDocument();
    expect(screen.getByText(/Deleting a tip or resource removes its discussion, learners' “reviewed” records, its draft/)).toBeInTheDocument();
    expect(await screen.findByText(/The learning path “Path using a tip” includes “Video tip”/)).toBeInTheDocument();
    expect(screen.getByText("The category “Photography” is also deleted.")).toBeInTheDocument();
    expect(screen.getByText(/Moved content keeps everything/)).toBeInTheDocument();
    expect(await screen.findByText(/The learning path “Path elsewhere” includes “Alpha”\. That step will show as unavailable; nothing is marked complete\./)).toBeInTheDocument();
    expect(screen.getByText(/Learning path “Path one”: keep it, with no category/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
  });
  test("delete all → ‘Delete category and 4 courses’ (no resources); empty category → a simple confirm", async () => {
    state.contents.guides = []; state.contents.paths = [];
    const { unmount } = open();
    fireEvent.click(await screen.findByRole("radio", { name: /Delete the category and its courses and tips & resources/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    expect(await screen.findByRole("button", { name: "Delete category and 4 courses" })).toBeInTheDocument();
    unmount();
    state.contents.courses = [];
    open();
    expect(await screen.findByText(/has no courses, tips & resources or learning paths, so only the category itself is deleted/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete category" })).toBeInTheDocument();
  });
  test("no other category: moving explains a category must be created first; choices are kept for later", async () => {
    const { unmount } = open({ categories: [{ id: "photo", label: "Photography" }] });
    fireEvent.click(await screen.findByRole("radio", { name: /Choose individually/ }));
    expect(screen.getByText(/There's no other category to move content to\. Create one first; your choices here are kept\./)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("What happens to Alpha"), { target: { value: "delete" } });
    unmount();
    open({ categories: [{ id: "photo", label: "Photography" }] });
    await waitFor(() => expect(screen.getByLabelText("What happens to Alpha")).toHaveValue("delete"));
    expect(screen.getByRole("radio", { name: /Choose individually/ })).toBeChecked();
  });
  test("a course published in another category can't be deleted from here", async () => {
    state.contents.courses = [row("e", "Elsewhere", "published", { liveIn: false, draftIn: true, publishedElsewhere: true, liveCategory: "film" })];
    open();
    fireEvent.click(await screen.findByRole("radio", { name: /Choose individually/ }));
    const sel = screen.getByLabelText("What happens to Elsewhere");
    expect(within(sel).getByRole("option", { name: "Delete" })).toBeDisabled();
    expect(screen.getByText(/Published in “Filmmaking”; only its unpublished changes are filed here/)).toBeInTheDocument();
  });
});

describe("resume (v6.11)", () => {
  test("a stored plan without a ‘guides’ section (a lock from before tips & resources) resumes without crashing", async () => {
    state.contents = { ...state.contents, lock: { planId: "old", byName: "Jane", plan: { courses: { a: { action: "move", dest: "film" } }, paths: {} } } };
    open();
    await screen.findByText(/was started by Jane but isn't finished/);
    expect(screen.getByText(/Alpha/)).toBeTruthy();
  });
});

describe("impact discovery gates the destructive button (v6.11)", () => {
  const deferred = () => { let resolve, reject; const p = new Promise((r, j) => { resolve = r; reject = j; }); return { p, resolve, reject }; };
  beforeEach(() => { state.contents.paths = []; });
  const toDeleteAllReview = async () => {
    fireEvent.click(await screen.findByRole("radio", { name: /Delete the category and its courses and tips & resources/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    return screen.findByRole("button", { name: /^Delete category and/ });
  };
  test("delayed: disabled while checking, with the reason shown; enabled only when the check finishes", async () => {
    const d = deferred(); state.impl.pathsUsingCourse = () => d.p;
    open();
    const btn = await toDeleteAllReview();
    expect(btn).toBeDisabled();
    expect(screen.getByText("Checking where these are used…")).toBeInTheDocument();
    expect(screen.getByText("Available once the check above finishes.")).toBeInTheDocument();
    fireEvent.click(btn);
    expect(state.calls.length).toBe(0);
    await act(async () => { d.resolve([{ id: "px", title: "Path elsewhere" }]); });
    await waitFor(() => expect(btn).toBeEnabled());
    expect(screen.getAllByText(/The learning path “Path elsewhere” includes/).length).toBeGreaterThan(0);
  });
  test("failed: the failure is shown with Retry; the button never enables until a retry succeeds", async () => {
    let fail = true; state.impl.coursesRecommending = async () => { if (fail) throw new Error("Server error 500."); return []; };
    open();
    const btn = await toDeleteAllReview();
    expect(await screen.findByText(/Couldn't check which learning paths and recommendations use these items \(Server error 500\)\. Nothing has been deleted\./)).toBeInTheDocument();
    expect(btn).toBeDisabled();
    expect(screen.getByText("Available after the check succeeds. Retry above.")).toBeInTheDocument();
    fireEvent.click(btn); expect(state.calls.length).toBe(0);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(btn).toBeEnabled());
    expect(screen.queryByText(/Couldn't check which learning paths/)).toBeNull();
  });
  test("stale: a slow check from an earlier review never unlocks a newer one", async () => {
    const first = deferred(); let n = 0;
    state.impl.pathsUsingCourse = () => (++n <= 4 ? first.p : new Promise(() => {}));   // review 1: slow; review 2: never finishes
    open();
    await toDeleteAllReview();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review…" }));
    const btn = await screen.findByRole("button", { name: /^Delete category and/ });
    await act(async () => { first.resolve([]); });                                        // review 1 finishes late
    await new Promise((r) => setTimeout(r, 20));
    expect(btn).toBeDisabled();
    expect(screen.getByText("Checking where these are used…")).toBeInTheDocument();
  });
  test("confirm sends exactly the reviewed plan; if the server says it changed, nothing runs and the admin reviews again", async () => {
    state.impl.lock = () => ({ ok: false, changes: [{ kind: "added", type: "course", id: "new", title: "Brand new" }] });
    open();
    const btn = await toDeleteAllReview();
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    await waitFor(() => expect(state.calls.length).toBe(1));
    const sent = state.calls[0][1];
    expect(Object.keys(sent.plan.courses).sort()).toEqual(["a", "b", "c", "d"]);
    expect(Object.values(sent.plan.courses).every((x) => x.action === "delete")).toBe(true);
    expect(sent.expected.courses.map((c) => c.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(await screen.findByText(/changed after you reviewed it, so nothing was deleted or moved: “Brand new” was added/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review…" })).toBeInTheDocument();      // back to choosing, must review again
  });
});
