/* IFC Creative Academy — video LINK parsing/normalisation (pure).
   Run: node --test src/academyVideo.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVideoLink, videoRecord, videoFromRecord, shouldPersistPosition, resumePosition, videoWatchedFromEvent,
} from "./academyVideo.js";

test("YouTube: watch, short, shorts, embed, live, nocookie and mobile links all normalise to one id", () => {
  const forms = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
    "https://youtu.be/dQw4w9WgXcQ?si=abc",
    "https://youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ?feature=share",
  ];
  for (const f of forms) {
    const r = parseVideoLink(f);
    assert.equal(r.ok, true, f);
    assert.equal(r.provider, "youtube");
    assert.equal(r.id, "dQw4w9WgXcQ");
    assert.equal(r.embedUrl, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1&rel=0&modestbranding=1&playsinline=1");
    assert.equal(r.capabilities.tracksEnded, true);
  }
});

test("Vimeo: page, unlisted hash and player links; hash survives into the embed", () => {
  const a = parseVideoLink("https://vimeo.com/123456789");
  assert.equal(a.ok, true); assert.equal(a.provider, "vimeo"); assert.equal(a.id, "123456789"); assert.equal(a.hash, null);
  const b = parseVideoLink("https://vimeo.com/123456789/ABCDEF12");
  assert.equal(b.hash, "abcdef12");
  assert.match(b.embedUrl, /^https:\/\/player\.vimeo\.com\/video\/123456789\?h=abcdef12&/);
  const c = parseVideoLink("https://player.vimeo.com/video/123456789?h=abcdef12&title=0");
  assert.equal(c.hash, "abcdef12");
  assert.equal(parseVideoLink("https://vimeo.com/channels/staffpicks/123456789").id, "123456789");
});

test("Google Drive: share links embed via /preview and report NO playback tracking", () => {
  const r = parseVideoLink("https://drive.google.com/file/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456/view?usp=sharing");
  assert.equal(r.ok, true); assert.equal(r.provider, "gdrive");
  assert.equal(r.embedUrl, "https://drive.google.com/file/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456/preview");
  assert.equal(r.capabilities.tracksProgress, false);
  assert.equal(r.capabilities.tracksEnded, false);
  assert.equal(parseVideoLink("https://drive.google.com/open?id=1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456").ok, true);
});

test("rejects: empty, non-https, HTML/script, unknown providers, and provider links without an id", () => {
  for (const bad of ["", "   ", "javascript:alert(1)", "ftp://x.com/v", "<iframe src=https://youtube.com/embed/x>",
                     "https://example.com/video.mp4", "https://www.youtube.com/", "https://youtu.be/", "https://vimeo.com/about",
                     "https://drive.google.com/drive/folders/abc", "https://www.youtube.com/watch?v=short"]) {
    const r = parseVideoLink(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(typeof r.reason, "string");
  }
});

test("the embed URL is BUILT from the id — query strings and fragments from the input never leak", () => {
  const r = parseVideoLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&onload=alert(1)#x");
  assert.ok(!r.embedUrl.includes("list="));
  assert.ok(!r.embedUrl.includes("alert"));
});

test("videoRecord stores only provider/id(/hash); videoFromRecord rebuilds, and rejects tampered records", () => {
  const rec = videoRecord(parseVideoLink("https://youtu.be/dQw4w9WgXcQ"));
  assert.deepEqual(rec, { provider: "youtube", id: "dQw4w9WgXcQ" });
  assert.equal(videoFromRecord(rec).embedUrl, parseVideoLink("https://youtu.be/dQw4w9WgXcQ").embedUrl);
  assert.equal(videoFromRecord({ provider: "youtube", id: "../../evil" }), null);
  assert.equal(videoFromRecord({ provider: "unknown", id: "dQw4w9WgXcQ" }), null);
  assert.equal(videoFromRecord({ provider: "vimeo", id: "12" }), null);
  assert.equal(videoFromRecord(null), null);
  assert.equal(videoRecord({ ok: false }), null);
});

test("position persistence is throttled, delta-gated and never saves inside the tail", () => {
  const base = { durationSec: 600, lastSavedSec: null, lastSavedAt: null, now: 100000 };
  assert.equal(shouldPersistPosition({ ...base, positionSec: 30 }), true);
  assert.equal(shouldPersistPosition({ ...base, positionSec: 30, lastSavedSec: 28, lastSavedAt: 1 }), false, "moved < 5s");
  assert.equal(shouldPersistPosition({ ...base, positionSec: 60, lastSavedSec: 30, lastSavedAt: 95000 }), false, "saved < 15s ago");
  assert.equal(shouldPersistPosition({ ...base, positionSec: 60, lastSavedSec: 30, lastSavedAt: 80000 }), true);
  assert.equal(shouldPersistPosition({ ...base, positionSec: 595 }), false, "tail");
  assert.equal(shouldPersistPosition({ ...base, positionSec: -1 }), false);
});

test("resume ignores tiny or tail positions; watched only from ENDED or the final seconds", () => {
  assert.equal(resumePosition(0, 600), 0);
  assert.equal(resumePosition(4, 600), 0);
  assert.equal(resumePosition(120.7, 600), 120);
  assert.equal(resumePosition(595, 600), 0);
  assert.equal(resumePosition(120, 0), 120, "unknown duration still resumes");
  assert.equal(videoWatchedFromEvent({ ended: true, positionSec: 0, durationSec: 0 }), true);
  assert.equal(videoWatchedFromEvent({ ended: false, positionSec: 598, durationSec: 600 }), true);
  assert.equal(videoWatchedFromEvent({ ended: false, positionSec: 300, durationSec: 600 }), false, "seeking to the middle is not watched");
  assert.equal(videoWatchedFromEvent({ ended: false, positionSec: 300, durationSec: 0 }), false, "no duration → only ENDED counts");
});

test("Vimeo events: only the player's own error event is a failure; autoplay refusals, rejected API calls, pauses and slow loading are not", async () => {
  const { vimeoEventKind, vimeoProvesPlayback } = await import("./academyVideo.js");
  assert.equal(vimeoEventKind({ event: "error", data: { name: "PrivacyError", message: "Because of its privacy settings, this video cannot be played here." } }), "failure");
  assert.equal(vimeoEventKind({ event: "error", data: { name: "NotFoundError", message: "x" } }), "failure");
  assert.equal(vimeoEventKind({ event: "error", data: {} }), "failure", "an unnamed player error still counts");
  assert.equal(vimeoEventKind({ event: "error", data: { name: "NotAllowedError", message: "play() failed because the user didn't interact" } }), "autoplay-blocked");
  assert.equal(vimeoEventKind({ event: "error", data: { name: "AbortError" } }), "autoplay-blocked");
  assert.equal(vimeoEventKind({ event: "error", data: { method: "setCurrentTime", name: "RangeError" } }), "method-error");
  assert.equal(vimeoEventKind({ event: "error", data: { method: "play", name: "NotAllowedError" } }), "method-error");
  assert.equal(vimeoEventKind({ event: "pause", data: { seconds: 12 } }), null, "a pause is not an event we act on");
  assert.equal(vimeoEventKind({ event: "ready" }), "ready");
  assert.equal(vimeoEventKind({ event: "timeupdate", data: { seconds: 0, duration: 62 } }), "time-zero");
  assert.equal(vimeoEventKind({ event: "timeupdate", data: { seconds: 3.2, duration: 62 } }), "time");
  for (const bad of [null, "ready", 5, {}, { event: "bogus" }]) assert.equal(vimeoEventKind(bad), null);
  assert.equal(vimeoEventKind({ event: "play", data: { seconds: 0 } }), "play-requested");
  assert.equal(vimeoEventKind({ event: "playing", data: { seconds: 0 } }), "playing");
  assert.equal(vimeoEventKind({ event: "drminitfailed" }), null, "not the documented error event; not treated as a confirmed failure");
  assert.ok(vimeoProvesPlayback("playing") && vimeoProvesPlayback("time") && vimeoProvesPlayback("ended"));
  assert.ok(!vimeoProvesPlayback("play-requested"), "a play REQUEST is not proof (observed: play then drminitfailed, no progress)");
  assert.ok(!vimeoProvesPlayback("ready") && !vimeoProvesPlayback("time-zero") && !vimeoProvesPlayback("autoplay-blocked"));
});
