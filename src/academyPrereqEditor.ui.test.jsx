/* IFC Creative Academy v6.6 — the two selectors (lesson prerequisites,
   recommended prior knowledge) and the learner's "Recommended prior knowledge",
   rendered with keyboard operation. Run: npm run test:ui */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React, { useState } from "react";

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn(), reportIssue: vi.fn(async () => true) }));
const state = vi.hoisted(() => ({ courses: [], byPath: {}, progress: {} }));
vi.mock("./academyData.js", () => new Proxy({
  useCourses: () => ({ courses: state.courses, loaded: true, error: null }),
  useManyDocs: () => ({ byPath: state.byPath, loaded: true }),
  useAllProgress: () => ({ docs: [], loaded: true, byCourse: state.progress }),
  useImageUrl: () => ({ url: null, error: false }),
}, { get: (t, k) => (k in t ? t[k] : (k === "then" ? undefined : vi.fn(() => ({ docs: [], loaded: true, data: null })))) }));
vi.mock("./AcademyManage.jsx", () => ({ Field: ({ children }) => children, RequiredTag: () => null, CategorySelect: () => null, TopicsField: () => null, ImagePicker: () => null, ThumbnailChoice: () => null, DeleteCategoryDialog: () => null, ManageGuides: () => null, ManagePaths: () => null, ManageTopics: () => null, CoverThumb: () => null, AcademyEditorScope: ({ children }) => children, PurposeVideoEditor: () => null, GuideEditor: () => null, PathEditor: () => null }));

import { CompletionAccess, PriorKnowledgeField } from "./AcademyWorkspace.jsx";
import { SearchPicker } from "./academyPicker.jsx";
import { PriorKnowledge } from "./Academy.jsx";
import { validatePrerequisites, mergeCategories } from "./academyProgress.js";

const ordered = [{ id: "a", title: "Exposure Triangle" }, { id: "b", title: "Composition" }, { id: "c", title: "Advanced Exposure" }, { id: "d", title: "Putting it together" }];
function Harness({ lid, init = [], list = ordered, fixes = {} }) {
  const [ls, setLs] = useState(list.map((l) => (l.id === lid ? { ...l, prerequisites: init } : l)));
  const lesson = ls.find((l) => l.id === lid);
  return <CompletionAccess lid={lid} lesson={lesson} ordered={ls} issues={validatePrerequisites(ls)} fixes={fixes}
    up={(patch) => setLs((x) => x.map((l) => (l.id === lid ? { ...l, ...patch } : l)))} />;
}

describe("lesson prerequisite selector", () => {
  test("the first lesson: no earlier lessons, no picker; default None", () => {
    render(<Harness lid="a" />);
    expect(screen.getByText("This is the first lesson. No earlier lessons are available.")).toBeInTheDocument();
    expect(screen.getByText("None. Learners can open this lesson directly.")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
  test("C is offered A and B only (never itself or D); keyboard: ↓ opens, ↓/Enter picks and CLOSES; chip removable; focus returns to the field", () => {
    render(<Harness lid="c" />);
    expect(screen.getByText(/Choose earlier lessons learners must complete first\./)).toBeInTheDocument();
    const box = screen.getByRole("combobox", { name: /Add a prerequisite/ });
    box.focus();
    expect(screen.queryByRole("listbox")).toBeNull();                             // tabbing in doesn't pop a list open
    fireEvent.keyDown(box, { key: "ArrowDown" });
    const opts = within(screen.getByRole("listbox", { name: "Earlier lessons you can add" })).getAllByRole("option").map((b) => b.textContent);
    expect(opts).toEqual(["1. Exposure TriangleRequired", "2. CompositionRequired"]);
    fireEvent.change(box, { target: { value: "comp" } });
    expect(box).toHaveAttribute("aria-activedescendant", expect.stringContaining("-opt-0"));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove prerequisite Composition" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();                             // closed after the pick
    expect(box).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Remove prerequisite Composition" }));
    expect(screen.getByText("None. Learners can open this lesson directly.")).toBeInTheDocument();
  });
  test("after a reorder puts a prerequisite later: flagged with titles and explicit fixes; nothing removed silently", () => {
    const moveBelow = vi.fn();
    const reordered = [ordered[2], ordered[0], ordered[1], ordered[3]];          // Advanced Exposure dragged to the top
    render(<Harness lid="c" init={["a"]} list={reordered} fixes={{ moveBelow }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("“Advanced Exposure” requires “Exposure Triangle”, which comes after it in the course.");
    expect(screen.getByText(/comes after this lesson/)).toBeInTheDocument();     // the chip still shows the relationship
    fireEvent.click(screen.getByRole("button", { name: "Move this lesson below “Exposure Triangle”" }));
    expect(moveBelow).toHaveBeenCalledWith("c", "a");
    fireEvent.click(screen.getByRole("button", { name: "Remove “Exposure Triangle” from prerequisites" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
  test("an optional prerequisite of a required lesson is flagged with 'make it required' / remove", () => {
    const makeRequired = vi.fn();
    render(<Harness lid="c" init={["b"]} list={ordered.map((l) => (l.id === "b" ? { ...l, bonus: true } : l))} fixes={{ makeRequired }} />);
    fireEvent.click(screen.getByRole("button", { name: "Make “Composition” required" }));
    expect(makeRequired).toHaveBeenCalledWith("b");
  });
});

const cats = mergeCategories([]);
const tax = { categories: cats, hidden: [] };
beforeEach(() => {
  state.courses = [
    { id: "colour", title: "Colour Grading", status: "published", category: "filmmaking" },
    { id: "resolve", title: "DaVinci Resolve Essentials", status: "published", category: "filmmaking" },
    { id: "expo", title: "Exposure Fundamentals", status: "published", category: "photography" },
    { id: "draftc", title: "Secret draft course", status: "draft", category: "photography" },
  ];
  state.byPath = {}; state.progress = {};
});

describe("recommended prior knowledge — editor", () => {
  function PK({ init = { courseIds: [], note: "" } }) {
    const [v, setV] = useState(init);
    return <><PriorKnowledgeField cid="colour" value={v} onChange={setV} me={{ id: "e", role: "admin", status: "approved" }} tax={tax} /><output data-testid="v">{JSON.stringify(v)}</output></>;
  }
  test("search across categories, pick closes the list, reopen for another, no self, already-added state, removable, note; stable ids", () => {
    render(<PK />);
    const box = screen.getByRole("combobox", { name: /recommended course/ });
    fireEvent.click(box);                                                                       // a click opens it
    const names = within(screen.getByRole("listbox", { name: "Courses you can recommend" })).getAllByRole("option").map((b) => b.textContent);
    expect(names.some((n) => /Colour Grading/.test(n))).toBe(false);                           // never itself
    expect(names.some((n) => /Exposure Fundamentals.*Photography/.test(n))).toBe(true);         // another category
    fireEvent.change(box, { target: { value: "resolve" } });
    const opt = screen.getByRole("option", { name: /DaVinci Resolve Essentials/ });
    fireEvent.mouseDown(opt); fireEvent.click(opt);
    expect(screen.queryByRole("listbox")).toBeNull();                                          // dismissed after selecting
    fireEvent.change(box, { target: { value: "expo" } });                                       // typing reopens it
    fireEvent.click(screen.getByRole("option", { name: /Exposure Fundamentals/ }));
    fireEvent.change(box, { target: { value: "resolve" } });
    expect(screen.getByText("“DaVinci Resolve Essentials” is already recommended.")).toBeInTheDocument();   // no duplicates
    fireEvent.change(screen.getByLabelText("Note for learners (optional)"), { target: { value: "You should be comfortable navigating Resolve." } });
    expect(JSON.parse(screen.getByTestId("v").textContent)).toEqual({ courseIds: ["resolve", "expo"], note: "You should be comfortable navigating Resolve." });
    fireEvent.click(screen.getByRole("button", { name: "Remove DaVinci Resolve Essentials from recommended prior knowledge" }));
    expect(JSON.parse(screen.getByTestId("v").textContent).courseIds).toEqual(["expo"]);
  });
  test("references learners can't see are flagged for editors (unpublished, deleted)", () => {
    render(<PK init={{ courseIds: ["draftc", "gone"], note: "" }} />);
    expect(screen.getByText(/Not published\. Learners won't see this course/)).toBeInTheDocument();
    expect(screen.getByText(/This course no longer exists/)).toBeInTheDocument();
  });
});

describe("recommended prior knowledge — learner", () => {
  const me = { id: "u", role: "member", status: "approved" };
  const course = { id: "colour", title: "Colour Grading", category: "filmmaking", status: "published", priorKnowledge: { courseIds: ["resolve", "expo", "draftc", "gone"], note: "Know basic exposure." } };
  test("only accessible courses, with links and a subtle Completed; hidden/deleted ones never leak; renamed titles follow the id", () => {
    state.byPath = { "courses/resolve": { id: "resolve", title: "Resolve Essentials (renamed)", status: "published", category: "filmmaking" }, "courses/expo": { id: "expo", title: "Exposure Fundamentals", status: "published", category: "photography" }, "courses/draftc": null, "courses/gone": null };
    state.progress = { expo: { finishedAt: 1 } };
    const R = { navigate: vi.fn() };
    const { container } = render(<PriorKnowledge me={me} c={course} R={R} />);
    expect(screen.getByRole("heading", { name: "Recommended prior knowledge" })).toBeInTheDocument();
    expect(screen.getByText("This course assumes some familiarity with the topics below. If you already have that knowledge, you can start straight away.")).toBeInTheDocument();
    const card = screen.getByRole("link", { name: "View course: Resolve Essentials (renamed)" });
    expect(card).toHaveAttribute("href", "/learn/course/resolve");                              // a real link: new tab / copy link work
    expect(within(card).getByText("Filmmaking")).toBeInTheDocument();
    expect(within(card).getByText("View course")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Secret draft course|draftc|gone/);
    const done = screen.getByRole("link", { name: "View course: Exposure Fundamentals (completed)" });
    expect(within(done).getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Know basic exposure.")).toBeInTheDocument();
    fireEvent.click(done);
    expect(R.navigate).toHaveBeenCalledWith("/learn/course/expo");
    expect(screen.queryByText(/available to learners/)).toBeNull();                            // learners aren't told about hidden ones
    expect(screen.queryByRole("link", { name: "Review recommendations" })).toBeNull();
  });
  test("editors are told about references learners can't see", () => {
    state.byPath = { "courses/resolve": null, "courses/expo": null, "courses/draftc": { id: "draftc", title: "Secret draft course", status: "draft", category: "photography" }, "courses/gone": null };
    render(<PriorKnowledge me={{ id: "e", role: "admin", status: "approved" }} c={course} editor R={{ navigate: vi.fn() }} />);
    expect(screen.getByText("4 recommended courses aren't available to learners.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review recommendations" })).toHaveAttribute("href", "/learn/manage/course/colour?item=details&focus=prior");
    expect(screen.queryByRole("link", { name: /Secret draft course/ })).toBeNull();            // even an editor's learner view lists only published
  });
});

describe("searchable picker — dismissal and states", () => {
  const items = [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }, { id: "c", label: "Gamma" }];
  function P(props) {
    const [picked, setPicked] = useState([]);
    return <><button type="button">outside</button>
      <SearchPicker id="pk" label="Add a thing" listLabel="Things" items={items.filter((x) => !picked.includes(x.id))} selected={items.filter((x) => picked.includes(x.id))}
        onPick={(x) => setPicked((p) => [...p, x.id])} {...props} />
      <output data-testid="picked">{picked.join(",")}</output></>;
  }
  test("Escape closes (and doesn't reopen); outside press closes; focus leaving closes", () => {
    render(<P />);
    const box = screen.getByRole("combobox", { name: "Add a thing" });
    fireEvent.click(box); expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Escape" }); expect(screen.queryByRole("listbox")).toBeNull();
    expect(box).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(box); expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "outside" })); expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(box);
    fireEvent.blur(box.closest(".ac-pick"), { relatedTarget: screen.getByRole("button", { name: "outside" }) });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  test("a press on an option is never swallowed by the outside/blur handlers; arrows + Enter pick; Home/End", () => {
    render(<P />);
    const box = screen.getByRole("combobox");
    fireEvent.click(box);
    const opt = screen.getByRole("option", { name: "Beta" });
    fireEvent.pointerDown(opt); fireEvent.mouseDown(opt); fireEvent.click(opt);              // inside → not "outside"
    expect(screen.getByTestId("picked")).toHaveTextContent("b");
    fireEvent.keyDown(box, { key: "ArrowDown" });                                            // reopen from the keyboard
    fireEvent.keyDown(box, { key: "End" }); fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByTestId("picked")).toHaveTextContent("b,c");
  });
  test("loading, empty, no-match, already-selected and load-failure states", () => {
    const { rerender } = render(<SearchPicker id="s" label="L" listLabel="X" items={[]} onPick={() => {}} loading />);
    fireEvent.click(screen.getByRole("combobox")); expect(screen.getByText("Loading…")).toBeInTheDocument();
    rerender(<SearchPicker id="s" label="L" listLabel="X" items={[]} onPick={() => {}} emptyText="Nothing to add." />);
    expect(screen.getByText("Nothing to add.")).toBeInTheDocument();
    rerender(<SearchPicker id="s" label="L" listLabel="X" items={[{ id: "a", label: "Alpha" }]} selected={[{ id: "z", label: "Zulu" }]} onPick={() => {}} noMatchText="No matches." />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zul" } });
    expect(screen.getByText("“Zulu” is already added.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "qqq" } });
    expect(screen.getByText("No matches.")).toBeInTheDocument();
    const retry = vi.fn();
    rerender(<SearchPicker id="s" label="L" listLabel="X" items={[]} onPick={() => {}} error="Couldn't load courses." onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" })); expect(retry).toHaveBeenCalled();
  });
});
