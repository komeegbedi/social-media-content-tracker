/* Mention candidate selection + typeahead + rendering (client) — pure.
   Run with: node --test src/mentions.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mentionableUsers, mentionQuery, filterMentionCandidates, groupMentionOptions,
  mentionDisambiguator, applyMention, mentionTokenPresent, syncCommentMentions,
  mentionSegments,
} from "./data.js";

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

/* ---------------------------------------------------------------------------
   @mention typeahead — query detection, filtering, insertion, sync
   --------------------------------------------------------------------------- */

test("mentionQuery: detects the active @query at the caret (spaces allowed in names)", () => {
  assert.deepEqual(mentionQuery("hi @Ol", 6), { start: 3, query: "Ol" });
  assert.deepEqual(mentionQuery("hi @Oluwa Tof", 13), { start: 3, query: "Oluwa Tof" });
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });        // bare @ opens the list
});

test("mentionQuery: an email '@' does NOT trigger (preceded by a word char)", () => {
  assert.equal(mentionQuery("mail me@host", 7), null);
});

test("mentionQuery: stops at a newline and returns null past it", () => {
  assert.equal(mentionQuery("@Ada\nhello", 10), null);   // caret on the 2nd line, no @ there
});

test("mentionQuery: the NEAREST @ left of the caret is the active one", () => {
  assert.deepEqual(mentionQuery("@Ada hi @B", 10), { start: 8, query: "B" });
});

test("filterMentionCandidates: case-insensitive full-name prefix; assignees first", () => {
  const cands = [
    { id: "a", name: "Ada Admin" }, { id: "b", name: "Bo Crew" },
    { id: "o", name: "OluwaTofunmi OlaTunde" }, { id: "z", name: "Zed" },
  ];
  assert.deepEqual(filterMentionCandidates(cands, "oluwa", []).map((u) => u.id), ["o"]);
  assert.deepEqual(filterMentionCandidates(cands, "", []).map((u) => u.id), ["a", "b", "o", "z"]); // all, alpha
  // 'b' is a task assignee → floated to the top even though 'a' sorts earlier.
  assert.deepEqual(filterMentionCandidates(cands, "", ["b"]).map((u) => u.id), ["b", "a", "o", "z"]);
});

test("groupMentionOptions: offers the single @all group token by query prefix", () => {
  assert.deepEqual(groupMentionOptions(""), ["all"]);
  assert.deepEqual(groupMentionOptions("al"), ["all"]);
  assert.deepEqual(groupMentionOptions("ev"), []);    // 'everyone' is no longer an alias
  assert.deepEqual(groupMentionOptions("zz"), []);
});

test("mentionDisambiguator: only when the full name is shared, shows secondary info", () => {
  const cands = [{ id: "1", name: "Sam Lee", email: "sam1@x.com" }, { id: "2", name: "Sam Lee", email: "sam2@x.com" }, { id: "3", name: "Bo" }];
  assert.equal(mentionDisambiguator(cands[0], cands), "sam1@x.com");
  assert.equal(mentionDisambiguator(cands[2], cands), "");     // unique name → no hint
});

test("applyMention: replaces the @query AT THE CARET with the FULL name + space", () => {
  // "hi @Ol rest", caret after "Ol" (index 6). Insert full name, keep " rest".
  const r = applyMention("hi @Ol rest", 3, 6, "OluwaTofunmi OlaTunde");
  assert.equal(r.text, "hi @OluwaTofunmi OlaTunde rest");        // no double space before "rest"
  assert.equal(r.caret, "hi @OluwaTofunmi OlaTunde".length + 0); // caret sits before the kept space
  // At end of text a trailing space IS added so the user can keep typing.
  const e = applyMention("hi @Ol", 3, 6, "Bo Crew");
  assert.equal(e.text, "hi @Bo Crew ");
  assert.equal(e.caret, "hi @Bo Crew ".length);
});

test("syncCommentMentions: only mentions still present in the draft are kept, deduped", () => {
  const selected = [{ uid: "a", name: "Ada Admin" }, { uid: "b", name: "Bo Crew" }, { uid: "a", name: "Ada Admin" }];
  const r = syncCommentMentions("hey @Ada Admin look", selected);
  assert.deepEqual(r.mentions, ["a"]);                 // Bo's token was edited away; 'a' deduped
  assert.deepEqual(r.mentionNames, ["Ada Admin"]);
  assert.equal(r.mentionAll, false);
});

test("syncCommentMentions: detects @all as the group token", () => {
  assert.equal(syncCommentMentions("ping @all now", []).mentionAll, true);
  assert.equal(syncCommentMentions("ping @everyone", []).mentionAll, false);  // no longer an alias
  assert.equal(syncCommentMentions("no group here", []).mentionAll, false);
});

test("mentionTokenPresent: boundary-aware (not a substring of a longer word)", () => {
  assert.equal(mentionTokenPresent("@Sam here", "Sam"), true);
  assert.equal(mentionTokenPresent("@Sammy here", "Sam"), false);   // must not match inside @Sammy
  assert.equal(mentionTokenPresent("email a@b.com", "b"), false);   // email @ never a mention
});

/* ---------------------------------------------------------------------------
   Rendered-comment highlighting (mentionSegments)
   --------------------------------------------------------------------------- */

const seg = (text, opts) => mentionSegments(text, opts).map((s) => (s.mention ? `[${s.text}]` : s.text)).join("");

test("mentionSegments: full names (incl. spaces) highlight as ONE unit", () => {
  assert.equal(
    seg("@David Graphic Design @Tofunmi can't find it", { mentionNames: ["David Graphic Design", "Tofunmi"] }),
    "[@David Graphic Design] [@Tofunmi] can't find it");
});

test("mentionSegments: punctuation and multi-line text are preserved verbatim", () => {
  const out = mentionSegments("Hey @Ada,\nsee this.", { mentionNames: ["Ada"] });
  assert.deepEqual(out, [
    { text: "Hey ", mention: false, group: false },
    { text: "@Ada", mention: true, group: false },
    { text: ",\nsee this.", mention: false, group: false },
  ]);
});

test("mentionSegments: @all highlights only when the group flag is set", () => {
  assert.equal(seg("ping @all now", { mentionAll: true }), "ping [@all] now");
  assert.equal(seg("ping @all now", { mentionAll: false }), "ping @all now");  // plain text otherwise
});

test("mentionSegments: emails and arbitrary @text are NOT highlighted", () => {
  // "bob" is a real mention name, yet the email's '@' (preceded by a word char) is
  // never a trigger; "@nobody" is not a selected name, so it stays plain text too.
  assert.equal(seg("write bob@example.com or @nobody", { mentionNames: ["bob"] }), "write bob@example.com or @nobody");
});

test("mentionSegments: legacy comments fall back to the mentioned users' FIRST names", () => {
  // Old impl inserted '@Firstname' and stored only uids; render resolves first names.
  assert.equal(
    seg("thanks @Oluwa!", { mentionNames: [], legacyNames: ["Oluwa"] }),
    "thanks [@Oluwa]!");
});

test("mentionSegments: no mentions → a single plain text segment", () => {
  assert.deepEqual(mentionSegments("just text", {}), [{ text: "just text", mention: false, group: false }]);
});
