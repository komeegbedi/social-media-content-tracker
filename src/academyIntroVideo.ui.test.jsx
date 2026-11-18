/* The Learn introduction ("Purpose video") editor: source vs custom 16:9
   thumbnail like lesson videos, link changes, late or failed metadata, and its
   protection when a newer release asks for a reload. Run: npm run test:ui */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn(), auth: {} }));
vi.mock("./logging", () => ({ logIssue: vi.fn(async () => true), reportIssue: vi.fn(async () => true) }));
const data = vi.hoisted(() => ({ save: null, fetch: null, deleted: [] }));
vi.mock("./academyData.js", () => new Proxy({
  savePurposeVideo: (...a) => data.save(...a),
  fetchVideoMetadata: (...a) => data.fetch(...a),
  deleteImage: async (p) => { data.deleted.push(p); },
  uploadImage: vi.fn(),
  useImageUrl: (ref) => ({ url: ref?.path ? `blob:${ref.path}` : null, error: false }),
}, { get: (t, k) => (k in t ? t[k] : (k === "then" ? undefined : vi.fn(() => ({ docs: [], loaded: true, data: null })))) }));

import { PurposeVideoEditor } from "./AcademyManage.jsx";
import { saveAndReload, hasUnsavedWork, __resetAppUpdate } from "./appUpdate.js";

const me = { id: "admin", role: "admin", status: "approved" };
const meta = (id, title = "Intro") => ({ available: true, title, author: "IFC", authorUrl: "https://www.youtube.com/@ifc", thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, sourceUrl: `https://www.youtube.com/watch?v=${id}` });
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const link = () => screen.getByLabelText("Video link");
const srcImgs = () => [...document.querySelectorAll("img")].map((i) => i.getAttribute("src")).filter((s) => /ytimg/.test(s || ""));
beforeEach(() => { __resetAppUpdate(); window.sessionStorage.clear(); data.save = vi.fn(async () => {}); data.fetch = vi.fn(async (p) => meta(p.id)); data.deleted = []; });

describe("intro video thumbnail", () => {
  test("a valid YouTube link: preview + the video's own thumbnail; 'Use video thumbnail' selected; saved with that link's metadata", async () => {
    const onClose = vi.fn();
    render(<PurposeVideoEditor me={me} current={null} onClose={onClose} />);
    fireEvent.change(link(), { target: { value: "https://youtu.be/LZxtveAHWsM" } });
    expect(await screen.findByText("Intro")).toBeInTheDocument();                       // the preview's title
    await waitFor(() => expect(srcImgs()).toContain("https://i.ytimg.com/vi/LZxtveAHWsM/hqdefault.jpg"));
    expect(screen.getByRole("radio", { name: /Use video thumbnail/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Upload custom thumbnail/ })).toBeDisabled();
    expect(screen.queryByText(/Duration/)).toBeNull();                                    // not relevant for the intro
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    const saved = data.save.mock.calls[0][1];
    expect(saved.video.id).toBe("LZxtveAHWsM");
    expect(saved.thumbMode).toBe("source");
    expect(saved.videoMeta.id).toBe("LZxtveAHWsM");
    expect(saved.videoMeta.thumbnailUrl).toBe("https://i.ytimg.com/vi/LZxtveAHWsM/hqdefault.jpg");
    expect(onClose).toHaveBeenCalled();
  });

  test("changing the URL never leaves the previous video's thumbnail; a LATE response for the old link is ignored", async () => {
    const first = deferred();
    data.fetch = vi.fn((p) => (p.id === "LZxtveAHWsM" ? first.p : Promise.resolve(meta(p.id, "Second"))));
    render(<PurposeVideoEditor me={me} current={null} onClose={vi.fn()} />);
    fireEvent.change(link(), { target: { value: "https://youtu.be/LZxtveAHWsM" } });
    fireEvent.change(link(), { target: { value: "https://youtu.be/dQw4w9WgXcQ" } });
    expect(await screen.findByText("Second")).toBeInTheDocument();
    await act(async () => { first.resolve(meta("LZxtveAHWsM", "First (late)")); await first.p; });
    expect(screen.queryByText("First (late)")).toBeNull();
    expect(srcImgs().every((s) => s.includes("dQw4w9WgXcQ"))).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    const saved = data.save.mock.calls[0][1];
    expect(saved.video.id).toBe("dQw4w9WgXcQ");
    expect(saved.videoMeta.id).toBe("dQw4w9WgXcQ");
  });

  test("metadata failure (even a stale release) never blocks saving a valid link; no raw module error is shown", async () => {
    data.fetch = vi.fn().mockRejectedValue(Object.assign(new Error("A newer version of the app is available. Save your changes, then reload to continue."), { code: "app/stale", cause: new Error("Failed to fetch dynamically imported module: https://x/assets/index.esm-Di5kQlnq.js") }));
    render(<PurposeVideoEditor me={me} current={null} onClose={vi.fn()} />);
    fireEvent.change(link(), { target: { value: "https://youtu.be/LZxtveAHWsM" } });
    expect(await screen.findByText(/A newer version of the app is available/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/index\.esm|MIME|dynamically imported/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    const saved = data.save.mock.calls[0][1];
    expect(saved.video.id).toBe("LZxtveAHWsM");
    expect(saved.videoMeta).toBeNull();
  });

  test("an existing custom thumbnail (older doc, no mode) stays selected; switching to the video thumbnail keeps the upload (as lessons do)", async () => {
    const custom = { path: "academy/purpose/v1.jpg", version: "v1", contentType: "image/jpeg", bytes: 9, w: 1280, h: 720 };
    const current = { title: "Why", intro: "We serve.", video: { provider: "youtube", id: "LZxtveAHWsM" }, thumb: custom };
    render(<PurposeVideoEditor me={me} current={current} onClose={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /Upload custom thumbnail/ })).toBeChecked();
    expect([...document.querySelectorAll("img")].some((i) => i.getAttribute("src") === "blob:academy/purpose/v1.jpg")).toBe(true);
    await screen.findByText("Intro");
    fireEvent.click(screen.getByRole("radio", { name: /Use video thumbnail/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    const saved = data.save.mock.calls[0][1];
    expect(saved.thumbMode).toBe("source");
    expect(saved.thumb).toEqual(custom);
    expect(saved.intro).toBe("We serve.");
    expect(data.deleted).toEqual([]);
  });
});

describe("intro dialog and a newer release", () => {
  test("unsaved fields: Cancel asks first; the reload saves the dialog before reloading", async () => {
    render(<PurposeVideoEditor me={me} current={null} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Short intro"), { target: { value: "Unsaved words" } });
    expect(hasUnsavedWork()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Leave without saving?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    const reload = vi.fn();
    let r; await act(async () => { r = await saveAndReload({ reload, doc: document }); });
    expect(r.ok).toBe(true);
    expect(data.save).toHaveBeenCalledTimes(1);
    expect(data.save.mock.calls[0][1].intro).toBe("Unsaved words");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("when the dialog can't be saved, nothing reloads and every field stays as typed", async () => {
    render(<PurposeVideoEditor me={me} current={null} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Short intro"), { target: { value: "Keep me" } });
    fireEvent.change(link(), { target: { value: "https://example.com/not-a-video" } });
    const reload = vi.fn();
    let r; await act(async () => { r = await saveAndReload({ reload, doc: document }); });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Couldn't save the introduction, so the page wasn't reloaded\. Your changes are still here\./);
    expect(reload).not.toHaveBeenCalled();
    expect(data.save).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Short intro")).toHaveValue("Keep me");
    expect(link()).toHaveValue("https://example.com/not-a-video");
  });

  test("a failed save (e.g. offline) keeps the dialog open with its content", async () => {
    data.save = vi.fn().mockRejectedValue(Object.assign(new Error("You're offline."), { code: "unavailable" }));
    const onClose = vi.fn();
    render(<PurposeVideoEditor me={me} current={null} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Short intro"), { target: { value: "Still here" } });
    const reload = vi.fn();
    let r; await act(async () => { r = await saveAndReload({ reload, doc: document }); });
    expect(r.ok).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Short intro")).toHaveValue("Still here");
  });
});
