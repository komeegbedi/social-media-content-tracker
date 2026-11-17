/* IFC Creative Academy — a SMALL, safe markdown subset (pure, DOM-free).

   Lesson descriptions and course "About" copy are stored as plain text in this
   subset and rendered through a React component that only ever creates real
   elements from this AST — never innerHTML, never arbitrary HTML. Anything that
   looks like HTML is rendered as literal text.

   Supported (and nothing else):
     # / ## / ###    headings (rendered one level below the page's own h1/h2)
     blank line      paragraph break
     - item / * item unordered list;  1. item  ordered list
     **bold**  *italic*  _italic_  `code`
     [label](https://…)  links — http(s) only; anything else renders as text
     bare https://… URLs are auto-linked
     a line ending in two spaces → hard break
   FORMAT VERSIONS (stored next to the text as `mdVersion`; absent = 1):
     1  legacy — exactly the original rules: backslashes are ordinary text, a
        heading's trailing #s are always stripped. Every existing document
        renders as it always has.
     2  adds backslash escapes (\*  \_  \`  \[  \]  \#  \-  \.  \\ …: the next
        character is literal) and CommonMark heading closers (only " #…" with a
        space is stripped, so "# C#" keeps its #). Written by the visual editor
        so "*not italic*" typed as plain text stays plain after saving.
   Pass { version } to parseMarkdown / parseInlines / markdownToText.

   AST shape:
     block := { type:"heading", level:1|2|3, inlines }
            | { type:"paragraph", inlines }
            | { type:"list", ordered:boolean, items: inlines[] }
     inline := { type:"text", text } | { type:"strong"|"em"|"code", inlines|text }
             | { type:"link", href, inlines } | { type:"break" } */

export const MARKDOWN_HELP =
  "Formatting: # Heading, blank line for a new paragraph, - bullet, 1. numbered, **bold**, *italic*, `code`, [label](https://link).";
/* Version-2 text also understands backslash escapes. */
export const MARKDOWN_HELP_V2 = MARKDOWN_HELP + " Put \\ before a character to show it literally, e.g. \\*.";

/* Characters a backslash can escape (CommonMark's ASCII punctuation subset we use). */
export const ESCAPABLE = "\\`*_[](){}#+-.!>|~•";
const isEscaped = (s, i) => { let n = 0; for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) n++; return n % 2 === 1; };
/* First occurrence of `tok` at/after `from` that isn't backslash-escaped. */
function findUnescaped(s, tok, from) {
  for (let i = s.indexOf(tok, from); i !== -1; i = s.indexOf(tok, i + 1)) if (!isEscaped(s, i)) return i;
  return -1;
}

const SAFE_HREF = /^https?:\/\/[^\s<>"'()]+$/i;

export const MD_LEGACY = 1, MD_CURRENT = 2;
export function parseMarkdown(src, opts = {}) {
  const v2 = opts.version === MD_CURRENT;
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ type: "paragraph", inlines: parseInlines(para.join("\n"), opts) });
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(list);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "    ");
    if (!line.trim()) { flushPara(); flushList(); continue; }

    const h = v2 ? line.match(/^(#{1,3})\s+(.+?)(?:\s+#+)?\s*$/) : line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (h) { flushPara(); flushList(); blocks.push({ type: "heading", level: h[1].length, inlines: parseInlines(h[2], opts) }); continue; }

    const li = line.match(/^\s{0,3}(?:([-*•])|(\d{1,3})[.)])\s+(.+)$/);
    if (li) {
      flushPara();
      const ordered = !!li[2];
      if (!list || list.ordered !== ordered) { flushList(); list = { type: "list", ordered, items: [] }; }
      list.items.push(parseInlines(li[3], opts));
      continue;
    }

    // A continuation line inside a list item (indented) extends the last item.
    if (list && /^\s{2,}\S/.test(line)) {
      const last = list.items[list.items.length - 1];
      last.push({ type: "text", text: " " }, ...parseInlines(line.trim(), opts));
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return blocks;
}

/* Inline tokenizer. Hard breaks: "  \n" or a bare newline inside a paragraph
   (we keep author line breaks — the editor types them on purpose). */
export function parseInlines(text, opts = {}) {
  const v2 = opts.version === MD_CURRENT;
  // v1 (legacy): closers are found literally; v2: escaped closers don't count
  const find = v2 ? findUnescaped : (s0, tok, from) => s0.indexOf(tok, from);
  const out = [];
  const s = String(text || "");
  let i = 0;
  let buf = "";
  const pushText = () => { if (buf) { out.push({ type: "text", text: buf }); buf = ""; } };

  while (i < s.length) {
    const ch = s[i];

    // backslash escape → the next character is literal
    if (v2 && ch === "\\" && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }

    // hard break
    if (ch === "\n") { pushText(); out.push({ type: "break" }); i += 1; continue; }

    // inline code
    if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) { pushText(); out.push({ type: "code", text: s.slice(i + 1, end) }); i = end + 1; continue; }
    }

    // bold **x**
    if (s.startsWith("**", i)) {
      const end = find(s, "**", i + 2);
      if (end > i + 2) { pushText(); out.push({ type: "strong", inlines: parseInlines(s.slice(i + 2, end), opts) }); i = end + 2; continue; }
    }

    // italic *x* or _x_ (not inside words for _)
    if ((ch === "*" || (ch === "_" && (i === 0 || /\s|\(/.test(s[i - 1])))) && s[i + 1] && !/\s/.test(s[i + 1])) {
      const end = find(s, ch, i + 1);
      if (end > i + 1 && !/\s/.test(s[end - 1]) && (ch !== "_" || !s[end + 1] || /[\s.,;:!?)]/.test(s[end + 1]))) {
        pushText(); out.push({ type: "em", inlines: parseInlines(s.slice(i + 1, end), opts) }); i = end + 1; continue;
      }
    }

    // [label](href)
    if (ch === "[") {
      const close = find(s, "](", i + 1);
      if (close > i) {
        // Balanced parens inside the href (e.g. javascript:alert(1), wiki links).
        let depth = 1, hrefEnd = -1;
        for (let k = close + 2; k < s.length; k += 1) {
          if (v2 && s[k] === "\\") { k += 1; continue; }
          if (s[k] === "(") depth += 1;
          else if (s[k] === ")") { depth -= 1; if (depth === 0) { hrefEnd = k; break; } }
        }
        if (hrefEnd > close) {
          const label = s.slice(i + 1, close);
          const href = s.slice(close + 2, hrefEnd).trim();
          pushText();
          if (SAFE_HREF.test(href)) out.push({ type: "link", href, inlines: parseInlines(label, opts) });
          else out.push({ type: "text", text: label });        // unsafe scheme → label as text
          i = hrefEnd + 1; continue;
        }
      }
    }

    // bare URL autolink
    if ((ch === "h") && /^https?:\/\//i.test(s.slice(i, i + 8))) {
      const m = s.slice(i).match(/^https?:\/\/[^\s<>"'()]+/i);
      if (m) {
        let url = m[0];
        // Strip trailing punctuation that's almost certainly sentence punctuation.
        const trimmed = url.replace(/[.,;:!?]+$/, "");
        url = trimmed;
        pushText(); out.push({ type: "link", href: url, inlines: [{ type: "text", text: url }] });
        i += url.length; continue;
      }
    }

    buf += ch; i += 1;
  }
  pushText();
  return out;
}

/* Plain-text projection (search indexing, previews, aria descriptions). */
export function markdownToText(src, opts = {}) {
  const walk = (inl) => inl.map((n) =>
    n.type === "text" || n.type === "code" ? n.text
    : n.type === "break" ? " "
    : walk(n.inlines || [])).join("");
  return parseMarkdown(src, opts).map((b) =>
    b.type === "list" ? b.items.map((it) => walk(it)).join(" · ") : walk(b.inlines)
  ).join("\n").trim();
}

/* Resource links are stored as { label, url } — validated with the same
   https-only rule as markdown links. */
export function isSafeHref(href) { return SAFE_HREF.test(String(href || "").trim()); }
