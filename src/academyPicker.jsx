/* Searchable picker (combobox + listbox) for the Academy workspace — used to
   add recommended courses and lesson prerequisites. Same accessible pattern as
   the @mention composer: the input keeps focus, options are announced with
   aria-activedescendant, a mouse press on an option never blurs the input
   first (so a blur/outside handler can't swallow the selection).

   Opens: click/tap in the field, typing, ↓ / Alt+↓, or the chevron.
   Closes: picking an option, Escape, a click/tap outside, focus leaving.
   After a pick the results close, the query clears and focus stays in the
   field WITHOUT reopening — ↓ or typing opens it again for the next one. */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "@heroicons/react/24/outline";

export function SearchPicker({
  id, label, placeholder, describedBy, items, getText = (x) => x.label,
  renderItem, onPick, listLabel, loading = false, error = "", onRetry,
  emptyText = "Nothing to add.", noMatchText = "No matches.", selected = [], selectedText = (x) => `“${getText(x)}” is already added.`,
  extraItem = null,   // (query) => an extra option (e.g. "Create “…”"), or null
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState({ up: false, max: 320 });
  const rootRef = useRef(null), inputRef = useRef(null);
  const needle = q.trim().toLowerCase();
  const match = (x) => !needle || String(getText(x) || "").toLowerCase().includes(needle);
  const extra = extraItem ? extraItem(q) : null;
  const shown = [...items.filter(match).slice(0, 50), ...(extra ? [extra] : [])];
  const already = needle ? selected.filter(match) : [];
  const listId = `${id}-list`;
  const optId = (i) => `${id}-opt-${i}`;

  // keep the active option valid as the list changes
  useEffect(() => { if (active >= shown.length) setActive(shown.length ? shown.length - 1 : -1); }, [shown.length, active]);
  // outside click/tap closes (capture: runs before anything inside can stop it)
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) { setOpen(false); setActive(-1); } };
    document.addEventListener("pointerdown", h, true);
    return () => document.removeEventListener("pointerdown", h, true);
  }, [open]);
  // fit the results into the visible viewport: below the field, or above it when there's more room there
  useLayoutEffect(() => {
    if (!open || !inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const below = vh - r.bottom - 12, above = r.top - 12;
    const up = below < 180 && above > below;
    setPlace({ up, max: Math.max(120, Math.min(320, up ? above : below)) });
  }, [open, q, shown.length]);
  // the active option stays in view while arrowing
  useEffect(() => { const el = open && active >= 0 ? document.getElementById(optId(active)) : null; if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); }, [active, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { setOpen(false); setActive(-1); };
  const pick = (x) => { onPick(x); setQ(""); close(); inputRef.current?.focus({ preventScroll: true }); };
  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!open) { setOpen(true); setActive(shown.length ? 0 : -1); } else setActive((a) => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { if (open) { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); } }
    else if (e.key === "Home" && open && shown.length) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && open && shown.length) { e.preventDefault(); setActive(shown.length - 1); }
    else if (e.key === "Enter") { if (open && active >= 0 && shown[active]) { e.preventDefault(); pick(shown[active]); } }
    else if (e.key === "Escape") { if (open) { e.preventDefault(); e.stopPropagation(); close(); } else if (q) { e.preventDefault(); e.stopPropagation(); setQ(""); } }
    else if (e.key === "Tab") close();
  };
  const status = loading ? "Loading…" : error ? null : shown.length === 0 ? (already.length ? selectedText(already[0]) : needle ? noMatchText : emptyText) : null;

  return (
    <div className="ac-pick" ref={rootRef} onBlur={(e) => { if (!rootRef.current?.contains(e.relatedTarget)) close(); }}>
      <div className="ac-pickfield">
        <input ref={inputRef} id={id} type="text" value={q} autoComplete="off" spellCheck={false}
          role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-haspopup="listbox"
          aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
          aria-label={label} aria-describedby={describedBy} placeholder={placeholder}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(e.target.value.trim() ? 0 : -1); }}
          onClick={() => { if (!open) setOpen(true); }}
          onKeyDown={onKeyDown} />
        <button type="button" className="ac-pickchev" tabIndex={-1} aria-label={open ? "Hide the list" : "Show the list"}
          onMouseDown={(e) => e.preventDefault()} onClick={() => { if (open) close(); else { setOpen(true); inputRef.current?.focus({ preventScroll: true }); } }}>
          <ChevronDownIcon className="hi hi-sm" aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div className={"ac-pickpop" + (place.up ? " up" : "")} style={{ maxHeight: place.max }} onMouseDown={(e) => e.preventDefault()}>
          {error ? (
            <div className="ac-pickstatus err" role="alert">{error}{onRetry && <> <button type="button" className="ac-link" onClick={onRetry}>Try again</button></>}</div>
          ) : status ? <div className="ac-pickstatus" role="status">{status}</div> : null}
          <ul id={listId} role="listbox" aria-label={listLabel} className="ac-picklist" hidden={!shown.length || loading || !!error}>
            {shown.map((x, i) => (
              <li key={x.id} id={optId(i)} role="option" aria-selected={i === active} className={"ac-pickopt" + (i === active ? " active" : "")}
                onClick={() => pick(x)} onMouseMove={() => { if (active !== i) setActive(i); }}>
                {renderItem ? renderItem(x) : getText(x)}
              </li>
            ))}
          </ul>
          <span className="sb-vh" role="status" aria-live="polite">{!loading && !error && shown.length ? `${shown.length} result${shown.length === 1 ? "" : "s"}` : ""}</span>
        </div>
      )}
    </div>
  );
}
