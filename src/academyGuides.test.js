import { test } from "node:test";
import assert from "node:assert/strict";
import { guidePublishIssues, guideDraftFromLive, guideRow, GUIDE_CONTENT_FIELDS, guideFingerprint, pathPickerGuides } from "./academyGuides.js";

test("what publishing a tip/resource requires (and only that)", () => {
  const ok = { title: "Export tips", category: "photo", body: "Long edge 2048 px.", video: null };
  assert.deepEqual(guidePublishIssues(ok, ["photo"]), [], "a text-only resource publishes without a video");
  assert.deepEqual(guidePublishIssues({ ...ok, body: "", video: { provider: "youtube", id: "dQw4w9WgXcQ" } }, ["photo"]), [], "a video resource needs no text");
  const keys = (g, cats = ["photo"]) => guidePublishIssues(g, cats).map((i) => i.key);
  assert.deepEqual(keys({ ...ok, title: " " }), ["title"]);
  assert.deepEqual(keys({ ...ok, category: "gone" }), ["category"], "only categories that exist (workspace-created ones too)");
  assert.deepEqual(keys({ ...ok, category: "test-loy4" }, ["photo", "test-loy4"]), [], "a workspace-created category is fine (the old editor refused these)");
  assert.deepEqual(keys({ ...ok, body: "" }), ["content"], "no video and no text");
  assert.deepEqual(keys({ ...ok, video: { provider: "youtube", id: "bad" } }), ["video"], "an unsupported video link");
  assert.equal(guidePublishIssues({ ...ok, title: "" }, ["photo"])[0].fix, "Add title");
});

test("opening a legacy resource never converts its text: the draft copies values as they are", () => {
  const live = { title: "Old guide", category: "photo", body: "Use *literal* punctuation -- like this.", video: null, resources: [{ label: "Doc", url: "https://x.y" }], status: "published", publishedAt: 1 };
  const d = guideDraftFromLive(live);
  assert.equal(d.body, live.body);
  assert.equal("mdVersion" in d, false, "no mdVersion added: legacy text stays legacy until edited");
  assert.equal(d.status, undefined, "only content fields");
  assert.deepEqual(Object.keys(d).every((k) => GUIDE_CONTENT_FIELDS.includes(k)), true);
  assert.equal(guideDraftFromLive({ ...live, mdVersion: 2 }).mdVersion, 2);
});

test("rows for management/deletion: every status; conflicts; fingerprints change on any publish/save", () => {
  const ts = (n) => ({ toMillis: () => n });
  assert.equal(guideRow("g", null, { title: "A", category: "c", rev: 1, publishedRev: 0 }, ["c"]).status, "draft-only");
  assert.equal(guideRow("g", { status: "published", category: "c" }, { category: "c", rev: 3, publishedRev: 3 }, ["c"]).status, "published");
  const edits = guideRow("g", { status: "published", category: "c" }, { category: "c", rev: 4, publishedRev: 3 }, ["c"]);
  assert.equal(edits.status, "published-edits"); assert.equal(edits.changes, true);
  assert.equal(guideRow("g", { status: "archived", category: "c" }, null, ["c"]).status, "archived");
  assert.equal(guideRow("g", { status: "published", category: "c" }, { category: "other", rev: 2, publishedRev: 1 }, ["c"]).draftConflict, true);
  assert.equal(guideRow("g", { status: "published", category: "other" }, { category: "c", rev: 2, publishedRev: 1 }, ["c"]).publishedElsewhere, true);
  assert.equal(guideRow("g", null, { video: { provider: "youtube", id: "x" } }).kind, "video");
  assert.notEqual(guideFingerprint({ status: "published", category: "c", updatedAt: ts(1) }, null), guideFingerprint({ status: "published", category: "c", updatedAt: ts(2) }, null));
});

test("text over the server's 20,000-character limit is a publish issue (not a permission error); exactly 20,000 is fine", () => {
  const base = { title: "T", category: "photo", video: null };
  assert.deepEqual(guidePublishIssues({ ...base, body: "x".repeat(20000) }, ["photo"]), []);
  const issues = guidePublishIssues({ ...base, body: "x".repeat(20001) }, ["photo"]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, "body-long");
  assert.match(issues[0].message, /Shorten the text to 20,000 characters or fewer/);
});

test("learning-path picker (editors): never-published resources are listed, labelled, alongside published/unpublished/archived ones", () => {
  const live = [{ id: "p", title: "Published one", category: "photo", status: "published" }, { id: "u", title: "Unpublished", category: "photo", status: "draft" }, { id: "a", title: "Archived", category: "photo", status: "archived" }];
  const drafts = [{ id: "p", title: "Published one (edited draft)", category: "photo" }, { id: "n", title: "Brand new", category: "film" }, { id: "e", title: "  ", category: "" }];
  const rows = pathPickerGuides(live, drafts);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(by).sort(), ["a", "e", "n", "p", "u"]);
  assert.equal(by.n.status, "draft-only"); assert.equal(by.n.statusLabel, "not published yet"); assert.equal(by.n.category, "film");
  assert.equal(by.p.title, "Published one", "a published resource shows its PUBLISHED title, not private draft edits");
  assert.equal(by.p.statusLabel, ""); assert.equal(by.u.statusLabel, "unpublished"); assert.equal(by.a.statusLabel, "archived");
  assert.equal(by.e.title, "Untitled resource");
  assert.deepEqual(pathPickerGuides(live, []).map((r) => r.id).sort(), ["a", "p", "u"], "without drafts (e.g. not an editor), only records");
});
