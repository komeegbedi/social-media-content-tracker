/* Browser connectivity as React state (navigator.onLine + online/offline
   events). Used to make save/sync status truthful: a write that is queued
   while offline is "waiting to sync", not "saving" and not "saved". */
import { useEffect, useState } from "react";

export const isOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false);
/* Errors that mean "couldn't reach the server" rather than "the server said no". */
export const isOfflineError = (e) => !isOnline() || /unavailable|deadline-exceeded/.test(String(e?.code || "")) || /offline|network|failed to fetch|connection/i.test(String(e?.message || ""));

export function useOnline() {
  const [online, setOnline] = useState(isOnline);
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    setOnline(isOnline());
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}
/* For actions that must reach the server now (publish, visibility, delete):
   refuse up front instead of hanging or appearing to succeed. */
export function requireOnline() {
  if (!isOnline()) throw new Error("You're offline. Nothing was changed — reconnect, then try again.");
}
