/* Tests for the Task-Creation & Workflow UX helpers (v2).
   Run with: node --test src/data.uxv2.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidUrl, userDepartments, isAvailable,
  soloCrewRole, soloCrewFor, soloCrewVerb, autoAssign, workloadBadge,
} from "./data.js";

test("isValidUrl accepts http(s) URLs, rejects plain text", () => {
  assert.equal(isValidUrl("https://drive.google.com/abc"), true);
  assert.equal(isValidUrl("http://example.com"), true);
  assert.equal(isValidUrl("HTTPS://Example.com/x"), true);
  assert.equal(isValidUrl("drive.google.com"), false);   // no scheme
  assert.equal(isValidUrl("just some text"), false);
  assert.equal(isValidUrl("ftp://example.com"), false);   // wrong scheme
  assert.equal(isValidUrl("https://nodot"), false);       // no dotted host
  assert.equal(isValidUrl(""), false);
  assert.equal(isValidUrl(null), false);
  assert.equal(isValidUrl("https://a.com with space"), false);
});

test("userDepartments normalises legacy string + new array", () => {
  assert.deepEqual(userDepartments({ department: "QA" }), ["QA"]);
  assert.deepEqual(userDepartments({ departments: ["QA", "Photography"] }), ["QA", "Photography"]);
  assert.deepEqual(userDepartments({ departments: [] }), []);          // array wins over legacy
  assert.deepEqual(userDepartments({ departments: [], department: "QA" }), []);
  assert.deepEqual(userDepartments({}), []);
  assert.deepEqual(userDepartments(null), []);
});

test("isAvailable defaults to true, false only when explicitly unavailable", () => {
  assert.equal(isAvailable({}), true);
  assert.equal(isAvailable({ available: true }), true);
  assert.equal(isAvailable({ available: false }), false);
  assert.equal(isAvailable(null), true);
});

test("solo-owner crew role maps by type", () => {
  assert.equal(soloCrewRole("Poster"), "leaddesign");
  assert.equal(soloCrewRole("Reel"), "contentlead");
  assert.equal(soloCrewRole("Photography"), "contentlead");
  assert.deepEqual(soloCrewFor("Poster", "Kome"), { name: "Kome", role: "leaddesign" });
  assert.deepEqual(soloCrewFor("Reel", "Kome"), { name: "Kome", role: "contentlead" });
  assert.match(soloCrewVerb("Poster"), /graphic/);
  assert.match(soloCrewVerb("Reel"), /reel/);
});

test("workloadBadge buckets by availability + active count", () => {
  const u = { available: true };
  assert.equal(workloadBadge(u, 0).label, "Available");
  assert.equal(workloadBadge(u, 1).label, "Light");
  assert.equal(workloadBadge(u, 2).label, "Light");
  assert.equal(workloadBadge(u, 3).label, "Moderate");
  assert.equal(workloadBadge(u, 5).label, "Moderate");
  assert.equal(workloadBadge(u, 6).label, "High");
  assert.equal(workloadBadge(u, 99).label, "High");
  // Unavailable always wins, regardless of count.
  assert.equal(workloadBadge({ available: false }, 0).label, "Unavailable");
  assert.equal(workloadBadge({ available: false }, 8).label, "Unavailable");
  // tones are stable for styling
  assert.equal(workloadBadge(u, 0).tone, "green");
  assert.equal(workloadBadge(u, 6).tone, "red");
});

test("autoAssign never picks an unavailable person", () => {
  const users = [
    { name: "Owner", skills: ["coordinate"], location: ["828"] },
    { name: "Shooter", skills: ["shoot"], location: ["828"], available: false },
    { name: "Editor", skills: ["edit"], location: ["828"] },
  ];
  const out = autoAssign({ type: "Reel", location: "828", owner: "Owner" }, users);
  const names = out.map((s) => s.name);
  assert.ok(!names.includes("Shooter"), "unavailable Shooter must be excluded");
  assert.ok(names.includes("Editor"), "available Editor should be assigned");
});
