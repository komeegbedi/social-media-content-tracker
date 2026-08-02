/* Mention candidate selection (client) — pure.
   Run with: node --test src/mentions.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionableUsers } from "./data.js";

const users = [
  { id: "me", name: "Me", status: "approved" },
  { id: "b", name: "Bo", status: "approved" },
  { id: "a", name: "Ada", status: "approved" },
  { id: "pend", name: "Peg", status: "pending" },
];
const me = { id: "me" };

test("offers approved teammates excluding self, sorted by name", () => {
  assert.deepEqual(mentionableUsers(users, me).map((u) => u.id), ["a", "b"]);
});

test("excludes pending/unapproved users", () => {
  assert.ok(!mentionableUsers(users, me).some((u) => u.id === "pend"));
});

test("tolerates empty input", () => {
  assert.deepEqual(mentionableUsers(undefined, me), []);
  assert.deepEqual(mentionableUsers([], me), []);
});
