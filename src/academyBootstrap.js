/* Starter categories — the ONE writer behind "Create the starter categories".
   Used by the app (academyData.createDefaultCategories) and exercised against
   the real Firestore rules in test/academyBootstrap.rules.test.js, so it takes
   the Firestore instance instead of importing the app's.

   • The id is the document path only; the body holds just the fields
     firestore.rules (validCategoryRecord) allows. (The previous writer spread
     the whole record, `id` included, so every setup was rejected.)
   • A transaction reads the six starter documents first and creates only the
     missing ones: an existing category is never overwritten, renamed, unhidden
     or reset, so retries and concurrent attempts are safe (a concurrent create
     makes Firestore retry the transaction, which then finds it).
   • A transaction resolves only after the SERVER commits — there are no
     optimistic local records — so a resolved promise means confirmed setup.
     It fails offline instead of queueing. */
import { doc, runTransaction, serverTimestamp } from "firebase/firestore";
import { defaultCategoryRecords } from "./academyProgress.js";

export const CATEGORY_RECORD_FIELDS = ["name", "short", "description", "order", "hidden", "cover"];

/* The stored body of a starter category: allowed fields + attribution. */
export function starterCategoryBody(record, uid) {
  const body = {};
  for (const k of CATEGORY_RECORD_FIELDS) if (record[k] !== undefined) body[k] = record[k];
  const now = serverTimestamp();
  return { ...body, createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid };
}

/* → { created: [ids], existing: [ids] } once the server has committed. */
export async function createStarterCategories(db, uid) {
  if (!uid) throw Object.assign(new Error("Sign in to create categories."), { code: "unauthenticated" });
  const records = defaultCategoryRecords();
  return runTransaction(db, async (tx) => {
    const refs = records.map((r) => doc(db, "academyCategories", r.id));
    const snaps = [];
    for (const ref of refs) snaps.push(await tx.get(ref)); // all reads before any write
    const created = [], existing = [];
    records.forEach((r, i) => {
      if (snaps[i].exists()) { existing.push(r.id); return; }
      tx.set(refs[i], starterCategoryBody(r, uid));
      created.push(r.id);
    });
    return { created, existing };
  });
}

/* What the category reads say — ONE answer for Learn and the workspace:
   "loading" (either read still pending), "error" (either read FAILED — never
   treated as an empty Academy), "empty" (the records query SUCCEEDED and found
   none: the starter set applies and setup is offered), "ready". */
export function categoryReadState(recs, idx) {
  if (recs?.error || idx?.error) return "error";
  if (!recs?.loaded || !idx?.loaded) return "loading";
  return (recs.docs || []).length === 0 ? "empty" : "ready";
}
