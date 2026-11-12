/* Markdown ⇄ visual editor conversion, with the stored FORMAT VERSION:
     v1 (legacy, no `mdVersion`) — the original rules, untouched;
     v2 (new / converted)        — adds backslash escapes.
   Run: npm run test:ui */
import { describe, test, expect } from "vitest";
import { markdownToHtml, htmlToMarkdown, canEditVisually, toCurrentFormat } from "./academyRichText.js";

const V1 = 1, V2 = 2;
const fromEditor = (html) => { const el = document.createElement("div"); el.innerHTML = html; return htmlToMarkdown(el); };
const render = (md, v) => { const el = document.createElement("div"); el.innerHTML = markdownToHtml(md, v); return el; };

describe("legacy (v1) content renders exactly as before", () => {
  test("backslashes are ordinary text in v1 (they used to show, and still do)", () => {
    expect(render("Save to C:\\Users\\me\\Docs", V1).textContent).toBe("Save to C:\\Users\\me\\Docs");
    expect(render("Type \\* to multiply", V1).textContent).toBe("Type \\* to multiply");
    expect(render("a \\\\ b", V1).textContent).toBe("a \\\\ b");
    expect(render("\\# not special", V1).textContent).toBe("\\# not special");
  });
  test("v1 keeps the legacy heading rule (trailing #s stripped) — v2 doesn't", () => {
    expect(render("# Learn C#", V1).querySelector("h3").textContent).toBe("Learn C");
    expect(render("# Learn C#", V2).querySelector("h3").textContent).toBe("Learn C#");
  });
  test("the same text renders differently only where v2 adds escapes", () => {
    expect(render("\\*x\\*", V1).textContent).toContain("\\");          // v1: the backslash shows, as it always did
    expect(render("\\*x\\*", V2).textContent).toBe("*x*");
  });
});

describe("editing legacy content converts it to v2 WITHOUT changing what it shows", () => {
  const legacy = [
    "Save to C:\\Users\\me\\Docs",
    "Type \\* to multiply and \\_x\\_ stays",
    "a \\\\ b and \\[brackets\\]",
    "# Learn C#",
    "## Notes ##",
    "*italic* **bold** `code` [link](https://example.com/a) and https://example.org.",
    "- one\n- two\n\n1. first\n2. second",
    "* star bullet\n* another",
    "Line one\nLine two",
    "_underscore italic_ and snake_case",
    "Literal <b>tags</b> & ampersands",
  ];
  for (const src of legacy) {
    test(`same rendering after conversion: ${JSON.stringify(src).slice(0, 50)}`, () => {
      expect(canEditVisually(src, V1)).toBe(true);
      const v2 = toCurrentFormat(src, V1);
      expect(v2).not.toBeNull();
      expect(markdownToHtml(v2, V2)).toBe(markdownToHtml(src, V1));
      // and it's stable: converting the converted text changes nothing
      expect(toCurrentFormat(v2, V2)).toBe(v2);
      expect(markdownToHtml(fromEditor(markdownToHtml(v2, V2)), V2)).toBe(markdownToHtml(v2, V2));
    });
  }
  test("text whose meaning would change is NOT converted (stays in source view)", () => {
    expect(canEditVisually("Contact [us](mailto:a@b.org)", V1)).toBe(false);
    expect(toCurrentFormat("Contact [us](mailto:a@b.org)", V1)).toBeNull();
  });
});

describe("new (v2) content: literal characters stay literal", () => {
  const literals = [
    "5 * 3 = 15 and 2*4=8",
    "*not italic* and **not bold**",
    "snake_case and _not italic_ either",
    "[not a link] written as text",
    "Use `backticks` literally",
    "a back\\slash and a lone [ bracket ]",
    "C# and F# are languages",
  ];
  for (const text of literals) {
    test(`plain text survives save + reopen: ${text}`, () => {
      const md = fromEditor(`<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`);
      const back = render(md, V2);
      expect(back.textContent).toBe(text);
      expect(back.querySelector("strong,em,code,a")).toBeNull();
      expect(fromEditor(back.innerHTML)).toBe(md);
    });
  }
  test("escaped punctuation in v2 source renders literally", () => {
    expect(render("\\*a\\* \\_b\\_ \\`c\\` \\[d\\] \\# \\- 1\\. \\\\", V2).textContent).toBe("*a* _b_ `c` [d] # - 1. \\");
  });
  test("a bare web address still auto-links (as it always has); bracket text never becomes a link", () => {
    const back = render(fromEditor("<p>[see](https://example.com) here</p>"), V2);
    expect(back.textContent).toBe("[see](https://example.com) here");
    for (const a of back.querySelectorAll("a")) expect(a.textContent).toBe(a.getAttribute("href"));
  });
  test("line starts that look like Markdown stay plain paragraphs", () => {
    const back = render(fromEditor("<p># not a heading</p><p>- not a list</p><p>1. not numbered</p><p>• bullet char</p>"), V2);
    expect(back.querySelector("h3,h4,h5,ul,ol")).toBeNull();
    expect([...back.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["# not a heading", "- not a list", "1. not numbered", "• bullet char"]);
  });
  test("a heading ending in # keeps it", () => {
    expect([...render(fromEditor("<h3>Learning C #</h3><h3>C#</h3>"), V2).querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Learning C #", "C#"]);
  });
  test("formatting the author applied is kept, with literal characters inside it", () => {
    const back = render(fromEditor('<p><b>2*3</b> and <i>a_b</i> see <a href="https://example.com/x">the [draft] guide</a> or https://example.org</p><ul><li>*star* item</li></ul>'), V2);
    expect(back.querySelector("strong").textContent).toBe("2*3");
    expect(back.querySelector("em").textContent).toBe("a_b");
    expect([...back.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["the [draft] guide", "https://example.com/x"], ["https://example.org", "https://example.org"]]);
    expect(back.querySelector("li").textContent).toBe("*star* item");
  });
});

describe("safety (both versions)", () => {
  test("HTML is built only from the parsed subset and escaped", () => {
    for (const v of [V1, V2]) {
      const html = markdownToHtml('<img src=x onerror=alert(1)> [x](javascript:alert(1)) "q"', v);
      expect(html).not.toMatch(/<img|javascript:/);
    }
  });
  test("pasted/foreign structure collapses to the subset; unsafe links keep only their text", () => {
    const el = document.createElement("div");
    el.innerHTML = '<div><h1>Title</h1><p style="color:red">A <span>styled</span> <i>word</i></p></div><ol><li>a<ul><li>nested</li></ul></li></ol><p><a href="data:text/html,x">click</a></p>';
    expect(htmlToMarkdown(el)).toBe("# Title\n\nA styled *word*\n\n1. a\n- nested\n\nclick");
  });
});
