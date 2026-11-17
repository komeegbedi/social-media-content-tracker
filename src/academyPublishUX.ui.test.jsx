/* v6.7 — quiz editor wording/labels and the publish readiness checklist. */
import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React, { useState } from "react";

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn(), reportIssue: vi.fn(async () => true) }));
vi.mock("./academyData.js", () => new Proxy({ useCourses: () => ({ courses: [], loaded: true, error: null }) },
  { get: (t, k) => (k in t ? t[k] : (k === "then" ? undefined : vi.fn(() => ({ docs: [], loaded: true, data: null })))) }));
vi.mock("./AcademyManage.jsx", () => ({ Field: ({ children }) => children, RequiredTag: () => null, CategorySelect: () => null, TopicsField: () => null, ImagePicker: () => null, ThumbnailChoice: () => null, DeleteCategoryDialog: () => null, ManageGuides: () => null, ManagePaths: () => null, ManageTopics: () => null, CoverThumb: () => null, AcademyEditorScope: ({ children }) => children }));

import { QuizEditor } from "./academyWorkspaceParts.jsx";
import { Readiness, backDestination } from "./AcademyWorkspace.jsx";
import { publishIssues } from "./academyProgress.js";

function Q({ multi = false, err }) {
  const [quiz, setQuiz] = useState({ mode: "required", passMark: 70, retryLimit: 3, questions: [{ id: "x", prompt: "Pick one", multi, options: [{ id: "a", text: "Kome" }, { id: "b", text: "John" }] }] });
  const [key, setKey] = useState({ answers: {}, explanations: {} });
  return <><QuizEditor idBase="qz" quiz={quiz} quizKey={key} onChange={(q, k) => { setQuiz(q); setKey(k); }} err={err} /><output data-testid="key">{JSON.stringify(key.answers)}</output></>;
}

describe("quiz editor", () => {
  test("visible Question / Answer option labels, correct-answer instructions, named remove buttons, Quiz attempts helper", () => {
    render(<Q />);
    expect(screen.getByLabelText(/^Question 1/)).toHaveValue("Pick one");
    expect(screen.getByRole("group", { name: "Answer options" })).toBeInTheDocument();
    expect(screen.getByText(/Select the correct answer\./)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Answer option 1" })).toHaveValue("Kome");
    expect(screen.getByRole("button", { name: "Remove question 1: Pick one" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove answer option 2 (John)" })).toBeDisabled();       // two is the minimum
    expect(screen.getByText(/Quiz attempts/).closest(".ac-fieldhint")).toHaveTextContent("Academy editors can give a learner extra attempts from Quiz attempts on the course page.");
    expect(document.body.textContent).not.toMatch(/learner progress/i);
    fireEvent.click(screen.getByRole("radio", { name: "Answer option 2 (John) is correct" }));
    expect(screen.getByTestId("key")).toHaveTextContent('{"x":["b"]}');
  });
  test("multi-answer instructions; errors sit with the control they're about (question text vs correct answer)", () => {
    const { unmount } = render(<Q multi err={(field) => (field === "qa:x" ? "Mark the correct answer." : "")} />);
    expect(screen.getByText(/Tick every correct answer\. Learners must choose all of them\./)).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Answer options" });
    expect(group).toHaveAttribute("aria-invalid", "true");
    expect(group).toHaveAccessibleDescription(expect.stringContaining("Mark the correct answer."));
    expect(screen.getByLabelText(/^Question 1/)).not.toHaveAttribute("aria-invalid");
    unmount();
    render(<Q err={(field) => (field === "q:x" ? "Write the question." : "")} />);
    expect(screen.getByLabelText(/^Question 1/)).toHaveAccessibleDescription("Write the question.");
  });
});

describe("publish readiness", () => {
  const course = { title: "", category: "photography", level: "beginner", cover: null, modules: [{ id: "m", lessonIds: ["l"] }] };
  const issues = publishIssues(course, [{ id: "l", title: "Intro", kind: "video", video: null }], ["photography"]);
  function R({ attempted = false, onFix = vi.fn() }) { const [open, setOpen] = useState(false); return <Readiness issues={issues} attempted={attempted} open={open} setOpen={setOpen} onFix={onFix} />; }
  test("a compact summary that expands to labelled items, each with a fix that targets its field", () => {
    const onFix = vi.fn();
    render(<R onFix={onFix} />);
    const sum = screen.getByRole("button", { name: /3 items need attention before publishing/ });
    expect(sum).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(sum);
    const cover = screen.getByText("Course cover").closest("li");
    expect(within(cover).getByText("Add a cover image before publishing.")).toBeInTheDocument();
    fireEvent.click(within(cover).getByRole("button", { name: "Add cover: Course cover" }));
    expect(onFix).toHaveBeenCalledWith(expect.objectContaining({ key: "cover", item: "details", field: "cover" }));
    expect(screen.getByText("“Intro” video link")).toBeInTheDocument();
  });
  test("after a publish attempt it says so (not published yet)", () => {
    render(<R attempted />);
    expect(screen.getByRole("button", { name: /Nothing was published/ })).toBeInTheDocument();
  });
});

describe("leaving the editor: Back goes only to pages that exist", () => {
  const pub = { status: "published" };
  const cat = { id: "photo", label: "Photography", hidden: false };
  test("published course + published lesson → Back to lesson (path context kept)", () => {
    expect(backDestination({ cid: "c1", item: "l1", liveCourse: pub, liveLessons: [{ id: "l1" }], category: cat, pathCtx: "p1" }))
      .toMatchObject({ label: "Back to lesson", to: "/learn/course/c1/lesson/l1?path=p1", note: "" });
  });
  test("course details or a lesson added since the last publish → Back to course", () => {
    expect(backDestination({ cid: "c1", item: "details", liveCourse: pub, liveLessons: [{ id: "l1" }], category: cat })).toMatchObject({ label: "Back to course", to: "/learn/course/c1", note: "" });
    const b = backDestination({ cid: "c1", item: "new1", liveCourse: pub, liveLessons: [{ id: "l1" }], category: cat });
    expect(b).toMatchObject({ label: "Back to course", to: "/learn/course/c1" });
    expect(b.note).toMatch(/hasn't been published yet/);
  });
  test("never published → its visible category, else the Academy; archived → not its (hidden) page", () => {
    expect(backDestination({ cid: "c1", item: "", liveCourse: null, category: cat })).toMatchObject({ label: "Back to category", aria: "Back to Photography", to: "/learn/category/photo" });
    expect(backDestination({ cid: "c1", item: "", liveCourse: null, category: { ...cat, hidden: true } })).toMatchObject({ label: "Back to Academy", to: "/learn" });
    const a = backDestination({ cid: "c1", item: "", liveCourse: { status: "archived" }, category: null });
    expect(a).toMatchObject({ label: "Back to Academy", to: "/learn" });
    expect(a.note).toMatch(/archived/);
  });
});
