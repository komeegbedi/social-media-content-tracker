/* Startup orchestrator — success / failure / genuine retry / no duplicate attempts.
   Run: node --test src/bootstrap.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBootstrap } from "./bootstrap.js";

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
// An attempt whose outcome each call is scripted by `outcomes` (array of "ok"/"fail").
function scripted(outcomes) {
  let n = 0; const calls = () => n;
  const attempt = () => { const o = outcomes[Math.min(n, outcomes.length - 1)]; n++; return o === "ok" ? Promise.resolve() : Promise.reject(new Error("boom")); };
  return { attempt, calls };
}

test("success → mount once, no error screen", async () => {
  const { attempt, calls } = scripted(["ok"]);
  let mounts = 0, errors = 0;
  runBootstrap({ attempt, mount: () => mounts++, renderError: () => errors++ });
  await flush();
  assert.equal(mounts, 1); assert.equal(errors, 0); assert.equal(calls(), 1);
});

test("failure → error screen, no mount, sanitized onError fired", async () => {
  const { attempt } = scripted(["fail"]);
  let mounts = 0, errs = 0, onErr = 0;
  runBootstrap({ attempt, mount: () => mounts++, renderError: () => errs++, onError: () => onErr++ });
  await flush();
  assert.equal(mounts, 0); assert.equal(errs, 1); assert.equal(onErr, 1);
});

test("retry re-runs the attempt; a later success restores the app", async () => {
  const { attempt, calls } = scripted(["fail", "ok"]);   // 1st fails, 2nd (retry) succeeds
  let mounts = 0; let retry = null;
  runBootstrap({ attempt, mount: () => mounts++, renderError: (r) => { retry = r; } });
  await flush();
  assert.equal(mounts, 0); assert.equal(calls(), 1);
  retry();                                                // user clicks "Try again"
  await flush();
  assert.equal(mounts, 1, "app restored on the successful retry");
  assert.equal(calls(), 2);
});

test("overlapping retries cannot start a second attempt (no duplicate listeners)", async () => {
  let resolve; const attempt = () => new Promise((r) => { resolve = r; }); // never settles until we say
  let started = 0; const counting = () => { started++; return attempt(); };
  let retry = null; let mounts = 0;
  runBootstrap({ attempt: counting, mount: () => mounts++, renderError: (r) => { retry = r; } });
  await flush();
  assert.equal(started, 1, "one attempt in flight");
  // First attempt fails → renderError gives us retry; call it many times before it settles.
  resolve && resolve(Promise.reject(new Error("x"))); // settle the first as failure via thenable
  await flush();
  const before = started;
  retry(); retry(); retry();                 // hammer retry
  await flush();
  assert.ok(started <= before + 1, "at most one new attempt despite repeated retries");
});

test("after a successful mount, retry never re-mounts", async () => {
  const { attempt } = scripted(["ok"]);
  let mounts = 0; const { retry } = runBootstrap({ attempt, mount: () => mounts++, renderError: () => {} });
  await flush();
  retry(); retry();
  await flush();
  assert.equal(mounts, 1, "mount happens exactly once");
});
