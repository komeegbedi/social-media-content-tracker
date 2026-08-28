/* Interaction tests for the inline-token @mention composer.
   Run with: npm run test:ui  (vitest + jsdom + Testing Library) */
import { describe, test, expect, vi } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MentionComposer from "./MentionComposer.jsx";

const CANDIDATES = [
  { id: "ada", name: "Ada Admin", email: "ada@ifc.app" },
  { id: "bo", name: "Bo Crew", email: "bo@ifc.app" },
  { id: "olu", name: "OluwaTofunmi OlaTunde", email: "olu@ifc.app" },
  { id: "sam1", name: "Sam Lee", email: "sam1@ifc.app" },
  { id: "sam2", name: "Sam Lee", email: "sam2@ifc.app" },   // duplicate full name
  { id: "tof", name: "Tofunmi" },
];

const box = () => screen.getByRole("combobox");
const listbox = () => screen.queryByRole("listbox");
const postBtn = () => screen.getByRole("button", { name: /post note/i });
const setup = (props = {}) => {
  const onPost = vi.fn();
  const { container } = render(<MentionComposer candidates={CANDIDATES} assigneeUids={[]} onPost={onPost} {...props} />);
  return { onPost, user: userEvent.setup(), container };
};
// The visible green tokens painted in the overlay (the inline highlight).
const highlights = (c) => Array.from(c.querySelectorAll(".sb-mention-tag")).map((el) => el.textContent);
// Type a query and choose a suggestion by its visible label.
const pick = async (user, query, label) => { await user.type(box(), query); await user.click(within(listbox()).getByText(label)); };

describe("inline highlighting", () => {
  test("a selected full-name mention is highlighted inside the composer", async () => {
    const { user, container } = setup();
    await user.type(box(), "hi ");
    await pick(user, "@Oluwa", "OluwaTofunmi OlaTunde");
    expect(box()).toHaveValue("hi @OluwaTofunmi OlaTunde ");
    expect(highlights(container)).toEqual(["@OluwaTofunmi OlaTunde"]);   // whole token, one unit
  });

  test("a selected @all is highlighted inside the composer", async () => {
    const { user, container } = setup();
    await pick(user, "@al", "@all");
    expect(box()).toHaveValue("@all ");
    expect(highlights(container)).toEqual(["@all"]);
  });

  test("ordinary @text, emails, and @everyone are NOT highlighted", async () => {
    const { user, container } = setup();
    await user.type(box(), "email me@host.com then @everyone and @Nobody");
    expect(highlights(container)).toEqual([]);     // nothing was selected → nothing green
    expect(listbox()).not.toBeInTheDocument();     // @everyone offers no suggestion
  });

  test("text can be added before and after a mention without breaking the highlight", async () => {
    const { user, container } = setup();
    await pick(user, "@Bo", "Bo Crew");
    await user.type(box(), "please review");        // after
    await user.type(box(), "team ", { initialSelectionStart: 0, initialSelectionEnd: 0 }); // before
    expect(box()).toHaveValue("team @Bo Crew please review");
    expect(highlights(container)).toEqual(["@Bo Crew"]);
  });

  test("multiline text keeps the mention highlighted", async () => {
    const { user, container } = setup();
    await user.type(box(), "line one{Enter}");
    await pick(user, "@Bo", "Bo Crew");
    await user.type(box(), "done");
    expect(box().value).toContain("\n");
    expect(highlights(container)).toEqual(["@Bo Crew"]);
  });
});

describe("atomic tokens (deletion removes the whole mention + its metadata)", () => {
  test("Backspace from the END of a mention removes the complete token", async () => {
    const { user, container } = setup();
    await pick(user, "@Bo", "Bo Crew");             // "@Bo Crew " (len 9)
    await user.type(box(), "{Backspace}", { initialSelectionStart: 8, initialSelectionEnd: 8 }); // caret right after "Crew"
    expect(box()).toHaveValue("");
    expect(highlights(container)).toEqual([]);
  });

  test("Delete from the START of a mention removes the complete token", async () => {
    const { user } = setup();
    await pick(user, "@Bo", "Bo Crew");
    await user.type(box(), "{Delete}", { initialSelectionStart: 0, initialSelectionEnd: 0 });
    expect(box()).toHaveValue("");
  });

  test("deleting a character from INSIDE a mention removes the complete token", async () => {
    const { user } = setup();
    await user.type(box(), "hey ");
    await pick(user, "@Tof", "Tofunmi");            // "hey @Tofunmi "
    // Caret inside "@Tofunmi" (index 7, between 'f' and 'u'); Backspace.
    await user.type(box(), "{Backspace}", { initialSelectionStart: 7, initialSelectionEnd: 7 });
    expect(box()).toHaveValue("hey ");             // whole token + its space gone, "hey " intact
  });

  test("a partially overlapping selection removes the complete mention", async () => {
    const { user } = setup();
    await user.type(box(), "hi ");
    await pick(user, "@Bo", "Bo Crew");            // "hi @Bo Crew "
    await user.type(box(), "there");               // "hi @Bo Crew there"
    // Select from mid-token to mid-"there" and delete.
    await user.type(box(), "{Backspace}", { initialSelectionStart: 6, initialSelectionEnd: 14 });
    expect(box().value.includes("@Bo Crew")).toBe(false);  // the token is fully gone
  });

  test("removing a mention drops its UID from the outgoing metadata", async () => {
    const { user, onPost } = setup();
    await pick(user, "@Bo", "Bo Crew");
    await user.type(box(), "{Backspace}", { initialSelectionStart: 8, initialSelectionEnd: 8 });
    await user.type(box(), "never mind");
    await user.click(postBtn());
    const [text, meta] = onPost.mock.calls[0];
    expect(text).toBe("never mind");
    expect(meta.mentions).toEqual([]);
  });

  test("removing @all clears mentionAll on post", async () => {
    const { user, onPost } = setup();
    await pick(user, "@al", "@all");               // "@all " (len 5)
    await user.type(box(), "{Backspace}", { initialSelectionStart: 4, initialSelectionEnd: 4 });
    await user.type(box(), "standup");
    await user.click(postBtn());
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentionAll).toBe(false);
  });

  test("the caret lands at the former token start after deletion", async () => {
    const { user } = setup();
    await user.type(box(), "hey ");
    await pick(user, "@Bo", "Bo Crew");            // "hey @Bo Crew "
    await user.type(box(), "{Backspace}", { initialSelectionStart: 12, initialSelectionEnd: 12 });
    expect(box()).toHaveValue("hey ");
    expect(box().selectionStart).toBe(4);          // where the token began
  });
});

describe("typeahead + submission", () => {
  test("typing @ opens the list, filters by full name, ↑/↓ + Enter selects the full name", async () => {
    const { user } = setup();
    await user.type(box(), "@");
    expect(listbox()).toBeInTheDocument();
    expect(within(listbox()).getByText("@all")).toBeInTheDocument();
    await user.type(box(), "Oluwa");
    expect(within(listbox()).getByText("OluwaTofunmi OlaTunde")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(box()).toHaveValue("@OluwaTofunmi OlaTunde ");
    expect(listbox()).not.toBeInTheDocument();
  });

  test("Escape closes the list; duplicate names show disambiguating info", async () => {
    const { user } = setup();
    await user.type(box(), "@Sam");
    const sams = within(listbox()).getAllByRole("option").filter((o) => o.textContent.includes("Sam Lee"));
    expect(sams.length).toBe(2);
    expect(sams.some((o) => o.textContent.includes("sam1@ifc.app"))).toBe(true);
    await user.keyboard("{Escape}");
    expect(listbox()).not.toBeInTheDocument();
  });

  test("@to selects a matching user and inserts the complete name", async () => {
    const { user } = setup();
    await pick(user, "@to", "Tofunmi");
    expect(box()).toHaveValue("@Tofunmi ");
  });

  test("posting emits plain text + mention metadata (uid identity)", async () => {
    const { user, onPost } = setup();
    await pick(user, "@Ada", "Ada Admin");
    await user.type(box(), "please review  ");
    await user.click(postBtn());
    const [text, meta] = onPost.mock.calls[0];
    expect(text).toBe("@Ada Admin please review");
    expect(meta.mentions).toEqual(["ada"]);
    expect(meta.mentionNames).toEqual(["Ada Admin"]);
    expect(meta.mentionAll).toBe(false);
  });

  test("selecting @all emits mentionAll:true", async () => {
    const { user, onPost } = setup();
    await pick(user, "@al", "@all");
    await user.type(box(), "standup now");
    await user.click(postBtn());
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentionAll).toBe(true);
    expect(meta.mentions).toEqual([]);
  });
});

describe("@everyone stays unsupported", () => {
  test("the typeahead never offers @everyone", async () => {
    const { user } = setup();
    await user.type(box(), "@every");
    // No listbox at all (no candidate/group matches "every").
    expect(listbox()).not.toBeInTheDocument();
  });

  test("typing @everyone does not set mentionAll and is not highlighted", async () => {
    const { user, onPost, container } = setup();
    await user.type(box(), "@everyone please gather");
    expect(highlights(container)).toEqual([]);
    await user.click(postBtn());
    const [text, meta] = onPost.mock.calls[0];
    expect(text).toBe("@everyone please gather");
    expect(meta.mentionAll).toBe(false);
    expect(meta.mentions).toEqual([]);
  });

  test("pasting '@Person Name' does not create a recipient", async () => {
    const { user, onPost } = setup();
    await user.click(box());
    await user.paste("@Ada Admin hi");             // Ada is a real candidate, but pasted, not selected
    await user.click(postBtn());
    const [text, meta] = onPost.mock.calls[0];
    expect(text).toBe("@Ada Admin hi");
    expect(meta.mentions).toEqual([]);              // no silent recipient
  });
});

describe("selected-mention boundary (the separator-deletion bug)", () => {
  test("deleting the separator keeps @Tofunmi highlighted (hey stays ordinary) + UID persists", async () => {
    const { user, container, onPost } = setup();
    await pick(user, "@Tof", "Tofunmi");            // "@Tofunmi "
    await user.type(box(), "hey");                  // "@Tofunmi hey"
    // Delete ONLY the separator space (caret after it, index 9 → removes index 8).
    await user.type(box(), "{Backspace}", { initialSelectionStart: 9, initialSelectionEnd: 9 });
    expect(box()).toHaveValue("@Tofunmihey");
    expect(highlights(container)).toEqual(["@Tofunmi"]);   // exactly the token; "hey" not included
    await user.click(postBtn());
    const [text, meta] = onPost.mock.calls[0];
    expect(text).toBe("@Tofunmihey");
    expect(meta.mentions).toEqual(["tof"]);          // UID survives the separator deletion
    expect(meta.mentionRanges).toEqual([0, 8]);      // rendering positions of "@Tofunmi"
  });

  test("deleting the separator after @all keeps it highlighted and mentionAll:true", async () => {
    const { user, container, onPost } = setup();
    await pick(user, "@al", "@all");                 // "@all "
    await user.type(box(), "now");                   // "@all now"
    await user.type(box(), "{Backspace}", { initialSelectionStart: 5, initialSelectionEnd: 5 }); // remove the space
    expect(box()).toHaveValue("@allnow");
    expect(highlights(container)).toEqual(["@all"]);
    await user.click(postBtn());
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentionAll).toBe(true);
  });

  test("punctuation directly after a mention does not break it", async () => {
    const { user, container } = setup();
    await pick(user, "@Bo", "Bo Crew");              // "@Bo Crew "
    await user.type(box(), "!", { initialSelectionStart: 8, initialSelectionEnd: 8 }); // "@Bo Crew! "
    expect(highlights(container)).toEqual(["@Bo Crew"]);
  });

  test("edits before shift the token range; edits after leave it (both stay highlighted)", async () => {
    const { user, container, onPost } = setup();
    await pick(user, "@Bo", "Bo Crew");              // "@Bo Crew "
    await user.type(box(), "ok");                    // after → "@Bo Crew ok"
    await user.type(box(), "hi ", { initialSelectionStart: 0, initialSelectionEnd: 0 }); // before
    expect(box()).toHaveValue("hi @Bo Crew ok");
    expect(highlights(container)).toEqual(["@Bo Crew"]);
    await user.click(postBtn());
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentions).toEqual(["bo"]);
    expect(meta.mentionRanges).toEqual([3, 11]);     // shifted by "hi "
  });

  test("deleting a character INSIDE the token still removes the whole mention", async () => {
    const { user, container, onPost } = setup();
    await pick(user, "@Bo", "Bo Crew");
    await user.type(box(), "{Backspace}", { initialSelectionStart: 4, initialSelectionEnd: 4 }); // inside "@Bo Crew"
    expect(highlights(container)).toEqual([]);       // token gone
    await user.click(postBtn());                     // (only if there is text) — add some
  });

  test("multiple selected mentions keep identity when the space between them is removed", async () => {
    const { user, container, onPost } = setup();
    await pick(user, "@Bo", "Bo Crew");              // "@Bo Crew "
    await pick(user, "@Ada", "Ada Admin");           // "@Bo Crew @Ada Admin "
    await user.type(box(), "{Backspace}", { initialSelectionStart: 9, initialSelectionEnd: 9 }); // remove the middle space
    expect(box()).toHaveValue("@Bo Crew@Ada Admin ");
    expect(highlights(container)).toEqual(["@Bo Crew", "@Ada Admin"]);
    await user.click(postBtn());
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentions.sort()).toEqual(["ada", "bo"]);
  });

  test("manually typed '@Tofunmihey' stays inert (no highlight, no recipient)", async () => {
    const { user, container, onPost } = setup();
    await user.type(box(), "@Tofunmihey");           // typed, never selected
    expect(highlights(container)).toEqual([]);
    await user.click(postBtn());
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentions).toEqual([]);
  });
});

describe("atomic deletion across ALL edit paths (visible text + caret + metadata together)", () => {
  // Dispatch a raw beforeinput with NO preceding keydown — mimics a mobile virtual
  // keyboard, where Backspace never produces a keydown.
  const fireBeforeInput = async (el, inputType, data = null) =>
    act(async () => { el.dispatchEvent(new window.InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true })); });

  test("Backspace INSIDE a mention removes the whole visible token (value + caret + metadata)", async () => {
    const { user, container, onPost } = setup();
    await user.type(box(), "Hello ");
    await pick(user, "@Tof", "Tofunmi");              // "Hello @Tofunmi "
    await user.type(box(), "there");                  // "Hello @Tofunmi there"
    await user.type(box(), "{Backspace}", { initialSelectionStart: 9, initialSelectionEnd: 9 }); // inside the 'f'/'u'
    expect(box()).toHaveValue("Hello there");         // 1. visible text — full token gone
    expect(box().selectionStart).toBe(6);             // 2. caret at the former token start
    expect(highlights(container)).toEqual([]);
    await user.click(postBtn());
    const [text, meta] = onPost.mock.calls[0];        // 3. metadata
    expect(text).toBe("Hello there");
    expect(meta.mentions).toEqual([]);
    expect(meta.mentionRanges).toEqual([]);
  });

  test("Delete INSIDE a mention removes the whole visible token", async () => {
    const { user, container } = setup();
    await user.type(box(), "Hello ");
    await pick(user, "@Tof", "Tofunmi");              // "Hello @Tofunmi "
    await user.type(box(), "there");
    await user.type(box(), "{Delete}", { initialSelectionStart: 9, initialSelectionEnd: 9 });
    expect(box()).toHaveValue("Hello there");
    expect(highlights(container)).toEqual([]);
  });

  test("MOBILE: a beforeinput delete with NO keydown still removes the whole token", async () => {
    const { user, container } = setup();
    await pick(user, "@Tof", "Tofunmi");              // "@Tofunmi "
    await user.type(box(), "hi");                     // "@Tofunmi hi"
    const el = box();
    el.setSelectionRange(4, 4);                       // caret inside "@Tofunmi"
    await fireBeforeInput(el, "deleteContentBackward");
    expect(el).toHaveValue("hi");                     // whole token removed, not "@Tofnmi hi"
    expect(el.selectionStart).toBe(0);
    expect(highlights(container)).toEqual([]);
  });

  test("Cut over a selection intersecting a mention removes the whole token", async () => {
    const { user, container } = setup();
    await user.type(box(), "hi ");
    await pick(user, "@Bo", "Bo Crew");               // "hi @Bo Crew "
    const el = box();
    el.focus(); el.setSelectionRange(4, 7);           // selection inside the token ("Bo ")
    await user.cut();
    expect(el).toHaveValue("hi ");                    // the whole "@Bo Crew" (+ its space) is gone
    expect(highlights(container)).toEqual([]);
  });

  test("Paste over a selection intersecting a mention removes the token, then inserts", async () => {
    const { user, container, onPost } = setup();
    await pick(user, "@Bo", "Bo Crew");               // "@Bo Crew "
    const el = box();
    el.focus(); el.setSelectionRange(4, 7);           // partial selection inside the token
    await user.paste("XY");
    expect(el).toHaveValue("XY");                     // token removed, replacement inserted
    await user.click(postBtn());
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentions).toEqual([]);                // no stale recipient
  });

  test("Typing over a selection intersecting a mention removes the whole token first", async () => {
    const { user, container } = setup();
    await user.type(box(), "hi ");
    await pick(user, "@Bo", "Bo Crew");               // "hi @Bo Crew "
    const el = box();
    el.focus(); el.setSelectionRange(4, 9);           // spans into the token
    await user.keyboard("Z");                         // types over the selection
    expect(el.value.includes("@Bo Crew")).toBe(false);
    expect(highlights(container)).toEqual([]);
  });

  test("@all: Delete INSIDE removes the whole token and clears mentionAll", async () => {
    const { user, container, onPost } = setup();
    await pick(user, "@al", "@all");                  // "@all "
    await user.type(box(), "team");                   // "@all team"
    await user.type(box(), "{Backspace}", { initialSelectionStart: 2, initialSelectionEnd: 2 }); // inside "@all"
    expect(box()).toHaveValue("team");
    expect(box().selectionStart).toBe(0);
    expect(highlights(container)).toEqual([]);
    await user.click(postBtn());
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentionAll).toBe(false);
  });

  test("deleting ONLY the separator preserves the token, caret and metadata", async () => {
    const { user, container, onPost } = setup();
    await pick(user, "@Tof", "Tofunmi");              // "@Tofunmi "
    await user.type(box(), "hey");                    // "@Tofunmi hey"
    await user.type(box(), "{Backspace}", { initialSelectionStart: 9, initialSelectionEnd: 9 }); // remove the space only
    expect(box()).toHaveValue("@Tofunmihey");
    expect(box().selectionStart).toBe(8);             // caret where the space was
    expect(highlights(container)).toEqual(["@Tofunmi"]);
    await user.click(postBtn());
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentions).toEqual(["tof"]);
    expect(meta.mentionRanges).toEqual([0, 8]);
  });

  test("removing ONE of several mentions keeps the others correctly ranged", async () => {
    const { user, container, onPost } = setup();
    await pick(user, "@Bo", "Bo Crew");               // "@Bo Crew "
    await pick(user, "@Ada", "Ada Admin");            // "@Bo Crew @Ada Admin "
    // Delete the first token from inside it.
    await user.type(box(), "{Backspace}", { initialSelectionStart: 3, initialSelectionEnd: 3 });
    expect(box()).toHaveValue("@Ada Admin ");
    expect(highlights(container)).toEqual(["@Ada Admin"]);
    await user.click(postBtn());
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentions).toEqual(["ada"]);
    expect(meta.mentionRanges).toEqual([0, 10]);
  });

  test("a submitted comment never carries a stale recipient after removal", async () => {
    const { user, onPost } = setup();
    await pick(user, "@Bo", "Bo Crew");
    await pick(user, "@Ada", "Ada Admin");            // both selected
    // Remove Bo entirely.
    await user.type(box(), "{Backspace}", { initialSelectionStart: 4, initialSelectionEnd: 4 });
    await user.click(postBtn());
    const [, meta] = onPost.mock.calls[0];
    expect(meta.mentions).toEqual(["ada"]);           // only the surviving mention
  });
});

describe("layer structure (dark-mode visibility contract)", () => {
  test("wrapper owns the field; overlay holds ordinary text + green mentions beneath the textarea", async () => {
    const { user, container } = setup();
    await user.type(box(), "hi ");
    await pick(user, "@Bo", "Bo Crew");                // "hi @Bo Crew "
    await user.type(box(), "there");                   // ordinary text right after the mention
    const wrap = container.querySelector(".sb-mc-wrap");
    const overlay = container.querySelector(".sb-mc-overlay");
    const ta = container.querySelector("textarea.sb-mc-input");
    expect(wrap && overlay && ta).toBeTruthy();
    // The overlay lives inside the wrapper and precedes the textarea → it paints beneath.
    expect(wrap.contains(overlay)).toBe(true);
    expect(wrap.contains(ta)).toBe(true);
    expect(overlay.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The visible layer (overlay) carries BOTH the ordinary text and the green token…
    expect(overlay.textContent).toContain("hi ");
    expect(overlay.textContent).toContain("there");
    expect(overlay.querySelector(".sb-mention-tag").textContent).toBe("@Bo Crew");
    // …while the textarea (the interaction layer, aria-hidden overlay excluded) holds the value.
    expect(ta.value).toBe("hi @Bo Crew there");
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
  });

  test("the placeholder lives on the transparent textarea (visible when empty)", () => {
    const { container } = setup();
    const ta = container.querySelector("textarea.sb-mc-input");
    expect(ta.getAttribute("placeholder")).toBeTruthy();
    expect(ta.value).toBe("");
  });
});

describe("caret alignment model (styling adjustment must not change the value/selection/ranges)", () => {
  test("typing past a long mention keeps the caret at the true end and the token range intact", async () => {
    const { user, container, onPost } = setup();
    await pick(user, "@Oluwa", "OluwaTofunmi OlaTunde");   // "@OluwaTofunmi OlaTunde "
    await user.type(box(), "ffff3");                        // the reproduction shape
    const ta = box();
    expect(ta.value).toBe("@OluwaTofunmi OlaTunde ffff3");
    expect(ta.selectionStart).toBe(ta.value.length);        // caret at the real end of the value
    expect(highlights(container)).toEqual(["@OluwaTofunmi OlaTunde"]);   // still green, still one token
    // overlay carries the trailing ordinary text, separate from the token
    const overlay = container.querySelector(".sb-mc-overlay");
    expect(overlay.textContent).toContain("ffff3");
    await user.click(postBtn());
    const [text, meta] = onPost.mock.calls[0];
    expect(text).toBe("@OluwaTofunmi OlaTunde ffff3");
    expect(meta.mentions).toEqual(["olu"]);
    expect(meta.mentionRanges).toEqual([0, 22]);            // "@OluwaTofunmi OlaTunde" = 22 chars
  });
});
