/* Mention candidate selection + typeahead + rendering (client) — pure.
   Run with: node --test src/mentions.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mentionableUsers, mentionQuery, filterMentionCandidates, groupMentionOptions,
  mentionDisambiguator, applyMention, mentionTokenPresent, syncCommentMentions,
  mentionSegments, selectedMentionSpans, planMentionDeletion, reconcileTokens, tokenSegments, applyTokenEdit,
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

/* ---------------------------------------------------------------------------
   Atomic mention tokens — spans + whole-token deletion planning
   --------------------------------------------------------------------------- */

test("selectedMentionSpans: tags each present token with its identity (uid / group)", () => {
  const sel = [{ uid: "u1", name: "Tofunmi" }, { uid: "u2", name: "Bo Crew" }];
  const spans = selectedMentionSpans("hi @Tofunmi and @Bo Crew ok", sel, false);
  assert.deepEqual(spans.map((s) => [s.start, s.end, s.uid, s.group]),
    [[3, 11, "u1", false], [16, 24, "u2", false]]);
  // @all tagged as a group span when the flag is set.
  const g = selectedMentionSpans("ping @all now", [], true);
  assert.deepEqual(g.map((s) => [s.start, s.end, s.group, s.name]), [[5, 9, true, "all"]]);
  // An unselected name is NOT a span (no identity to make it a token).
  assert.deepEqual(selectedMentionSpans("@Bo Crew", [], false), []);
});

test("planMentionDeletion: Backspace at a token end removes the whole token + its space", () => {
  const sel = [{ uid: "u1", name: "Tofunmi" }];
  const spans = selectedMentionSpans("@Tofunmi hey", sel, false);
  assert.deepEqual(planMentionDeletion("@Tofunmi hey", 8, 8, "backward", spans),
    { text: "hey", caret: 0, range: [0, 9], removed: [{ name: "Tofunmi", group: false, uid: "u1" }] });
});

test("planMentionDeletion: Delete at a token start, and Backspace from inside, both remove it whole", () => {
  const sel = [{ uid: "u1", name: "Tofunmi" }];
  const spans = selectedMentionSpans("@Tofunmi hey", sel, false);
  assert.equal(planMentionDeletion("@Tofunmi hey", 0, 0, "forward", spans).text, "hey");   // delete at start
  assert.equal(planMentionDeletion("@Tofunmi hey", 4, 4, "backward", spans).text, "hey");  // backspace inside
});

test("planMentionDeletion: an edit that touches no token returns null (edit normally)", () => {
  const sel = [{ uid: "u1", name: "Tofunmi" }];
  const spans = selectedMentionSpans("@Tofunmi hey", sel, false);
  assert.equal(planMentionDeletion("@Tofunmi hey", 11, 11, "backward", spans), null);  // deep in "hey"
});

test("planMentionDeletion: a range overlapping a token removes the entire token", () => {
  const sel = [{ uid: "u1", name: "Bo Crew" }];
  const spans = selectedMentionSpans("hi @Bo Crew there", sel, false);
  const r = planMentionDeletion("hi @Bo Crew there", 6, 13, "backward", spans);   // mid-token → mid-"there"
  assert.equal(r.text.includes("@Bo Crew"), false);
  assert.deepEqual(r.removed, [{ name: "Bo Crew", group: false, uid: "u1" }]);
});

test("planMentionDeletion: removing an @all token reports a group removal", () => {
  const spans = selectedMentionSpans("ping @all now", [], true);
  const r = planMentionDeletion("ping @all now", 7, 7, "backward", spans);
  assert.equal(r.text, "ping now");
  assert.equal(r.removed[0].group, true);
});

/* ---------------------------------------------------------------------------
   Position-tracked tokens — identity survives boundary changes (the bug fix)
   --------------------------------------------------------------------------- */
const tok = (start, name, uid, group = false) => ({ start, name, uid, group });

test("reconcileTokens: deleting the trailing separator KEEPS the token (identity survives)", () => {
  const r = reconcileTokens([tok(0, "Tofunmi", "u1")], "@Tofunmi hey", "@Tofunmihey");
  assert.deepEqual(r, [tok(0, "Tofunmi", "u1")]);          // still [0,8), still Tofunmi/u1
});

test("reconcileTokens: an edit BEFORE the token shifts it; an edit AFTER leaves it", () => {
  assert.equal(reconcileTokens([tok(0, "Bo Crew", "b")], "@Bo Crew", "hi @Bo Crew")[0].start, 3);   // before → shift
  assert.deepEqual(reconcileTokens([tok(0, "Bo Crew", "b")], "@Bo Crew ", "@Bo Crew ok"), [tok(0, "Bo Crew", "b")]); // after → unchanged
});

test("reconcileTokens: adjacent punctuation/letters do NOT demote a selected token", () => {
  assert.equal(reconcileTokens([tok(0, "Tofunmi", "u1")], "@Tofunmi", "@Tofunmi!").length, 1);   // punctuation after
  assert.equal(reconcileTokens([tok(0, "Tofunmi", "u1")], "@Tofunmi", "@Tofunmix").length, 1);   // letter after
});

test("reconcileTokens: an edit INSIDE the token drops it (insert or delete)", () => {
  assert.deepEqual(reconcileTokens([tok(0, "Tofunmi", "u1")], "@Tofunmi hey", "@Tofxunmi hey"), []); // insert inside
  assert.deepEqual(reconcileTokens([tok(0, "Tofunmi", "u1")], "@Tofunmi hey", "@Tofnmi hey"), []);   // delete inside
});

test("reconcileTokens: two tokens keep identity when the space between them is removed", () => {
  const toks = [tok(0, "Bo Crew", "b"), tok(9, "Ada Admin", "a")];
  const r = reconcileTokens(toks, "@Bo Crew @Ada Admin ", "@Bo Crew@Ada Admin ");
  assert.deepEqual(r.map((t) => [t.start, t.uid]), [[0, "b"], [8, "a"]]);   // Bo stays, Ada shifts -1
});

test("tokenSegments: renders exactly the stored ranges — '@Tofunmihey' → @Tofunmi + hey", () => {
  assert.deepEqual(tokenSegments("@Tofunmihey", [{ start: 0, end: 8 }]), [
    { text: "@Tofunmi", mention: true, group: false },
    { text: "hey", mention: false, group: false },
  ]);
});

test("tokenSegments: ignores out-of-bounds or non-'@' ranges (forged-range safety)", () => {
  assert.deepEqual(tokenSegments("hello world", [{ start: 3, end: 8 }]), [{ text: "hello world", mention: false, group: false }]); // not an @token
  assert.deepEqual(tokenSegments("@Bo", [{ start: 0, end: 99 }]), [{ text: "@Bo", mention: false, group: false }]);               // out of bounds
});

test("applyTokenEdit: a known edit drops the intersected token and shifts later ones exactly", () => {
  // "@Bo Crew @Ada Admin " — delete "@Bo Crew " ([0,9)); Bo dropped, Ada shifts to 0.
  const toks = [{ start: 0, name: "Bo Crew", uid: "b" }, { start: 9, name: "Ada Admin", uid: "a" }];
  assert.deepEqual(applyTokenEdit(toks, 0, 9, 0).map((t) => [t.start, t.uid]), [[0, "a"]]);
  // An edit strictly after both tokens leaves them; an edit before shifts both by delta.
  assert.deepEqual(applyTokenEdit(toks, 20, 20, 3).map((t) => t.start), [0, 9]);          // after → unchanged
  assert.deepEqual(applyTokenEdit(toks, 0, 0, 3).map((t) => t.start), [3, 12]);           // insert 3 before → shift
});

test("planMentionDeletion reports the exact edited range (for applyTokenEdit)", () => {
  const spans = selectedMentionSpans("hi @Bo Crew there", [{ uid: "b", name: "Bo Crew" }], false);
  assert.deepEqual(planMentionDeletion("hi @Bo Crew there", 5, 5, "backward", spans).range, [3, 12]); // "@Bo Crew " incl. space
});
