/* Learn landing: what may hold up the first screen, and what it may claim.
   The real LearnHome (through the Academy entry) with the data hooks mocked
   and controllable: each test sets categories / topics / courses / history to
   loading, empty, populated or failed and checks what the learner sees.
   Run: npm run test:ui */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import React from "react";
import { defaultCategoryRecords } from "./academyProgress.js";

const D = {};
const calls = { topics: 0, courses: [], guides: [], paths: [] };
const loading = { docs: [], loaded: false, error: null };
const ok = (docs = []) => ({ docs, loaded: true, error: null });

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn(), reportIssue: vi.fn() }));
vi.mock("./AcademyManage.jsx", () => ({ AcademyEditorScope: ({ children }) => children, PurposeVideoEditor: () => null, PathEditor: () => null }));
vi.mock("./academyData.js", () => ({
  useImageUrl: (ref) => ({ url: ref?.path ? `blob:${ref.path}` : null, error: false }),
  useCategoryRecords: () => D.cats,
  useCategoryIndex: () => ({ ...D.idx, hidden: D.idx.hidden || [] }),
  useTopicRecords: () => { calls.topics += 1; return { docs: [], byId: {}, loaded: false, error: null }; },
  useCourses: (me, opts) => { calls.courses.push(opts); return { courses: D.courses.docs, loaded: D.courses.loaded, error: D.courses.error }; },
  useGuides: (me, opts) => { calls.guides.push(opts); return { guides: [], loaded: true, error: null }; },
  usePaths: (me, opts) => { calls.paths.push({ me: !!me, opts }); return me ? { paths: D.paths.docs, loaded: D.paths.loaded, error: D.paths.error } : { paths: [], loaded: false, error: null }; },
  useAllProgress: () => ({ ...D.progress, byCourse: Object.fromEntries((D.progress.docs || []).map((p) => [p.id, p])) }),
  useSharedDocs: () => ({ byPath: {}, loaded: D.lessonsLoaded !== false }),
  usePurposeVideo: () => ({ data: null, loaded: true }),
  useCategoryArt: () => ({ data: null, loaded: true }),
  useIntroState: () => ({ data: null, loaded: true }),
  setIntroWatched: vi.fn(), retryCategoryReads: vi.fn(),
}));

import Academy from "./Academy.jsx";

const member = { id: "u-member", name: "Member", role: "member", status: "approved" };
const admin = { id: "u-admin", name: "Admin", role: "admin", status: "approved" };
const R = { navigate: vi.fn() };
const cats = defaultCategoryRecords();
const course = (id, category, extra = {}) => ({ id, title: `Course ${id}`, category, status: "published", format: "course", modules: [{ id: "m", lessonIds: ["l1", "l2"] }], updatedAt: 1, publishedAt: 1, ...extra });
const show = (me = member) => render(<Academy me={me} users={[]} isAdmin={me.role === "admin"} nav={{}} R={R} />);
const catSection = () => document.getElementById("ac-cats-h").closest("section");
const counts = () => [...catSection().querySelectorAll(".ac-catcount")].map((e) => (e.classList.contains("pending") ? "pending" : e.textContent.trim()));

beforeEach(() => {
  Object.assign(D, { cats: ok(cats), idx: { loaded: true, hidden: [] }, courses: loading, progress: loading, paths: ok([]), lessonsLoaded: true });
  calls.topics = 0; calls.courses = []; calls.guides = []; calls.paths = [];
});

describe("categories come first", () => {
  test("categories render once the records and the hidden index are known, while courses, history and topics are still loading", () => {
    show();
    const sec = catSection();
    expect(within(sec).getByText("The Heart of Serving")).toBeInTheDocument();
    expect(sec.querySelector(".ac-catart.sb-skel")).toBeNull();          // no category skeleton
    expect(counts().every((c) => c === "pending")).toBe(true);           // counts reserved, never "0 courses" yet
    expect(calls.topics).toBe(0);                                       // the landing page doesn't read topics at all
    expect(screen.queryByText(/No courses are published yet/)).toBeNull(); // no empty message before the query confirms it
  });

  test("the category skeleton shows only while the records or the hidden index are unknown", () => {
    D.idx = { loaded: false, hidden: [] };
    show();
    expect(catSection().querySelector(".ac-catart.sb-skel")).not.toBeNull();
    expect(screen.queryByText("The Heart of Serving")).toBeNull();      // nothing shown before visibility is known
  });

  test("a hidden category is never shown, and appears once it is made visible again", () => {
    D.idx = { loaded: true, hidden: ["photography"] };
    const { rerender } = show();
    expect(screen.queryByText("Photography")).toBeNull();
    D.idx = { loaded: true, hidden: [] };
    rerender(<Academy me={member} users={[]} isAdmin={false} nav={{}} R={R} />);
    expect(within(catSection()).getByText("Photography")).toBeInTheDocument();
  });

  test("a FAILED category read shows an error with Try again — never the starter categories or 'no categories'", () => {
    D.cats = { docs: [], loaded: true, error: Object.assign(new Error("offline"), { code: "unavailable" }) };
    show();
    expect(screen.getByText(/Couldn't load the Academy's categories/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("The Heart of Serving")).toBeNull();
    expect(screen.queryByText(/No categories yet/)).toBeNull();
  });

  test("a category without artwork shows its branded fallback at once, in the reserved 3:4 shape", () => {
    show();
    const art = catSection().querySelector(".ac-catart");
    expect(art.dataset.img).toBe("none");
    expect(art.style.aspectRatio).toBe("3 / 4");
  });
});

describe("Continue learning needs positive evidence", () => {
  test("history still loading: no Continue placeholder (nothing implies a history exists)", () => {
    show();
    expect(document.querySelector(".ac-continue-skel")).toBeNull();
  });

  test("confirmed empty history: no Continue placeholder or section", () => {
    D.progress = ok([]);
    show();
    expect(document.querySelector(".ac-continue")).toBeNull();
  });

  test("a started, unfinished course: the placeholder holds the slot until the card can show", () => {
    D.progress = ok([{ id: "c1", startedAt: 1, lastLessonId: "l1" }]);
    show();
    expect(document.querySelector(".ac-continue-skel")).not.toBeNull();
  });

  test("only finished courses: no placeholder", () => {
    D.progress = ok([{ id: "c1", startedAt: 1, lastLessonId: "l2", finishedAt: 2 }]);
    show();
    expect(document.querySelector(".ac-continue-skel")).toBeNull();
  });

  test("a FAILED history read is not an empty history: it says so, and no suggestions are made from it", () => {
    D.progress = { docs: [], loaded: true, error: Object.assign(new Error("offline"), { code: "unavailable" }) };
    D.courses = ok([course("c1", "photography")]);
    show();
    expect(screen.getByText(/learning history couldn't load/i)).toBeInTheDocument();
    expect(document.getElementById("ac-foryou-h")).toBeNull();
    expect(document.querySelector(".ac-continue")).toBeNull();
    expect(within(catSection()).getByText("Photography")).toBeInTheDocument();   // categories unaffected
  });
});

describe("counts and the empty Academy", () => {
  test("member, nothing published: accurate zero counts once confirmed, an intentional note, no Continue / For you", () => {
    D.courses = ok([]); D.progress = ok([]);
    show();
    expect(counts().every((c) => c === "0 courses")).toBe(true);
    expect(screen.getByText("No courses are published yet. New courses will appear in these categories.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /create one in manage/i })).toBeNull();
    expect(document.querySelector(".ac-continue")).toBeNull();
    expect(document.getElementById("ac-foryou-h")).toBeNull();
  });

  test("editor, nothing published: the same learner view, plus a way to create the first course", () => {
    D.courses = ok([]); D.progress = ok([]);
    show(admin);
    expect(screen.getByRole("link", { name: /create one in manage/i })).toHaveAttribute("href", "/learn/manage");
    expect(screen.getByRole("button", { name: /manage/i })).toBeInTheDocument();
    // the landing page reads the learner lists (published + visible), never the full editor datasets
    expect(calls.courses.every((o) => o && o.learnerView === true)).toBe(true);
    expect(calls.guides.every((o) => o && o.learnerView === true)).toBe(true);
  });

  test("populated: counts per category, no empty note", () => {
    D.courses = ok([course("c1", "photography"), course("c2", "photography"), course("c3", "filmmaking")]); D.progress = ok([]);
    show();
    const sec = catSection();
    expect(within(sec).getByRole("link", { name: "Photography, 2 courses" })).toBeInTheDocument();
    expect(within(sec).getByRole("link", { name: "Filmmaking, 1 course" })).toBeInTheDocument();
    expect(screen.queryByText(/No courses are published yet/)).toBeNull();
  });

  test("a failed course list never shows zero counts", () => {
    D.courses = { docs: [], loaded: true, error: Object.assign(new Error("denied"), { code: "permission-denied" }) };
    show();
    expect(counts().every((c) => c === "pending")).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load the academy's courses/i);
    expect(screen.queryByText(/No courses are published yet/)).toBeNull();
  });

  test("the learning-paths count: shown only after the query succeeds — never while loading, never after a failure", () => {
    const link = () => screen.getByRole("link", { name: /^Learning paths/ }).textContent.trim();
    D.paths = loading;
    const { rerender, unmount } = show();
    expect(link()).toBe("Learning paths");
    D.paths = { docs: [], loaded: true, error: Object.assign(new Error("offline"), { code: "unavailable" }) };
    rerender(<Academy me={member} users={[]} isAdmin={false} nav={{}} R={R} />);
    expect(link()).toBe("Learning paths");
    D.paths = ok([]);
    rerender(<Academy me={member} users={[]} isAdmin={false} nav={{}} R={R} />);
    expect(link()).toBe("Learning paths · 0");
    unmount();
  });

  test("the learning-paths count starts only after the categories are known", () => {
    D.idx = { loaded: false, hidden: [] };
    show();
    expect(calls.paths.every((c) => c.me === false)).toBe(true);
  });
});
