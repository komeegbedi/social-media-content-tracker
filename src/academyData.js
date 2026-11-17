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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { acquireShared, releaseShared, sharedState, sessionGen, cachedImageUrl, storeImageUrl, retainImage, releaseImage, onAcademyClear, clearAcademySession } from "./academyCache.js";
import {
  collection, collectionGroup, doc, query, where, onSnapshot, getDoc, getDocs, getDocsFromServer,
  setDoc, updateDoc, deleteDoc, addDoc, writeBatch, serverTimestamp, deleteField, FieldPath, runTransaction,
} from "firebase/firestore";
import { db, callFunction, getStorageInstance } from "./firebase";
import { logIssue } from "./logging";
import { courseCounters, newId, toMs, normalizeCategory, normalizeTopics, nameKey, slugId, defaultCategoryRecords,
  isAcademyEditor, ACADEMY_CATEGORIES, LEGACY_CATEGORY_IDS, quizMode, publishBlockers, flatLessons, categoryIdFromName } from "./academyProgress.js";
import { videoRecord } from "./academyVideo.js";
import { runCourseDeletion, pathsReferencingCourse } from "./academyDeletion.js";
import { courseRow } from "./academyCategoryDeletion.js";
import { GUIDE_CONTENT_FIELDS, guideDraftFromLive, guidePublishIssues, guideRow } from "./academyGuides.js";
import { orderCourses } from "./academyOrder.js";
import { draftFromLive, buildPublishPlan, imagePathsOf, deletableAfterDraftSave, normalizeOutline, ownedByCourse } from "./academyDrafts.js";

const PURPOSE_DOC = "purposeVideo";

/* ---- generic listeners ---------------------------------------------------- */
/* Shared, lingering subscription (academyCache.js): `key` null = disabled. The
   first render after a revisit returns the last known state at once (no
   skeleton flash), and the live listener keeps it current. */
function useShared(key, start, initial) {
  // the session generation is part of the identity: after a sign-out / account
  // or role change, readers re-subscribe under the new session
  const g = sessionGen();
  const subscribe = useCallback((cb) => {
    if (!key) return () => {};
    const s = acquireShared(key, start, initial);
    s.listeners.add(cb);
    return () => releaseShared(key, s, cb);
  }, [key, g]); // eslint-disable-line react-hooks/exhaustive-deps
  const snap = () => (key ? sharedState(key) ?? initial : initial);
  return useSyncExternalStore(subscribe, snap, snap);
}
const Q_IDLE = { docs: [], loaded: false, error: null };
const Q_OFF = { docs: [], loaded: true, error: null };
const startQuery = (build) => (set) => onSnapshot(build(),
  (snap) => set({ docs: snap.docs.map((d) => ({ id: d.id, ...d.data() })), loaded: true, error: null }),
  (err) => {
    // the listener has stopped: clear the content it was showing (access may have
    // been revoked) and let the next reader restart it
    set({ docs: [], loaded: true, error: err }, { ended: true });
    logIssue({ kind: "error", action: "academy read failed", message: err.message, code: err.code });
  });
/* `shareKey`: a string that fully identifies the query (shared + lingering);
   without one the listener belongs to this component alone (editor/leader
   views, comments). */
function useQueryDocs(build, deps, enabled, shareKey = null) {
  const shared = useShared(shareKey && enabled ? `q:${shareKey}` : null, startQuery(build), Q_IDLE);
  const [state, setState] = useState(Q_IDLE);
  useEffect(() => {
    if (shareKey) return undefined;
    if (!enabled) { setState(Q_OFF); return undefined; }
    setState((s) => ({ ...s, loaded: false, error: null }));
    let q;
    try { q = build(); } catch (e) { setState({ docs: [], loaded: true, error: e }); return undefined; }
    return onSnapshot(q,
      (snap) => setState({ docs: snap.docs.map((d) => ({ id: d.id, ...d.data() })), loaded: true, error: null }),
      (err) => {
        setState((s) => ({ docs: s.docs, loaded: true, error: err }));
        logIssue({ kind: "error", action: "academy read failed", message: err.message, code: err.code });
      });
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  if (shareKey) return enabled ? shared : Q_OFF;
  return state;
}
/* `withPending`: also report whether a local write is still waiting for the
   server (`pending`) and keep `confirmed` = the doc as the SERVER last
   acknowledged it. The UI uses `data` for immediate feedback but `confirmed`
   for claims of success (e.g. course completion) — an unrelated pending write
   (like recording a lesson view) never makes acknowledged progress look new.
   Shared + lingering (see useShared). */
const D_IDLE = { data: undefined, loaded: false, error: null, pending: false, confirmed: undefined };
const D_OFF = { data: null, loaded: true, error: null, pending: false, confirmed: null };
function useDocState(path, enabled, withPending = false) {
  const on = !!(enabled && path);
  const st = useShared(on ? `d:${withPending ? 1 : 0}:${path}` : null, (set) => onSnapshot(doc(db, path), { includeMetadataChanges: withPending },
    (snap) => {
      const data = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      const pending = withPending && snap.metadata.hasPendingWrites;
      set((prev) => ({ data, loaded: true, error: null, pending, confirmed: pending ? (prev.confirmed === undefined ? null : prev.confirmed) : data }));
    },
    (err) => {
      // permission-denied for a draft/missing course reads as "not available".
      set({ data: null, loaded: true, error: err, pending: false, confirmed: null }, { ended: true });
      if (err.code !== "permission-denied") logIssue({ kind: "error", action: `academy doc read failed: ${path}`, message: err.message, code: err.code });
    }), D_IDLE);
  return on ? st : D_OFF;
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
export const useCategoryRecords = () => useQueryDocs(() => collection(db, "academyCategories"), [], true, "academyCategories");
export const useTopicRecords = () => {
  const s = useQueryDocs(() => collection(db, "academyTopics"), [], true, "academyTopics");
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
// ≤ 40 chars in total (the rules' limit): a 35-char slug + "-" + 4 random chars.
export const newCategoryId = (name) => categoryIdFromName(name, Math.random().toString(36).slice(2, 6));
export async function createCategoryDraft(me, id, { name, description = "", short = "", order = 0 }, currentHidden = []) {
  const b = writeBatch(db);
  b.set(doc(db, "academyCategories", id), { name: String(name || "Untitled category").trim().slice(0, 60) || "Untitled category", short: String(short || "").trim().slice(0, 30), description: String(description || "").slice(0, 300), order, hidden: true, cover: null, courseOrder: [], ...stamp(me, true) });
  b.set(doc(db, "academySettings/categoryIndex"), { hidden: [...new Set([...currentHidden, id])], updatedAt: serverTimestamp(), updatedBy: me.id });
  await b.commit();
  return id;
}
export const setCategoryCourseOrder = (me, id, courseOrder) => updateDoc(doc(db, "academyCategories", id), { courseOrder: courseOrder.slice(0, 500), ...stamp(me) });
/* Hide/restore keeps the denormalised list (consulted by rules) in the same batch. */
// Legacy ids that read as this category are hidden with it (rules compare raw ids).
const categoryIdsFor = (id) => [id, ...Object.entries(LEGACY_CATEGORY_IDS).filter(([, to]) => to === id).map(([from]) => from)];
const nextHiddenList = (cur, id, hidden) => { const ids = categoryIdsFor(id); return hidden ? [...new Set([...cur, ...ids])] : cur.filter((x) => !ids.includes(x)); };
/* Writes the category's flag + the index inside a transaction `tx`, reading the
   index FRESH (never a possibly stale client copy, so two admins toggling
   different categories can't undo each other). */
async function applyCategoryHidden(tx, me, id, hidden) {
  const idxRef = doc(db, "academySettings/categoryIndex");
  const idx = await tx.get(idxRef);
  const cur = idx.exists() ? (idx.data().hidden || []) : [];
  return (writes) => {
    writes.update(doc(db, "academyCategories", id), { hidden: !!hidden, ...stamp(me) });
    writes.set(idxRef, { hidden: nextHiddenList(cur, id, hidden), updatedAt: serverTimestamp(), updatedBy: me.id });
  };
}
export async function setCategoryHidden(me, id, hidden /* , currentHidden — read fresh now */) {
  await runTransaction(db, async (tx) => { const write = await applyCategoryHidden(tx, me, id, hidden); write(tx); });
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
/* ---- v6.10: deleting a category with its contents (admins) -----------------
   The plan is run item by item with the services below; the server locks the
   category first (re-checking against what was reviewed) and deletes the
   record last, only once nothing is filed under it (functions/
   academyCategoryDeletion.js + the rules' categoryLocked()). */
export async function categoryContents(catId) {
  const ids = categoryIdsFor(catId);
  const q = (c) => getDocs(query(collection(db, c), where("category", "in", ids)));
  const [live, drafts, guides, guideDrafts, paths, rec] = await Promise.all([q("courses"), q("courseDrafts"), q("guides"), q("guideDrafts"), q("paths"), getDoc(doc(db, "academyCategories", catId))]);
  const courseIds = [...new Set([...live.docs, ...drafts.docs].map((d) => d.id))];
  const courses = await Promise.all(courseIds.map(async (id) => {
    const [l, d] = await Promise.all([getDoc(doc(db, "courses", id)), getDoc(doc(db, "courseDrafts", id))]);
    return courseRow(id, l.exists() ? l.data() : null, d.exists() ? d.data() : null, ids);
  }));
  // the category's own order first (as learners and the workspace show it), then the rest by title
  const order = (rec.exists() && rec.data().courseOrder) || [];
  const pos = (id) => { const i = order.indexOf(id); return i < 0 ? Infinity : i; };
  courses.sort((a, b) => pos(a.id) - pos(b.id) || a.title.localeCompare(b.title));
  return {
    ids, exists: rec.exists(), lock: rec.exists() ? rec.data().deleting || null : null, cover: rec.exists() ? rec.data().cover || null : null,
    courses,
    guides: await Promise.all([...new Set([...guides.docs, ...guideDrafts.docs].map((d) => d.id))].map(async (id) => {
      const [l, d] = await Promise.all([getDoc(doc(db, "guides", id)), getDoc(guideDraftRef(id))]);
      return guideRow(id, l.exists() ? l.data() : null, d.exists() ? d.data() : null, ids);
    })).then((gs) => { const order = (rec.exists() && rec.data().guideOrder) || []; const pos = (x) => { const i = order.indexOf(x); return i < 0 ? Infinity : i; }; return gs.sort((a, b) => pos(a.id) - pos(b.id) || a.title.localeCompare(b.title)); }),
    paths: paths.docs.map((d) => ({ id: d.id, title: d.data().title || "Untitled path", status: d.data().status })),
  };
}
/* Move a course to another category, keeping everything (ids, lessons, keys,
   attempts, progress, comments, images, references). The live course moves if
   it's filed here; the draft moves if it's filed here (or `draftToo`), with a
   draft revision bump so an open editor notices. Never publishes, restores or
   un-hides anything. Already moved → nothing to do. */
export async function moveCourseCategory(me, id, fromIds, dest, { draftToo = false } = {}) {
  await runTransaction(db, async (tx) => {
    const lref = doc(db, "courses", id), dref = doc(db, "courseDrafts", id);
    const l = await tx.get(lref); const d = await tx.get(dref);
    if (l.exists() && fromIds.includes(l.data().category)) tx.update(lref, { category: dest, updatedAt: serverTimestamp(), updatedBy: me.id });
    if (d.exists() && d.data().category !== dest && (fromIds.includes(d.data().category) || draftToo))
      tx.update(dref, { category: dest, rev: Number(d.data().rev || 0) + 1, updatedAt: serverTimestamp(), updatedBy: me.id });
  });
}
/* Move a resource: its published record (if filed here) and its draft (if filed
   here, or `draftToo`), with a draft revision bump. Never publishes or restores. */
export async function moveGuideCategory(me, id, dest, { fromIds = null, draftToo = false } = {}) {
  await runTransaction(db, async (tx) => {
    const lref = doc(db, "guides", id), dref = guideDraftRef(id);
    const l = await tx.get(lref); const d = await tx.get(dref);
    const here = (c) => !fromIds || fromIds.includes(c);
    if (l.exists() && here(l.data().category) && l.data().category !== dest) tx.update(lref, { category: dest, updatedAt: serverTimestamp(), updatedBy: me.id });
    if (d.exists() && d.data().category !== dest && (here(d.data().category) || draftToo))
      tx.update(dref, { category: dest, rev: Number(d.data().rev || 0) + 1, updatedAt: serverTimestamp(), updatedBy: me.id });
  });
}
export const movePathCategory = (me, id, dest) => updateDoc(doc(db, "paths", id), { category: dest || "", ...stamp(me) });
/* Moved courses go after the destination's existing courses, in the order they
   had here. If the destination has no saved order yet, its CURRENT order (as
   shown) is saved first, so nothing already there moves. */
export async function appendCourseOrder(me, destId, movedIds) {
  const ref = doc(db, "academyCategories", destId);
  const cur = await getDoc(ref);
  if (!cur.exists()) return;
  let order = cur.data().courseOrder || [];
  if (!order.length) {
    const [live, drafts] = await Promise.all([getDocs(query(collection(db, "courses"), where("category", "==", destId))), getDocs(query(collection(db, "courseDrafts"), where("category", "==", destId)))]);
    const byId = new Map();
    for (const d of live.docs) byId.set(d.id, { id: d.id, ...d.data(), publishedAtMs: toMs(d.data().publishedAt), createdAtMs: toMs(d.data().createdAt) });
    for (const d of drafts.docs) if (!byId.has(d.id)) byId.set(d.id, { id: d.id, ...d.data(), publishedAtMs: 0, createdAtMs: toMs(d.data().createdAt) });
    order = orderCourses([...byId.values()].filter((c) => !movedIds.includes(c.id)), []).map((c) => c.id);
  }
  const next = [...order.filter((x) => !movedIds.includes(x)), ...movedIds].slice(0, 500);
  await updateDoc(ref, { courseOrder: next, ...stamp(me) });
}
export const lockCategoryForDeletion = (payload) => callFunction("lockCategoryForDeletion", payload).then((r) => r.data);
export const finalizeCategoryDeletion = (categoryId, planId) => callFunction("finalizeCategoryDeletion", { categoryId, planId }).then((r) => r.data);
export const cancelCategoryDeletion = (categoryId) => callFunction("cancelCategoryDeletion", { categoryId }).then((r) => r.data);

export async function createTopic(me, { name, description = "" }, byId = {}) {
  const key = nameKey(name);
  const dup = Object.values(byId).find((t) => nameKey(t.name) === key);
  if (dup) throw new Error(`“${dup.name}” already exists${dup.hidden ? " (hidden, so restore it instead)" : ""}.`);
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
  const learnerIds = !editor && coll !== "paths";
  // Ready to subscribe? (a learner's query needs the visible category ids first)
  const ready = !!me?.id && (!learnerIds || cats.loaded);
  const empty = learnerIds && cats.loaded && !key;
  const shareKey = ready && !empty ? `list:${coll}:${editor ? "all" : learnerIds ? key : "pub"}:${me.id}` : null;
  const st = useShared(shareKey, (set) => {
    let qs;
    if (editor) qs = [collection(db, coll)];
    else if (coll === "paths") qs = [query(collection(db, coll), where("status", "==", "published"))];
    else {
      const ids = key.split(",");
      qs = [];
      for (let i = 0; i < ids.length; i += 30) qs.push(query(collection(db, coll), where("status", "==", "published"), where("category", "in", ids.slice(i, i + 30))));
    }
    const parts = qs.map(() => null);
    const publish = (error = null) => {
      if (!parts.every(Boolean) && !error) return;
      const docs = parts.filter(Boolean).flat().sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt));
      set({ docs, loaded: true, error }, error ? { ended: true } : undefined);
    };
    const unsubs = qs.map((q, i) => onSnapshot(q,
      (snap) => { parts[i] = snap.docs.map((d) => ({ id: d.id, ...d.data(), format })); publish(); },
      (err) => { parts[i] = []; publish(err); logIssue({ kind: "error", action: `academy ${coll} read failed`, message: err.message, code: err.code }); }));
    return () => unsubs.forEach((u) => u());
  }, Q_IDLE);
  if (!me?.id || empty) return Q_OFF;
  return st;
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
  useQueryDocs(() => collection(db, `courses/${courseId}/lessons`), [courseId, enabled], !!courseId && enabled, `courses/${courseId}/lessons`);
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
export const useProgress = (uid, courseId) => useDocState(uid && courseId ? progressPath(uid, courseId) : null, !!(uid && courseId), true);
export function useAllProgress(uid) {
  const s = useQueryDocs(() => collection(db, `learnerProgress/${uid}/courseProgress`), [uid], !!uid, `learnerProgress/${uid}/courseProgress`);
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
  const s = useQueryDocs(() => collection(db, `learnerProgress/${uid}/guideReviews`), [uid], !!uid, `learnerProgress/${uid}/guideReviews`);
  return useMemo(() => ({ ...s, byGuide: Object.fromEntries(s.docs.map((r) => [r.id, r])) }), [s]);
};
export const useGuideReview = (uid, guideId) => useDocState(uid && guideId ? `learnerProgress/${uid}/guideReviews/${guideId}` : null, !!(uid && guideId));
export const setGuideReviewed = (uid, guideId, reviewed) =>
  setDoc(doc(db, `learnerProgress/${uid}/guideReviews/${guideId}`),
    { uid, guideId, reviewed: !!reviewed, reviewedAt: reviewed ? serverTimestamp() : deleteField(), updatedAt: serverTimestamp() }, { merge: true });
export const useAllPathProgress = (uid) => {
  const s = useQueryDocs(() => collection(db, `learnerProgress/${uid}/pathProgress`), [uid], !!uid, `learnerProgress/${uid}/pathProgress`);
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
/* v6.4: the learner's own writes go to `playback` (view/position) — completion
   flags in `lessons`, `earned` and `finishedAt` are server-only (see rules). */
export const recordLessonView = (uid, courseId, lessonId, hasProgress) =>
  writeProgress(uid, courseId, {
    lastLessonId: lessonId, lastViewedAt: serverTimestamp(),
    playback: { [lessonId]: { viewedAt: serverTimestamp() } },
  }, { create: !hasProgress });
export const startCourse = (uid, courseId, hasProgress) =>
  writeProgress(uid, courseId, { lastViewedAt: serverTimestamp() }, { create: !hasProgress });
export const savePlayback = (uid, courseId, lessonId, { positionSec, durationSec }) =>
  writeProgress(uid, courseId, { playback: { [lessonId]: { positionSec: Math.floor(positionSec), durationSec: Math.floor(durationSec || 0) } } });
/* Completion goes through the server, which enforces the course order
   (functions/academyCompletion.js). They resolve once the server has written. */
export const markVideoWatched = (uid, courseId, lessonId) =>
  callFunction("completeLesson", { courseId, lessonId, how: "video", done: true }).then((r) => r.data);
export const setManualDone = (uid, courseId, lessonId, done) =>
  callFunction("completeLesson", { courseId, lessonId, how: "manual", done: !!done }).then((r) => r.data);
/* Finish course: server-verified, idempotent → { already, finishedAt } */
export const finishCourse = (courseId) => callFunction("finishCourse", { courseId }).then((r) => r.data);

/* Quiz: graded by the submitQuizAttempt callable (server-side). */
/* `submissionId` identifies ONE attempt: reuse it to retry an uncertain request
   (the server returns the original result instead of using another attempt). */
export const submitQuiz = (courseId, lessonId, answers, submissionId) =>
  callFunction("submitQuizAttempt", { courseId, lessonId, answers, ...(submissionId ? { submissionId } : {}) }).then((r) => r.data);
/* Academy staff: give a learner more attempts on a limited quiz (server-checked). */
export const grantQuizAttempts = (uid, courseId, lessonId, count = 1) =>
  callFunction("grantQuizAttempts", { uid, courseId, lessonId, count }).then((r) => r.data);
/* Academy staff: attempts on one course's limited quizzes (scoped server view). */
export const quizAttemptStatus = (courseId) => callFunction("quizAttemptStatus", { courseId }).then((r) => r.data);
/* Learner: ask for another attempt on a used-up quiz (editors see it on the course page). */
export const requestQuizAttempt = (courseId, lessonId) => callFunction("requestQuizAttempt", { courseId, lessonId }).then((r) => r.data);

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
/* Pin/unpin changes ONLY `pinned` (never editedAt — pinning isn't an edit). */
export const pinComment = (scope, id, pinned) =>
  updateDoc(doc(db, commentsPath(scope), id), { pinned: !!pinned });
/* Delete one comment. Replies are NOT deleted: they stay visible under a
   "Comment deleted" placeholder. If it's already gone (deleted elsewhere),
   resolves { alreadyGone: true } instead of failing. */
export async function deleteComment(scope, id) {
  const ref = doc(db, commentsPath(scope), id);
  try { await deleteDoc(ref); return { alreadyGone: false }; }
  catch (e) {
    let gone = false;
    try { gone = !(await getDoc(ref)).exists(); } catch { /* can't tell */ }
    if (gone) return { alreadyGone: true };
    throw e;
  }
}

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
export const shapePriorKnowledge = (pk, selfId = null) => ({
  courseIds: [...new Set(((pk && pk.courseIds) || []).map(String))].filter((id) => id && id !== selfId).slice(0, 10),
  note: String((pk && pk.note) || "").trim().slice(0, 300),
});
export const courseShape = (d) => ({
  title: String(d.title || "").trim().slice(0, 120),
  category: normalizeCategory(d.category), level: d.level, topics: normalizeTopics(d.topics), topicIds: topicIdsOf(d),
  about: String(d.about || "").slice(0, 20000),
  outcomes: (d.outcomes || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20),
  requirements: (d.requirements || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20),
  modules: (d.modules || []).slice(0, 50).map((m) => ({ id: m.id || newId(), title: String(m.title || "").slice(0, 120), lessonIds: (m.lessonIds || []).slice(0, 200) })),
  cover: d.cover || null,
  previewVideo: d.previewVideo ? videoRecord(d.previewVideo.ok ? d.previewVideo : { ok: true, ...d.previewVideo }) : null,
  // v6.6 "Recommended prior knowledge": advisory course ids + a short note (never a gate)
  ...(d.priorKnowledge ? { priorKnowledge: shapePriorKnowledge(d.priorKnowledge) } : {}),
  // Markdown format of `about` (absent = 1, legacy). Never written for legacy text.
  ...(d.mdVersion === 2 ? { mdVersion: 2 } : {}),
});

/* v6.6: courses and lessons are only ever written through the workspace's
   draft → publish flow (saveCourseDraft / publishCourseDraft), which the rules
   and the server prerequisite check are built around. The pre-workspace direct
   writers (createCourse, updateCourse, saveLesson, deleteLesson, getQuizKey)
   were removed so nothing can save a live course or lesson another way. */
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
/* v6.11 — Tips & resources get private drafts (guideDrafts/{id}). Saving never
   touches what learners read; Publish copies the draft's content fields into
   guides/{id} in one transaction that also bumps the draft revision (the rules
   require the published content to equal the draft being published). */
const guideDraftRef = (gid) => doc(db, "guideDrafts", gid);
export const newGuideId = () => doc(collection(db, "guides")).id;
export function useGuideDrafts(me) {
  return useQueryDocs(() => collection(db, "guideDrafts"), [me?.id, isAcademyEditor(me)], !!me?.id && isAcademyEditor(me));
}
const shapeGuideDraft = (g) => ({
  title: String(g.title || "").slice(0, 120),
  category: g.category ? normalizeCategory(g.category) : "", topics: normalizeTopics(g.topics), topicIds: topicIdsOf(g),
  video: g.video ? videoRecord(g.video.ok ? g.video : { ok: true, ...g.video }) : null,
  videoMeta: g.video ? shapeVideoMeta(g.videoMeta) : null,
  thumbMode: g.thumbMode === "custom" && g.thumb ? "custom" : "source",
  body: String(g.body || "").slice(0, 20000),
  resources: (g.resources || []).filter((r) => r && r.url).slice(0, 20).map(shapeResource),
  thumb: g.thumb || null,
  durationMinutes: g.video ? 0 : Math.max(0, Math.round(Number(g.durationMinutes) || 0)),   // a reading estimate, text-only
  ...(g.mdVersion === 2 ? { mdVersion: 2 } : {}),
});
export async function loadGuideWorkspace(gid) {
  const [d, l] = await Promise.all([getDoc(guideDraftRef(gid)), getDoc(doc(db, "guides", gid))]);
  const live = l.exists() ? { id: gid, ...l.data() } : null;
  if (d.exists()) return { draftExists: true, head: { rev: Number(d.data().rev || 0), publishedRev: Number(d.data().publishedRev || 0) }, guide: d.data(), live };
  if (live) return { draftExists: false, head: { rev: 0, publishedRev: 0 }, guide: guideDraftFromLive(live), live };
  return { draftExists: false, head: { rev: 0, publishedRev: 0 }, guide: null, live: null };
}
/* One save, pinned to the revision the editor loaded (else → conflict). */
export async function saveGuideDraft(me, gid, guide, baseRev) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(guideDraftRef(gid));
    const cur = snap.exists() ? Number(snap.data().rev || 0) : 0;
    if (cur !== baseRev) throw Object.assign(new Error("This resource was changed somewhere else (another editor or tab)."), { code: "conflict", remoteRev: cur });
    const data = { ...shapeGuideDraft(guide), rev: cur + 1, publishedRev: snap.exists() ? Number(snap.data().publishedRev || 0) : 0, updatedAt: serverTimestamp(), updatedBy: me.id };
    if (snap.exists()) tx.update(guideDraftRef(gid), data); else tx.set(guideDraftRef(gid), { ...data, createdAt: serverTimestamp(), createdBy: me.id });
    return cur + 1;
  });
}
/* Publish exactly revision `expectedRev`. Retry-safe like courses: if that
   revision is already the published one → { already: true }. */
export async function publishGuideDraft(me, gid, expectedRev) {
  try { return await publishGuideOnce(me, gid, expectedRev); }
  catch (e) {
    if (e?.code !== "conflict") throw e;
    const d = await getDoc(guideDraftRef(gid)); const x = d.exists() ? d.data() : null;
    if (x && Number(x.rev) === expectedRev + 1 && Number(x.publishedRev) === Number(x.rev)) return { rev: Number(x.rev), already: true, firstPublish: false };
    throw e;
  }
}
async function publishGuideOnce(me, gid, expectedRev) {
  const d = await getDoc(guideDraftRef(gid));
  if (!d.exists()) throw Object.assign(new Error("There are no changes to publish."), { code: "no-draft" });
  const draft = d.data();
  const catOk = !!draft.category && (await getDoc(doc(db, "academyCategories", draft.category))).exists();
  const issues = guidePublishIssues(draft, catOk ? [draft.category] : []);
  if (issues.length) throw Object.assign(new Error(issues[0].message), { code: "blocked", blockers: issues.map((i) => i.blocker) });
  let oldThumb = null, first = false;
  const rev = await runTransaction(db, async (tx) => {
    const cur = await tx.get(guideDraftRef(gid));
    if (!cur.exists() || Number(cur.data().rev) !== expectedRev) throw Object.assign(new Error("This resource was changed somewhere else since you last saved. Reload to see the latest version, then publish."), { code: "conflict" });
    const liveRef = doc(db, "guides", gid); const live = await tx.get(liveRef);
    const content = {}; for (const k of GUIDE_CONTENT_FIELDS) if (cur.data()[k] !== undefined) content[k] = cur.data()[k];
    const now = serverTimestamp();
    oldThumb = live.exists() ? live.data().thumb?.path || null : null; first = !live.exists() || !live.data().publishedAt;
    const next = { ...content, status: "published", updatedAt: now, updatedBy: me.id };
    if (live.exists()) {
      const drop = Object.fromEntries(GUIDE_CONTENT_FIELDS.filter((k) => !(k in content) && live.data()[k] !== undefined).map((k) => [k, deleteField()]));
      tx.update(liveRef, { ...next, ...drop, ...(live.data().publishedAt ? {} : { publishedAt: now }) });
    } else tx.set(liveRef, { ...next, createdAt: now, createdBy: me.id, publishedAt: now });
    const r = expectedRev + 1;
    tx.update(guideDraftRef(gid), { rev: r, publishedRev: r, updatedAt: now, updatedBy: me.id });
    return r;
  });
  // the replaced thumbnail, if it was this resource's own and nothing else uses it
  if (oldThumb && oldThumb !== draft.thumb?.path && oldThumb.startsWith(`academy/guideThumbs/${gid}/`)) {
    try { if (!(await imagesReferencedElsewhere([oldThumb], null, { guideId: gid })).has(oldThumb)) await deleteImage(oldThumb); } catch { /* left for clean-up */ }
  }
  return { rev, firstPublish: first };
}
/* Discard unpublished changes: the draft goes; learners' published version, its
   reviews and discussion are untouched. */
export const discardGuideDraft = (gid) => deleteDoc(guideDraftRef(gid));
export const setGuideStatus = (me, gid, status) => setContentStatus("guides", me, gid, status);
/* Permanently delete a resource: discussion, learners' "reviewed" records,
   its draft and the published record; then its own thumbnails that nothing
   else uses. Primary deletion first; image clean-up reported separately. */
export async function deleteGuideHard(me, gid) {
  const [g, d] = await Promise.all([getDoc(doc(db, "guides", gid)), getDoc(guideDraftRef(gid))]);
  const images = [...new Set([g.exists() && g.data().thumb?.path, d.exists() && d.data().thumb?.path].filter((p) => p && p.startsWith(`academy/guideThumbs/${gid}/`)))];
  // discussion first (readable only while the resource exists), then the draft +
  // record, then learners' "reviewed" records (deletable once it's gone)
  const cs = g.exists() ? await getDocs(collection(db, `guides/${gid}/comments`)) : { docs: [] };
  await batchDelete(cs.docs.map((c) => c.ref));
  const b = writeBatch(db);
  if (d.exists()) b.delete(guideDraftRef(gid));
  if (g.exists()) b.delete(doc(db, "guides", gid));
  await b.commit();
  let reviewsLeft = false;
  if (g.exists()) {
    try { const rs = await getDocs(query(collectionGroup(db, "guideReviews"), where("guideId", "==", gid))); await batchDelete(rs.docs.map((x) => x.ref)); }
    catch { reviewsLeft = true; /* left behind; never shown once the resource is gone */ }
  }
  const keep = images.length ? await imagesReferencedElsewhere(images, null, { guideId: gid }).catch(() => new Set(images)) : new Set();
  const failed = [];
  for (const p of images.filter((x) => !keep.has(x))) { try { await deleteImage(p); } catch (e) { if (e?.code !== "storage/object-not-found") failed.push(p); } }
  return { pendingCleared: failed.length === 0 && !reviewsLeft, failedImages: failed, keptShared: [...keep] };
}
/* Impact checks before a deletion read the SERVER only (never the local cache): offline,
   they fail visibly and the review offers Retry instead of showing unconfirmed results. */
export async function pathsUsingGuide(gid) {
  const ps = await getDocsFromServer(collection(db, "paths"));
  return ps.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => (p.items || []).some((it) => it.type === "guide" && it.guideId === gid));
}
export const setCategoryGuideOrder = (me, id, guideOrder) => updateDoc(doc(db, "academyCategories", id), { guideOrder: guideOrder.slice(0, 500), ...stamp(me) });

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
/* Other courses that list `courseId` as recommended prior knowledge (live or
   draft). Deleting it leaves those references dangling: learners simply stop
   seeing it there, and editors are told to update the list. */
export async function coursesRecommending(courseId) {
  const [live, drafts] = await Promise.all([
    getDocsFromServer(query(collection(db, "courses"), where("priorKnowledge.courseIds", "array-contains", courseId))),
    getDocsFromServer(query(collection(db, "courseDrafts"), where("priorKnowledge.courseIds", "array-contains", courseId))),
  ]);
  const byId = new Map();
  for (const d of [...live.docs, ...drafts.docs]) if (d.id !== courseId && !byId.has(d.id)) byId.set(d.id, { id: d.id, title: d.data().title || "Untitled course" });
  return [...byId.values()];
}
export async function pathsUsingCourse(courseId) {
  const ps = await getDocsFromServer(collection(db, "paths"));
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
  // v6.5: stable lesson ids this lesson requires (only written when present)
  ...(Array.isArray(d.prerequisites) ? { prerequisites: [...new Set(d.prerequisites.map(String))].slice(0, 20) } : {}),
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

export async function savePurposeVideo(me, data) {
  await setDoc(doc(db, `academySettings/${PURPOSE_DOC}`), {
    title: String(data.title || "").slice(0, 120), intro: String(data.intro || "").slice(0, 4000),
    video: data.video ? videoRecord(data.video.ok ? data.video : { ok: true, ...data.video }) : null,
    thumb: data.thumb || null, updatedAt: serverTimestamp(), updatedBy: me.id,
  });
}

/* ---- Storage -------------------------------------------------------------- */
/* Uploads fail FAST instead of hanging: the Storage SDK otherwise keeps
   retrying for minutes (and an unresponsive Storage service never answers).
   Ends with a clear error code, after cancelling the upload task:
     "offline"  — offline at the start, or the connection drops mid-upload
     "stalled"  — no progress for `stallMs` (the service stopped responding)
     "timeout"  — not finished within `timeoutMs` overall
     "canceled" — the author cancelled (`signal`)
   Getting a storage handle that never resolves counts as a stall too. Nothing
   references the uploaded file until this resolves. */
export async function uploadImage(path, blob, contentType, { timeoutMs = 90000, stallMs = 20000, signal = null } = {}) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw Object.assign(new Error("offline"), { code: "offline" });
  if (signal?.aborted) throw Object.assign(new Error("canceled"), { code: "canceled" });
  const fail = (code) => Object.assign(new Error(code), { code });
  const withStall = (p) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(fail("stalled")), stallMs);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
  const [{ ref, uploadBytesResumable }, st] = await withStall(Promise.all([import("firebase/storage"), getStorageInstance()]));
  const task = uploadBytesResumable(ref(st, path), blob, { contentType, cacheControl: "private, max-age=3600" });
  return new Promise((resolve, reject) => {
    let done = false, stall = 0;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(stall); unsub(); window.removeEventListener("offline", onOffline); signal?.removeEventListener("abort", onAbort); fn(); };
    const abort = (code) => finish(() => { try { task.cancel(); } catch {} reject(fail(code)); });
    const armStall = () => { clearTimeout(stall); stall = setTimeout(() => abort("stalled"), stallMs); };
    const onOffline = () => abort("offline");
    const onAbort = () => abort("canceled");
    const timer = setTimeout(() => abort("timeout"), timeoutMs);
    const unsub = task.on("state_changed", () => armStall(), () => {}, () => {});
    armStall();
    window.addEventListener("offline", onOffline);
    signal?.addEventListener("abort", onAbort);
    task.then((snap) => finish(() => resolve({ path, bytes: snap.metadata.size, contentType })), (e) => finish(() => reject(e)));
  });
}
/* Which of `paths` are still used by anything OTHER than course `courseId`:
   another course or course draft (cover), any live or draft lesson (thumb),
   a quick guide (thumb), a learning path or category (cover). Folder
   ownership alone isn't enough — data copied between courses can point at
   another course's file. If a check can't complete, the path counts as still
   used (an image is only deleted when it's provably unreferenced). */
export async function imagesReferencedElsewhere(paths, courseId, { guideId = null } = {}) {
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
        getDocs(query(collection(db, "guideDrafts"), where("thumb.path", "==", p))),
      ]);
      const [courses, drafts, lessons, guides, pathsQ, cats, guideDrafts] = qs;
      if ([...courses.docs, ...drafts.docs].some((d) => d.id !== courseId) || lessons.docs.some(notThisCourse)
        || [...guides.docs, ...guideDrafts.docs].some((d) => d.id !== guideId) || pathsQ.size || cats.size) keep.add(p);
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
/* Images (round 7). Reads stay auth-checked (getBlob under storage.rules →
   blob: URLs); no public or download URLs. The object-URL cache lives in
   academyCache.js: bounded, entries in use are never evicted, evicted URLs are
   revoked, everything is dropped on sign-out / account change.
   • at most IMAGE_PARALLEL downloads at once; images on screen are requested
     first (callers only ask once an image is near the viewport — useImageUrl)
   • one request per path at a time (in-flight dedupe)
   • a stuck request counts as failed after IMAGE_TIMEOUT_MS from when its
     download STARTS (time spent queued doesn't count). Failures are never
     cached, so the next view tries again. */
export const IMAGE_TIMEOUT_MS = 15000;
const IMAGE_PARALLEL = 4;
let _storageMod = null;          // the Storage SDK module, imported once on first use
const storageModule = () => (_storageMod ||= import("firebase/storage"));
const _inflight = new Map();   // path → { promise, job }
const _queue = [];
let _active = 0;
const cancelled = () => Object.assign(new Error("Not needed any more."), { code: "cancelled" });
onAcademyClear(() => { for (const j of _queue) j.reject(cancelled()); _queue.length = 0; _inflight.clear(); });
function pumpImages() {
  while (_active < IMAGE_PARALLEL && _queue.length) {
    const job = _queue.shift();
    _active += 1;
    job.started = true;
    job.run().then(job.resolve, job.reject).finally(() => { _active -= 1; pumpImages(); });
  }
}
/* A component that no longer needs an image (it unmounted, e.g. the learner
   moved on) withdraws its interest; a download that hasn't STARTED and that
   nobody waits for any more leaves the queue, so it never delays the images on
   the screen the learner moved to. */
export function releaseImageRequest(path) {
  const f = _inflight.get(path);
  if (!f || f.job.started) return;
  f.job.waiters -= 1;
  if (f.job.waiters > 0) return;
  const i = _queue.indexOf(f.job);
  if (i >= 0) _queue.splice(i, 1);
  _inflight.delete(path);
  f.job.reject(cancelled());
}
export async function imageObjectUrl(path, { timeoutMs = IMAGE_TIMEOUT_MS, waiter = false } = {}) {
  const hit = cachedImageUrl(path);
  if (hit) return hit;
  if (_inflight.has(path)) { const f = _inflight.get(path); if (waiter) f.job.waiters += 1; return f.promise; }
  const gen = sessionGen();
  const run = async () => {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Image took too long to load."), { code: "timeout" })), timeoutMs); });
    const load = (async () => {
      const [{ ref, getBlob }, st] = await Promise.all([storageModule(), getStorageInstance()]);
      const blob = await getBlob(ref(st, path));
      const url = URL.createObjectURL(blob);
      // a download from a previous session is revoked, never cached
      if (!storeImageUrl(path, url, gen)) throw Object.assign(new Error("Signed out."), { code: "cancelled" });
      return url;
    })();
    try { return await Promise.race([load, timeout]); } finally { clearTimeout(timer); }
  };
  const job = { run, resolve: null, reject: null, started: false, waiters: waiter ? 1 : 0 };
  const p = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; _queue.push(job); pumpImages(); })
    .finally(() => { if (_inflight.get(path)?.promise === p) _inflight.delete(path); });
  _inflight.set(path, { promise: p, job });
  return p;
}
/* `visible`: start loading only once the image is on (or near) the screen.
   While mounted the cached URL is retained (never evicted under it). */
export function useImageUrl(imageRef, visible = true) {
  const path = imageRef?.path || null;
  const [state, setState] = useState(() => ({ path, url: path ? cachedImageUrl(path) : null, error: false }));
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!path) return undefined;
    retainImage(path);
    return () => releaseImage(path);
  }, [path, state.url]);
  useEffect(() => {
    if (!path) { setState({ path, url: null, error: false }); return; }
    const cached = cachedImageUrl(path);
    if (cached) { setState({ path, url: cached, error: false }); return; }
    if (!visible) { setState((s) => (s.path === path && !s.url && !s.error ? s : { path, url: null, error: false })); return; }
    setState({ path, url: null, error: false });
    let waiting = true;
    imageObjectUrl(path, { waiter: true }).then(
      (url) => { waiting = false; if (alive.current) setState({ path, url, error: false }); },
      (e) => { waiting = false; if (alive.current && e?.code !== "cancelled") setState({ path, url: null, error: true }); });
    return () => { if (waiting) releaseImageRequest(path); };
  }, [path, visible]);
  return state.path === path ? state : { path, url: null, error: false };
}
export const _resetImageCacheForTests = () => { clearAcademySession(); _active = 0; };


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
/* opts.showCategory: ALSO make the course's (draft) category visible, in the
   SAME transaction — both happen or neither does (admins only; the rules
   refuse the category write for anyone else, which fails the whole publish).
   Retry-safe: if this exact revision was already published (a lost response,
   a double click, another tab), it returns { already: true } instead of a
   conflict. */
export async function publishCourseDraft(me, cid, expectedRev, opts = {}) {
  try { return await publishCourseDraftOnce(me, cid, expectedRev, opts); }
  catch (e) {
    // a revision mismatch shows up either in the transaction ("conflict") or in
    // the server check that runs first ("aborted")
    if (e?.code !== "conflict" && e?.code !== "functions/aborted") throw e;
    const d = await getDoc(draftRef(cid));
    const x = d.exists() ? d.data() : null;
    if (x && Number(x.rev) === expectedRev + 1 && Number(x.publishedRev) === Number(x.rev)) return { rev: Number(x.rev), already: true, firstPublish: false, leftovers: [], categoryShown: false };
    if (e?.code === "conflict") throw e;
    throw Object.assign(new Error("This course was changed somewhere else since you last saved. Reload to see the latest version, then publish."), { code: "conflict" });
  }
}
async function publishCourseDraftOnce(me, cid, expectedRev, { showCategory = false } = {}) {
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
  // EVERY publish is checked by the SERVER for this exact draft revision
  // (prerequisites, video links, quiz answer keys). The rules refuse published
  // lessons, answer keys and the course itself without a matching, passing
  // verdict — the checks above are for quick feedback only.
  const res = (await callFunction("checkCoursePrerequisites", { courseId: cid, rev: expectedRev })).data;
  if (!res.ok) throw Object.assign(new Error(res.issues[0]?.message || "Fix the problems listed, then publish."), { code: "blocked", blockers: res.issues.map((i) => i.message) });
  if (2 + plan.upserts.length * 2 + plan.removes.length * 2 > 480) throw Object.assign(new Error("This course has too many lessons to publish in one step."), { code: "too-large" });
  const newRev = await runTransaction(db, async (tx) => {
    const cur = await tx.get(draftRef(cid));
    if (!cur.exists() || Number(cur.data().rev) !== expectedRev) throw Object.assign(new Error("This course was changed somewhere else since you last saved. Reload to review the latest version, then publish."), { code: "conflict" });
    const liveRef = doc(db, "courses", cid);
    const curLive = await tx.get(liveRef);
    const showWrite = showCategory && catExists ? await applyCategoryHidden(tx, me, catId, false) : null;   // all reads before writes
    const now = serverTimestamp();
    const shaped = { ...courseShape(plan.course), lessonCount: plan.course.lessonCount, requiredLessonCount: plan.course.requiredLessonCount,
      requiredQuizLessonIds: plan.course.requiredQuizLessonIds, bonusLessonIds: plan.course.bonusLessonIds, durationMinutes: plan.course.durationMinutes,
      prerequisiteMap: plan.course.prerequisiteMap || {},
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
    if (showWrite) showWrite(tx);
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
  return { rev: newRev, firstPublish: plan.firstPublish, leftovers, categoryShown: !!(showCategory && catExists) };
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
