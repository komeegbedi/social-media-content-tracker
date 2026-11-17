/* Offline truthfulness for course drafts: an edit made offline is never shown
   as saved, is kept, saves automatically on reconnect, and publishing's
   pre-flight (settle) refuses while it's unsaved. Run: npm run test:ui */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import React, { useImperativeHandle, forwardRef } from "react";

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn() }));
const saveCourseDraft = vi.fn();
vi.mock("./academyData.js", () => ({
  loadCourseWorkspace: vi.fn(async () => ({ draftExists: true, head: { rev: 1, publishedRev: 1 }, course: { title: "T", modules: [] }, lessons: {}, liveCourse: { status: "published" }, liveLessons: [] })),
  saveCourseDraft: (...a) => saveCourseDraft(...a),
  cleanupDraftImages: vi.fn(async () => []), fetchLinkMetadata: vi.fn(), useDraftHead: () => ({ data: null }),
  useImageUrl: () => ({ url: null, error: false }),
}));
import { useCourseDraft, SaveStatus } from "./academyWorkspaceParts.jsx";

let online = true;
Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
const goOffline = () => { online = false; window.dispatchEvent(new Event("offline")); };
const goOnline = () => { online = true; window.dispatchEvent(new Event("online")); };

const Harness = forwardRef(function Harness(_, ref) {
  const store = useCourseDraft("c1", { id: "u1" });
  useImperativeHandle(ref, () => store);
  if (store.status !== "ready") return <p>loading</p>;
  return <div><SaveStatus save={store.save} onRetry={store.flushNow} /><output data-testid="title">{store.model.course.title}</output></div>;
});

beforeEach(() => { online = true; saveCourseDraft.mockReset(); });

describe("course draft offline status", () => {
  test("offline: edits are kept and shown as NOT saved; they save automatically on reconnect", async () => {
    const ref = React.createRef();
    render(<React.StrictMode><Harness ref={ref} /></React.StrictMode>);
    await screen.findByTestId("title");
    saveCourseDraft.mockImplementation(async () => { if (!online) throw Object.assign(new Error("Failed to get document because the client is offline."), { code: "unavailable" }); return 2; });
    goOffline();
    act(() => { ref.current.updateCourse({ title: "Edited offline" }); });
    expect(await screen.findByText(/You're offline, so your latest edits aren't saved yet/, {}, { timeout: 3000 })).toHaveAttribute("role", "status");
    expect(screen.queryByText("Draft saved")).toBeNull();
    expect(screen.getByTestId("title")).toHaveTextContent("Edited offline");
    expect(saveCourseDraft.mock.calls.length).toBeLessThanOrEqual(2);       // no save loop while offline
    // publishing's pre-flight refuses while the edit is unsaved
    await expect(ref.current.settle({ force: true })).rejects.toThrow(/haven't saved yet/);
    await act(async () => { goOnline(); });
    await waitFor(() => expect(screen.getByText("Draft saved")).toBeInTheDocument(), { timeout: 3000 });
    expect(saveCourseDraft.mock.lastCall[2].course.title).toBe("Edited offline");
  });
  test("a real server refusal is a failure, not 'offline'", async () => {
    const ref = React.createRef();
    render(<Harness ref={ref} />);
    await screen.findByTestId("title");
    saveCourseDraft.mockRejectedValue(Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" }));
    act(() => { ref.current.updateCourse({ title: "Nope" }); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Couldn.t save the draft: the server refused the change\. You may no longer have editing access/), { timeout: 3000 });
    expect(screen.queryByText(/Offline/)).toBeNull();
  });
});
