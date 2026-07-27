/* Admin-only callable: remove a team member via the durable removal saga.
   Reversible (Auth disabled, profile tombstoned — never permanently deleted),
   idempotent, and resumable after a crash. All authorization is re-verified
   server-side; nothing from the client is trusted except the target uid and the
   task-reassignment policy (used by 4B). */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { getAuth } = require("firebase-admin/auth");
const { db, FieldValue } = require("./lib");
const { removalOpId, validateCaller, validateTarget, runRemoval } = require("./removalSaga");

// Reversibly disable the Auth account (never delete). A missing Auth account is
// treated as already-disabled so a Firestore-only profile can still be removed.
async function disableAuthUser(uid) {
  try { await getAuth().updateUser(uid, { disabled: true }); }
  catch (e) { if (e && e.code === "auth/user-not-found") return; throw e; }
}

// Count admins whose account is still active (disabled != true).
async function activeAdminCount(database) {
  const snap = await database.collection("users").where("role", "==", "admin").get();
  return snap.docs.filter((d) => d.data().disabled !== true).length;
}

/* Testable core: read authoritative state, authorize, then create-or-resume the
   saga. `deps` lets tests inject the Auth op + crash hooks. Throws HttpsError on
   a denied request; returns { ok, opId, phase | alreadyRemoved }. */
async function removeUserCore({ database, callerUid, targetUid, policy, deps = {} }) {
  const disable = deps.disableAuthUser || disableAuthUser;
  const [callerSnap, targetSnap, admins] = await Promise.all([
    database.doc(`users/${callerUid}`).get(),
    targetUid ? database.doc(`users/${targetUid}`).get() : Promise.resolve(null),
    activeAdminCount(database),
  ]);
  const caller = callerSnap.exists ? callerSnap.data() : null;
  const target = targetSnap && targetSnap.exists ? targetSnap.data() : null;

  // 1. Caller authorization ALWAYS runs (a denied retry stays denied).
  const cErr = validateCaller({ caller, callerUid, targetUid });
  if (cErr) throw new HttpsError(cErr[0], cErr[1]);

  const opRef = database.collection("adminOps").doc(removalOpId(targetUid));
  const existing = await opRef.get();

  // 2. Resume an in-progress op REGARDLESS of tombstone state — a crash mid-saga
  //    leaves the target already tombstoned, so this must not fall into the
  //    "already removed" shortcut below; it has to finish the remaining phases.
  const run = () => runRemoval({
    db: database, opRef, targetUid, targetName: target ? target.name : (existing.exists ? existing.data().targetName : ""),
    removedBy: callerUid, disableAuthUser: disable, hooks: deps.hooks || {},
  });
  if (existing.exists) {
    if (existing.data().phase === "done") return { ok: true, opId: opRef.id, phase: "done", alreadyDone: true };
    return { ok: true, opId: opRef.id, phase: await run() };
  }

  // 3. Fresh removal → target checks, then create the op and run.
  const tv = validateTarget({ target, activeAdminCount: admins });
  if (tv.error) throw new HttpsError(tv.error[0], tv.error[1]);
  if (tv.alreadyRemoved) return { ok: true, opId: opRef.id, alreadyRemoved: true };

  await opRef.create({
    type: "user_removal", targetUid, targetName: target.name || "", requestedBy: callerUid,
    policy: policy || null, phase: "validating",
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, opId: opRef.id, phase: await run() };
}

exports.removeUser = onCall({ memory: "256MiB", timeoutSeconds: 120 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in and try again.");
  const targetUid = String((req.data && req.data.targetUid) || "");
  const policy = (req.data && req.data.policy) || null;
  try {
    return await removeUserCore({ database: db, callerUid: req.auth.uid, targetUid, policy });
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error("removeUser failed", { targetUid, message: String((e && e.message) || e).slice(0, 300) });
    throw new HttpsError("internal", "Couldn't remove the user. The error has been logged.");
  }
});

exports.removeUserCore = removeUserCore; // for tests
