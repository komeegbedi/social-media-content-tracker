/* IFC Creative Academy — single-step Undo + safe reorder persistence.

   Three separate concerns (the old code mixed them, so "Undo" re-offered Undo
   and toggled forever):
     1. PERSIST an order               → useReorder().save(ids)   (no Undo)
     2. RECORD a user-initiated move   → useReorder().move(ids, label) → offers Undo once
     3. REVERSE that move              → the Undo action: checks the order is
        still the one we wrote (else refuses — never overwrite someone else's
        newer change), persists the previous order once, then shows
        "Move undone" with NO further Undo.

   useUndo is the toast: one undoable action at a time (a new one replaces
   it), the button is disabled while the undo runs, double clicks can't run it
   twice, failure shows a truthful message + "Try again", and timers are
   cleared on dismiss/unmount (navigation). */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";

/* Plain words for a failed write (never raw rule-debug text). */
export function friendlySaveError(e) {
  const code = String(e?.code || "").replace(/^firestore\//, "");
  if (code === "permission-denied") return "the change wasn't accepted. You may not have permission, or one of these items changed in the meantime";
  if (code === "unavailable" || code === "deadline-exceeded" || /network|offline|fetch/i.test(e?.message || "")) return "the connection dropped";
  if (code === "stale" || code === "conflict") return e.message;
  const m = String(e?.message || "").split(/[:\n]/)[0].trim();
  return m && m.length < 120 ? m : "something went wrong";
}
export const sameIds = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/* ------------------------------------------------------------------ toast -- */
export function useUndo({ idleMs = 8000, doneMs = 3000 } = {}) {
  // state: null | { key, message, undo, phase: "ready"|"pending"|"done"|"error", error }
  const [s, setS] = useState(null);
  const timer = useRef(0);
  const running = useRef(false);
  const seq = useRef(0);
  const alive = useRef(true);
  // StrictMode-safe: re-mark alive on (re)mount, not only clear on unmount.
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
  const arm = (ms) => { clearTimeout(timer.current); timer.current = setTimeout(() => { if (alive.current) setS(null); }, ms); };

  const clear = useCallback(() => { clearTimeout(timer.current); seq.current++; running.current = false; setS(null); }, []);
  /* offer({ message, undo: async () => void }) — replaces any previous offer. */
  const offer = useCallback(({ message, undo, doneMessage = "Move undone." }) => {
    seq.current++; running.current = false;
    setS({ key: seq.current, message, undo, doneMessage, phase: "ready" });
    arm(idleMs);
  }, [idleMs]); // eslint-disable-line react-hooks/exhaustive-deps
  /* A plain confirmation with no action (e.g. a failed move's explanation). */
  const notify = useCallback((message, { error = false } = {}) => {
    seq.current++; running.current = false;
    setS({ key: seq.current, message, phase: error ? "error-final" : "done" });
    arm(error ? idleMs : doneMs);
  }, [idleMs, doneMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (!s || running.current || (s.phase !== "ready" && s.phase !== "error")) return;
    running.current = true;
    const mine = s.key;
    clearTimeout(timer.current);
    setS((x) => (x && x.key === mine ? { ...x, phase: "pending", error: "" } : x));
    try {
      await s.undo();
      if (!alive.current || seq.current !== mine) return;          // replaced meanwhile
      running.current = false;
      setS((x) => ({ key: mine, message: x?.doneMessage || "Move undone.", phase: "done" }));
      arm(doneMs);
    } catch (e) {
      if (!alive.current || seq.current !== mine) return;
      running.current = false;
      const final = e?.code === "stale";                           // can't be retried safely
      setS((x) => (x && x.key === mine ? { ...x, phase: final ? "error-final" : "error", error: final ? e.message : `Couldn't undo: ${friendlySaveError(e)}.` } : x));
      arm(idleMs);
    }
  };

  const node = s ? (
    <div className={"ac-undo" + (s.phase === "error" || s.phase === "error-final" ? " is-error" : "")} role="status" aria-live="polite">
      <span className="ac-undomsg">{s.phase === "error" || s.phase === "error-final" ? (s.error || s.message) : s.message}</span>
      {(s.phase === "ready" || s.phase === "pending") && (
        <button type="button" className="ac-undobtn" onClick={run} disabled={s.phase === "pending"} aria-busy={s.phase === "pending" || undefined}>
          {s.phase === "pending" ? "Undoing…" : "Undo"}
        </button>
      )}
      {s.phase === "error" && <button type="button" className="ac-undobtn" onClick={run}>Try again</button>}
      <button type="button" className="ac-undox" onClick={clear} aria-label="Dismiss"><XMarkIcon className="hi hi-sm" aria-hidden="true" /></button>
    </div>
  ) : null;
  return { offer, notify, clear, node, phase: s?.phase || null };
}

/* -------------------------------------------------------- reorder writes -- */
/* `observed`: ids in the order the subscription currently reports.
   `persist(ids)`: writes an order (async).
   Display order = the order we asked for until the observed order matches it
   (no timers — a slow save never snaps back). Writes are serialized and
   coalesced: while one is in flight only the LATEST requested order is written
   next. Failure → `error` + `retry()`; the shown order falls back to observed. */
export function useReorder(observed, persist, { onError } = {}) {
  const [want, setWant] = useState(null);         // ids we expect to see, or null
  const [state, setState] = useState({ phase: "idle" });   // idle | saving | error
  const inflight = useRef(null);                   // Promise of the current write
  const queued = useRef(null);                     // latest ids waiting to be written
  const persistRef = useRef(persist); persistRef.current = persist;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);   // StrictMode-safe

  // Reconcile with what the database reports.
  useEffect(() => {
    if (want && sameIds(observed, want) && !inflight.current && !queued.current) setWant(null);
  }, [observed, want]);

  const pump = useCallback(() => {
    if (inflight.current || !queued.current) return inflight.current;
    const ids = queued.current; queued.current = null;
    setState({ phase: "saving" });
    const p = (async () => {
      let err = null;
      try { await persistRef.current(ids); } catch (e) { err = e; }
      inflight.current = null;
      if (!alive.current) { if (err) throw err; return; }
      if (queued.current) return pump();           // a newer order supersedes; its result decides
      if (err) {
        setWant(null);                             // show the truth (Firestore already rolled back)
        setState({ phase: "error", message: friendlySaveError(err), ids });
        onError?.(err);
        throw err;
      }
      setState({ phase: "idle" });
    })();
    inflight.current = p;
    return p;
  }, [onError]);

  /* Persist `ids` (no Undo). Resolves when this order (or a newer one) is saved. */
  const save = useCallback((ids) => {
    setWant(ids);
    queued.current = ids;
    return pump() || Promise.resolve();
  }, [pump]);
  const retry = useCallback(() => (state.ids ? save(state.ids) : Promise.resolve()), [state.ids, save]);
  // Items added/removed elsewhere meanwhile still appear/disappear correctly.
  const shown = useMemo(() => (want ? [...want.filter((id) => observed.includes(id)), ...observed.filter((id) => !want.includes(id))] : observed), [want, observed]);
  return useMemo(() => ({ shown, save, retry, state, saving: state.phase === "saving" }), [shown, save, retry, state]);
}

/* Record a user move: persist it and offer ONE Undo that reverses exactly it.
   `current()` must return the order as it is NOW (observed), so a stale undo
   (someone else reordered since) is refused instead of overwriting them. */
export function recordMove({ before, after, label, save, current, undo: undoToast, same = sameIds, message }) {
  if (same(before, after)) return Promise.resolve();             // no-op drag → nothing to undo
  // The move's own failure is shown by the list (error + Retry); a failed move
  // has nothing to undo, so its toast is withdrawn.
  // save() runs synchronously so the list shows the new order in the same render as the drop.
  let p; try { p = Promise.resolve(save(after)); } catch (e) { p = Promise.reject(e); }
  p = p.catch(() => { undoToast.clear(); });
  undoToast.offer({
    message: message || `Moved “${label}”.`,
    undo: async () => {
      const now = current();
      if (!same(now, after)) throw Object.assign(new Error("The order changed after your move (another editor or tab), so it can't be undone safely."), { code: "stale" });
      await save(before);
    },
  });
  return p;
}

/* Deep equality for small plain data (module outlines). */
export const sameData = (a, b) => JSON.stringify(a) === JSON.stringify(b);
