/* IFC Creative Academy — contextual link editor for the formatted (visual) text
   editor (RichTextField).

   • linkContext(root, range) decides what the selection means:
       create — no link touched (caret or plain text selected)
       edit   — caret inside ONE link, or a selection entirely within it, or
                exactly that link
       mixed  — the selection touches 2+ links, or a link plus unlinked text;
                handled explicitly (link it all to one address / remove the
                links) instead of silently applying the wrong destination
   • Actions go through document.execCommand so the editor's own undo/redo
     keeps working; each has a plain-DOM fallback (jsdom, odd engines).
   • LinkPopover is anchored to the selection/link (fixed, in a portal, so the
     editor's scroll container can't clip it), flips above/below and clamps to
     the viewport; under 600 px it's a compact bottom sheet. Opening or
     cancelling never touches the content. Only https?:// addresses are ever
     written (isSafeHref) and "Open link" uses noopener/noreferrer. */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowTopRightOnSquareIcon, LinkSlashIcon } from "@heroicons/react/24/outline";
import { isSafeHref } from "./academyMarkdown.js";
import { normalizeLinkInput } from "./academyLinks.js";
import { useMediaQuery } from "./overlay.jsx";

const execOk = () => typeof document !== "undefined" && typeof document.execCommand === "function";
const exec = (cmd, arg = null) => { try { return execOk() && document.execCommand(cmd, false, arg); } catch { return false; } };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ---------------------------------------------------------- selection logic */
export function linkContext(root, range) {
  if (!root || !range || !root.contains(range.commonAncestorContainer)) return { mode: "create", collapsed: true, text: "" };
  const closestA = (n) => { for (let x = n && (n.nodeType === 1 ? n : n.parentNode); x && x !== root; x = x.parentNode) if (x.tagName === "A") return x; return null; };
  const touched = [...root.querySelectorAll("a")].filter((a) => {
    try { return range.intersectsNode(a); } catch { return false; }
  });
  const startA = closestA(range.startContainer), endA = closestA(range.endContainer);
  const text = range.toString();
  if (range.collapsed) {
    return startA ? { mode: "edit", anchor: startA, collapsed: true, text: startA.textContent, href: startA.getAttribute("href") || "" } : { mode: "create", collapsed: true, text: "" };
  }
  // Selection entirely inside one link (or exactly that link's text).
  const only = touched.length === 1 ? touched[0] : null;
  const within = startA && startA === endA;
  const exact = only && text.trim() === only.textContent.trim() && text.trim().length > 0;
  if (within || exact) {
    const a = within ? startA : only;
    return { mode: "edit", anchor: a, collapsed: false, text: a.textContent, selectedText: text, href: a.getAttribute("href") || "" };
  }
  if (touched.length === 0) return { mode: "create", collapsed: false, text };
  const linkedText = touched.map((a) => a.textContent).join("");
  return { mode: "mixed", links: touched, collapsed: false, text, hasUnlinked: text.replace(/\s/g, "").length > linkedText.replace(/\s/g, "").length || touched.length === 1 };
}

const select = (range) => { const sel = window.getSelection(); if (!sel) return; sel.removeAllRanges(); sel.addRange(range); };
const rangeAround = (node) => { const r = document.createRange(); r.selectNode(node); return r; };

/* --------------------------------------------------------------- actions ---- */
export function createLink(root, range, url, text) {
  root.focus({ preventScroll: true });
  select(range);
  if (!range.collapsed) {
    if (exec("createLink", url)) return true;
    const a = document.createElement("a"); a.setAttribute("href", url);
    a.appendChild(range.extractContents()); range.insertNode(a); return true;
  }
  const label = String(text || "").trim() || url;
  if (exec("insertHTML", `<a href="${esc(url)}">${esc(label)}</a>`)) return true;
  const a = document.createElement("a"); a.setAttribute("href", url); a.textContent = label;
  range.insertNode(a); return true;
}
/* Change a link's destination (and its text, only if the author changed it).
   Unchanged text keeps any bold/italic inside the link. Never nests anchors. */
export function updateLink(root, anchor, url, newText) {
  root.focus({ preventScroll: true });
  const textChanged = newText != null && newText.trim() && newText.trim() !== anchor.textContent.trim();
  if (textChanged) {
    select(rangeAround(anchor));
    if (exec("insertHTML", `<a href="${esc(url)}">${esc(newText.trim())}</a>`)) return true;
    const a = document.createElement("a"); a.setAttribute("href", url); a.textContent = newText.trim();
    anchor.replaceWith(a); return true;
  }
  if ((anchor.getAttribute("href") || "") === url) return false;
  // unlink + relink the same content: formatting kept, one anchor, undoable.
  const r = document.createRange(); r.selectNodeContents(anchor);
  select(r);
  if (exec("unlink") && exec("createLink", url)) return true;
  anchor.setAttribute("href", url); return true;
}
/* Remove a link but keep its text and inline formatting. */
export function removeLink(root, anchor) {
  root.focus({ preventScroll: true });
  const r = document.createRange(); r.selectNodeContents(anchor);
  select(r);
  if (exec("unlink")) return true;
  anchor.replaceWith(...anchor.childNodes); return true;
}
/* Mixed selections: remove every link the selection touches (text kept). */
export function unlinkRange(root, range, links = []) {
  root.focus({ preventScroll: true });
  select(range);
  if (exec("unlink") && ![...root.querySelectorAll("a")].some((a) => links.includes(a))) return true;
  for (const a of links) if (a.isConnected) a.replaceWith(...a.childNodes);
  return true;
}
export function relinkRange(root, range, links, url) {
  unlinkRange(root, range, links);
  const sel = window.getSelection();
  const r = sel && sel.rangeCount ? sel.getRangeAt(0) : range;
  return createLink(root, r, url);
}
export const openLinkSafely = (href) => { if (isSafeHref(href)) window.open(href, "_blank", "noopener,noreferrer"); };

/* ------------------------------------------------------------ the popover --- */
const GAP = 8, MARGIN = 8;
export function placeNear(rect, size, vw, vh) {
  const below = vh - rect.bottom - GAP - MARGIN, above = rect.top - GAP - MARGIN;
  const side = size.height <= below || below >= above ? "below" : "above";
  const top = side === "below" ? Math.min(rect.bottom + GAP, vh - size.height - MARGIN) : Math.max(MARGIN, rect.top - GAP - size.height);
  const left = Math.max(MARGIN, Math.min(rect.left, vw - size.width - MARGIN));
  return { top: Math.round(Math.max(MARGIN, top)), left: Math.round(left), side };
}

export function LinkPopover({ ctx, getRect, onApply, onRemove, onUnlinkAll, onOpen, onCancel, idBase }) {
  const sheet = useMediaQuery("(max-width: 599px)");
  const box = useRef(null);
  const onCancelRef = useRef(onCancel); onCancelRef.current = onCancel;
  const urlRef = useRef(null);
  const [pos, setPos] = useState(null);
  const [kbd, setKbd] = useState(0);                          // mobile keyboard height
  const editing = ctx.mode === "edit";
  const [url, setUrl] = useState(editing ? ctx.href : "");
  const [text, setText] = useState(editing ? ctx.text : "");
  const [err, setErr] = useState("");
  const normalized = normalizeLinkInput(url);
  const valid = isSafeHref(normalized);

  const place = () => {
    if (sheet || !box.current) return;
    const r = getRect();
    if (!r) return;
    setPos(placeNear(r, { width: box.current.offsetWidth, height: box.current.offsetHeight }, window.innerWidth, window.innerHeight));
  };
  useLayoutEffect(() => { place(); }, [sheet]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const re = () => place();
    window.addEventListener("resize", re); window.addEventListener("scroll", re, true);
    const vv = window.visualViewport;
    const onVV = () => { if (vv) setKbd(Math.max(0, window.innerHeight - vv.height - vv.offsetTop)); re(); };
    vv?.addEventListener("resize", onVV); vv?.addEventListener("scroll", onVV);
    requestAnimationFrame(() => { urlRef.current?.focus({ preventScroll: true }); urlRef.current?.select(); });
    // Escape cancels wherever focus is; a click outside the popover dismisses it
    // (without moving the author's new caret back).
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); onCancelRef.current(true); } };
    const onDown = (e) => { if (box.current && !box.current.contains(e.target) && !e.target.closest?.(".ac-linkscrim")) onCancelRef.current(false); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => { window.removeEventListener("resize", re); window.removeEventListener("scroll", re, true); vv?.removeEventListener("resize", onVV); vv?.removeEventListener("scroll", onVV);
      document.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onDown, true); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e) => {
    e.preventDefault();
    if (!valid) { setErr(url.trim() ? "That isn't a web address that can be linked. Use one that starts with https://, for example https://example.com." : "Enter the web address to link to."); urlRef.current?.focus(); return; }
    onApply({ url: normalized, text });
  };
  const onKeyDown = () => {};   // Escape is handled at document level (above)
  const title = editing ? "Edit link" : ctx.mode === "mixed" ? (ctx.links.length > 1 ? `Your selection includes ${ctx.links.length} links` : "Your selection includes linked and unlinked text") : "Add link";
  const errId = `${idBase}-linkerr`;

  const form = (
    <form ref={box} className={"ac-linkpop2" + (sheet ? " is-sheet" : "")} role="dialog" aria-modal={sheet ? "true" : undefined} aria-label={title}
      onSubmit={submit} onKeyDown={onKeyDown} noValidate
      style={sheet ? { bottom: kbd } : { position: "fixed", top: pos ? pos.top : -9999, left: pos ? pos.left : -9999, visibility: pos ? "visible" : "hidden" }}>
      <div className="ac-linkpop2-head"><b>{title}</b></div>
      {ctx.mode === "mixed" && <p className="ac-cardsub ac-linkpop2-note">Choose what to do with all of it: give the whole selection one address, or remove the links it contains. Nothing changes until you choose.</p>}
      {ctx.mode === "create" && !ctx.collapsed && <p className="ac-linkpop2-sel"><span className="ac-cardsub">Text</span> <span className="ac-linkpop2-quote">“{ctx.text.length > 80 ? ctx.text.slice(0, 80) + "…" : ctx.text}”</span></p>}
      {(editing || (ctx.mode === "create" && ctx.collapsed)) && (
        <div className="sb-field">
          <label htmlFor={`${idBase}-ltext`}>Text to show{editing ? "" : " (optional)"}</label>
          <input id={`${idBase}-ltext`} value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder={editing ? "" : "Defaults to the address"} />
        </div>
      )}
      <div className="sb-field">
        <label htmlFor={`${idBase}-lurl`}>Web address</label>
        <input id={`${idBase}-lurl`} ref={urlRef} type="text" inputMode="url" autoComplete="url" spellCheck={false} placeholder="https://…" value={url}
          onChange={(e) => { setUrl(e.target.value); if (err) setErr(""); }}
          onBlur={() => { if (url.trim() && !valid) setErr("That isn't a web address that can be linked. Use one that starts with https://, for example https://example.com."); }}
          aria-invalid={err ? "true" : undefined} aria-describedby={err ? errId : undefined} />
        {err && <div id={errId} className="ac-err" role="alert">{err}</div>}
      </div>
      <div className="ac-linkpop2-actions">
        <button type="submit" className="sb-btn compact">{editing ? "Update link" : ctx.mode === "mixed" ? "Link all selected text" : "Apply"}</button>
        {editing && <button type="button" className="sb-btn ghost compact" onClick={() => onOpen(ctx.href)} disabled={!isSafeHref(ctx.href)}><ArrowTopRightOnSquareIcon className="hi hi-sm" aria-hidden="true" /><span>Open link</span></button>}
        {editing && <button type="button" className="sb-btn ghost subtle-danger compact" onClick={onRemove}><LinkSlashIcon className="hi hi-sm" aria-hidden="true" /><span>Remove link</span></button>}
        {ctx.mode === "mixed" && <button type="button" className="sb-btn ghost compact" onClick={onUnlinkAll}><LinkSlashIcon className="hi hi-sm" aria-hidden="true" /><span>Remove links in selection</span></button>}
        <button type="button" className="sb-btn ghost compact" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
  return createPortal(sheet ? <div className="ac-menuscrim ac-linkscrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>{form}</div> : form, document.body);
}
