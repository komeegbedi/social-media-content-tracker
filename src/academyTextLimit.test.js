/* The client mirrors the server's 20,000-character limit on formatted text, so an over-long
   course description or lesson text is named in the publish checklist instead of failing as
   "permission denied". */
import { test } from "node:test";
import assert from "node:assert/strict";
import { publishIssues, TEXT_LIMIT } from "./academyProgress.js";

const course = (over = {}) => ({ title: "C", category: "photography", level: "beginner", cover: { path: "academy/covers/c/v.jpg" }, about: "", modules: [{ id: "m1", title: "", lessonIds: ["l1"] }], ...over });
const lesson = (over = {}) => ({ id: "l1", title: "L", moduleId: "m1", kind: "written", video: null, description: "", quiz: { mode: "none", questions: [] }, ...over });

test("limit matches the rules", () => assert.equal(TEXT_LIMIT, 20000));
test("course ‘about’ and lesson text at the limit publish; one character over is a named issue", () => {
  const keys = (c, ls) => publishIssues(c, ls, ["photography"]).map((i) => i.key);
  assert.deepEqual(keys(course({ about: "a".repeat(20000) }), [lesson({ description: "d".repeat(20000) })]), []);
  assert.deepEqual(keys(course({ about: "a".repeat(20001) }), [lesson()]), ["about-long"]);
  assert.deepEqual(keys(course(), [lesson({ description: "d".repeat(20001) })]), ["ld:l1"]);
  const i = publishIssues(course(), [lesson({ title: "Exposure", description: "d".repeat(20001) })], ["photography"])[0];
  assert.match(i.label, /“Exposure” description/);
  assert.match(i.message, /Shorten this text to 20,000 characters or fewer/);
});
