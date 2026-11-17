/* Deleting a category and resolving everything filed under it — the pure
   parts (plan, review wording, order of operations, honest results). The
   dialog injects the real operations; the server (callables + rules) owns the
   lock, the re-check against what was reviewed, and the final delete.

   Plan: { courses: { [id]: { action: "move"|"delete", dest?, draftDest? } },
           guides:  { [id]: { action: "move"|"delete", dest?, draftDest? } },   (tips & resources, v6.11)
           paths:   { [id]: destCategoryId | "" } }                            (never deleted here) */

const ms = (t) => (!t ? 0 : typeof t.toMillis === "function" ? t.toMillis() : typeof t.seconds === "number" ? t.seconds * 1000 : 0);
/* Same as courseFingerprint in functions/academyCategoryDeletion.js (parity-tested):
   anything that changes it after review (a publish, a draft save, a move)
   means the admin reviews again. */
export function courseFingerprint(live, draft) {
  return [live ? live.status || "" : "", live ? live.category || "" : "", draft ? draft.category || "" : "", draft ? Number(draft.rev || 0) : "", live ? ms(live.updatedAt) : ""].join("|");
}

/* A course row for the dialog from its live + draft docs. `inCategory` = the
   ids that read as this category (legacy aliases included). */
export function courseRow(id, live, draft, inCategory) {
  const liveIn = !!live && inCategory.includes(live.category);
  const draftIn = !!draft && inCategory.includes(draft.category);
  const status = !live ? "draft-only" : live.status === "published" ? (draft && Number(draft.rev) > Number(draft.publishedRev || 0) ? "published-edits" : "published") : live.status === "archived" ? "archived" : "unpublished";
  return {
    id, title: (draft && draft.title) || (live && live.title) || "Untitled course", cover: (draft && draft.cover) || (live && live.cover) || null,
    status, liveIn, draftIn, liveCategory: live ? live.category || "" : "", draftCategory: draft ? draft.category || "" : "",
    // its unpublished edits would move it to ANOTHER category on publish: shown, never overwritten silently
    draftConflict: liveIn && !!draft && !!draft.category && !inCategory.includes(draft.category),
    // only its draft is filed here; the live course is published in another category
    publishedElsewhere: !liveIn && !!live && live.status === "published",
    fp: courseFingerprint(live, draft),
  };
}
export const STATUS_LABEL = {
  "published": "Published", "published-edits": "Published, with unpublished changes", "unpublished": "Unpublished",
  "archived": "Archived", "draft-only": "Draft, never published",
};

/* The plan from the dialog's choices. mode: "move-all" | "delete-all" | "each". */
export function buildPlan({ mode, courses, guides = [], paths = [], sharedDest = "", rows = {}, pathDest = {} }) {
  const plan = { courses: {}, guides: {}, paths: {} };
  const resolve = (c) => {
    const r = rows[c.id] || {};
    const action = mode === "move-all" ? "move" : mode === "delete-all" ? "delete" : r.action || null;
    if (!action) return null;
    const dest = action === "move" ? (mode === "each" && r.dest ? r.dest : sharedDest) : undefined;
    return action === "move" ? { action, dest, ...(c.draftConflict && r.draftToo ? { draftDest: dest } : {}) } : { action };
  };
  for (const c of courses) { const a = resolve(c); if (a) plan.courses[c.id] = a; }
  for (const g of guides) { const a = resolve(g); if (a) plan.guides[g.id] = a; }
  // learning paths are never deleted here: an explicit category, or none
  for (const p of paths) if (p.id in pathDest) plan.paths[p.id] = pathDest[p.id];
  return plan;
}

/* What still needs a decision before review (each entry names the item). */
export function unresolved(plan, { courses, guides = [], paths = [] }, categoryIds = []) {
  const out = [];
  const okDest = (d) => !!d && categoryIds.includes(d);
  const check = (c, a, what) => {
    if (!a) out.push(`Choose Move or Delete for ${what} “${c.title}”.`);
    else if (a.action === "move" && !okDest(a.dest)) out.push(`Choose where to move ${what} “${c.title}”.`);
    else if (a.action === "delete" && c.publishedElsewhere) out.push(`${what === "the course" ? "The course" : "The resource"} “${c.title}” is published in another category, so it can't be deleted from here. Move it instead.`);
  };
  for (const c of courses) check(c, plan.courses[c.id], "the course");
  for (const g of guides) check(g, plan.guides[g.id], "the resource");
  for (const p of paths) if (!(p.id in plan.paths) || (plan.paths[p.id] !== "" && !okDest(plan.paths[p.id]))) out.push(`Choose a category for the learning path “${p.title}”, or “No category”.`);
  return out;
}

const n = (k, what = "course") => `${k} ${what}${k === 1 ? "" : "s"}`;
const listNames = (xs) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
/* "2 courses and 3 resources" / "2 courses" / "3 resources" */
const both = (c, g) => listNames([c ? n(c) : "", g ? n(g, "resource") : ""].filter(Boolean));
/* The summary (separate counts for courses and tips & resources) + the
   confirm button's label + the items grouped by destination. */
export function reviewSummary(plan, { category, courses, guides = [], labelOf }) {
  const moves = courses.filter((c) => plan.courses[c.id]?.action === "move");
  const dels = courses.filter((c) => plan.courses[c.id]?.action === "delete");
  const gmoves = guides.filter((g) => plan.guides[g.id]?.action === "move");
  const gdels = guides.filter((g) => plan.guides[g.id]?.action === "delete");
  const byDest = {};
  for (const c of moves) (byDest[plan.courses[c.id].dest] ||= []).push({ ...c, type: "course" });
  for (const g of gmoves) (byDest[plan.guides[g.id].dest] ||= []).push({ ...g, type: "guide" });
  const parts = [];
  if (moves.length || gmoves.length) parts.push(`Move ${both(moves.length, gmoves.length)}.`);
  if (dels.length || gdels.length) parts.push(`Delete ${both(dels.length, gdels.length)}.`);
  parts.push(`Delete the category ${category}.`);
  const sentence = parts.join(" ");
  const m = moves.length + gmoves.length, d = dels.length + gdels.length;
  const button = !m && !d ? "Delete category"
    : !m ? `Delete category and ${both(dels.length, gdels.length)}`
    : !d ? `Move ${both(moves.length, gmoves.length)} and delete category`
    : `Move ${both(moves.length, gmoves.length)} and delete ${both(dels.length, gdels.length)}`;
  return { sentence, button, moves, dels, gmoves, gdels, byDest, destText: Object.entries(byDest).map(([dd, xs]) => `${both(xs.filter((x) => x.type === "course").length, xs.filter((x) => x.type === "guide").length)} to ${labelOf(dd)}`) };
}

/* ORDER (deliberate):
   1. lock: the server re-checks everything against what was reviewed and
      locks the category (nothing new can be filed under it). Changed →
      stop, nothing done, review again.
   2. each item, in order: moves (course, then guide/path) and deletions,
      each with the existing service; a failure is recorded, the rest go on.
   3. destination orders: moved courses appended, existing order untouched.
   4. finalize — ONLY if every item succeeded: the server deletes the
      category once nothing is filed under it.
   Re-running with the same plan is safe: moved items are already moved,
   deleted ones are already gone (both no-ops), the lock/finalize calls are
   idempotent. Returns a report of exactly what happened. */
export async function runCategoryDeletion({ plan, items, ops, onProgress }) {
  const report = { stage: "running", moved: [], deleted: [], failed: [], cleanupPending: [], warnings: [], changes: null, problems: null };
  const lock = await ops.lock();
  if (!lock.ok) return { ...report, stage: lock.changes ? "changed" : "invalid", changes: lock.changes || null, problems: lock.problems || null };
  const movedBy = {};
  for (const it of items) {
    onProgress && onProgress(it, "working");
    try {
      const act = it.type === "course" ? plan.courses[it.id] : it.type === "guide" ? plan.guides[it.id] : null;
      if (act && act.action === "delete") {
        const r = it.type === "course" ? await ops.deleteCourse(it.id) : await ops.deleteGuide(it.id);
        report.deleted.push(it);
        if (r && r.pendingCleared === false) report.cleanupPending.push(it);
      } else {
        const dest = act ? act.dest : plan.paths[it.id];
        await ops.move(it, dest);
        report.moved.push({ ...it, dest });
        if (it.type === "course") (movedBy[dest] ||= []).push(it.id);
      }
      onProgress && onProgress(it, "done");
    } catch (e) {
      report.failed.push({ ...it, message: (e && e.message) || "Failed." });
      onProgress && onProgress(it, "failed");
    }
  }
  for (const [dest, ids] of Object.entries(movedBy)) {
    try { await ops.appendOrder(dest, ids); } catch { report.warnings.push(`The order in ${dest} couldn't be updated. The moved courses are there, listed after the others.`); }
  }
  if (report.failed.length) return { ...report, stage: "partial" };
  const fin = await ops.finalize();
  if (!fin.ok) return { ...report, stage: "partial", remaining: fin.remaining || [] };
  if (fin.coverPath && ops.deleteCover) { try { await ops.deleteCover(fin.coverPath); } catch { report.cleanupPending.push({ type: "cover", id: fin.coverPath, title: "category cover" }); } }
  return { ...report, stage: "done" };
}

/* The final message after success. */
/* Totals come from the PLAN when given (a resumed run only did the rest, but the
   message describes the whole deletion). */
export function doneMessage(report, category, plan = null) {
  const count = (type, action) => plan
    ? Object.values((type === "course" ? plan.courses : plan.guides) || {}).filter((a) => a.action === action).length
    : (action === "move" ? report.moved : report.deleted).filter((x) => x.type === type).length;
  const mc = count("course", "move"), mg = count("guide", "move"), dc = count("course", "delete"), dg = count("guide", "delete");
  const bits = [mc || mg ? `moved ${both(mc, mg)}` : "", dc || dg ? `permanently deleted ${both(dc, dg)}` : ""].filter(Boolean);
  const pathsMoved = plan ? Object.keys(plan.paths || {}).length : report.moved.filter((x) => x.type === "path").length;
  let msg = `Deleted the category “${category}”.${bits.length ? ` ${bits.join(" and ").replace(/^./, (ch) => ch.toUpperCase())}.` : ""}`;
  if (pathsMoved) msg += ` ${pathsMoved === 1 ? "1 learning path was" : `${pathsMoved} learning paths were`} updated too.`;
  if (report.cleanupPending.length) msg += " Some clean-up (old images, progress or review records) is still pending. You can retry it from this page.";
  return msg;
}
