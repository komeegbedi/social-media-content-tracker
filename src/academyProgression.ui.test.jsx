/* IFC Creative Academy v6.5 — prerequisites, the end of a course and quiz
   attempts, rendered (RTL + jsdom, StrictMode). The data layer is mocked at its
   boundary: completeLesson / finishCourse / submitQuizAttempt are vi.fn()s, and
   "the server-written flag arriving" is simulated by re-rendering with new
   progress — exactly what the progress snapshot does in the app.
   Run: npm run test:ui */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import React from "react";

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn(), reportIssue: vi.fn(async () => true) }));
const data = vi.hoisted(() => ({ setManualDone: null, finishCourse: null, markVideoWatched: null, grant: null, status: null }));
vi.mock("./academyData.js", () => ({
  useImageUrl: () => ({ url: null, error: false }),
  useTopicRecords: () => ({ docs: [], byId: {}, loaded: true, error: null }),
  useAttempts: () => ({ docs: [], loaded: true, error: null }),
  submitQuiz: vi.fn(), grantQuizAttempts: (...a) => data.grant(...a), quizAttemptStatus: (...a) => data.status(...a), requestQuizAttempt: vi.fn(),
  useCourses: () => ({ courses: [], loaded: true, error: null }), useCourse: () => ({ data: null, loaded: true }),
  useLessons: () => ({ docs: [], loaded: true }), usePurposeVideo: () => ({ data: null, loaded: true }),
  useProgress: () => ({ data: null, loaded: true }), useAllProgress: () => ({ docs: [], loaded: true, byCourse: {} }),
  usePaths: () => ({ paths: [], loaded: true, error: null }), useAllGuideReviews: () => ({ docs: [], loaded: true, byGuide: {} }),
  useManyDocs: () => ({ byPath: {}, loaded: true }),
  useComments: () => ({ docs: [], loaded: true }), useLeaderProgress: () => ({ docs: [], loaded: true }), useLeaderAttempts: () => ({ docs: [], loaded: true }),
  recordLessonView: vi.fn(async () => {}), startCourse: vi.fn(async () => {}), savePlayback: vi.fn(async () => {}),
  markVideoWatched: (...a) => data.markVideoWatched(...a),
  setManualDone: (...a) => data.setManualDone(...a),
  finishCourse: (...a) => data.finishCourse(...a),
  addComment: vi.fn(), editComment: vi.fn(), deleteComment: vi.fn(), pinComment: vi.fn(),
}));
vi.mock("./AcademyManage.jsx", () => ({ PurposeVideoEditor: () => null, GuideEditor: () => null, PathEditor: () => null, AcademyEditorScope: ({ children }) => children }));

import { LessonBody, CourseOverviewBody, QuizPanel } from "./Academy.jsx";
import { reportIssue } from "./logging";

let reduceMotion = false;
beforeEach(() => {
  reduceMotion = false;
  window.matchMedia = (q) => ({ matches: /reduce/.test(q) ? reduceMotion : /min-width: 1000px/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
  Element.prototype.scrollIntoView = vi.fn();
  HTMLCanvasElement.prototype.getContext = () => null;
  data.setManualDone = vi.fn(async () => ({ ok: true }));
  data.markVideoWatched = vi.fn(async () => ({ ok: true }));
  data.finishCourse = vi.fn(async () => ({ already: false, finishedAt: Date.UTC(2026, 10, 12, 12), required: 5 }));
});

/* a → v → q is a prerequisite chain; d has none (required, open directly);
   adv needs BOTH q and d; bonus is an optional trailing lesson. */
const quiz = { mode: "required", passMark: 70, questions: [{ id: "x", prompt: "Pick one", options: [{ id: "o1", text: "One" }, { id: "o2", text: "Two" }] }] };
const course = { id: "c1", title: "Lighting Basics", category: "photography", status: "published", modules: [{ id: "m", title: "", lessonIds: ["a", "v", "q", "d", "adv", "bonus"] }] };
const lessons = [
  { id: "a", title: "Reading the light", description: "SECRET LESSON TEXT A" },
  { id: "v", title: "Watch the demo", video: { provider: "youtube", id: "dQw4w9WgXcQ" }, description: "SECRET LESSON TEXT V", prerequisites: ["a"] },
  { id: "q", title: "Check yourself", quiz, prerequisites: ["v"] },
  { id: "d", title: "Drive walkthrough", video: { provider: "gdrive", id: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345" } },
  { id: "adv", title: "Advanced lighting", description: "SECRET ADV", prerequisites: ["q", "d"] },
  { id: "bonus", title: "Optional extra", bonus: true },
];
const me = { id: "u1", name: "Sam", role: "member", status: "approved" };
const done = (...ids) => Object.fromEntries(ids.map((id) => [id, id === "v" ? { videoWatched: true } : { manualDone: true }]));
const allRequired = { startedAt: 1, progressModel: 2, lessons: done("a", "v", "d", "adv"), earned: { q: { at: 1 } } };

function setup(props) {
  const R = { navigate: vi.fn(), replace: vi.fn() };
  const el = (p) => <React.StrictMode><LessonBody me={me} users={[]} R={R} c={course} lessons={lessons} courseId="c1" progress={null} {...props} {...p} /></React.StrictMode>;
  const utils = render(el({}));
  return { R, ...utils, update: (p) => utils.rerender(el(p)) };
}
const nextBtn = () => screen.getByRole("button", { name: /Next lesson/ });

describe("prerequisites, not blanket order", () => {
  test("required lessons with no prerequisites open directly; only explicit prerequisites lock", () => {
    const first = setup({ lessonId: "a" });
    expect(screen.getAllByText(/\(locked\)/).length).toBe(3);                    // v, q, adv — not d, not bonus
    first.unmount();
    const { container } = setup({ lessonId: "d" });                              // required, no prerequisites
    expect(container.querySelector(".ac-locked")).toBeNull();
    expect(screen.getByRole("button", { name: "Mark as watched" })).toBeInTheDocument();
  });
  test("one prerequisite: “Complete Reading the light to unlock this lesson.” with a route; no content rendered", () => {
    const { R } = setup({ lessonId: "v" });
    expect(document.querySelector(".ac-locked")).not.toBeNull();
    expect(document.querySelector(".ac-locked-why")).toHaveTextContent("Complete Reading the light to unlock this lesson.");
    expect(screen.queryByText("SECRET LESSON TEXT V")).toBeNull();
    expect(screen.queryByRole("button", { name: /Play video/ })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Watch the demo" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Go to “Reading the light”" }));
    expect(R.navigate).toHaveBeenCalledWith("/learn/course/c1/lesson/a");
  });
  test("several prerequisites: a checklist (done / locked) and a route through the chain to an open lesson", () => {
    const { R } = setup({ lessonId: "adv", progress: { progressModel: 2, lessons: done("a", "d") } });
    expect(screen.getByText("Complete these lessons to unlock this one:")).toBeInTheDocument();
    const items = within(document.querySelector(".ac-prereqcheck")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["Check yourselfLocked. Complete “Watch the demo” first.", "Drive walkthroughCompleted"]);
    fireEvent.click(screen.getByRole("button", { name: "Go to “Watch the demo”" }));     // adv → q (locked) → v (open)
    expect(R.navigate).toHaveBeenCalledWith("/learn/course/c1/lesson/v");
    expect(screen.queryByText("SECRET ADV")).toBeNull();
  });
  test("path context is kept on prerequisite recovery links", () => {
    const { R } = setup({ lessonId: "v", pathCtx: "p1" });
    fireEvent.click(screen.getByRole("button", { name: "Go to “Reading the light”" }));
    expect(R.navigate).toHaveBeenCalledWith("/learn/course/c1/lesson/a?path=p1");
  });
  test("an unpassed required quiz blocks only what depends on it; Next to an unrelated lesson stays open", () => {
    setup({ lessonId: "q", progress: { progressModel: 2, lessons: done("a", "v") } });
    expect(screen.getByRole("heading", { name: "Pass the quiz to complete this lesson" })).toBeInTheDocument();
    expect(nextBtn()).toBeEnabled();                                              // Next = Drive walkthrough (no prerequisites)
    expect(within(nextBtn()).getByText("Drive walkthrough")).toBeInTheDocument();
  });
  test("Next to a locked lesson: precise reason + a route to the prerequisite and to another open lesson", () => {
    const { R } = setup({ lessonId: "d", progress: { progressModel: 2, lessons: done("a", "v") } });
    expect(nextBtn()).toBeDisabled();
    expect(nextBtn()).toHaveAccessibleDescription("Complete “Check yourself” and this lesson to unlock the next lesson.");
    expect(screen.getByRole("button", { name: "Or open “Optional extra”" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to “Check yourself”" }));
    expect(R.navigate).toHaveBeenCalledWith("/learn/course/c1/lesson/q");
  });
  test("editors follow prerequisites in the learner view; the preview locks nothing", () => {
    const first = setup({ lessonId: "v", editor: true });
    fireEvent.click(screen.getByRole("button", { name: "open it in the preview" }));
    expect(first.R.navigate).toHaveBeenCalledWith("/learn/preview/course/c1/lesson/v");
    first.unmount();
    setup({ lessonId: "adv", preview: true });
    expect(screen.queryByText("Complete these lessons to unlock this one:")).toBeNull();
    expect(screen.getByText("SECRET ADV")).toBeInTheDocument();
  });
});

describe("round 7: copy follows the real prerequisites; completion said once", () => {
  test("a video whose next lesson is open never claims to unlock it", () => {
    const open = lessons.map((l) => (l.id === "q" ? { ...l, prerequisites: [] } : l));
    setup({ lessonId: "v", lessons: open, progress: { progressModel: 2, lessons: done("a") } });
    expect(nextBtn()).toBeEnabled();
    const p = screen.getByText(/tells us when the video ends/);
    expect(p).toHaveTextContent("YouTube tells us when the video ends, so this lesson completes on its own.");
    expect(p.textContent).not.toMatch(/unlock/);
  });
  test("a video the next lesson depends on says so", () => {
    setup({ lessonId: "v", progress: { progressModel: 2, lessons: done("a") } });
    expect(screen.getByText(/tells us when the video ends/)).toHaveTextContent("so this lesson completes on its own. That unlocks the next lesson.");
  });
  test("a required quiz whose next lesson is open: no unlock claim", () => {
    setup({ lessonId: "q", progress: { progressModel: 2, lessons: done("a", "v") } });
    expect(screen.getByText(/graded when you submit/).textContent).not.toMatch(/unlock/);
  });
  test("revisiting a completed lesson: a small Completed status, no second big confirmation", () => {
    setup({ lessonId: "a", progress: { progressModel: 2, lessons: done("a") } });
    expect(screen.getByText("Completed", { selector: ".ac-lessonstatus" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Lesson completed" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark as not complete" })).toBeInTheDocument();
  });
});

describe("completing a lesson", () => {
  test("written: Complete lesson; Next (which needs it) waits for the CONFIRMED server flag", async () => {
    let resolve;
    data.setManualDone = vi.fn(() => new Promise((r) => { resolve = r; }));
    const { update } = setup({ lessonId: "a" });
    expect(screen.getByText("Finished reading? Mark this lesson complete. It unlocks the next lesson.")).toBeInTheDocument();
    expect(nextBtn()).toHaveAccessibleDescription("Complete this lesson to unlock the next one.");
    fireEvent.click(screen.getByRole("button", { name: "Complete lesson" }));
    fireEvent.click(screen.getByRole("button", { name: /Complete lesson|Saving/ }));
    expect(data.setManualDone).toHaveBeenCalledTimes(1);
    expect(nextBtn()).toHaveAccessibleDescription("Saving your progress…");
    await act(async () => resolve({ ok: true }));
    expect(nextBtn()).toBeDisabled();
    update({ lessonId: "a", progress: { startedAt: 1, progressModel: 2, lessons: done("a") } });
    expect(await screen.findByRole("heading", { name: "Lesson completed" })).toBeInTheDocument();
    expect(nextBtn()).toBeEnabled();
  });
  test("a refused save says why; nothing unlocks", async () => {
    data.setManualDone = vi.fn(async () => { const e = new Error("Complete “Reading the light” to unlock this lesson."); e.code = "functions/failed-precondition"; throw e; });
    setup({ lessonId: "a" });
    fireEvent.click(screen.getByRole("button", { name: "Complete lesson" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Complete “Reading the light” to unlock this lesson.");
  });
  test("tracked video: no manual bypass; playback written by the client can't fake completion", () => {
    setup({ lessonId: "v", progress: { lessons: done("a"), playback: { v: { positionSec: 65, durationSec: 300, videoWatched: true, manualDone: true } } } });
    expect(screen.getByText("You're at 1:05 of 5:00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Complete lesson|Mark as watched/ })).toBeNull();
    expect(nextBtn()).toHaveAccessibleDescription("Watch the video to the end to unlock the next lesson.");
  });
  test("unplayable video: explained blocker + report via Report an issue; never auto-completed", async () => {
    const broken = lessons.map((l) => (l.id === "a" ? { ...l, video: { provider: "nope", id: "x" } } : l));
    setup({ lessonId: "a", lessons: broken });
    expect(screen.getByRole("heading", { name: "This lesson can't be completed yet" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Report this problem" }));
    expect(await screen.findByText(/Thanks for reporting it/)).toBeInTheDocument();
    expect(reportIssue).toHaveBeenCalledWith(expect.objectContaining({ action: "academy content unavailable" }));
    expect(data.setManualDone).not.toHaveBeenCalled();
  });
  test("an optional lesson says it can be skipped", () => {
    setup({ lessonId: "bonus" });
    expect(screen.getByText(/Optional\. You can skip this lesson/)).toBeInTheDocument();
  });
});

describe("Finish course", () => {
  test("ready after finishing requirements OUT OF ORDER, on a middle lesson: Finish + Explore bonus lessons; one call; celebration", async () => {
    let resolve;
    data.finishCourse = vi.fn(() => new Promise((r) => { resolve = r; }));
    setup({ lessonId: "d", progress: allRequired });
    expect(screen.getByRole("button", { name: "Explore bonus lessons" })).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Finish course" });
    fireEvent.click(btn); fireEvent.click(btn);
    expect(data.finishCourse).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "You did it!" })).toBeNull();          // nothing before the server confirms
    await act(async () => resolve({ already: false, finishedAt: Date.UTC(2026, 10, 12, 12), required: 5 }));
    expect(await screen.findByRole("heading", { name: "You did it!" })).toHaveFocus();
    await waitFor(() => expect(document.querySelector(".ac-celebrate [role=status]").textContent).toBe("Course completed. You've completed Lighting Basics."));
    expect(document.querySelector(".ac-confetti")).not.toBeNull();
  });
  test("reduced motion: the same panel, no confetti", async () => {
    reduceMotion = true;
    setup({ lessonId: "d", progress: allRequired });
    fireEvent.click(screen.getByRole("button", { name: "Finish course" }));
    expect(await screen.findByRole("heading", { name: "You did it!" })).toBeInTheDocument();
    expect(document.querySelector(".ac-confetti")).toBeNull();
  });
  test("already finished elsewhere → calm completed state, no celebration", async () => {
    data.finishCourse = vi.fn(async () => ({ already: true, finishedAt: 5 }));
    setup({ lessonId: "d", progress: allRequired });
    fireEvent.click(screen.getByRole("button", { name: "Finish course" }));
    expect(await screen.findByRole("heading", { name: "Course completed" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "You did it!" })).toBeNull();
  });
  test("refused → explained, recoverable", async () => {
    data.finishCourse = vi.fn(async () => { const e = new Error("1 required lesson is still incomplete."); e.code = "functions/failed-precondition"; throw e; });
    setup({ lessonId: "d", progress: allRequired });
    fireEvent.click(screen.getByRole("button", { name: "Finish course" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 required lesson is still incomplete. Complete it, then finish the course.");
    expect(screen.getByRole("button", { name: "Finish course" })).toBeEnabled();
  });
  test("HISTORICAL completion (all done before Finish course existed — no progressModel) stays completed, never 'ready to finish'", () => {
    const { progressModel, ...legacy } = allRequired;
    setup({ lessonId: "bonus", progress: legacy });
    expect(screen.getByRole("heading", { name: "Course completed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finish course" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "You did it!" })).toBeNull();
  });
  test("revisit after finishing: calm panel with the date; never the celebration", () => {
    setup({ lessonId: "bonus", progress: { ...allRequired, finishedAt: Date.UTC(2026, 10, 1, 12), finishedRequired: 5 } });
    expect(screen.getByText(/You finished/)).toHaveTextContent(/on .*2026/);
    expect(screen.queryByRole("heading", { name: "You did it!" })).toBeNull();
  });
  test("work left on the last lesson → the way to an OPEN requirement", () => {
    const { R } = setup({ lessonId: "bonus", progress: { startedAt: 1, progressModel: 2, lessons: done("a", "v", "bonus") } });
    expect(screen.getByText(/3 required lessons are/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue remaining lessons" }));
    expect(R.navigate).toHaveBeenCalledWith("/learn/course/c1/lesson/q");
  });
});

describe("course overview", () => {
  const R = { navigate: vi.fn(), replace: vi.fn() };
  const ov = (progress) => render(<CourseOverviewBody me={me} users={[]} R={R} c={course} lessons={lessons} progress={progress} courseId="c1" editor={false} leader={false} />);
  test("ready → Finish course is the primary action; a legacy completion → Completed", () => {
    const first = ov(allRequired);
    expect(screen.getByText("All required lessons are complete. You're ready to finish.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review lessons" })).toHaveClass("ghost");
    first.unmount();
    const { progressModel, ...legacy } = allRequired;
    ov(legacy);
    expect(document.querySelector(".ac-summary")).toHaveTextContent(/^Completed/);
    expect(screen.queryByRole("button", { name: "Finish course" })).toBeNull();
  });
  test("the curriculum marks only lessons whose prerequisites aren't met", () => {
    ov({ startedAt: 1, progressModel: 2, lessons: done("a") });
    expect(screen.getAllByText(/\(locked\)/).length).toBe(2);                      // q (needs v), adv (needs q + d)
    expect(screen.getByText(/2 lessons to complete first/)).toBeInTheDocument();
  });
});

describe("quiz attempts", () => {
  const lesson = { id: "q", title: "Check yourself", quiz: { ...quiz, retryLimit: 3, questions: [...quiz.questions, { id: "m", prompt: "Which two?", multi: true, options: [{ id: "p", text: "P" }, { id: "r", text: "R" }, { id: "z", text: "Z" }] }] } };
  const hook = (n) => () => ({ docs: Array.from({ length: n }, (_, i) => ({ id: "t" + i, passed: false, percent: 50, createdAt: i })), loaded: true });
  test("before submitting: 'Attempt 2 of 3'; unlimited quizzes say so; multi-select is checkboxes with instructions", () => {
    const first = render(<QuizPanel lesson={lesson} courseId="c1" me={me} state={{}} submit={vi.fn()} attemptsHook={hook(1)} />);
    expect(screen.getByText(/Attempt 2 of 3/)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByText("Select all correct answers.")).toBeInTheDocument();
    first.unmount();
    render(<QuizPanel lesson={{ ...lesson, quiz: { ...lesson.quiz, retryLimit: 0 } }} courseId="c1" me={me} state={{}} submit={vi.fn()} attemptsHook={hook(7)} />);
    expect(screen.getByText(/Unlimited attempts/)).toBeInTheDocument();
  });
  test("every selected checkbox is sent; a failed attempt with attempts left shows a prominent Try again", async () => {
    const submit = vi.fn().mockResolvedValue({ score: 1, total: 2, percent: 50, passMark: 70, passed: false, mode: "required", attemptsUsed: 2, results: [{ qId: "x", correct: true, selected: ["o1"], correctOptions: ["o1"] }, { qId: "m", correct: false, selected: ["p"], correctOptions: ["p", "r"] }] });
    render(<QuizPanel lesson={lesson} courseId="c1" me={me} state={{}} submit={submit} attemptsHook={hook(1)} />);
    fireEvent.click(screen.getByRole("radio", { name: "One" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "P" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Z" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Z" }));                       // un-tick
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("c1", "q", { x: ["o1"], m: ["p"] }, expect.any(String)));
    expect(await screen.findByRole("button", { name: "Try again" })).toHaveClass("sb-btn");
    expect(screen.getByText(/1 attempt left/)).toBeInTheDocument();
    expect(screen.getByText("Correct answer · not selected")).toBeInTheDocument();
  });
  test("network failure → retry reuses the SAME submission id (no second attempt); Try again starts a new one", async () => {
    const ids = [];
    const submit = vi.fn(async (c, l, a, id) => { ids.push(id); if (ids.length === 1) { const e = new Error("fetch failed"); e.code = "functions/unavailable"; throw e; } return { score: 0, total: 2, percent: 0, passMark: 70, passed: false, mode: "required", results: [] }; });
    render(<QuizPanel lesson={lesson} courseId="c1" me={me} state={{}} submit={submit} attemptsHook={hook(0)} />);
    fireEvent.click(screen.getByRole("radio", { name: "Two" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Z" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/won't use an extra attempt/);
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    await screen.findByRole("button", { name: "Try again" });
    expect(ids[0]).toBe(ids[1]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("radio", { name: "Two" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Z" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    await waitFor(() => expect(ids).toHaveLength(3));
    expect(ids[2]).not.toBe(ids[0]);
  });
  test("exhausted: explained, with a real recovery (ask staff); a staff grant brings the form back", async () => {
    const request = vi.fn(async () => true);
    const { rerender } = render(<QuizPanel lesson={lesson} courseId="c1" me={me} state={{}} submit={vi.fn()} attemptsHook={hook(3)} request={request} courseTitle="Lighting Basics" />);
    expect(screen.getByText("You've used all 3 attempts for this quiz.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit answers" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask for another attempt" }));
    expect(await screen.findByText(/Request sent\. Academy editors will see it on this course's page\./)).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith("c1", "q");
    rerender(<QuizPanel lesson={lesson} courseId="c1" me={me} state={{}} submit={vi.fn()} attemptsHook={hook(3)} request={request} extraAttempts={1} />);
    expect(screen.getByText(/Attempt 4 of 4/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit answers" })).toBeInTheDocument();
  });
  test("an earlier pass is kept when a later attempt fails", async () => {
    const submit = vi.fn().mockResolvedValue({ score: 0, total: 2, percent: 0, passMark: 70, passed: false, mode: "required", results: [] });
    render(<QuizPanel lesson={{ ...lesson, quiz: { ...lesson.quiz, retryLimit: 0 } }} courseId="c1" me={me} state={{ earned: true }} submit={submit} attemptsHook={hook(0)} />);
    fireEvent.click(screen.getByRole("radio", { name: "Two" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Z" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(await screen.findByText("You passed this quiz earlier, so the lesson stays complete.")).toBeInTheDocument();
  });
});

describe("v6.6: broken prerequisite data + recommended prior knowledge never gates", () => {
  test("broken published data (prerequisite is a LATER lesson): honest unavailable state + report; not completable; others unaffected", async () => {
    const broken = lessons.map((l) => (l.id === "a" ? { ...l, prerequisites: ["d"] } : l));
    const { R } = setup({ lessonId: "a", lessons: broken, editor: true });
    expect(screen.getByText("This lesson isn't available right now.")).toBeInTheDocument();
    expect(screen.queryByText("SECRET LESSON TEXT A")).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete lesson" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Report this problem" }));
    expect(await screen.findByText(/Thanks for reporting it/)).toBeInTheDocument();
    expect(reportIssue).toHaveBeenCalledWith(expect.objectContaining({ action: "academy prerequisite problem" }));
    fireEvent.click(screen.getByRole("button", { name: "course workspace" }));
    expect(R.navigate).toHaveBeenCalledWith(expect.stringContaining("/learn/manage"));
    expect(screen.getAllByText(/Unavailable · its setup needs fixing/).length).toBeGreaterThan(0);
  });
  test("an earned completion of a now-broken lesson stays reviewable", () => {
    const broken = lessons.map((l) => (l.id === "a" ? { ...l, prerequisites: ["d"] } : l));
    setup({ lessonId: "a", lessons: broken, progress: { progressModel: 2, lessons: done("a") } });
    expect(screen.getByText("SECRET LESSON TEXT A")).toBeInTheDocument();
  });
  test("recommended prior knowledge (not completed) never disables Start or blocks Finish, and isn't in the percentage", () => {
    const R = { navigate: vi.fn(), replace: vi.fn() };
    const withPk = { ...course, priorKnowledge: { courseIds: ["elsewhere"], note: "Know Resolve basics." } };
    const first = render(<CourseOverviewBody me={me} users={[]} R={R} c={withPk} lessons={lessons} progress={null} courseId="c1" editor={false} leader={false} />);
    expect(screen.getByRole("heading", { name: "Recommended prior knowledge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start course" })).toBeEnabled();
    first.unmount();
    render(<CourseOverviewBody me={me} users={[]} R={R} c={withPk} lessons={lessons} progress={allRequired} courseId="c1" editor={false} leader={false} />);
    expect(screen.getByText("All required lessons are complete. You're ready to finish.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish course" })).toBeEnabled();
  });
});

describe("v6.6: Quiz attempts panel for Academy editors who aren't leads", () => {
  test("editor (not a lead): the panel appears without the lead-only Learner progress; grant → refreshed; requests first", async () => {
    const rows = [{ uid: "s", name: "Sam", lessonId: "q", lessonTitle: "Check yourself", used: 3, allowed: 3, extra: 0, passed: false, exhausted: true, requestedAt: Date.UTC(2026, 10, 12), lastGrant: null }];
    data.status = vi.fn(async () => ({ quizzes: [{ lessonId: "q", title: "Check yourself", limit: 3 }], rows }));
    data.grant = vi.fn(async () => ({ extra: 1, allowed: 4 }));
    const editorMe = { id: "e", name: "Ed", role: "member", status: "approved", academyEditor: true };
    render(<CourseOverviewBody me={editorMe} users={[]} R={{ navigate: vi.fn() }} c={course} lessons={lessons} progress={null} courseId="c1" editor leader={false} />);
    expect(screen.queryByRole("heading", { name: "Learner progress" })).toBeNull();
    fireEvent.click(within(screen.getByRole("heading", { name: "Quiz attempts" }).closest("section")).getByRole("button", { name: "Show" }));
    expect(await screen.findByText(/asked for another attempt/)).toBeInTheDocument();
    expect(screen.getByText(/out of attempts/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Give 1 more attempt" }));
    expect(await screen.findByText("Sam now has 4 attempts.")).toBeInTheDocument();
    expect(data.grant).toHaveBeenCalledWith("s", "c1", "q", 1);
    expect(data.status).toHaveBeenCalledTimes(2);                                   // reloaded after the grant
  });
  test("learners never see the panel", () => {
    render(<CourseOverviewBody me={me} users={[]} R={{ navigate: vi.fn() }} c={course} lessons={lessons} progress={null} courseId="c1" editor={false} leader={false} />);
    expect(screen.queryByRole("heading", { name: "Quiz attempts" })).toBeNull();
  });
  test("a request already on record shows as sent", () => {
    const l = { id: "q", title: "Check yourself", quiz: { ...quiz, retryLimit: 1 } };
    render(<QuizPanel lesson={l} courseId="c1" me={me} state={{}} submit={vi.fn()} attemptsHook={() => ({ docs: [{ id: "x", passed: false, percent: 0, createdAt: 1 }], loaded: true })} requestedAt={5} />);
    expect(screen.getByText(/Request sent/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask for another attempt" })).toBeNull();
  });
});
