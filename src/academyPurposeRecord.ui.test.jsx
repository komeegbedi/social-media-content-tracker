/* What the Learn introduction stores (academyData.purposeRecord). Run: npm run test:ui */
import { test, expect, vi } from "vitest";
vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn(), reportIssue: vi.fn() }));
import { purposeRecord } from "./academyData.js";

const me = { id: "admin" };
const yt = (id) => ({ ok: true, provider: "youtube", id, url: `https://youtu.be/${id}` });
const custom = { path: "academy/purpose/v1.jpg", version: "v1", contentType: "image/jpeg", bytes: 9, w: 1280, h: 720 };
const meta = (id) => ({ id, title: "T", author: "A", authorUrl: "https://a", thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, sourceUrl: "https://s", fetchedAt: 1, junk: "x" });

test("metadata is stored only for THIS link (a previous video's thumbnail is dropped), cleaned to the allowed fields", () => {
  const r = purposeRecord(me, { title: "Why", intro: "x", video: yt("LZxtveAHWsM"), videoMeta: meta("LZxtveAHWsM"), thumb: null });
  expect(r.videoMeta.thumbnailUrl).toBe("https://i.ytimg.com/vi/LZxtveAHWsM/hqdefault.jpg");
  expect(r.videoMeta.junk).toBeUndefined();
  expect(Object.keys(r).sort()).toEqual(["intro", "thumb", "thumbMode", "title", "updatedAt", "updatedBy", "video", "videoMeta"]);
  expect(purposeRecord(me, { video: yt("dQw4w9WgXcQ"), videoMeta: meta("LZxtveAHWsM") }).videoMeta).toBeNull();
  expect(purposeRecord(me, { video: null, videoMeta: meta("LZxtveAHWsM") }).videoMeta).toBeNull();
});

test("thumbnail mode: custom only with an uploaded image; 'source' keeps the upload; no mode on an old doc = custom", () => {
  expect(purposeRecord(me, { video: yt("a1b2c3d4e5f"), thumb: custom }).thumbMode).toBe("custom");
  expect(purposeRecord(me, { video: yt("a1b2c3d4e5f"), thumb: custom, thumbMode: "source" })).toMatchObject({ thumbMode: "source", thumb: custom });
  expect(purposeRecord(me, { video: yt("a1b2c3d4e5f"), thumb: null, thumbMode: "custom" }).thumbMode).toBe("source");
});
