/* Real interaction tests for the WhatsApp-style @mention composer.
   Run with: npm run test:ui  (vitest + jsdom + Testing Library) */
import { describe, test, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MentionComposer from "./MentionComposer.jsx";

const CANDIDATES = [
  { id: "ada", name: "Ada Admin", email: "ada@ifc.app" },
  { id: "bo", name: "Bo Crew", email: "bo@ifc.app" },
  { id: "olu", name: "OluwaTofunmi OlaTunde", email: "olu@ifc.app" },
  { id: "sam1", name: "Sam Lee", email: "sam1@ifc.app" },
  { id: "sam2", name: "Sam Lee", email: "sam2@ifc.app" },   // duplicate full name
];

const box = () => screen.getByRole("combobox");
const listbox = () => screen.queryByRole("listbox");
const setup = (props = {}) => {
  const onPost = vi.fn();
  render(<MentionComposer candidates={CANDIDATES} assigneeUids={[]} onPost={onPost} {...props} />);
  return { onPost, user: userEvent.setup() };
};

describe("MentionComposer typeahead", () => {
  test("typing @ immediately opens suggestions; typing filters by full name", async () => {
    const { user } = setup();
    await user.click(box());
    await user.type(box(), "@");
    expect(listbox()).toBeInTheDocument();
    // The group aliases and people are all offered on the bare "@".
    expect(within(listbox()).getByText("@all")).toBeInTheDocument();
    expect(within(listbox()).getByText("Ada Admin")).toBeInTheDocument();
    // Filter to a single person.
    await user.type(box(), "Oluwa");
    expect(within(listbox()).getByText("OluwaTofunmi OlaTunde")).toBeInTheDocument();
    expect(within(listbox()).queryByText("Ada Admin")).not.toBeInTheDocument();
  });

  test("keyboard: ArrowDown + Enter inserts the COMPLETE name (never a first name)", async () => {
    const { user } = setup();
    await user.type(box(), "hi @Oluwa");
    await user.keyboard("{ArrowDown}{Enter}");     // first (only) match
    expect(box()).toHaveValue("hi @OluwaTofunmi OlaTunde ");
    expect(listbox()).not.toBeInTheDocument();      // closes after selecting
  });

  test("mouse: clicking a suggestion inserts that user's full name", async () => {
    const { user } = setup();
    await user.type(box(), "@Bo");
    await user.click(within(listbox()).getByText("Bo Crew"));
    expect(box()).toHaveValue("@Bo Crew ");
  });

  test("Escape dismisses the list without inserting", async () => {
    const { user } = setup();
    await user.type(box(), "@Ada");
    expect(listbox()).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(listbox()).not.toBeInTheDocument();
    expect(box()).toHaveValue("@Ada");              // text untouched
  });

  test("inserts AT THE CARET, not appended at the end", async () => {
    const { user } = setup();
    await user.type(box(), "hi end");
    // Place the caret right after "hi " (index 3) — a mention starts at a boundary —
    // and type there; the completed token must splice into the MIDDLE, not the end.
    await user.type(box(), "@Bo", { initialSelectionStart: 3, initialSelectionEnd: 3 });
    await user.keyboard("{Enter}");
    expect(box()).toHaveValue("hi @Bo Crew end");
  });

  test("duplicate full names show disambiguating secondary info", async () => {
    const { user } = setup();
    await user.type(box(), "@Sam");
    const options = within(listbox()).getAllByRole("option");
    const samRows = options.filter((o) => o.textContent.includes("Sam Lee"));
    expect(samRows.length).toBe(2);
    expect(samRows.some((o) => o.textContent.includes("sam1@ifc.app"))).toBe(true);
    expect(samRows.some((o) => o.textContent.includes("sam2@ifc.app"))).toBe(true);
  });

  test("@to picks a matching user and inserts the complete name", async () => {
    // A composer whose roster includes a 'Tofunmi' — '@to' should surface it.
    const { user } = setup({ candidates: [...CANDIDATES, { id: "tof", name: "Tofunmi" }] });
    await user.type(box(), "@to");
    await user.click(within(listbox()).getByText("Tofunmi"));
    expect(box()).toHaveValue("@Tofunmi ");
  });
});

describe("MentionComposer posting + mention metadata", () => {
  test("posting sends the selected UID + exact name; author-facing text is trimmed", async () => {
    const { user, onPost } = setup();
    await user.type(box(), "@Ada");
    await user.click(within(listbox()).getByText("Ada Admin"));
    await user.type(box(), "please review  ");
    await user.click(screen.getByRole("button", { name: /post note/i }));
    expect(onPost).toHaveBeenCalledTimes(1);
    const [text, meta] = onPost.mock.calls[0];
    expect(text).toBe("@Ada Admin please review");
    expect(meta.mentions).toEqual(["ada"]);
    expect(meta.mentionNames).toEqual(["Ada Admin"]);
    expect(meta.mentionAll).toBe(false);
  });

  test("editing a selected mention out of the text drops it from the outgoing metadata", async () => {
    const { user, onPost } = setup();
    await user.type(box(), "@Ada");
    await user.click(within(listbox()).getByText("Ada Admin"));   // "@Ada Admin "
    // Delete the whole mention token with repeated backspaces.
    await user.type(box(), "{Backspace>11/}");                     // remove "@Ada Admin "
    await user.type(box(), "never mind");
    await user.click(screen.getByRole("button", { name: /post note/i }));
    const [text, meta] = onPost.mock.calls[0];
    expect(text).toBe("never mind");
    expect(meta.mentions).toEqual([]);                             // stale recipient removed
  });

  test("removing a mention chip strips the token and drops the recipient", async () => {
    const { user, onPost } = setup();
    await user.type(box(), "@Bo");
    await user.click(within(listbox()).getByText("Bo Crew"));
    await user.type(box(), "hello");
    await user.click(screen.getByRole("button", { name: /remove bo crew/i }));
    await user.click(screen.getByRole("button", { name: /post note/i }));
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentions).toEqual([]);
  });

  test("selecting @all sets the group flag on post", async () => {
    const { user, onPost } = setup();
    await user.type(box(), "@al");
    await user.click(within(listbox()).getByText("@all"));
    await user.type(box(), "standup now");
    await user.click(screen.getByRole("button", { name: /post note/i }));
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentionAll).toBe(true);
    expect(meta.mentions).toEqual([]);
  });
});
