/* Capacity engine (v1) — the "3 people / edge cases on paper" artifact, as tests.
   Run with: node --test src/data.capacity.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  responsibilityWeight, responsibilityPhase, responsibilityDate, loadBucket,
  personLoad, workloadBand, weeklyCapacity, staleFlags, autoAssign, toggleId, orderedCrew, loadSummary, crewReason, sameCrew,
} from "./data.js";

// date N days from today, as the app stores it (YYYY-MM-DD)
const d = (n) => { const t = new Date(); t.setHours(0,0,0,0); t.setDate(t.getDate()+n); return t.toISOString().slice(0,10); };

test("role weights: heavy edit outweighs light coordination", () => {
  assert.equal(responsibilityWeight("edit"), 5);
  assert.equal(responsibilityWeight("coordinate"), 1);
  assert.equal(responsibilityWeight("owner"), 2);
  assert.equal(responsibilityWeight("mystery"), 1); // falls back to "other"
});

test("phase is derived from workflow status (no manual per-assignment status)", () => {
  // Owner spans the whole task until Posted.
  for (const s of ["Planned","In Progress","In Review","Approved","Ready to Post"])
    assert.equal(responsibilityPhase("owner", s), "active", s);
  assert.equal(responsibilityPhase("owner", "Posted"), "done");
  // Coordination is pre-production only.
  assert.equal(responsibilityPhase("coordinate", "Planned"), "active");
  assert.equal(responsibilityPhase("coordinate", "In Progress"), "done");
  // Editing: upcoming -> active during production -> done once submitted for QA.
  assert.equal(responsibilityPhase("edit", "Planned"), "upcoming");
  assert.equal(responsibilityPhase("edit", "In Progress"), "active");
  assert.equal(responsibilityPhase("edit", "Changes Requested"), "active");
  assert.equal(responsibilityPhase("edit", "In Review"), "done");
});

test("relevant date: shoot-side uses shootDate, edit/owner use postDate", () => {
  const task = { shootDate: d(2), postDate: d(9) };
  assert.equal(responsibilityDate("shoot", task), d(2));
  assert.equal(responsibilityDate("coordinate", task), d(2));
  assert.equal(responsibilityDate("edit", task), d(9));
  assert.equal(responsibilityDate("owner", task), d(9));
});

test("time buckets, including overdue -> this week and no date -> unscheduled", () => {
  assert.equal(loadBucket(d(-3)), "thisWeek");
  assert.equal(loadBucket(d(0)), "thisWeek");
  assert.equal(loadBucket(d(7)), "thisWeek");
  assert.equal(loadBucket(d(10)), "nextWeek");
  assert.equal(loadBucket(d(20)), "later");
  assert.equal(loadBucket(null), "unscheduled");
});

test("weekly capacity from availability", () => {
  assert.equal(weeklyCapacity({}), 20);
  assert.equal(weeklyCapacity({ limited: true }), 10);
  assert.equal(weeklyCapacity({ available: false }), 0);
});

test("one task splits into different loads per person (per-assignment, not per-task)", () => {
  // Sunday Sermon Reel, mid-production.
  const reel = {
    id: "reel", type: "Reel", status: "In Progress", shootDate: d(-1), postDate: d(4),
    owner: "Kome",
    support: [
      { name: "Esther", role: "shoot" },
      { name: "Tofunmi", role: "edit" },
      { name: "Dola", role: "coordinate" },
      { name: "Sam", role: "shadow" },
    ],
  };
  const tasks = [reel];
  const load = (n) => personLoad({ name: n }, tasks).activePoints;
  assert.equal(load("Kome"), 2);      // owner, active
  assert.equal(load("Esther"), 3);    // shoot, active
  assert.equal(load("Tofunmi"), 5);   // edit, active
  assert.equal(load("Dola"), 0);      // coordination finished once shooting started
  assert.equal(load("Sam"), 0.5);     // shadow, active
});

test("lifecycle: an editor's load switches on and off automatically", () => {
  const base = { id: "t", type: "Reel", postDate: d(6), owner: "X", support: [{ name: "Tofunmi", role: "edit" }] };
  const at = (status) => personLoad({ name: "Tofunmi" }, [{ ...base, status }]);
  assert.equal(at("Planned").upcomingPoints, 2.5);   // 5 * 0.5, not yet started
  assert.equal(at("Planned").activePoints, 0);
  assert.equal(at("In Progress").activePoints, 5);   // active
  assert.equal(at("In Review").activePoints, 0);     // handed to QA -> done
  assert.equal(at("Posted").items.length, 0);        // gone entirely
});

test("owner spans the horizon; a no-date task lands in Unscheduled", () => {
  const tasks = [
    { id: "a", type: "Reel", status: "In Progress", postDate: d(3), owner: "Kome", support: [] },
    { id: "b", type: "Poster", status: "Planned", owner: "Kome", support: [] }, // no dates
  ];
  const load = personLoad({ name: "Kome" }, tasks);
  assert.equal(load.activePoints, 4);                 // owner(2) active on both
  assert.equal(load.buckets.thisWeek.length, 1);      // task a, due in 3 days
  assert.equal(load.buckets.unscheduled.length, 1);   // task b, no date -> not silently "this week"
});

test("band is capacity-relative and only reflects ACTIVE load", () => {
  assert.equal(workloadBand({ available: false }, 10, 20).label, "Unavailable");
  assert.equal(workloadBand({}, 0, 20).label, "Available");
  assert.equal(workloadBand({}, 5, 20).label, "Light");      // 25%
  assert.equal(workloadBand({}, 12, 20).label, "Balanced");  // 60%
  assert.equal(workloadBand({}, 16, 20).label, "Busy");      // 80%
  assert.equal(workloadBand({}, 19, 20).label, "High workload"); // 95%
  // Same 5 points, tighter capacity -> higher band (25% -> 50%).
  assert.equal(workloadBand({}, 5, 20).label, "Light");
  assert.equal(workloadBand({ limited: true }, 5, 10).label, "Balanced");
});

test("staleFlags surface out-of-date statuses (never auto-changes them)", () => {
  assert.deepEqual(staleFlags({ status: "Planned", shootDate: d(-2), postDate: d(5) }), ["shoot-passed-still-planned"]);
  assert.deepEqual(staleFlags({ status: "In Review", postDate: d(-1) }), ["post-passed-not-posted"]);
  assert.deepEqual(staleFlags({ status: "In Progress", postDate: d(5) }), []);
  assert.deepEqual(staleFlags({ status: "Posted", postDate: d(-9) }), []); // done work isn't stale
});

test("accordion: rapid expansion of multiple cards stays independent (keyed by id)", () => {
  // Simulates a user quickly tapping several cards' chevrons.
  let open = new Set();
  open = toggleId(open, "u-a");            // expand A
  assert.deepEqual([...open], ["u-a"]);
  open = toggleId(open, "u-b");            // expand B — A must remain open, B correct
  assert.deepEqual([...open].sort(), ["u-a", "u-b"]);
  open = toggleId(open, "u-c");            // expand C
  assert.deepEqual([...open].sort(), ["u-a", "u-b", "u-c"]);
  open = toggleId(open, "u-a");            // collapse A — B and C untouched
  assert.deepEqual([...open].sort(), ["u-b", "u-c"]);
  // Returns a NEW set each time (no shared, mutated, stale state).
  const before = new Set(["x"]);
  const after = toggleId(before, "y");
  assert.deepEqual([...before], ["x"]);
  assert.deepEqual([...after].sort(), ["x", "y"]);
});

test("each person's load is computed independently — no bleed between cards", () => {
  const tasks = [
    { id: "t1", type: "Reel", status: "In Progress", postDate: "2026-06-01",
      owner: "Ada", support: [{ name: "Ben", role: "edit" }] },
    { id: "t2", type: "Poster", status: "Planned", postDate: "2026-06-20",
      owner: "Cara", support: [] },
  ];
  const ada = personLoad({ name: "Ada" }, tasks);
  const ben = personLoad({ name: "Ben" }, tasks);
  const cara = personLoad({ name: "Cara" }, tasks);
  assert.equal(ada.items.length, 1); assert.equal(ada.items[0].role, "owner");
  assert.equal(ben.items.length, 1); assert.equal(ben.items[0].role, "edit");
  assert.equal(cara.items.length, 1); assert.equal(cara.items[0].role, "owner");
  // Pure + deterministic: recomputing yields identical data (no async/stale response).
  assert.deepEqual(personLoad({ name: "Ben" }, tasks).items, ben.items);
});

test("auto-assign refuses when no content type is chosen (never assumes graphics)", () => {
  const users = [{ name: "David", skills: ["design"], location: ["828"] }];
  assert.deepEqual(autoAssign({ location: "828", owner: "X" }, users), []);       // no type at all
  assert.deepEqual(autoAssign({ type: "", location: "828", owner: "X" }, users), []); // empty type
  // With a real type it still resolves (Poster -> a designer).
  const out = autoAssign({ type: "Poster", location: "828", owner: "X" }, users);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "design");
});

test("graphics auto-assign generalizes — no hardcoded designer name", () => {
  const users = [
    { name: "Grace", skills: ["design"], location: ["828"] },  // designers, none named "David"
    { name: "Kola",  skills: ["design"], location: ["828"] },
    { name: "Sam",   skills: ["shoot"],  location: ["828"] },
  ];
  // Owner is a designer → they design it themselves; no extra crew.
  assert.deepEqual(autoAssign({ type: "Poster", owner: "Grace" }, users), []);
  // Owner is NOT a designer → an available designer (not the owner) is assigned.
  const out = autoAssign({ type: "Poster", owner: "Sam" }, users);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "design");
  assert.ok(["Grace", "Kola"].includes(out[0].name));
  // No designer available at all → nothing (caller surfaces the reason).
  assert.deepEqual(autoAssign({ type: "Poster", owner: "Sam" }, [{ name: "Sam", skills: ["shoot"] }]), []);
});

test("auto-assign is board-aware: a pre-loaded person is passed over", () => {
  const users = [
    { name: "Owner", skills: ["coordinate"], location: ["828"] },
    { name: "EdA", skills: ["edit", "shoot"], location: ["828"] },
    { name: "EdB", skills: ["edit", "shoot"], location: ["828"] },
  ];
  const newTask = { id: "new", type: "Reel", location: "828", owner: "Owner", support: [] };
  // With no board context, equal load -> first eligible (EdA) takes the first role.
  const cold = autoAssign(newTask, users);
  assert.equal(cold.find(a => a.role === "shoot").name, "EdA");
  // EdA already carries a heavy active edit elsewhere -> the lighter EdB is chosen.
  const board = [{ id: "old", type: "Reel", status: "In Progress", postDate: d(3), owner: "Z", support: [{ name: "EdA", role: "edit" }] }];
  const warm = autoAssign(newTask, users, board);
  assert.equal(warm.find(a => a.role === "shoot").name, "EdB");
});

test("production team renders in production order, not insertion order", () => {
  // Added haphazardly by whoever was assigning.
  const support = [
    { name: "Sam", role: "shadow" },
    { name: "Tofunmi", role: "edit" },
    { name: "Dola", role: "coordinate" },
    { name: "Esther", role: "shoot" },
    { name: "Grace", role: "design" },
    { name: "Ada", role: "mystery" },        // unknown role sinks to the end
  ];
  const out = orderedCrew(support);
  assert.deepEqual(out.map(o => o.s.role),
    ["shoot", "edit", "design", "coordinate", "shadow", "mystery"]);
  // Original indices survive so edits/removals still target the right entry.
  assert.equal(out[0].i, 3);   // Esther was index 3
  assert.equal(out[4].i, 0);   // Sam was index 0
  assert.deepEqual(support.map(s => s.name),
    ["Sam", "Tofunmi", "Dola", "Esther", "Grace", "Ada"], "input is not mutated");
  assert.deepEqual(orderedCrew(null), []);
  assert.deepEqual(orderedCrew([{ name: "X" }]).map(o => o.i), [0]); // role-less is safe
});

test("loadSummary is short, and only badges the ends of the scale", () => {
  const tasks = [
    { id:"a", type:"Reel", status:"In Progress", postDate:d(3), owner:"Z", support:[{name:"Jane",role:"edit"}] },
    { id:"b", type:"Reel", status:"In Progress", postDate:d(5), owner:"Z", support:[{name:"Jane",role:"edit"}] },
    { id:"c", type:"Reel", status:"In Progress", postDate:d(4), owner:"Z", support:[{name:"Jane",role:"coordinate"}] },
  ];
  const jane = loadSummary({ name:"Jane" }, tasks);
  assert.equal(jane.detail, "2 due this week");   // coordination is done once shooting starts
  assert.equal(jane.dueThisWeek, 2);

  // Nobody assigned anything -> "Available" IS news, so it gets a chip.
  const idle = loadSummary({ name:"Nobody" }, tasks);
  assert.equal(idle.detail, "Available this week");
  assert.equal(idle.band.key, "available");
  assert.equal(idle.notable, true);
  // A middling load is not news - one line, no coloured chip.
  const mid = loadSummary({ name:"Mid" },
    [{ id:"m", type:"Reel", status:"In Progress", postDate:d(2), owner:"Mid", support:[] },
     { id:"n", type:"Reel", status:"In Progress", postDate:d(2), owner:"Mid", support:[] }]);
  assert.equal(mid.band.key, "light");
  assert.equal(mid.notable, false);
  // Work exists but none of it lands this week.
  const later = loadSummary({ name:"Later" },
    [{ id:"l", type:"Reel", status:"In Progress", postDate:d(30), owner:"Later", support:[] }]);
  assert.equal(later.detail, "Nothing due this week");
  assert.equal(later.upcoming, 1);
  // Unavailable is always worth saying out loud.
  const off = loadSummary({ name:"Away", available:false }, tasks);
  assert.equal(off.detail, "Unavailable");
  assert.equal(off.notable, true);
});

test("no engine vocabulary reaches the user (no points, no internal role names)", () => {
  const tasks = [
    { id:"o1", type:"Reel", status:"In Progress", postDate:d(2), owner:"Lee", support:[] },
    { id:"o2", type:"Reel", status:"In Progress", postDate:d(3), owner:"Lee", support:[] },
  ];
  const users = [{ name:"Lee", skills:["shoot","edit"] }];
  const strings = [
    loadSummary({ name:"Lee" }, tasks).detail,
    crewReason({ name:"Lee", role:"shoot" }, users, tasks),
    crewReason({ name:"Lee", role:"edit" }, users, tasks),
  ];
  for (const s of strings) {
    // "owner" is an internal role key; it must never surface as "pieces to own".
    assert.ok(!/owner|to own|points?\b|weight|bucket|phase|activePoints/i.test(s),
      `leaked engine vocabulary: "${s}"`);
    assert.ok(s.length <= 34, `too long to read at a glance: "${s}"`);
  }
});

test("crewReason recommends in human terms and stays honest when someone is freer", () => {
  const users = [
    { name:"Jordan", skills:["shoot","edit"] },
    { name:"Riley",  skills:["shoot","edit"] },
    { name:"Sam",    skills:["shoot"] },
  ];
  // Jordan carries a live edit; Riley carries nothing.
  const tasks = [{ id:"t1", type:"Reel", status:"In Progress", postDate:d(3),
    owner:"Z", support:[{ name:"Jordan", role:"edit" }] }];

  assert.equal(crewReason({ name:"Riley", role:"edit" }, users, tasks), "Best available editor");
  assert.equal(crewReason({ name:"Riley", role:"shoot" }, users, tasks), "Best available shooter");
  // Jordan is NOT the lightest editor - say what's on his plate, don't oversell.
  assert.equal(crewReason({ name:"Jordan", role:"edit" }, users, tasks), "1 due this week");
  // Lightest of the loaded candidates gets the comparative recommendation.
  const busy = [
    ...tasks,
    { id:"t2", type:"Reel", status:"In Progress", postDate:d(3), owner:"Z", support:[{ name:"Riley", role:"edit" }] },
    { id:"t3", type:"Reel", status:"In Progress", postDate:d(3), owner:"Z", support:[{ name:"Riley", role:"shoot" }] },
  ];
  assert.equal(crewReason({ name:"Jordan", role:"edit" }, users, busy), "Light editing schedule");
  // Shadows are a training decision, not a capacity one.
  assert.equal(crewReason({ name:"Sam", role:"shadow" }, users, tasks), "Learning on this one");
  // Never leaks internals for an unknown or unavailable person.
  assert.equal(crewReason({ name:"Ghost", role:"edit" }, users, tasks), "Available");
  assert.equal(crewReason({ name:"Away", role:"edit" }, [{ name:"Away", available:false, skills:["edit"] }], tasks),
    "Unavailable");
});

test("re-running auto-assign is detectable as a no-op (the button is not dead)", () => {
  const users = [
    { name:"Owner", skills:["coordinate"], location:["828"] },
    { name:"EdA",   skills:["edit","shoot"], location:["828"] },
    { name:"EdB",   skills:["edit","shoot"], location:["828"] },
  ];
  const task = { id:"t", type:"Reel", location:"828", owner:"Owner", support:[] };
  const first  = autoAssign(task, users);
  const second = autoAssign({ ...task, support: first }, users);
  assert.ok(first.length > 0);
  assert.equal(sameCrew(first, second), true, "same inputs must be recognised as the same team");

  // Order must not matter — the UI renders in production order, not insert order.
  assert.equal(sameCrew(first, [...first].reverse()), true);
  // A real difference is still a difference.
  assert.equal(sameCrew(first, first.slice(1)), false);
  assert.equal(sameCrew(first, first.map(c => ({ ...c, name:"Someone Else" }))), false);
  assert.equal(sameCrew(first, first.map(c => ({ ...c, role:"shadow" }))), false);
  // Campus counts: same people, different campus = a different plan.
  assert.equal(sameCrew([{name:"A",role:"shoot",loc:"479"}], [{name:"A",role:"shoot",loc:"828"}]), false);
  // Empty crew edge cases never throw.
  assert.equal(sameCrew([], []), true);
  assert.equal(sameCrew(null, undefined), true);
  assert.equal(sameCrew(null, first), false);
});
