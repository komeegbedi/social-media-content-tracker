/* UI for stale-release recovery (appUpdate.js): the app-wide notice, a
   "Save and reload" action usable inside editors, and lazy screens that can be
   retried for real (React.lazy caches a failed import for ever, so "Try
   again" must create a fresh lazy component). No App.jsx dependency. */
import React, { useState, useSyncExternalStore } from "react";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { STALE_MESSAGE, useAppUpdate, saveAndReload, hasOpenEditors } from "./appUpdate.js";
import { useUploadsInFlight } from "./academyUploads.js";

/* The reload action: saves registered editors first; reports instead of
   reloading when anything can't be saved or an image is uploading. */
export function SaveAndReloadButton({ className = "sb-btn compact", run = saveAndReload, label }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const uploading = useUploadsInFlight();
  const go = async () => {
    if (busy) return;
    setBusy(true); setMsg("");
    const r = await run();
    if (!r?.ok) { setMsg(r?.message || "The page wasn't reloaded."); setBusy(false); }
  };
  // one stable label while an editor is open (whether or not it has unsaved edits right now)
  const text = label || (hasOpenEditors() || uploading ? "Save and reload" : "Reload");
  return (
    <span className="ac-reloadact">
      <button type="button" className={className} onClick={go} disabled={busy} aria-busy={busy || undefined}>
        <ArrowPathIcon className="hi hi-sm" aria-hidden="true" /><span>{busy ? "Saving…" : text}</span>
      </button>
      {msg && <span className="ac-err" role="alert">{msg}</span>}
    </span>
  );
}

/* Shown at the top of the main area once this tab is known to be out of date. */
export function UpdateBanner() {
  const u = useAppUpdate();
  if (u.status !== "stale") return null;
  return (
    <div className="sb-updatebanner" role="status">
      <span>{STALE_MESSAGE}</span>
      <SaveAndReloadButton />
    </div>
  );
}

/* React.lazy that can be retried: retryLazies() swaps in a fresh lazy for each
   component whose import failed (the next render imports again). */
const lazies = new Set();
let version = 0;
const vsubs = new Set();
export function retryableLazy(loader) {
  const box = { failed: false, loader };
  // only a lazy whose import FAILED is replaced on retry (a loaded one keeps its
  // instance, so nothing that rendered fine is remounted)
  const load = () => loader().catch((e) => { box.failed = true; throw e; });
  box.make = () => React.lazy(load);
  box.current = box.make();
  lazies.add(box);
  function RetryableLazy(props) {
    useSyncExternalStore((f) => { vsubs.add(f); return () => vsubs.delete(f); }, () => version, () => version);
    const C = box.current;
    return <C {...props} />;
  }
  RetryableLazy.preload = loader;
  return RetryableLazy;
}
export function retryLazies() {
  for (const b of lazies) if (b.failed) { b.failed = false; b.current = b.make(); }
  version += 1;
  vsubs.forEach((f) => f());
}
