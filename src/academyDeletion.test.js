/* Course deletion orchestration: ordering, idempotent retry, and the guarantee
   that learning paths are never edited (so no completion is silently awarded).
   Run: node --test src/academyDeletion.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCourseDeletion, pathsReferencingCourse } from "./academyDeletion.js";
import { resolvePathItems, pathProgress } from "./academyProgress.js";

function fakeOps(over = {}) {
  const log = [];
  const state = { pending: {}, content: ["l1", "l2", "course"], progress: 3, attempts: 2, images: new Set(["academy/covers/c/v1.jpg", "academy/lessonThumbs/c/l1/v1.jpg"]) };
  const ops = {
    plan: async (id) => { log.push("plan"); return { exists: state.content.includes("course"), title: "Course C", contentRefs: [...state.content], images: [...state.images], pathsAffected: [{ id: "p1" }] }; },
    markPending: async (id, entry) => { log.push("markPending"); state.pending[id] = entry; },
    deleteContent: async (refs) => { log.push("deleteContent"); state.content = []; },
    deleteProgress: async () => { log.push("deleteProgress"); const n = state.progress; state.progress = 0; return n; },
    deleteAttempts: async () => { log.push("deleteAttempts"); const n = state.attempts; state.attempts = 0; return n; },
    deleteImage: async (p) => { log.push("deleteImage"); if (!state.images.has(p)) { const e = new Error("nf"); e.code = "storage/object-not-found"; throw e; } state.images.delete(p); },
    isNotFound: (e) => e && e.code === "storage/object-not-found",
    clearPending: async (id) => { log.push("clearPending"); delete state.pending[id]; },
    ...over,
  };
  return { ops, log, state };
}

test("happy path: pending is recorded first, content before learner records, pending cleared last", async () => {
  const { ops, log, state } = fakeOps();
  const r = await runCourseDeletion(ops, "c");
  assert.deepEqual(log.slice(0, 3), ["plan", "markPending", "deleteContent"]);
  assert.equal(log[log.length - 1], "clearPending");
  assert.deepEqual([r.contentDeleted, r.progressDeleted, r.attemptsDeleted, r.failedImages.length, r.pendingCleared], [true, 3, 2, 0, true]);
  assert.deepEqual(state.pending, {});
  assert.deepEqual(r.pathsAffected, [{ id: "p1" }], "affected paths are reported, not edited");
});

test("content deletion failure throws; the pending entry stays so the admin can retry; nothing else ran", async () => {
  const { ops, log, state } = fakeOps({ deleteContent: async () => { throw new Error("offline"); } });
  await assert.rejects(runCourseDeletion(ops, "c"), /offline/);
  assert.ok(state.pending.c, "pending recorded");
  assert.ok(!log.includes("deleteProgress"), "learner records untouched while the course still exists");
});

test("partial cleanup failure keeps the pending entry; a retry finishes it idempotently (images already gone count as done)", async () => {
  let fail = true;
  const { ops, state } = fakeOps({});
  const flaky = { ...ops, deleteAttempts: async () => { if (fail) throw new Error("quota"); return ops.deleteAttempts(); } };
  const first = await runCourseDeletion(flaky, "c");
  assert.deepEqual(first.errors, ["attempts"]);
  assert.equal(first.pendingCleared, false);
  assert.ok(state.pending.c);
  // retry: the course doc is gone, the plan finds no images — the pending entry's list is used
  fail = false;
  const retryOps = { ...flaky, plan: async () => ({ exists: false, title: "", contentRefs: [], images: [], pathsAffected: [] }) };
  const second = await runCourseDeletion(retryOps, "c", state.pending.c);
  assert.equal(second.pendingCleared, true);
  assert.equal(second.failedImages.length, 0, "images deleted on the first run are 'not found' now — that's success");
  assert.deepEqual(state.pending, {});
});

test("a real image failure is reported and keeps the pending entry", async () => {
  const { ops, state } = fakeOps({ deleteImage: async () => { throw new Error("denied"); } });
  const r = await runCourseDeletion(ops, "c");
  assert.equal(r.failedImages.length, 2);
  assert.equal(r.pendingCleared, false);
  assert.ok(state.pending.c);
});

test("paths are left referencing the deleted course → the step is unavailable and the path can NOT complete silently", () => {
  const me = { id: "u", role: "member", status: "approved" };
  const path = { items: [{ id: "a", type: "course", courseId: "gone", required: true, label: "Film it" }, { id: "b", type: "guide", guideId: "g", required: true }] };
  const ctx = { me, courses: { gone: null }, lessons: {}, guides: { g: { id: "g", title: "G", status: "published" } }, progressByCourse: {}, reviews: { g: { reviewed: true } }, hidden: [] };
  const s = pathProgress(resolvePathItems(path, ctx));
  assert.equal(s.completed, false);
  assert.equal(s.blocked, true, "everything available is done, but a required step is missing");
  assert.equal(s.unavailable, 1);
  assert.equal(s.percent, 50);
  assert.deepEqual(pathsReferencingCourse([{ id: "p", title: "P", status: "published", items: path.items }, { id: "q", items: [] }], "gone"), [{ id: "p", title: "P", status: "published", steps: 1 }]);
});

test("course deletion never deletes an image outside that course's own folders", async () => {
  const deleted = [];
  const ops = {
    plan: async () => ({ exists: true, title: "X", contentRefs: ["course"], images: ["academy/covers/x/v1.jpg", "academy/covers/seed-course-light/seed.png", "academy/lessonThumbs/x/l/v.jpg", "academy/purpose/v1.jpg"], pathsAffected: [] }),
    markPending: async () => {}, deleteContent: async () => {}, deleteProgress: async () => 0, deleteAttempts: async () => 0,
    deleteImage: async (p) => { deleted.push(p); }, clearPending: async () => {},
  };
  await runCourseDeletion(ops, "x");
  assert.deepEqual(deleted.sort(), ["academy/covers/x/v1.jpg", "academy/lessonThumbs/x/l/v.jpg"]);
});

const opsWith = (images, referencedElsewhere, deleted, cleared) => ({
  plan: async () => ({ exists: true, title: "X", contentRefs: ["course"], images, pathsAffected: [] }),
  markPending: async () => {}, deleteContent: async () => {}, deleteProgress: async () => 0, deleteAttempts: async () => 0,
  deleteImage: async (p) => { deleted.push(p); }, clearPending: async () => { cleared.push(true); }, referencedElsewhere,
});
test("deleting the OWNING course keeps its image while another course/draft still uses it", async () => {
  const deleted = [], cleared = [];
  const r = await runCourseDeletion(opsWith(["academy/covers/x/shared.jpg", "academy/covers/x/only-mine.jpg"],
    async (paths, id) => { assert.equal(id, "x"); return new Set(paths.filter((p) => p.endsWith("shared.jpg"))); }, deleted, cleared), "x");
  assert.deepEqual(deleted, ["academy/covers/x/only-mine.jpg"]);
  assert.deepEqual(r.keptShared, ["academy/covers/x/shared.jpg"]);
  assert.equal(r.pendingCleared, true, "a kept shared image is intentional, not a failure");
});
test("if the reference check can't run, NO image is deleted and the clean-up stays pending for a retry", async () => {
  const deleted = [], cleared = [];
  const r = await runCourseDeletion(opsWith(["academy/covers/x/a.jpg"], async () => { throw new Error("offline"); }, deleted, cleared), "x");
  assert.deepEqual(deleted, []);
  assert.deepEqual(r.failedImages, ["academy/covers/x/a.jpg"]);
  assert.equal(r.pendingCleared, false);
  assert.equal(r.contentDeleted, true);
});
