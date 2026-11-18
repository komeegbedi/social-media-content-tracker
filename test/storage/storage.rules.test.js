/* IFC Creative Academy — Cloud Storage rules against the emulator (needs BOTH
   the Firestore and Storage emulators, because storage.rules reads user +
   course docs with firestore.get). Run: npm run test:academy */
import { assertThrowawayProject } from "../emulatorGuard.js";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
import { ref, uploadBytes, getBytes, deleteObject } from "firebase/storage";
import { createRequire } from "node:module";
// The REAL learner-media sync (functions/academyLearnerMedia.js), run against
// this throwaway emulator through the Admin SDK — the same code the deployed
// triggers run (test/trigger/learner-media-trigger.test.js runs the triggers).
const { syncLearnerMedia, reconcileLearnerMedia } = createRequire(import.meta.url)("../../functions/academyLearnerMedia.js");

/* Cross-service rules (firestore.get from storage.rules) only resolve against the
   emulator's OWN project id (GCLOUD_PROJECT, set by `emulators:exec`), so this
   suite must share it — a per-run random id would make every firestore.get
   return null. It therefore clears that project's emulator data: run it only
   through `npm run test:academy` (a throwaway emulator), never against the dev
   emulator you've seeded.
   ALSO: every Storage emulator keeps its file contents in the SAME folder,
   $TMPDIR/firebase/storage/blobs, and deletes it when it stops — so a second
   Storage emulator started beside the dev one wipes the dev emulator's files.
   `npm run test:academy` sets its own TMPDIR for that reason; keep it if you
   run this suite any other way. */
const PROJECT_ID = process.env.GCLOUD_PROJECT;
if (!PROJECT_ID) throw new Error("storage.rules.test.js must run under `firebase emulators:exec` (npm run test:academy)");
const BUCKET = `${PROJECT_ID}.appspot.com`;
assertThrowawayProject(PROJECT_ID, { bucket: BUCKET });   // never the dev project/bucket
let env;
const asStorage = (uid) => env.authenticatedContext(uid).storage(BUCKET);
async function seed(path, id, data) {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path, id), data); });
}
// what the deployed triggers do after a course / guide / categoryIndex write
const syncMedia = async (...items) => { for (const [kind, id] of items) await syncLearnerMedia(kind, id); };
async function seedObject(path, bytes, contentType = "image/jpeg") {
  await env.withSecurityRulesDisabled(async (ctx) => { await uploadBytes(ref(ctx.storage(BUCKET), path), bytes, { contentType }); });
}
// A tiny valid-enough byte payload; the rules check content type + size, not pixels.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 0xff, 0xd9]);
const BIG = new Uint8Array(2 * 1024 * 1024 + 1);

const USERS = {
  admin:  { name: "Ada", role: "admin",  status: "approved" },
  inst:   { name: "Ines", role: "member", status: "approved", academyEditor: true },
  exinst: { name: "Former instructor", role: "member", status: "approved" },
  member: { name: "Mel", role: "member", status: "approved" },
  pending:{ name: "Peg", role: "member", status: "pending" },
  exadmin:{ name: "Ex",  role: "admin",  status: "removed", disabled: true },
};

/* The emulator address `firebase emulators:exec` exported (an isolated run on
   other ports), else the default local ports. */
const emu = (envVar, port) => { const [h, p] = String(process.env[envVar] || "").split(":"); return { host: h || "127.0.0.1", port: Number(p) || port }; };
before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), ...emu("FIRESTORE_EMULATOR_HOST", 8080) },
    storage: { rules: readFileSync("storage.rules", "utf8"), ...emu("FIREBASE_STORAGE_EMULATOR_HOST", 9199) },
  });
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  for (const [k, u] of Object.entries(USERS)) await seed("users", k, u);
  await seed("courses", "pub", { title: "P", status: "published", instructorUid: "inst" });
  await seed("courses", "draft", { title: "D", status: "draft", instructorUid: "inst" });
  // editors edit through a private draft (the workspace creates it before any upload)
  await seed("courseDrafts", "pub", { title: "P", rev: 2, publishedRev: 1 });
  await seed("courseDrafts", "draft", { title: "D", rev: 1, publishedRev: 0 });
  await syncMedia(["course", "pub"], ["course", "draft"]);
  await seedObject("academy/covers/pub/v1.jpg", JPEG);
  await seedObject("academy/covers/draft/v1.jpg", JPEG);
  await seedObject("academy/lessonThumbs/pub/l1/v1.jpg", JPEG);
  await seedObject("academy/purpose/v1.jpg", JPEG);
  await seedObject("other/secret.jpg", JPEG);
});

test("reads follow the course access model: published → approved members; drafts → editors only", async () => {
  await assertSucceeds(getBytes(ref(asStorage("member"), "academy/covers/pub/v1.jpg")));
  await assertSucceeds(getBytes(ref(asStorage("member"), "academy/lessonThumbs/pub/l1/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("pending"), "academy/covers/pub/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("exadmin"), "academy/covers/pub/v1.jpg")));
  await assertFails(getBytes(ref(env.unauthenticatedContext().storage(BUCKET), "academy/covers/pub/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("member"), "academy/covers/draft/v1.jpg")));
  await assertSucceeds(getBytes(ref(asStorage("inst"), "academy/covers/draft/v1.jpg")));
  await assertSucceeds(getBytes(ref(asStorage("admin"), "academy/covers/draft/v1.jpg")));
  await assertSucceeds(getBytes(ref(asStorage("member"), "academy/purpose/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("admin"), "other/secret.jpg")), "default deny outside academy/");
});

test("uploads: course editors only, image types only, ≤ 2 MB; learners and strangers denied", async () => {
  await assertSucceeds(uploadBytes(ref(asStorage("inst"), "academy/covers/pub/v2.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertSucceeds(uploadBytes(ref(asStorage("admin"), "academy/covers/draft/v2.jpg"), JPEG, { contentType: "image/png" }));
  await assertSucceeds(uploadBytes(ref(asStorage("inst"), "academy/lessonThumbs/pub/l1/v2.jpg"), JPEG, { contentType: "image/webp" }));
  await assertFails(uploadBytes(ref(asStorage("member"), "academy/covers/pub/v3.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/covers/pub/v4.jpg"), JPEG, { contentType: "image/svg+xml" }), "svg denied");
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/covers/pub/v5.jpg"), JPEG, { contentType: "text/html" }));
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/covers/pub/v6.jpg"), BIG, { contentType: "image/jpeg" }), "size cap");
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/covers/nope/v1.jpg"), JPEG, { contentType: "image/jpeg" }), "the course's draft must exist");
  await assertFails(uploadBytes(ref(asStorage("admin"), "other/x.jpg"), JPEG, { contentType: "image/jpeg" }), "outside academy/");
  await assertFails(uploadBytes(ref(asStorage("exadmin"), "academy/covers/pub/v7.jpg"), JPEG, { contentType: "image/jpeg" }));
});

test("purpose thumbnail: admin writes only", async () => {
  await assertSucceeds(uploadBytes(ref(asStorage("admin"), "academy/purpose/v2.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/purpose/v3.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(deleteObject(ref(asStorage("inst"), "academy/purpose/v1.jpg")));
  await assertSucceeds(deleteObject(ref(asStorage("admin"), "academy/purpose/v1.jpg")));
});

test("deletes: Academy editors only (replacements, cancelled uploads and clean-up)", async () => {
  await assertFails(deleteObject(ref(asStorage("member"), "academy/covers/pub/v1.jpg")));
  await assertSucceeds(deleteObject(ref(asStorage("inst"), "academy/covers/pub/v1.jpg")));
  await assertSucceeds(deleteObject(ref(asStorage("admin"), "academy/lessonThumbs/pub/l1/v1.jpg")));
});

test("v2: guide thumbnails + path covers follow the guide/path access model", async () => {
  await seed("guides", "gpub", { title: "G", status: "published", instructorUid: "inst" });
  await seed("guides", "gdraft", { title: "D", status: "draft", instructorUid: "inst" });
  await seed("paths", "ppub", { title: "P", status: "published", instructorUid: "inst" });
  await seed("paths", "pdraft", { title: "PD", status: "draft", instructorUid: "inst" });
  await seedObject("academy/guideThumbs/gpub/v1.jpg", JPEG);
  await seedObject("academy/guideThumbs/gdraft/v1.jpg", JPEG);
  await seedObject("academy/pathCovers/ppub/v1.jpg", JPEG);
  await seedObject("academy/pathCovers/pdraft/v1.jpg", JPEG);
  await seed("guideDrafts", "gpub", { title: "G", rev: 2, publishedRev: 1 });
  await syncMedia(["guide", "gpub"], ["guide", "gdraft"]);
  await assertSucceeds(getBytes(ref(asStorage("member"), "academy/guideThumbs/gpub/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("member"), "academy/guideThumbs/gdraft/v1.jpg")));
  await assertSucceeds(getBytes(ref(asStorage("inst"), "academy/guideThumbs/gdraft/v1.jpg")));
  await assertSucceeds(getBytes(ref(asStorage("member"), "academy/pathCovers/ppub/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("member"), "academy/pathCovers/pdraft/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("pending"), "academy/pathCovers/ppub/v1.jpg")));
  await assertSucceeds(uploadBytes(ref(asStorage("inst"), "academy/guideThumbs/gpub/v2.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(asStorage("member"), "academy/guideThumbs/gpub/v3.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/guideThumbs/gpub/v4.jpg"), JPEG, { contentType: "image/gif" }));
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/guideThumbs/nope/v1.jpg"), JPEG, { contentType: "image/jpeg" }), "the resource's draft must exist");
  await assertSucceeds(uploadBytes(ref(asStorage("admin"), "academy/pathCovers/pdraft/v2.jpg"), JPEG, { contentType: "image/png" }));
  await assertFails(uploadBytes(ref(asStorage("member"), "academy/pathCovers/ppub/v3.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/pathCovers/ppub/v5.jpg"), BIG, { contentType: "image/jpeg" }));
  await assertFails(deleteObject(ref(asStorage("member"), "academy/pathCovers/ppub/v1.jpg")));
  await assertSucceeds(deleteObject(ref(asStorage("inst"), "academy/pathCovers/ppub/v1.jpg")));
  await assertSucceeds(deleteObject(ref(asStorage("inst"), "academy/guideThumbs/gpub/v1.jpg")));
});

test("v3→v4: legacy landscape category art stays readable (and deletable by admins) but can no longer be written", async () => {
  await seedObject("academy/categoryArt/filmmaking/v1.jpg", JPEG);
  await assertSucceeds(getBytes(ref(asStorage("member"), "academy/categoryArt/filmmaking/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("pending"), "academy/categoryArt/filmmaking/v1.jpg")));
  await assertFails(uploadBytes(ref(asStorage("admin"), "academy/categoryArt/photography/v2.jpg"), JPEG, { contentType: "image/jpeg" }), "new covers go to catCovers/");
  await assertFails(deleteObject(ref(asStorage("inst"), "academy/categoryArt/filmmaking/v1.jpg")));
  await assertSucceeds(deleteObject(ref(asStorage("admin"), "academy/categoryArt/filmmaking/v1.jpg")));
});

test("v4: portrait category covers — any existing category RECORD, admin writes, approved reads", async () => {
  await seed("academyCategories", "audio", { name: "Audio", hidden: false });
  await assertSucceeds(uploadBytes(ref(asStorage("admin"), "academy/catCovers/audio/v1.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(asStorage("admin"), "academy/catCovers/no-such-category/v1.jpg"), JPEG, { contentType: "image/jpeg" }), "record must exist");
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/catCovers/audio/v2.jpg"), JPEG, { contentType: "image/jpeg" }), "admins manage category covers");
  await assertFails(uploadBytes(ref(asStorage("admin"), "academy/catCovers/audio/v3.jpg"), JPEG, { contentType: "image/svg+xml" }));
  await assertSucceeds(getBytes(ref(asStorage("member"), "academy/catCovers/audio/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("pending"), "academy/catCovers/audio/v1.jpg")));
  await assertSucceeds(deleteObject(ref(asStorage("admin"), "academy/catCovers/audio/v1.jpg")));
});

test("v4: editor role is global (no per-course instructor); hidden categories hide course images from learners", async () => {
  await assertSucceeds(uploadBytes(ref(asStorage("inst"), "academy/covers/pub/v9.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(asStorage("exinst"), "academy/covers/pub/v9b.jpg"), JPEG, { contentType: "image/jpeg" }), "a former instructor without the role can't upload");
  await seed("courses", "pubhidden", { title: "H", status: "published", category: "worship" });
  await syncMedia(["course", "pubhidden"]);
  await seedObject("academy/covers/pubhidden/v1.jpg", JPEG);
  await assertSucceeds(getBytes(ref(asStorage("member"), "academy/covers/pubhidden/v1.jpg")));
  await seed("academySettings", "categoryIndex", { hidden: ["worship"] });
  await syncMedia(["course", "pubhidden"]);
  await assertFails(getBytes(ref(asStorage("member"), "academy/covers/pubhidden/v1.jpg")), "hidden category → cover private");
  await assertSucceeds(getBytes(ref(asStorage("inst"), "academy/covers/pubhidden/v1.jpg")), "editors still see it");
});

test("v6: a course that exists only as a private DRAFT accepts editor uploads; learners can't read them; no draft/course → no upload", async () => {
  await seed("courseDrafts", "newc", { title: "New", rev: 1, publishedRev: 0 });
  await assertSucceeds(uploadBytes(ref(asStorage("inst"), "academy/covers/newc/v1.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertSucceeds(uploadBytes(ref(asStorage("inst"), "academy/lessonThumbs/newc/l1/v1.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertSucceeds(getBytes(ref(asStorage("inst"), "academy/covers/newc/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("member"), "academy/covers/newc/v1.jpg")));
  await assertFails(uploadBytes(ref(asStorage("member"), "academy/covers/newc/v2.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/covers/nothing-here/v1.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertSucceeds(deleteObject(ref(asStorage("inst"), "academy/covers/newc/v1.jpg")));
});

test("deleting a course: its leftover uploads can be removed by an editor once the course AND draft are gone; never by learners", async () => {
  await seed("courses", "gone", { title: "G", status: "archived" });
  await seedObject("academy/covers/gone/v1.jpg", JPEG);
  await seedObject("academy/lessonThumbs/gone/l1/v1.jpg", JPEG);
  await assertFails(deleteObject(ref(asStorage("member"), "academy/covers/gone/v1.jpg")));
  // course deleted (as the app does first)
  await env.withSecurityRulesDisabled(async (ctx) => { const { deleteDoc } = await import("firebase/firestore"); await deleteDoc(doc(ctx.firestore(), "courses", "gone")); });
  await assertFails(deleteObject(ref(asStorage("member"), "academy/covers/gone/v1.jpg")), "learners still can't");
  await assertFails(deleteObject(ref(asStorage("exinst"), "academy/covers/gone/v1.jpg")), "former editors still can't");
  await assertSucceeds(deleteObject(ref(asStorage("inst"), "academy/covers/gone/v1.jpg")));
  await assertSucceeds(deleteObject(ref(asStorage("admin"), "academy/lessonThumbs/gone/l1/v1.jpg")));
  // a course that still exists only as a draft is NOT a leftover for non-editors
  await seed("courseDrafts", "drafty", { title: "D", rev: 1, publishedRev: 0 });
  await seedObject("academy/covers/drafty/v1.jpg", JPEG);
  await assertFails(deleteObject(ref(asStorage("member"), "academy/covers/drafty/v1.jpg")));
});

test("v6.11: a resource that exists only as a private DRAFT accepts editor thumbnails; learners can't read them; clean-up after deletion", async () => {
  await seed("guideDrafts", "gnew", { title: "Draft only", rev: 1, publishedRev: 0 });
  await seed("academySettings", "categoryIndex", { hidden: ["hid"] });
  await seed("guides", "ghid", { title: "H", status: "published", category: "hid" });
  await syncMedia(["guide", "ghid"], ["guide", "gnew"]);
  await seedObject("academy/guideThumbs/ghid/v1.jpg", JPEG);
  // draft-only: editors upload + read; learners can't read; no guide/draft → no upload
  await assertSucceeds(uploadBytes(ref(asStorage("inst"), "academy/guideThumbs/gnew/v1.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertSucceeds(getBytes(ref(asStorage("inst"), "academy/guideThumbs/gnew/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("member"), "academy/guideThumbs/gnew/v1.jpg")));
  await assertFails(uploadBytes(ref(asStorage("member"), "academy/guideThumbs/gnew/v2.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(deleteObject(ref(asStorage("member"), "academy/guideThumbs/gnew/v1.jpg")));
  // a published resource in a hidden category: learners can't read its thumbnail
  await assertFails(getBytes(ref(asStorage("member"), "academy/guideThumbs/ghid/v1.jpg")));
  await assertSucceeds(getBytes(ref(asStorage("inst"), "academy/guideThumbs/ghid/v1.jpg")));
  // after the resource AND its draft are gone: an editor may remove the leftover; a learner never
  await env.withSecurityRulesDisabled(async (ctx) => { const { deleteDoc } = await import("firebase/firestore"); await deleteDoc(doc(ctx.firestore(), "guideDrafts", "gnew")); });
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/guideThumbs/gnew/v3.jpg"), JPEG, { contentType: "image/jpeg" }), "no guide or draft → no upload");
  await assertFails(deleteObject(ref(asStorage("member"), "academy/guideThumbs/gnew/v1.jpg")));
  await assertSucceeds(deleteObject(ref(asStorage("inst"), "academy/guideThumbs/gnew/v1.jpg")));
});

/* ---- the document-budget fix (production refused draft-only uploads) ---- */

test("never-published draft (the reported case): an admin uploads, replaces and reads its cover and lesson thumbnails; learners and non-editors can't", async () => {
  // only the private draft exists — no courses/{id} doc at all
  await seed("courseDrafts", "kingdom", { title: "A never-published draft (test)", rev: 7, publishedRev: 0, category: "heart-of-serving" });
  await syncMedia(["course", "kingdom"]);
  await assertSucceeds(uploadBytes(ref(asStorage("admin"), "academy/covers/kingdom/v1.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertSucceeds(getBytes(ref(asStorage("admin"), "academy/covers/kingdom/v1.jpg")));
  await assertSucceeds(uploadBytes(ref(asStorage("admin"), "academy/covers/kingdom/v2.jpg"), JPEG, { contentType: "image/jpeg" }), "replacement");
  await assertSucceeds(deleteObject(ref(asStorage("admin"), "academy/covers/kingdom/v1.jpg")), "the replaced image is removed");
  await assertSucceeds(uploadBytes(ref(asStorage("inst"), "academy/lessonThumbs/kingdom/l1/v1.jpg"), JPEG, { contentType: "image/jpeg" }));
  for (const who of ["member", "pending", "exinst", "exadmin"]) {
    await assertFails(getBytes(ref(asStorage(who), "academy/covers/kingdom/v2.jpg")), `${who} can't read a draft's image`);
    await assertFails(uploadBytes(ref(asStorage(who), "academy/covers/kingdom/v3.jpg"), JPEG, { contentType: "image/jpeg" }), `${who} can't upload`);
    await assertFails(deleteObject(ref(asStorage(who), "academy/covers/kingdom/v2.jpg")), `${who} can't delete`);
  }
  await assertFails(uploadBytes(ref(env.unauthenticatedContext().storage(BUCKET), "academy/covers/kingdom/v3.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(asStorage("admin"), "academy/covers/kingdom/v4.jpg"), BIG, { contentType: "image/jpeg" }), "size cap still applies");
  await assertFails(uploadBytes(ref(asStorage("admin"), "academy/covers/kingdom/v5.jpg"), JPEG, { contentType: "image/gif" }), "type check still applies");
});

test("publishing, unpublishing and hiding: learners see a course's images exactly while it is published in a visible category", async () => {
  await seed("courseDrafts", "life", { title: "L", rev: 1, publishedRev: 0, category: "photography" });
  await seedObject("academy/covers/life/v1.jpg", JPEG);
  await seedObject("academy/lessonThumbs/life/l1/v1.jpg", JPEG);
  const learnerCan = async () => {
    try { await getBytes(ref(asStorage("member"), "academy/covers/life/v1.jpg")); } catch { return false; }
    await getBytes(ref(asStorage("member"), "academy/lessonThumbs/life/l1/v1.jpg"));
    return true;
  };
  assert.equal(await learnerCan(), false, "draft only");
  await seed("courses", "life", { title: "L", status: "published", category: "photography" }); await syncMedia(["course", "life"]);
  assert.equal(await learnerCan(), true, "published");
  await seed("academySettings", "categoryIndex", { hidden: ["photography"] }); await syncMedia(["course", "life"]);
  assert.equal(await learnerCan(), false, "category hidden");
  await seed("academySettings", "categoryIndex", { hidden: [] }); await syncMedia(["course", "life"]);
  assert.equal(await learnerCan(), true, "category shown again");
  await seed("courses", "life", { title: "L", status: "archived", category: "photography" }); await syncMedia(["course", "life"]);
  assert.equal(await learnerCan(), false, "archived");
  await assertFails(getBytes(ref(asStorage("pending"), "academy/covers/pub/v1.jpg")), "approval is still required for published images");
  // a published course's images are still editable through its draft
  await assertSucceeds(uploadBytes(ref(asStorage("inst"), "academy/covers/life/v2.jpg"), JPEG, { contentType: "image/jpeg" }));
});

test("the learner-access marker can't be forged: clients can neither read nor write academyLearnerMedia", async () => {
  const { setDoc: set, getDoc } = await import("firebase/firestore");
  for (const who of ["admin", "inst", "member"]) {
    const fdb = env.authenticatedContext(who).firestore();
    await assertFails(set(doc(fdb, "academyLearnerMedia", "course_draft"), { kind: "course", id: "draft" }), `${who} can't create a marker`);
    await assertFails(getDoc(doc(fdb, "academyLearnerMedia", "course_pub")), `${who} can't read markers`);
  }
  await assertFails(getBytes(ref(asStorage("member"), "academy/covers/draft/v1.jpg")), "a draft stays private");
});

test("revocation is EVENTUAL: after unpublishing or hiding, an existing marker keeps allowing reads until the sync runs; a sync that never ran is found and repaired", async () => {
  const { setDoc: set } = await import("firebase/firestore");
  const read = async (who, p) => { try { await getBytes(ref(asStorage(who), p)); return true; } catch { return false; } };
  await seed("courses", "rev", { title: "R", status: "published", category: "photography" });
  await seed("guides", "grev", { title: "G", status: "published", category: "photography" });
  await syncMedia(["course", "rev"], ["guide", "grev"]);
  await seedObject("academy/covers/rev/v1.jpg", JPEG);
  await seedObject("academy/guideThumbs/grev/v1.jpg", JPEG);
  assert.equal(await read("member", "academy/covers/rev/v1.jpg"), true);

  // 1) archived in Firestore, trigger not run yet (delayed or failed): Firestore refuses the course at once…
  await seed("courses", "rev", { title: "R", status: "archived", category: "photography" });
  const { getDoc } = await import("firebase/firestore");
  await assertFails(getDoc(doc(env.authenticatedContext("member").firestore(), "courses", "rev")));
  // …but the image is STILL readable through the stale marker — the documented window
  assert.equal(await read("member", "academy/covers/rev/v1.jpg"), true, "stale marker: still readable until the sync runs");
  // 2) hiding the category without a sync: the resource thumbnail is still readable too
  await seed("academySettings", "categoryIndex", { hidden: ["photography"] });
  assert.equal(await read("member", "academy/guideThumbs/grev/v1.jpg"), true, "stale marker after hiding");
  // 3) detection: the drift check lists both; dry run changes nothing
  const found = await reconcileLearnerMedia();
  assert.deepEqual(found.stale, ["course_rev", "guide_grev"]);
  assert.equal(await read("member", "academy/covers/rev/v1.jpg"), true, "dry run is read-only");
  // 4) repair → denied from then on
  await reconcileLearnerMedia(undefined, { apply: true });
  assert.equal(await read("member", "academy/covers/rev/v1.jpg"), false, "after repair: denied");
  assert.equal(await read("member", "academy/guideThumbs/grev/v1.jpg"), false, "after repair: denied");
  assert.equal(await read("inst", "academy/covers/rev/v1.jpg"), true, "editors still see it");
  assert.deepEqual((await reconcileLearnerMedia()).stale, []);
});

test("smoke-probe assumption: a refused delete of a MISSING object reports unauthorized; an allowed one reports not-found", async () => {
  await seed("courseDrafts", "probe", { title: "P", rev: 1, publishedRev: 0 });
  for (const who of ["member", "pending"]) {
    const e = await deleteObject(ref(asStorage(who), "academy/covers/probe/missing.jpg")).then(() => null, (x) => x);
    assert.equal(e?.code, "storage/unauthorized", `${who}: refused before existence is checked`);
  }
  const e = await deleteObject(ref(asStorage("inst"), "academy/covers/probe/missing.jpg")).then(() => null, (x) => x);
  assert.equal(e?.code, "storage/object-not-found", "an editor's delete is allowed, then finds nothing");
});
