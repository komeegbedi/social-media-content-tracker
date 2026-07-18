import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidEmail } from "./data.js";

test("valid email accepted", () => { assert.equal(isValidEmail("name@example.com"), true); });
test("trims surrounding spaces", () => { assert.equal(isValidEmail("  name@example.com  "), true); });
test("missing domain rejected", () => { assert.equal(isValidEmail("name@"), false); });
test("missing @ rejected", () => { assert.equal(isValidEmail("name.example.com"), false); });
test("multiple @ rejected", () => { assert.equal(isValidEmail("a@b@example.com"), false); });
test("internal space rejected", () => { assert.equal(isValidEmail("na me@example.com"), false); });
test("empty rejected", () => { assert.equal(isValidEmail(""), false); assert.equal(isValidEmail("   "), false); });
test("no TLD dot rejected", () => { assert.equal(isValidEmail("name@localhost"), false); });
