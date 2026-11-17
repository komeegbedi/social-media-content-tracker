/* Tips & resources (stored as "guides") — pure helpers for the private draft →
   publish model (v6.11). A guide is ONE document, so its draft is too:
   guideDrafts/{id} (editors only) holds the working copy; guides/{id} is what
   learners read. Publishing copies GUIDE_CONTENT_FIELDS verbatim from the draft
   (the rules require the published fields to equal the draft being published). */
import { isValidVideoRecord } from "./academyVideo.js";

export const GUIDE_CONTENT_FIELDS = ["title", "category", "topics", "topicIds", "video", "videoMeta", "thumbMode", "body", "resources", "thumb", "durationMinutes", "mdVersion"];

/* The working copy from a published (or legacy) guide: same values, nothing
   converted — `mdVersion` is copied only if present, so legacy text keeps
   rendering as legacy until the author actually edits it. */
export function guideDraftFromLive(live) {
  const out = {};
  for (const k of GUIDE_CONTENT_FIELDS) if (live && live[k] !== undefined) out[k] = live[k];
  return { title: "", category: "", topics: [], topicIds: [], video: null, videoMeta: null, thumbMode: "source", body: "", resources: [], thumb: null, durationMinutes: 0, ...out };
}
export const guideKind = (g) => (g && g.video ? "video" : "text");
export const GUIDE_KIND_LABEL = { video: "Video resource", text: "Written resource" };

/* What publishing requires (labels/readiness/publish check all use this).
   A resource needs a title, an existing category, and content: a supported
   video link OR some text (a text-only resource publishes without a video). */
export function guidePublishIssues(g, categoryIds) {
  const out = [];
  const add = (x) => out.push({ blocker: x.message, item: "details", ...x });
  if (!String(g.title || "").trim()) add({ key: "title", kind: "missing", field: "title", label: "Title", message: "Add a title.", fix: "Add title" });
  if (!g.category || (categoryIds && !categoryIds.includes(g.category))) add({ key: "category", kind: "missing", field: "category", label: "Category", message: "Choose a category.", fix: "Choose category" });
  if (g.video && !isValidVideoRecord(g.video)) add({ key: "video", kind: "missing", field: "video", label: "Video link", message: "Use a YouTube, Vimeo or Google Drive link.", fix: "Fix link" });
  else if (!g.video && !String(g.body || "").trim()) add({ key: "content", kind: "missing", field: "content", label: "Content", message: "Add a video link or some text.", fix: "Add content" });
  if (String(g.body || "").length > 20000) add({ key: "body-long", kind: "missing", field: "body", label: "Text", message: "Shorten the text to 20,000 characters or fewer.", fix: "Shorten" });
  return out;
}
export const guideHasChanges = (head) => !!head && Number(head.rev || 0) > Number(head.publishedRev || 0);

/* Same as courseFingerprint, for a guide: any publish/save/move after a review
   is detected (server mirror in functions/academyCategoryDeletion.js). */
const ms = (t) => (!t ? 0 : typeof t.toMillis === "function" ? t.toMillis() : typeof t.seconds === "number" ? t.seconds * 1000 : 0);
export function guideFingerprint(live, draft) {
  return [live ? live.status || "" : "", live ? live.category || "" : "", draft ? draft.category || "" : "", draft ? Number(draft.rev || 0) : "", live ? ms(live.updatedAt) : ""].join("|");
}
/* A row for category management / deletion. */
export function guideRow(id, live, draft, inCategory = null) {
  const src = draft || live || {};
  const status = !live ? "draft-only" : live.status === "published" ? (draft && Number(draft.rev) > Number(draft.publishedRev || 0) ? "published-edits" : "published") : live.status === "archived" ? "archived" : "unpublished";
  const liveIn = !!live && (!inCategory || inCategory.includes(live.category));
  return {
    id, type: "guide", title: String(src.title || (live && live.title) || "").trim() || "Untitled resource", status, kind: guideKind(src),
    thumb: src.thumb || null, video: src.video || null, videoMeta: src.videoMeta || null, thumbMode: src.thumbMode,
    category: draft ? draft.category || "" : live ? live.category || "" : "", liveCategory: live ? live.category || "" : "",
    liveIn, draftIn: !!draft && (!inCategory || inCategory.includes(draft.category)),
    draftConflict: liveIn && !!draft && !!draft.category && !!inCategory && !inCategory.includes(draft.category),
    publishedElsewhere: !!inCategory && !liveIn && !!live && live.status === "published",
    changes: !!live && !!draft && Number(draft.rev) > Number(draft.publishedRev || 0),
    fp: guideFingerprint(live, draft),
  };
}

/* Learning-path editor (editors only): every resource an editor can add as a step —
   published / unpublished / archived records AND never-published drafts (which exist
   only in guideDrafts until their first publish). Learners never read this list: a
   step whose resource isn't published shows to them as unavailable. */
export const PATH_GUIDE_STATUS = { published: "", unpublished: "unpublished", archived: "archived", "draft-only": "not published yet" };
export function pathPickerGuides(live = [], drafts = []) {
  const byId = new Map();
  for (const g of live) byId.set(g.id, { live: g, draft: null });
  for (const d of drafts) { const x = byId.get(d.id); if (x) x.draft = d; else byId.set(d.id, { live: null, draft: d }); }
  return [...byId.entries()].map(([id, { live: l, draft: d }]) => {
    const status = !l ? "draft-only" : l.status === "published" ? "published" : l.status === "archived" ? "archived" : "unpublished";
    const title = String((l ? l.title : d && d.title) || "").trim() || "Untitled resource";
    return { id, title, category: (l ? l.category : d && d.category) || "", status, statusLabel: PATH_GUIDE_STATUS[status] };
  }).sort((a, b) => a.title.localeCompare(b.title));
}
