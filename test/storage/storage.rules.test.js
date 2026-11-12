/* IFC Creative Academy — Cloud Storage rules against the emulator (needs BOTH
   the Firestore and Storage emulators, because storage.rules reads user +
   course docs with firestore.get). Run: npm run test:academy */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
import { ref, uploadBytes, getBytes, deleteObject } from "firebase/storage";

/* Cross-service rules (firestore.get from storage.rules) only resolve against the
   emulator's OWN project id (GCLOUD_PROJECT, set by `emulators:exec`), so this
   suite must share it — a per-run random id would make every firestore.get
   return null. It therefore clears that project's emulator data: run it only
   through `npm run test:academy` (a throwaway emulator), never against the dev
   emulator you've seeded. */
const PROJECT_ID = process.env.GCLOUD_PROJECT;
if (!PROJECT_ID) throw new Error("storage.rules.test.js must run under `firebase emulators:exec` (npm run test:academy)");
const BUCKET = `${PROJECT_ID}.appspot.com`;
let env;
const asStorage = (uid) => env.authenticatedContext(uid).storage(BUCKET);
async function seed(path, id, data) {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path, id), data); });
}
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

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
    storage: { rules: readFileSync("storage.rules", "utf8"), host: "127.0.0.1", port: 9199 },
  });
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  for (const [k, u] of Object.entries(USERS)) await seed("users", k, u);
  await seed("courses", "pub", { title: "P", status: "published", instructorUid: "inst" });
  await seed("courses", "draft", { title: "D", status: "draft", instructorUid: "inst" });
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
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/covers/nope/v1.jpg"), JPEG, { contentType: "image/jpeg" }), "course must exist");
  await assertFails(uploadBytes(ref(asStorage("admin"), "other/x.jpg"), JPEG, { contentType: "image/jpeg" }), "outside academy/");
  await assertFails(uploadBytes(ref(asStorage("exadmin"), "academy/covers/pub/v7.jpg"), JPEG, { contentType: "image/jpeg" }));
});

test("purpose thumbnail: admin writes only", async () => {
  await assertSucceeds(uploadBytes(ref(asStorage("admin"), "academy/purpose/v2.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/purpose/v3.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(deleteObject(ref(asStorage("inst"), "academy/purpose/v1.jpg")));
  await assertSucceeds(deleteObject(ref(asStorage("admin"), "academy/purpose/v1.jpg")));
});

test("deletes: editors of that course only", async () => {
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
  await assertSucceeds(getBytes(ref(asStorage("member"), "academy/guideThumbs/gpub/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("member"), "academy/guideThumbs/gdraft/v1.jpg")));
  await assertSucceeds(getBytes(ref(asStorage("inst"), "academy/guideThumbs/gdraft/v1.jpg")));
  await assertSucceeds(getBytes(ref(asStorage("member"), "academy/pathCovers/ppub/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("member"), "academy/pathCovers/pdraft/v1.jpg")));
  await assertFails(getBytes(ref(asStorage("pending"), "academy/pathCovers/ppub/v1.jpg")));
  await assertSucceeds(uploadBytes(ref(asStorage("inst"), "academy/guideThumbs/gpub/v2.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(asStorage("member"), "academy/guideThumbs/gpub/v3.jpg"), JPEG, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/guideThumbs/gpub/v4.jpg"), JPEG, { contentType: "image/gif" }));
  await assertFails(uploadBytes(ref(asStorage("inst"), "academy/guideThumbs/nope/v1.jpg"), JPEG, { contentType: "image/jpeg" }), "guide must exist");
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
  await seedObject("academy/covers/pubhidden/v1.jpg", JPEG);
  await assertSucceeds(getBytes(ref(asStorage("member"), "academy/covers/pubhidden/v1.jpg")));
  await seed("academySettings", "categoryIndex", { hidden: ["worship"] });
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
