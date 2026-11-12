/* IFC Creative Academy — formatted (visual) editing for the safe Markdown subset.

   Stored content stays exactly the same format as before (academyMarkdown.js).
   The visual editor converts:
     Markdown → editor HTML   built ONLY from the parsed AST, every string
                              escaped; links are already https-only.
     editor DOM → Markdown    a whitelist walk (p/div, h3–h5, ul/ol/li, b/strong,
                              i/em, code, a[href https], br); anything else
                              contributes its text only.
   `canEditVisually(src)` is the fidelity gate: existing text opens in the
   visual view only if converting it to the editor and back renders IDENTICALLY
   and nothing hidden would be dropped (e.g. an unsafe link's address, which the
   renderer never shows but the source keeps). Otherwise it opens in the
   labelled Markdown source view — nothing is silently rewritten. The editor
   also never writes anything until the author actually types. */
import { parseMarkdown, MD_LEGACY, MD_CURRENT } from "./academyMarkdown.js";

const SAFE_HREF = /^https?:\/\/[^\s<>"'()]+$/i;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inlinesToHtml(inl) {
  return (inl || []).map((n) => {
    switch (n.type) {
      case "text": return esc(n.text);
      case "break": return "<br>";
      case "code": return `<code>${esc(n.text)}</code>`;
      case "strong": return `<strong>${inlinesToHtml(n.inlines)}</strong>`;
      case "em": return `<em>${inlinesToHtml(n.inlines)}</em>`;
      case "link": return `<a href="${esc(n.href)}">${inlinesToHtml(n.inlines)}</a>`;
      default: return "";
    }
  }).join("");
}
/* Headings: # → h3, ## → h4, ### → h5 (the same levels the learner view uses).
   `version` = the stored text's format (1 legacy, 2 current); the editor always
   WRITES version 2 (see htmlToMarkdown). */
export function markdownToHtml(src, version = MD_LEGACY) {
  return parseMarkdown(src, { version }).map((b) => {
    if (b.type === "heading") return `<h${b.level + 2}>${inlinesToHtml(b.inlines)}</h${b.level + 2}>`;
    if (b.type === "list") { const t = b.ordered ? "ol" : "ul"; return `<${t}>${b.items.map((it) => `<li>${inlinesToHtml(it)}</li>`).join("")}</${t}>`; }
    return `<p>${inlinesToHtml(b.inlines)}</p>`;
  }).join("");
}

const BLOCK = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE"]);
// Move edge spaces outside a marker pair: "* x *" wouldn't parse as italic.
const wrap = (inner, mark) => {
  if (!inner.trim()) return inner;
  const lead = inner.match(/^\s*/)[0], trail = inner.match(/\s*$/)[0];
  return `${lead}${mark}${inner.trim()}${mark}${trail}`;
};
/* Text the author typed is LITERAL: escape every character the parser would
   otherwise read as formatting, so "*not italic*" stays exactly that. */
const escText = (t) => t.replace(/[\\`*_[\]]/g, (c) => "\\" + c);
/* Line starts that would turn plain text into a heading / list item. */
const escLineStart = (line) => line
  .replace(/^(\s{0,3})(#{1,3})(?=\s)/, "$1\\$2")
  .replace(/^(\s{0,3})([-•])(?=\s)/, "$1\\$2")
  .replace(/^(\s{0,3}\d{1,3})([.)])(?=\s)/, "$1\\$2");
const escBlockLines = (t) => t.split("\n").map(escLineStart).join("\n");
function inlineMd(node) {
  if (node.nodeType === 3) return escText(node.nodeValue.replace(/ /g, " ").replace(/\n/g, " "));
  if (node.nodeType !== 1) return "";
  const tag = node.tagName;
  const kids = () => [...node.childNodes].map(inlineMd).join("");
  if (tag === "BR") return "\n";
  if (tag === "B" || tag === "STRONG") return wrap(kids(), "**");
  if (tag === "I" || tag === "EM") return wrap(kids(), "*");
  if (tag === "CODE") {
    const t = node.textContent || "";
    if (!t) return "";
    return t.includes("`") ? escText(t) : "`" + t + "`";   // a backtick can't live inside code → keep the text, literally
  }
  if (tag === "A") {
    const href = (node.getAttribute("href") || "").trim();
    const label = kids();
    if (!SAFE_HREF.test(href)) return label;
    // a link showing its own address stays a bare URL; otherwise [label](href) with the label escaped
    return (node.textContent || "").trim() === href ? href : `[${label}](${href})`;
  }
  if (BLOCK.has(tag)) return "\n" + kids() + "\n";
  return kids();
}
const tidy = (s) => s.split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n").replace(/^\n+|\n+$/g, "");
const HEADING_MARK = { H1: "#", H2: "#", H3: "#", H4: "##", H5: "###", H6: "###" };

/* editor DOM (a container element) → Markdown subset */
export function htmlToMarkdown(root) {
  const blocks = [];
  let loose = [];
  const flushLoose = () => { const t = tidy(loose.join("")); if (t.trim()) blocks.push(escBlockLines(t)); loose = []; };
  const listItems = (list, out, ordered) => {
    let n = 1;
    for (const li of list.children) {
      if (li.tagName !== "LI") continue;
      const nested = [];
      const text = [...li.childNodes].filter((c) => { if (c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")) { nested.push(c); return false; } return true; })
        .map(inlineMd).join("").replace(/\n+/g, " ").trim();
      if (text) out.push(`${ordered ? `${n++}.` : "-"} ${text}`);
      for (const sub of nested) listItems(sub, out, sub.tagName === "OL");
    }
  };
  for (const node of root.childNodes) {
    if (node.nodeType === 1 && BLOCK.has(node.tagName)) {
      flushLoose();
      const tag = node.tagName;
      if (tag === "UL" || tag === "OL") { const out = []; listItems(node, out, tag === "OL"); if (out.length) blocks.push(out.join("\n")); continue; }
      if (HEADING_MARK[tag]) {
        // a trailing " #…" would be read as a closing sequence → escape it
        const t = inlineMd(node).replace(/\n+/g, " ").trim().replace(/(\s)(#+)$/, "$1\\$2");
        if (t) blocks.push(`${HEADING_MARK[tag]} ${t}`); continue;
      }
      // a paragraph-like block may itself contain blocks (pasted structure) → recurse
      if ([...node.children].some((c) => BLOCK.has(c.tagName))) { const inner = htmlToMarkdown(node); if (inner) blocks.push(inner); continue; }
      const t = tidy([...node.childNodes].map(inlineMd).join(""));
      if (t.trim()) blocks.push(escBlockLines(t));
    } else loose.push(inlineMd(node));
  }
  flushLoose();
  return blocks.join("\n\n");
}

/* Fidelity gate (needs a DOM — the browser or jsdom). Text stored in format
   `version` may open in the visual view only if re-saving what it shows (always
   as version 2) renders IDENTICALLY to the original — so editing legacy text
   converts it without changing its visible meaning — and nothing hidden would be
   dropped (e.g. an unsafe link's address, which is never rendered). */
export function canEditVisually(src, version = MD_LEGACY, doc = typeof document !== "undefined" ? document : null) {
  const s = String(src || "");
  if (!s.trim()) return true;
  if (!doc) return false;
  if (/\]\((?!\s*https?:\/\/)[^)]*\)/i.test(s)) return false;
  const el = doc.createElement("div");
  el.innerHTML = markdownToHtml(s, version);
  return markdownToHtml(htmlToMarkdown(el), MD_CURRENT) === markdownToHtml(s, version);
}
/* Convert stored text of any version to version 2 with identical rendering, or
   null when that isn't possible (then it must stay as it is). */
export function toCurrentFormat(src, version = MD_LEGACY, doc = typeof document !== "undefined" ? document : null) {
  if (version === MD_CURRENT) return String(src || "");
  if (!canEditVisually(src, version, doc)) return null;
  const el = doc.createElement("div");
  el.innerHTML = markdownToHtml(src, version);
  return htmlToMarkdown(el);
}
