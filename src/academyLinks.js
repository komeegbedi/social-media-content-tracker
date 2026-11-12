/* IFC Creative Academy — resource links (pure helpers). A link needs only its
   URL; these give it a readable name and type when the server can't fetch
   metadata (offline, private, or sign-in-only documents). */
import { isSafeHref } from "./academyMarkdown.js";

const EXT_TYPES = { pdf: "PDF", doc: "Word", docx: "Word", ppt: "PowerPoint", pptx: "PowerPoint", key: "Keynote", xls: "Excel", xlsx: "Excel", csv: "CSV", txt: "Text", zip: "ZIP", png: "Image", jpg: "Image", jpeg: "Image", gif: "Image", webp: "Image", svg: "Image", mp3: "Audio", wav: "Audio", mp4: "Video", mov: "Video", psd: "Photoshop", ai: "Illustrator", fig: "Figma", cube: "LUT", lut: "LUT" };
const HOST_NAMES = { "docs.google.com": "Google Docs", "drive.google.com": "Google Drive", "dropbox.com": "Dropbox", "figma.com": "Figma", "canva.com": "Canva", "notion.so": "Notion", "youtube.com": "YouTube", "vimeo.com": "Vimeo", "github.com": "GitHub" };

export const normalizeLinkInput = (raw) => {
  let s = String(raw || "").trim();
  if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) s = "https://" + s;   // "example.com/x" → https://
  return s;
};
export const isValidResourceUrl = (raw) => isSafeHref(normalizeLinkInput(raw));
export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
export const sourceLabel = (url) => { const h = hostOf(url); return HOST_NAMES[h] || h; };
export function fileTypeFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "docs.google.com") { const m = u.pathname.match(/^\/(document|spreadsheets|presentation|forms)\//); if (m) return { document: "Doc", spreadsheets: "Sheet", presentation: "Slides", forms: "Form" }[m[1]]; }
    const ext = u.pathname.split("/").pop().split(".").pop().toLowerCase();
    return u.pathname.includes(".") ? (EXT_TYPES[ext] || "") : "";
  } catch { return ""; }
}
/* A readable fallback name: the file name ("Film LUT pack.zip") or, failing
   that, the site ("Google Docs" / "studio.example.org"). */
export function fallbackLabel(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last.replace(/[-_]+/g, " ").slice(0, 120);
    return sourceLabel(url) || url.slice(0, 120);
  } catch { return String(url || "").slice(0, 120); }
}
/* Merge fetched metadata into a link WITHOUT touching an author's custom name. */
export function applyLinkMeta(link, meta) {
  const next = { ...link };
  if (meta?.available && meta.title && !link.custom) next.label = meta.title.slice(0, 120);
  if (!next.label) next.label = fallbackLabel(link.url);
  next.source = meta?.siteName || sourceLabel(link.url);
  next.fileType = meta?.fileType || fileTypeFromUrl(link.url) || link.fileType || "";
  next.restricted = !!meta?.restricted;
  return next;
}
export const newLink = (url) => ({ url, label: fallbackLabel(url), source: sourceLabel(url), fileType: fileTypeFromUrl(url) });
