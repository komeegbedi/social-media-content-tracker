/* IFC Creative Academy — permanent course deletion, as an idempotent,
   retryable sequence (pure orchestration; Firebase operations are injected so
   the failure/retry behaviour is unit-tested).

     1. plan        what exists: the course, its content docs, app-owned images
     2. markPending record { title, images } in academySettings/pendingCleanup —
                    BEFORE anything is deleted, so a failure later is visible
                    and retryable from Admin → Academy → Courses
     3. content     lessons, comments, quiz keys, then the course doc (last).
                    A failure here throws: the course still exists, nothing is
                    half-hidden, and running the delete again resumes.
     4. learner records   progress + quiz attempts for the course (rules allow
                    this only once the course doc is gone)
     5. images      app-owned uploads only; "not found" counts as done.
                    Provider-hosted thumbnails are never touched.
     6. clearPending      ONLY when 4 and 5 fully succeeded.

   Learning paths are deliberately NOT edited. A step pointing at the deleted
   course resolves as "unavailable", which BLOCKS path completion until an
   editor updates the path — removing the step silently could award a path
   completion the learner never earned. */
export async function runCourseDeletion(ops, courseId, pending = null) {
  const report = { contentDeleted: false, progressDeleted: 0, attemptsDeleted: 0, failedImages: [], errors: [], pendingCleared: false, pathsAffected: [] };
  const plan = await ops.plan(courseId);
  // only this course's own upload folders (never a shared/foreign reference)
  const own = (p) => !!p && (String(p).startsWith(`academy/covers/${courseId}/`) || String(p).startsWith(`academy/lessonThumbs/${courseId}/`));
  const candidates = [...new Set([...(plan.images || []), ...((pending && pending.images) || [])])].filter(own);
  // …and not used by any other course/draft/lesson/guide/path/category. If the
  // check can't run, nothing is deleted now: the images stay in the pending
  // clean-up list and "Retry clean-up" re-checks them later.
  let keep = new Set(), verified = true;
  if (ops.referencedElsewhere && candidates.length) {
    try { keep = await ops.referencedElsewhere(candidates, courseId); } catch { verified = false; }
  }
  const images = verified ? candidates.filter((p) => !keep.has(p)) : [];
  if (!verified) report.failedImages.push(...candidates);
  report.keptShared = [...keep];
  report.pathsAffected = plan.pathsAffected || [];
  await ops.markPending(courseId, { title: plan.title || (pending && pending.title) || courseId, images: verified ? images : candidates });
  if (plan.contentRefs && plan.contentRefs.length) await ops.deleteContent(plan.contentRefs);   // throws → retry later
  report.contentDeleted = true;
  try { report.progressDeleted = await ops.deleteProgress(courseId); } catch { report.errors.push("progress"); }
  try { report.attemptsDeleted = await ops.deleteAttempts(courseId); } catch { report.errors.push("attempts"); }
  for (const p of images) {
    try { await ops.deleteImage(p); }
    catch (e) { if (!(ops.isNotFound && ops.isNotFound(e))) report.failedImages.push(p); }
  }
  if (!report.errors.length && !report.failedImages.length) { await ops.clearPending(courseId); report.pendingCleared = true; }
  return report;
}

/* Which learning paths reference a course (any step type) — shown in the
   delete confirmation so the effect on paths is explicit. */
export const pathsReferencingCourse = (paths, courseId) =>
  (paths || []).filter((p) => (p.items || []).some((it) => it.courseId === courseId))
    .map((p) => ({ id: p.id, title: p.title, status: p.status, steps: (p.items || []).filter((it) => it.courseId === courseId).length }));
