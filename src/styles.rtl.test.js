/* RTL / logical-layout regression guards (FIFTH-B, Part A). Source-level, since
   jsdom has no layout — live pixel geometry is verified in the browser, not here.
   These lock in that the audited direction-sensitive rules stay LOGICAL (so LTR is
   pixel-identical and RTL mirrors) and that the few physical exceptions are the
   intended ones. Run: node --test src/styles.rtl.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const read = (f) => readFileSync(new URL("./" + f, import.meta.url), "utf8");
const app = read("App.jsx");
const admin = read("AdminScreen.jsx");
const MODULES = ["App.jsx", "AdminScreen.jsx", "controls.jsx", "ProfileDrawer.jsx", "notifShell.jsx", "loading.jsx"];

// Documented allowlist of INTENTIONAL physical inline styles (not reading-direction):
// vertical/centering transforms, top/bottom, fixed square sizes, etc. Keep empty of
// direction-sensitive props.
const INLINE_ALLOW = [/* none currently — all direction inline styles migrated to logical */];

// Ignore comments so prose examples don't trip the physical-property guards.
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("no physical box-model left/right remain (migrated to logical inline properties)", () => {
  for (const phys of ["margin-left:", "margin-right:", "padding-left:", "padding-right:",
                      "border-left:", "border-right:", "border-left-color", "border-right-color",
                      "text-align:left", "text-align:right"]) {
    assert.equal(code.split(phys).length - 1, 0, `physical "${phys}" should be migrated to a logical property`);
  }
  assert.ok(/inline-start|inline-end/.test(code), "logical inline properties should be in use");
});

test("no physical left:/right: positioning remains (migrated to inset-inline-*)", () => {
  // bare `left:`/`right:` (not part of border-*/*-left etc.) should be gone.
  assert.ok(!/(?<![-\w])left:/.test(code), "bare left: positioning should be inset-inline-start");
  assert.ok(!/(?<![-\w])right:/.test(code), "bare right: positioning should be inset-inline-end");
});

test("the notification drawer has an RTL slide-in rule (attaches to inline-end)", () => {
  assert.ok(/\[dir="rtl"\][^{]*\.sb-scrim-right[^{]*\.sb-notifpanel\{[^}]*animation-name:drawerInRtl/.test(css),
    "RTL notif drawer must slide from the opposite edge (drawerInRtl)");
  assert.ok(/@keyframes drawerInRtl\{[^}]*translateX\(-100%\)/.test(css),
    "drawerInRtl must translate from -100% (inline-end in RTL)");
});

test("the warning/problem row accent is on the inline-start", () => {
  assert.ok(/\.sb-cap-warn\{[^}]*border-inline-start:3px solid var\(--warning\)/.test(css),
    "the warning row accent border must be border-inline-start (mirrors in RTL)");
});

test("the password reveal sits at the field's inline-end", () => {
  assert.ok(/\.sb-pwtoggle\{[^}]*inset-inline-end:/.test(css),
    "the password reveal must be positioned with inset-inline-end");
});

test("dropdown menus align to the logical end (inset-inline-end)", () => {
  assert.ok(/\.sb-kebab-menu\{[^}]*inset-inline-end:0/.test(css), "kebab menu must align to inline-end");
  assert.ok(/\.sb-nmore-menu\{[^}]*inset-inline-end:0/.test(css), "the notif more-menu must align to inline-end");
});

test("the bottom-nav selection indicator reverses its slide in RTL", () => {
  assert.ok(/\[dir="rtl"\]\s*\.sb-nav-ind\{transform:translate3d\(calc\(var\(--nav-i,0\) \* -100%\)/.test(css),
    "RTL nav indicator must slide in the reversed direction");
});

test("forward CTA arrows mirror in RTL and are used as aria-hidden .sb-fwd spans", () => {
  assert.ok(/\[dir="rtl"\]\s*\.sb-fwd\{transform:scaleX\(-1\)\}/.test(css), "the .sb-fwd forward arrow must mirror in RTL");
  assert.ok(/className="sb-fwd" aria-hidden="true">→<\/span>/.test(app),
    "CTA arrows should be wrapped in an aria-hidden .sb-fwd span");
  // and the Home hero ::after forward arrow flips its glyph
  assert.ok(/\[dir="rtl"\]\s*\.sb-stat2::after\{content:"←"\}/.test(css), "the hero forward arrow glyph must flip in RTL");
});

test("forward-navigation chevrons mirror, but disclosure twisties do NOT", () => {
  assert.ok(/\[dir="rtl"\][\s\S]*?\.sb-rvcard-go \.hi[\s\S]*?transform:scaleX\(-1\)/.test(css),
    "forward-nav chevrons (.sb-rvcard-go) must mirror");
  // .sb-chev is a disclosure twisty (rotates on open) — must NOT get a blanket RTL mirror
  assert.ok(!/\[dir="rtl"\][^{]*\.sb-chev\b[^{]*\{[^}]*scaleX/.test(css),
    "disclosure twisties (.sb-chev) must not be blanket-mirrored");
});

// ---- FIFTH-B corrections: extended source audit (JSX + modules) ----

test("no direction-sensitive PHYSICAL inline styles remain in JSX/modules (allowlisted exceptions only)", () => {
  const physical = /style=\{\{[^}]*(marginLeft|marginRight|paddingLeft|paddingRight|textAlign:\s*["'](?:left|right)|(?:^|[^a-zA-Z-])left:\s*\d|(?:^|[^a-zA-Z-])right:\s*\d)[^}]*\}\}/g;
  const offenders = [];
  for (const f of MODULES) {
    const src = read(f);
    for (const m of src.matchAll(physical)) {
      if (INLINE_ALLOW.some((re) => re.test(m[0]))) continue;
      offenders.push(`${f}: ${m[0].slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [], "direction-sensitive inline styles must be logical or extracted to classes");
});

test("extracted inline blocks are now named classes with LOGICAL properties", () => {
  assert.ok(/\.sb-mention-menu\{[^}]*inset-inline-start:0/.test(css), "mention menu → inset-inline-start");
  assert.ok(/\.sb-mention-item\{[^}]*text-align:start/.test(css), "mention item → text-align:start");
  assert.ok(/\.sb-mention-check\{[^}]*margin-inline-start:6px/.test(css), "mention check → margin-inline-start");
  assert.ok(/\.sb-detail-val\{[^}]*text-align:end/.test(css), "detail value → text-align:end");
});

test("no user-visible date is manually assembled in English in migrated surfaces", () => {
  // dateFormat.js is the ONE place that may assemble compact relative strings; the
  // app modules must delegate to it (this specifically catches the old agoT/agoShort
  // "m ago"/"h ago"/"d ago"/"w ago" concatenation the earlier guard missed).
  for (const f of ["App.jsx", "AdminScreen.jsx", "data.js", "notifications.js"]) {
    const src = read(f);
    assert.ok(!/toLocaleDateString|toLocaleTimeString/.test(src), `${f} must not format dates with toLocaleDateString`);
    assert.ok(!/\.toLocaleString\(undefined/.test(src), `${f} must not date-format via toLocaleString(undefined,…)`);
    assert.ok(!/ at 9:00 AM/.test(src.replace(/\/\/[^\n]*/g, "")), `${f} must not hard-code " at 9:00 AM"`);
    assert.ok(!/day\$\{[^}]*!==\s*1\s*\?/.test(src), `${f} must not manually pluralize day/days`);
    assert.ok(!/["'`]\s*[mhdw]\s*ago\s*["'`]|\+\s*["']m ago["']|["']h ago["']|["']d ago["']|["']w ago["']/.test(src),
      `${f} must not hand-assemble compact relative time ("Nm/h/d/w ago") — use formatRelativeShort`);
  }
});

test("mixed-direction user content is bidi-isolated (dir=auto / <bdi>)", () => {
  assert.ok(/<bdi>\{u\.name\}<\/bdi>|dir="auto"><bdi>\{u\.name\}/.test(app), "user names in search should be bdi-isolated");
  assert.ok(/className="sb-detail-val" dir="auto"/.test(app), "detail values should use dir=auto");
  assert.ok(/dir="auto"[^>]*aria-label="Search tasks|value=\{q\}[^>]*dir="auto"/.test(app), "the search input should use dir=auto");
  const pd = read("ProfileDrawer.jsx");
  assert.ok(/<bdi>\{me\.name\}<\/bdi>/.test(pd) && /<bdi>\{me\.email\}<\/bdi>/.test(pd), "profile name + email should be bdi-isolated");
  // mention list options isolate names too
  assert.ok(/<bdi>\{u\.name\}<\/bdi>\{mentions\.includes/.test(app), "mention option names should be bdi-isolated");
});

test("Admin People cards bidi-isolate names, emails, and campus/department", () => {
  // pending-user + approved People-card name/email use <bdi>; campus·dept uses dir=auto.
  assert.ok((admin.match(/<bdi>\{u\.name\}<\/bdi>/g) || []).length >= 2, "pending + approved People names should be bdi-isolated");
  assert.ok((admin.match(/<bdi>\{u\.email\}<\/bdi>/g) || []).length >= 2, "pending + approved People emails should be bdi-isolated");
  assert.ok(/dir="auto"[^>]*title=\{`\$\{campus\} · \$\{dept\}`\}/.test(admin), "campus · department should use dir=auto");
});

test("admin tab centering is direction-safe (scrollIntoView inline + tested helper, no Math.max(0) clamp)", () => {
  assert.ok(/scrollIntoView\(\{ inline: "center"/.test(admin), "should prefer scrollIntoView({inline:'center'})");
  assert.ok(/centeredScrollTarget\(/.test(admin), "should fall back to the tested centeredScrollTarget helper");
  assert.ok(!/Math\.max\(0, target\)/.test(admin), "must not clamp scrollLeft to >=0 (wrong under RTL negative-scroll)");
});
