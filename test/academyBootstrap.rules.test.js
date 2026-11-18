/* "Create the starter categories" — the REAL writer (src/academyBootstrap.js,
   the same function the workspace button calls) against the REAL
   firestore.rules in the emulator, starting from an EMPTY Academy (only user
   profiles are seeded; categories are never inserted by the test).

   Run (self-contained):   npm run test:academy
   Or against a running emulator: node --test test/academyBootstrap.rules.test.js */
import { assertThrowawayProject } from "./emulatorGuard.js";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, getDocs, collection, updateDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { createStarterCategories, CATEGORY_RECORD_FIELDS } from "../src/academyBootstrap.js";
import { defaultCategoryRecords } from "../src/academyProgress.js";

// its own demo-* namespace in the emulator, so clearing it never touches the other suites' data
const PROJECT_ID = assertThrowawayProject(`${process.env.RULES_TEST_PROJECT || "demo-academy-test"}-bootstrap`);
let env;
const USERS = {
  admin:   { name: "Ada Admin",   role: "admin",  status: "approved" },
  admin2:  { name: "Abe Admin",   role: "admin",  status: "approved" },
  editor:  { name: "Ines Editor", role: "member", status: "approved", academyEditor: true },
  member:  { name: "Mel Member",  role: "member", status: "approved" },
  pending: { name: "Peg Pending", role: "member", status: "pending" },
};
const as = (uid) => env.authenticatedContext(uid).firestore();
const IDS = defaultCategoryRecords().map((r) => r.id);
const ALLOWED = new Set([...CATEGORY_RECORD_FIELDS, "createdAt", "createdBy", "updatedAt", "updatedBy"]);
async function categories(db = as("member")) { const s = await getDocs(collection(db, "academyCategories")); return Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); }
const plain = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v && typeof v.toMillis === "function" ? v.toMillis() : v)));

before(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  const [h, p] = host.split(":");
  env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { host: h, port: Number(p), rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") } });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => { const db = ctx.firestore(); for (const [uid, u] of Object.entries(USERS)) await setDoc(doc(db, "users", uid), u); });
});

test("root cause: the previous payload (the record spread with its `id`) is refused even for an admin", async () => {
  const [first] = defaultCategoryRecords();
  await assertFails(setDoc(doc(as("admin"), "academyCategories", first.id),
    { ...first, createdAt: serverTimestamp(), createdBy: "admin", updatedAt: serverTimestamp(), updatedBy: "admin" }));
});

test("an approved admin creates all six from an empty Academy; only allowed fields, attributed, persisted on the server", async () => {
  assert.deepEqual(await categories(), {}, "starts empty");
  const res = await assertSucceeds(createStarterCategories(as("admin"), "admin"));
  assert.deepEqual(res.created.sort(), [...IDS].sort());
  assert.deepEqual(res.existing, []);
  const stored = await categories();                       // read back as another user, from the emulator
  assert.deepEqual(Object.keys(stored).sort(), [...IDS].sort());
  for (const [id, d] of Object.entries(stored)) {
    assert.deepEqual(Object.keys(d).filter((k) => !ALLOWED.has(k)), [], `${id}: only allowed fields`);
    assert.ok(!("id" in d), `${id}: no id field`);
    assert.equal(d.createdBy, "admin"); assert.equal(d.updatedBy, "admin");
    assert.ok(d.createdAt && d.updatedAt, `${id}: server timestamps`);
    assert.equal(d.hidden, false); assert.equal(d.cover, null);
  }
  assert.equal(stored.photography.name, "Photography");
});

test("repeating setup creates nothing and changes nothing", async () => {
  await createStarterCategories(as("admin"), "admin");
  const before = plain(await categories());
  const again = await createStarterCategories(as("admin2"), "admin2");
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.existing.sort(), [...IDS].sort());
  assert.deepEqual(plain(await categories()), before, "no document was rewritten (timestamps and attribution unchanged)");
});

test("a retry after a partial state creates only the missing ones; existing names, descriptions and visibility survive", async () => {
  await createStarterCategories(as("admin"), "admin");
  // an admin edits Photography through the normal update rule (rename, describe, hide)
  const photo = await getDoc(doc(as("admin"), "academyCategories", "photography"));
  await assertSucceeds(updateDoc(doc(as("admin"), "academyCategories", "photography"),
    { name: "Photo & Light", description: "Our own description", hidden: true, updatedAt: serverTimestamp(), updatedBy: "admin" }));
  // one category missing (e.g. deleted by the server's category deletion)
  await env.withSecurityRulesDisabled(async (ctx) => { await deleteDoc(doc(ctx.firestore(), "academyCategories", "filmmaking")); });
  const res = await createStarterCategories(as("admin2"), "admin2");
  assert.deepEqual(res.created, ["filmmaking"]);
  const p = (await categories()).photography;
  assert.equal(p.name, "Photo & Light"); assert.equal(p.description, "Our own description"); assert.equal(p.hidden, true);
  assert.equal(p.createdAt.toMillis(), photo.data().createdAt.toMillis(), "Photography was not re-created");
});

test("two admins setting up at the same time: each category is created exactly once", async () => {
  const [a, b] = await Promise.all([createStarterCategories(as("admin"), "admin"), createStarterCategories(as("admin2"), "admin2")]);
  const created = [...a.created, ...b.created].sort();
  assert.deepEqual(created, [...IDS].sort(), "every id created once across both attempts");
  assert.equal(Object.keys(await categories()).length, IDS.length);
});

test("non-admins are refused and nothing is written: Academy editor, member, pending user, signed out", async () => {
  for (const uid of ["editor", "member", "pending"]) {
    await assertFails(createStarterCategories(as(uid), uid));
  }
  await assertFails(createStarterCategories(env.unauthenticatedContext().firestore(), "nobody"));
  assert.deepEqual(await categories(as("admin")), {});
});
