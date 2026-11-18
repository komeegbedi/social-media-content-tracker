/* useSharedDocs: the Continue card's lesson documents through the shared,
   lingering subscriptions — one listener per document, an instant warm
   revisit, and NOTHING carried across a sign-out / account switch.
   The Firestore SDK is mocked: every onSnapshot call is recorded and driven
   by the test. Run: npm run test:ui */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";

const listeners = [];   // { path, next, error, closed }
vi.mock("firebase/firestore", () => ({
  doc: (_db, path) => ({ path }),
  onSnapshot: (ref, _opts, next, error) => { const l = { path: ref.path, next, error, closed: false }; listeners.push(l); return () => { l.closed = true; }; },
}));
vi.mock("./firebase", () => ({ db: {}, callFunction: vi.fn(), getStorageInstance: vi.fn() }));
vi.mock("./logging", () => ({ logIssue: vi.fn(), reportIssue: vi.fn() }));

import { useSharedDocs } from "./academyData.js";
import { clearAcademySession } from "./academyCache.js";

const snap = (path, data) => ({ exists: () => data != null, id: path.split("/").pop(), data: () => data, metadata: { hasPendingWrites: false } });
const open = (path) => listeners.filter((l) => l.path === path && !l.closed);
function Reader({ paths, label = "r" }) {
  const { byPath, loaded } = useSharedDocs(paths);
  return <div data-testid={label}>{loaded ? paths.map((p) => (byPath[p] ? byPath[p].title : byPath[p] === null ? "unavailable" : "?")).join(",") : "loading"}</div>;
}
const A = "courses/c1/lessons/l1", B = "courses/c2/lessons/l9";

beforeEach(() => { act(() => clearAcademySession()); listeners.length = 0; });

describe("useSharedDocs", () => {
  test("one listener per document for every reader; a missing or denied document reads as unavailable", () => {
    render(<><Reader paths={[A, B]} label="one" /><Reader paths={[A]} label="two" /></>);
    expect(open(A)).toHaveLength(1);
    expect(screen.getByTestId("one")).toHaveTextContent("loading");
    act(() => open(A)[0].next(snap(A, { title: "Lighting" })));
    expect(screen.getByTestId("two")).toHaveTextContent("Lighting");
    expect(screen.getByTestId("one")).toHaveTextContent("loading");      // B not known yet
    act(() => open(B)[0].error(Object.assign(new Error("denied"), { code: "permission-denied" })));
    expect(screen.getByTestId("one")).toHaveTextContent("Lighting,unavailable");
  });

  test("a revisit within the linger period renders at once, without a new listener", () => {
    const first = render(<Reader paths={[A]} />);
    act(() => open(A)[0].next(snap(A, { title: "Lighting" })));
    first.unmount();
    const before = listeners.length;
    render(<Reader paths={[A]} />);
    expect(screen.getByTestId("r")).toHaveTextContent("Lighting");
    expect(listeners.length).toBe(before);
  });

  test("sign-out / account switch: no earlier data is shown, the old listener closes, a late snapshot is ignored, and readers re-subscribe", () => {
    render(<Reader paths={[A]} />);
    const old = open(A)[0];
    act(() => old.next(snap(A, { title: "Previous user's lesson" })));
    expect(screen.getByTestId("r")).toHaveTextContent("Previous user's lesson");
    act(() => clearAcademySession());
    expect(old.closed).toBe(true);
    expect(screen.getByTestId("r")).toHaveTextContent("loading");
    act(() => old.next(snap(A, { title: "LATE from the old session" })));
    expect(screen.getByTestId("r")).toHaveTextContent("loading");
    const fresh = open(A);
    expect(fresh).toHaveLength(1);
    act(() => fresh[0].next(snap(A, { title: "New user's lesson" })));
    expect(screen.getByTestId("r")).toHaveTextContent("New user's lesson");
  });

  test("no paths: loaded at once with nothing to read", () => {
    render(<Reader paths={[]} />);
    expect(screen.getByTestId("r")).toHaveTextContent("");
    expect(listeners).toHaveLength(0);
  });
});
