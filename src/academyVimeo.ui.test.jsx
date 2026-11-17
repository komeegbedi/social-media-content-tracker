/* Vimeo lesson: failure, slow loading, blocked autoplay and Retry on the real
   lesson page (LessonBody). ALL PLAYER EVENTS HERE ARE SIMULATED: they are
   postMessage events dispatched from the test as if they came from
   player.vimeo.com; no Vimeo player runs in jsdom. Real Vimeo playback stays
   unverified until it succeeds in a normal browser.
   The data layer is mocked; completion writes are spies, so "no completion
   awarded" means markVideoWatched / setManualDone were never called.
   Run: npm run test:ui */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import React from "react";

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn(), reportIssue: vi.fn(async () => true) }));
vi.mock("./academyData.js", () => ({
  useImageUrl: () => ({ url: null, error: false }),
  useAttempts: () => ({ docs: [], loaded: true, error: null }),
  submitQuiz: vi.fn(), useCourses: () => ({ courses: [], loaded: true, error: null }), useCourse: () => ({ data: null, loaded: true }),
  useLessons: () => ({ docs: [], loaded: true }), usePurposeVideo: () => ({ data: null, loaded: true }),
  useProgress: () => ({ data: null, loaded: true }), useAllProgress: () => ({ docs: [], loaded: true, byCourse: {} }),
  useComments: () => ({ docs: [], loaded: true }), useLeaderProgress: () => ({ docs: [], loaded: true }), useLeaderAttempts: () => ({ docs: [], loaded: true }),
  recordLessonView: vi.fn(), startCourse: vi.fn(), savePlayback: vi.fn(async () => {}), markVideoWatched: vi.fn(async () => {}), setManualDone: vi.fn(async () => {}),
  finishCourse: vi.fn(), requestQuizAttempt: vi.fn(), quizAttemptStatus: vi.fn(), grantQuizAttempt: vi.fn(),
  addComment: vi.fn(), editComment: vi.fn(), deleteComment: vi.fn(), pinComment: vi.fn(),
}));
vi.mock("./AcademyManage.jsx", () => ({ CourseEditor: () => null, PurposeVideoEditor: () => null, GuideEditor: () => null, PathEditor: () => null, AcademyManage: () => null, AcademyEditorScope: ({ children }) => children }));

import { LessonBody } from "./Academy.jsx";
import { markVideoWatched, setManualDone, savePlayback } from "./academyData.js";
import { VIMEO_SLOW_MS } from "./academyVideo.js";

const me = { id: "u1", name: "Learner", role: "member", status: "approved" };
const course = { id: "c1", title: "Video course", status: "published", modules: [{ id: "m1", title: "Module", lessonIds: ["vm", "after"] }] };
const lessons = [
  { id: "vm", title: "Vimeo lesson", kind: "video", video: { provider: "vimeo", id: "76979871" }, durationSec: 62, prerequisites: [] },
  { id: "after", title: "After", kind: "written", prerequisites: ["vm"] },
];
const progress = { lessons: {}, playback: { vm: { positionSec: 20, durationSec: 62 } } };   // existing progress to preserve

/* SIMULATED Vimeo player message from the current embed */
function vimeo(event, data) {
  const frame = document.querySelector(".ac-lessonplayer iframe");
  if (!frame) throw new Error("no Vimeo iframe mounted");
  act(() => { window.dispatchEvent(new MessageEvent("message", { origin: "https://player.vimeo.com", source: frame.contentWindow, data: JSON.stringify(data === undefined ? { event } : { event, data }) })); });
}
function openLesson() {
  render(<LessonBody me={me} users={[]} R={{ navigate: vi.fn() }} c={course} lessons={lessons} progress={progress} courseId="c1" lessonId="vm" />);
  fireEvent.click(screen.getByRole("button", { name: /^Play video: Vimeo lesson/ }));
  return document.querySelector(".ac-lessonplayer iframe");
}
const completionArea = () => document.querySelector(".ac-completion");
const noCompletionWrites = () => { expect(markVideoWatched).not.toHaveBeenCalled(); expect(setManualDone).not.toHaveBeenCalled(); };

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe("Vimeo lesson (simulated player events)", () => {
  test("a reported player error: clear message, Retry, Open original kept, failure guidance with Report, no completion, progress untouched", () => {
    openLesson();
    expect(completionArea().textContent).toMatch(/Watch the video to the end to complete this lesson/);
    vimeo("ready");
    vimeo("error", { name: "PrivacyError", message: "Because of its privacy settings, this video cannot be played here." });
    // player: message instead of the embed, with Retry; the original link stays
    expect(document.querySelector(".ac-lessonplayer iframe")).toBeNull();
    expect(screen.getByText(/Vimeo reported a problem playing this video/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    const original = screen.getByRole("link", { name: /Open original on Vimeo/ });
    expect(original).toHaveAttribute("href", "https://vimeo.com/76979871");
    // completion: the automatic-completion guidance is replaced, the external-site caveat is explained, Report is offered
    const area = completionArea();
    expect(area.textContent).not.toMatch(/Watch the video to the end to complete this lesson/);
    expect(within(area).getByRole("heading", { name: /can't be completed yet/ })).toBeInTheDocument();
    expect(area.textContent).toMatch(/watching it there can't mark this lesson complete in the Academy/);
    expect(within(area).getByRole("button", { name: "Report this problem" })).toBeInTheDocument();
    expect(within(area).queryByRole("button", { name: /Complete lesson|Mark as watched/ })).toBeNull();
    expect(screen.getByText(/didn't play here, so the next lesson can't unlock yet/)).toBeInTheDocument();
    // opening Vimeo externally awards nothing
    fireEvent.click(original);
    noCompletionWrites();
    expect(savePlayback).not.toHaveBeenCalled();   // existing position (20 s) is left as it was
  });

  test("slow loading without an error is neutral: no 'unavailable' claim, normal guidance kept, Retry offered; ready clears it", () => {
    vi.useFakeTimers();
    openLesson();
    act(() => { vi.advanceTimersByTime(VIMEO_SLOW_MS - 1); });
    expect(screen.queryByText(/taking longer than usual/)).toBeNull();
    act(() => { vi.advanceTimersByTime(2); });
    expect(screen.getByText(/taking longer than usual to load/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(document.querySelector(".ac-lessonplayer iframe")).not.toBeNull();       // the embed stays: it may still load
    expect(screen.queryByText(/reported a problem|can't be played|can't be completed/)).toBeNull();
    expect(completionArea().textContent).toMatch(/Watch the video to the end to complete this lesson/);
    vimeo("ready");
    expect(screen.queryByText(/taking longer than usual/)).toBeNull();
    noCompletionWrites();
  });

  test("autoplay blocked until a user gesture: a 'press play' hint, not a failure; rejected API calls and pauses are ignored; playing to the end then completes", () => {
    openLesson();
    vimeo("ready");
    vimeo("error", { name: "NotAllowedError", message: "play() failed because the user didn't interact with the document first." });
    expect(screen.getByText("Press play in the video to start it.")).toBeInTheDocument();
    vimeo("error", { method: "setCurrentTime", name: "RangeError", message: "Seconds must be within range" });
    vimeo("pause", { seconds: 0 });
    expect(document.querySelector(".ac-lessonplayer iframe")).not.toBeNull();
    expect(screen.queryByText(/reported a problem/)).toBeNull();
    expect(completionArea().textContent).toMatch(/Watch the video to the end to complete this lesson/);
    noCompletionWrites();
    // the learner presses play inside the player (simulated events from it)
    vimeo("play", { seconds: 0, duration: 62 });
    expect(screen.queryByText("Press play in the video to start it.")).toBeNull();
    vimeo("timeupdate", { seconds: 30, duration: 62 });
    vimeo("ended", { seconds: 62, duration: 62 });
    expect(markVideoWatched).toHaveBeenCalledTimes(1);
    expect(markVideoWatched).toHaveBeenCalledWith("u1", "c1", "vm");
    expect(setManualDone).not.toHaveBeenCalled();
  });

  test("Retry reloads the embed; failure guidance stays until real playback, then normal guidance and end-event completion return", () => {
    const first = openLesson();
    vimeo("ready");
    vimeo("error", { name: "NotFoundError" });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    const second = document.querySelector(".ac-lessonplayer iframe");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);                                        // a fresh embed
    noCompletionWrites();                                                  // retrying awards nothing
    vimeo("ready");                                                        // loading again is not proof of playback
    expect(completionArea().textContent).toMatch(/can't be completed yet/);
    vimeo("play", { seconds: 0, duration: 62 });                           // a play REQUEST alone is not proof (it can still fail)
    expect(completionArea().textContent).toMatch(/can't be completed yet/);
    vimeo("playing", { seconds: 0, duration: 62 });                        // playback actually started after Retry
    expect(completionArea().textContent).not.toMatch(/can't be completed yet/);
    expect(completionArea().textContent).toMatch(/Watch the video to the end/);
    expect(screen.queryByText(/didn't play here/)).toBeNull();
    noCompletionWrites();
    vimeo("ended", { seconds: 62, duration: 62 });
    expect(markVideoWatched).toHaveBeenCalledTimes(1);
  });

  test("a failure that repeats after Retry shows the failure again and still awards nothing", () => {
    openLesson();
    vimeo("error", { name: "PrivacyError" });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    vimeo("ready");
    vimeo("error", { name: "PrivacyError" });
    expect(screen.getByText(/Vimeo reported a problem playing this video/)).toBeInTheDocument();
    expect(completionArea().textContent).toMatch(/can't be completed yet/);
    noCompletionWrites();
  });

  test("messages from other origins or other frames are ignored", () => {
    openLesson();
    const frame = document.querySelector(".ac-lessonplayer iframe");
    act(() => { window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", source: frame.contentWindow, data: JSON.stringify({ event: "error", data: { name: "PrivacyError" } }) })); });
    act(() => { window.dispatchEvent(new MessageEvent("message", { origin: "https://player.vimeo.com", source: window, data: JSON.stringify({ event: "ended", data: { duration: 62 } }) })); });
    expect(document.querySelector(".ac-lessonplayer iframe")).not.toBeNull();
    noCompletionWrites();
  });
});
