/* Showing a category + publishing chosen courses with it — the pure parts
   (who is affected, readiness, ORDER of operations, honest outcome). The React
   dialog and the data layer inject the real operations, so this unit-tests
   without Firebase.

   Model (unchanged): courses are draft/published/archived; categories are
   hidden/visible. Nothing here changes one because of the other unless the
   admin explicitly chose it in the dialog. */
import { publishIssues, flatLessons, normalizeCategory } from "./academyProgress.js";

/* The courses a category's visibility affects, split the way the dialog shows them.
   list: workspace course rows ({ id, title, category, liveCategory, status, changes }).
     visible   — already published here: they become visible when the category is shown
     never     — never published, filed here: CAN be published (not preselected)
     edits     — published here with unpublished edits: the LIVE version becomes
                 visible; the edits are published only if explicitly selected
     archived  — archived here: stay hidden (restore from the course menu) */
export function categoryCourseGroups(list, catId) {
  const id = normalizeCategory(catId);
  const inLive = (c) => normalizeCategory(c.liveCategory || "") === id;
  const inDraft = (c) => normalizeCategory(c.category || "") === id;
  const visible = list.filter((c) => c.status === "published" && inLive(c));
  return {
    visible,
    never: list.filter((c) => c.status === "draft" && inDraft(c)),
    edits: list.filter((c) => c.status === "published" && c.changes && inDraft(c)),
    archived: list.filter((c) => c.status === "archived" && inLive(c)),
    // published courses that will LEAVE this category on their next publish still count as visible now
  };
}

/* Readiness of one course from loadCourseWorkspace(cid) output: the exact
   revision to publish + what must be fixed first (same checks as Publish). */
export function readinessOf(ws, categoryIds) {
  if (!ws || !ws.draftExists) return { rev: null, issues: [], ready: false, nothingToPublish: true };
  const ordered = flatLessons(ws.course, Object.entries(ws.lessons || {}).map(([id, l]) => ({ id, ...l })));
  const issues = publishIssues(ws.course, ordered, categoryIds);
  return { rev: ws.head.rev, issues, ready: issues.length === 0, nothingToPublish: ws.head.rev <= ws.head.publishedRev && !!ws.liveCourse && ws.liveCourse.status === "published" };
}

const plain = (e, what = "publish") => {
  if (e?.code === "conflict") return "It changed after you opened this list, so it wasn't published. Check it again.";
  if (e?.code === "blocked") return (e.blockers && e.blockers[0]) || e.message || "It isn't ready to publish.";
  // a security-rules refusal: lost editing access, a category being deleted, or content the server
  // won't accept (e.g. an invalid image reference) — don't claim it's only about permission
  if (e?.code === "permission-denied" || /permission/i.test(e?.message || "")) return what === "show" ? "The server refused to show the category. You may no longer have permission to change it, or it may be being deleted."
    : "The server refused to publish it. You may no longer have editing access, its category may be being deleted, or something in it isn't valid. Open it to check.";
  if (e?.code === "offline" || e?.code === "unavailable" || /offline|network/i.test(e?.message || "")) return "The connection dropped before this was confirmed. Try again. It won't publish twice.";
  return e?.message || "Couldn't publish.";
};

/* ORDER (deliberate):
   1. each selected course, one at a time, pinned to the revision the admin
      reviewed (each publish is one atomic transaction and retry-safe);
   2. the category, ONLY when it was requested AND every selected course
      published — a hidden category is never revealed after a failure.
   Never undoes a successful publish. Returns
   { results: [{ id, title, rev, ok, already, code, message }],
     category: "shown" | "held" | "failed" | "unchanged", categoryError } */
export async function runCategoryPublish({ items, show = false, publish, showCategory, onProgress }) {
  const results = [];
  for (const it of items) {
    onProgress && onProgress(it.id, "publishing");
    try {
      const r = await publish(it.id, it.rev, it);
      results.push({ ...it, ok: true, already: !!(r && r.already) });
    } catch (e) {
      results.push({ ...it, ok: false, code: e?.code || "error", message: plain(e) });
    }
    onProgress && onProgress(it.id, results[results.length - 1].ok ? "done" : "failed");
  }
  let category = "unchanged", categoryError = null;
  if (show) {
    if (results.every((r) => r.ok)) {
      try { await showCategory(); category = "shown"; }
      catch (e) { category = "failed"; categoryError = plain(e, "show"); }
    } else category = "held";
  }
  return { results, category, categoryError };
}

/* One sentence for the outcome, never claiming more than happened. */
export function outcomeSummary({ results, category }, { wasHidden }) {
  const ok = results.filter((r) => r.ok).length, failed = results.length - ok;
  const noun = results.some((r) => r.type === "guide") ? "item" : "course";
  const n = (k) => `${k} ${noun}${k === 1 ? "" : "s"}`;
  const pub = !results.length ? "" : failed ? `${ok} of ${n(results.length)} published. ${failed} didn't publish.` : `${n(ok)} published.`;
  const cat = category === "shown" ? "The category is now visible to learners."
    : category === "held" ? `The category is still hidden because not every selected ${noun} was published.`
    : category === "failed" ? "Showing the category failed, so it's still hidden."
    : wasHidden ? "The category is still hidden."
    : results.length ? `The category stays visible, and ${noun === "item" ? "content" : "courses"} that ${noun === "item" ? "was" : "were"} already published ${noun === "item" ? "is" : "are"} unchanged.` : "";
  return [pub, cat].filter(Boolean).join(" ");
}
