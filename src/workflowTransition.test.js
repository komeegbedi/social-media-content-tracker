/* Shared workflow-transition core — pure, Firebase-free.
   Covers finding 5 (ACTION-specific capability attribution) and the idempotent /
   stale / links / append decision that both the client and the emulator test drive.
   Run: node --test src/workflowTransition.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { workflowCapability, planTransition } from "./workflowTransition.js";

/* ---- finding 5: capability is attributed from the ACTION, not just the profile ---- */
const adminqa = { id: "aq", name: "Andy AdminQA", role: "admin", qa: true };
const caps    = { id: "c",  name: "Cara Caps",    role: "member", captions: true };
const crew    = { id: "m",  name: "Mel Member",   role: "member" };
const qaOnly  = { id: "q",  name: "Quinn QA",     role: "member", qa: true };
const adminOnly = { id: "a", name: "Ada Admin",   role: "admin" };

test("finding 5 · Admin+QA STARTING work records 'admin' (production via Admin, not QA)", () => {
  assert.equal(workflowCapability(adminqa, "started"), "admin");
  assert.equal(workflowCapability(adminqa, "qa_sent"), "admin");
});

test("finding 5 · Admin+QA APPROVING / requesting changes in QA records 'qa'", () => {
  assert.equal(workflowCapability(adminqa, "approved"), "qa");
  assert.equal(workflowCapability(adminqa, "changes_requested"), "qa");
});

test("finding 5 · a captions user marking ready / posted records 'captions'", () => {
  assert.equal(workflowCapability(caps, "ready"), "captions");
  assert.equal(workflowCapability(caps, "posted"), "captions");
});

test("finding 5 · an assigned crew member starting / submitting records 'member'", () => {
  assert.equal(workflowCapability(crew, "started"), "member");
  assert.equal(workflowCapability(crew, "qa_sent"), "member");
});

test("finding 5 · a QA-only user's approval records 'qa'", () => {
  assert.equal(workflowCapability(qaOnly, "approved"), "qa");
});

test("finding 5 · an admin driving posting records 'admin' (governance authority)", () => {
  assert.equal(workflowCapability(adminOnly, "ready"), "admin");
  assert.equal(workflowCapability(adminOnly, "posted"), "admin");
});

/* ---- the shared idempotent / stale / links / append decision (finding 1 at unit level) ---- */
const actor = { uid: "m", name: "Mel Member", cap: "member" };

test("planTransition · already at destination → idempotent success, NO write", () => {
  const r = planTransition({ status: "In Progress", activity: [{ type: "created" }] },
    { fromStatus: "Planned", toStatus: "In Progress", kind: "started", actor });
  assert.equal(r.ok, true);
  assert.equal(r.idempotent, true);
  assert.equal(r.update, undefined, "no write is planned");
});

test("planTransition · unexpected current status → stale, NO write", () => {
  const r = planTransition({ status: "In Review" },
    { fromStatus: "Planned", toStatus: "In Progress", kind: "started", actor });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale");
  assert.equal(r.current, "In Review");
});

test("planTransition · missing required deliverable link on submit → links, NO write", () => {
  const r = planTransition({ status: "In Progress", type: "Reel", links: {} },
    { fromStatus: "In Progress", toStatus: "In Review", kind: "qa_sent", actor });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "links");
});

test("planTransition · a valid advance appends EXACTLY ONE correctly-typed, attributed entry", () => {
  const r = planTransition({ status: "Planned", activity: [{ type: "created", at: 1 }] },
    { fromStatus: "Planned", toStatus: "In Progress", kind: "started", actor });
  assert.equal(r.ok, true);
  assert.equal(r.update.status, "In Progress");
  assert.equal(r.update.activity.length, 2, "created + exactly one appended entry");
  const e = r.update.activity[1];
  assert.equal(e.type, "started");
  assert.equal(e.uid, "m");
  assert.equal(e.cap, "member");
});

test("planTransition · a trashed or missing task is refused without a write", () => {
  assert.deepEqual(planTransition(null, { toStatus: "In Progress", actor }), { ok: false, reason: "gone" });
  assert.deepEqual(planTransition({ deletedAt: 1, status: "Planned" }, { toStatus: "In Progress", actor }),
    { ok: false, reason: "trashed" });
});

test("planTransition · Posted flags archive so the caller stamps archivedAt", () => {
  const r = planTransition({ status: "Ready to Post", type: "Reel", links: { video: "https://drive.google.com/x" } },
    { fromStatus: "Ready to Post", toStatus: "Posted", kind: "posted", actor: { ...actor, cap: "captions" } });
  assert.equal(r.ok, true);
  assert.equal(r.archive, true);
});

/* ---- submit-to-QA link invariant: only VALID http(s) URLs may cross into a gated stage ---- */
const submit = (links, toStatus = "In Review", kind = "qa_sent") =>
  planTransition({ status: "In Progress", type: "Reel", links },
    { fromStatus: "In Progress", toStatus, kind, actor });

test("planTransition · a Reel submit with a blank / whitespace / plain-text / scheme-less link is blocked", () => {
  for (const links of [{}, { video: "" }, { video: "   " }, { video: "coming soon" }, { video: "drive.google.com/x" }, { video: "ftp://a.com/x" }]) {
    const r = submit(links);
    assert.equal(r.ok, false, `links=${JSON.stringify(links)} should block`);
    assert.equal(r.reason, "links");
    assert.equal(r.update, undefined, "no write is planned");
  }
});

test("planTransition · a Reel submit with a valid https URL succeeds and appends qa_sent", () => {
  const r = submit({ video: "https://drive.google.com/file/abc" });
  assert.equal(r.ok, true);
  assert.equal(r.update.status, "In Review");
  assert.equal(r.update.activity[r.update.activity.length - 1].type, "qa_sent");
});

test("planTransition · a Poster needs BOTH graphics valid to submit", () => {
  const poster = (links) => planTransition({ status: "In Progress", type: "Poster", links },
    { fromStatus: "In Progress", toStatus: "In Review", kind: "qa_sent", actor });
  assert.equal(poster({ ig: "https://a.com/ig" }).reason, "links");                              // landscape missing
  assert.equal(poster({ ig: "https://a.com/ig", landscape: "nope" }).reason, "links");           // landscape invalid
  assert.equal(poster({ ig: "https://a.com/ig", landscape: "https://a.com/land" }).ok, true);    // both valid → ok
});

test("planTransition · QA approval of a legacy In Review record with an invalid link is blocked", () => {
  const legacy = { status: "In Review", type: "Reel", links: { video: "tbd" } };
  const approve = planTransition(legacy, { fromStatus: "In Review", toStatus: "Approved", kind: "approved", actor: { ...actor, cap: "qa" } });
  assert.equal(approve.ok, false);
  assert.equal(approve.reason, "links");
  // Requesting changes (a non-gated status) is NOT blocked, so QA can bounce it back.
  const bounce = planTransition(legacy, { fromStatus: "In Review", toStatus: "Changes Requested", kind: "changes_requested", actor: { ...actor, cap: "qa" } });
  assert.equal(bounce.ok, true);
});
