/* IFC Creative Academy — deleting a category with its contents (admins only).

   The browser runs the reviewed plan with the existing services (the course
   deletion service and ordinary category moves, each checked by the rules);
   the SERVER owns the parts that must not be left to a browser:

   lockCategoryForDeletion { categoryId, planId, expected, plan }
     Re-reads everything filed under the category (live courses, course drafts,
     quick guides, learning paths) and compares it with what the admin reviewed
     (`expected`: ids + a per-course fingerprint of status, categories, draft
     revision and last publish). Any difference → { ok:false, changes } and
     nothing is locked: the admin must review again. Validates the plan (every
     item resolved, destinations exist / aren't this category / aren't being
     deleted, published courses filed elsewhere aren't deleted from here), then
     LOCKS the category: `deleting: { planId, plan, by, byName, at }`. While
     locked the rules refuse anything that would file content under it
     (create, move in, publish, draft autosave), and allow an admin to delete
     its published courses directly. Same planId again → ok (idempotent).

   finalizeCategoryDeletion { categoryId, planId }
     Deletes the category record — only if it's locked for this plan and
     NOTHING is filed under it any more ({ ok:false, remaining } otherwise).
     Removes it from the hidden index and returns its own cover path for the
     caller's storage clean-up. Already gone → { ok:true, already:true }.

   cancelCategoryDeletion { categoryId }
     Removes the lock (the category stays). Courses already deleted stay
     deleted; moved courses stay where they went. */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db, FieldValue } = require("./lib");

const CAT = /^[a-z0-9-]{1,40}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const LEGACY = { videography: "filmmaking", "social-media": "social-media-storytelling" };
const idsFor = (catId) => [catId, ...Object.entries(LEGACY).filter(([, to]) => to === catId).map(([from]) => from)];
const ms = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : 0);
/* Must match courseFingerprint in src/academyCategoryDeletion.js (parity-tested). */
function courseFingerprint(live, draft) {
  return [live ? live.status || "" : "", live ? live.category || "" : "", draft ? draft.category || "" : "", draft ? Number(draft.rev || 0) : "", live ? ms(live.updatedAt) : ""].join("|");
}

async function requireAdmin(uid) {
  const snap = await db.collection("users").doc(uid).get();
  const p = snap.exists ? snap.data() : null;
  if (!p || p.disabled === true || p.role !== "admin" || (p.status && p.status !== "approved")) throw new HttpsError("permission-denied", "Only admins can delete a category.");
  return p;
}

/* Everything filed under the category, read on the server. */
async function contentsOf(catId) {
  const ids = idsFor(catId);
  const [live, drafts, guides, guideDrafts, paths] = await Promise.all([
    db.collection("courses").where("category", "in", ids).get(),
    db.collection("courseDrafts").where("category", "in", ids).get(),
    db.collection("guides").where("category", "in", ids).get(),
    db.collection("guideDrafts").where("category", "in", ids).get(),       // v6.11: tips & resources have drafts too
    db.collection("paths").where("category", "in", ids).get(),
  ]);
  const courseIds = [...new Set([...live.docs.map((d) => d.id), ...drafts.docs.map((d) => d.id)])];
  const courses = await Promise.all(courseIds.map(async (id) => {
    const [l, d] = await Promise.all([db.collection("courses").doc(id).get(), db.collection("courseDrafts").doc(id).get()]);
    const ld = l.exists ? l.data() : null, dd = d.exists ? d.data() : null;
    return { id, title: (dd && dd.title) || (ld && ld.title) || "Untitled course", fp: courseFingerprint(ld, dd), live: ld, draft: dd };
  }));
  const guideIds = [...new Set([...guides.docs.map((d) => d.id), ...guideDrafts.docs.map((d) => d.id)])];
  const guideRows = await Promise.all(guideIds.map(async (id) => {
    const [l, d] = await Promise.all([db.collection("guides").doc(id).get(), db.collection("guideDrafts").doc(id).get()]);
    const ld = l.exists ? l.data() : null, dd = d.exists ? d.data() : null;
    return { id, title: String((dd && dd.title) || (ld && ld.title) || "").trim() || "Untitled resource", fp: courseFingerprint(ld, dd), live: ld, draft: dd };
  }));
  return { courses, guides: guideRows, paths: paths.docs.map((d) => ({ id: d.id, title: d.data().title || "Untitled path" })) };
}

/* What differs from what the admin reviewed (empty = nothing). */
function diffContents(current, expected) {
  const changes = [];
  const exp = new Map((expected.courses || []).map((c) => [c.id, c.fp]));
  for (const c of current.courses) {
    if (!exp.has(c.id)) changes.push({ kind: "added", type: "course", id: c.id, title: c.title });
    else if (exp.get(c.id) !== c.fp) changes.push({ kind: "changed", type: "course", id: c.id, title: c.title });
  }
  for (const id of exp.keys()) if (!current.courses.some((c) => c.id === id)) changes.push({ kind: "removed", type: "course", id });
  // tips & resources: ids + fingerprints (like courses); older clients sent plain ids
  const expG = new Map((expected.guides || []).map((g) => (typeof g === "string" ? [g, null] : [g.id, g.fp])));
  for (const g of current.guides) {
    if (!expG.has(g.id)) changes.push({ kind: "added", type: "guide", id: g.id, title: g.title });
    else if (expG.get(g.id) != null && expG.get(g.id) !== g.fp) changes.push({ kind: "changed", type: "guide", id: g.id, title: g.title });
  }
  for (const id of expG.keys()) if (!current.guides.some((g) => g.id === id)) changes.push({ kind: "removed", type: "guide", id });
  const e = new Set(expected.paths || []);
  for (const x of current.paths) if (!e.has(x.id)) changes.push({ kind: "added", type: "path", id: x.id, title: x.title });
  for (const id of e) if (!current.paths.some((x) => x.id === id)) changes.push({ kind: "removed", type: "path", id });
  return changes;
}

async function validDestination(dest, catId) {
  if (!CAT.test(String(dest || "")) || idsFor(catId).includes(dest)) return false;
  const d = await db.collection("academyCategories").doc(dest).get();
  return d.exists && !d.data().deleting;
}
/* Problems with the plan itself (each item needs an explicit, valid resolution). */
async function planProblems(current, plan, catId) {
  const out = [];
  const ids = idsFor(catId);
  for (const c of current.courses) {
    const a = plan.courses && plan.courses[c.id];
    if (!a || !["move", "delete"].includes(a.action)) { out.push(`“${c.title}” has no choice yet.`); continue; }
    if (a.action === "move" && !(await validDestination(a.dest, catId))) out.push(`“${c.title}” has no valid destination.`);
    if (a.action === "delete" && c.live && c.live.status === "published" && !ids.includes(c.live.category))
      out.push(`“${c.title}” is published in another category, so it can't be deleted from here.`);
  }
  for (const g of current.guides) {
    const a = plan.guides && plan.guides[g.id];
    if (!a || !["move", "delete"].includes(a.action)) { out.push(`The resource “${g.title}” has no choice yet.`); continue; }
    if (a.action === "move" && !(await validDestination(a.dest, catId))) out.push(`The resource “${g.title}” has no valid destination.`);
    if (a.action === "delete" && g.live && g.live.status === "published" && !ids.includes(g.live.category))
      out.push(`The resource “${g.title}” is published in another category, so it can't be deleted from here.`);
  }
  for (const p of current.paths) { const d = plan.paths && plan.paths[p.id]; if (d !== "" && !(await validDestination(d, catId))) out.push(`The learning path “${p.title}” needs a category, or “No category”.`); }
  return out;
}

const readArgs = (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const categoryId = String((req.data && req.data.categoryId) || "");
  if (!CAT.test(categoryId)) throw new HttpsError("invalid-argument", "Category is missing.");
  return { uid: req.auth.uid, categoryId, planId: String((req.data && req.data.planId) || "") };
};

const lockCategoryForDeletion = onCall({ memory: "256MiB", timeoutSeconds: 60 }, async (req) => {
  const { uid, categoryId, planId } = readArgs(req);
  const me = await requireAdmin(uid);
  if (!ID.test(planId)) throw new HttpsError("invalid-argument", "Plan is missing.");
  const expected = (req.data && req.data.expected) || {};
  const plan = (req.data && req.data.plan) || {};
  const ref = db.collection("academyCategories").doc(categoryId);
  const cat = await ref.get();
  if (!cat.exists) throw new HttpsError("not-found", "This category doesn't exist any more.");
  const lock = cat.data().deleting;
  if (lock && lock.planId === planId) return { ok: true, already: true };            // a retry of the same confirmation
  if (lock) throw new HttpsError("failed-precondition", `${lock.byName || "Another admin"} is already deleting this category.`);
  const current = await contentsOf(categoryId);
  const changes = diffContents(current, expected);
  if (changes.length) return { ok: false, changes };
  const problems = await planProblems(current, plan, categoryId);
  if (problems.length) return { ok: false, problems };
  // lock — only if nobody else locked it in the meantime
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpsError("not-found", "This category doesn't exist any more.");
    const l = s.data().deleting;
    if (l && l.planId !== planId) throw new HttpsError("failed-precondition", `${l.byName || "Another admin"} is already deleting this category.`);
    if (!l) tx.update(ref, { deleting: { planId, plan: { courses: plan.courses || {}, guides: plan.guides || {}, paths: plan.paths || {} }, by: uid, byName: me.name || "", at: FieldValue.serverTimestamp() } });
  });
  // re-check after locking: anything filed under it between the read and the lock
  const after = diffContents(await contentsOf(categoryId), expected);
  if (after.length) { await ref.update({ deleting: FieldValue.delete() }); return { ok: false, changes: after }; }
  return { ok: true };
});

const finalizeCategoryDeletion = onCall({ memory: "256MiB", timeoutSeconds: 60 }, async (req) => {
  const { uid, categoryId, planId } = readArgs(req);
  await requireAdmin(uid);
  const ref = db.collection("academyCategories").doc(categoryId);
  const cat = await ref.get();
  if (!cat.exists) return { ok: true, already: true };                                // a retry after it was deleted
  const lock = cat.data().deleting;
  if (!lock || lock.planId !== planId) throw new HttpsError("failed-precondition", "This category isn't being deleted with this plan. Review it again.");
  const current = await contentsOf(categoryId);
  const remaining = [...current.courses.map((c) => ({ type: "course", id: c.id, title: c.title })), ...current.guides.map((g) => ({ type: "guide", id: g.id, title: g.title })), ...current.paths.map((p) => ({ type: "path", id: p.id, title: p.title }))];
  if (remaining.length) return { ok: false, remaining };
  const cover = cat.data().cover && cat.data().cover.path;
  await db.runTransaction(async (tx) => {
    const idxRef = db.collection("academySettings").doc("categoryIndex");
    const idx = await tx.get(idxRef);
    tx.delete(ref);
    if (idx.exists) tx.update(idxRef, { hidden: (idx.data().hidden || []).filter((x) => !idsFor(categoryId).includes(x)), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
  });
  // its own cover image is removed by the caller (same storage clean-up as courses)
  return { ok: true, coverPath: cover && String(cover).startsWith(`academy/catCovers/${categoryId}/`) ? cover : null };
});

const cancelCategoryDeletion = onCall({ memory: "256MiB", timeoutSeconds: 30 }, async (req) => {
  const { uid, categoryId } = readArgs(req);
  await requireAdmin(uid);
  const ref = db.collection("academyCategories").doc(categoryId);
  const cat = await ref.get();
  if (cat.exists && cat.data().deleting) await ref.update({ deleting: FieldValue.delete() });
  return { ok: true };
});

module.exports = { lockCategoryForDeletion, finalizeCategoryDeletion, cancelCategoryDeletion, courseFingerprint, diffContents, idsFor };
