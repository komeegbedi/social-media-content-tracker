/* Assignment-notification recipient resolution (finding 6) — pure, Firebase-free.
   Proves recipients resolve by STABLE uid identity: a rename does not mis-fire an
   assignment, a duplicate display name never notifies the wrong person, and a
   legacy (no-uid) slot still resolves by name.
   Run: node --test test/assignment-recipients.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
const { assignmentRecipients, resolveByIdentity } = await import("../functions/assignmentRecipients.js");

const ada  = { uid: "ua", name: "Ada" };
const bo   = { uid: "ub", name: "Bo" };
const cy   = { uid: "uc", name: "Cy" };
// Two DIFFERENT people share the display name "Bo".
const boDup = { uid: "ub2", name: "Bo" };
const byUid = { ua: ada, ub: bo, uc: cy, ub2: boDup };
// byName is last-writer-wins on the duplicate (mirrors loadUsers) — the trap.
const byName = { Ada: ada, Bo: boDup, Cy: cy };
const D = { byUid, byName };

const uids = (recs) => recs.map((r) => r.user.uid);

test("finding 6 · a NEW owner assignment notifies, resolved by ownerUid", () => {
  const recs = assignmentRecipients({ owner: "Pending", ownerUid: "" }, { owner: "Ada", ownerUid: "ua" }, D);
  assert.deepEqual(uids(recs), ["ua"]);
  assert.equal(recs[0].kind, "owner");
});

test("finding 6 · a pure RENAME of the same owner uid fires NO assignment", () => {
  const before = { owner: "Ada", ownerUid: "ua" };
  const after  = { owner: "Ada Newname", ownerUid: "ua" };   // same uid, new display name
  assert.deepEqual(assignmentRecipients(before, after, D), []);
});

test("finding 6 · owner resolves by UID even when a DIFFERENT user shares the display name", () => {
  // after.owner display name is "Bo" but the uid is the real Bo (ub), not the dup (ub2).
  const recs = assignmentRecipients({ ownerUid: "" }, { owner: "Bo", ownerUid: "ub" }, D);
  assert.deepEqual(uids(recs), ["ub"], "the uid wins — not byName's last-writer 'Bo'");
});

test("finding 6 · a newly-added crew member is notified, resolved by support[].uid", () => {
  const before = { ownerUid: "ua", owner: "Ada", support: [] };
  const after  = { ownerUid: "ua", owner: "Ada", support: [{ uid: "uc", name: "Cy", role: "shoot" }] };
  const recs = assignmentRecipients(before, after, D);
  assert.deepEqual(uids(recs), ["uc"]);
  assert.equal(recs[0].kind, "crew");
});

test("finding 6 · a RENAMED crew member (uid unchanged) is NOT re-notified", () => {
  const before = { support: [{ uid: "uc", name: "Cy", role: "shoot" }] };
  const after  = { support: [{ uid: "uc", name: "Cy Renamed", role: "shoot" }] };
  assert.deepEqual(assignmentRecipients(before, after, D), []);
});

test("finding 6 · a just-STAMPED uid (name unchanged) is not mistaken for a fresh add", () => {
  const before = { support: [{ name: "Cy", role: "shoot" }] };            // legacy, no uid
  const after  = { support: [{ uid: "uc", name: "Cy", role: "shoot" }] }; // uid backfilled
  assert.deepEqual(assignmentRecipients(before, after, D), []);
});

test("finding 6 · a Pending crew slot notifies nobody", () => {
  const after = { support: [{ name: "Pending", suggested: "Someone", role: "edit" }] };
  assert.deepEqual(assignmentRecipients({ support: [] }, after, D), []);
});

test("finding 6 · legacy: a no-uid owner slot still resolves by name", () => {
  const recs = assignmentRecipients({ owner: "Pending" }, { owner: "Ada" }, D);  // no ownerUid anywhere
  assert.deepEqual(uids(recs), ["ua"]);
});

test("finding 6 · resolveByIdentity: uid is authoritative; no name fallback when uid is set", () => {
  assert.equal(resolveByIdentity("ua", "Whoever", byUid, byName), ada);   // uid wins
  assert.equal(resolveByIdentity("missing", "Ada", byUid, byName), null); // uid set but unknown → NO name fallback
  assert.equal(resolveByIdentity("", "Ada", byUid, byName), ada);         // legacy → name
});

/* ============================================================================
   Finding 3 — legacy name fallback must be DUPLICATE-SAFE (never last-writer-wins)
   ============================================================================ */
// A roster where "Bo" is shared by TWO users (bo, boDup) and Ada/Cy are unique.
// byName collapses "Bo" to boDup (last-writer-wins) — the trap the dupe set avoids.
const ROSTER = [ada, boDup, bo, cy];
const withList = { byUid, byName, list: ROSTER };

test("finding 3 · legacy UNIQUE owner name resolves correctly", () => {
  const recs = assignmentRecipients({ owner: "Pending" }, { owner: "Ada" }, withList);
  assert.deepEqual(uids(recs), ["ua"]);
});

test("finding 3 · legacy UNIQUE crew name resolves correctly", () => {
  const recs = assignmentRecipients({ support: [] }, { support: [{ name: "Cy", role: "shoot" }] }, withList);
  assert.deepEqual(uids(recs), ["uc"]);
});

test("finding 3 · legacy DUPLICATE owner name notifies NOBODY (reported, never guessed)", () => {
  const unresolved = [];
  const recs = assignmentRecipients({ owner: "Pending" }, { owner: "Bo" },
    { ...withList, onUnresolved: (i) => unresolved.push(i) });
  assert.deepEqual(recs, [], "ambiguous legacy owner name → no recipient");
  assert.deepEqual(unresolved, [{ kind: "owner", name: "Bo", reason: "duplicate-name" }]);
});

test("finding 3 · legacy DUPLICATE crew name notifies NOBODY (reported)", () => {
  const unresolved = [];
  const recs = assignmentRecipients({ support: [] }, { support: [{ name: "Bo", role: "edit" }] },
    { ...withList, onUnresolved: (i) => unresolved.push(i) });
  assert.deepEqual(recs, [], "ambiguous legacy crew name → no recipient");
  assert.ok(unresolved.some((i) => i.kind === "crew" && i.name === "Bo" && i.reason === "duplicate-name"));
});

test("finding 3 · UID-based assignment still resolves even when the display name is duplicated", () => {
  // 'Bo' is duplicated, but the slot carries a uid → resolve by uid, unaffected.
  const recs = assignmentRecipients({ ownerUid: "" }, { owner: "Bo", ownerUid: "ub" }, withList);
  assert.deepEqual(uids(recs), ["ub"], "uid wins; the duplicate name is irrelevant");
});

/* ============================================================================
   Finding 4 — a same-name UID REPLACEMENT must NOT be suppressed by the name match
   ============================================================================ */
const alexA = { uid: "uid-a", name: "Alex" };
const alexB = { uid: "uid-b", name: "Alex" };
const replDeps = { byUid: { "uid-a": alexA, "uid-b": alexB }, byName: { Alex: alexB }, list: [alexA, alexB] };

test("finding 4 · a same-name UID replacement notifies the NEW uid (not suppressed by the shared name)", () => {
  const before = { support: [{ name: "Alex", uid: "uid-a", role: "shoot" }] };
  const after  = { support: [{ name: "Alex", uid: "uid-b", role: "shoot" }] };   // A replaced by B, same name
  const recs = assignmentRecipients(before, after, replDeps);
  assert.deepEqual(uids(recs), ["uid-b"], "the genuine replacement is notified");
});

test("finding 4 · backfilling a legacy crew member's uid does NOT notify (migration, not a new assignment)", () => {
  const before = { support: [{ name: "Cy", role: "shoot" }] };             // legacy, no uid
  const after  = { support: [{ name: "Cy", uid: "uc", role: "shoot" }] };  // uid stamped, same person
  assert.deepEqual(assignmentRecipients(before, after, withList), [], "stamping is not a fresh assignment");
});
