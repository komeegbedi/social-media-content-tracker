/* IFC Creative Academy — tiny shared image components used by BOTH the learner
   screens (Academy.jsx) and the editors (AcademyManage.jsx). Kept separate so
   the two chunks don't import each other. */
import React, { useMemo, useState } from "react";
import { parseMarkdown, parseInlines } from "./academyMarkdown.js";
import { AcademicCapIcon, CameraIcon, FilmIcon, PaintBrushIcon, MegaphoneIcon, UserGroupIcon, HeartIcon, PlayIcon } from "@heroicons/react/24/outline";
import { useImageUrl } from "./academyData.js";

/* An uploaded image read through Storage (auth-checked). `ratio` keeps the box
   stable while loading; a missing/denied image shows a quiet placeholder.
   `fit="contain"` letterboxes (used for legacy landscape uploads in a portrait
   slot — they are shown as-is until an editor re-crops). */
export function StoredImage({ imageRef, alt = "", className = "", ratio, placeholder, fit = "cover" }) {
  const { url, error } = useImageUrl(imageRef);
  const style = ratio ? { aspectRatio: ratio } : undefined;
  if (!imageRef?.path || error) {
    return <div className={"ac-img ac-img-empty " + className} style={style} role={alt ? "img" : undefined} aria-label={alt || undefined}>{placeholder || <AcademicCapIcon className="hi" aria-hidden="true" />}</div>;
  }
  if (!url) return <div className={"ac-img ac-img-loading sb-skel " + className} style={style} aria-hidden="true" />;
  return <img className={"ac-img " + className + (fit === "contain" ? " ac-img-contain" : "")} style={style} src={url} alt={alt} loading="lazy" decoding="async" />;
}

/* Is a stored image ref landscape (older category artwork)? */
export const isLandscapeRef = (ref) => !!ref && Number(ref.w) > 0 && Number(ref.h) > 0 && ref.w > ref.h;

/* Category cover (portrait 3:4) with an intentional fallback: a per-category
   tinted panel with an icon — never an empty rectangle. A legacy landscape
   upload is letterboxed inside the portrait slot rather than cropped. */
const CATEGORY_ICON = { "heart-of-serving": HeartIcon, photography: CameraIcon, filmmaking: FilmIcon, "graphic-design": PaintBrushIcon, "social-media-storytelling": MegaphoneIcon, "creating-together": UserGroupIcon };
const TONES = ["t1", "t2", "t3", "t4", "t5", "t6"];
const toneFor = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return TONES[h % TONES.length]; };
export function CategoryArt({ category, imageRef, className = "", ratio = "3 / 4" }) {
  const { url, error } = useImageUrl(imageRef);
  const Icon = CATEGORY_ICON[category.id] || null;
  const style = { aspectRatio: ratio };
  if (imageRef?.path && !error && url) return <img className={"ac-catart " + className + (isLandscapeRef(imageRef) ? " ac-img-contain" : "")} style={style} src={url} alt="" loading="lazy" decoding="async" />;
  if (imageRef?.path && !error) return <div className={"ac-catart ac-catart-fb sb-skel " + className} style={style} aria-hidden="true" />;
  // One centred mark sized relative to the poster (container units), so it reads
  // as intentional at any size — a large learner poster or a small admin thumbnail.
  const initial = String(category.label || category.name || "?").trim().slice(0, 1).toUpperCase();
  return (
    <div className={`ac-catart ac-catart-fb cat-${category.id} ${toneFor(category.id)} ${className}`} style={style} aria-hidden="true">
      <span className="ac-catart-mark">{Icon ? <Icon className="hi" /> : <span className="ac-catart-initial">{initial}</span>}</span>
    </div>
  );
}

/* Source thumbnail URL (provider-hosted; never copied into our storage, never
   "deleted" by us). Only the `thumbnail_url` the provider returned through its
   documented oEmbed endpoint is used — no guessed URL patterns. Drive has none. */
export function sourceThumbUrl(_video, meta) {
  return meta?.thumbnailUrl && /^https:\/\//.test(meta.thumbnailUrl) ? meta.thumbnailUrl : "";
}

/* 16:9 thumbnail for a lesson/guide: custom upload (app-owned) when thumbMode is
   "custom", else the provider's artwork (letterboxed, never distorted), else a
   quiet placeholder. */
export function VideoThumb({ item, className = "", placeholder }) {
  const [broken, setBroken] = useState(false);
  // Older docs have an uploaded thumb but no thumbMode: that upload stays selected.
  const custom = item?.thumb?.path && (item.thumbMode === "custom" || item.thumbMode == null);
  if (custom) return <StoredImage imageRef={item.thumb} alt="" className={className} ratio="16 / 9" placeholder={placeholder} />;
  const src = sourceThumbUrl(item?.video, item?.videoMeta);
  if (src && !broken) return <div className={"ac-img ac-srcthumb " + className}><img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} /></div>;
  return <div className={"ac-img ac-img-empty " + className} style={{ aspectRatio: "16 / 9" }} aria-hidden="true">{placeholder || <PlayIcon className="hi" />}</div>;
}

/* Renders the safe markdown AST (academyMarkdown.js) as real elements. Headings
   are shifted so a lesson's "#" is an h3 under the page's own h1/h2. */
/* `version`: the stored text's Markdown format (absent/1 = legacy rules). */
export function Markdown({ src, className = "ac-md", baseLevel = 3, version = 1 }) {
  const blocks = useMemo(() => parseMarkdown(src, { version }), [src, version]);
  if (!blocks.length) return null;
  return (
    <div className={className}>
      {blocks.map((b, i) => {
        if (b.type === "heading") {
          const H = `h${Math.min(6, baseLevel + b.level - 1)}`;
          return <H key={i}>{renderInlines(b.inlines)}</H>;
        }
        if (b.type === "list") {
          const L = b.ordered ? "ol" : "ul";
          return <L key={i}>{b.items.map((it, j) => <li key={j}>{renderInlines(it)}</li>)}</L>;
        }
        return <p key={i}>{renderInlines(b.inlines)}</p>;
      })}
    </div>
  );
}
export function renderInlines(inl) {
  return inl.map((n, i) => {
    switch (n.type) {
      case "text": return <React.Fragment key={i}>{n.text}</React.Fragment>;
      case "break": return <br key={i} />;
      case "code": return <code key={i}>{n.text}</code>;
      case "strong": return <strong key={i}>{renderInlines(n.inlines)}</strong>;
      case "em": return <em key={i}>{renderInlines(n.inlines)}</em>;
      case "link": return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">{renderInlines(n.inlines)}</a>;
      default: return null;
    }
  });
}
/* Comment bodies: inline formatting + safe links only (no headings/lists). */
export function SafeText({ text }) {
  const inl = useMemo(() => parseInlines(String(text || "")), [text]);
  return <>{renderInlines(inl)}</>;
}
