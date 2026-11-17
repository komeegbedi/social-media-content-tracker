/* IFC Creative Academy — image constraints + crop geometry (pure).
   Run: node --test src/academyImage.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateImageFile, defaultCrop, cropFromControls, imagePath, IMAGE_KINDS, IMAGE_MAX_INPUT_BYTES } from "./academyImage.js";

test("validateImageFile: JPEG/PNG/WebP ≤ 5 MB only", () => {
  assert.equal(validateImageFile({ type: "image/jpeg", size: 1000 }).ok, true);
  assert.equal(validateImageFile({ type: "image/png", size: IMAGE_MAX_INPUT_BYTES }).ok, true);
  assert.equal(validateImageFile({ type: "image/webp", size: IMAGE_MAX_INPUT_BYTES + 1 }).ok, false);
  assert.equal(validateImageFile({ type: "image/gif", size: 10 }).ok, false);
  assert.equal(validateImageFile({ type: "image/svg+xml", size: 10 }).ok, false);
  assert.equal(validateImageFile({ type: "image/jpeg", size: 0 }).ok, false);
  assert.equal(validateImageFile(null).ok, false);
});

test("defaultCrop is the largest centred rectangle at the ratio", () => {
  const r = IMAGE_KINDS.cover.ratio;   // 3:4
  assert.deepEqual(defaultCrop(3000, 4000, r), { x: 0, y: 0, w: 3000, h: 4000 });
  assert.deepEqual(defaultCrop(4000, 3000, r), { x: 875, y: 0, w: 2250, h: 3000 });   // landscape → crop sides
  assert.deepEqual(defaultCrop(1000, 3000, r), { x: 0, y: 834, w: 1000, h: 1333 });   // tall → crop top/bottom
  assert.deepEqual(defaultCrop(0, 0, r), { x: 0, y: 0, w: 0, h: 0 });
});

test("cropFromControls stays inside the image at any slider value and keeps the ratio", () => {
  const r = IMAGE_KINDS.cover.ratio;
  for (const scale of [0, 0.2, 0.5, 1, 7]) for (const cx of [0, 0.5, 1]) for (const cy of [0, 0.5, 1]) {
    const c = cropFromControls(4000, 3000, r, { scale, cx, cy });
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= 4000 && c.y + c.h <= 3000, JSON.stringify({ scale, cx, cy, c }));
    assert.ok(Math.abs(c.w / c.h - r) < 0.01, "ratio");
  }
  assert.deepEqual(cropFromControls(4000, 3000, r, { scale: 1, cx: 0.5, cy: 0.5 }), defaultCrop(4000, 3000, r));
  const zoomed = cropFromControls(4000, 3000, r, { scale: 0.5, cx: 0, cy: 0 });
  assert.equal(zoomed.x, 0); assert.equal(zoomed.y, 0); assert.equal(zoomed.w, 1125);
});

test("object paths are versioned and namespaced under academy/", () => {
  const a = imagePath("cover", { courseId: "c1" }), b = imagePath("cover", { courseId: "c1" });
  assert.match(a, /^academy\/covers\/c1\/[a-z0-9]+-[a-z0-9]+\.jpg$/);
  assert.notEqual(a, b, "two uploads never collide");
  assert.match(imagePath("thumb", { courseId: "c1", lessonId: "l9" }), /^academy\/lessonThumbs\/c1\/l9\//);
  assert.match(imagePath("purpose"), /^academy\/purpose\//);
  assert.throws(() => imagePath("nope"));
});
