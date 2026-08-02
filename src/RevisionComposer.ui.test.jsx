/* Real interaction tests for the QA "Request changes" revision composer.
   Run with: npm run test:ui  (vitest + jsdom + Testing Library) */
import { useState } from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RevisionComposer from "./RevisionComposer.jsx";
import { approveGate } from "./data.js";

// A never-resolving promise + its resolve/reject handles — to hold a send "in flight".
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const composer = () => screen.getByRole("textbox", { name: /what needs to change/i });
const sendBtn = () => screen.getByRole("button", { name: /send revision request|sending/i });

describe("RevisionComposer", () => {
  test("reveal moves focus into the composer", async () => {
    render(<RevisionComposer onSend={vi.fn()} />);
    await waitFor(() => expect(composer()).toHaveFocus());
  });

  test("blank / whitespace-only cannot be submitted", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<RevisionComposer onSend={onSend} />);
    expect(sendBtn()).toBeDisabled();                 // empty
    await user.type(composer(), "   \n  ");           // whitespace only
    expect(sendBtn()).toBeDisabled();
    await user.click(sendBtn());
    expect(onSend).not.toHaveBeenCalled();
  });

  test("Return inserts a newline and never submits", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<RevisionComposer onSend={onSend} />);
    await user.type(composer(), "line one{Enter}line two");
    expect(composer()).toHaveValue("line one\nline two");
    expect(onSend).not.toHaveBeenCalled();            // Enter did not send
  });

  test("multiline content is sent exactly (trimmed), then the draft clears", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onSent = vi.fn();
    render(<RevisionComposer onSend={onSend} onSent={onSent} />);
    await user.type(composer(), "  Fix the hook.{Enter}{Enter}Swap image two.  ");
    await user.click(sendBtn());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("Fix the hook.\n\nSwap image two.");
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(composer()).toHaveValue("");               // cleared only on success
  });

  test("a failed send KEEPS the draft and surfaces an error", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockRejectedValue(new Error("offline"));
    render(<RevisionComposer onSend={onSend} />);
    await user.type(composer(), "Please tighten the caption.");
    await user.click(sendBtn());
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(composer()).toHaveValue("Please tighten the caption."); // draft retained
    expect(sendBtn()).toBeEnabled();                               // can retry
  });

  test("repeated taps cannot fire duplicate sends", async () => {
    const user = userEvent.setup();
    const d = deferred();
    const onSend = vi.fn().mockReturnValue(d.promise);            // stays in flight
    render(<RevisionComposer onSend={onSend} />);
    await user.type(composer(), "Needs a stronger CTA.");
    await user.click(sendBtn());
    // Now in flight: button reads "Sending…" and is disabled.
    expect(sendBtn()).toBeDisabled();
    expect(sendBtn()).toHaveTextContent(/sending/i);
    await user.click(sendBtn()).catch(() => {});                  // second tap (on disabled) is a no-op
    expect(onSend).toHaveBeenCalledTimes(1);
    d.resolve();
    await waitFor(() => expect(sendBtn()).toHaveTextContent(/send revision request/i)); // flush in-flight resolution
  });

  test("enforces the 2,000-char backend cap on the field", () => {
    render(<RevisionComposer onSend={vi.fn()} />);
    expect(composer()).toHaveAttribute("maxlength", "2000");
  });

  test("reports dirty + sending state to the parent", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    const onSendingChange = vi.fn();
    const d = deferred();
    render(<RevisionComposer onSend={() => d.promise} onDirtyChange={onDirtyChange} onSendingChange={onSendingChange} />);
    await user.type(composer(), "x");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await user.click(sendBtn());
    expect(onSendingChange).toHaveBeenLastCalledWith(true);
    d.resolve();
    await waitFor(() => expect(onSendingChange).toHaveBeenLastCalledWith(false));
  });
});

// Mirrors TaskDetail's real wiring (approveGate + composer dirty reporting) to
// exercise "Approve while an unsent draft exists".
function QaPanelHarness({ onSend }) {
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [approved, setApproved] = useState(0);
  const draftDirty = open && dirty;
  const approve = () => {
    const g = approveGate({ dirty: draftDirty, sending });
    if (g === "sending") return;
    if (g === "confirm-discard") { setConfirmApprove(true); return; }
    setApproved((n) => n + 1);
  };
  return (
    <div>
      <button onClick={approve} disabled={sending}>Approve</button>
      <button onClick={() => setOpen((v) => !v)}>Request changes</button>
      {open && <RevisionComposer onSend={onSend} onSent={() => setOpen(false)} onDirtyChange={setDirty} onSendingChange={setSending} />}
      {confirmApprove && (
        <div role="dialog" aria-label="confirm approve">
          <button onClick={() => { setOpen(false); setConfirmApprove(false); setApproved((n) => n + 1); }}>Discard &amp; approve</button>
          <button onClick={() => setConfirmApprove(false)}>Keep writing</button>
        </div>
      )}
      <span data-testid="approved">{approved}</span>
    </div>
  );
}

describe("QA panel — Approve with an unsent draft", () => {
  test("Approve with a draft asks before discarding, then approves", async () => {
    const user = userEvent.setup();
    render(<QaPanelHarness onSend={vi.fn().mockResolvedValue(undefined)} />);
    await user.click(screen.getByRole("button", { name: /request changes/i }));
    await user.type(composer(), "Reshoot the intro.");
    await user.click(screen.getByRole("button", { name: /^approve$/i }));
    // Not approved yet — a confirmation appears instead.
    const dialog = screen.getByRole("dialog", { name: /confirm approve/i });
    expect(screen.getByTestId("approved")).toHaveTextContent("0");
    await user.click(within(dialog).getByRole("button", { name: /discard & approve/i }));
    expect(screen.getByTestId("approved")).toHaveTextContent("1");
    expect(screen.queryByRole("textbox", { name: /what needs to change/i })).not.toBeInTheDocument();
  });

  test("Approve with no draft approves immediately", async () => {
    const user = userEvent.setup();
    render(<QaPanelHarness onSend={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(screen.getByTestId("approved")).toHaveTextContent("1");
  });
});
