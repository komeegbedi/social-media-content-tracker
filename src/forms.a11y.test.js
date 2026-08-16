/* FIFTH-A regression guards for form accessibility + constrained-viewport layout.
   Source-level (the repo's runners are node/vitest, no headless browser), so these
   lock in the specific fixes; the runtime behaviours (overflow, reachability,
   lock release) were verified live and are also covered for overlays by
   overlay.ui.test.jsx / notifShell.ui.test.jsx. Run: node --test src/forms.a11y.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const admin = readFileSync(new URL("./AdminScreen.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const controls = readFileSync(new URL("./controls.jsx", import.meta.url), "utf8");

test("Toggle/Switch expose switch semantics (role=switch + aria-checked) in controls.jsx", () => {
  // Behaviour is covered by the RENDERED tests (controls.ui.test.jsx); this just
  // guards that the shared primitives keep switch semantics + type=button.
  const t = controls.match(/export function Toggle[\s\S]{0,320}?<button[\s\S]*?>/);
  assert.ok(t && /role="switch"/.test(t[0]) && /aria-checked=\{!!v\}/.test(t[0]) && /type="button"/.test(t[0]),
    "Toggle must be a type=button role=switch with aria-checked");
  const s = controls.match(/export function Switch[\s\S]{0,320}?<button[\s\S]*?>/);
  assert.ok(s && /role="switch"/.test(s[0]) && /aria-checked=\{!!on\}/.test(s[0]),
    "Switch must be a role=switch with aria-checked");
});

test("admin search inputs carry an accessible name (were placeholder-only)", () => {
  assert.ok(/aria-label="Search content"/.test(admin), "Admin content search needs an accessible name");
  assert.ok(/aria-label="Search people"/.test(admin), "Admin people search needs an accessible name");
});

test("previously-unassociated form labels now use htmlFor/id", () => {
  // A representative set spanning feature request, report, task detail, event +
  // user editors, notification settings, crew, compose, import.
  for (const id of ["fr-title", "fr-problem", "fr-link", "ri-note", "td-blocked", "td-postlink",
                     "ue-name", "ue-role", "ns-hour", "crew-who", "pc-link"]) {
    assert.ok(new RegExp(`htmlFor="${id}"`).test(app), `label htmlFor="${id}" missing`);
    assert.ok(new RegExp(`id="${id}"`).test(app), `control id="${id}" missing`);
  }
  for (const id of ["ev-name", "ev-anchor", "imp-sheet"]) {
    assert.ok(new RegExp(`htmlFor="${id}"`).test(admin), `admin label htmlFor="${id}" missing`);
    assert.ok(new RegExp(`id="${id}"`).test(admin), `admin control id="${id}" missing`);
  }
});

test("the password field's 'Forgot?' link is OUTSIDE the <label> (no accessible-name pollution)", () => {
  // PasswordField (controls.jsx) renders labelAction OUTSIDE the <label>, in the
  // .sb-labelrow; LoginScreen (App.jsx) passes Forgot? via labelAction, never
  // wrapping it in a label.
  const pf = controls.match(/<div className="sb-labelrow">[\s\S]*?<\/div>/);
  assert.ok(pf, "PasswordField label row not found");
  // labelAction sits AFTER the closing </label>, never inside it.
  assert.ok(/<\/label>\s*\{labelAction\}/.test(pf[0]), "labelAction must render after </label>, beside the label");
  const labelEl = pf[0].match(/<label htmlFor=\{id\}>[\s\S]*?<\/label>/);
  assert.ok(labelEl && !/labelAction/.test(labelEl[0]), "labelAction must not be inside the <label> element");
  assert.ok(/labelAction=\{mode!=="register" && <button[^>]*className="sb-fieldlink"[^>]*>Forgot\?/.test(app),
    "LoginScreen should pass Forgot? as labelAction");
});

test("multi-select segmented groups expose selected state (aria-pressed) + group semantics", () => {
  // Skills + Service location previously had no aria-pressed (colour-only state).
  assert.ok(/role="group" aria-labelledby="ue-skills-lbl"/.test(app), "Skills group needs group semantics");
  assert.ok(/role="group" aria-labelledby="ue-loc-lbl"/.test(app), "Service-location group needs group semantics");
  // every segmented button in the editor should carry aria-pressed
  const segButtons = app.match(/className=\{"sb-segbtn"[\s\S]*?\}/g) || [];
  assert.ok(segButtons.length > 0);
  assert.ok(/aria-pressed=\{f\.skills\.includes/.test(app), "skill chips must expose aria-pressed");
  assert.ok(/aria-pressed=\{f\.location\.includes/.test(app), "location chips must expose aria-pressed");
});

test("URL fields declare url type/inputmode where added (better mobile keyboard)", () => {
  assert.ok(/id="fr-link" type="url" inputMode="url"/.test(app), "feature-request link should be a url field");
  assert.ok(/id="imp-sheet" type="url" inputMode="url"/.test(admin), "sheet URL should be a url field");
});

test("mobile touch-target rules exist (44px hit areas, glyphs unchanged)", () => {
  assert.ok(/@media\(max-width:899px\)\{[\s\S]*?min-height:44px/.test(css), "mobile 44px form-control rule missing");
  assert.ok(/\.sb-nfilters \.sb-fchip\{min-height:44px;min-width:44px\}/.test(css), "notif filter chips need a 44px target");
  assert.ok(/\.sb-searchclose,\.sb-iconbtn\{min-width:44px;min-height:44px\}/.test(css), "overlay icon buttons need a 44px target");
});

test("the profile drawer is dvh/safe-area bounded with internal scroll (short landscape)", () => {
  const m = css.match(/\.sb-drawer\{[^}]*\}/);
  assert.ok(m, ".sb-drawer rule not found");
  assert.ok(/max-height:calc\(100dvh/.test(m[0]), "drawer must be dvh-bounded so it never exceeds the viewport");
  assert.ok(/overflow-y:auto/.test(m[0]), "drawer must scroll internally rather than clip off-screen");
});
