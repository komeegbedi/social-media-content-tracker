/* Firestore Security Rules — allowed vs denied, run against the emulator.
   These prove the security boundary (not the UI): valid status enum, role-gated
   workflow transitions, append-only audit log, archivedAt semantics, strict
   comment/issue schemas.

   Run directly against a running emulator:   node --test test/firestore.rules.test.js
   Or self-contained (CI):                     npm run test:rules
   (the latter starts a throwaway Firestore emulator via `firebase emulators:exec`) */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";

const PROJECT_ID = "rules-test-" + Date.now();
let env;

// Seed helper: write a doc bypassing rules (admin context).
async function seed(path, id, data) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path, id), data);
  });
}
// A Firestore handle acting AS a given signed-in uid.
const as = (uid) => env.authenticatedContext(uid).firestore();

const USERS = {
  admin:  { name: "Ada Admin",  role: "admin",  status: "approved" },
  owner:  { name: "Otis Owner", role: "member", status: "approved" },
  qa:     { name: "Quinn QA",   role: "member", status: "approved", qa: true },
  caps:   { name: "Cara Caps",  role: "member", status: "approved", captions: true },
  member: { name: "Mel Member", role: "member", status: "approved" },
  pending:{ name: "Peggy Pend", role: "member", status: "pending" },
};

const baseTask = (over = {}) => ({
  title: "Sunday Reel", type: "Reel", owner: "Otis Owner",
  status: "Planned", activity: [{ type: "created", by: "Ada Admin", at: 1 }],
  ...over,
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  for (const [k, u] of Object.entries(USERS)) await seed("users", k, u);
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); for (const [k, u] of Object.entries(USERS)) await seed("users", k, u); });

/* ---- workflow transitions ---- */

test("owner may Start work (Planned → In Progress); a bystander member may not", async () => {
  await seed("tasks", "t1", baseTask());
  const move = (uid) => updateDoc(doc(as(uid), "tasks", "t1"), {
    status: "In Progress",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "started", by: "Otis Owner", at: 2 }],
    updatedAt: serverTimestamp(),
  });
  await assertSucceeds(move("owner"));
  await seed("tasks", "t1", baseTask());               // reset
  await assertFails(move("member"));                    // not the owner → denied
});

test("only QA/admin may make the QA decision (In Review → Approved)", async () => {
  await seed("tasks", "t2", baseTask({ status: "In Review" }));
  const approve = (uid) => updateDoc(doc(as(uid), "tasks", "t2"), {
    status: "Approved",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "approved", by: "x", at: 2 }],
    updatedAt: serverTimestamp(),
  });
  await assertFails(approve("owner"));                  // owner can't self-approve
  await seed("tasks", "t2", baseTask({ status: "In Review" }));
  await assertSucceeds(approve("qa"));
});

test("only captions/admin may post (Ready to Post → Posted) and it may set archivedAt", async () => {
  await seed("tasks", "t3", baseTask({ status: "Ready to Post" }));
  const post = (uid) => updateDoc(doc(as(uid), "tasks", "t3"), {
    status: "Posted", archivedAt: serverTimestamp(),
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "posted", by: "x", at: 2 }],
    updatedAt: serverTimestamp(),
  });
  await assertFails(post("member"));
  await seed("tasks", "t3", baseTask({ status: "Ready to Post" }));
  await assertSucceeds(post("caps"));
});

test("an invalid status value is rejected for everyone (incl. admin)", async () => {
  await seed("tasks", "t4", baseTask());
  await assertFails(updateDoc(doc(as("admin"), "tasks", "t4"), { status: "Bogus", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("owner"), "tasks", "t4"), { status: "Posted", updatedAt: serverTimestamp() })); // illegal skip
});

test("a skipped transition (Planned → Posted) is denied for a member", async () => {
  await seed("tasks", "t5", baseTask());
  await assertFails(updateDoc(doc(as("owner"), "tasks", "t5"), {
    status: "Posted", updatedAt: serverTimestamp(),
  }));
});

/* ---- audit log + archivedAt integrity ---- */

test("the activity log is append-only — truncation or bulk-forgery is denied", async () => {
  await seed("tasks", "t6", baseTask({ activity: [
    { type: "created", by: "Ada", at: 1 }, { type: "started", by: "Otis", at: 2 }] }));
  // Truncate the history → denied.
  await assertFails(updateDoc(doc(as("owner"), "tasks", "t6"), { activity: [], updatedAt: serverTimestamp() }));
  // Inject two entries at once → denied (at most one per write).
  await assertFails(updateDoc(doc(as("owner"), "tasks", "t6"), {
    activity: [{ type: "created", by: "Ada", at: 1 }, { type: "started", by: "Otis", at: 2 },
               { type: "x", by: "y", at: 3 }, { type: "z", by: "w", at: 4 }],
    updatedAt: serverTimestamp() }));
});

test("a non-admin cannot clear a set archivedAt (no un-archiving history)", async () => {
  await seed("tasks", "t7", baseTask({ status: "Posted", archivedAt: new Date() }));
  await assertFails(updateDoc(doc(as("caps"), "tasks", "t7"), { archivedAt: null, updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as("admin"), "tasks", "t7"), { archivedAt: null, updatedAt: serverTimestamp() }));
});

test("members can't touch protected fields (owner/dates/priority)", async () => {
  await seed("tasks", "t8", baseTask());
  await assertFails(updateDoc(doc(as("owner"), "tasks", "t8"), { owner: "Someone Else", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("owner"), "tasks", "t8"), { priority: "High", updatedAt: serverTimestamp() }));
});

test("an approved member may toggle a reaction, but can't smuggle a status change through it", async () => {
  await seed("tasks", "tr", baseTask());
  // A plain reaction toggle (reactions + updatedAt, no status change) is allowed.
  await assertSucceeds(updateDoc(doc(as("member"), "tasks", "tr"), {
    reactions: { "🔥": ["Mel Member"] }, updatedAt: serverTimestamp(),
  }));
  // The same write may not also jump the workflow (illegal transition denied).
  await assertFails(updateDoc(doc(as("member"), "tasks", "tr"), {
    reactions: { "🔥": ["Mel Member"] }, status: "Approved", updatedAt: serverTimestamp(),
  }));
});

/* ---- comment subcollection schema ---- */

test("a comment must be owned by the caller, well-formed, and size-bounded", async () => {
  await seed("tasks", "t9", baseTask());
  const good = { uid: "member", who: "Mel Member", txt: "looks good", tm: serverTimestamp(), mentions: [] };
  await assertSucceeds(setDoc(doc(as("member"), "tasks/t9/comments", "c1"), good));
  // Spoofed uid → denied.
  await assertFails(setDoc(doc(as("member"), "tasks/t9/comments", "c2"), { ...good, uid: "someone" }));
  // Extra field → denied (strict schema).
  await assertFails(setDoc(doc(as("member"), "tasks/t9/comments", "c3"), { ...good, evil: true }));
  // Oversized text → denied.
  await assertFails(setDoc(doc(as("member"), "tasks/t9/comments", "c4"), { ...good, txt: "x".repeat(2001) }));
  // Pending user → denied.
  await assertFails(setDoc(doc(as("pending"), "tasks/t9/comments", "c5"), { ...good, uid: "pending" }));
});

/* ---- issues schema (#11) ---- */

test("auto-captured errors are allowed for any signed-in user; reports require approval", async () => {
  const err = { uid: "pending", kind: "error", message: "boom", status: "open", createdAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(as("pending"), "issues", "e1"), err));
  // A user-initiated REPORT from a pending user → denied.
  const report = { uid: "pending", kind: "report", note: "hi", status: "open", createdAt: serverTimestamp() };
  await assertFails(setDoc(doc(as("pending"), "issues", "r1"), report));
  await assertSucceeds(setDoc(doc(as("member"), "issues", "r2"), { ...report, uid: "member" }));
});

test("issues reject spoofed uid, arbitrary fields, oversized payloads, bad status", async () => {
  const ok = { uid: "member", kind: "report", note: "x", status: "open", createdAt: serverTimestamp() };
  await assertFails(setDoc(doc(as("member"), "issues", "x1"), { ...ok, uid: "someone" }));      // spoof
  await assertFails(setDoc(doc(as("member"), "issues", "x2"), { ...ok, evil: 1 }));             // extra field
  await assertFails(setDoc(doc(as("member"), "issues", "x3"), { ...ok, note: "x".repeat(4001) })); // oversized
  await assertFails(setDoc(doc(as("member"), "issues", "x4"), { ...ok, status: "resolved" }));  // must be open
  await assertFails(setDoc(doc(as("member"), "issues", "x5"), { ...ok, kind: "spam" }));        // invalid kind
});

test("reminderDigests is server-owned: admin-read, no client write", async () => {
  await seed("reminderDigests", "u1_2026-07-27", { uid: "member", day: "2026-07-27", status: "pending", items: [] });
  await assertFails(getDoc(doc(as("member"), "reminderDigests", "u1_2026-07-27")));
  await assertSucceeds(getDoc(doc(as("admin"), "reminderDigests", "u1_2026-07-27")));
  await assertFails(setDoc(doc(as("admin"), "reminderDigests", "x"), { uid: "x", status: "pending" })); // even admins can't write
});

test("non-admins cannot read the issue log", async () => {
  await seed("issues", "i1", { uid: "member", kind: "report", note: "x", status: "open" });
  await assertFails(getDoc(doc(as("member"), "issues", "i1")));
  await assertSucceeds(getDoc(doc(as("admin"), "issues", "i1")));
});
