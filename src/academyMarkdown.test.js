/* IFC Creative Academy — safe markdown subset (pure).
   Run: node --test src/academyMarkdown.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseInlines, markdownToText, isSafeHref } from "./academyMarkdown.js";

const types = (blocks) => blocks.map((b) => b.type);

test("headings, paragraphs and lists", () => {
  const b = parseMarkdown("# Title\n\nFirst para\nsecond line\n\n## Sub\n- one\n- two\n\n1. a\n2) b");
  assert.deepEqual(types(b), ["heading", "paragraph", "heading", "list", "list"]);
  assert.equal(b[0].level, 1);
  assert.equal(b[2].level, 2);
  assert.equal(b[3].ordered, false); assert.equal(b[3].items.length, 2);
  assert.equal(b[4].ordered, true); assert.equal(b[4].items.length, 2);
  // a bare newline inside a paragraph is a hard break (authors type them on purpose)
  assert.ok(b[1].inlines.some((n) => n.type === "break"));
});

test("inline: bold, italic, code, links; HTML is literal text", () => {
  const inl = parseInlines("Say **hi** to _you_ and *me* with `code` <script>alert(1)</script>");
  assert.deepEqual(inl.map((n) => n.type), ["text", "strong", "text", "em", "text", "em", "text", "code", "text"]);
  assert.equal(inl[8].text, " <script>alert(1)</script>");
});

test("links: only http(s) hrefs become links; javascript:/data: labels render as plain text", () => {
  const ok = parseInlines("[Guide](https://example.com/g?x=1)");
  assert.equal(ok[0].type, "link"); assert.equal(ok[0].href, "https://example.com/g?x=1");
  const bad = parseInlines("[Click](javascript:alert(1)) and [d](data:text/html,x)");
  assert.ok(bad.every((n) => n.type === "text"), JSON.stringify(bad));
  assert.equal(bad.map((n) => n.text).join(""), "Click and d");
});

test("bare URLs autolink, trailing punctuation excluded", () => {
  const inl = parseInlines("See https://example.com/a. Then go.");
  assert.equal(inl[1].type, "link"); assert.equal(inl[1].href, "https://example.com/a");
  assert.equal(inl[2].text, ". Then go.");
});

test("underscores inside words are not italics (snake_case survives)", () => {
  const inl = parseInlines("use my_var_name here");
  assert.equal(inl.length, 1); assert.equal(inl[0].text, "use my_var_name here");
});

test("markdownToText flattens for previews/search", () => {
  assert.equal(markdownToText("# T\n\n**b** [l](https://x.io)\n- a\n- b"), "T\nb l\na · b");
});

test("isSafeHref matches the link rule used for resources", () => {
  assert.equal(isSafeHref("https://drive.google.com/x"), true);
  assert.equal(isSafeHref("http://x.io"), true);
  assert.equal(isSafeHref("javascript:void(0)"), false);
  assert.equal(isSafeHref("https://x.io/a b"), false);
  assert.equal(isSafeHref(""), false);
});

const V2 = { version: 2 };
test("LEGACY (default, v1): backslashes are ordinary text and parsing is exactly the original", () => {
  const txt = (inl) => inl.map((n) => (n.type === "text" ? n.text : `<${n.type}>`)).join("");
  assert.equal(txt(parseInlines("C:\\Users\\me")), "C:\\Users\\me");
  assert.equal(txt(parseInlines("a \\\\ b")), "a \\\\ b");
  assert.equal(txt(parseInlines("\\[x\\]")), "\\[x\\]");
  // original closer rule: the next "*" closes italics even after a backslash
  assert.deepEqual(parseInlines("*a\\*b*").map((n) => n.type), ["em", "text"]);
  assert.equal(parseMarkdown("# C#")[0].inlines[0].text, "C", "legacy heading rule strips trailing #s");
  assert.equal(parseMarkdown("\\# x")[0].type, "paragraph");
  assert.equal(markdownToText("**Bold** \\* note"), "Bold \\* note");
});
test("v2: backslash escapes keep formatting characters literal (written by the visual editor)", () => {
  const txt = (inl) => inl.map((n) => (n.type === "text" ? n.text : `<${n.type}>`)).join("");
  assert.equal(txt(parseInlines("\\*a\\* \\_b\\_ \\`c\\` \\[d\\](https://e.f) g\\\\h", V2)), "*a* _b_ `c` [d](<link>) g\\h");
  assert.deepEqual(parseInlines("*a\\*b*", V2).map((n) => n.type), ["em"], "an escaped closer doesn't end italics");
  assert.equal(parseInlines("**x\\*\\*y**", V2)[0].inlines[0].text, "x**y");
  assert.equal(parseInlines("[a \\] b](https://x.y)", V2)[0].type, "link");
  assert.equal(parseInlines("\\q stays", V2)[0].text, "\\q stays", "non-escapable characters keep their backslash");
  assert.deepEqual(parseMarkdown("\\# not heading\n\n\\- not list\n\n1\\. not numbered", V2).map((b) => b.type), ["paragraph", "paragraph", "paragraph"]);
});
test("v2: a heading's closing #s need a space before them (C# keeps its #)", () => {
  const h = (src) => parseMarkdown(src, V2)[0].inlines.map((n) => n.text).join("");
  assert.equal(h("# C#"), "C#");
  assert.equal(h("## Title ##"), "Title");
  assert.equal(h("# Item \\#"), "Item #");
});
