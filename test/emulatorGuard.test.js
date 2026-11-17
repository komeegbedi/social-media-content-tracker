/* The guard that keeps destructive suites off the development project's data. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertThrowawayProject } from "./emulatorGuard.js";

test("refuses the dev project id, unknown ids and a missing id", () => {
  assert.throws(() => assertThrowawayProject("ifc-social-media-tracker"), /refusing/);
  assert.throws(() => assertThrowawayProject("my-team-project"), /refusing/);
  assert.throws(() => assertThrowawayProject(undefined), /no project id/);
  assert.throws(() => assertThrowawayProject(""), /no project id/);
});
test("allows demo-* and the generated rules-test ids", () => {
  assert.equal(assertThrowawayProject("demo-academy-test"), "demo-academy-test");
  assert.equal(assertThrowawayProject("rules-test-1794590000000"), "rules-test-1794590000000");
  assert.equal(assertThrowawayProject("academy-rules-1794590000000"), "academy-rules-1794590000000");
});
test("refuses the dev bucket or a bucket of another project", () => {
  assert.throws(() => assertThrowawayProject("demo-x", { bucket: "ifc-social-media-tracker.firebasestorage.app" }), /bucket/);
  assert.throws(() => assertThrowawayProject("demo-x", { bucket: "demo-y.appspot.com" }), /bucket/);
  assert.doesNotThrow(() => assertThrowawayProject("demo-x", { bucket: "demo-x.appspot.com" }));
});
