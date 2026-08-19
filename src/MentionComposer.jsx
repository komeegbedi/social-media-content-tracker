import { useState, useMemo, useRef, useLayoutEffect } from "react";
import {
  mentionQuery, filterMentionCandidates, groupMentionOptions, applyMention,
  mentionDisambiguator, syncCommentMentions,
} from "./data.js";

/* WhatsApp-style @mention composer for the task Discussion.

   Self-contained (no Firebase) so every interaction is unit-testable. Typing `@`
   opens an inline typeahead near the caret; it filters live by the person's FULL
   name (case-insensitive), floats current-task assignees to the top, and offers the
   @all group token. Selecting replaces the active @query AT THE CARET
   with the complete `@Full Name ` token (never a first name), and records the
   selection by UID. Identity is always the UID — display names are only copy.

   Contract:
   - candidates : mentionable users [{ id, name, email?, role?, departments? }]
   - assigneeUids : uids of the current task's assignees (ranked first)
   - onPost(text, { mentions, mentionNames, mentionAll }) -> post the note.
     `mentions`/`mentionNames` are re-derived from the draft on post, so a mention
     the user edited or deleted is dropped; `mentionAll` is the group token. */
export default function MentionComposer({ candidates = [], assigneeUids = [], onPost, placeholder = "Add a note for the crew…" }) {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState([]);      // [{ uid, name }] chosen via the typeahead
  const [active, setActive] = useState(0);           // highlighted suggestion index
  const [closed, setClosed] = useState(false);       // Escape / after-select suppression
  const taRef = useRef(null);
  const pendingCaret = useRef(null);                 // caret to restore after a programmatic edit

  const q = useMemo(() => mentionQuery(draft, caret), [draft, caret]);

  // Suggestion list for the active query: group aliases first, then people
  // (assignees ranked first). Empty when there's no active @query.
  const items = useMemo(() => {
    if (!q) return [];
    const groups = groupMentionOptions(q.query).map((alias) => ({ type: "group", key: `g:${alias}`, alias }));
    const people = filterMentionCandidates(candidates, q.query, assigneeUids)
      .map((u) => ({ type: "user", key: `u:${u.id}`, user: u, hint: mentionDisambiguator(u, candidates) }));
    return [...groups, ...people];
  }, [q, candidates, assigneeUids]);

  const open = !closed && !!q && items.length > 0;
  const activeIdx = Math.min(active, Math.max(0, items.length - 1));

  // Restore the caret after a programmatic insert (React resets it otherwise).
  useLayoutEffect(() => {
    if (pendingCaret.current != null && taRef.current) {
      const pos = pendingCaret.current;
      pendingCaret.current = null;
      taRef.current.focus({ preventScroll: true });
      taRef.current.setSelectionRange(pos, pos);
      setCaret(pos);
    }
  }, [draft]);

  const onChange = (e) => { setDraft(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setClosed(false); setActive(0); };
  const onSelectCaret = (e) => setCaret(e.target.selectionStart ?? 0);

  const choose = (item) => {
    if (!q) return;
    const insertName = item.type === "group" ? item.alias : item.user.name;
    const { text, caret: nextCaret } = applyMention(draft, q.start, caret, insertName);
    if (item.type === "user") {
      setSelected((s) => (s.some((x) => x.uid === item.user.id) ? s : [...s, { uid: item.user.id, name: item.user.name }]));
    }
    pendingCaret.current = nextCaret;
    setDraft(text);
    setClosed(true);
    setActive(0);
  };

  const onKeyDown = (e) => {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % items.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(items[activeIdx]); }
    else if (e.key === "Escape") { e.preventDefault(); setClosed(true); }
  };

  // Live view of what will actually be sent (mentions the user edited away drop out).
  const meta = useMemo(() => syncCommentMentions(draft, selected), [draft, selected]);
  const chips = meta.mentionNames.map((name, i) => ({ uid: meta.mentions[i], name }));

  const removeChip = (uid, name) => {
    setSelected((s) => s.filter((x) => x.uid !== uid));
    // Also strip the "@Name" token from the draft so the text and metadata agree.
    setDraft((d) => d.replace(new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s?`), ""));
  };

  const post = () => {
    const text = draft.trim();
    if (!text) return;
    const m = syncCommentMentions(draft, selected);
    onPost(text, m);
    setDraft(""); setSelected([]); setCaret(0); setClosed(false); setActive(0);
  };

  const listboxId = "mention-listbox";
  return (
    <div className="sb-mc">
      <div className="sb-field" style={{ marginTop: 10, position: "relative" }}>
        <label htmlFor="td-comment" className="sb-vh">Add a note for the crew</label>
        <textarea
          id="td-comment" ref={taRef} rows={2} placeholder={placeholder} value={draft}
          onChange={onChange} onSelect={onSelectCaret} onKeyDown={onKeyDown}
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

      {(chips.length > 0 || meta.mentionAll) && (
        <div className="sb-mention-chips" style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "8px 0 2px" }}>
          {meta.mentionAll && <span className="sb-chip sb-chip-all">@all · everyone on this task</span>}
          {chips.map((c) => (
            <span key={c.uid} className="sb-chip" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              @{c.name}
              <button type="button" aria-label={`Remove ${c.name}`} className="sb-chip-x" onClick={() => removeChip(c.uid, c.name)}>×</button>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
        <button className="sb-btn compact" disabled={!draft.trim()} onClick={post}>Post note</button>
        <span className="sb-sub" style={{ margin: 0 }}>Type <b>@</b> to mention someone</span>
      </div>
    </div>
  );
}
