/* Starter-category setup control and category read states.
   The write itself is proven against the real rules in
   test/academyBootstrap.rules.test.js; here the control's behaviour while the
   server is (or isn't) confirming. Run: npm run test:ui */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn(), reportIssue: vi.fn() }));
const retry = vi.fn();
vi.mock("./academyData.js", () => ({ createDefaultCategories: vi.fn(), retryCategoryReads: (...a) => retry(...a) }));

import { StarterCategoriesSetup, CategoryReadError } from "./academyCategorySetup.jsx";
import { categoryReadState } from "./academyBootstrap.js";

const me = { id: "admin", role: "admin", status: "approved" };
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const unhandled = [];
const onUnhandled = (e) => unhandled.push(e);
process.on("unhandledRejection", onUnhandled);
afterEach(() => { retry.mockReset(); });

describe("Create the starter categories", () => {
  test("while the server confirms: 'Creating categories…', repeat presses ignored, no success yet", async () => {
    const d = deferred(); const create = vi.fn(() => d.p); const onCreated = vi.fn();
    render(<StarterCategoriesSetup me={me} create={create} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "Create the starter categories" }));
    expect(screen.getByRole("button")).toHaveTextContent("Creating categories…");
    fireEvent.click(screen.getByRole("button")); fireEvent.click(screen.getByRole("button"));
    expect(create).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();                    // pending is not success
    await act(async () => { d.resolve({ created: ["photography"], existing: [] }); await d.p; });
    expect(onCreated).toHaveBeenCalledWith({ created: ["photography"], existing: [] });
  });

  test("a rejected write: an actionable message beside the control, Try again works, nothing unhandled", async () => {
    let n = 0;
    const create = vi.fn(() => (++n === 1 ? Promise.reject(Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" })) : Promise.resolve({ created: ["a"], existing: [] })));
    const onCreated = vi.fn();
    render(<StarterCategoriesSetup me={me} create={create} onCreated={onCreated} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create the starter categories" })); });
    expect(screen.getByRole("alert")).toHaveTextContent(/only an admin can create categories\. Nothing was created/i);
    expect(onCreated).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(create).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toEqual([]);
  });

  test("offline / dropped connection: says no categories were created and to reconnect", async () => {
    const create = vi.fn(() => Promise.reject(Object.assign(new Error("Failed to get document because the client is offline."), { code: "unavailable" })));
    render(<StarterCategoriesSetup me={me} create={create} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create the starter categories" })); });
    expect(screen.getByRole("alert")).toHaveTextContent(/no categories were created\. Reconnect, then try again/i);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
});

describe("category read states", () => {
  const ok = (docs) => ({ docs, loaded: true, error: null });
  const fail = { docs: [], loaded: true, error: Object.assign(new Error("offline"), { code: "unavailable" }) };
  test("a FAILED read is an error — never 'empty' (which would offer setup or show the starter set)", () => {
    expect(categoryReadState(fail, { loaded: true, error: null })).toBe("error");
    expect(categoryReadState(ok([]), { loaded: true, error: Object.assign(new Error("x"), { code: "unavailable" }) })).toBe("error");
    expect(categoryReadState({ docs: [], loaded: false, error: null }, { loaded: true })).toBe("loading");
    expect(categoryReadState(ok([]), { loaded: false })).toBe("loading");
    expect(categoryReadState(ok([]), { loaded: true, error: null })).toBe("empty");
    expect(categoryReadState(ok([{ id: "photography" }]), { loaded: true, error: null })).toBe("ready");
  });
  test("the read-error state offers Try again", () => {
    render(<CategoryReadError />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't load the Academy's categories/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
