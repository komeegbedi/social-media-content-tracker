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
import { doc, setDoc, getDoc, updateDoc, deleteDoc, serverTimestamp, deleteField } from "firebase/firestore";

// A fixed project id can be supplied (RULES_TEST_PROJECT) so the emulator's rule
// coverage report can be fetched for THIS run; otherwise a unique per-run id is used.
const PROJECT_ID = process.env.RULES_TEST_PROJECT || ("rules-test-" + Date.now());
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
  // A regular approved member who is NOT owner/crew of the test tasks.
  outsider:{ name: "Odell Outsider", role: "member", status: "approved" },
  pending:{ name: "Peggy Pend", role: "member", status: "pending" },
  // A removed admin: role still says admin, but the disabled kill switch denies it.
  exadmin:{ name: "Ex Admin",   role: "admin",  status: "removed", disabled: true },
};

const baseTask = (over = {}) => ({
  title: "Sunday Reel", type: "Reel", owner: "Otis Owner",
  // A valid Reel deliverable link by default, so a task legitimately at In Review /
  // Approved / Ready to Post / Posted satisfies the link invariant. Tests that
  // exercise the MISSING-link boundary override this with `links: {}` (or a bad value).
  status: "Planned", links: { video: "https://drive.example/reel" },
  activity: [{ type: "created", by: "Ada Admin", at: 1 }],
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
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "started", by: "Otis Owner", uid, at: 2 }],
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

/* ---- Trash (soft-delete) — admin-only, status-preserving, forgery-proof ---- */
const ADMIN_NAME = USERS.admin.name;   // deletedByName must match the caller's profile

test("Trash: ONLY an admin may soft-delete; the owner/member cannot", async () => {
  await seed("tasks", "tt1", baseTask({ status: "In Progress" }));
  const trash = (uid) => updateDoc(doc(as(uid), "tasks", "tt1"), {
    deletedAt: serverTimestamp(), deletedBy: uid, deletedByName: ADMIN_NAME, updatedAt: serverTimestamp(),
  });
  await assertFails(trash("member"));   // not admin
  await assertFails(trash("owner"));    // even the owner cannot trash
  // admin must attribute to THEMSELVES (deletedBy == caller); "admin" ctx uid is "admin".
  await assertSucceeds(updateDoc(doc(as("admin"), "tasks", "tt1"), {
    deletedAt: serverTimestamp(), deletedBy: "admin", deletedByName: ADMIN_NAME, updatedAt: serverTimestamp(),
  }));
});

test("Trash: rejects a FORGED deletedBy (not the caller)", async () => {
  await seed("tasks", "ttf", baseTask({ status: "In Progress" }));
  await assertFails(updateDoc(doc(as("admin"), "tasks", "ttf"), {
    deletedAt: serverTimestamp(), deletedBy: "someone-else", deletedByName: ADMIN_NAME, updatedAt: serverTimestamp(),
  }));
});

test("Trash: rejects a CLIENT timestamp (deletedAt must equal request.time)", async () => {
  await seed("tasks", "ttc", baseTask({ status: "In Progress" }));
  await assertFails(updateDoc(doc(as("admin"), "tasks", "ttc"), {
    deletedAt: 1234567, deletedBy: "admin", deletedByName: ADMIN_NAME, updatedAt: serverTimestamp(),
  }));
});

test("Trash: rejects a MISSING deletedBy", async () => {
  await seed("tasks", "ttm", baseTask({ status: "In Progress" }));
  await assertFails(updateDoc(doc(as("admin"), "tasks", "ttm"), {
    deletedAt: serverTimestamp(), deletedByName: ADMIN_NAME, updatedAt: serverTimestamp(),
  }));
});

test("Trash: rejects a forged deletedByName (not the caller's profile name)", async () => {
  await seed("tasks", "ttn", baseTask({ status: "In Progress" }));
  await assertFails(updateDoc(doc(as("admin"), "tasks", "ttn"), {
    deletedAt: serverTimestamp(), deletedBy: "admin", deletedByName: "Someone Else", updatedAt: serverTimestamp(),
  }));
});

test("Trash: must NOT change status (trash + a legal status transition is denied)", async () => {
  await seed("tasks", "tt2", baseTask({ status: "Approved" }));
  await assertFails(updateDoc(doc(as("admin"), "tasks", "tt2"), {
    deletedAt: serverTimestamp(), deletedBy: "admin", deletedByName: ADMIN_NAME,
    status: "Ready to Post", updatedAt: serverTimestamp(),   // Approved→Ready is legal, but not with trash
  }));
});

test("Restore: ONLY an admin may clear deletedAt; a member cannot un-trash", async () => {
  await seed("tasks", "tt3", baseTask({ status: "Ready to Post", deletedAt: 111, deletedBy: "admin", deletedByName: ADMIN_NAME }));
  const restore = (uid) => updateDoc(doc(as(uid), "tasks", "tt3"), {
    deletedAt: deleteField(), deletedBy: deleteField(), deletedByName: deleteField(), updatedAt: serverTimestamp(),
  });
  await assertFails(restore("member"));
  await assertSucceeds(restore("admin"));
});

test("Restore: PARTIAL marker clearing is denied (all markers must clear together)", async () => {
  await seed("tasks", "tt4", baseTask({ status: "Ready to Post", deletedAt: 111, deletedBy: "admin", deletedByName: ADMIN_NAME }));
  // Clears deletedAt but leaves deletedBy/deletedByName → denied.
  await assertFails(updateDoc(doc(as("admin"), "tasks", "tt4"), {
    deletedAt: deleteField(), updatedAt: serverTimestamp(),
  }));
});

test("Restore: must NOT ride a status change (restore + a legal transition is denied)", async () => {
  await seed("tasks", "tt5", baseTask({ status: "Approved", deletedAt: 111, deletedBy: "admin", deletedByName: ADMIN_NAME }));
  await assertFails(updateDoc(doc(as("admin"), "tasks", "tt5"), {
    deletedAt: deleteField(), deletedBy: deleteField(), deletedByName: deleteField(),
    status: "Ready to Post", updatedAt: serverTimestamp(),
  }));
});

test("While trashed: a member collaboration update is DENIED", async () => {
  await seed("tasks", "tt6", baseTask({ status: "In Progress", owner: "Otis Owner", deletedAt: 111, deletedBy: "admin" }));
  // A normal owner transition that would be legal on an ACTIVE task.
  await assertFails(updateDoc(doc(as("owner"), "tasks", "tt6"), {
    status: "In Review", updatedAt: serverTimestamp(),
  }));
});

test("While trashed: an ADMIN normal field/status edit is DENIED (only Restore is allowed)", async () => {
  await seed("tasks", "tt7", baseTask({ status: "In Progress", deletedAt: 111, deletedBy: "admin", deletedByName: ADMIN_NAME }));
  await assertFails(updateDoc(doc(as("admin"), "tasks", "tt7"), {
    status: "In Review", updatedAt: serverTimestamp(),   // normal admin edit on trashed → denied
  }));
});

test("A normal update cannot sneak in deletedAt via the member allowlist", async () => {
  await seed("tasks", "tt8", baseTask({ status: "In Progress", owner: "Otis Owner" }));
  await assertFails(updateDoc(doc(as("owner"), "tasks", "tt8"), {
    deletedAt: serverTimestamp(), status: "In Review", updatedAt: serverTimestamp(),
  }));
});

test("Comment creation beneath a TRASHED task is denied; beneath an active task it succeeds", async () => {
  await seed("tasks", "tt9", baseTask({ status: "In Progress", deletedAt: 111, deletedBy: "admin" }));
  await seed("tasks", "tt9live", baseTask({ status: "In Progress" }));
  const comment = (taskId) => setDoc(doc(as("member"), "tasks", taskId, "comments", "c1"), {
    uid: "member", who: "Mel Member", txt: "hi", tm: serverTimestamp(), mentions: [],
  });
  await assertFails(comment("tt9"));      // trashed parent → no new collaboration
  await assertSucceeds(comment("tt9live")); // active parent → normal comment
});

test("Create: a task cannot be BORN trashed (client Trash metadata rejected)", async () => {
  await assertFails(setDoc(doc(as("admin"), "tasks", "ttborn"), baseTask({ deletedAt: serverTimestamp(), deletedBy: "admin" })));
  await assertSucceeds(setDoc(doc(as("admin"), "tasks", "ttborn2"), baseTask()));  // clean create OK
});

test("Trash: a MISSING deletedByName is denied (no rule-supplied default)", async () => {
  await seed("tasks", "ttnn", baseTask({ status: "In Progress" }));
  // deletedAt + deletedBy correct, but deletedByName omitted → denied.
  await assertFails(updateDoc(doc(as("admin"), "tasks", "ttnn"), {
    deletedAt: serverTimestamp(), deletedBy: "admin", updatedAt: serverTimestamp(),
  }));
  // Adding the required, matching name → allowed.
  await assertSucceeds(updateDoc(doc(as("admin"), "tasks", "ttnn"), {
    deletedAt: serverTimestamp(), deletedBy: "admin", deletedByName: ADMIN_NAME, updatedAt: serverTimestamp(),
  }));
});

test("HARD DELETE of a task is denied for admins — active AND trashed", async () => {
  await seed("tasks", "delA", baseTask({ status: "In Progress" }));                 // active
  await seed("tasks", "delT", baseTask({ status: "In Progress", deletedAt: 111, deletedBy: "admin", deletedByName: ADMIN_NAME })); // trashed
  await assertFails(deleteDoc(doc(as("admin"), "tasks", "delA")));   // admin cannot hard-delete active
  await assertFails(deleteDoc(doc(as("admin"), "tasks", "delT")));   // admin cannot hard-delete trashed
  await assertFails(deleteDoc(doc(as("member"), "tasks", "delA")));  // member certainly cannot
});

test("HARD DELETE of an event series is denied for the client (even an admin)", async () => {
  await seed("eventSeries", "ev1", { name: "Praise Night", frequency: "monthly-weekday", anchorDate: "2026-09-04", archived: false });
  await assertFails(deleteDoc(doc(as("admin"), "eventSeries", "ev1")));   // retire = archive, never delete
  // Archiving (an update) is still allowed.
  await assertSucceeds(updateDoc(doc(as("admin"), "eventSeries", "ev1"), { archived: true }));
});

test("Comment moderation (create/update/delete) is FROZEN while the parent task is trashed", async () => {
  await seed("tasks", "cparent", baseTask({ status: "In Progress", deletedAt: 111, deletedBy: "admin", deletedByName: ADMIN_NAME }));
  // Seed an existing comment under the trashed task (rules-disabled seed).
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "tasks", "cparent", "comments", "c1"),
      { uid: "member", who: "Mel Member", txt: "old", tm: 1, mentions: [] });
  });
  // create → denied (parent trashed)
  await assertFails(setDoc(doc(as("member"), "tasks", "cparent", "comments", "c2"),
    { uid: "member", who: "Mel Member", txt: "hi", tm: serverTimestamp(), mentions: [] }));
  // admin edit → denied (moderation frozen)
  await assertFails(updateDoc(doc(as("admin"), "tasks", "cparent", "comments", "c1"), { txt: "edited" }));
  // admin delete → denied (moderation frozen)
  await assertFails(deleteDoc(doc(as("admin"), "tasks", "cparent", "comments", "c1")));
});

// FULL comment lifecycle driven through the REAL authenticated Trash/Restore
// transitions (not a seeded deletedAt): active → trash → frozen → restore → thawed.
test("Comment lifecycle across a real admin Trash then Restore", async () => {
  await seed("tasks", "clc", baseTask({ status: "In Progress" }));   // ACTIVE
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "tasks", "clc", "comments", "c1"),
      { uid: "member", who: "Mel Member", txt: "old", tm: 1, mentions: [] });
  });
  const mkComment = (id) => setDoc(doc(as("member"), "tasks", "clc", "comments", id),
    { uid: "member", who: "Mel Member", txt: "hi", tm: serverTimestamp(), mentions: [] });

  // 1. Active parent → member can post, admin can moderate.
  await assertSucceeds(mkComment("c2"));
  await assertSucceeds(updateDoc(doc(as("admin"), "tasks", "clc", "comments", "c1"), { txt: "moderated" }));

  // 2. Admin TRASHES the task through the real Trash transition.
  await assertSucceeds(updateDoc(doc(as("admin"), "tasks", "clc"), {
    deletedAt: serverTimestamp(), deletedBy: "admin", deletedByName: ADMIN_NAME, updatedAt: serverTimestamp(),
  }));

  // 3. While trashed: create/update/delete all denied (thread frozen).
  await assertFails(mkComment("c3"));
  await assertFails(updateDoc(doc(as("admin"), "tasks", "clc", "comments", "c1"), { txt: "nope" }));
  await assertFails(deleteDoc(doc(as("admin"), "tasks", "clc", "comments", "c1")));

  // 4. Admin RESTORES the task through the real Restore transition.
  await assertSucceeds(updateDoc(doc(as("admin"), "tasks", "clc"), {
    deletedAt: deleteField(), deletedBy: deleteField(), deletedByName: deleteField(), updatedAt: serverTimestamp(),
  }));

  // 5. After restore: member can post again, admin moderation works again.
  await assertSucceeds(mkComment("c4"));
  await assertSucceeds(updateDoc(doc(as("admin"), "tasks", "clc", "comments", "c1"), { txt: "moderated again" }));
  await assertSucceeds(deleteDoc(doc(as("admin"), "tasks", "clc", "comments", "c1")));
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
  // Submitting to QA now requires the type's deliverable link at the boundary.
  await seed("tasks", "tf", baseTask({ status: "In Progress", links: { video: "https://drive.example/reel" } }));
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

/* ============================================================================
   ASSIGNED-TEAM PRODUCTION WORKFLOW (UID-based) — feature/assigned-team-workflow
   A task with STABLE uid assignment: owner = Otis(owner), crew = Mel(member, shoot).
   ============================================================================ */
const assignedTask = (over = {}) => baseTask({
  ownerUid: "owner", owner: "Otis Owner",
  support: [{ name: "Mel Member", uid: "member", role: "shoot" }],
  assigneeUids: ["owner", "member"],
  ...over,
});
const VIDEO = { links: { video: "https://drive.example/reel" } };

test("assigned SHOOTER (crew, not owner) can Start work: Planned → In Progress", async () => {
  await seed("tasks", "aw1", assignedTask({ status: "Planned" }));
  await assertSucceeds(directWrite("member", "aw1", "In Progress", "started"));
});

test("assigned EDITOR (crew) can attach the required link AND submit for QA in one write", async () => {
  await seed("tasks", "aw2", assignedTask({ status: "In Progress" }));
  await assertSucceeds(updateDoc(doc(as("member"), "tasks", "aw2"), {
    status: "In Review", links: { video: "https://drive.example/edit" },
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "qa_sent", by: "Mel Member", uid: "member", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
});

test("assigned member can RESUBMIT after changes: Changes Requested → In Review (with link)", async () => {
  await seed("tasks", "aw3", assignedTask({ status: "Changes Requested", ...VIDEO }));
  await assertSucceeds(directWrite("member", "aw3", "In Review", "qa_sent"));
});

test("UNASSIGNED member cannot perform ANY production transition", async () => {
  await seed("tasks", "aw4", assignedTask({ status: "Planned" }));
  await assertFails(directWrite("outsider", "aw4", "In Progress", "started"));
  await seed("tasks", "aw4", assignedTask({ status: "In Progress", ...VIDEO }));
  await assertFails(directWrite("outsider", "aw4", "In Review", "qa_sent"));
});

test("UNASSIGNED member cannot edit production links or blockers; an assignee can", async () => {
  await seed("tasks", "aw5", assignedTask({ status: "In Progress" }));
  await assertFails(updateDoc(doc(as("outsider"), "tasks", "aw5"), { links: { video: "x" }, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("outsider"), "tasks", "aw5"), { blockedOn: "waiting", updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as("member"), "tasks", "aw5"), { blockedOn: "waiting on assets", updatedAt: serverTimestamp() }));
});

test("a member cannot ADD THEIR UID to the assignment and advance status in one request", async () => {
  await seed("tasks", "aw6", assignedTask({ status: "Planned" }));
  await assertFails(updateDoc(doc(as("outsider"), "tasks", "aw6"), {
    assigneeUids: ["owner", "member", "outsider"],
    support: [{ name: "Mel Member", uid: "member", role: "shoot" }, { name: "Odell Outsider", uid: "outsider", role: "edit" }],
    status: "In Progress",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "started", by: "Odell Outsider", uid: "outsider", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
});

test("PENDING / REMOVED / DISABLED assigned users are denied production", async () => {
  await seed("tasks", "aw7", assignedTask({ status: "Planned", assigneeUids: ["owner", "pending", "exadmin"] }));
  await assertFails(directWrite("pending", "aw7", "In Progress", "started"));   // not approved
  await assertFails(directWrite("exadmin", "aw7", "In Progress", "started"));   // disabled/removed
});

test("RENAMING an assigned user does NOT remove access (uid-authoritative)", async () => {
  // Stored owner name is stale, but the crew uid still matches → access preserved.
  await seed("tasks", "aw8", assignedTask({ status: "Planned", owner: "Old Display Name" }));
  await assertSucceeds(directWrite("member", "aw8", "In Progress", "started"));
});

test("MISSING required links are rejected at the boundary on submit to QA", async () => {
  await seed("tasks", "aw9", assignedTask({ status: "In Progress", type: "Reel", links: {} }));
  await assertFails(directWrite("member", "aw9", "In Review", "qa_sent"));       // Reel needs video
  await seed("tasks", "aw9", assignedTask({ status: "In Progress", type: "Poster", links: { ig: "x" } }));
  await assertFails(directWrite("member", "aw9", "In Review", "qa_sent"));       // Poster needs ig + landscape
});

/* ---- Submit-to-QA link invariant: only VALID http(s) URLs pass (the bypass fix) ---- */
test("Reel submit → In Review is DENIED for blank / whitespace / plain-text / scheme-less links", async () => {
  for (const bad of [{}, { video: "" }, { video: "   " }, { video: "tbd later" }, { video: "drive.google.com/x" }, { video: "ftp://a.com/x" }]) {
    await seed("tasks", "lk", assignedTask({ status: "In Progress", type: "Reel", links: bad }));
    await assertFails(directWrite("member", "lk", "In Review", "qa_sent"));
  }
  // A valid https URL submits successfully.
  await seed("tasks", "lk", assignedTask({ status: "In Progress", type: "Reel", links: { video: "https://drive.google.com/file/abc" } }));
  await assertSucceeds(directWrite("member", "lk", "In Review", "qa_sent"));
});

test("Poster submit → In Review needs BOTH graphics valid (one present is not enough)", async () => {
  await seed("tasks", "lp", assignedTask({ status: "In Progress", type: "Poster", links: { ig: "https://a.com/ig" } }));
  await assertFails(directWrite("member", "lp", "In Review", "qa_sent"));                 // landscape missing
  await seed("tasks", "lp", assignedTask({ status: "In Progress", type: "Poster", links: { ig: "https://a.com/ig", landscape: "not-a-url" } }));
  await assertFails(directWrite("member", "lp", "In Review", "qa_sent"));                 // landscape invalid
  await seed("tasks", "lp", assignedTask({ status: "In Progress", type: "Poster", links: { ig: "https://a.com/ig", landscape: "https://a.com/land" } }));
  await assertSucceeds(directWrite("member", "lp", "In Review", "qa_sent"));              // both valid → ok
});

test("direct CREATE into a link-gated status without valid links is denied (blocks import bypass)", async () => {
  // A Reel born straight into In Review with no/invalid links → denied.
  await assertFails(setDoc(doc(as("admin"), "tasks", "cIR"), baseTask({ status: "In Review", links: {} })));
  await assertFails(setDoc(doc(as("admin"), "tasks", "cIR"), baseTask({ status: "In Review", links: { video: "tbd" } })));
  // Later stages too (Approved / Ready to Post / Posted).
  await assertFails(setDoc(doc(as("admin"), "tasks", "cAP"), baseTask({ status: "Approved", links: {} })));
  // With valid links, creating directly at In Review is allowed (a legitimate backfill).
  await assertSucceeds(setDoc(doc(as("admin"), "tasks", "cOK"), baseTask({ status: "In Review", links: { video: "https://drive.google.com/x" } })));
  // Creating in a non-gated status never needs links.
  await assertSucceeds(setDoc(doc(as("admin"), "tasks", "cPL"), baseTask({ status: "Planned", links: {} })));
});

test("QA CANNOT approve a legacy In Review record whose required links are missing/invalid", async () => {
  // A legacy record sitting at In Review with an invalid link (seeded past the boundary).
  await seed("tasks", "leg", assignedTask({ status: "In Review", type: "Reel", links: { video: "not a url" } }));
  await assertFails(updateDoc(doc(as("qa"), "tasks", "leg"), {                            // approve → denied (bad links)
    status: "Approved",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "approved", by: "Quinn QA", uid: "qa", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
  // QA can still bounce it BACK for correction (Changes Requested is not link-gated).
  await assertSucceeds(updateDoc(doc(as("qa"), "tasks", "leg"), {
    status: "Changes Requested",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "changes_requested", by: "Quinn QA", uid: "qa", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
  // Once a valid link is attached, approval succeeds.
  await seed("tasks", "leg", assignedTask({ status: "In Review", type: "Reel", links: { video: "https://drive.google.com/fixed" } }));
  await assertSucceeds(updateDoc(doc(as("qa"), "tasks", "leg"), {
    status: "Approved",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "approved", by: "Quinn QA", uid: "qa", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
});

test("assigned production members CANNOT approve or request changes (QA-only)", async () => {
  await seed("tasks", "aw10", assignedTask({ status: "In Review" }));
  await assertFails(directWrite("member", "aw10", "Approved", "approved"));
  await assertFails(directWrite("owner", "aw10", "Changes Requested", "changes_requested"));
});

test("QA-only user can make QA decisions but CANNOT operate production", async () => {
  await seed("tasks", "aw11", assignedTask({ status: "In Review" }));
  await assertSucceeds(updateDoc(doc(as("qa"), "tasks", "aw11"), {
    status: "Approved",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "approved", by: "Quinn QA", uid: "qa", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
  await seed("tasks", "aw11", assignedTask({ status: "Planned" }));
  await assertFails(directWrite("qa", "aw11", "In Progress", "started"));        // qa not assigned here
});

test("Admin + QA CAN make normal QA decisions (qa === true)", async () => {
  await seed("tasks", "aw12", assignedTask({ status: "In Review" }));
  await assertSucceeds(updateDoc(doc(as("adminqa"), "tasks", "aw12"), {
    status: "Approved",
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "approved", by: "Andy AdminQA", uid: "adminqa", at: 2 }],
    updatedAt: serverTimestamp(),
  }));
});

test("Only Admins may change assignment identity (owner/ownerUid/support/assigneeUids)", async () => {
  await seed("tasks", "aw13", assignedTask({ status: "Planned" }));
  // A member (even an assignee) cannot change the assignment identity fields.
  await assertFails(updateDoc(doc(as("member"), "tasks", "aw13"), { assigneeUids: ["owner"], updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("member"), "tasks", "aw13"), { ownerUid: "member", updatedAt: serverTimestamp() }));
  // Admins can.
  await assertSucceeds(updateDoc(doc(as("admin"), "tasks", "aw13"), {
    ownerUid: "member", owner: "Mel Member", assigneeUids: ["member"], updatedAt: serverTimestamp() }));
});

/* ---- Finding 2: QA-only never operates production, even if (mis)assigned ---- */
test("QA-only is DENIED production even with their uid in ownerUid / support / assigneeUids", async () => {
  await seed("tasks", "qa1", assignedTask({ status: "Planned",
    ownerUid: "qa", owner: "Quinn QA", assigneeUids: ["qa"], support: [{ name: "Quinn QA", uid: "qa", role: "shoot" }] }));
  await assertFails(directWrite("qa", "qa1", "In Progress", "started"));            // no Start work
  await seed("tasks", "qa1", assignedTask({ status: "In Progress", ownerUid: "qa", owner: "Quinn QA", assigneeUids: ["qa"], links: { video: "x" } }));
  await assertFails(directWrite("qa", "qa1", "In Review", "qa_sent"));              // no Submit for QA
  await assertFails(updateDoc(doc(as("qa"), "tasks", "qa1"), { links: { video: "y" }, updatedAt: serverTimestamp() })); // no links edit
  await assertFails(updateDoc(doc(as("qa"), "tasks", "qa1"), { blockedOn: "z", updatedAt: serverTimestamp() }));         // no blocker edit
});
test("Admin + QA CAN operate production via Admin authority", async () => {
  await seed("tasks", "aq1", assignedTask({ status: "Planned", assigneeUids: [] }));  // not assigned, but admin
  await assertSucceeds(directWrite("adminqa", "aq1", "In Progress", "started"));
});

/* ---- Finding 7: legacy fallback only when the assigneeUids FIELD is absent ---- */
test("legacy fallback: NO assigneeUids field → owner-name fallback authorizes the owner", async () => {
  await seed("tasks", "lf1", baseTask({ status: "Planned" }));   // baseTask has no assigneeUids field
  await assertSucceeds(directWrite("owner", "lf1", "In Progress", "started"));
});
test("assigneeUids: [] (present, empty) → NO name fallback; nobody is an assignee", async () => {
  await seed("tasks", "lf2", baseTask({ status: "Planned", assigneeUids: [] }));
  await assertFails(directWrite("owner", "lf2", "In Progress", "started"));   // owner NOT authorized by name
});
test("partially-migrated task: only STORED uids authorize (owner name ignored)", async () => {
  await seed("tasks", "lf3", baseTask({ status: "Planned", owner: "Otis Owner", assigneeUids: ["member"] }));
  await assertFails(directWrite("owner", "lf3", "In Progress", "started"));       // owner not in stored uids
  await assertSucceeds(directWrite("member", "lf3", "In Progress", "started"));   // member is in stored uids
});

/* ---- Finding 1: activity discipline (transition ⟹ 1 entry; same-status ⟹ none) ---- */
test("a STATUS-PRESERVING edit cannot modify or append activity", async () => {
  await seed("tasks", "ac1", assignedTask({ status: "In Progress", activity: [{ type: "created", by: "Ada Admin", at: 1 }] }));
  await assertFails(updateDoc(doc(as("member"), "tasks", "ac1"), {   // same status, appends an entry → denied
    blockedOn: "waiting", activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "note", by: "Mel Member", uid: "member", at: 2 }],
    updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as("member"), "tasks", "ac1"), { blockedOn: "waiting", updatedAt: serverTimestamp() })); // no activity change → ok
});
test("a REAL transition requires exactly one appended, self-attributed entry", async () => {
  await seed("tasks", "ac2", assignedTask({ status: "Planned", activity: [{ type: "created", by: "Ada Admin", at: 1 }] }));
  await assertFails(updateDoc(doc(as("member"), "tasks", "ac2"), { status: "In Progress", updatedAt: serverTimestamp() })); // transition, 0 entries → denied
  await assertSucceeds(updateDoc(doc(as("member"), "tasks", "ac2"), {
    status: "In Progress", activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "started", by: "Mel Member", uid: "member", at: 2 }],
    updatedAt: serverTimestamp() }));
});

/* ---- Finding 8: production-field authority (links/blockers vs caption/postLink) ---- */
test("caption / final post-link: only captions-authorized or Admin may change them", async () => {
  await seed("tasks", "cp1", assignedTask({ status: "Ready to Post" }));
  await assertFails(updateDoc(doc(as("member"),  "tasks", "cp1"), { caption: "x", updatedAt: serverTimestamp() }));            // assignee w/o captions → denied
  await assertFails(updateDoc(doc(as("outsider"),"tasks", "cp1"), { postLink: "https://ig/x", updatedAt: serverTimestamp() })); // unassigned → denied
  await assertFails(updateDoc(doc(as("qa"),      "tasks", "cp1"), { caption: "x", updatedAt: serverTimestamp() }));            // QA → denied
  await assertSucceeds(updateDoc(doc(as("caps"), "tasks", "cp1"), { caption: "final caption", updatedAt: serverTimestamp() })); // captions → ok
  await assertSucceeds(updateDoc(doc(as("admin"),"tasks", "cp1"), { postLink: "https://ig/y", updatedAt: serverTimestamp() })); // admin → ok
});
test("links & blockers: unassigned member's handcrafted request is denied; QA read-only", async () => {
  await seed("tasks", "cp2", assignedTask({ status: "In Progress" }));
  await assertFails(updateDoc(doc(as("outsider"), "tasks", "cp2"), { links: { video: "x" }, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("qa"),       "tasks", "cp2"), { blockedOn: "x", updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as("member"),"tasks", "cp2"), { links: { video: "https://drive/x" }, updatedAt: serverTimestamp() })); // assignee → ok
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

/* ---- Finding 2: EVERY production/posting transition must record its EXACT event type ---- */
test("production/posting transitions succeed with the destination's correct event type", async () => {
  await seed("tasks", "et", assignedTask({ status: "Planned" }));
  await assertSucceeds(directWrite("member", "et", "In Progress", "started"));           // → In Progress = started
  await seed("tasks", "et", assignedTask({ status: "In Progress", ...VIDEO }));
  await assertSucceeds(directWrite("member", "et", "In Review", "qa_sent"));             // → In Review = qa_sent
  await seed("tasks", "et", assignedTask({ status: "Changes Requested", ...VIDEO }));
  await assertSucceeds(directWrite("member", "et", "In Review", "qa_sent"));             // resubmit = qa_sent
  await seed("tasks", "et", baseTask({ status: "Approved" }));
  await assertSucceeds(directWrite("caps", "et", "Ready to Post", "ready"));             // → Ready to Post = ready
  await seed("tasks", "et", baseTask({ status: "Ready to Post" }));
  await assertSucceeds(directWrite("caps", "et", "Posted", "posted"));                   // → Posted = posted
});

test("production/posting transitions with a WRONG or forged event type are DENIED", async () => {
  await seed("tasks", "ex", assignedTask({ status: "Planned" }));
  await assertFails(directWrite("member", "ex", "In Progress", "approved"));             // must be 'started'
  await seed("tasks", "ex", assignedTask({ status: "In Progress", ...VIDEO }));
  await assertFails(directWrite("member", "ex", "In Review", "started"));                // must be 'qa_sent'
  await seed("tasks", "ex", baseTask({ status: "Approved" }));
  await assertFails(directWrite("caps", "ex", "Ready to Post", "posted"));               // must be 'ready'
  await seed("tasks", "ex", baseTask({ status: "Ready to Post" }));
  await assertFails(directWrite("caps", "ex", "Posted", "ready"));                       // must be 'posted'
  await seed("tasks", "ex", assignedTask({ status: "Planned" }));
  await assertFails(directWrite("member", "ex", "In Progress", "status"));               // generic/forged type
});

test("a production transition that appends NO event (missing type) is denied", async () => {
  await seed("tasks", "en", assignedTask({ status: "Planned" }));
  await assertFails(updateDoc(doc(as("member"), "tasks", "en"), { status: "In Progress", updatedAt: serverTimestamp() }));
});

test("Admin normal FORWARD workflow uses NORMAL event types, never admin_override", async () => {
  await seed("tasks", "an", baseTask({ status: "Planned" }));
  await assertSucceeds(directWrite("admin", "an", "In Progress", "started"));            // normal type OK
  await seed("tasks", "an", baseTask({ status: "Planned" }));
  await assertFails(directWrite("admin", "an", "In Progress", "admin_override"));        // override label forbidden client-side
  await seed("tasks", "an", baseTask({ status: "Approved" }));
  await assertSucceeds(directWrite("admin", "an", "Ready to Post", "ready"));            // posting via admin uses 'ready'
});

test("only captions/admin may post (Ready to Post → Posted) and it may set archivedAt", async () => {
  await seed("tasks", "t3", baseTask({ status: "Ready to Post" }));
  const post = (uid) => updateDoc(doc(as(uid), "tasks", "t3"), {
    status: "Posted", archivedAt: serverTimestamp(),
    activity: [{ type: "created", by: "Ada Admin", at: 1 }, { type: "posted", by: "x", uid, at: 2 }],
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

test("comment schema accepts the mention fields (mentionNames, mentionAll) with bounds", async () => {
  await seed("tasks", "tm", baseTask());
  const base = { uid: "member", who: "Mel Member", txt: "hey @Bo Crew and @everyone", tm: serverTimestamp() };
  // A full mention payload is accepted.
  await assertSucceeds(setDoc(doc(as("member"), "tasks/tm/comments", "ok1"), {
    ...base, mentions: ["bo"], mentionNames: ["Bo Crew"], mentionAll: true }));
  // A group-only mention (@everyone) with no individual uids is accepted.
  await assertSucceeds(setDoc(doc(as("member"), "tasks/tm/comments", "ok2"), { ...base, mentionAll: true }));
  // mentionAll must be a BOOL.
  await assertFails(setDoc(doc(as("member"), "tasks/tm/comments", "bad1"), { ...base, mentionAll: "yes" }));
  // mentionNames must be a LIST, bounded at 20.
  await assertFails(setDoc(doc(as("member"), "tasks/tm/comments", "bad2"), { ...base, mentionNames: "Bo" }));
  await assertFails(setDoc(doc(as("member"), "tasks/tm/comments", "bad3"), {
    ...base, mentionNames: Array.from({ length: 21 }, (_, i) => "N" + i) }));
  // An unknown field is STILL rejected — the schema stays strict.
  await assertFails(setDoc(doc(as("member"), "tasks/tm/comments", "bad4"), { ...base, mentionsAll: true }));
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
