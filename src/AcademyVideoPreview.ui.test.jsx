/* Editor video-link preview + thumbnail display (RTL + jsdom). The provider
   metadata call is injected, so these tests drive loading / success / failure /
   retry / stale-request / URL-change behaviour deterministically.
   Run: npm run test:ui */
import { describe, test, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React, { useState } from "react";

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn() }));
vi.mock("./youtubeApi.js", () => ({ loadYouTubeApi: () => Promise.resolve(globalThis.__fakeYT || null) }));
vi.mock("./academyData.js", () => ({
  fetchVideoMetadata: vi.fn(),
  useImageUrl: (ref) => ({ url: ref?.path ? `blob:${ref.path}` : null, error: false }),
}));

import { VideoPreview } from "./academyVideoPreview.jsx";
import { VideoThumb, sourceThumbUrl } from "./academyShared.jsx";
import { parseVideoLink } from "./academyVideo.js";

const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
function Harness({ url: initial, fetcher, probe = false }) {
  const [url, setUrl] = useState(initial);
  const [meta, setMeta] = useState(null);
  const parsed = url ? parseVideoLink(url) : null;
  return (
    <div>
      <label htmlFor="u">Video link</label><input id="u" value={url} onChange={(e) => setUrl(e.target.value)} />
      <VideoPreview parsed={parsed} meta={meta} onMeta={setMeta} fetcher={fetcher} probe={probe} />
      <output data-testid="meta">{meta ? `${meta.id}|${meta.title}` : "none"}</output>
      <output data-testid="dur">{meta ? `${meta.durationSec ?? "none"}|${meta.isLive ? "live" : "vod"}` : "none"}</output>
    </div>
  );
}
const ytMeta = (title) => ({ available: true, title, author: "Creator", authorUrl: "https://www.youtube.com/@c", thumbnailUrl: "https://i.ytimg.com/vi/x/hqdefault.jpg", sourceUrl: "https://www.youtube.com/watch?v=x" });

describe("VideoPreview", () => {
  test("loading → title, creator, provider thumbnail and an 'open original' link (watch, youtu.be and Shorts links normalise)", async () => {
    for (const link of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "https://youtube.com/shorts/dQw4w9WgXcQ"]) {
      const d = deferred();
      const fetcher = vi.fn(() => d.p);
      const { unmount } = render(<Harness url={link} fetcher={fetcher} />);
      expect(screen.getByText("Loading preview…")).toBeInTheDocument();
      expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({ provider: "youtube", id: "dQw4w9WgXcQ" }));
      await act(async () => { d.resolve(ytMeta("A real title")); });
      expect(screen.getByText("A real title")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Creator" })).toHaveAttribute("href", "https://www.youtube.com/@c");
      expect(screen.getByRole("img", { name: "Thumbnail: A real title" })).toHaveAttribute("src", "https://i.ytimg.com/vi/x/hqdefault.jpg");
      expect(screen.getByRole("link", { name: /Open on YouTube/ })).toHaveAttribute("href", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(screen.getByTestId("meta")).toHaveTextContent("dQw4w9WgXcQ|A real title");
      unmount();
    }
  });

  test("a slower response for an OLD link never overwrites the newer link's preview; changing the link clears stale metadata", async () => {
    const first = deferred(), second = deferred();
    const fetcher = vi.fn().mockReturnValueOnce(first.p).mockReturnValueOnce(second.p);
    render(<Harness url="https://youtu.be/AAAAAAAAAAA" fetcher={fetcher} />);
    fireEvent.change(screen.getByLabelText("Video link"), { target: { value: "https://youtu.be/BBBBBBBBBBB" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve(ytMeta("Newer video")); });
    await act(async () => { first.resolve(ytMeta("OLD video")); });
    expect(screen.getByText("Newer video")).toBeInTheDocument();
    expect(screen.queryByText("OLD video")).toBeNull();
    expect(screen.getByTestId("meta")).toHaveTextContent("BBBBBBBBBBB|Newer video");
    // an invalid link clears the preview and the stored metadata
    fireEvent.change(screen.getByLabelText("Video link"), { target: { value: "not a link" } });
    expect(screen.queryByText("Newer video")).toBeNull();
    expect(screen.getByTestId("meta")).toHaveTextContent("none");
  });

  test("failure is honest and retryable; the link is still saveable; a later success replaces the error", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ available: false, reason: "Couldn't reach the video provider. Try again.", retryable: true })
      .mockResolvedValueOnce(ytMeta("Back online"));
    render(<Harness url="https://youtu.be/dQw4w9WgXcQ" fetcher={fetcher} />);
    expect(await screen.findByText(/Couldn't reach the video provider/)).toBeInTheDocument();
    expect(screen.getByText(/can still be saved/)).toBeInTheDocument();
    expect(screen.getByTestId("meta")).toHaveTextContent("none");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
    expect(screen.getByText("Back online")).toBeInTheDocument();
  });

  test("a thrown error (e.g. network) is handled the same way; private videos aren't retryable", async () => {
    render(<Harness url="https://youtu.be/dQw4w9WgXcQ" fetcher={vi.fn().mockRejectedValue(new Error("offline"))} />);
    expect(await screen.findByText(/offline/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  test("Google Drive: no metadata request; an explicit 'no preview' note", () => {
    const fetcher = vi.fn();
    render(<Harness url="https://drive.google.com/file/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456/view" fetcher={fetcher} />);
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByText(/Google Drive doesn't publish a title, thumbnail or duration/)).toBeInTheDocument();
    expect(screen.getByText("Duration unknown")).toBeInTheDocument();
  });

  test("a valid preview whose thumbnail fails to load says so (parsing ≠ metadata ≠ thumbnail ≠ playability)", async () => {
    render(<Harness url="https://youtu.be/dQw4w9WgXcQ" fetcher={vi.fn().mockResolvedValue(ytMeta("T"))} />);
    const img = await screen.findByRole("img", { name: "Thumbnail: T" });
    fireEvent.error(img);
    expect(screen.getByText(/thumbnail didn't load/)).toBeInTheDocument();
    expect(screen.getByText(/can't play inside other sites/)).toBeInTheDocument();
  });
});

/* A stand-in for the official YouTube IFrame Player API: getDuration() is 0
   until playback starts (as documented), then returns `seq` values in turn. */
function fakeYT(seq) {
  return { PlayerState: { PLAYING: 1 }, Player: class {
    constructor(el, opts) { this.i = 0; setTimeout(() => { opts.events.onReady(); setTimeout(() => opts.events.onStateChange({ data: 1 }), 5); }, 0); }
    getDuration() { return this.i === 0 ? (this.i++, 0) : seq[Math.min(this.i++ - 1, seq.length - 1)]; }
    mute() {} playVideo() {} pauseVideo() {} seekTo() {} unMute() {} destroy() {}
  } };
}

describe("VideoPreview — automatic duration", () => {
  test("Vimeo: the duration comes from the provider's oEmbed response and is stored", async () => {
    render(<Harness url="https://vimeo.com/76979871" fetcher={vi.fn().mockResolvedValue({ ...ytMeta("Vimeo talk"), durationSec: 754 })} />);
    expect(await screen.findByText("Duration 12:34")).toBeInTheDocument();
    expect(screen.getByTestId("dur")).toHaveTextContent("754|vod");
  });
  test("Vimeo without a duration stays UNKNOWN (never 0) and doesn't block anything", async () => {
    render(<Harness url="https://vimeo.com/76979871" fetcher={vi.fn().mockResolvedValue(ytMeta("No length"))} />);
    expect(await screen.findByText("Duration unknown")).toBeInTheDocument();
    expect(screen.getByTestId("dur")).toHaveTextContent("none|vod");
  });
  test("YouTube: measured with the IFrame API once playback starts", async () => {
    globalThis.__fakeYT = fakeYT([212.4, 212.4]);
    try {
      render(<Harness url="https://youtu.be/dQw4w9WgXcQ" fetcher={vi.fn().mockResolvedValue(ytMeta("Song"))} probe />);
      expect(screen.getByText(/Measuring duration/)).toBeInTheDocument();
      expect(await screen.findByText("Duration 3:32", {}, { timeout: 5000 })).toBeInTheDocument();
      expect(screen.getByTestId("dur")).toHaveTextContent("212|vod");
    } finally { delete globalThis.__fakeYT; }
  }, 10000);
  test("YouTube live stream: a growing duration is detected as live and no length is stored", async () => {
    globalThis.__fakeYT = fakeYT([100, 104]);
    try {
      render(<Harness url="https://youtu.be/dQw4w9WgXcQ" fetcher={vi.fn().mockResolvedValue(ytMeta("Live service"))} probe />);
      expect(await screen.findByText(/Live stream, so there's no fixed length/, {}, { timeout: 5000 })).toBeInTheDocument();
      expect(screen.getByTestId("dur")).toHaveTextContent("none|live");
    } finally { delete globalThis.__fakeYT; }
  }, 10000);
  test("the player API failing to load leaves the duration unknown with a way to try again", async () => {
    render(<Harness url="https://youtu.be/dQw4w9WgXcQ" fetcher={vi.fn().mockResolvedValue(ytMeta("X"))} probe />);
    expect(await screen.findByText(/The YouTube player couldn't load/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Measure again" })).toBeInTheDocument();
  });
});

describe("VideoThumb (16:9, source vs custom)", () => {
  const meta = { thumbnailUrl: "https://i.ytimg.com/vi/x/hqdefault.jpg" };
  test("source mode shows the provider's artwork letterboxed; custom mode shows the app-owned upload; legacy uploads without a mode stay selected", () => {
    const { container, rerender } = render(<VideoThumb item={{ video: { provider: "youtube", id: "x" }, videoMeta: meta, thumbMode: "source", thumb: { path: "academy/lessonThumbs/c/l/v.jpg" } }} />);
    expect(container.querySelector(".ac-srcthumb img")).toHaveAttribute("src", meta.thumbnailUrl);
    rerender(<VideoThumb item={{ video: { provider: "youtube", id: "x" }, videoMeta: meta, thumbMode: "custom", thumb: { path: "academy/lessonThumbs/c/l/v.jpg" } }} />);
    expect(container.querySelector("img")).toHaveAttribute("src", "blob:academy/lessonThumbs/c/l/v.jpg");
    rerender(<VideoThumb item={{ video: { provider: "youtube", id: "x" }, videoMeta: meta, thumb: { path: "academy/lessonThumbs/c/l/old.jpg" } }} />);
    expect(container.querySelector("img")).toHaveAttribute("src", "blob:academy/lessonThumbs/c/l/old.jpg");
  });
  test("a broken or missing source thumbnail falls back to a 16:9 placeholder; no guessed provider URLs", () => {
    const { container, rerender } = render(<VideoThumb item={{ video: { provider: "youtube", id: "x" }, videoMeta: meta, thumbMode: "source" }} />);
    fireEvent.error(container.querySelector(".ac-srcthumb img"));
    expect(container.querySelector(".ac-img-empty")).toHaveStyle({ aspectRatio: "16 / 9" });
    rerender(<VideoThumb item={{ video: { provider: "youtube", id: "y" }, videoMeta: null, thumbMode: "source" }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(sourceThumbUrl({ provider: "youtube", id: "y" }, null), "").toBe("");
    expect(sourceThumbUrl(null, { thumbnailUrl: "http://insecure/x.jpg" })).toBe("");
  });
});
