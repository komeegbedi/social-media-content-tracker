/* ===================================================================
   Seed the Firebase Emulator with fake users + tasks for testing.

   Usage:
     1. Terminal A:  npm run emulators
     2. Terminal B:  npm run seed

   The Admin SDK bypasses firestore.rules, so it can create pre-approved
   and admin users directly. Everything is written to the LOCAL emulator
   only — nothing touches production.
   =================================================================== */

// An ISOLATED test project may be seeded instead of the dev emulators — but only a
// throwaway demo-* project, and only with explicit emulator hosts that aren't the
// dev ones (this script deletes existing tasks/notifications before seeding).
const SEED_PROJECT = process.env.SEED_PROJECT_ID || "";
if (SEED_PROJECT) {
  if (!/^demo-[a-z0-9-]+$/.test(SEED_PROJECT)) throw new Error(`seed: SEED_PROJECT_ID must be a demo-* project (got "${SEED_PROJECT}")`);
  const hosts = [process.env.FIRESTORE_EMULATOR_HOST, process.env.FIREBASE_AUTH_EMULATOR_HOST, process.env.FIREBASE_STORAGE_EMULATOR_HOST];
  if (hosts.some((h) => !h) || hosts.some((h) => /:(8080|9099|9199)$/.test(h))) throw new Error("seed: an isolated project needs explicit, non-dev emulator hosts (FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_STORAGE_EMULATOR_HOST)");
}
// Point the Admin SDK at the running emulators BEFORE importing firebase-admin.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
process.env.FIREBASE_STORAGE_EMULATOR_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { deflateSync } from "node:zlib";
import { autoAssign } from "../src/data.js";

const PROJECT_ID = SEED_PROJECT || "ifc-social-media-tracker";
const PASSWORD = "password123"; // shared login password for every seeded user

// Upload to the SAME bucket the web app reads (VITE_FIREBASE_STORAGE_BUCKET in
// .env). Using a different default bucket made every seeded image 404 in the app.
import { readFileSync as _readEnv } from "node:fs";
const STORAGE_BUCKET = (() => {
  if (SEED_PROJECT) return process.env.SEED_STORAGE_BUCKET || `${SEED_PROJECT}.appspot.com`;
  try { const m = _readEnv(new URL("../.env", import.meta.url), "utf8").match(/^VITE_FIREBASE_STORAGE_BUCKET=(.+)$/m); if (m && m[1].trim()) return m[1].trim(); } catch {}
  return `${PROJECT_ID}.appspot.com`;
})();
initializeApp({ projectId: PROJECT_ID, storageBucket: STORAGE_BUCKET });
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
  // QA reviewer — a distinct, non-production department: no skills, no location,
  // not production-available. Reviews and approves content only.
  { uid: "seed-john",   name: "John Smith",     email: "john@example.com",
    role: "member", status: "approved", qa: true, departments: ["QA"], skills: [], location: [], available: false },
  { uid: "seed-alex",   name: "Alex Johnson",   email: "alex@example.com",
    role: "member", status: "approved", skills: ["shoot", "edit"],              location: ["479"],
    department: "Videography", lead: true, academyEditor: true },
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
      ...(p.academyEditor ? { academyEditor: true } : {}),
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

/* ===================================================================
   IFC CREATIVE ACADEMY — fictional courses for the Learn section.
   Everything here is invented demo content (never production). Covers are
   generated PNGs uploaded to the STORAGE EMULATOR so the catalogue renders
   real artwork; if the storage emulator isn't running, courses are seeded
   without covers (the UI shows a placeholder).
   =================================================================== */
function makePng(w, h, pixel) {
  // Minimal PNG encoder (8-bit RGB, no filter) — enough for a flat demo cover.
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const [r, g, b] = pixel(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const coverArt = (hue) => makePng(300, 400, (x, y) => {
  // Two-tone diagonal with a soft band — reads as "artwork", not a title card.
  const t = (x + y) / 700;
  const band = Math.abs(((x * 0.7 - y * 0.4) % 90) - 45) < 6 ? 0.12 : 0;
  const base = hue.map((c, i) => Math.round(c * (0.65 + 0.35 * t) + 255 * band * (i === 2 ? 1 : 0.6)));
  return base.map((v) => Math.max(0, Math.min(255, v)));
});

async function uploadCover(path, png) {
  const file = getStorage().bucket().file(path);
  await file.save(png, { contentType: "image/png", metadata: { cacheControl: "private, max-age=3600" } });
  return { path, version: path.split("/").pop().replace(/\.png$/, ""), contentType: "image/png", bytes: png.length, w: 300, h: 400 };
}

const yt = (id) => ({ provider: "youtube", id });
const q = (id, prompt, options, multi = false) => ({ id, prompt, multi, options: options.map(([oid, text]) => ({ id: oid, text })) });

const COURSES = [
  {
    id: "seed-course-light", title: "Light & Composition for Sunday (demo)", category: "photography", level: "beginner", topics: ["Exposure, composition, and lighting", "Service and event coverage"],
    hue: [94, 106, 210],
    about: "*Local demo content. Not official IFC material.*\n\n# Why this matters\n\nGreat photos of our gatherings start with **seeing light**. This short course walks through the three things that make a frame feel intentional: light, framing and timing.\n\n- Shoot in the room you actually have\n- Make the subject obvious\n- Capture moments, not poses",
    outcomes: ["Read the light in the auditorium before the first song", "Frame a speaker without the lectern taking over", "Pick a moment worth posting from 200 frames"],
    requirements: ["Any camera (a phone is fine)", "Access to a Sunday gathering"],
    modules: [
      { id: "m1", title: "Seeing light", lessons: [
        { id: "l1", title: "What the room gives you", video: yt("dQw4w9WgXcQ"), durationMinutes: 8,
          description: "## Before you start\n\nWatch how the stage lights change between worship and the message.\n\n1. Stand at the back for one song\n2. Notice where faces are brightest\n3. Pick your spot *before* you lift the camera", resources: [{ label: "Exposure cheat sheet", url: "https://example.org/academy/exposure" }],
          quiz: { mode: "practice", passMark: 60, retryLimit: 0, questions: [q("a", "Where are faces usually brightest during worship?", [["x", "Under the key light"], ["y", "At the back wall"], ["z", "Behind the haze"]])] },
          key: { a: ["x"] }, explain: { a: "Key light is aimed at the stage edge — that's where faces pop." } },
        { id: "l2", title: "Framing a speaker", video: yt("dQw4w9WgXcQ"), durationMinutes: 11,
          description: "Keep the lectern low in the frame and give the speaker room to look into.",
          quiz: { mode: "required", passMark: 70, retryLimit: 3, questions: [
            q("b1", "Which TWO help a speaker frame?", [["p", "Lead room in the look direction"], ["q", "Centre the lectern"], ["r", "Keep horizon lines level"]], true),
            q("b2", "Best lens choice from the mid-floor?", [["s", "Wide 16mm"], ["t", "Short tele 85mm"], ["u", "Fisheye"]]),
          ] }, key: { b1: ["p", "r"], b2: ["t"] }, explain: { b1: "Lead room + level lines are the two framing habits that matter most.", b2: "A short telephoto compresses the stage and isolates the speaker." } },
      ] },
      { id: "m2", title: "Moments", lessons: [
        { id: "l3", title: "Choosing the frame to post", video: yt("dQw4w9WgXcQ"), durationMinutes: 6, description: "Cull fast: pick the three that tell the story, then pick one." },
        { id: "l4", title: "Bonus: a phone-only workflow", video: yt("dQw4w9WgXcQ"), durationMinutes: 5, bonus: true, description: "Everything above, on the device in your pocket." },
      ] },
    ],
  },
  {
    // Production side of short-form video → Filmmaking (was "social-media" in the first build).
    id: "seed-course-reels", title: "Filming Short-Form Video (demo)", category: "filmmaking", level: "intermediate", topics: ["Short-form video production", "Instagram Reels", "Video editing and colour grading"],
    hue: [197, 139, 27],
    about: "*Local demo content. Not official IFC material.*\n\nShooting and cutting vertical video for a church audience: the hook shot, pacing and a clean edit.",
    outcomes: ["Shoot a 3-second hook", "Cut to the beat without losing the message", "Export a vertical master"],
    modules: [
      { id: "m1", title: "", lessons: [
        { id: "l1", title: "The first three seconds", video: { provider: "vimeo", id: "76979871" }, durationMinutes: 9, description: "Open on the moment, not the logo." },
        { id: "l2", title: "Pacing and the edit", video: { provider: "gdrive", id: "1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456" }, durationMinutes: 12,
          description: "This lesson is hosted on Google Drive, so playback isn't tracked — mark it done when you've watched it.",
          resources: [{ label: "Edit checklist (demo)", url: "https://example.org/academy/edit-checklist" }] },
      ] },
    ],
  },
  {
    // Publishing / strategy side → Social Media & Storytelling.
    id: "seed-course-captions", title: "Captions, Hooks & Publishing (demo)", category: "social-media-storytelling", level: "beginner", topics: ["Captions and hooks", "Testing posting times for our audience", "Understanding results and improving future content"],
    hue: [94, 160, 120],
    about: "*Local demo content. Not official IFC material.*\n\nDeciding what to say, writing it for sound-off viewing, and learning from what happened after you posted.",
    outcomes: ["Write a caption that stands on its own", "Pick a posting time on purpose", "Read the response without chasing numbers"],
    modules: [
      { id: "m1", title: "", lessons: [
        { id: "l1", title: "Writing the caption", video: yt("dQw4w9WgXcQ"), durationMinutes: 7, description: "Say the one thing. Then stop." },
        { id: "l2", title: "Reading the response", video: yt("dQw4w9WgXcQ"), durationMinutes: 6, description: "Comments and saves tell you more than likes." },
      ] },
    ],
  },
  {
    id: "seed-course-heart", title: "Why We Serve: An Introduction (demo)", category: "heart-of-serving", level: "beginner", topics: ["Why we serve", "Receiving feedback"],
    hue: [120, 90, 170],
    about: "*Local demo content. Not official IFC material. Example values here are placeholders, not approved statements.*\n\nA short orientation for anyone joining the creative team.",
    outcomes: ["Describe who our content serves", "Know how feedback works on this team"],
    modules: [{ id: "m1", title: "", lessons: [
      { id: "l1", title: "People first", video: yt("dQw4w9WgXcQ"), durationMinutes: 5, description: "The camera is in the room for the people in the room." },
      { id: "l2", title: "How feedback works here", video: null, durationMinutes: 3, description: "Text lesson (demo): notes are about the work, never the person. Mark it done when you've read it." },
    ] }],
  },
  {
    id: "seed-course-worship", title: "Lyric Slides That Don't Distract (demo)", category: "worship-visuals", level: "beginner", topics: ["Layout, typography, and colour"],
    hue: [90, 60, 150],
    about: "*Local demo content.* Published, but filed under a HIDDEN category, so learners can't see it until the category is shown again.",
    outcomes: ["Keep lyric slides legible from the back row"],
    modules: [{ id: "m1", title: "", lessons: [{ id: "l1", title: "Contrast and line length", kind: "written", video: null, durationMinutes: 4, description: "Two lines per slide; never centred body text over a busy background." }] }],
  },
  // ---- Filmmaking demo courses (category page example set) ----
  {
    id: "seed-course-camera", title: "Camera Fundamentals (demo)", category: "filmmaking", level: "beginner", topics: ["Digital cameras and exposure"],
    hue: [60, 70, 120],
    about: "*Local demo content. Not official IFC training.*\n\nHow a camera turns light into an image, and the three settings you'll touch on every shoot.",
    outcomes: ["Set exposure by hand", "Choose a frame rate for the job", "Nail focus on a moving subject"],
    previewVideo: yt("dQw4w9WgXcQ"),
    modules: [
      { id: "m1", title: "Exposure", lessons: [
        { id: "l1", title: "The exposure triangle", kind: "video", video: yt("dQw4w9WgXcQ"), durationMinutes: 9, description: "Aperture, shutter and ISO — and what each one costs you." },
        { id: "l2", title: "Reading a histogram", kind: "written", video: null, durationMinutes: 4, description: "## What you're looking at\n\nThe histogram is a count of pixels by brightness. If it's piled against the right edge you've clipped the highlights — and there's no getting them back.\n\n- Expose for the faces\n- Protect the highlights on skin\n- Shadows are forgiving" },
        { id: "l3", title: "Exercise: manual exposure walk", kind: "exercise", video: null, durationMinutes: 20, description: "Take the camera outside at golden hour. Make **ten** frames in full manual, changing only one setting between each. Note what you changed and why.\n\nMark the exercise complete when you've done it — nobody checks the frames; this is for you." },
      ] },
      { id: "m2", title: "Motion", lessons: [
        { id: "l4", title: "Frame rate and shutter angle", kind: "video", video: yt("dQw4w9WgXcQ"), durationMinutes: 8, description: "Why 24 fps at 1/50 looks like film." },
        { id: "l5", title: "Reference: camera menus cheat sheet", kind: "resource", video: null, durationMinutes: 3, description: "Two one-page references for the cameras in our kit.", resources: [{ label: "Camera A quick settings (demo)", url: "https://example.org/academy/camera-a" }, { label: "Camera B quick settings (demo)", url: "https://example.org/academy/camera-b" }] },
      ] },
    ],
  },
  {
    id: "seed-course-lighting", title: "Lighting Fundamentals (demo)", category: "filmmaking", level: "beginner", topics: ["Cinematography, lighting, framing, and movement"],
    hue: [160, 110, 40],
    about: "*Local demo content. Not official IFC training.*\n\nOne light, then two, then the room you actually have on a Sunday.",
    outcomes: ["Place a key light for an interview", "Control contrast with negative fill"],
    modules: [{ id: "m1", title: "", lessons: [
      { id: "l1", title: "One light, one face", kind: "video", video: yt("dQw4w9WgXcQ"), durationMinutes: 11, description: "Key light position and what it says about the subject." },
      { id: "l2", title: "Exercise: light a chair", kind: "exercise", video: null, durationMinutes: 15, description: "Light an empty chair three ways: soft, hard, backlit. Photograph each." },
    ] }],
  },
  {
    id: "seed-course-resolve", title: "DaVinci Resolve Essentials (demo)", category: "filmmaking", level: "intermediate", topics: ["Video editing and colour grading", "DaVinci Resolve"],
    hue: [40, 90, 110],
    about: "*Local demo content. Not official IFC training.*\n\nImport, cut, grade and export a short piece in Resolve.",
    outcomes: ["Organise media and a timeline", "Apply a basic primary grade", "Export for Instagram and YouTube"],
    modules: [{ id: "m1", title: "", lessons: [
      { id: "l1", title: "Project setup and media", kind: "video", video: yt("dQw4w9WgXcQ"), durationMinutes: 10, description: "" },
      { id: "l2", title: "The cut page", kind: "video", video: yt("dQw4w9WgXcQ"), durationMinutes: 14, description: "" },
      { id: "l3", title: "Primary colour correction", kind: "video", video: yt("dQw4w9WgXcQ"), durationMinutes: 12, description: "" },
      { id: "l4", title: "Export presets", kind: "resource", video: null, durationMinutes: 2, description: "Our export presets as a download.", resources: [{ label: "Resolve export presets (demo)", url: "https://example.org/academy/resolve-presets" }] },
    ] }],
  },
  {
    id: "seed-course-story", title: "Storytelling Through Film (demo)", category: "filmmaking", level: "intermediate", topics: ["Storyboarding and shot planning", "Sound and interviews"],
    hue: [90, 60, 130],
    about: "*Local demo content. Not official IFC training.*\n\nFrom a testimony interview to a finished three-minute film.",
    outcomes: ["Plan a shot list from a story beat", "Record a clean interview"],
    modules: [{ id: "m1", title: "", lessons: [
      { id: "l1", title: "Finding the story", kind: "written", video: null, durationMinutes: 6, description: "Every testimony has a before, a turn and an after. Find the turn first." },
      { id: "l2", title: "Storyboarding a 3-minute film", kind: "video", video: yt("dQw4w9WgXcQ"), durationMinutes: 13, description: "" },
    ] }],
  },
  {
    id: "seed-course-brand", title: "Designing Inside the Brand (demo)", category: "graphic-design", level: "beginner", topics: ["Brand consistency", "Event artwork"],
    hue: [13, 148, 136],
    about: "*Local demo content. Not official IFC material.*\n\nType, colour and layout for event graphics that still look like us.", outcomes: ["Use the type scale", "Build a poster from the template"],
    modules: [{ id: "m1", title: "", lessons: [{ id: "l1", title: "The template, explained", video: yt("dQw4w9WgXcQ"), durationMinutes: 7, description: "Where everything lives and why." }] }],
  },
  {
    // Deliberately left on the LEGACY id to exercise backward-compatible reading (→ Filmmaking).
    id: "seed-course-draft", title: "Multi-cam Basics (demo draft)", category: "videography", level: "advanced", status: "draft",
    hue: [120, 120, 130],
    about: "Work in progress. Learners can't see this one.", outcomes: [],
    modules: [{ id: "m1", title: "", lessons: [{ id: "l1", title: "Camera positions", video: null, durationMinutes: 0, description: "" }] }],
  },
];

/* Real provider metadata for demo videos, fetched from the documented oEmbed
   endpoints at seed time (cached per video). Offline → null (the UI shows an
   honest "no preview" state). Nothing is invented. */
const _metaCache = new Map();
async function videoMetaFor(v) {
  const key = `${v.provider}:${v.id}`;
  if (_metaCache.has(key)) return _metaCache.get(key);
  let meta = null;
  const src = v.provider === "youtube" ? `https://www.youtube.com/watch?v=${v.id}` : v.provider === "vimeo" ? `https://vimeo.com/${v.id}` : null;
  const endpoint = v.provider === "youtube" ? `https://www.youtube.com/oembed?url=${encodeURIComponent(src)}&format=json`
    : v.provider === "vimeo" ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(src)}` : null;
  if (endpoint) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(endpoint, { signal: ctl.signal }); clearTimeout(t);
      if (r.ok) {
        const b = await r.json();
        const https = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : "");
        meta = { title: String(b.title || "").slice(0, 200), author: String(b.author_name || "").slice(0, 120), authorUrl: https(b.author_url), thumbnailUrl: https(b.thumbnail_url), sourceUrl: src, fetchedAt: Date.now() };
      }
    } catch { meta = null; }
  }
  _metaCache.set(key, meta);
  return meta;
}
let _storageOk = true;
/* One lesson demonstrates an app-owned CUSTOM thumbnail (16:9); the rest use
   the provider's artwork. */
async function customThumbFor(courseId, lessonId) {
  if (!(courseId === "seed-course-camera" && lessonId === "l1") || !_storageOk) return { thumb: null, thumbMode: "source" };
  try {
    const png = makePng(320, 180, (x, y) => [30 + (x / 320) * 40, 40 + (y / 180) * 30, 110 + (x / 320) * 80]);
    const path = `academy/lessonThumbs/${courseId}/${lessonId}/seed.png`;
    await getStorage().bucket().file(path).save(png, { contentType: "image/png" });
    return { thumb: { path, version: "seed", contentType: "image/png", bytes: png.length, w: 320, h: 180 }, thumbMode: "custom" };
  } catch { return { thumb: null, thumbMode: "source" }; }
}
/* Topic RECORDS: every distinct demo tag becomes academyTopics/{slug}. */
const topicSlug = (n) => String(n).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const topicIdsFor = (names) => [...new Set((names || []).map(topicSlug))];
async function seedTopicRecords(names, now) {
  for (const name of names) {
    // "CapCut" is HIDDEN: it disappears from learner chips/filters, but the
    // association on the draft guide is kept so restoring it brings it back.
    await db.collection("academyTopics").doc(topicSlug(name)).set({ name, description: "", hidden: name === "CapCut", createdAt: now, createdBy: "seed-jane", updatedAt: now, updatedBy: "seed-jane" });
  }
}

async function seedAcademy() {
  const now = new Date();
  let covers = 0, storageOk = true;
  // ---- Category RECORDS (stable ids; names/descriptions editable in Admin) ----
  const CATS = [
    { id: "heart-of-serving", name: "The Heart of Serving", short: "Heart of Serving", description: "Help everyone understand why the team exists and how to serve people well.", hue: [160, 120, 40] },
    { id: "photography", name: "Photography", description: "Capture meaningful moments and deliver consistent, usable photographs.", hue: [80, 90, 200] },
    { id: "filmmaking", name: "Filmmaking", description: "Tell stories through moving images, from a short Reel to a testimony video.", hue: [190, 120, 30] },
    { id: "graphic-design", name: "Graphic Design", description: "Communicate clearly and build a recognizable visual identity for IFC.", hue: [20, 140, 130] },
    { id: "social-media-storytelling", name: "Social Media & Storytelling", short: "Social & Storytelling", description: "Decide what to communicate, who it serves, and how to publish it effectively.", hue: [190, 60, 70] },
    // No portrait cover: shows the legacy LANDSCAPE upload letterboxed (see below).
    { id: "creating-together", name: "Creating Together", description: "The practical process that turns an idea into approved, published content.", hue: null },
    // Demo records exercising the new behaviour:
    { id: "sound-and-audio", name: "Sound & Audio (demo, empty)", short: "Sound & Audio", description: "Local demo category with no courses yet. It shows the empty state.", hue: null },
    { id: "worship-visuals", name: "Worship Visuals (demo, hidden)", short: "Worship Visuals", description: "Local demo category that is HIDDEN. Its published course is invisible to learners.", hue: [90, 60, 150], hidden: true },
  ];
  for (const [i, c] of CATS.entries()) {
    let cover = null;
    if (c.hue && storageOk) {
      try {
        const path = `academy/catCovers/${c.id}/seed.png`;
        const png = coverArt(c.hue);
        await getStorage().bucket().file(path).save(png, { contentType: "image/png" });
        cover = { path, version: "seed", contentType: "image/png", bytes: png.length, w: 300, h: 400 };
      } catch (e) { storageOk = false; _storageOk = false; }
    }
    await db.collection("academyCategories").doc(c.id).set({ name: c.name, short: c.short || "", description: c.description, order: i, hidden: !!c.hidden, cover, createdAt: now, createdBy: "seed-jane", updatedAt: now, updatedBy: "seed-jane" });
  }
  await db.collection("academySettings").doc("categoryIndex").set({ hidden: CATS.filter((c) => c.hidden).map((c) => c.id), updatedAt: now, updatedBy: "seed-jane" });
  for (const c of COURSES) {
    let cover = null;
    if (storageOk) {
      try { cover = await uploadCover(`academy/covers/${c.id}/seed.png`, coverArt(c.hue)); covers += 1; }
      catch (e) { storageOk = false; console.log(`  (storage emulator not reachable — seeding without covers: ${e.message.split("\n")[0]})`); }
    }
    const lessonsFlat = c.modules.flatMap((m) => m.lessons.map((l) => ({ ...l, moduleId: m.id })));
    const required = lessonsFlat.filter((l) => !l.bonus);
    const status = c.status || "published";
    await db.collection("courses").doc(c.id).set({
      title: c.title, category: c.category, level: c.level, status, topics: c.topics || [],
      previewVideo: c.previewVideo || null,
      // Topics as record ids; one course keeps legacy free-text tags only (compatibility demo).
      ...(c.id === "seed-course-brand" ? {} : { topicIds: topicIdsFor(c.topics), topics: [] }),
      about: c.about, outcomes: c.outcomes || [], requirements: c.requirements || [],
      modules: c.modules.map((m) => ({ id: m.id, title: m.title, lessonIds: m.lessons.map((l) => l.id) })),
      cover,
      lessonCount: lessonsFlat.length, requiredLessonCount: required.length,
      requiredQuizLessonIds: required.filter((l) => l.quiz && l.quiz.mode === "required").map((l) => l.id),
      bonusLessonIds: lessonsFlat.filter((l) => l.bonus).map((l) => l.id),
      durationMinutes: lessonsFlat.reduce((s, l) => s + (l.durationMinutes || 0), 0),
      createdAt: now, createdBy: "seed-jane", updatedAt: now, updatedBy: "seed-jane",
      // Staggered publication dates so "Recently added" has a real order (not edit times).
      ...(status === "published" ? { publishedAt: new Date(now - COURSES.indexOf(c) * 36e5 * 7) } : {}),
    });
    let i = 0;
    for (const l of lessonsFlat) {
      i += 1;
      const quiz = l.quiz ? { mode: l.quiz.mode, passMark: l.quiz.passMark, retryLimit: l.quiz.retryLimit || 0, questions: l.quiz.questions } : { mode: "none", passMark: 70, retryLimit: 0, questions: [] };
      await db.collection("courses").doc(c.id).collection("lessons").doc(l.id).set({
        title: l.title, moduleId: l.moduleId, kind: l.kind || (l.video ? "video" : "written"), video: l.video || null, description: l.description || "",
        videoMeta: l.video ? await videoMetaFor(l.video) : null,
        ...(await customThumbFor(c.id, l.id)),
        resources: l.resources || [], bonus: !!l.bonus, durationMinutes: l.durationMinutes || 0, quiz,
        createdAt: now, createdAtMs: now.getTime() + i, updatedAt: now,
      });
      if (l.quiz) await db.collection("courses").doc(c.id).collection("quizKeys").doc(l.id).set({ answers: l.key, explanations: l.explain || {}, updatedAt: now });
    }
  }
  // Category artwork for the Explore cards (generated demo art — replace with real photography).
  // Legacy LANDSCAPE artwork (pre-v4) — kept for one category to demonstrate it is
  // displayed letterboxed, never silently cropped, until an admin replaces it.
  const CAT_HUES = { "creating-together": [40, 100, 190] };
  const art = {};
  if (storageOk) {
    for (const [id, hue] of Object.entries(CAT_HUES)) {
      try {
        const png = makePng(480, 270, (x, y) => { const t = (x / 480) * 0.5 + (y / 270) * 0.5; const band = Math.abs(((x * 0.6 + y * 0.8) % 110) - 55) < 7 ? 0.1 : 0; return hue.map((c, i) => Math.max(0, Math.min(255, Math.round(c * (0.6 + 0.4 * t) + 255 * band * (i === 1 ? 0.8 : 0.5))))); });
        const file = getStorage().bucket().file(`academy/categoryArt/${id}/seed.png`);
        await file.save(png, { contentType: "image/png" });
        art[id] = { path: `academy/categoryArt/${id}/seed.png`, version: "seed", contentType: "image/png", bytes: png.length, w: 480, h: 270 };
      } catch {}
    }
  }
  await db.collection("academySettings").doc("categories").set({ art, updatedAt: now, updatedBy: "seed-jane" });

  // Purpose video on the Learn home.
  let purposeThumb = null;
  if (storageOk) { try { purposeThumb = await uploadCover("academy/purpose/seed.png", makePng(300, 400, (x, y) => [40 + (y / 400) * 60, 44 + (x / 300) * 30, 120])); } catch {} }
  await db.collection("academySettings").doc("purposeVideo").set({
    title: "The Heart Behind the Creative", intro: "Before the cameras and the templates: why this team exists, and who we're serving when we press record.",
    video: yt("dQw4w9WgXcQ"), thumb: purposeThumb, updatedAt: now, updatedBy: "seed-jane",
  });
  // ---- Quick guides (standalone help; video + notes, or text only) ----
  const GUIDES = [
    { id: "seed-guide-plan", title: "Planning a post: message first (demo)", category: "social-media-storytelling", topics: ["Content planning and storytelling", "Content ideas and audience needs"],
      video: null, body: "*Local demo content. Not official IFC material.*\n\n## Before you shoot anything\n\n1. Who is this for?\n2. What's the one thing they should take away?\n3. What format fits that — a Reel, a carousel, a photo?\n\nWrite the answer in one sentence and keep it visible while you work.", resources: [{ label: "Planning template (demo)", url: "https://example.org/academy/plan" }], durationMinutes: 4 },
    { id: "seed-guide-publish", title: "Publishing checklist (demo)", category: "social-media-storytelling", topics: ["Choosing formats", "Testing posting times for our audience"],
      video: yt("dQw4w9WgXcQ"), body: "*Local demo content.*\n\n- Caption reads without sound\n- Alt text added\n- Posting time chosen on purpose\n- Marked **Posted** on the Creatives Board", resources: [], durationMinutes: 3 },
    { id: "seed-guide-handover", title: "Organising files and handing over (demo)", category: "creating-together", topics: ["Organizing files and handing work over", "Using IFC Creatives Board"],
      video: null, body: "*Local demo content. Folder names below are examples, not an approved standard.*\n\n## Naming\n\n`YYYY-MM-DD_event_shortname` — one folder per shoot.\n\n## Hand-over\n\nPaste the folder link into the content's **Links** on the Board, then move it to **In Review**.", resources: [], durationMinutes: 3 },
    { id: "seed-guide-feedback", title: "Receiving feedback well (demo)", category: "heart-of-serving", topics: ["Receiving feedback", "Teamwork and preparation"],
      video: yt("dQw4w9WgXcQ"), body: "*Local demo content.*\n\nNotes are about the work, not the person. Ask what the note is protecting before you defend the cut.", resources: [], durationMinutes: 5 },
    { id: "seed-guide-export", title: "Exporting photos for the web (demo)", category: "photography", topics: ["Exporting and delivering images", "Lightroom"],
      video: null, body: "*Local demo content.*\n\n- Long edge 2048 px\n- sRGB\n- JPEG quality 80", resources: [], durationMinutes: 2 },
    { id: "seed-guide-draft", title: "Colour grading in CapCut (demo draft)", category: "filmmaking", topics: ["Video editing and colour grading", "CapCut"], status: "draft",
      video: null, body: "Work in progress.", resources: [], durationMinutes: 0 },
  ];
  {
    const names = new Set();
    for (const c of COURSES) (c.topics || []).forEach((t) => names.add(t));
    for (const g of GUIDES) (g.topics || []).forEach((t) => names.add(t));
    ["Short-form video production", "Captions and hooks", "Instagram Reels"].forEach((t) => names.add(t));
    await seedTopicRecords([...names], now);
  }
  for (const g of GUIDES) {
    const status = g.status || "published";
    await db.collection("guides").doc(g.id).set({
      title: g.title, category: g.category, topicIds: topicIdsFor(g.topics), topics: [], status,
      video: g.video, videoMeta: g.video ? await videoMetaFor(g.video) : null, thumbMode: "source", body: g.body, resources: g.resources, thumb: null, durationMinutes: g.durationMinutes,
      createdAt: now, createdBy: "seed-jane", updatedAt: now, updatedBy: "seed-jane", ...(status === "published" ? { publishedAt: new Date(now - (GUIDES.indexOf(g) + 1) * 36e5 * 5) } : {}),
    });
  }
  // ---- Learning path: "Short-Form Content" — references Filmmaking + Social Media content ----
  let pathCover = null;
  if (storageOk) { try { pathCover = await uploadCover("academy/pathCovers/seed-path-shortform/seed.png", coverArt([215, 90, 70])); } catch {} }
  await db.collection("paths").doc("seed-path-shortform").set({
    title: "Short-Form Content (demo)", purpose: "From an idea to a posted Reel and what you learn from it. For anyone producing vertical video for IFC's channels.",
    category: "", topicIds: topicIdsFor(["Short-form video production", "Captions and hooks", "Instagram Reels"]), topics: [], status: "published",
    cover: pathCover,
    items: [
      { id: "s1", type: "guide",  guideId: "seed-guide-plan",                                   required: true,  label: "Plan the message" },
      { id: "s2", type: "lesson", courseId: "seed-course-reels", lessonId: "l1",                required: true,  label: "Film the content" },
      { id: "s3", type: "lesson", courseId: "seed-course-reels", lessonId: "l2",                required: true,  label: "Edit the video" },
      { id: "s4", type: "lesson", courseId: "seed-course-captions", lessonId: "l1",             required: true,  label: "Write the caption" },
      { id: "s5", type: "guide",  guideId: "seed-guide-publish",                                required: true,  label: "Publish the content" },
      { id: "s6", type: "lesson", courseId: "seed-course-captions", lessonId: "l2",             required: true,  label: "Review the response" },
      { id: "s7", type: "guide",  guideId: "seed-guide-draft",                                  required: false, label: "Bonus: colour grading (unpublished demo that shows the unavailable state)" },
    ],
    createdAt: now, createdBy: "seed-jane", updatedAt: now, updatedBy: "seed-jane", publishedAt: now,
  });
  await db.collection("learnerProgress").doc("seed-sam").collection("guideReviews").doc("seed-guide-plan").set({ uid: "seed-sam", guideId: "seed-guide-plan", reviewed: true, reviewedAt: now, updatedAt: now });
  await db.collection("learnerProgress").doc("seed-sam").collection("pathProgress").doc("seed-path-shortform").set({ uid: "seed-sam", pathId: "seed-path-shortform", startedAt: now, lastItemKey: "guide:seed-guide-plan", lastViewedAt: now, updatedAt: now });

  // Some learner progress so "Continue learning" and the leader view have data.
  await db.collection("learnerProgress").doc("seed-sam").collection("courseProgress").doc("seed-course-light").set({
    uid: "seed-sam", courseId: "seed-course-light", startedAt: now, lastLessonId: "l2", lastViewedAt: now, updatedAt: now,
    lessons: { l1: { videoWatched: true, videoWatchedAt: now, positionSec: 0, durationSec: 480 }, l2: { viewedAt: now, positionSec: 120, durationSec: 660 } },
    earned: {},
  });
  await db.collection("learnerProgress").doc("seed-jordan").collection("courseProgress").doc("seed-course-reels").set({
    uid: "seed-jordan", courseId: "seed-course-reels", startedAt: now, lastLessonId: "l1", lastViewedAt: new Date(now - 86400000), updatedAt: now,
    lessons: { l1: { viewedAt: now, positionSec: 40, durationSec: 540 } }, earned: {},
  });
  console.log(`✓ ${CATS.length} category records (1 hidden, 1 empty), ${COURSES.length} academy courses, ${GUIDES.length} quick guides, 1 learning path, topic records; video metadata ${[..._metaCache.values()].some(Boolean) ? "fetched via oEmbed" : "unavailable (offline)"} (${covers} course covers uploaded)`);
}

async function main() {
  console.log(`Seeding emulator (${PROJECT_ID})…`);
  console.log(`  Firestore: ${process.env.FIRESTORE_EMULATOR_HOST}`);
  console.log(`  Auth:      ${process.env.FIREBASE_AUTH_EMULATOR_HOST}\n`);
  await seedUsers();
  await seedTasks();
  await seedNotifications();
  await seedAcademy();
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
