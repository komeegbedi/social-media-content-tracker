/* Video metadata callable — pure parts. Run: node --test functions/videoMetadata.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { oembedRequest, normalizeOembed } = require("./videoMetadata");

test("oEmbed requests are built from the validated provider + id only (official endpoints, no user URL)", () => {
  const yt = oembedRequest({ provider: "youtube", id: "dQw4w9WgXcQ" });
  assert.equal(yt.url, "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json");
  assert.equal(yt.fallbackThumb, null, "no undocumented thumbnail URL patterns — only oEmbed's thumbnail_url");
  const v = oembedRequest({ provider: "vimeo", id: "76979871", hash: "ABCDEF12" });
  assert.equal(v.url, "https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F76979871%2Fabcdef12");
  assert.equal(oembedRequest({ provider: "gdrive", id: "1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456" }), null);
  assert.equal(oembedRequest({ provider: "youtube", id: "../evil" }), null);
  assert.equal(oembedRequest({ provider: "youtube", id: "https://evil.example/x" }), null);
});

test("normalizeOembed keeps only safe, bounded fields; non-https thumbnails are dropped; fallback thumb used", () => {
  const m = normalizeOembed("youtube", "dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    { title: "T", author_name: "A", author_url: "javascript:alert(1)", thumbnail_url: "http://insecure/x.jpg", html: "<iframe>" }, null);
  assert.deepEqual(m, { provider: "youtube", id: "dQw4w9WgXcQ", sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", available: true, title: "T", author: "A", authorUrl: "", thumbnailUrl: "", durationSec: null });
  const ok = normalizeOembed("youtube", "dQw4w9WgXcQ", "s", { thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }, null);
  assert.equal(ok.thumbnailUrl, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "the provider's own https thumbnail_url is kept");
  assert.equal(normalizeOembed("vimeo", "1", "https://vimeo.com/1", null, null).thumbnailUrl, "");
  assert.equal(normalizeOembed("vimeo", "1", "https://vimeo.com/1", { title: "x".repeat(500) }, null).title.length, 200);
});

test("duration: taken from a provider-supplied positive number only (Vimeo); never invented", () => {
  assert.equal(normalizeOembed("vimeo", "1", "s", { duration: 62 }, null).durationSec, 62);
  assert.equal(normalizeOembed("vimeo", "1", "s", { duration: 0 }, null).durationSec, null);
  assert.equal(normalizeOembed("vimeo", "1", "s", { duration: "abc" }, null).durationSec, null);
  assert.equal(normalizeOembed("youtube", "x", "s", { title: "no duration in YouTube oEmbed" }, null).durationSec, null);
});
