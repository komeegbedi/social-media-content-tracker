/* Round 5 — Academy images never sit on a skeleton forever: a stuck Storage
   request times out into the branded fallback, the failure isn't cached (the
   next view retries), and loading / no-cover / failed / loaded are distinct. */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";

const st = vi.hoisted(() => ({ mode: "hang", calls: 0, paths: [], pending: {} }));
vi.mock("./firebase", () => ({
  db: {}, callFunction: vi.fn(),
  getStorageInstance: async () => ({}),
}));
vi.mock("firebase/storage", () => ({
  ref: (_s, p) => ({ p }),
  getBlob: (r) => {
    st.calls++; st.paths.push(r.p);
    if (st.mode === "manual") return new Promise((res) => { st.pending[r.p] = () => res(new Blob(["x"])); });
    return st.mode === "hang" ? new Promise(() => {}) : st.mode === "fail" ? Promise.reject(new Error("denied")) : Promise.resolve(new Blob(["x"]));
  },
}));
vi.mock("./logging", () => ({ logIssue: vi.fn(), reportIssue: vi.fn() }));

import { imageObjectUrl, _resetImageCacheForTests } from "./academyData.js";
import { clearAcademySession, cachedImageUrl } from "./academyCache.js";
import { CategoryArt, StoredImage } from "./academyShared.jsx";

const revoked = [];
beforeEach(() => { _resetImageCacheForTests(); st.calls = 0; st.paths = []; st.pending = {}; st.mode = "hang"; revoked.length = 0; globalThis.URL.createObjectURL = () => "blob:ok"; globalThis.URL.revokeObjectURL = (u) => revoked.push(u); });

describe("image loading never hangs", () => {
  test("a stuck request rejects with a timeout and is not cached (the next request tries again)", async () => {
    await expect(imageObjectUrl("academy/catCovers/x/a.png", { timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
    st.mode = "ok";
    await expect(imageObjectUrl("academy/catCovers/x/a.png", { timeoutMs: 30 })).resolves.toBe("blob:ok");
    expect(st.calls).toBe(2);
  });
  test("category cover: no cover → branded fallback; a cover → loading placeholder, then the image", async () => {
    const cat = { id: "photography", label: "Photography" };
    const { container, rerender } = render(<CategoryArt category={cat} imageRef={null} />);
    expect(container.querySelector("[data-img]").dataset.img).toBe("none");
    st.mode = "ok";
    rerender(<CategoryArt category={cat} imageRef={{ path: "academy/catCovers/photography/seed.png" }} />);
    await waitFor(() => expect(container.querySelector("[data-img]").dataset.img).toBe("loaded"));
  });
  test("a failed load shows the non-disruptive fallback, never an endless skeleton", async () => {
    st.mode = "fail";
    const { container } = render(<StoredImage imageRef={{ path: "academy/covers/c/v.jpg" }} ratio="3 / 4" />);
    expect(container.querySelector("[data-img]").dataset.img).toBe("loading");
    await waitFor(() => expect(container.querySelector("[data-img]").dataset.img).toBe("failed"));
    expect(container.querySelector(".sb-skel")).toBeNull();
  });
});

describe("round 8: the download queue and session changes", () => {
  test("a queued download for an image that left the screen is withdrawn (never fetched)", async () => {
    st.mode = "manual";
    const views = ["a", "b", "c", "d"].map((x) => render(<StoredImage imageRef={{ path: `academy/covers/q/${x}.jpg` }} ratio="3 / 4" />));
    await waitFor(() => expect(st.paths.length).toBe(4));               // 4 downloads at once
    const fifth = render(<StoredImage imageRef={{ path: "academy/covers/q/e.jpg" }} ratio="3 / 4" />);
    await new Promise((r) => setTimeout(r, 10));
    expect(st.paths).not.toContain("academy/covers/q/e.jpg");           // queued behind them
    fifth.unmount();                                                      // the learner moved on
    const sixth = render(<StoredImage imageRef={{ path: "academy/covers/q/f.jpg" }} ratio="3 / 4" />);
    st.pending["academy/covers/q/a.jpg"]();                               // a slot frees up
    await waitFor(() => expect(st.paths).toContain("academy/covers/q/f.jpg"));
    expect(st.paths).not.toContain("academy/covers/q/e.jpg");           // the withdrawn one never ran
    views.forEach((v) => v.unmount()); sixth.unmount();
  });
  test("a download that finishes after sign-out is discarded and revoked, never cached", async () => {
    st.mode = "manual";
    globalThis.URL.createObjectURL = () => "blob:late";
    const p = imageObjectUrl("academy/covers/q/late.jpg");
    await waitFor(() => expect(st.pending["academy/covers/q/late.jpg"]).toBeTypeOf("function"));
    clearAcademySession();                                               // sign-out / account change
    st.pending["academy/covers/q/late.jpg"]();                           // the old session's response arrives
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    expect(cachedImageUrl("academy/covers/q/late.jpg")).toBeNull();
    expect(revoked).toContain("blob:late");
  });
});
