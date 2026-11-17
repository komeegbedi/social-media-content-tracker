/* Image uploads in flight (covers, thumbnails). Publishing waits for these so a
   cover that is still uploading is never reported as "missing" — and never
   published without. Module-level: one counter for the whole app. */
import { useSyncExternalStore } from "react";

let inFlight = 0;
const subs = new Set();
const emit = () => { for (const f of subs) f(); };
export function trackUpload(promise) {
  inFlight += 1; emit();
  return Promise.resolve(promise).finally(() => { inFlight = Math.max(0, inFlight - 1); emit(); });
}
export const uploadsInFlight = () => inFlight;
export function subscribeUploads(f) { subs.add(f); return () => subs.delete(f); }
export function useUploadsInFlight() { return useSyncExternalStore(subscribeUploads, uploadsInFlight, () => 0); }
/* Resolves when nothing is uploading; rejects after `ms` (the caller explains). */
export function waitForUploads(ms = 120000) {
  if (!inFlight) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { off(); reject(Object.assign(new Error("An image is still uploading. Wait for it to finish, then publish."), { code: "uploading" })); }, ms);
    const off = subscribeUploads(() => { if (!inFlight) { clearTimeout(t); off(); resolve(); } });
  });
}
