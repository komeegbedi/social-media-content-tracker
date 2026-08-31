/* Startup orchestrator (pure, framework-free, unit-testable).

   Gates the first render on a single init `attempt` (Firebase App Check + service
   construction — see firebase.js). On success it mounts the app; on failure it renders a
   readable error with a genuine Retry that RE-RUNS the attempt. A re-entrancy guard means
   overlapping retries can never start a second attempt (so a retry cannot create duplicate
   Auth/Firestore listeners). No provider/optional feature (e.g. the admin Email Usage
   panel) participates here — those mount far inside the authenticated app and can never
   block startup.

   Contract:
     attempt():    () => Promise   — one fresh initialization attempt.
     mount():      () => void      — render the real app (called once, on success).
     renderError(retry): (fn) => void — render the fallback; `retry` re-runs the attempt.
     onError?(err): (err) => void  — optional sanitized hook (log a code, never secrets). */
export function runBootstrap({ attempt, mount, renderError, onError }) {
  let inFlight = false;
  let mounted = false;
  const go = () => {
    if (inFlight || mounted) return;          // no overlapping attempts, never re-mount
    inFlight = true;
    Promise.resolve()
      .then(attempt)
      .then(
        () => { inFlight = false; mounted = true; mount(); },
        (err) => {
          inFlight = false;
          if (onError) { try { onError(err); } catch { /* logging must never throw */ } }
          renderError(go);                    // `go` is the retry: re-runs `attempt`
        }
      );
  };
  go();
  return { retry: go };
}
