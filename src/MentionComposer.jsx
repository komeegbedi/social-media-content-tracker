import { useState, useMemo, useRef, useLayoutEffect, useEffect } from "react";
import {
  mentionQuery, filterMentionCandidates, groupMentionOptions, applyMention,
  mentionDisambiguator, planMentionDeletion, tokenSegments, reconcileTokens, applyTokenEdit,
} from "./data.js";

/* WhatsApp-style @mention composer for the task Discussion.
   ---------------------------------------------------------------------------
   Inline highlighting WITHOUT unsafe HTML: a real <textarea> owns editing, caret
   and selection (fully controllable + testable); its text is painted transparent
   over an aria-hidden OVERLAY that renders the SAME value with each mention drawn
   as a green token. Nothing is ever set via innerHTML.

   STRUCTURED TOKENS, not regex-matched text: each typeahead-selected mention is a
   token with an explicit range `{ start, name, uid?, group }`. On every edit the
   ranges are re-mapped by DIFF (reconcileTokens): edits before a token shift it,
   edits after leave it, and only an edit that INTERSECTS the token removes it. So a
   mention keeps its identity + highlight when the trailing space is deleted, when
   text is typed right beside it, or when punctuation is added — while a hand-typed
   or pasted "@Name" lookalike (never in the token list) stays inert. Identity is
   always the UID; a token is real only via an explicit typeahead selection.

   Contract:
   - candidates : mentionable users [{ id, name, email?, role?, departments? }]
   - assigneeUids : uids of the current task's assignees (ranked first)
   - onPost(text, { mentions, mentionNames, mentionAll, mentionRanges }) — post the
     note. mentionRanges are token positions in the posted text (rendering-only). */
export default function MentionComposer({ candidates = [], assigneeUids = [], onPost, placeholder = "Add a note for the crew…" }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [tokens, setTokens] = useState([]);          // [{ start, name, uid?, group }] — position-tracked
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const taRef = useRef(null);
  const overlayRef = useRef(null);
  const pendingCaret = useRef(null);
  const beforeInputRef = useRef(null);               // latest beforeinput handler (fresh closures)

  // Token ranges (identity carried by position, not by re-matching the text).
  const spans = useMemo(
    () => [...tokens].sort((a, b) => a.start - b.start)
      .map((t) => ({ start: t.start, end: t.start + 1 + t.name.length, uid: t.uid, group: t.group, name: t.name })),
    [tokens]);
  const segments = useMemo(() => tokenSegments(text, spans), [text, spans]);

  const q = useMemo(() => mentionQuery(text, caret), [text, caret]);
  const items = useMemo(() => {
    if (!q) return [];
    const groups = groupMentionOptions(q.query).map((alias) => ({ type: "group", key: `g:${alias}`, alias }));
    const people = filterMentionCandidates(candidates, q.query, assigneeUids)
      .map((u) => ({ type: "user", key: `u:${u.id}`, user: u, hint: mentionDisambiguator(u, candidates) }));
    return [...groups, ...people];
  }, [q, candidates, assigneeUids]);
  const open = !closed && !!q && items.length > 0;
  const activeIdx = Math.min(active, Math.max(0, items.length - 1));

  // Attach a stable native `beforeinput` listener that delegates to the latest
  // handler (React's synthetic onBeforeInput is unreliable across versions).
  useEffect(() => {
    const el = taRef.current; if (!el) return;
    const listener = (e) => beforeInputRef.current && beforeInputRef.current(e);
    el.addEventListener("beforeinput", listener);
    return () => el.removeEventListener("beforeinput", listener);
  }, []);

  useLayoutEffect(() => {
    if (pendingCaret.current != null && taRef.current) {
      const pos = pendingCaret.current; pendingCaret.current = null;
      taRef.current.focus({ preventScroll: true });
      taRef.current.setSelectionRange(pos, pos);
      setCaret(pos);
    }
    if (overlayRef.current && taRef.current) overlayRef.current.scrollTop = taRef.current.scrollTop;
  }, [text]);

  // Single funnel for EVERY text change. For a KNOWN edit (proactive delete/insert/
  // select) we re-map tokens by its EXACT range (applyTokenEdit) — deterministic, so
  // an adjacent token is never wrongly dropped. For an UNKNOWN native change (onChange)
  // we diff old→new (reconcileTokens). Then optionally add a freshly selected token.
  const applyValue = (nextText, nextCaret, { addToken = null, edit = null, restoreCaret = true } = {}) => {
    setTokens((toks) => {
      let next = edit ? applyTokenEdit(toks, edit.start, edit.end, edit.insertLen) : reconcileTokens(toks, text, nextText);
      if (addToken) next = [...next, addToken];
      return next;
    });
    if (restoreCaret) pendingCaret.current = nextCaret;
    setText(nextText);
    setCaret(nextCaret);
  };

  const syncScroll = () => { if (overlayRef.current && taRef.current) overlayRef.current.scrollTop = taRef.current.scrollTop; };
  const onChange = (e) => { applyValue(e.target.value, e.target.selectionStart ?? e.target.value.length, { restoreCaret: false }); setClosed(false); setActive(0); };
  const onSelectCaret = (e) => setCaret(e.target.selectionStart ?? 0);

  const choose = (item) => {
    if (!q) return;
    const insertName = item.type === "group" ? item.alias : item.user.name;
    const { text: nextText, caret: nextCaret } = applyMention(text, q.start, caret, insertName);
    const token = item.type === "group"
      ? { start: q.start, name: insertName, group: true }
      : { start: q.start, name: item.user.name, uid: item.user.id, group: false };
    applyValue(nextText, nextCaret, { addToken: token, edit: { start: q.start, end: caret, insertLen: nextCaret - q.start } });
    setClosed(true); setActive(0);
  };

  const commit = (nextText, nextCaret, edit) => { applyValue(nextText, nextCaret, { edit }); setClosed(true); };

  // keydown drives ONLY the typeahead — never editing (that's handled at beforeinput
  // so it works on mobile too, where a Backspace keydown may not fire).
  const onKeyDown = (e) => {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % items.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(items[activeIdx]); }
    else if (e.key === "Escape") { e.preventDefault(); setClosed(true); }
  };

  // The SINGLE editing interception point. `beforeinput` fires for EVERY edit path —
  // desktop keys, MOBILE virtual keyboards (where keydown may not fire), cut, paste,
  // and typing/pasting over a selection — and is cancelable. A deletion or an insert
  // that TARGETS or INTERSECTS a selected token removes the WHOLE visible token (its
  // text, not merely its highlight/metadata); everything else proceeds natively and
  // reconcileTokens (onChange) keeps ranges in sync. Composition (IME) is left to
  // compose and reconciled afterwards, so it never leaves stale metadata.
  const handleBeforeInput = (e) => {
    const ta = taRef.current; if (!ta) return;
    const it = e.inputType || "";
    if (it.includes("omposition")) return;                       // IME → reconcile is the safety net
    const s = ta.selectionStart ?? 0, en = ta.selectionEnd ?? 0;
    if (it.startsWith("delete")) {
      // Removes the whole token when the delete targets it (incl. cut / mobile);
      // returns null for a separator-only or plain-text delete → let it happen.
      const plan = planMentionDeletion(text, s, en, it.toLowerCase().includes("forward") ? "forward" : "backward", spans);
      if (plan) { e.preventDefault(); commit(plan.text, plan.caret, { start: plan.range[0], end: plan.range[1], insertLen: 0 }); }
      return;
    }
    if (it.startsWith("insert")) {
      const touched = s !== en
        ? spans.filter((sp) => sp.start < en && sp.end > s)      // selection intersects a token
        : spans.filter((sp) => sp.start < s && s < sp.end);      // caret STRICTLY inside a token
      if (!touched.length) return;                               // normal insert → native → onChange
      e.preventDefault();
      let data = e.data;
      if (data == null) data = e.dataTransfer ? e.dataTransfer.getData("text") : (it === "insertLineBreak" || it === "insertParagraph" ? "\n" : "");
      let lo = s, hi = en;
      for (const sp of touched) { lo = Math.min(lo, sp.start); hi = Math.max(hi, sp.end); }
      if (text[hi] === " ") hi += 1;                             // absorb the removed token's separator
      commit(text.slice(0, lo) + data + text.slice(hi), lo + data.length, { start: lo, end: hi, insertLen: data.length });
    }
  };
  beforeInputRef.current = handleBeforeInput;                    // always the latest closures

  const post = () => {
    const lead = text.length - text.trimStart().length;   // token positions shift when leading space trims
    const body = text.trim();
    if (!body) return;
    const mentions = [], mentionNames = [], mentionRanges = [], seen = new Set();
    let mentionAll = false;
    for (const t of [...tokens].sort((a, b) => a.start - b.start)) {
      const start = t.start - lead, end = start + 1 + t.name.length;
      if (start < 0 || end > body.length || body.slice(start, end) !== "@" + t.name) continue;
      mentionRanges.push(start, end);
      if (t.group) { mentionAll = true; continue; }
      if (t.uid && !seen.has(t.uid)) { seen.add(t.uid); mentions.push(t.uid); mentionNames.push(t.name); }
    }
    onPost(body, { mentions, mentionNames, mentionAll, mentionRanges });
    setText(""); setTokens([]); setCaret(0); setClosed(false); setActive(0);
  };

  const listboxId = "mention-listbox";
  return (
    <div className="sb-mc">
      <label htmlFor="td-comment" className="sb-vh">Add a note for the crew</label>
      <div className="sb-mc-wrap">
        <div ref={overlayRef} className="sb-mc-overlay" aria-hidden="true">
          {segments.map((seg, i) => seg.mention
            ? <span key={i} className={"sb-mention-tag" + (seg.group ? " grp" : "")}>{seg.text}</span>
            : <span key={i}>{seg.text}</span>)}
          {"​"}
        </div>
        <textarea
          id="td-comment" ref={taRef} rows={2} className="sb-mc-input" placeholder={placeholder} value={text}
          onChange={onChange} onSelect={onSelectCaret} onKeyDown={onKeyDown} onScroll={syncScroll}
          role="combobox" aria-expanded={open} aria-controls={listboxId} aria-autocomplete="list"
          aria-activedescendant={open ? `mention-opt-${activeIdx}` : undefined} />
        {open && (
          <ul className="sb-mention-pop" role="listbox" id={listboxId} aria-label="Mention a teammate">
            {items.map((item, i) => (
              <li
                key={item.key} id={`mention-opt-${i}`} role="option" aria-selected={i === activeIdx}
                className={"sb-mention-opt" + (i === activeIdx ? " active" : "")}
                onMouseDown={(e) => { e.preventDefault(); choose(item); }}
                onMouseEnter={() => setActive(i)}>
                {item.type === "group" ? (
                  <>
                    <span className="sb-mention-av sb-mention-av-all" aria-hidden="true">@</span>
                    <span className="sb-mention-nm"><bdi>@{item.alias}</bdi></span>
                    <span className="sb-mention-hint">Everyone on this task</span>
                  </>
                ) : (
                  <>
                    <span className="sb-mention-av" aria-hidden="true">{(item.user.name || "?").trim().charAt(0).toUpperCase()}</span>
                    <span className="sb-mention-nm"><bdi>{item.user.name}</bdi></span>
                    {item.hint && <span className="sb-mention-hint">{item.hint}</span>}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
        <button className="sb-btn compact" disabled={!text.trim()} onClick={post}>Post note</button>
        <span className="sb-sub" style={{ margin: 0 }}>Type <b>@</b> to mention someone</span>
      </div>
    </div>
  );
}
