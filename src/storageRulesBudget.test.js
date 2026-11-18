/* storage.rules — the Firestore DOCUMENT BUDGET of every request.

   A Cloud Storage rules evaluation may access at most two Firestore documents
   ("No more than two Firestore documents may be accessed in a single Rules
   evaluation" — firebase.google.com/docs/storage/security/rules-conditions).
   Neither the emulator nor the Rules test API enforces this, so emulator tests
   alone can't catch it: production refused editor uploads to a draft-only
   course (users + courses + courseDrafts = three documents) as
   storage/unauthorized, while every emulator test passed.

   This test reads storage.rules, inlines every function, and computes for each
   match block and each method the set of DISTINCT documents any matching
   `allow` could touch (conservatively: all branches, no short-circuiting, every
   allow for that method together — they're one evaluation). The set must have
   at most two members. Run: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// STORAGE_RULES_FILE: check another copy (e.g. the deployed rules) with the same parser
const SRC = readFileSync(process.env.STORAGE_RULES_FILE || new URL("../storage.rules", import.meta.url), "utf8").replace(/\/\/[^\n]*/g, "");
const LIMIT = 2;

const FUNCS = {};
for (const m of SRC.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*\{\s*return([\s\S]*?);\s*\}/g)) {
  FUNCS[m[1]] = { params: m[2].split(",").map((s) => s.trim()).filter(Boolean), body: m[3] };
}

// split "a, f(b, c), 'x'" at top-level commas
function splitArgs(s) {
  const out = []; let depth = 0, cur = "", q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// the argument text of the call starting at `open` (the index of its "(")
function callArgs(expr, open) {
  let depth = 0;
  for (let i = open; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    if (expr[i] === ")" && --depth === 0) return expr.slice(open + 1, i);
  }
  throw new Error("unbalanced call in: " + expr.slice(open, open + 80));
}
const subst = (text, env) => text.replace(/\b[A-Za-z_]\w*\b/g, (w) => (w in env ? env[w] : w));

/* Every document template an expression may access, functions inlined. */
function docsOf(expr, env = {}, stack = []) {
  const docs = new Set();
  for (const m of expr.matchAll(/firestore\.(?:get|exists)\(/g)) {
    // the whole (balanced) path argument, e.g. "/databases/(default)/documents/users/$(request.auth.uid)"
    const arg = callArgs(expr, m.index + m[0].length - 1).trim();
    const prefix = "/databases/(default)/documents/";
    if (!arg.startsWith(prefix)) throw new Error("unrecognised Firestore path: " + arg);
    docs.add(subst(arg.slice(prefix.length), env).replace(/\s+/g, " "));
  }
  for (const m of expr.matchAll(/(?<![.\w])(\w+)\s*\(/g)) {
    const f = FUNCS[m[1]];
    if (!f) continue;
    if (stack.includes(m[1])) throw new Error("recursive rules function " + m[1]);
    const args = splitArgs(callArgs(expr, m.index + m[0].length - 1)).map((a) => subst(a, env));
    const inner = Object.fromEntries(f.params.map((p, i) => [p, args[i] ?? p]));
    for (const d of docsOf(f.body, inner, [...stack, m[1]])) docs.add(d);
  }
  return docs;
}

/* match path → { method → Set(doc templates) } */
const METHODS = ["get", "list", "create", "update", "delete"];
const expand = (list) => list.flatMap((m) => (m === "read" ? ["get", "list"] : m === "write" ? ["create", "update", "delete"] : [m]));
function budget() {
  const out = {};
  for (const block of SRC.matchAll(/match\s+(\/\S+)\s*\{([^{}]*)\}/g)) {
    const per = Object.fromEntries(METHODS.map((m) => [m, new Set()]));
    for (const a of block[2].matchAll(/allow\s+([\w,\s]+):\s*if\s+([\s\S]*?);/g)) {
      const ms = expand(a[1].split(",").map((s) => s.trim()));
      const docs = docsOf(a[2]);
      for (const m of ms) for (const d of docs) per[m].add(d);
    }
    out[block[1]] = per;
  }
  return out;
}

const B = budget();
const ME = "users/$(request.auth.uid)";
const show = (s) => [...s].sort();

test("the parser sees every Academy match block and inlines the functions", () => {
  for (const p of ["/academy/covers/{courseId}/{file}", "/academy/lessonThumbs/{courseId}/{lessonId}/{file}", "/academy/guideThumbs/{guideId}/{file}",
    "/academy/pathCovers/{pathId}/{file}", "/academy/catCovers/{categoryId}/{file}", "/academy/categoryArt/{categoryId}/{file}", "/academy/purpose/{file}", "/{allPaths=**}"]) {
    assert.ok(B[p], `match ${p} parsed`);
  }
  assert.ok(Object.keys(FUNCS).length >= 10, "functions parsed");
  assert.deepEqual(show(docsOf("isEditor()")), [ME], "role checks read only the profile");
});

test(`no request can touch more than ${LIMIT} Firestore documents (the production limit)`, () => {
  const over = [];
  for (const [p, per] of Object.entries(B)) for (const [m, s] of Object.entries(per)) if (s.size > LIMIT) over.push(`${m} ${p}: ${show(s).join(" + ")}`);
  assert.deepEqual(over, [], "over the Storage rules document limit");
});

test("exact documents per operation (the reviewed budget)", () => {
  const exp = {
    "/academy/covers/{courseId}/{file}": { get: [ME, "academyLearnerMedia/$('course_' + courseId)"], create: [ME, "courseDrafts/$(courseId)"], delete: [ME] },
    "/academy/lessonThumbs/{courseId}/{lessonId}/{file}": { get: [ME, "academyLearnerMedia/$('course_' + courseId)"], create: [ME, "courseDrafts/$(courseId)"], delete: [ME] },
    "/academy/guideThumbs/{guideId}/{file}": { get: [ME, "academyLearnerMedia/$('guide_' + guideId)"], create: [ME, "guideDrafts/$(guideId)"], delete: [ME] },
    "/academy/pathCovers/{pathId}/{file}": { get: [ME, "paths/$(pathId)"], create: [ME, "paths/$(pathId)"], delete: [ME, "paths/$(pathId)"] },
    "/academy/catCovers/{categoryId}/{file}": { get: [ME], create: [ME, "academyCategories/$(categoryId)"], delete: [ME] },
    "/academy/purpose/{file}": { get: [ME], create: [ME], delete: [ME] },
    "/{allPaths=**}": { get: [], create: [], delete: [] },
  };
  for (const [p, ms] of Object.entries(exp)) for (const [m, docs] of Object.entries(ms)) {
    assert.deepEqual(show(B[p][m]), [...docs].sort(), `${m} ${p}`);
    if (m === "create") assert.deepEqual(show(B[p].update), [...docs].sort(), `update ${p} = create`);
  }
});

test("regression: the previous course-image rules needed THREE documents for a draft-only course", () => {
  // the rule that production refused (d3ae810), evaluated with the same parser
  FUNCS.oldCourseExists = { params: ["c"], body: "firestore.exists(/databases/(default)/documents/courses/$(c))" };
  FUNCS.oldDraftExists = { params: ["c"], body: "firestore.exists(/databases/(default)/documents/courseDrafts/$(c))" };
  const old = docsOf("isEditor() && (oldCourseExists(courseId) || oldDraftExists(courseId))");
  delete FUNCS.oldCourseExists; delete FUNCS.oldDraftExists;
  assert.equal(old.size, 3, show(old).join(" + "));
});
