/* Starter-category setup and the category read-error state (Academy workspace).
   Kept small and separate so their behaviour is tested on its own. */
import React, { useRef, useState } from "react";
import { BusyButton } from "./loading.jsx";
import { isOfflineError } from "./useOnline.js";
import { createDefaultCategories, retryCategoryReads } from "./academyData.js";

/* Create the starter categories: "Creating categories…" while the server
   commits (repeat presses ignored); a failure stays beside the button with
   Try again; success is reported only after the server confirmed the write
   (the category list then replaces this control). */
export function StarterCategoriesSetup({ me, onCreated, create = createDefaultCategories }) {
  const [st, setSt] = useState({ busy: false, error: "" });
  const busy = useRef(false);
  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    setSt({ busy: true, error: "" });
    try {
      const res = await create(me);
      busy.current = false;
      setSt({ busy: false, error: "" });
      onCreated && onCreated(res);
    } catch (e) {
      busy.current = false;
      const msg = isOfflineError(e) || e?.code === "unavailable" || e?.code === "failed-precondition"
        ? "You're offline or the connection dropped, so no categories were created. Reconnect, then try again."
        : e?.code === "permission-denied"
          ? "The server refused the change: only an admin can create categories. Nothing was created."
          : "Couldn't create the categories, and nothing was changed. Please try again.";
      setSt({ busy: false, error: msg });
    }
  };
  return (
    <div className="ac-setup">
      <BusyButton className="sb-btn compact" busy={st.busy} busyLabel="Creating categories…" onClick={run} aria-describedby={st.error ? "ac-setup-err" : undefined}>
        {st.error ? "Try again" : "Create the starter categories"}
      </BusyButton>
      {st.error && <p className="ac-err" id="ac-setup-err" role="alert">{st.error}</p>}
    </div>
  );
}
/* A failed category read: say so (never "no categories") and offer a retry. */
export function CategoryReadError() {
  return (
    <div className="sb-empty" role="alert">
      <p>Couldn't load the Academy's categories. Check your connection, then try again.</p>
      <button type="button" className="sb-btn compact" onClick={retryCategoryReads}>Try again</button>
    </div>
  );
}
