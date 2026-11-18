/* Learner image access markers through the REAL Firestore triggers
   (functions/academyLearnerMedia.js: onAcademyCourseMedia, onAcademyGuideMedia,
   onAcademyCategoryIndexMedia) in the Functions emulator. storage.rules lets a
   learner read a course / resource image only while its marker exists.
   Run: npm run test:trigger:media */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { assertThrowawayProject } from "../emulatorGuard.js";

const PROJECT = assertThrowawayProject(process.env.GCLOUD_PROJECT || "demo-learner-media");
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marker = (id) => db.doc(`academyLearnerMedia/${id}`);
async function eventually(id, want, label) {
  const until = Date.now() + 20000;
  for (;;) {
    const has = (await marker(id).get()).exists;
    if (has === want) return;
    if (Date.now() > until) assert.fail(`${label}: marker ${id} ${want ? "never appeared" : "never went away"}`);
    await sleep(250);
  }
}
const S = String(Date.now()).slice(-6);

before(async () => { await db.doc("academySettings/categoryIndex").set({ hidden: [] }); });

test("a course: no marker as a draft; marker when published; gone when its category is hidden, back when shown, gone when archived or deleted", async () => {
  const id = `c${S}`;
  await db.doc(`courseDrafts/${id}`).set({ title: "Draft only", rev: 1, publishedRev: 0, category: "photography" });
  await db.doc(`courses/${id}`).set({ title: "T", status: "draft", category: "photography" });
  await sleep(1500);
  assert.equal((await marker(`course_${id}`).get()).exists, false, "draft: no marker");
  await db.doc(`courses/${id}`).update({ status: "published" });
  await eventually(`course_${id}`, true, "published");
  await db.doc("academySettings/categoryIndex").set({ hidden: ["photography"] });
  await eventually(`course_${id}`, false, "category hidden");
  await db.doc("academySettings/categoryIndex").set({ hidden: [] });
  await eventually(`course_${id}`, true, "category shown again");
  await db.doc(`courses/${id}`).update({ category: "filmmaking" });
  await db.doc("academySettings/categoryIndex").set({ hidden: ["filmmaking"] });
  await eventually(`course_${id}`, false, "moved into a hidden category");
  await db.doc("academySettings/categoryIndex").set({ hidden: [] });
  await eventually(`course_${id}`, true, "visible again");
  await db.doc(`courses/${id}`).update({ status: "archived" });
  await eventually(`course_${id}`, false, "archived");
  await db.doc(`courses/${id}`).update({ status: "published" });
  await eventually(`course_${id}`, true, "republished");
  await db.doc(`courses/${id}`).delete();
  await eventually(`course_${id}`, false, "deleted");
});

test("a resource (guide) follows the same model", async () => {
  const id = `g${S}`;
  await db.doc(`guides/${id}`).set({ title: "G", status: "published", category: "graphic-design" });
  await eventually(`guide_${id}`, true, "published");
  await db.doc("academySettings/categoryIndex").set({ hidden: ["graphic-design"] });
  await eventually(`guide_${id}`, false, "hidden");
  await db.doc("academySettings/categoryIndex").set({ hidden: [] });
  await eventually(`guide_${id}`, true, "shown");
  await db.doc(`guides/${id}`).delete();
  await eventually(`guide_${id}`, false, "deleted");
});

/* Rapid changes: Firebase documents no ordering for trigger events, and each
   sync reads the CURRENT documents — so whatever order the invocations run in,
   the marker must settle on the state of the last write (and stay there). */
async function settles(id, want, label) {
  const t0 = Date.now();
  await eventually(id, want, label);
  await sleep(3000);                                          // no late event flips it back
  assert.equal((await marker(id).get()).exists, want, `${label}: stays ${want ? "present" : "absent"}`);
  return Date.now() - t0 - 3000;
}
test("rapid publish → hide → show (no waits): ends visible; rapid publish → hide: ends hidden", async () => {
  const a = `ra${S}`, b = `rb${S}`;
  await db.doc("academySettings/categoryIndex").set({ hidden: [] });
  await db.doc(`courses/${a}`).set({ title: "A", status: "draft", category: "social-media-storytelling" });
  await db.doc(`courses/${b}`).set({ title: "B", status: "draft", category: "creating-together" });
  await db.doc(`courses/${a}`).update({ status: "published" });
  await db.doc("academySettings/categoryIndex").set({ hidden: ["social-media-storytelling"] });
  await db.doc("academySettings/categoryIndex").set({ hidden: [] });
  const ms = await settles(`course_${a}`, true, "publish → hide → show");
  await db.doc(`courses/${b}`).update({ status: "published" });
  await db.doc("academySettings/categoryIndex").set({ hidden: ["creating-together"] });
  const ms2 = await settles(`course_${b}`, false, "publish → hide");
  await db.doc(`courses/${b}`).update({ status: "archived" });
  await db.doc("academySettings/categoryIndex").set({ hidden: [] });
  await db.doc(`courses/${a}`).update({ status: "archived" });
  await settles(`course_${a}`, false, "archive");
  await settles(`course_${b}`, false, "archived stays hidden after the category is shown");
  console.log(`  (emulator, informational only — no production bound: settled after ~${ms} ms and ~${ms2} ms)`);
});
