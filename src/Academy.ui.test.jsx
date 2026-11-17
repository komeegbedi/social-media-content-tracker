/* IFC Creative Academy — rendered behaviour (RTL + jsdom): safe markdown
   rendering, the quiz panel (labelled controls, validation, server result,
   explanations), the course card (cover is artwork, text sits below, progress
   is a real progressbar) and the completion copy. Firebase is mocked at the
   data-layer boundary. Run: npm run test:ui */
import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn(), reportIssue: vi.fn() }));
vi.mock("./academyData.js", async () => {
  const actual = await vi.importActual("./academyProgress.js");
  return {
    useImageUrl: (ref) => ({ url: ref?.path ? `blob:${ref.path}` : null, error: false }),
    useAttempts: () => ({ docs: [], loaded: true, error: null }),
    submitQuiz: vi.fn(),
    useCourses: () => ({ courses: [], loaded: true, error: null }), useCourse: () => ({ data: null, loaded: true }),
    useLessons: () => ({ docs: [], loaded: true }), usePurposeVideo: () => ({ data: null, loaded: true }),
    useProgress: () => ({ data: null, loaded: true }), useAllProgress: () => ({ docs: [], loaded: true, byCourse: {} }),
    useComments: () => ({ docs: [], loaded: true }), useLeaderProgress: () => ({ docs: [], loaded: true }), useLeaderAttempts: () => ({ docs: [], loaded: true }),
    recordLessonView: vi.fn(), startCourse: vi.fn(), savePlayback: vi.fn(), markVideoWatched: vi.fn(), setManualDone: vi.fn(), finishCourse: vi.fn(), requestQuizAttempt: vi.fn(), quizAttemptStatus: vi.fn(), grantQuizAttempts: vi.fn(),
    addComment: vi.fn(), editComment: vi.fn(), deleteComment: vi.fn(), pinComment: vi.fn(), _unused: actual,
  };
});
vi.mock("./AcademyManage.jsx", () => ({ CourseEditor: () => null, PurposeVideoEditor: () => null, GuideEditor: () => null, PathEditor: () => null, AcademyManage: () => null, AcademyEditorScope: ({ children }) => children }));

import { Markdown, SafeText, QuizPanel, CourseCard, ProgressBar } from "./Academy.jsx";

describe("Markdown (safe subset)", () => {
  test("renders headings/lists/links as elements and HTML as text; links are https-only + noopener", () => {
    const { container } = render(<Markdown src={"# Heading\n\nText with **bold** and [a link](https://example.com/x) and <img src=x onerror=alert(1)>\n- one\n- two\n[bad](javascript:alert(1))"} />);
    expect(screen.getByRole("heading", { level: 3, name: "Heading" })).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    const a = screen.getByRole("link", { name: "a link" });
    expect(a).toHaveAttribute("href", "https://example.com/x");
    expect(a).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(container.textContent).toContain("bad");
  });
  test("SafeText (comments) autolinks and never injects markup", () => {
    const { container } = render(<p><SafeText text={"see https://x.io/a <b>no</b>"} /></p>);
    expect(screen.getByRole("link", { name: "https://x.io/a" })).toHaveAttribute("href", "https://x.io/a");
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("CourseCard", () => {
  const course = { id: "c", title: "Lighting Basics", category: "photography", level: "beginner", status: "published", lessonCount: 4, requiredLessonCount: 4, cover: { path: "academy/covers/c/v.jpg" } };
  test("the cover is decorative artwork (no text drawn over it); title/category/level/count sit below; one accessible button", () => {
    render(<CourseCard course={course} onOpen={() => {}} />);
    const btn = screen.getByRole("button", { name: "Lighting Basics" });
    const img = within(btn).getByRole("presentation", { hidden: true });   // alt="" → presentation
    expect(img).toHaveAttribute("src", "blob:academy/covers/c/v.jpg");
    expect(within(btn).getByText("Photography")).toBeInTheDocument();
    expect(within(btn).getByText(/Beginner · 4 lessons/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();   // not started → no bar
  });
  test("started → a real progressbar with the percentage; completed → the completed state", () => {
    const { rerender } = render(<CourseCard course={course} progress={{ startedAt: 1, lessons: { a: { videoWatched: true } } }} onOpen={() => {}} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(bar).toHaveAccessibleName("Lighting Basics: 25% complete");
    const all = { startedAt: 1, progressModel: 2, lessons: { a: { videoWatched: true }, b: { videoWatched: true }, c: { manualDone: true }, d: { videoWatched: true } } };
    rerender(<CourseCard course={course} progress={all} onOpen={() => {}} />);
    expect(screen.getByText("Ready to finish")).toBeInTheDocument();             // requirements done, Finish not pressed
    expect(screen.getByRole("button", { name: /\(ready to finish\)/ })).toBeInTheDocument();
    rerender(<CourseCard course={course} progress={{ ...all, finishedAt: 5 }} onOpen={() => {}} />);
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\(completed\)/ })).toBeInTheDocument();
  });
  test("a missing cover renders a quiet placeholder, never a generated title card", () => {
    const { container } = render(<CourseCard course={{ ...course, cover: null }} onOpen={() => {}} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".ac-img-empty")).toBeInTheDocument();
  });
  test("ProgressBar clamps and exposes min/max/now", () => {
    render(<ProgressBar percent={140} label="x" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
});

describe("QuizPanel", () => {
  const lesson = { id: "l1", title: "L", quiz: { mode: "required", passMark: 70, retryLimit: 0, questions: [
    { id: "q1", prompt: "Which f-stop is wider?", multi: false, options: [{ id: "a", text: "f/2" }, { id: "b", text: "f/8" }] },
    { id: "q2", prompt: "Pick two", multi: true, options: [{ id: "a", text: "x" }, { id: "b", text: "y" }, { id: "c", text: "z" }] },
  ] } };
  const me = { id: "u1" };
  test("questions are fieldsets with labelled radios/checkboxes; submitting unanswered shows per-question errors (no server call)", async () => {
    const submit = vi.fn();
    render(<QuizPanel lesson={lesson} courseId="c" me={me} state={{}} submit={submit} />);
    expect(screen.getByRole("group", { name: /Which f-stop is wider\?/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "f/2" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "z" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(await screen.findAllByRole("alert")).toHaveLength(2);
    expect(submit).not.toHaveBeenCalled();
  });
  test("grading is the server's: the panel sends answers, renders the returned score, correct options and explanations", async () => {
    const submit = vi.fn().mockResolvedValue({
      attemptId: "a1", score: 1, total: 2, percent: 50, passMark: 70, passed: false, mode: "required",
      results: [{ qId: "q1", correct: true, selected: ["a"], correctOptions: ["a"], explanation: "Smaller number, wider aperture." },
                { qId: "q2", correct: false, selected: ["a"], correctOptions: ["a", "c"], explanation: "" }],
    });
    render(<QuizPanel lesson={lesson} courseId="c" me={me} state={{}} submit={submit} />);
    fireEvent.click(screen.getByRole("radio", { name: "f/2" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "x" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("c", "l1", { q1: ["a"], q2: ["a"] }, expect.stringMatching(/^[a-z0-9]{8,}$/)));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Not yet");
    expect(status).toHaveTextContent("1 of 2 correct (50%)");
    expect(screen.getByText("Smaller number, wider aperture.")).toBeInTheDocument();
    expect(screen.getAllByText("Your answer · correct")).toHaveLength(2);   // q1 a, q2 a
    expect(screen.getByText("Correct answer · not selected")).toBeInTheDocument();   // q2 c, missed
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
  test("a failed submission shows the error and keeps the form", async () => {
    const submit = vi.fn().mockRejectedValue(Object.assign(new Error("You've used all the attempts for this quiz."), { code: "functions/resource-exhausted" }));
    render(<QuizPanel lesson={lesson} courseId="c" me={me} state={{}} submit={submit} />);
    fireEvent.click(screen.getByRole("radio", { name: "f/8" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "y" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("used all your attempts");
    expect(screen.getByRole("button", { name: "Submit answers" })).toBeInTheDocument();
  });
  test("retry limit reached → no form", () => {
    const attemptsHook = () => ({ docs: [{ id: "x", passed: false, percent: 20, createdAt: 1 }, { id: "y", passed: false, percent: 40, createdAt: 2 }], loaded: true });
    render(<QuizPanel lesson={{ ...lesson, quiz: { ...lesson.quiz, retryLimit: 2 } }} courseId="c" me={me} state={{}} submit={vi.fn()} attemptsHook={attemptsHook} />);
    expect(screen.queryByRole("button", { name: "Submit answers" })).toBeNull();
    expect(screen.getByText(/used all 2 attempts/)).toBeInTheDocument();
  });
  test("practice quizzes say they don't affect completion", () => {
    render(<QuizPanel lesson={{ ...lesson, quiz: { ...lesson.quiz, mode: "practice" } }} courseId="c" me={me} state={{}} submit={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Practice quiz" })).toBeInTheDocument();
    expect(screen.getByText(/doesn't affect completion/)).toBeInTheDocument();
  });
});

import { GuideCard, PathCard } from "./Academy.jsx";

describe("Library cards label their format and use the right artwork shape", () => {
  test("CourseCard with showFormat exposes 'Course'; GuideCard is a 16:9 thumb with no progress bar; PathCard is a portrait cover with a step count", () => {
    const { container, rerender } = render(<CourseCard course={{ id: "c", title: "Lighting", category: "videography", level: "beginner", status: "published", lessonCount: 2, requiredLessonCount: 2, cover: null }} onOpen={() => {}} showFormat />);
    expect(screen.getByRole("button", { name: "Lighting (course)" })).toBeInTheDocument();
    expect(screen.getByText("Course")).toBeInTheDocument();
    expect(screen.getByText("Filmmaking")).toBeInTheDocument();   // legacy "videography" reads as Filmmaking

    rerender(<GuideCard guide={{ id: "g", title: "Export for web", category: "photography", status: "published", body: "x", thumb: { path: "academy/guideThumbs/g/v.jpg" } }} review={{ reviewed: true }} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: "Export for web (resource) (reviewed)" })).toBeInTheDocument();
    expect(screen.getByText(/Written resource|Video resource/)).toBeInTheDocument();
    expect(screen.getByText("Reviewed")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.querySelector(".ac-guidethumb")).toHaveStyle({ aspectRatio: "16 / 9" });

    rerender(<PathCard path={{ id: "p", title: "Short-Form Content", category: "", status: "draft", items: [1, 2, 3], cover: null }} started onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: "Short-Form Content (learning path)" })).toBeInTheDocument();
    expect(screen.getByText("Learning path")).toBeInTheDocument();
    expect(screen.getByText(/3 steps · in progress/)).toBeInTheDocument();
    expect(screen.getByText("draft")).toBeInTheDocument();
    expect(container.querySelector(".ac-cover")).toHaveStyle({ aspectRatio: "3 / 4" });
  });
});

import { CategoryCard } from "./Academy.jsx";
import { ACADEMY_CATEGORIES } from "./academyProgress.js";

describe("CategoryCard", () => {
  test("portrait 3:4 poster; name + count below; iconic fallback when artwork is absent; legacy landscape art letterboxed, not cropped", () => {
    const filmmaking = { ...ACADEMY_CATEGORIES.find((c) => c.id === "filmmaking"), name: "Filmmaking" };
    const { container, rerender } = render(<CategoryCard category={filmmaking} count={4} onOpen={() => {}} />);
    expect(container.querySelector(".ac-catart")).toHaveStyle({ aspectRatio: "3 / 4" });
    expect(screen.getByRole("button", { name: "Filmmaking, 4 courses" })).toBeInTheDocument();
    expect(screen.getByText("Filmmaking")).toBeInTheDocument();
    expect(screen.getByText(filmmaking.purpose)).toBeInTheDocument();
    expect(container.querySelector(".ac-catart-fb.cat-filmmaking .ac-catart-mark svg")).toBeInTheDocument();   // centred icon mark, not an empty box
    expect(container.querySelector("img")).toBeNull();
    rerender(<CategoryCard category={filmmaking} count={1} imageRef={{ path: "academy/catCovers/filmmaking/v.jpg", w: 900, h: 1200 }} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: "Filmmaking, 1 course" })).toBeInTheDocument();
    const img = container.querySelector("img.ac-catart");
    expect(img).toHaveAttribute("src", "blob:academy/catCovers/filmmaking/v.jpg");
    expect(img).not.toHaveClass("ac-img-contain");
    expect(container.querySelector(".ac-catcard.wide")).toBeNull();      // no stretched cards
    // a pre-v4 LANDSCAPE upload is shown whole (contain), never silently cropped
    rerender(<CategoryCard category={filmmaking} count={0} imageRef={{ path: "academy/categoryArt/filmmaking/old.jpg", w: 1600, h: 900 }} onOpen={() => {}} />);
    expect(container.querySelector("img.ac-catart")).toHaveClass("ac-img-contain");
    expect(screen.getByRole("button", { name: "Filmmaking, 0 courses" })).toBeInTheDocument();
    // a brand-new record with no artwork gets a single centred initial in the mark (no stray icon)
    rerender(<CategoryCard category={{ id: "sound-and-audio", name: "Sound & Audio", label: "Sound & Audio", purpose: "" }} count={0} onOpen={() => {}} />);
    expect(container.querySelector(".ac-catart-fb .ac-catart-mark .ac-catart-initial")).toHaveTextContent("S");
    expect(container.querySelector(".ac-catart-fb svg")).toBeNull();
  });
});
