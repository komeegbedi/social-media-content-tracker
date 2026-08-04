/* Interaction tests for the Administrative-override "Correct workflow status" flow.
   Run: npm run test:ui  (vitest + jsdom + Testing Library) */
import { useState, useRef, useEffect } from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminOverrideDialog from "./AdminOverrideDialog.jsx";
import { canAdminOverride, STAGES } from "./data.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* A minimal confirmation that mirrors the real ConfirmDialog contract: shows the
   structured summary, focuses Cancel first, guards duplicate submits, and stays open
   (with an error) on failure. */
function MiniConfirm({ current, to, reason, requestedChanges, onConfirm, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  const confirm = async () => {
    if (busy) return;
    setBusy(true); setErr("");
    try { await onConfirm(); } catch (e) { setBusy(false); setErr(e?.message || "error"); }
  };
  return (
    <div role="alertdialog" aria-label="Confirm status correction">
      <p>{`This will move from “${current}” to “${to}”.`}</p>
      <ul>
        <li>{`Current status: ${current}`}</li>
        <li>{`New status: ${to}`}</li>
        {requestedChanges ? <li>{`What needs to change: ${requestedChanges}`}</li> : null}
        <li>{`Reason for administrative override: ${reason}`}</li>
      </ul>
      {err && <div role="alert">{err}</div>}
      <button ref={cancelRef} onClick={onCancel} disabled={busy}>Cancel</button>
      <button onClick={confirm} disabled={busy}>{busy ? "Applying…" : "Confirm correction"}</button>
    </div>
  );
}

/* Mirrors TaskDetail's Admin-controls wiring: the entry point gated by
   canAdminOverride, the focused dialog, and the confirmation step. */
function AdminControlsHarness({ me, task, onOverride }) {
  const [showOverride, setShowOverride] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [rc, setRc] = useState("");
  const canOverride = canAdminOverride(me);
  const isCR = to === "Changes Requested";
  const close = () => { setShowOverride(false); setConfirming(false); setTo(""); setReason(""); setRc(""); };
  return (
    <div>
      {canOverride && (
        <>
          <button>Edit details</button>
          <button>Duplicate</button>
          <button className="entry" aria-haspopup="dialog" aria-expanded={showOverride}
            onClick={() => setShowOverride(true)}>Correct workflow status</button>
          <div data-testid="danger-zone">
            <span>Danger zone</span>
            <button>Delete content</button>
          </div>
        </>
      )}
      {showOverride && !confirming && (
        <AdminOverrideDialog task={task} to={to} setTo={setTo} reason={reason} setReason={setReason}
          requestedChanges={rc} setRequestedChanges={setRc}
          onReview={() => setConfirming(true)} onClose={close} />
      )}
      {showOverride && confirming && (
        <MiniConfirm current={task.status} to={to} reason={reason.trim()} requestedChanges={isCR ? rc.trim() : ""}
          onConfirm={async () => { await onOverride({ toStatus: to, reason: reason.trim(), requestedChanges: isCR ? rc.trim() : undefined }); close(); }}
          onCancel={() => setConfirming(false)} />
      )}
    </div>
  );
}

const task = { title: "Sunday Reel", status: "In Review" };
const entry = () => screen.queryByRole("button", { name: /correct workflow status/i });
const reviewBtn = () => screen.getByRole("button", { name: /review correction/i });

describe("AdminOverrideDialog — the focused correction dialog", () => {
  const Controlled = ({ onReview = vi.fn(), onClose = vi.fn() }) => {
    const [to, setTo] = useState("");
    const [reason, setReason] = useState("");
    const [rc, setRc] = useState("");
    return <AdminOverrideDialog task={task} to={to} setTo={setTo} reason={reason} setReason={setReason}
      requestedChanges={rc} setRequestedChanges={setRc} onReview={onReview} onClose={onClose} />;
  };
  const whatChanges = () => screen.queryByRole("textbox", { name: /what needs to change/i });

  test("shows current status (read-only), destination + reason fields, and explanatory copy", () => {
    render(<Controlled />);
    const dialog = screen.getByRole("dialog", { name: /correct workflow status/i });
    expect(within(dialog).getByText("Current status")).toBeInTheDocument();
    expect(within(dialog).getByText("In Review")).toBeInTheDocument();          // the current value
    expect(within(dialog).getByRole("combobox", { name: /move to/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: /reason for administrative override/i })).toBeInTheDocument();
    expect(within(dialog).getByText(/bypasses the normal workflow/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/administrative audit log/i)).toBeInTheDocument(); // helper text, not placeholder
  });

  test("Review is disabled until a destination AND a non-empty reason are supplied", async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    render(<Controlled onReview={onReview} />);
    expect(reviewBtn()).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: /move to/i }), "Approved");
    expect(reviewBtn()).toBeDisabled();                                          // still no reason
    await user.type(screen.getByRole("textbox", { name: /reason for administrative override/i }), "   ");
    expect(reviewBtn()).toBeDisabled();                                          // whitespace-only
    await user.type(screen.getByRole("textbox", { name: /reason for administrative override/i }), "Wrong stage");
    expect(reviewBtn()).toBeEnabled();
    await user.click(reviewBtn());
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  test("the destination selector excludes the current status", () => {
    render(<Controlled />);
    const opts = within(screen.getByRole("combobox", { name: /move to/i })).getAllByRole("option").map((o) => o.textContent);
    expect(opts).not.toContain("In Review");
    expect(opts).toContain("Approved");
  });

  test("Cancel closes without reviewing; Escape also cancels", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Controlled onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("focus starts in the field (not on a submit button)", async () => {
    render(<Controlled />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: /move to/i })).toHaveFocus());
  });

  test("'What needs to change?' appears ONLY when the destination is Changes Requested", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    expect(whatChanges()).not.toBeInTheDocument();                              // no destination yet
    await user.selectOptions(screen.getByRole("combobox", { name: /move to/i }), "Approved");
    expect(whatChanges()).not.toBeInTheDocument();                              // other destination
    await user.selectOptions(screen.getByRole("combobox", { name: /move to/i }), "Changes Requested");
    const field = whatChanges();
    expect(field).toBeInTheDocument();
    // Persistent label + helper (not placeholder-only), and multiline.
    expect(screen.getByText(/clear, actionable instructions/i)).toBeInTheDocument();
    expect(field.tagName).toBe("TEXTAREA");
    expect(field).toHaveAttribute("maxlength", "2000");
  });

  test("Changes Requested requires BOTH the revision instructions AND the override reason", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.selectOptions(screen.getByRole("combobox", { name: /move to/i }), "Changes Requested");
    await user.type(screen.getByRole("textbox", { name: /reason for administrative override/i }), "Reviewer unavailable");
    expect(reviewBtn()).toBeDisabled();                                         // reason only — still blocked
    await user.type(whatChanges(), "   ");
    expect(reviewBtn()).toBeDisabled();                                         // whitespace-only instructions
    await user.type(whatChanges(), "Shorten the opening to 3s.");
    expect(reviewBtn()).toBeEnabled();                                          // both present
  });
});

describe("AdminOverrideDialog — no-op (same-status) prevention", () => {
  const noop = () => {};
  const dialogFor = (status) => (
    <AdminOverrideDialog task={{ title: "T", status }} to="" setTo={noop} reason="" setReason={noop}
      requestedChanges="" setRequestedChanges={noop} onReview={noop} onClose={noop} />
  );

  test("the current status is ABSENT from the destination selector — for EVERY status", () => {
    for (const status of STAGES) {
      const { unmount } = render(dialogFor(status));
      const opts = within(screen.getByRole("combobox", { name: /move to/i })).getAllByRole("option").map((o) => o.textContent);
      expect(opts).not.toContain(status);                                       // e.g. Changes Requested can't pick Changes Requested
      expect(opts).toContain("Select the correct status");                      // placeholder stays
      for (const other of STAGES.filter((s) => s !== status)) expect(opts).toContain(other);
      unmount();
    }
  });

  test("Review stays disabled without a different destination", async () => {
    const user = userEvent.setup();
    function W() {
      const [reason, setReason] = useState("");
      return <AdminOverrideDialog task={{ title: "T", status: "In Review" }} to="" setTo={() => {}}
        reason={reason} setReason={setReason} requestedChanges="" setRequestedChanges={() => {}}
        onReview={() => {}} onClose={() => {}} />;
    }
    render(<W />);
    expect(reviewBtn()).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: /reason for administrative override/i }), "a reason");
    expect(reviewBtn()).toBeDisabled();                                         // reason but no destination
  });

  test("a task update that makes the selected destination current invalidates the form", async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    function Wrap() {
      const [status, setStatus] = useState("In Review");
      const [to, setTo] = useState("");
      const [reason, setReason] = useState("");
      return (
        <>
          <button onClick={() => setStatus("Approved")}>race</button>
          <AdminOverrideDialog task={{ title: "T", status }} to={to} setTo={setTo} reason={reason} setReason={setReason}
            requestedChanges="" setRequestedChanges={() => {}} onReview={onReview} onClose={() => {}} />
        </>
      );
    }
    render(<Wrap />);
    await user.selectOptions(screen.getByRole("combobox", { name: /move to/i }), "Approved");
    await user.type(screen.getByRole("textbox", { name: /reason for administrative override/i }), "some reason");
    expect(reviewBtn()).toBeEnabled();
    // Another process moves the task to the selected destination.
    await user.click(screen.getByRole("button", { name: /race/i }));
    expect(screen.getByRole("combobox", { name: /move to/i })).toHaveValue("");  // stale selection cleared
    expect(reviewBtn()).toBeDisabled();
    expect(screen.getByText(/choose a status different from the current status/i)).toBeInTheDocument();
    expect(onReview).not.toHaveBeenCalled();                                     // never opens confirmation for a no-op
  });

  test("stale selection equal to the current status self-heals and can't open confirmation", async () => {
    const onReview = vi.fn();
    function Wrap() {
      const [to, setTo] = useState("In Review");                                // stale: equals current status
      return (
        <AdminOverrideDialog task={{ title: "T", status: "In Review" }} to={to} setTo={setTo}
          reason="has a reason" setReason={() => {}} requestedChanges="" setRequestedChanges={() => {}}
          onReview={onReview} onClose={() => {}} />
      );
    }
    render(<Wrap />);
    await waitFor(() => expect(screen.getByText(/choose a status different from the current status/i)).toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: /move to/i })).toHaveValue("");
    expect(reviewBtn()).toBeDisabled();
    expect(onReview).not.toHaveBeenCalled();
  });
});

describe("Admin-controls flow — entry point, ordering, and full correction", () => {
  const admin = { role: "admin", qa: false, status: "approved" };
  const member = { role: "member", qa: false, status: "approved" };

  test("the entry point is visible to Admins and absent for non-Admins", () => {
    const { unmount } = render(<AdminControlsHarness me={admin} task={task} onOverride={vi.fn()} />);
    expect(entry()).toBeInTheDocument();
    unmount();
    render(<AdminControlsHarness me={member} task={task} onOverride={vi.fn()} />);
    expect(entry()).not.toBeInTheDocument();
  });

  test("the entry point appears BEFORE the Danger zone", () => {
    render(<AdminControlsHarness me={admin} task={task} onOverride={vi.fn()} />);
    const e = entry();
    const danger = screen.getByTestId("danger-zone");
    // Node.DOCUMENT_POSITION_FOLLOWING (4) => danger comes after the entry point.
    expect(e.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("opening the entry point reveals the focused dialog with the correction fields", async () => {
    const user = userEvent.setup();
    render(<AdminControlsHarness me={admin} task={task} onOverride={vi.fn()} />);
    await user.click(entry());
    const dialog = screen.getByRole("dialog", { name: /correct workflow status/i });
    expect(within(dialog).getByText("In Review")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: /move to/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: /reason for administrative override/i })).toBeInTheDocument();
  });

  test("Cancel preserves the task (no override) and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    const onOverride = vi.fn();
    render(<AdminControlsHarness me={admin} task={task} onOverride={onOverride} />);
    await user.click(entry());
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onOverride).not.toHaveBeenCalled();
    await waitFor(() => expect(entry()).toHaveFocus());
  });

  async function fillAndReview(user, { to = "Approved", reason = "Reshoot the intro." } = {}) {
    await user.click(entry());
    await user.selectOptions(screen.getByRole("combobox", { name: /move to/i }), to);
    await user.type(screen.getByRole("textbox", { name: /reason for administrative override/i }), reason);
    await user.click(reviewBtn());
  }

  test("confirmation shows the EXACT current status, destination, and reason", async () => {
    const user = userEvent.setup();
    render(<AdminControlsHarness me={admin} task={task} onOverride={vi.fn().mockResolvedValue()} />);
    await fillAndReview(user, { to: "Approved", reason: "Reviewer unavailable." });
    const dialog = screen.getByRole("alertdialog", { name: /confirm status correction/i });
    expect(within(dialog).getByText("Current status: In Review")).toBeInTheDocument();
    expect(within(dialog).getByText("New status: Approved")).toBeInTheDocument();
    expect(within(dialog).getByText("Reason for administrative override: Reviewer unavailable.")).toBeInTheDocument();
    // Non-CR destination shows no revision-instructions line.
    expect(within(dialog).queryByText(/what needs to change:/i)).not.toBeInTheDocument();
  });

  test("duplicate confirmation clicks cannot fire the override twice", async () => {
    const user = userEvent.setup();
    const d = deferred();
    const onOverride = vi.fn().mockReturnValue(d.promise);
    render(<AdminControlsHarness me={admin} task={task} onOverride={onOverride} />);
    await fillAndReview(user);
    const confirmBtn = screen.getByRole("button", { name: /confirm correction/i });
    await user.click(confirmBtn);
    expect(screen.getByRole("button", { name: /applying/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /applying/i })).catch(() => {});
    expect(onOverride).toHaveBeenCalledTimes(1);
    d.resolve();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  test("a FAILED override preserves the entered destination and reason", async () => {
    const user = userEvent.setup();
    const onOverride = vi.fn().mockRejectedValue(new Error("offline"));
    render(<AdminControlsHarness me={admin} task={task} onOverride={onOverride} />);
    await fillAndReview(user, { to: "Approved", reason: "Original reviewer left." });
    await user.click(screen.getByRole("button", { name: /confirm correction/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    // Cancel back to the dialog — the draft is intact.
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /^cancel$/i }));
    expect(screen.getByRole("combobox", { name: /move to/i })).toHaveValue("Approved");
    expect(screen.getByRole("textbox", { name: /reason for administrative override/i })).toHaveValue("Original reviewer left.");
  });

  test("a successful override closes the flow and clears its state", async () => {
    const user = userEvent.setup();
    const onOverride = vi.fn().mockResolvedValue();
    render(<AdminControlsHarness me={admin} task={task} onOverride={onOverride} />);
    await fillAndReview(user, { to: "Approved", reason: "Reshoot done." });
    await user.click(screen.getByRole("button", { name: /confirm correction/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onOverride).toHaveBeenCalledWith({ toStatus: "Approved", reason: "Reshoot done." });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Reopening starts empty (state cleared).
    await user.click(entry());
    expect(screen.getByRole("combobox", { name: /move to/i })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: /reason for administrative override/i })).toHaveValue("");
  });

  test("Changes Requested: confirmation shows the revision instructions + reason; override is called with requestedChanges", async () => {
    const user = userEvent.setup();
    const onOverride = vi.fn().mockResolvedValue();
    render(<AdminControlsHarness me={admin} task={task} onOverride={onOverride} />);
    await user.click(entry());
    await user.selectOptions(screen.getByRole("combobox", { name: /move to/i }), "Changes Requested");
    await user.type(screen.getByRole("textbox", { name: /what needs to change/i }), "Shorten the opening to 3s.");
    await user.type(screen.getByRole("textbox", { name: /reason for administrative override/i }), "Reviewer OOO.");
    await user.click(reviewBtn());
    const dialog = screen.getByRole("alertdialog", { name: /confirm status correction/i });
    expect(within(dialog).getByText("New status: Changes Requested")).toBeInTheDocument();
    expect(within(dialog).getByText("What needs to change: Shorten the opening to 3s.")).toBeInTheDocument();
    expect(within(dialog).getByText("Reason for administrative override: Reviewer OOO.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /confirm correction/i }));
    await waitFor(() => expect(onOverride).toHaveBeenCalled());
    expect(onOverride).toHaveBeenCalledWith({ toStatus: "Changes Requested", reason: "Reviewer OOO.", requestedChanges: "Shorten the opening to 3s." });
  });
});
