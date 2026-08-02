/* Interaction tests for the Administrative-override "Correct workflow status" flow.
   Run: npm run test:ui  (vitest + jsdom + Testing Library) */
import { useState, useRef, useEffect } from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminOverrideDialog from "./AdminOverrideDialog.jsx";
import { canAdminOverride } from "./data.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* A minimal confirmation that mirrors the real ConfirmDialog contract: shows the
   structured summary, focuses Cancel first, guards duplicate submits, and stays open
   (with an error) on failure. */
function MiniConfirm({ current, to, reason, onConfirm, onCancel }) {
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
        <li>{`Reason: ${reason}`}</li>
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
  const canOverride = canAdminOverride(me);
  const close = () => { setShowOverride(false); setConfirming(false); setTo(""); setReason(""); };
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
          onReview={() => setConfirming(true)} onClose={close} />
      )}
      {showOverride && confirming && (
        <MiniConfirm current={task.status} to={to} reason={reason.trim()}
          onConfirm={async () => { await onOverride({ toStatus: to, reason: reason.trim() }); close(); }}
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
    return <AdminOverrideDialog task={task} to={to} setTo={setTo} reason={reason} setReason={setReason} onReview={onReview} onClose={onClose} />;
  };

  test("shows current status (read-only), destination + reason fields, and explanatory copy", () => {
    render(<Controlled />);
    const dialog = screen.getByRole("dialog", { name: /correct workflow status/i });
    expect(within(dialog).getByText("Current status")).toBeInTheDocument();
    expect(within(dialog).getByText("In Review")).toBeInTheDocument();          // the current value
    expect(within(dialog).getByRole("combobox", { name: /move to/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: /reason for correction/i })).toBeInTheDocument();
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
    await user.type(screen.getByRole("textbox", { name: /reason for correction/i }), "   ");
    expect(reviewBtn()).toBeDisabled();                                          // whitespace-only
    await user.type(screen.getByRole("textbox", { name: /reason for correction/i }), "Wrong stage");
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
    expect(within(dialog).getByRole("textbox", { name: /reason for correction/i })).toBeInTheDocument();
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
    await user.type(screen.getByRole("textbox", { name: /reason for correction/i }), reason);
    await user.click(reviewBtn());
  }

  test("confirmation shows the EXACT current status, destination, and reason", async () => {
    const user = userEvent.setup();
    render(<AdminControlsHarness me={admin} task={task} onOverride={vi.fn().mockResolvedValue()} />);
    await fillAndReview(user, { to: "Approved", reason: "Reviewer unavailable." });
    const dialog = screen.getByRole("alertdialog", { name: /confirm status correction/i });
    expect(within(dialog).getByText("Current status: In Review")).toBeInTheDocument();
    expect(within(dialog).getByText("New status: Approved")).toBeInTheDocument();
    expect(within(dialog).getByText("Reason: Reviewer unavailable.")).toBeInTheDocument();
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
    expect(screen.getByRole("textbox", { name: /reason for correction/i })).toHaveValue("Original reviewer left.");
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
    expect(screen.getByRole("textbox", { name: /reason for correction/i })).toHaveValue("");
  });
});
