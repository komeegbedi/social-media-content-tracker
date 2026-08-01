/* QA-as-department: QA reviewers are never production personnel — excluded from
   staffing, capacity, recommendations, and search, at the BUSINESS-RULE level
   (even if a stray skill lingers on their doc). Run: node --test src/data.qa.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isQA, isApproved, isProductionMember, isAssignable, isAvailable,
  autoAssign, searchPeople, reviewMetrics, reviewQueue, reviewTiming,
  searchTasks, qaTaskCapabilities, isReviewableState,
} from "./data.js";

// A local-midnight ISO date `off` days from today, so daysTo() returns exactly `off`.
const iso = (off) => {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

test("isProductionMember excludes QA — with NO admin exception", () => {
  const shooter = { status: "approved", skills: ["shoot"] };
  const reviewer = { status: "approved", qa: true };
  const qaAdmin = { role: "admin", qa: true };          // admin AND QA
  assert.equal(isProductionMember(shooter), true);
  assert.equal(isProductionMember(reviewer), false);
  // The critical rule: an admin who is QA is STILL not production personnel.
  assert.equal(isProductionMember(qaAdmin), false);
  // …but they remain an approved org member and an admin.
  assert.equal(isApproved(qaAdmin), true);
  assert.equal(isQA(qaAdmin), true);
});

test("availability stays a pure production flag; QA exclusion is separate", () => {
  const reviewer = { status: "approved", qa: true, available: true };
  // isAvailable reflects only the `available` flag (not conflated with QA)…
  assert.equal(isAvailable(reviewer), true);
  // …but a reviewer is never ASSIGNABLE, regardless of that flag.
  assert.equal(isAssignable(reviewer), false);
});

test("auto-assign never staffs a QA reviewer — even with a leftover skill", () => {
  const users = [
    { name: "Grace", status: "approved", skills: ["design"], location: ["828"] },
    // A QA user whose old design skill hasn't been migrated away yet:
    { name: "Rev",   status: "approved", qa: true, skills: ["design"], location: ["828"] },
  ];
  const out = autoAssign({ type: "Poster", owner: "X", location: "828" }, users);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Grace");                    // the real designer, never Rev
  // If the ONLY candidate is QA, no one is assigned (not the reviewer).
  const onlyQA = [{ name: "Rev", status: "approved", qa: true, skills: ["design"], location: ["828"] }];
  assert.deepEqual(autoAssign({ type: "Poster", owner: "X", location: "828" }, onlyQA), []);
});

test("a QA owner/crew is never auto-recommended for a shoot", () => {
  const users = [
    { name: "Sam", status: "approved", skills: ["shoot", "edit"], location: ["479"] },
    { name: "Rev", status: "approved", qa: true, skills: ["shoot", "edit"], location: ["479"] },
    { name: "Own", status: "approved", skills: ["coordinate"], location: ["479"] },
  ];
  const crew = autoAssign({ type: "Reel", owner: "Own", location: "479" }, users);
  const names = crew.map((c) => c.name);
  assert.ok(names.includes("Sam"));
  assert.ok(!names.includes("Rev"), "QA reviewer must never be recommended as crew");
});

test("search: QA is findable by name/role, never by a production skill term", () => {
  const users = [
    { name: "Jordan Lee", email: "j@x.io", role: "member", status: "approved", skills: ["design"], departments: ["Graphic Design"] },
    { name: "Casey Kim",  email: "c@x.io", role: "member", status: "approved", qa: true, departments: ["QA"] },
  ];
  // A staffing search must not surface QA…
  assert.deepEqual(searchPeople(users, "design").map((u) => u.name), ["Jordan Lee"]);
  // …but QA is still searchable as a person.
  assert.deepEqual(searchPeople(users, "casey").map((u) => u.name), ["Casey Kim"]);
  assert.deepEqual(searchPeople(users, "qa").map((u) => u.name), ["Casey Kim"]);
});

test("reviewMetrics buckets submitted work — a QA concept, not production load", () => {
  const past = "2000-01-01", future = "2999-01-01";
  const tasks = [
    { id: "a", status: "In Review", postDate: future },
    { id: "b", status: "In Review", postDate: past },                                   // overdue review
    { id: "c", status: "Changes Requested", postDate: future },
    { id: "d", status: "Approved", postDate: future, activity: [{ type: "approved", at: 100 }] },
    { id: "e", status: "In Progress", postDate: future },                               // not a review item
  ];
  const m = reviewMetrics(tasks);
  assert.equal(m.counts.awaiting, 2);
  assert.equal(m.counts.overdue, 1);
  assert.deepEqual(m.overdue.map((t) => t.id), ["b"]);
  assert.equal(m.counts.changes, 1);
  assert.deepEqual(m.recentlyReviewed.map((t) => t.id), ["d"]);
});

/* ---- reviewQueue: ONE prioritised queue (each pending review shown once) ---- */

test("reviewQueue: overdue → due-soon → far; the most urgent is upNext, none duplicated", () => {
  const tasks = [
    { id: "far", status: "In Review", postDate: iso(200) },
    { id: "over", status: "In Review", postDate: iso(-4) },   // overdue
    { id: "soon", status: "In Review", postDate: iso(1) },    // due tomorrow
  ];
  const q = reviewQueue(tasks);
  assert.equal(q.upNext.id, "over");
  assert.deepEqual(q.alsoWaiting.map((t) => t.id), ["soon", "far"]);
  const shown = [q.upNext.id, ...q.alsoWaiting.map((t) => t.id)];
  assert.equal(new Set(shown).size, shown.length, "each pending review appears once");
  assert.equal(q.counts.ready, 3);
});

test("reviewQueue: ties break by oldest submission (longest waiting first)", () => {
  const tasks = [
    { id: "newer", status: "In Review", postDate: iso(-3), activity: [{ type: "qa_sent", at: 200 }] },
    { id: "older", status: "In Review", postDate: iso(-3), activity: [{ type: "qa_sent", at: 100 }] },
  ];
  const q = reviewQueue(tasks);
  assert.equal(q.upNext.id, "older");
  assert.deepEqual(q.alsoWaiting.map((t) => t.id), ["newer"]);
});

test("reviewQueue: blocked reviews are separated below actionable, never upNext", () => {
  const tasks = [
    { id: "blk", status: "In Review", postDate: iso(-10), blockedOn: "Uncle Leke" }, // most overdue BUT blocked
    { id: "act", status: "In Review", postDate: iso(2) },
  ];
  const q = reviewQueue(tasks);
  assert.equal(q.upNext.id, "act", "actionable outranks a more-overdue blocked item");
  assert.equal(q.alsoWaiting.length, 0);
  assert.deepEqual(q.blocked.map((t) => t.id), ["blk"]);
  assert.deepEqual(q.counts, { ready: 1, blocked: 1, changes: 0, reviewed: 0 });
});

test("reviewQueue: caught-up when nothing is In Review", () => {
  const q = reviewQueue([{ id: "x", status: "Approved" }, { id: "y", status: "Posted" }]);
  assert.equal(q.upNext, null);
  assert.equal(q.counts.ready, 0);
  assert.equal(q.alsoWaiting.length, 0);
  assert.equal(q.blocked.length, 0);
});

test("reviewQueue: changes + recently-reviewed are separate secondary buckets", () => {
  const tasks = [
    { id: "ch", status: "Changes Requested", postDate: iso(5) },
    { id: "ap", status: "Approved", activity: [{ type: "approved", at: 100 }] },
    { id: "ir", status: "In Review", postDate: iso(3) },
  ];
  const q = reviewQueue(tasks);
  assert.deepEqual(q.changes.map((t) => t.id), ["ch"]);
  assert.deepEqual(q.recentlyReviewed.map((t) => t.id), ["ap"]);
  assert.equal(q.upNext.id, "ir");
});

test("reviewTiming: shown only when it helps (overdue / due soon), else null", () => {
  assert.equal(reviewTiming({ postDate: iso(-3) }).tone, "overdue");
  assert.match(reviewTiming({ postDate: iso(-3) }).text, /3d overdue/);
  assert.equal(reviewTiming({ postDate: iso(0) }).text, "Due today");
  assert.equal(reviewTiming({ postDate: iso(1) }).text, "Due tomorrow");
  assert.equal(reviewTiming({ postDate: iso(3) }).tone, "soon");
  assert.equal(reviewTiming({ postDate: iso(30) }), null, "far future → no timing noise");
  assert.equal(reviewTiming({ postDate: null }), null);
  assert.equal(reviewTiming({}), null);
});

/* ---- QA can OBSERVE production (broad read), even though it can't OPERATE it ---- */

test("QA task search spans every status (planning → posted → archived)", () => {
  const tasks = [
    { id: "p", title: "Easter Planning",   status: "Planned" },
    { id: "r", title: "Easter Production",  status: "In Progress" },
    { id: "c", title: "Easter Changes",     status: "Changes Requested" },
    { id: "a", title: "Easter Approved",    status: "Approved" },
    { id: "x", title: "Easter Posted",      status: "Posted" },
  ];
  // Global task search is viewer-agnostic — it never narrows to review states,
  // so a QA reviewer searching "Easter" sees all of production for context.
  assert.deepEqual(searchTasks(tasks, "easter").map((t) => t.id).sort(),
    ["a", "c", "p", "r", "x"]);
  // And can find a specific in-production task.
  assert.deepEqual(searchTasks(tasks, "production").map((t) => t.id), ["r"]);
});

test("qaTaskCapabilities: review actions ONLY in a reviewable state; production never", () => {
  const inReview = qaTaskCapabilities({ status: "In Review" });
  const inProd   = qaTaskCapabilities({ status: "In Progress" });
  const posted   = qaTaskCapabilities({ status: "Posted" });

  // Observe everywhere.
  for (const c of [inReview, inProd, posted]) {
    assert.equal(c.canView, true);
    assert.equal(c.canViewProductionContext, true);
    assert.equal(c.canComment, true);
    // Operate production — never, in any state.
    assert.equal(c.canEditProduction, false);
    assert.equal(c.canAssignCrew, false);
    assert.equal(c.canChangeOwner, false);
    assert.equal(c.canAutoAssign, false);
    assert.equal(c.canPlanContent, false);
    assert.equal(c.canDelete, false);
  }
  // Review actions gate on state.
  assert.equal(inReview.canReview, true);
  assert.equal(inReview.canApprove, true);
  assert.equal(inReview.canRequestChanges, true);
  assert.equal(inProd.canReview, false);
  assert.equal(posted.canReview, false);
  assert.equal(isReviewableState("In Review"), true);
  assert.equal(isReviewableState("Approved"), false);
});

test("Admin + QA: administers the app, but is NEVER production personnel", () => {
  const qaAdmin = { name: "Ada", role: "admin", qa: true, skills: ["shoot", "edit"], location: ["479"] };
  const shooter = { name: "Ben", role: "member", status: "approved", skills: ["shoot", "edit"], location: ["479"] };
  const owner   = { name: "Cy",  role: "member", status: "approved", skills: ["coordinate"], location: ["479"] };

  // Retains admin authority (that's the isAdmin axis) …
  assert.equal(qaAdmin.role, "admin");
  assert.equal(isApproved(qaAdmin), true);
  // … but admin does NOT buy production eligibility.
  assert.equal(isProductionMember(qaAdmin), false);
  assert.equal(isAssignable(qaAdmin), false);

  // Never auto-assigned, even with real skills at the right location.
  const crew = autoAssign({ type: "Reel", owner: "Cy", location: "479" }, [qaAdmin, shooter, owner]);
  assert.ok(!crew.some((c) => c.name === "Ada"), "admin+QA must not be recommended as crew");
  assert.ok(crew.some((c) => c.name === "Ben"), "the real shooter is chosen instead");

  // Never counted in a production capacity roster (which filters isProductionMember).
  const roster = [qaAdmin, shooter, owner].filter(isProductionMember).map((u) => u.name);
  assert.deepEqual(roster.sort(), ["Ben", "Cy"]);
  assert.ok(!roster.includes("Ada"));
});
