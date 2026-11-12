/* IFC Creative Academy — Firestore / Storage / callable access layer.

   Everything the Learn screens and the course editor read or write goes through
   here, so the data model (see src/academyProgress.js header + docs/academy.md)
   has exactly one client-side implementation. Pure logic lives in
   academyProgress.js; this file is the Firebase adapter + React hooks.

   Write rules worth knowing (enforced by firestore.rules):
     • every course/lesson/progress write stamps updatedAt: serverTimestamp()
     • a learner's progress write never touches `earned` (server-only)
     • quiz answers are only ever read by the server (quizKeys is editor-only)
     • images are read with getBlob (auth-checked by storage.rules) → object URLs;
       no download URLs are ever requested or stored. */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection, collectionGroup, doc, query, where, onSnapshot, getDoc, getDocs,
  setDoc, updateDoc, deleteDoc, addDoc, writeBatch, serverTimestamp, deleteField, FieldPath, runTransaction,
} from "firebase/firestore";
import { db, callFunction, getStorageInstance } from "./firebase";
import { logIssue } from "./logging";
import { courseCounters, newId, toMs, normalizeCategory, normalizeTopics, nameKey, slugId, defaultCategoryRecords,
  isAcademyEditor, ACADEMY_CATEGORIES, LEGACY_CATEGORY_IDS, quizMode, publishBlockers, flatLessons } from "./academyProgress.js";
import { videoRecord } from "./academyVideo.js";
import { runCourseDeletion, pathsReferencingCourse } from "./academyDeletion.js";
import { draftFromLive, buildPublishPlan, imagePathsOf, deletableAfterDraftSave, normalizeOutline, ownedByCourse } from "./academyDrafts.js";

const PURPOSE_DOC = "purposeVideo";

/* ---- generic listeners ---------------------------------------------------- */
function useQueryDocs(build, deps, enabled) {
  const [state, setState] = useState({ docs: [], loaded: false, error: null });
  useEffect(() => {
    if (!enabled) { setState({ docs: [], loaded: true, error: null }); return; }
    setState((s) => ({ ...s, loaded: false, error: null }));
    let q;
    try { q = build(); } catch (e) { setState({ docs: [], loaded: true, error: e }); return; }
    return onSnapshot(q,
      (snap) => setState({ docs: snap.docs.map((d) => ({ id: d.id, ...d.data() })), loaded: true, error: null }),
      (err) => {
        setState((s) => ({ docs: s.docs, loaded: true, error: err }));
        logIssue({ kind: "error", action: "academy read failed", message: err.message, code: err.code });
      });
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}
function useDocState(path, enabled) {
  const [state, setState] = useState({ data: undefined, loaded: false, error: null });
  useEffect(() => {
    if (!enabled || !path) { setState({ data: null, loaded: true, error: null }); return; }
    setState({ data: undefined, loaded: false, error: null });
    return onSnapshot(doc(db, path),
      (snap) => setState({ data: snap.exists() ? { id: snap.id, ...snap.data() } : null, loaded: true, error: null }),
      (err) => {
        // permission-denied for a draft/missing course reads as "not available".
        setState({ data: null, loaded: true, error: err });
        if (err.code !== "permission-denied") logIssue({ kind: "error", action: `academy doc read failed: ${path}`, message: err.message, code: err.code });
      });
  }, [path, enabled]);
  return state;
}

/* Listen to an arbitrary SET of document paths (path resolution needs the
   referenced courses / lessons / guides). One listener per path; a denied or
   missing doc resolves to null (never throws — a draft referenced by a path
   simply reads as unavailable). Returns { byPath, loaded }. */
export function useManyDocs(paths) {
  const key = paths.join("|");
  const [state, setState] = useState({ byPath: {}, pending: new Set(paths) });
  useEffect(() => {
    const list = key ? key.split("|") : [];
    setState({ byPath: {}, pending: new Set(list) });
    const unsubs = list.map((path) => onSnapshot(doc(db, path),
      (snap) => setState((s) => { const pending = new Set(s.pending); pending.delete(path); return { byPath: { ...s.byPath, [path]: snap.exists() ? { id: snap.id, ...snap.data() } : null }, pending }; }),
      () => setState((s) => { const pending = new Set(s.pending); pending.delete(path); return { byPath: { ...s.byPath, [path]: null }, pending }; })));
    return () => unsubs.forEach((u) => u());
  }, [key]);
  return { byPath: state.byPath, loaded: state.pending.size === 0 };
}

/* ---- category + topic RECORDS (v4) ------------------------------------------ */
export const useCategoryRecords = () => useQueryDocs(() => collection(db, "academyCategories"), [], true);
export const useTopicRecords = () => {
  const s = useQueryDocs(() => collection(db, "academyTopics"), [], true);
  return useMemo(() => ({ ...s, byId: Object.fromEntries(s.docs.map((t) => [t.id, t])) }), [s]);
};
export const useCategoryIndex = () => {
  const s = useDocState("academySettings/categoryIndex", true);
  return useMemo(() => ({ ...s, hidden: s.data?.hidden || [] }), [s]);
};
const stamp = (me, create = false) => ({ updatedAt: serverTimestamp(), updatedBy: me.id, ...(create ? { createdAt: serverTimestamp(), createdBy: me.id } : {}) });
/* Create: id = slug of the name (stable afterwards); refuses a taken id. */
export async function createCategory(me, { name, description = "", short = "" }, existingIds = []) {
  let id = slugId(name);
  if (existingIds.includes(id)) throw new Error(`A category with the id “${id}” already exists. Choose a different name.`);
  await setDoc(doc(db, "academyCategories", id), { name: String(name).trim().slice(0, 60), short: String(short || "").trim().slice(0, 30), description: String(description || "").slice(0, 300), order: existingIds.length, hidden: false, cover: null, ...stamp(me, true) });
  return id;
}
export const updateCategory = (me, id, patch) => updateDoc(doc(db, "academyCategories", id), { ...patch, ...stamp(me) });
/* v6 workspace: a NEW category is created as a private draft (hidden) the
   moment it has a name (or needs an id for its cover). The id is a slug plus a
   short random suffix, fixed forever after; renames never touch it. */
export const newCategoryId = (name) => `${slugId(name || "category")}-${Math.random().toString(36).slice(2, 6)}`;
export async function createCategoryDraft(me, id, { name, description = "", short = "", order = 0 }, currentHidden = []) {
  const b = writeBatch(db);
  b.set(doc(db, "academyCategories", id), { name: String(name || "Untitled category").trim().slice(0, 60) || "Untitled category", short: String(short || "").trim().slice(0, 30), description: String(description || "").slice(0, 300), order, hidden: true, cover: null, courseOrder: [], ...stamp(me, true) });
  b.set(doc(db, "academySettings/categoryIndex"), { hidden: [...new Set([...currentHidden, id])], updatedAt: serverTimestamp(), updatedBy: me.id });
  await b.commit();
  return id;
}
export const setCategoryCourseOrder = (me, id, courseOrder) => updateDoc(doc(db, "academyCategories", id), { courseOrder: courseOrder.slice(0, 500), ...stamp(me) });
/* Hide/restore keeps the denormalised list (consulted by rules) in the same batch. */
export async function setCategoryHidden(me, id, hidden, currentHidden) {
  // Legacy ids that read as this category are hidden with it (rules compare raw ids).
  const ids = [id, ...Object.entries(LEGACY_CATEGORY_IDS).filter(([, to]) => to === id).map(([from]) => from)];
  const next = hidden ? [...new Set([...currentHidden, ...ids])] : currentHidden.filter((x) => !ids.includes(x));
  const b = writeBatch(db);
  b.update(doc(db, "academyCategories", id), { hidden: !!hidden, ...stamp(me) });
  b.set(doc(db, "academySettings/categoryIndex"), { hidden: next, updatedAt: serverTimestamp(), updatedBy: me.id });
  await b.commit();
}
export async function reorderCategories(me, orderedIds) {
  const b = writeBatch(db);
  orderedIds.forEach((id, i) => b.update(doc(db, "academyCategories", id), { order: i, ...stamp(me) }));
  await b.commit();
}
/* Bootstrap the six defaults (only offered when no record exists yet). */
export async function createDefaultCategories(me) {
  const b = writeBatch(db);
  for (const r of defaultCategoryRecords()) b.set(doc(db, "academyCategories", r.id), { ...r, ...stamp(me, true) });
  await b.commit();
}
/* Everything that references a category (editors read all statuses). */
export async function categoryReferences(categoryId) {
  const ids = [categoryId, ...Object.entries({ videography: "filmmaking", "social-media": "social-media-storytelling" }).filter(([, v]) => v === categoryId).map(([k]) => k)];
  const out = { courses: [], guides: [], paths: [] };
  for (const [coll, key] of [["courses", "courses"], ["guides", "guides"], ["paths", "paths"]]) {
    const snap = await getDocs(query(collection(db, coll), where("category", "in", ids)));
    out[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  return out;
}
/* Move every referencing item to another category, then delete the record
   (+ its cover) — never a cascade delete of content. */
export async function reassignAndDeleteCategory(me, fromId, toId, currentHidden) {
  const refs = await categoryReferences(fromId);
  const all = [...refs.courses.map((x) => ["courses", x]), ...refs.guides.map((x) => ["guides", x]), ...refs.paths.map((x) => ["paths", x])];
  if (all.length && !toId) throw new Error("Choose a category to move the content to first.");
  for (let i = 0; i < all.length; i += 200) {
    const b = writeBatch(db);
    for (const [coll, x] of all.slice(i, i + 200)) b.update(doc(db, coll, x.id), { category: toId, ...stamp(me) });
    await b.commit();
  }
  const rec = await getDoc(doc(db, "academyCategories", fromId));
  const cover = rec.exists() ? rec.data().cover : null;
  const b = writeBatch(db);
  b.delete(doc(db, "academyCategories", fromId));
  const aliases = Object.entries(LEGACY_CATEGORY_IDS).filter(([, to]) => to === fromId).map(([from]) => from);
  b.set(doc(db, "academySettings/categoryIndex"), { hidden: currentHidden.filter((x) => x !== fromId && !aliases.includes(x)), updatedAt: serverTimestamp(), updatedBy: me.id });
  await b.commit();
  if (cover?.path) { try { await deleteImage(cover.path); } catch {} }
  return all.length;
}

export async function createTopic(me, { name, description = "" }, byId = {}) {
  const key = nameKey(name);
  const dup = Object.values(byId).find((t) => nameKey(t.name) === key);
  if (dup) throw new Error(`“${dup.name}” already exists${dup.hidden ? " (hidden — restore it instead)" : ""}.`);
  let id = slugId(name);
  if (byId[id]) id = `${id}-${newId().slice(0, 4)}`;
  await setDoc(doc(db, "academyTopics", id), { name: String(name).trim().slice(0, 60), description: String(description || "").slice(0, 300), hidden: false, ...stamp(me, true) });
  return id;
}
export const updateTopic = (me, id, patch) => updateDoc(doc(db, "academyTopics", id), { ...patch, ...stamp(me) });
/* Items referencing a topic by id OR by legacy free-text name. */
export async function topicReferences(topic) {
  const out = [];
  for (const coll of ["courses", "guides", "paths"]) {
    const byId = await getDocs(query(collection(db, coll), where("topicIds", "array-contains", topic.id)));
    byId.docs.forEach((d) => out.push({ coll, id: d.id, title: d.data().title, via: "id" }));
  }
  return out;
}
/* Delete a topic: either strip the association or swap it for another topic
   on every referencing item. Content is never deleted. */
export async function deleteTopic(me, topic, { reassignTo = null } = {}) {
  const refs = await topicReferences(topic);
  for (let i = 0; i < refs.length; i += 200) {
    const b = writeBatch(db);
    for (const r of refs.slice(i, i + 200)) {
      const snap = await getDoc(doc(db, r.coll, r.id));
      const ids = (snap.data()?.topicIds || []).filter((x) => x !== topic.id);
      if (reassignTo && !ids.includes(reassignTo)) ids.push(reassignTo);
      b.update(doc(db, r.coll, r.id), { topicIds: ids, ...stamp(me) });
    }
    await b.commit();
  }
  await deleteDoc(doc(db, "academyTopics", topic.id));
  return refs.length;
}

/* Provider metadata (title / creator / thumbnail) via the server-side oEmbed
   callable — the browser never fetches provider URLs itself. */
/* Resource link card metadata (server-side, editor-only, SSRF-guarded). */
export const fetchLinkMetadata = (url) => callFunction("fetchLinkMetadata", { url }).then((r) => r.data);
export const fetchVideoMetadata = (rec) => callFunction("fetchVideoMetadata", { provider: rec.provider, id: rec.id, hash: rec.hash || null }).then((r) => r.data);

/* ---- courses -------------------------------------------------------------- */
/* Learners see published courses. Admins see everything. A non-admin instructor
   sees published courses plus their own drafts (two listeners, merged). */
/* The category ids a LEARNER may list content under: visible records (or the
   bootstrap defaults when no record exists yet) minus the hidden index, plus the
   legacy aliases of visible categories. */
function useLearnerCategoryIds() {
  const recs = useCategoryRecords();
  const idx = useCategoryIndex();
  return useMemo(() => {
    const base = recs.docs.length ? recs.docs.filter((r) => r.hidden !== true).map((r) => r.id) : ACADEMY_CATEGORIES.map((c) => c.id);
    const vis = base.filter((id) => !idx.hidden.includes(id));
    const legacy = Object.entries(LEGACY_CATEGORY_IDS).filter(([, to]) => vis.includes(to)).map(([from]) => from);
    return { ids: [...new Set([...vis, ...legacy])].sort(), loaded: recs.loaded && idx.loaded };
  }, [recs.docs, recs.loaded, idx.hidden, idx.loaded]);
}

/* Content lists. Editors (admin / academyEditor) read every doc. Learners read
   published docs filed under a VISIBLE category — the query carries
   `category in [...]` so firestore.rules can prove the hidden-category check
   for every result (rules are not filters). Paths aren't category-gated. */
function useContentList(coll, format, me) {
  const editor = isAcademyEditor(me);
  const cats = useLearnerCategoryIds();
  const key = cats.ids.join(",");
  const [state, setState] = useState({ docs: [], loaded: false, error: null });
  useEffect(() => {
    if (!me?.id) { setState({ docs: [], loaded: true, error: null }); return; }
    let qs;
    if (editor) qs = [collection(db, coll)];
    else if (coll === "paths") qs = [query(collection(db, coll), where("status", "==", "published"))];
    else {
      if (!cats.loaded) return;
      const ids = key ? key.split(",") : [];
      if (!ids.length) { setState({ docs: [], loaded: true, error: null }); return; }
      qs = [];
      for (let i = 0; i < ids.length; i += 30) qs.push(query(collection(db, coll), where("status", "==", "published"), where("category", "in", ids.slice(i, i + 30))));
    }
    setState((s) => ({ ...s, loaded: false, error: null }));
    const parts = qs.map(() => null);
    const publish = (error = null) => {
      if (!parts.every(Boolean) && !error) return;
      const docs = parts.filter(Boolean).flat().sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt));
      setState({ docs, loaded: true, error });
    };
    const unsubs = qs.map((q, i) => onSnapshot(q,
      (snap) => { parts[i] = snap.docs.map((d) => ({ id: d.id, ...d.data(), format })); publish(); },
      (err) => { parts[i] = []; publish(err); logIssue({ kind: "error", action: `academy ${coll} read failed`, message: err.message, code: err.code }); }));
    return () => unsubs.forEach((u) => u());
  }, [coll, format, me?.id, editor, key, cats.loaded]);
  return state;
}
export function useCourses(me) {
  const s = useContentList("courses", "course", me);
  return useMemo(() => ({ courses: s.docs, loaded: s.loaded, error: s.error }), [s]);
}
export function useGuides(me) {
  const s = useContentList("guides", "guide", me);
  return useMemo(() => ({ guides: s.docs, loaded: s.loaded, error: s.error }), [s]);
}
export function usePaths(me) {
  const s = useContentList("paths", "path", me);
  return useMemo(() => ({ paths: s.docs, loaded: s.loaded, error: s.error }), [s]);
}
export const useGuide = (guideId) => useDocState(guideId ? `guides/${guideId}` : null, !!guideId);
export const usePathDoc = (pathId) => useDocState(pathId ? `paths/${pathId}` : null, !!pathId);
export const useCourse = (courseId) => useDocState(courseId ? `courses/${courseId}` : null, !!courseId);
export const useLessons = (courseId, enabled = true) =>
  useQueryDocs(() => collection(db, `courses/${courseId}/lessons`), [courseId, enabled], !!courseId && enabled);
export const usePurposeVideo = () => useDocState(`academySettings/${PURPOSE_DOC}`, true);
/* Category artwork: { art: { [categoryId]: imageRef } } — ids are fixed in code. */
export const useCategoryArt = () => useDocState("academySettings/categories", true);
export const saveCategoryArt = (me, art) =>
  setDoc(doc(db, "academySettings/categories"), { art, updatedAt: serverTimestamp(), updatedBy: me.id });
/* "Start here" introduction watched flag (the learner's own). */
export const useIntroState = (uid) => useDocState(uid ? `learnerProgress/${uid}/intro/purposeVideo` : null, !!uid);
export const setIntroWatched = (uid, watched) =>
  setDoc(doc(db, `learnerProgress/${uid}/intro/purposeVideo`),
    { uid, watched: !!watched, watchedAt: watched ? serverTimestamp() : deleteField(), updatedAt: serverTimestamp() }, { merge: true });

/* ---- progress ------------------------------------------------------------- */
export const progressPath = (uid, courseId) => `learnerProgress/${uid}/courseProgress/${courseId}`;
export const useProgress = (uid, courseId) => useDocState(uid && courseId ? progressPath(uid, courseId) : null, !!(uid && courseId));
export function useAllProgress(uid) {
  const s = useQueryDocs(() => collection(db, `learnerProgress/${uid}/courseProgress`), [uid], !!uid);
  return useMemo(() => ({ ...s, byCourse: Object.fromEntries(s.docs.map((p) => [p.id, p])) }), [s]);
}
export const useLeaderProgress = (courseId, enabled) =>
  useQueryDocs(() => query(collectionGroup(db, "courseProgress"), where("courseId", "==", courseId)), [courseId, enabled], !!courseId && enabled);
export const useAttempts = (uid, courseId, lessonId) =>
  useQueryDocs(() => query(collection(db, `quizAttempts/${uid}/attempts`), where("courseId", "==", courseId), where("lessonId", "==", lessonId)),
    [uid, courseId, lessonId], !!(uid && courseId && lessonId));
export const useLeaderAttempts = (courseId, enabled) =>
  useQueryDocs(() => query(collectionGroup(db, "attempts"), where("courseId", "==", courseId)), [courseId, enabled], !!courseId && enabled);

/* Guide "reviewed" self-report + path bookkeeping (both learner-owned). */
export const useAllGuideReviews = (uid) => {
  const s = useQueryDocs(() => collection(db, `learnerProgress/${uid}/guideReviews`), [uid], !!uid);
  return useMemo(() => ({ ...s, byGuide: Object.fromEntries(s.docs.map((r) => [r.id, r])) }), [s]);
};
export const useGuideReview = (uid, guideId) => useDocState(uid && guideId ? `learnerProgress/${uid}/guideReviews/${guideId}` : null, !!(uid && guideId));
export const setGuideReviewed = (uid, guideId, reviewed) =>
  setDoc(doc(db, `learnerProgress/${uid}/guideReviews/${guideId}`),
    { uid, guideId, reviewed: !!reviewed, reviewedAt: reviewed ? serverTimestamp() : deleteField(), updatedAt: serverTimestamp() }, { merge: true });
export const useAllPathProgress = (uid) => {
  const s = useQueryDocs(() => collection(db, `learnerProgress/${uid}/pathProgress`), [uid], !!uid);
  return useMemo(() => ({ ...s, byPath: Object.fromEntries(s.docs.map((r) => [r.id, r])) }), [s]);
};
export const usePathProgressDoc = (uid, pathId) => useDocState(uid && pathId ? `learnerProgress/${uid}/pathProgress/${pathId}` : null, !!(uid && pathId));
/* First time the learner's path is fully complete, note the date on their own
   bookkeeping doc — so a later change to the path (a step removed or added)
   can say "you completed this on …" instead of erasing that history. Shown to
   the learner only; leaders see live progress. */
export const recordPathCompleted = (uid, pathId, hasDoc) =>
  setDoc(doc(db, `learnerProgress/${uid}/pathProgress/${pathId}`),
    { uid, pathId, completedAt: serverTimestamp(), updatedAt: serverTimestamp(), ...(hasDoc ? {} : { startedAt: serverTimestamp() }) }, { merge: true });
export const recordPathView = (uid, pathId, lastItemKey, hasDoc) =>
  setDoc(doc(db, `learnerProgress/${uid}/pathProgress/${pathId}`),
    { uid, pathId, lastViewedAt: serverTimestamp(), updatedAt: serverTimestamp(), ...(lastItemKey ? { lastItemKey } : {}), ...(hasDoc ? {} : { startedAt: serverTimestamp() }) }, { merge: true });
/* Leader views (admin / lead): collection-group reads, chunked for `in` (≤ 30). */
export const useLeaderGuideReviews = (guideId, enabled) =>
  useQueryDocs(() => query(collectionGroup(db, "guideReviews"), where("guideId", "==", guideId)), [guideId, enabled], !!guideId && enabled);
export const useLeaderPathProgress = (pathId, enabled) =>
  useQueryDocs(() => query(collectionGroup(db, "pathProgress"), where("pathId", "==", pathId)), [pathId, enabled], !!pathId && enabled);
function useGroupIn(group, field, ids, enabled) {
  const key = ids.join("|");
  const chunks = useMemo(() => { const list = key ? key.split("|") : []; const out = []; for (let i = 0; i < list.length; i += 30) out.push(list.slice(i, i + 30)); return out; }, [key]);
  const [state, setState] = useState({ docs: [], loaded: false, error: null });
  useEffect(() => {
    if (!enabled || !chunks.length) { setState({ docs: [], loaded: true, error: null }); return; }
    setState({ docs: [], loaded: false, error: null });
    const parts = chunks.map(() => []);
    const done = new Set();
    const publish = (error = null) => setState({ docs: parts.flat(), loaded: done.size === chunks.length, error });
    const unsubs = chunks.map((part, i) => onSnapshot(query(collectionGroup(db, group), where(field, "in", part)),
      (snap) => { parts[i] = snap.docs.map((d) => ({ id: d.id, ref: d.ref.path, ...d.data() })); done.add(i); publish(); },
      (err) => { done.add(i); publish(err); }));
    return () => unsubs.forEach((u) => u());
  }, [group, field, chunks, enabled]);
  return state;
}
export const useLeaderCourseProgressIn = (courseIds, enabled) => useGroupIn("courseProgress", "courseId", courseIds, enabled);
export const useLeaderGuideReviewsIn = (guideIds, enabled) => useGroupIn("guideReviews", "guideId", guideIds, enabled);

/* Every progress write is a merge that re-asserts uid/courseId/updatedAt (the
   rules require them on the merged doc) and never mentions `earned`. */
async function writeProgress(uid, courseId, patch, { create = false } = {}) {
  const base = { uid, courseId, updatedAt: serverTimestamp() };
  if (create) base.startedAt = serverTimestamp();
  await setDoc(doc(db, progressPath(uid, courseId)), { ...base, ...patch }, { merge: true });
}
export const recordLessonView = (uid, courseId, lessonId, hasProgress) =>
  writeProgress(uid, courseId, {
    lastLessonId: lessonId, lastViewedAt: serverTimestamp(),
    lessons: { [lessonId]: { viewedAt: serverTimestamp() } },
  }, { create: !hasProgress });
export const startCourse = (uid, courseId, hasProgress) =>
  writeProgress(uid, courseId, { lastViewedAt: serverTimestamp() }, { create: !hasProgress });
export const savePlayback = (uid, courseId, lessonId, { positionSec, durationSec }) =>
  writeProgress(uid, courseId, { lessons: { [lessonId]: { positionSec: Math.floor(positionSec), durationSec: Math.floor(durationSec || 0) } } });
export const markVideoWatched = (uid, courseId, lessonId) =>
  writeProgress(uid, courseId, { lessons: { [lessonId]: { videoWatched: true, videoWatchedAt: serverTimestamp() } } });
export const setManualDone = (uid, courseId, lessonId, done) =>
  writeProgress(uid, courseId, { lessons: { [lessonId]: done
    ? { manualDone: true, manualDoneAt: serverTimestamp() }
    : { manualDone: false, manualDoneAt: deleteField() } } });

/* Quiz: graded by the submitQuizAttempt callable (server-side). */
export const submitQuiz = (courseId, lessonId, answers) =>
  callFunction("submitQuizAttempt", { courseId, lessonId, answers }).then((r) => r.data);

/* ---- discussion ----------------------------------------------------------- */
/* A discussion lives under a lesson ({courseId, lessonId}) or a guide ({guideId}). */
export const commentsPath = (scope) =>
  scope.guideId ? `guides/${scope.guideId}/comments` : `courses/${scope.courseId}/lessons/${scope.lessonId}/comments`;
const scopeKey = (scope) => commentsPath(scope);
export const useComments = (scope, enabled = true) =>
  useQueryDocs(() => collection(db, commentsPath(scope)), [scopeKey(scope), enabled], !!(scope.guideId || (scope.courseId && scope.lessonId)) && enabled);
export function commentRoleFor(me) {
  if (me?.role === "admin") return "admin";
  if (me?.academyEditor === true) return "moderator";
  return "learner";
}
export const addComment = (scope, me, ownerDoc, txt, parentId = null) =>
  addDoc(collection(db, commentsPath(scope)), {
    uid: me.id, name: me.name || "", role: commentRoleFor(me), txt: txt.trim(),
    parentId: parentId || null, pinned: false, createdAt: serverTimestamp(),
  });
export const editComment = (scope, id, txt) =>
  updateDoc(doc(db, commentsPath(scope), id), { txt: txt.trim(), editedAt: serverTimestamp() });
export const pinComment = (scope, id, pinned, txt) =>
  updateDoc(doc(db, commentsPath(scope), id), { pinned: !!pinned, txt, editedAt: serverTimestamp() });
export const deleteComment = (scope, id) => deleteDoc(doc(db, commentsPath(scope), id));

/* ---- course management ---------------------------------------------------- */
const topicIdsOf = (d) => [...new Set((d.topicIds || []).map(String))].slice(0, 12);
/* Resource link: url + display label; `custom` marks a label the author typed
   (later metadata refreshes never overwrite it); source/fileType describe it. */
export const shapeResource = (r) => ({
  label: String(r.label || "").slice(0, 120), url: String(r.url).slice(0, 2000),
  ...(r.source ? { source: String(r.source).slice(0, 80) } : {}), ...(r.fileType ? { fileType: String(r.fileType).slice(0, 20) } : {}),
  ...(r.custom ? { custom: true } : {}), ...(r.restricted ? { restricted: true } : {}),
});
const https = (u, n) => (/^https:\/\//.test(u || "") ? String(u).slice(0, n) : "");
export const shapeVideoMeta = (m) => !m ? null : {
  ...(m.id ? { id: String(m.id).slice(0, 100) } : {}),
  title: String(m.title || "").slice(0, 200), author: String(m.author || "").slice(0, 120),
  authorUrl: https(m.authorUrl, 300), thumbnailUrl: https(m.thumbnailUrl, 500),
  sourceUrl: String(m.sourceUrl || "").slice(0, 300), fetchedAt: Number(m.fetchedAt) || Date.now(),
  ...(Number(m.durationSec) > 0 && !m.isLive ? { durationSec: Math.round(Number(m.durationSec)) } : {}),
  ...(m.isLive ? { isLive: true } : {}),
};
export const courseShape = (d) => ({
  title: String(d.title || "").trim().slice(0, 120),
  category: normalizeCategory(d.category), level: d.level, topics: normalizeTopics(d.topics), topicIds: topicIdsOf(d),
  about: String(d.about || "").slice(0, 20000),
  outcomes: (d.outcomes || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20),
  requirements: (d.requirements || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20),
  modules: (d.modules || []).slice(0, 50).map((m) => ({ id: m.id || newId(), title: String(m.title || "").slice(0, 120), lessonIds: (m.lessonIds || []).slice(0, 200) })),
  cover: d.cover || null,
  previewVideo: d.previewVideo ? videoRecord(d.previewVideo.ok ? d.previewVideo : { ok: true, ...d.previewVideo }) : null,
  // Markdown format of `about` (absent = 1, legacy). Never written for legacy text.
  ...(d.mdVersion === 2 ? { mdVersion: 2 } : {}),
});

export async function createCourse(me, data) {
  const ref = doc(collection(db, "courses"));
  await setDoc(ref, {
    ...courseShape(data), status: "draft",
    lessonCount: 0, requiredLessonCount: 0, requiredQuizLessonIds: [], bonusLessonIds: [], durationMinutes: 0,
    createdAt: serverTimestamp(), createdBy: me.id, updatedAt: serverTimestamp(), updatedBy: me.id,
  });
  return ref.id;
}
/* Save course fields and refresh the denormalised counters from the current
   lessons (passed in by the editor, which already listens to them). */
export async function updateCourse(me, courseId, data, lessons) {
  const patch = { ...courseShape(data), updatedAt: serverTimestamp(), updatedBy: me.id };
  if (lessons) Object.assign(patch, courseCounters({ ...data, modules: patch.modules }, lessons));
  await updateDoc(doc(db, "courses", courseId), patch);
}
/* Reorder save: writes only `modules` (+ counters/stamps), so a failed save can
   never lose unrelated edits and the editor keeps its previous order on error. */
export async function saveCourseOrder(me, courseId, course, modules, lessons) {
  const patch = { modules: modules.map((m) => ({ id: m.id || newId(), title: String(m.title || "").slice(0, 120), lessonIds: (m.lessonIds || []).slice(0, 200) })), updatedAt: serverTimestamp(), updatedBy: me.id };
  Object.assign(patch, courseCounters({ ...course, modules: patch.modules }, lessons));
  await updateDoc(doc(db, "courses", courseId), patch);
}
export async function setContentStatus(coll, me, id, status) {
  const patch = { status, updatedAt: serverTimestamp(), updatedBy: me.id };
  if (status === "published") patch.publishedAt = serverTimestamp();
  if (status === "archived") patch.archivedAt = serverTimestamp();
  await updateDoc(doc(db, coll, id), patch);
}
export const setCourseStatus = (me, courseId, status) => setContentStatus("courses", me, courseId, status);

/* ---- quick guides ---------------------------------------------------------- */
const guideShape = (d) => ({
  title: String(d.title || "").trim().slice(0, 120),
  category: normalizeCategory(d.category), topics: normalizeTopics(d.topics), topicIds: topicIdsOf(d),
  video: d.video ? videoRecord(d.video.ok ? d.video : { ok: true, ...d.video }) : null,
  thumbMode: d.thumbMode === "custom" && d.thumb ? "custom" : "source",
  videoMeta: d.video ? shapeVideoMeta(d.videoMeta) : null,
  body: String(d.body || "").slice(0, 20000),
  resources: (d.resources || []).filter((r) => r && r.url).slice(0, 20).map(shapeResource),
  thumb: d.thumb || null,
  durationMinutes: Math.max(0, Math.round(Number(d.durationMinutes) || 0)),
  ...(d.mdVersion === 2 ? { mdVersion: 2 } : {}),   // format of `description` (absent = 1, legacy)
});
export async function createGuide(me, data) {
  const ref = doc(collection(db, "guides"));
  await setDoc(ref, { ...guideShape(data), status: "draft", createdAt: serverTimestamp(), createdBy: me.id, updatedAt: serverTimestamp(), updatedBy: me.id });
  return ref.id;
}
export const updateGuide = (me, id, data) => updateDoc(doc(db, "guides", id), { ...guideShape(data), updatedAt: serverTimestamp(), updatedBy: me.id });
export async function deleteGuideHard(id) {
  const g = await getDoc(doc(db, "guides", id));
  const paths = g.exists() && g.data().thumb?.path ? [g.data().thumb.path] : [];
  const cs = await getDocs(collection(db, `guides/${id}/comments`));
  const b = writeBatch(db);
  cs.docs.forEach((c) => b.delete(c.ref));
  b.delete(doc(db, "guides", id));
  await b.commit();
  const failed = [];
  for (const p of paths) { try { await deleteImage(p); } catch { failed.push(p); } }
  return failed;
}

/* ---- learning paths -------------------------------------------------------- */
const pathItemShape = (it) => {
  const base = { id: it.id || newId(), type: it.type, required: it.required !== false, label: String(it.label || "").slice(0, 120) };
  if (it.type === "course") return { ...base, courseId: String(it.courseId || "") };
  if (it.type === "lesson") return { ...base, courseId: String(it.courseId || ""), lessonId: String(it.lessonId || "") };
  return { ...base, type: "guide", guideId: String(it.guideId || "") };
};
const pathShape = (d) => ({
  title: String(d.title || "").trim().slice(0, 120),
  purpose: String(d.purpose || "").slice(0, 4000),
  category: d.category ? normalizeCategory(d.category) : "", topics: normalizeTopics(d.topics), topicIds: topicIdsOf(d),
  cover: d.cover || null,
  items: (d.items || []).slice(0, 60).map(pathItemShape),
});
export async function createPath(me, data) {
  const ref = doc(collection(db, "paths"));
  await setDoc(ref, { ...pathShape(data), status: "draft", createdAt: serverTimestamp(), createdBy: me.id, updatedAt: serverTimestamp(), updatedBy: me.id });
  return ref.id;
}
export const updatePath = (me, id, data) => updateDoc(doc(db, "paths", id), { ...pathShape(data), updatedAt: serverTimestamp(), updatedBy: me.id });
export async function deletePathHard(id) {
  const p = await getDoc(doc(db, "paths", id));
  const paths = p.exists() && p.data().cover?.path ? [p.data().cover.path] : [];
  await deleteDoc(doc(db, "paths", id));
  const failed = [];
  for (const x of paths) { try { await deleteImage(x); } catch { failed.push(x); } }
  return failed;
}
/* Permanent delete (admin, unpublished only). Removes lessons, their comments,
   quiz keys, then the course, then the Storage objects — references are gone
   before any object is, so a half-failed delete never leaves a doc pointing at
   a missing image. Returns the list of object paths that could not be removed. */
/* Permanent course delete — see src/academyDeletion.js for the sequence and
   why learning paths are reported, not edited. `pending` (from
   academySettings/pendingCleanup) lets an admin retry an unfinished cleanup. */
const PENDING_DOC = "academySettings/pendingCleanup";
export const usePendingCleanup = (enabled) => useDocState(enabled ? PENDING_DOC : null, !!enabled);
async function batchDelete(refs) {
  for (let i = 0; i < refs.length; i += 400) { const b = writeBatch(db); refs.slice(i, i + 400).forEach((r) => b.delete(r)); await b.commit(); }
}
export async function pathsUsingCourse(courseId) {
  const ps = await getDocs(collection(db, "paths"));
  return pathsReferencingCourse(ps.docs.map((d) => ({ id: d.id, ...d.data() })), courseId);
}
export function deleteCourseHard(me, courseId, pending = null) {
  return runCourseDeletion({
    plan: async (id) => {
      const course = await getDoc(doc(db, "courses", id));
      const images = []; const contentRefs = [];
      if (course.exists() && course.data().cover?.path) images.push(course.data().cover.path);
      const lessons = await getDocs(collection(db, `courses/${id}/lessons`));
      for (const l of lessons.docs) {
        if (l.data().thumb?.path) images.push(l.data().thumb.path);
        const cs = await getDocs(collection(db, `courses/${id}/lessons/${l.id}/comments`));
        cs.docs.forEach((c) => contentRefs.push(c.ref));
        contentRefs.push(doc(db, `courses/${id}/quizKeys/${l.id}`));
        contentRefs.push(l.ref);
      }
      if (course.exists()) contentRefs.push(doc(db, "courses", id));     // course doc goes LAST
      // The private working copy goes too (its lessons + head in ONE batch —
      // rules only allow draft-lesson deletes alongside the head's deletion).
      const draft = await getDoc(doc(db, "courseDrafts", id));
      const draftLessons = draft.exists() ? await getDocs(collection(db, `courseDrafts/${id}/lessons`)) : { docs: [] };
      if (draft.exists()) {
        for (const p of imagePathsOf(draft.data(), Object.fromEntries(draftLessons.docs.map((d) => [d.id, d.data()])))) if (!images.includes(p)) images.push(p);
        contentRefs.unshift({ draftBatch: [...draftLessons.docs.map((d) => d.ref), draft.ref] });
      }
      let pathsAffected = [];
      try { pathsAffected = await pathsUsingCourse(id); } catch {}
      return { exists: course.exists() || draft.exists(), title: course.exists() ? course.data().title : draft.exists() ? draft.data().title : "", contentRefs, images, pathsAffected };
    },
    markPending: (id, entry) => setDoc(doc(db, PENDING_DOC), { courses: { [id]: { title: String(entry.title).slice(0, 120), images: entry.images.slice(0, 200), at: Date.now() } }, updatedAt: serverTimestamp(), updatedBy: me.id }, { merge: true }),
    deleteContent: async (refs) => {
      for (const r of refs) if (r && r.draftBatch) { const b = writeBatch(db); r.draftBatch.forEach((x) => b.delete(x)); await b.commit(); }
      await batchDelete(refs.filter((r) => !(r && r.draftBatch)));
    },
    deleteProgress: async (id) => { const s = await getDocs(query(collectionGroup(db, "courseProgress"), where("courseId", "==", id))); await batchDelete(s.docs.map((d) => d.ref)); return s.docs.length; },
    deleteAttempts: async (id) => { const s = await getDocs(query(collectionGroup(db, "attempts"), where("courseId", "==", id))); await batchDelete(s.docs.map((d) => d.ref)); return s.docs.length; },
    deleteImage,
    referencedElsewhere: imagesReferencedElsewhere,
    isNotFound: (e) => e && e.code === "storage/object-not-found",
    clearPending: (id) => updateDoc(doc(db, PENDING_DOC), new FieldPath("courses", id), deleteField(), "updatedAt", serverTimestamp(), "updatedBy", me.id),
  }, courseId, pending);
}

export const lessonShape = (d) => ({
  title: String(d.title || "").trim().slice(0, 120),
  moduleId: d.moduleId || "",
  kind: ["video", "written", "exercise", "resource"].includes(d.kind) ? d.kind : (d.video ? "video" : "written"),
  video: d.video ? videoRecord(d.video.ok ? d.video : { ok: true, ...d.video }) : null,
  description: String(d.description || "").slice(0, 20000),
  resources: (d.resources || []).filter((r) => r && r.url).slice(0, 20).map(shapeResource),
  thumb: d.thumb || null,
  thumbMode: d.thumbMode === "custom" && d.thumb ? "custom" : "source",
  videoMeta: d.video ? shapeVideoMeta(d.videoMeta) : null,
  bonus: d.bonus === true,
  durationMinutes: Math.max(0, Math.round(Number(d.durationMinutes) || 0)),
  quiz: {
    mode: d.quiz?.mode || "none",
    passMark: Math.min(100, Math.max(1, Math.round(Number(d.quiz?.passMark) || 70))),
    retryLimit: Math.max(0, Math.round(Number(d.quiz?.retryLimit) || 0)),
    questions: (d.quiz?.questions || []).slice(0, 30).map((q) => ({
      id: q.id || newId(), prompt: String(q.prompt || "").slice(0, 1000), multi: q.multi === true,
      options: (q.options || []).slice(0, 8).map((o) => ({ id: o.id || newId(), text: String(o.text || "").slice(0, 300) })),
    })),
  },
});
/* Save a lesson. The learner-readable doc gets the questions; the correct
   option ids + explanations go to quizKeys in the same batch, so the two can
   never drift. `key` = { answers: {qId: [optId]}, explanations: {qId: text} }. */
export async function saveLesson(courseId, lessonId, data, key) {
  const id = lessonId || doc(collection(db, `courses/${courseId}/lessons`)).id;
  const b = writeBatch(db);
  const ref = doc(db, `courses/${courseId}/lessons/${id}`);
  const shaped = { ...lessonShape(data), updatedAt: serverTimestamp() };
  if (!lessonId) { shaped.createdAt = serverTimestamp(); shaped.createdAtMs = Date.now(); }
  b.set(ref, shaped, { merge: !!lessonId });
  if (shaped.quiz.mode !== "none") {
    const answers = {}, explanations = {};
    for (const q of shaped.quiz.questions) {
      answers[q.id] = ((key?.answers || {})[q.id] || []).filter((o) => q.options.some((op) => op.id === o));
      const ex = (key?.explanations || {})[q.id];
      if (ex) explanations[q.id] = String(ex).slice(0, 2000);
    }
    b.set(doc(db, `courses/${courseId}/quizKeys/${id}`), { answers, explanations, updatedAt: serverTimestamp() });
  }
  await b.commit();
  return id;
}
export async function getQuizKey(courseId, lessonId) {
  const s = await getDoc(doc(db, `courses/${courseId}/quizKeys/${lessonId}`));
  return s.exists() ? s.data() : { answers: {}, explanations: {} };
}
export async function deleteLesson(courseId, lessonId) {
  const b = writeBatch(db);
  const cs = await getDocs(collection(db, `courses/${courseId}/lessons/${lessonId}/comments`));
  cs.docs.forEach((c) => b.delete(c.ref));
  b.delete(doc(db, `courses/${courseId}/quizKeys/${lessonId}`));
  b.delete(doc(db, `courses/${courseId}/lessons/${lessonId}`));
  await b.commit();
}
export async function savePurposeVideo(me, data) {
  await setDoc(doc(db, `academySettings/${PURPOSE_DOC}`), {
    title: String(data.title || "").slice(0, 120), intro: String(data.intro || "").slice(0, 4000),
    video: data.video ? videoRecord(data.video.ok ? data.video : { ok: true, ...data.video }) : null,
    thumb: data.thumb || null, updatedAt: serverTimestamp(), updatedBy: me.id,
  });
}

/* ---- Storage -------------------------------------------------------------- */
/* Uploads fail FAST instead of hanging: the Storage SDK otherwise keeps
   retrying for minutes while offline. Offline at the start, going offline
   mid-upload, or no completion within `timeoutMs` → cancelled + a clear
   error (code "offline" / "timeout"), so the author can simply try again. */
export async function uploadImage(path, blob, contentType, { timeoutMs = 60000 } = {}) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw Object.assign(new Error("offline"), { code: "offline" });
  const [{ ref, uploadBytesResumable }, st] = await Promise.all([import("firebase/storage"), getStorageInstance()]);
  const task = uploadBytesResumable(ref(st, path), blob, { contentType, cacheControl: "private, max-age=3600" });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); window.removeEventListener("offline", onOffline); fn(); };
    const abort = (code) => finish(() => { try { task.cancel(); } catch {} reject(Object.assign(new Error(code), { code })); });
    const onOffline = () => abort("offline");
    const timer = setTimeout(() => abort("timeout"), timeoutMs);
    window.addEventListener("offline", onOffline);
    task.then((snap) => finish(() => resolve({ path, bytes: snap.metadata.size, contentType })), (e) => finish(() => reject(e)));
  });
}
/* Which of `paths` are still used by anything OTHER than course `courseId`:
   another course or course draft (cover), any live or draft lesson (thumb),
   a quick guide (thumb), a learning path or category (cover). Folder
   ownership alone isn't enough — data copied between courses can point at
   another course's file. If a check can't complete, the path counts as still
   used (an image is only deleted when it's provably unreferenced). */
export async function imagesReferencedElsewhere(paths, courseId) {
  const keep = new Set();
  const notThisCourse = (d) => {
    // lesson docs live at courses/{cid}/lessons/{lid} or courseDrafts/{cid}/lessons/{lid}
    const owner = d.ref.parent?.parent;
    return owner ? owner.id !== courseId : d.id !== courseId;
  };
  for (const p of [...new Set(paths)].filter(Boolean)) {
    try {
      const qs = await Promise.all([
        getDocs(query(collection(db, "courses"), where("cover.path", "==", p))),
        getDocs(query(collection(db, "courseDrafts"), where("cover.path", "==", p))),
        getDocs(query(collectionGroup(db, "lessons"), where("thumb.path", "==", p))),
        getDocs(query(collection(db, "guides"), where("thumb.path", "==", p))),
        getDocs(query(collection(db, "paths"), where("cover.path", "==", p))),
        getDocs(query(collection(db, "academyCategories"), where("cover.path", "==", p))),
      ]);
      const [courses, drafts, lessons, guides, pathsQ, cats] = qs;
      if ([...courses.docs, ...drafts.docs].some((d) => d.id !== courseId) || lessons.docs.some(notThisCourse)
        || guides.size || pathsQ.size || cats.size) keep.add(p);
    } catch { keep.add(p); }
  }
  return keep;
}
/* The images a course may delete now: in its own folders AND unreferenced elsewhere. */
async function safeToDeleteFor(courseId, paths) {
  const own = [...new Set(paths)].filter((p) => ownedByCourse(p, courseId));
  if (!own.length) return [];
  const keep = await imagesReferencedElsewhere(own, courseId);
  return own.filter((p) => !keep.has(p));
}

export async function deleteImage(path) {
  const [{ ref, deleteObject }, st] = await Promise.all([import("firebase/storage"), getStorageInstance()]);
  await deleteObject(ref(st, path));
}
/* Object-URL cache: one fetch per object path per session. A failed fetch is
   not cached, so a transient error retries on the next render. */
const _urlCache = new Map();
const _inflight = new Map();
export async function imageObjectUrl(path) {
  if (_urlCache.has(path)) return _urlCache.get(path);
  if (_inflight.has(path)) return _inflight.get(path);
  const p = (async () => {
    const [{ ref, getBlob }, st] = await Promise.all([import("firebase/storage"), getStorageInstance()]);
    const blob = await getBlob(ref(st, path));
    const url = URL.createObjectURL(blob);
    _urlCache.set(path, url);
    return url;
  })().finally(() => _inflight.delete(path));
  _inflight.set(path, p);
  return p;
}
export function useImageUrl(imageRef) {
  const path = imageRef?.path || null;
  const [state, setState] = useState(() => ({ path, url: path ? _urlCache.get(path) || null : null, error: false }));
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!path) { setState({ path, url: null, error: false }); return; }
    const cached = _urlCache.get(path);
    if (cached) { setState({ path, url: cached, error: false }); return; }
    setState({ path, url: null, error: false });
    imageObjectUrl(path).then(
      (url) => { if (alive.current) setState({ path, url, error: false }); },
      () => { if (alive.current) setState({ path, url: null, error: true }); });
  }, [path]);
  return state.path === path ? state : { path, url: null, error: false };
}
export const _resetImageCacheForTests = () => { _urlCache.clear(); _inflight.clear(); };


/* =====================================================================
   Course DRAFTS (v6) — see src/academyDrafts.js for the model.
   ===================================================================== */
const draftRef = (cid) => doc(db, "courseDrafts", cid);
export const newCourseId = () => doc(collection(db, "courses")).id;
export const newLessonId = () => doc(collection(db, "courses")).id;
export function useCourseDrafts(me) {
  return useQueryDocs(() => collection(db, "courseDrafts"), [me?.id, isAcademyEditor(me)], !!me?.id && isAcademyEditor(me));
}
export const useDraftHead = (cid, enabled = true) => useDocState(cid ? `courseDrafts/${cid}` : null, !!cid && enabled);
export const useDraftLessons = (cid, enabled = true) => useQueryDocs(() => collection(db, `courseDrafts/${cid}/lessons`), [cid, enabled], !!cid && enabled);

const shapeDraftCourse = (c) => ({
  ...courseShape(c), title: String(c.title || "").slice(0, 120), category: c.category ? normalizeCategory(c.category) : "",
  level: ["beginner", "intermediate", "advanced"].includes(c.level) ? c.level : "beginner",
  previewVideo: c.previewVideo ? videoRecord(c.previewVideo.ok ? c.previewVideo : { ok: true, ...c.previewVideo }) : null,
});
const shapeDraftLesson = (l) => {
  const base = lessonShape(l);
  return { ...base, title: String(l.title || "").slice(0, 120), quizKey: { answers: l.quizKey?.answers || {}, explanations: l.quizKey?.explanations || {} }, createdAtMs: Number(l.createdAtMs) || Date.now() };
};

/* Everything the course workspace needs. Opening writes NOTHING: a course
   with no draft is edited from a copy of the live docs, persisted on the
   first change. */
export async function loadCourseWorkspace(cid) {
  const [dSnap, lSnap] = await Promise.all([getDoc(draftRef(cid)), getDoc(doc(db, "courses", cid))]);
  const liveCourse = lSnap.exists() ? { id: cid, ...lSnap.data() } : null;
  const liveLessons = liveCourse ? (await getDocs(collection(db, `courses/${cid}/lessons`))).docs.map((d) => ({ id: d.id, ...d.data() })) : [];
  if (dSnap.exists()) {
    const dl = await getDocs(collection(db, `courseDrafts/${cid}/lessons`));
    const head = dSnap.data();
    const lessons = Object.fromEntries(dl.docs.map((d) => [d.id, d.data()]));
    return { draftExists: true, head: { rev: head.rev, publishedRev: head.publishedRev }, course: normalizeOutline(head, lessons), lessons, liveCourse, liveLessons };
  }
  if (liveCourse) {
    const keys = {};
    await Promise.all(liveLessons.filter((l) => quizMode(l) !== "none").map(async (l) => { const k = await getDoc(doc(db, `courses/${cid}/quizKeys/${l.id}`)); if (k.exists()) keys[l.id] = k.data(); }));
    const { course, lessons } = draftFromLive(liveCourse, liveLessons, keys);
    return { draftExists: false, head: { rev: 0, publishedRev: 0 }, course, lessons, liveCourse, liveLessons };
  }
  return { draftExists: false, head: { rev: 0, publishedRev: 0 }, course: null, lessons: {}, liveCourse: null, liveLessons: [] };
}

/* One draft save: everything dirty in ONE transaction that first checks the
   draft's rev is still the one this editor loaded (else → conflict). Returns
   the new rev. `writeAll` persists every lesson (first save of a draft). */
export async function saveCourseDraft(me, cid, { course, lessons, dirtyLessonIds = [], deletedLessonIds = [], baseRev, writeAll = false }) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(draftRef(cid));
    const cur = snap.exists() ? Number(snap.data().rev || 0) : 0;
    if (cur !== baseRev) throw Object.assign(new Error("This course was changed somewhere else (another editor or tab)."), { code: "conflict", remoteRev: cur });
    const rev = cur + 1;
    const data = { ...shapeDraftCourse(course), rev, publishedRev: snap.exists() ? Number(snap.data().publishedRev || 0) : 0, updatedAt: serverTimestamp(), updatedBy: me.id };
    if (snap.exists()) tx.update(draftRef(cid), data);
    else tx.set(draftRef(cid), { ...data, createdAt: serverTimestamp(), createdBy: me.id });
    const ids = writeAll || !snap.exists() ? Object.keys(lessons) : dirtyLessonIds;
    for (const id of ids) if (lessons[id]) tx.set(doc(db, `courseDrafts/${cid}/lessons/${id}`), { ...shapeDraftLesson(lessons[id]), updatedAt: serverTimestamp() });
    for (const id of deletedLessonIds) tx.delete(doc(db, `courseDrafts/${cid}/lessons/${id}`));
    return rev;
  });
}
/* After a successful save: replaced/removed uploads that nothing references any
   more. References are re-read from the SERVER at clean-up time — the stored
   draft and the published course — plus the editor's in-memory draft, so a
   publish from another tab (or a stale cache) can never cause an image the
   learners still see to be deleted. */
export async function cleanupDraftImages(cid, candidates, { course, lessons }) {
  if (!cid || !candidates || !candidates.length) return [];
  const ws = await loadCourseWorkspace(cid);                 // throws → nothing is deleted
  const draftPaths = new Set([...imagePathsOf(course, lessons), ...(ws.draftExists ? imagePathsOf(ws.course, ws.lessons) : [])]);
  const livePaths = imagePathsOf(ws.liveCourse, Object.fromEntries((ws.liveLessons || []).map((l) => [l.id, l])));
  const paths = await safeToDeleteFor(cid, deletableAfterDraftSave(candidates, { draftPaths, livePaths }, cid));
  const failed = [];
  for (const p of paths) { try { await deleteImage(p); } catch (e) { if (e?.code !== "storage/object-not-found") failed.push(p); } }
  return failed;
}

/* Publish: draft → live in one transaction (same lesson ids). Throws
   { code: "conflict" } when the draft moved on since `expectedRev`, and
   { code: "blocked", blockers } when it isn't ready. Clean-up of discussions
   of removed lessons and of no-longer-referenced images runs after commit. */
export async function publishCourseDraft(me, cid, expectedRev) {
  const dSnap = await getDoc(draftRef(cid));
  if (!dSnap.exists()) throw Object.assign(new Error("There are no draft changes to publish."), { code: "no-draft" });
  const draftCourse = dSnap.data();
  const draftLessons = Object.fromEntries((await getDocs(collection(db, `courseDrafts/${cid}/lessons`))).docs.map((d) => [d.id, d.data()]));
  const liveSnap = await getDoc(doc(db, "courses", cid));
  const liveCourse = liveSnap.exists() ? liveSnap.data() : null;
  const liveLessons = liveCourse ? (await getDocs(collection(db, `courses/${cid}/lessons`))).docs.map((d) => ({ id: d.id, ...d.data() })) : [];
  const catId = normalizeCategory(draftCourse.category || "");
  const catExists = !!catId && (await getDoc(doc(db, "academyCategories", catId))).exists();
  const blockers = publishBlockers(draftCourse, flatLessons(draftCourse, Object.entries(draftLessons).map(([id, l]) => ({ id, ...l }))), catExists ? [catId] : []);
  if (blockers.length) throw Object.assign(new Error(blockers[0]), { code: "blocked", blockers });
  const plan = buildPublishPlan({ draftCourse, draftLessons, liveCourse, liveLessons, courseId: cid });
  if (2 + plan.upserts.length * 2 + plan.removes.length * 2 > 480) throw Object.assign(new Error("This course has too many lessons to publish in one step."), { code: "too-large" });
  const newRev = await runTransaction(db, async (tx) => {
    const cur = await tx.get(draftRef(cid));
    if (!cur.exists() || Number(cur.data().rev) !== expectedRev) throw Object.assign(new Error("This course was changed somewhere else since you last saved. Reload to review the latest version, then publish."), { code: "conflict" });
    const liveRef = doc(db, "courses", cid);
    const curLive = await tx.get(liveRef);
    const now = serverTimestamp();
    const shaped = { ...courseShape(plan.course), lessonCount: plan.course.lessonCount, requiredLessonCount: plan.course.requiredLessonCount,
      requiredQuizLessonIds: plan.course.requiredQuizLessonIds, bonusLessonIds: plan.course.bonusLessonIds, durationMinutes: plan.course.durationMinutes,
      status: "published", updatedAt: now, updatedBy: me.id };
    if (curLive.exists()) tx.update(liveRef, { ...shaped, ...(curLive.data().publishedAt ? {} : { publishedAt: now }) });
    else tx.set(liveRef, { ...shaped, createdAt: now, createdBy: me.id, publishedAt: now });
    for (const u of plan.upserts) {
      tx.set(doc(db, `courses/${cid}/lessons/${u.id}`), { ...lessonShape(u.live), createdAtMs: Number(u.live.createdAtMs) || Date.now(), updatedAt: now });
      const keyRef = doc(db, `courses/${cid}/quizKeys/${u.id}`);
      if (u.key) tx.set(keyRef, { ...u.key, updatedAt: now });
      else if (curLive.exists()) tx.delete(keyRef);
    }
    for (const id of plan.removes) { tx.delete(doc(db, `courses/${cid}/lessons/${id}`)); tx.delete(doc(db, `courses/${cid}/quizKeys/${id}`)); }
    const rev = Number(cur.data().rev) + 1;
    tx.update(draftRef(cid), { rev, publishedRev: rev, updatedAt: now, updatedBy: me.id });
    return rev;
  });
  // After commit (best effort; nothing learner-visible depends on these).
  const leftovers = [];
  for (const id of plan.removes) {
    try { const cs = await getDocs(collection(db, `courses/${cid}/lessons/${id}/comments`)); await batchDelete(cs.docs.map((d) => d.ref)); } catch { leftovers.push(`comments:${id}`); }
  }
  const draftPaths = imagePathsOf(draftCourse, draftLessons);
  const deletable = await safeToDeleteFor(cid, plan.imagesToDelete.filter((p) => !draftPaths.has(p)));
  for (const p of deletable) { try { await deleteImage(p); } catch (e) { if (e?.code !== "storage/object-not-found") leftovers.push(p); } }
  return { rev: newRev, firstPublish: plan.firstPublish, leftovers };
}
/* Discard a never-published draft (editors) — the course was never visible. */
export async function discardNeverPublishedDraft(cid) {
  const dl = await getDocs(collection(db, `courseDrafts/${cid}/lessons`));
  const head = await getDoc(draftRef(cid));
  const images = head.exists() ? [...imagePathsOf(head.data(), Object.fromEntries(dl.docs.map((d) => [d.id, d.data()])))].filter((p) => ownedByCourse(p, cid)) : [];
  const b = writeBatch(db);
  dl.docs.forEach((d) => b.delete(d.ref));
  b.delete(draftRef(cid));
  await b.commit();
  for (const p of await safeToDeleteFor(cid, images)) { try { await deleteImage(p); } catch {} }
}
