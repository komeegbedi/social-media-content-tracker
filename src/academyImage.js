/* IFC Creative Academy — cover/thumbnail image constraints + crop geometry.

   The pure parts (validation, crop maths, Storage paths) are DOM-free so they
   unit-test under node; `processImage` is the only browser-side function
   (canvas) and is guarded accordingly.

   Policy (mirrored in storage.rules):
     • input: JPEG / PNG / WebP, ≤ 5 MB
     • course cover: portrait 3:4, output 900×1200 (the catalogue renders it
       at ~180–300px wide, so 900 keeps 2–3× density on retina)
     • lesson thumbnail: 16:9, output 1280×720
     • output is re-encoded (JPEG by default, WebP when the browser can) and
       stepped down in quality until it's ≤ ~250 KB — the stored object is
       ALWAYS a freshly-encoded raster, never the uploaded bytes
     • Storage object paths are versioned, so a replacement never overwrites
       the object a learner may still be loading. */

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const IMAGE_MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const IMAGE_TARGET_BYTES = 250 * 1024;
export const IMAGE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;   // storage.rules ceiling

export const IMAGE_KINDS = {
  cover: { label: "Course cover", ratio: 3 / 4, width: 900, height: 1200 },
  thumb: { label: "Lesson thumbnail", ratio: 16 / 9, width: 1280, height: 720 },
  purpose: { label: "Purpose video thumbnail", ratio: 16 / 9, width: 1280, height: 720 },
  guideThumb: { label: "Guide thumbnail", ratio: 16 / 9, width: 1280, height: 720 },
  pathCover: { label: "Path cover", ratio: 3 / 4, width: 900, height: 1200 },
  categoryArt: { label: "Category artwork (legacy landscape)", ratio: 16 / 9, width: 1600, height: 900 },
  catCover: { label: "Category cover", ratio: 3 / 4, width: 900, height: 1200 },
};

/* Validate a File-like { type, size, name } before any work happens. */
export function validateImageFile(file) {
  if (!file) return { ok: false, reason: "Choose an image." };
  const type = String(file.type || "").toLowerCase();
  if (!IMAGE_TYPES.includes(type)) return { ok: false, reason: "Use a JPEG, PNG or WebP image." };
  if (!(file.size > 0)) return { ok: false, reason: "That file is empty." };
  if (file.size > IMAGE_MAX_INPUT_BYTES) return { ok: false, reason: "Images must be 5 MB or smaller." };
  return { ok: true };
}

/* The largest centred crop of `ratio` that fits an image of (w × h). */
export function defaultCrop(w, h, ratio) {
  if (!(w > 0 && h > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  let cw = w, ch = Math.round(w / ratio);
  if (ch > h) { ch = h; cw = Math.round(h * ratio); }
  return { x: Math.round((w - cw) / 2), y: Math.round((h - ch) / 2), w: cw, h: ch };
}

/* Keep a crop rectangle inside the image and at the required ratio. `scale`
   (0.2–1) is the crop width as a fraction of the maximum crop; `cx, cy` are the
   crop CENTRE as fractions (0–1) of the image size. This is what the UI's
   sliders drive, so any slider state yields a valid crop. */
export function cropFromControls(w, h, ratio, { scale = 1, cx = 0.5, cy = 0.5 } = {}) {
  const max = defaultCrop(w, h, ratio);
  const s = Math.min(1, Math.max(0.2, Number(scale) || 1));
  const cw = Math.max(1, Math.round(max.w * s));
  const ch = Math.max(1, Math.round(cw / ratio));
  const x = Math.round(Math.min(Math.max(0, cx * w - cw / 2), w - cw));
  const y = Math.round(Math.min(Math.max(0, cy * h - ch / 2), h - ch));
  return { x, y, w: cw, h: Math.min(ch, h) };
}

/* Versioned object path. The version is a timestamp + random suffix so two
   editors can't collide and a replacement never reuses a path. */
export function imagePath(kind, { courseId, lessonId, guideId, pathId, categoryId } = {}, version = versionTag()) {
  if (kind === "categoryArt") return `academy/categoryArt/${categoryId}/${version}.jpg`;
  if (kind === "catCover") return `academy/catCovers/${categoryId}/${version}.jpg`;
  if (kind === "cover") return `academy/covers/${courseId}/${version}.jpg`;
  if (kind === "thumb") return `academy/lessonThumbs/${courseId}/${lessonId}/${version}.jpg`;
  if (kind === "purpose") return `academy/purpose/${version}.jpg`;
  if (kind === "guideThumb") return `academy/guideThumbs/${guideId}/${version}.jpg`;
  if (kind === "pathCover") return `academy/pathCovers/${pathId}/${version}.jpg`;
  throw new Error("unknown image kind");
}
export const versionTag = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* Quality ladder used to step a JPEG/WebP down to the target size. */
export const QUALITY_STEPS = [0.86, 0.8, 0.74, 0.68, 0.62, 0.56, 0.5];

/* ---- browser only ----------------------------------------------------------
   processImage(file, kind, crop) -> Promise<{ blob, width, height, contentType }>
   Decodes with createImageBitmap, draws the crop onto a canvas of the kind's
   output size, encodes JPEG stepping quality down until ≤ IMAGE_TARGET_BYTES. */
export async function processImage(file, kind, crop) {
  if (typeof document === "undefined") throw new Error("processImage needs a browser");
  const spec = IMAGE_KINDS[kind];
  if (!spec) throw new Error("unknown image kind");
  const bmp = await createImageBitmap(file);
  try {
    const c = crop || defaultCrop(bmp.width, bmp.height, spec.ratio);
    const canvas = document.createElement("canvas");
    canvas.width = spec.width; canvas.height = spec.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, spec.width, spec.height);   // flatten PNG alpha
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, c.x, c.y, c.w, c.h, 0, 0, spec.width, spec.height);
    let blob = null;
    for (const q of QUALITY_STEPS) {
      blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
      if (!blob) throw new Error("Couldn't encode the image.");
      if (blob.size <= IMAGE_TARGET_BYTES) break;
    }
    if (blob.size > IMAGE_MAX_OUTPUT_BYTES) throw new Error("The image is still too large after compression. Try a simpler image.");
    return { blob, width: spec.width, height: spec.height, contentType: "image/jpeg" };
  } finally {
    if (typeof bmp.close === "function") bmp.close();
  }
}

/* Read natural size of a File (browser only). */
export async function imageDimensions(file) {
  const bmp = await createImageBitmap(file);
  const out = { width: bmp.width, height: bmp.height };
  if (typeof bmp.close === "function") bmp.close();
  return out;
}
