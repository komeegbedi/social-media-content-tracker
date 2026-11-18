/* Learner image access markers — academyLearnerMedia/{kind}_{id}.

   Why: a Cloud Storage rules evaluation may access at most TWO Firestore
   documents ("No more than two Firestore documents may be accessed in a single
   Rules evaluation" — firebase.google.com/docs/storage/security/rules-conditions).
   Letting a learner read a course or resource image needs three facts: the
   reader is approved (users/{uid}), the item is published (courses/{id} or
   guides/{id}) and its category isn't hidden (academySettings/categoryIndex) —
   three documents. These triggers fold the last two into ONE marker document,
   so storage.rules reads users/{uid} + the marker and nothing else.

   Once synced, the marker EXISTS exactly when the item's images may be shown
   to approved learners — the same test firestore.rules (canSeeCourseDoc)
   applies to the item itself: status == 'published' and its category isn't in
   the hidden list.

   TIMING — the marker is EVENTUALLY consistent, in both directions:
   • granting (publish, show a category): until the trigger runs, images stay
     hidden (fail-closed);
   • REVOKING (unpublish, archive, delete, hide a category): until the trigger
     has run successfully, an existing marker keeps allowing approved learners
     to read that item's images. Firestore itself refuses the item at once.
     Firebase documents no latency bound for Firestore triggers, delivers
     events at least once and in no guaranteed order, and retries a failed
     2nd-gen event for up to 24 hours. A sync that still fails, or an event
     that never arrives, leaves the marker stale until the next write to the
     item or the hidden list, or until reconcileLearnerMedia repairs it.

   • Server-written only: firestore.rules has no match for this collection, so
     clients can neither read nor write it.
   • Every sync recomputes from the CURRENT documents inside a transaction, so
     retries, duplicate or out-of-order events all converge on the right state.
   • Inputs: the item itself (course/guide trigger) and the hidden list
     (categoryIndex trigger re-syncs every item filed under a category whose
     hidden state changed).
   • Detection and repair: a failed sync is logged ("academy learner media sync
     failed", with the item) and retried; reconcileLearnerMedia compares every
     marker with the published items and reports (or, with apply, repairs) the
     missing and stale ones — scripts/reconcile-learner-media.mjs. */
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { db, FieldValue } = require("./lib");

const COLLECTION = "academyLearnerMedia";
const SOURCES = { course: "courses", guide: "guides" };
const INDEX = "academySettings/categoryIndex";

const markerId = (kind, id) => `${kind}_${id}`;

/* The same visibility test firestore.rules applies to a course / guide doc. */
function learnerVisible(item, hidden) {
  if (!item) return false;
  const status = typeof item.status === "string" ? item.status : "";
  const category = typeof item.category === "string" ? item.category : "";
  return status === "published" && !(Array.isArray(hidden) ? hidden : []).includes(category);
}

/* Categories whose hidden state differs between two versions of the index. */
function changedHiddenIds(before, after) {
  const a = new Set(Array.isArray(before) ? before : []);
  const b = new Set(Array.isArray(after) ? after : []);
  return [...new Set([...a, ...b])].filter((id) => a.has(id) !== b.has(id));
}

/* Recompute one marker from the current item + hidden list (transactional). */
async function syncLearnerMedia(kind, id, store = db) {
  if (!SOURCES[kind] || typeof id !== "string" || !id) throw new Error(`bad learner-media target ${kind}/${id}`);
  const itemRef = store.doc(`${SOURCES[kind]}/${id}`);
  const indexRef = store.doc(INDEX);
  const markerRef = store.collection(COLLECTION).doc(markerId(kind, id));
  return store.runTransaction(async (tx) => {
    const [item, index, marker] = await Promise.all([tx.get(itemRef), tx.get(indexRef), tx.get(markerRef)]);
    const data = item.exists ? item.data() : null;
    const visible = learnerVisible(data, index.exists ? index.data().hidden : []);
    if (visible) {
      const category = data.category || "";
      if (!marker.exists || marker.data().category !== category) {
        tx.set(markerRef, { kind, id, category, updatedAt: FieldValue.serverTimestamp() });
      }
    } else if (marker.exists) {
      tx.delete(markerRef);
    }
    return visible;
  });
}

/* Re-sync every course and guide filed under any of `categoryIds`. */
async function syncCategories(categoryIds, store = db) {
  const ids = [...new Set(categoryIds)].filter((x) => typeof x === "string" && x);
  let n = 0;
  for (const [kind, coll] of Object.entries(SOURCES)) {
    for (let i = 0; i < ids.length; i += 30) {                // `in` takes at most 30 values
      const snap = await store.collection(coll).where("category", "in", ids.slice(i, i + 30)).get();
      for (const d of snap.docs) { await syncLearnerMedia(kind, d.id, store); n += 1; }
    }
  }
  return n;
}

/* Drift check: every marker vs. what it should be NOW.
   missing = a learner-visible item without a marker (its images stay hidden);
   stale   = a marker whose item is no longer learner-visible (its images are
             still readable — the case that matters for revocation).
   Read-only unless `apply`, which re-syncs each affected item (stale markers
   of unknown shape are deleted). */
async function reconcileLearnerMedia(store = db, { apply = false } = {}) {
  const index = await store.doc(INDEX).get();
  const hidden = index.exists ? index.data().hidden : [];
  const expected = new Map();
  for (const [kind, coll] of Object.entries(SOURCES)) {
    const snap = await store.collection(coll).where("status", "==", "published").get();
    for (const d of snap.docs) if (learnerVisible(d.data(), hidden)) expected.set(markerId(kind, d.id), { kind, id: d.id });
  }
  const markers = await store.collection(COLLECTION).get();
  const have = new Map(markers.docs.map((d) => [d.id, d.data() || {}]));
  const missing = [...expected.keys()].filter((k) => !have.has(k)).sort();
  const stale = [...have.keys()].filter((k) => !expected.has(k)).sort();
  let repaired = 0;
  if (apply) {
    for (const k of missing) { const t = expected.get(k); await syncLearnerMedia(t.kind, t.id, store); repaired += 1; }
    for (const k of stale) {
      const m = have.get(k);
      if (SOURCES[m.kind] && typeof m.id === "string" && m.id && markerId(m.kind, m.id) === k) await syncLearnerMedia(m.kind, m.id, store);
      else await store.collection(COLLECTION).doc(k).delete();
      repaired += 1;
    }
  }
  return { visibleItems: expected.size, markers: have.size, missing, stale, repaired };
}

const opts = (document) => ({ document, memory: "256MiB", timeoutSeconds: 120, retry: true });
/* A failure is logged with the item and rethrown, so the event is retried. */
async function logged(what, fn) {
  try { return await fn(); }
  catch (e) { logger.error("academy learner media sync failed", { ...what, error: String(e?.message || e) }); throw e; }
}

exports.onAcademyCourseMedia = onDocumentWritten(opts("courses/{cid}"), (event) =>
  logged({ kind: "course", id: event.params.cid }, () => syncLearnerMedia("course", event.params.cid)));
exports.onAcademyGuideMedia = onDocumentWritten(opts("guides/{gid}"), (event) =>
  logged({ kind: "guide", id: event.params.gid }, () => syncLearnerMedia("guide", event.params.gid)));
exports.onAcademyCategoryIndexMedia = onDocumentWritten(opts(INDEX), async (event) => {
  const before = event.data?.before?.exists ? event.data.before.data().hidden : [];
  const after = event.data?.after?.exists ? event.data.after.data().hidden : [];
  const changed = changedHiddenIds(before, after);
  if (!changed.length) return;
  const n = await logged({ kind: "categories", ids: changed }, () => syncCategories(changed));
  logger.info("academy learner media re-synced", { categories: changed.length, items: n });
});

Object.assign(exports, { COLLECTION, markerId, learnerVisible, changedHiddenIds, syncLearnerMedia, syncCategories, reconcileLearnerMedia });
