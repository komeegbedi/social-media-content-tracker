/* ===================================================================
   Seed the Firebase Emulator with fake users + tasks for testing.

   Usage:
     1. Terminal A:  npm run emulators
     2. Terminal B:  npm run seed

   The Admin SDK bypasses firestore.rules, so it can create pre-approved
   and admin users directly. Everything is written to the LOCAL emulator
   only — nothing touches production.
   =================================================================== */

// Point the Admin SDK at the running emulators BEFORE importing firebase-admin.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { autoAssign } from "../src/data.js";

const PROJECT_ID = "ifc-social-media-tracker";
const PASSWORD = "password123"; // shared login password for every seeded user

initializeApp({ projectId: PROJECT_ID });
const auth = getAuth();
const db = getFirestore();

/* ---- date helpers (mirror src/data.js, in plain Node) ---- */
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (n) => { const d = today(); d.setDate(d.getDate() + n); return d; };
const iso = (d) => d.toISOString().slice(0, 10);

/* ===================================================================
   FAKE PEOPLE
   - 1 admin (approved), 5 approved members, 2 pending
   - "John Smith" is a designer so the Poster auto-assign path resolves
   =================================================================== */
// All fake/demo accounts for local emulator testing only (never production).
const PEOPLE = [
  { uid: "seed-jane",   name: "Jane Doe",       email: "jane@example.com",
    role: "admin",  status: "approved", skills: ["shoot", "edit", "coordinate"], location: ["479", "828"] },
  { uid: "seed-john",   name: "John Smith",     email: "john@example.com",
    role: "member", status: "approved", skills: ["design", "shoot"],            location: ["828"], qa: true },
  { uid: "seed-alex",   name: "Alex Johnson",   email: "alex@example.com",
    role: "member", status: "approved", skills: ["shoot", "edit"],              location: ["479"],
    department: "Videography", lead: true },
  { uid: "seed-sam",    name: "Sam Taylor",     email: "sam@example.com",
    role: "member", status: "approved", skills: ["edit", "coordinate"],         location: ["828"], captions: true },
  { uid: "seed-jordan", name: "Jordan Lee",     email: "jordan@example.com",
    role: "member", status: "approved", skills: ["shoot", "shadow"],            location: ["479", "828"] },
  { uid: "seed-casey",  name: "Casey Kim",      email: "casey@example.com",
    role: "member", status: "approved", skills: ["coordinate"],                 location: ["479"],
    limited: true },
  // Pending accounts: show up in Admin / People for approval testing.
  { uid: "seed-riley",  name: "Riley Brown",    email: "riley@example.com",
    role: "member", status: "pending",  skills: [], location: [] },
  { uid: "seed-morgan", name: "Morgan Diaz",    email: "morgan@example.com",
    role: "member", status: "pending",  skills: [], location: [] },
];

/* approved users in the shape autoAssign() expects (name/skills/location/flags) */
const assignPool = PEOPLE
  .filter((p) => p.status === "approved" || p.role === "admin")
  .map((p) => ({
    name: p.name, skills: p.skills || [], location: p.location || [],
    deprioritize: !!p.deprioritize, limited: !!p.limited, manualSchedule: !!p.manualSchedule,
  }));

/* ===================================================================
   FAKE TASKS — spans every status, both types, all locations
   =================================================================== */
// `pri`/`next`/`blocked` are optional — they exercise the priority,
// next-action and waiting-on features so My Day has real content to show.
const TASK_SEEDS = [
  { title: "Sunday welcome reel",        type: "Reel",   location: "828",  owner: "Jane Doe", status: "Planned",     shoot: 2,  post: 5,  relatedEvent: "Sunday Service", pri: "High", next: "Needs footage",
    brief: "Goal: make first-time guests feel expected, not just welcomed. 20–30s, warm tone, capture the door greeting + a packed room. Deliverable: 1 vertical reel for IG + a 9:16 cut for stories." },
  { title: "Easter poster series",       type: "Poster", location: "Both", owner: "John Smith",        status: "In Progress", shoot: -1, post: 3,  relatedEvent: "Easter", blocked: "Pastor's theme approval" },
  { title: "Youth night recap",          type: "Reel",   location: "479",  owner: "Alex Johnson",   status: "In Review",   shoot: -4, post: 1,  pri: "High", next: "Needs captions",
    brief: "High-energy recap of Friday youth night. Fast cuts, on-screen captions for the worship moment, end on the altar-call shot. Keep under 45s. Reference: last month's recap that performed well." },
  { title: "Worship moment teaser",      type: "Reel",   location: "828",  owner: "Jordan Lee",  status: "Ready to Post", shoot: -6, post: 1 },
  { title: "Baptism highlights",         type: "Reel",   location: "479",  owner: "Sam Taylor", status: "Posted",      shoot: -12, post: -8 },
  { title: "Midweek service flyer",      type: "Poster", location: "828",  owner: "Alex Johnson",   status: "Planned",     shoot: 4,  post: 7 },
  { title: "Volunteer spotlight",        type: "Reel",   location: "Both", owner: "Jane Doe", status: "Changes Requested", shoot: 1, post: 6 },
  { title: "Guest speaker announcement", type: "Poster", location: "479",  owner: "Sam Taylor", status: "In Review",   shoot: -2, post: 2,  relatedEvent: "Conference", pri: "High" },
  { title: "Behind the scenes setup",    type: "Reel",   location: "828",  owner: "Jordan Lee",  status: "Planned",     shoot: 3,  post: 8 },
  { title: "Testimony short",            type: "Reel",   location: "479",  owner: "Alex Johnson",   status: "In Progress", shoot: 0,  post: 4,  next: "Needs captions" },
  { title: "New series cover art",       type: "Poster", location: "Both", owner: "John Smith",        status: "Approved",    shoot: -3, post: 0,  next: "Ready to post" },
  { title: "Kids ministry promo",        type: "Reel",   location: "828",  owner: "Jane Doe", status: "Planned",     shoot: 6,  post: 10, pri: "Low" },
  { title: "Outreach event recap",       type: "Reel",   location: "479",  owner: "Jordan Lee",  status: "In Review",   shoot: -5, post: -2, relatedEvent: "Community Outreach", blocked: "John Smith's graphics" },
  { title: "Prayer week graphic",        type: "Poster", location: "828",  owner: "Sam Taylor", status: "Posted",      shoot: -15, post: -10 },
  { title: "Sunday sermon clip",         type: "Reel",   location: "Both", owner: "Jane Doe", status: "In Progress", shoot: 2,  post: 5,  pri: "High", next: "Awaiting approval" },
  { title: "Welcome team feature",       type: "Reel",   location: "828",  owner: "Alex Johnson",   status: "Planned",     shoot: 5,  post: 9 },
  { title: "Baptism photo gallery",      type: "Photography", location: "479", owner: "Jordan Lee", status: "Approved",  shoot: -7, post: 1, relatedEvent: "Baptism", next: "Ready to post" },
];

async function seedUsers() {
  for (const p of PEOPLE) {
    // Recreate cleanly so re-seeding is idempotent.
    try { await auth.deleteUser(p.uid); } catch { /* not there yet */ }
    await auth.createUser({ uid: p.uid, email: p.email, password: PASSWORD, displayName: p.name });

    await db.collection("users").doc(p.uid).set({
      name: p.name,
      email: p.email,
      role: p.role,
      status: p.status,
      skills: p.skills || [],
      location: p.location || [],
      department: p.department || "",
      lead: !!p.lead,
      deprioritize: !!p.deprioritize,
      limited: !!p.limited,
      manualSchedule: !!p.manualSchedule,
      qa: !!p.qa,
      captions: !!p.captions,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  console.log(`✓ ${PEOPLE.length} users created`);
}

async function seedTasks() {
  // Clear existing tasks so counts stay predictable across re-seeds.
  const existing = await db.collection("tasks").get();
  await Promise.all(existing.docs.map((d) => d.ref.delete()));

  // Statuses at/after which content has been produced (so links exist).
  const PRODUCED = ["In Review", "Changes Requested", "Approved", "Ready to Post", "Posted"];
  const CAPTIONED = ["Ready to Post", "Posted"];
  for (const s of TASK_SEEDS) {
    const task = {
      title: s.title,
      type: s.type,
      location: s.location,
      owner: s.owner,
      status: s.status,
      priority: s.pri || "Medium",
      blockedOn: s.blocked || "",
      brief: s.brief || "",
      caption: CAPTIONED.includes(s.status) ? "Come and worship with us this Sunday! 🙌 #IFC" : "",
      postLink: s.status === "Posted" ? "https://www.instagram.com/p/example" : "",
      shootDate: iso(addDays(s.shoot)),
      postDate: iso(addDays(s.post)),
      relatedEvent: s.relatedEvent || "",
      link: "",
      notes: "",
      // Content links exist once production has started (required to pass QA).
      links: PRODUCED.includes(s.status)
        ? (s.type === "Poster"
            ? { ig: "https://drive.google.com/example-ig", landscape: "https://drive.google.com/example-landscape" }
            : s.type === "Photography"
            ? { photos: "https://drive.google.com/example-album" }
            : { video: "https://drive.google.com/example-video" })
        : {},
    };
    task.support = autoAssign(task, assignPool);
    // Seed a plausible activity history for the timeline, based on status.
    const now = Date.now();
    const activity = [{ type: "created", by: s.owner, at: now - 6 * 86400000, note: "" }];
    if (s.status !== "Planned")
      activity.push({ type: "started", by: s.owner, at: now - 5 * 86400000, note: "In Progress" });
    if (PRODUCED.includes(s.status))
      activity.push({ type: "qa_sent", by: s.owner, at: now - 3 * 86400000, note: "In Review" });
    if (s.status === "Changes Requested")
      activity.push({ type: "changes_requested", by: "John Smith", at: now - 2 * 86400000, note: "Tighten the first 3 seconds." });
    if (["Approved", "Ready to Post", "Posted"].includes(s.status))
      activity.push({ type: "approved", by: "John Smith", at: now - 2 * 86400000, note: "Approved" });
    if (CAPTIONED.includes(s.status))
      activity.push({ type: "ready", by: "Sam Taylor", at: now - 1 * 86400000, note: "Ready to Post" });
    if (s.status === "Posted")
      activity.push({ type: "posted", by: "Sam Taylor", at: now - 12 * 3600000, note: "Posted" });
    await db.collection("tasks").add({
      ...task,
      comments: [],
      reactions: {},
      activity,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  console.log(`✓ ${TASK_SEEDS.length} tasks created`);
}

async function seedNotifications() {
  // Demo notifications for the admin so the Notification Center is testable
  // before Cloud Functions (Slice 3) start writing real ones. Emulator only.
  const existing = await db.collection("notifications").where("uid", "==", "seed-jane").get();
  await Promise.all(existing.docs.map((d) => d.ref.delete()));

  const oneTask = await db.collection("tasks").limit(1).get();
  const taskId = oneTask.empty ? "" : oneTask.docs[0].id;
  const now = Date.now();
  const demo = [
    { type: "assigned", title: "You've been assigned to 'Sunday welcome reel'", body: "You're leading this piece.", taskId, read: false, ago: 18 * 60000 },
    { type: "reminder", title: "'Easter poster series' is due in 3 days", body: "", taskId, read: false, ago: 3 * 3600000 },
    { type: "changes", title: "Changes requested on 'Youth night recap'", body: "Tighten the first 3 seconds.", taskId, read: false, ago: 26 * 3600000 },
    { type: "approved", title: "'New series cover art' has been approved", body: "", taskId, read: true, ago: 2 * 86400000 },
  ];
  await Promise.all(demo.map((n) => db.collection("notifications").add({
    uid: "seed-jane", type: n.type, title: n.title, body: n.body, taskId: n.taskId || "",
    read: n.read, channels: ["in-app"], dedupeKey: `demo_${n.type}`,
    createdAt: new Date(now - n.ago),
  })));
  console.log(`✓ ${demo.length} demo notifications created (for jane@example.com)`);
}

async function main() {
  console.log(`Seeding emulator (${PROJECT_ID})…`);
  console.log(`  Firestore: ${process.env.FIRESTORE_EMULATOR_HOST}`);
  console.log(`  Auth:      ${process.env.FIREBASE_AUTH_EMULATOR_HOST}\n`);
  await seedUsers();
  await seedTasks();
  await seedNotifications();
  console.log("\nDone. Sign in at the app with any of these:");
  console.log(`  Admin:   jane@example.com   /  ${PASSWORD}`);
  console.log(`  Member:  john@example.com   /  ${PASSWORD}`);
  console.log(`  Pending: riley@example.com  /  ${PASSWORD}  (waits for approval)`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nSeed failed:", err.message);
  console.error("Is the emulator running? Start it with `npm run emulators` first.");
  process.exit(1);
});
