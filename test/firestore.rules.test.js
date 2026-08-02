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
  // Admin and QA are separate axes — a user may hold both. `adminqa` reviews
  // because qa === true; `admin` (below) must NOT be able to review.
  adminqa:{ name: "Andy AdminQA", role: "admin", status: "approved", qa: true },
  caps:   { name: "Cara Caps",  role: "member", status: "approved", captions: true },
  member: { name: "Mel Member", role: "member", status: "approved" },
  pending:{ name: "Peggy Pend", role: "member", status: "pending" },
  // A removed admin: role still says admin, but the disabled kill switch denies it.
  exadmin:{ name: "Ex Admin",   role: "admin",  status: "removed", disabled: true },
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

// Admin and QA are SEPARATE capability axes: the QA decision requires qa === true,
// and the Admin role does NOT inherit it. An Admin's route to Approved-from-In-Review
// is the audited override callable (Admin SDK), never a direct client write.
test("QA decision (In Review → Approved): qa===true only; Admin-only is DENIED", async () => {
  const approve = (uid) => updateDoc(doc(as(uid), "tasks", "t2"), {
    status: "Approved",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "approved", by: "x", uid, at: 2 }],
    updatedAt: serverTimestamp(),
  });
  const reseed = () => seed("tasks", "t2", baseTask({ status: "In Review" }));
  await reseed(); await assertFails(approve("member"));     // Member: no
  await reseed(); await assertFails(approve("owner"));      // owner can't self-approve
  await reseed(); await assertFails(approve("admin"));      // ADMIN-ONLY: no — admin ≠ QA
  await reseed(); await assertSucceeds(approve("qa"));      // QA-only: yes
  await reseed(); await assertSucceeds(approve("adminqa")); // Admin+QA: yes (because qa===true)
});

test("QA decision (In Review → Changes Requested): qa===true only; Admin-only DENIED", async () => {
  const reqChanges = (uid) => updateDoc(doc(as(uid), "tasks", "t2r"), {
    status: "Changes Requested",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "changes_requested", by: "x", uid, at: 2 }],
    updatedAt: serverTimestamp(),
  });
  const reseed = () => seed("tasks", "t2r", baseTask({ status: "In Review" }));
  await reseed(); await assertFails(reqChanges("member"));
  await reseed(); await assertFails(reqChanges("admin"));   // ADMIN-ONLY: no
  await reseed(); await assertSucceeds(reqChanges("qa"));
  await reseed(); await assertSucceeds(reqChanges("adminqa"));
});

test("QA review authority only applies from In Review (Planned → Approved denied for a reviewer)", async () => {
  await seed("tasks", "t2b", baseTask({ status: "Planned" }));
  const approveFrom = (uid) => updateDoc(doc(as(uid), "tasks", "t2b"), {
    status: "Approved",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "approved", by: "x", uid, at: 2 }],
    updatedAt: serverTimestamp(),
  });
  // The QA decision is In Review → Approved | Changes Requested; from anywhere else
  // the reviewer path grants nothing. (An admin may still CORRECT the workflow via
  // the Admin axis — a separate power, verified elsewhere — but qa-only cannot.)
  await assertFails(approveFrom("qa"));
  await assertFails(approveFrom("member"));
});

test("a QA decision must be self-attributed — forging another actor's uid (or omitting it) is denied", async () => {
  await seed("tasks", "t2c", baseTask({ status: "In Review" }));
  // Quinn (qa) records the approval under someone else's uid → denied.
  await assertFails(updateDoc(doc(as("qa"), "tasks", "t2c"), {
    status: "Approved",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "approved", by: "Ada Admin", uid: "admin", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
  // An anonymous review entry (no uid) is also denied.
  await seed("tasks", "t2c", baseTask({ status: "In Review" }));
  await assertFails(updateDoc(doc(as("qa"), "tasks", "t2c"), {
    status: "Approved",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "approved", by: "x", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
});

// The tightened invariant: an Admin-only user can NEVER directly write Approved or
// Changes Requested (from any status), and can never bypass the lifecycle into
// Ready to Post / Posted. Exceptional corrections go through adminOverrideStatus.
const directWrite = (uid, taskId, to, type) => updateDoc(doc(as(uid), "tasks", taskId), {
  status: to,
  activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type, by: "Ada Admin", uid, at: 2 }],
  updatedAt: serverTimestamp(),
});

test("Admin-only CANNOT directly write Approved or Changes Requested from ANY status", async () => {
  for (const from of ["Planned", "In Progress", "In Review", "Changes Requested", "Approved", "Ready to Post"]) {
    if (from !== "Approved") {              // from==to is a no-op field edit, not a transition
      await seed("tasks", "ta", baseTask({ status: from }));
      await assertFails(directWrite("admin", "ta", "Approved", "approved"));
    }
    if (from !== "Changes Requested") {
      await seed("tasks", "ta", baseTask({ status: from }));
      await assertFails(directWrite("admin", "ta", "Changes Requested", "changes_requested"));
    }
  }
});

test("Admin-only Planned → Approved / Changes Requested is denied (spec cases)", async () => {
  await seed("tasks", "tp", baseTask({ status: "Planned" }));
  await assertFails(directWrite("admin", "tp", "Approved", "approved"));
  await seed("tasks", "tp", baseTask({ status: "Planned" }));
  await assertFails(directWrite("admin", "tp", "Changes Requested", "changes_requested"));
});

test("Admin-only cannot bypass the review lifecycle into Ready to Post / Posted", async () => {
  const bypasses = [
    ["Planned", "Ready to Post"], ["Planned", "Posted"],
    ["In Progress", "Ready to Post"], ["In Progress", "Posted"],
    ["In Review", "Posted"],
  ];
  for (const [from, to] of bypasses) {
    await seed("tasks", "tj", baseTask({ status: from }));
    await assertFails(directWrite("admin", "tj", to, "status"));
  }
});

test("Admin-only direct admin_override-LABELLED write remains denied (no forgery)", async () => {
  // Labelling the entry admin_override does not grant the transition — only the
  // server-authored callable (Admin SDK) may produce a genuine override.
  for (const [from, to] of [["In Review", "Approved"], ["Planned", "Posted"], ["Approved", "Changes Requested"]]) {
    await seed("tasks", "to", baseTask({ status: from }));
    await assertFails(directWrite("admin", "to", to, "admin_override"));
  }
});

test("Admin MAY drive the normal FORWARD workflow (owner/caption substitute) and edit fields", async () => {
  // Forward steps the guided workflow grants an admin (as owner-/caption-substitute).
  await seed("tasks", "tf", baseTask({ status: "Planned" }));
  await assertSucceeds(directWrite("admin", "tf", "In Progress", "started"));
  await seed("tasks", "tf", baseTask({ status: "In Progress" }));
  await assertSucceeds(directWrite("admin", "tf", "In Review", "qa_sent"));
  await seed("tasks", "tf", baseTask({ status: "Approved" }));
  await assertSucceeds(directWrite("admin", "tf", "Ready to Post", "ready"));
  await seed("tasks", "tf", baseTask({ status: "Ready to Post" }));
  await assertSucceeds(directWrite("admin", "tf", "Posted", "posted"));
  // Ordinary field edit with NO status change is allowed (admin management).
  await seed("tasks", "tf", baseTask({ status: "In Review" }));
  await assertSucceeds(updateDoc(doc(as("admin"), "tasks", "tf"), {
    title: "Renamed by admin", blockedOn: "waiting on assets", updatedAt: serverTimestamp(),
  }));
});

test("the audited override PATH (server context, like the callable) CAN reach Approved where the direct client write is denied", async () => {
  await seed("tasks", "tc", baseTask({ status: "In Review" }));
  // Direct client write by an admin → denied.
  await assertFails(directWrite("admin", "tc", "Approved", "approved"));
  // The callable writes via the Admin SDK (privileged context), producing a
  // server-authored admin_override event + immutable audit — this succeeds.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    await setDoc(doc(fs, "tasks", "tc"), {
      ...baseTask({ status: "In Review" }), status: "Approved",
      activity: [{ type: "created", by: "Ada Admin", at: 1 },
                 { type: "admin_override", by: "Ada Admin", uid: "admin", cap: "admin",
                   from: "In Review", to: "Approved", reason: "original reviewer unavailable", at: 2 }],
    });
    await setDoc(doc(fs, "auditEvents", "ovr1"), {
      type: "admin_override", taskId: "tc", actorUid: "admin", actorName: "Ada Admin",
      actorCap: "admin", fromStatus: "In Review", toStatus: "Approved", reason: "original reviewer unavailable",
    });
  });
  let after;
  await env.withSecurityRulesDisabled(async (ctx) => {
    after = (await getDoc(doc(ctx.firestore(), "tasks", "tc"))).data();
  });
  assert.equal(after.status, "Approved");
  assert.equal(after.activity[after.activity.length - 1].type, "admin_override", "history says override, not QA-approved");
});

/* ---- a client can never FORGE an admin_override, and QA events must be typed ---- */

test("QA cannot label an approval as admin_override (no forged override)", async () => {
  await seed("tasks", "tq", baseTask({ status: "In Review" }));
  await assertFails(updateDoc(doc(as("qa"), "tasks", "tq"), {
    status: "Approved",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "admin_override", by: "Quinn QA", uid: "qa", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
});

test("Admin cannot label a legal forward transition as admin_override", async () => {
  await seed("tasks", "tq2", baseTask({ status: "Planned" }));
  await assertFails(updateDoc(doc(as("admin"), "tasks", "tq2"), {
    status: "In Progress",   // legal admin forward step, but the override label is a client forgery
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "admin_override", by: "Ada Admin", uid: "admin", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
});

test("a no-op client update cannot append a fake admin_override (any role)", async () => {
  for (const uid of ["admin", "qa", "member"]) {
    await seed("tasks", "tq3", baseTask({ status: "In Progress" }));
    await assertFails(updateDoc(doc(as(uid), "tasks", "tq3"), {
      status: "In Progress",   // no-op status, sneaking an override event into the log
      activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "admin_override", by: "x", uid, at: 2 }],
      updatedAt: serverTimestamp(),
    }));
  }
});

test("QA approval requires an 'approved' event; request-changes requires 'changes_requested'", async () => {
  // Approved destination, wrong event type → denied.
  await seed("tasks", "tq4", baseTask({ status: "In Review" }));
  await assertFails(updateDoc(doc(as("qa"), "tasks", "tq4"), {
    status: "Approved",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "changes_requested", by: "Quinn QA", uid: "qa", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
  // Changes Requested destination, wrong event type → denied.
  await seed("tasks", "tq4", baseTask({ status: "In Review" }));
  await assertFails(updateDoc(doc(as("qa"), "tasks", "tq4"), {
    status: "Changes Requested",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "approved", by: "Quinn QA", uid: "qa", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
  // Correct event types succeed.
  await seed("tasks", "tq4", baseTask({ status: "In Review" }));
  await assertSucceeds(updateDoc(doc(as("qa"), "tasks", "tq4"), {
    status: "Approved",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "approved", by: "Quinn QA", uid: "qa", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
  await seed("tasks", "tq4", baseTask({ status: "In Review" }));
  await assertSucceeds(updateDoc(doc(as("qa"), "tasks", "tq4"), {
    status: "Changes Requested",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "changes_requested", by: "Quinn QA", uid: "qa", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
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

test("a removed/disabled admin is denied everywhere (the disabled kill switch)", async () => {
  await seed("tasks", "td", baseTask());
  // Despite role:"admin", the disabled tombstone can't read tasks or the admin logs.
  await assertFails(getDoc(doc(as("exadmin"), "tasks", "td")));
  await assertFails(getDoc(doc(as("exadmin"), "issues", "i1")));
  await assertFails(getDoc(doc(as("exadmin"), "auditEvents", "x")));
});

test("adminOps + auditEvents are server-owned: admin-read, no client write (audit immutable)", async () => {
  await seed("adminOps", "remove_x", { type: "user_removal", phase: "done" });
  await seed("auditEvents", "remove_x", { type: "user_removed", targetUid: "x" });
  await assertFails(getDoc(doc(as("member"), "adminOps", "remove_x")));
  await assertSucceeds(getDoc(doc(as("admin"), "adminOps", "remove_x")));
  await assertSucceeds(getDoc(doc(as("admin"), "auditEvents", "remove_x")));
  // No client — not even an admin — may write an audit event or op.
  await assertFails(setDoc(doc(as("admin"), "auditEvents", "y"), { type: "forged" }));
  await assertFails(setDoc(doc(as("admin"), "adminOps", "y"), { phase: "done" }));
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
