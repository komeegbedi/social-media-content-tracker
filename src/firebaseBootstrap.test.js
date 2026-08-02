/* Deferred-Firebase bootstrap helpers — pure.
   Run with: node --test src/firebaseBootstrap.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  memoizeImport, appCheckPlan, bootstrapFirebase, pushAvailability, foregroundSubscription, pushEnabled,
} from "./firebaseBootstrap.js";

// (bootstrapFirebase tests below assert App-Check-init-before-service-construction,
//  fail-closed on hard failure, and a soft first-token blip.)

const tick = () => new Promise((r) => setTimeout(r, 0));

/* ---- memoizeImport (callable + messaging chunk loading) ---- */

test("memoizeImport calls the loader once on success and shares it", async () => {
  let calls = 0;
  const get = memoizeImport(async () => { calls++; return { v: calls }; });
  const [a, b] = await Promise.all([get(), get()]);   // concurrent → shared
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal((await get()).v, 1);                   // still cached
});

test("memoizeImport does NOT cache a rejection — a retry re-imports", async () => {
  let calls = 0;
  const get = memoizeImport(async () => { calls++; if (calls === 1) throw new Error("offline"); return "ok"; });
  await assert.rejects(get(), /offline/);
  assert.equal(await get(), "ok");                    // retry succeeds
  assert.equal(calls, 2);
});

/* ---- App Check plan + ordering (attestation before access) ---- */

test("appCheckPlan: skip without a window, on the emulator, or with no key; init otherwise", () => {
  assert.equal(appCheckPlan({ hasWindow: false, key: "k" }).reason, "no-window");
  assert.equal(appCheckPlan({ hasWindow: true, useEmulator: true, key: "k" }).reason, "emulator");
  assert.equal(appCheckPlan({ hasWindow: true, key: "" }).reason, "no-key");
  assert.deepEqual(appCheckPlan({ hasWindow: true, key: "k" }), { init: true, debug: false });
  assert.equal(appCheckPlan({ hasWindow: true, key: "k", debug: true }).debug, true);
});

test("bootstrapFirebase: with nothing to attest, it just constructs services", async () => {
  const order = [];
  await bootstrapFirebase({ init: false, reason: "no-key" }, { constructServices: () => order.push("services") });
  assert.deepEqual(order, ["services"]);
});

test("bootstrapFirebase: Auth/Firestore are constructed ONLY AFTER App Check init", async () => {
  const order = [];
  await bootstrapFirebase({ init: true, debug: false }, {
    setDebug: () => order.push("debug"),
    loadAppCheck: async () => { order.push("load"); return { m: 1 }; },
    initAppCheck: (m) => { order.push("init"); assert.deepEqual(m, { m: 1 }); return { ac: 1 }; },
    firstToken: async (m, ac) => { order.push("token"); assert.deepEqual(ac, { ac: 1 }); },
    constructServices: () => order.push("services"),
  });
  assert.deepEqual(order, ["load", "init", "token", "services"]); // no debug unless asked
  assert.ok(order.indexOf("services") > order.indexOf("init"), "getAuth/initializeFirestore run after App Check init");
});

test("bootstrapFirebase sets a debug token only when requested", async () => {
  const order = [];
  await bootstrapFirebase({ init: true, debug: true }, {
    setDebug: () => order.push("debug"), loadAppCheck: async () => ({}), initAppCheck: () => ({}),
    firstToken: async () => {}, constructServices: () => order.push("services"),
  });
  assert.deepEqual(order, ["debug", "services"]);
});

test("bootstrapFirebase FAILS CLOSED: an App Check load/init failure never constructs services", async () => {
  let built = false;
  await assert.rejects(bootstrapFirebase({ init: true }, {
    loadAppCheck: async () => { throw new Error("chunk 404"); }, constructServices: () => { built = true; },
  }), /chunk 404/);
  assert.equal(built, false, "Auth/Firestore not constructed when App Check can't load");

  built = false;
  await assert.rejects(bootstrapFirebase({ init: true }, {
    loadAppCheck: async () => ({}), initAppCheck: () => { throw new Error("init boom"); }, constructServices: () => { built = true; },
  }), /init boom/);
  assert.equal(built, false, "Auth/Firestore not constructed when initializeAppCheck throws");
});

test("bootstrapFirebase SOFT-fails a first-token blip: SDK is initialized, so services still construct", async () => {
  let built = false, warned = false;
  await bootstrapFirebase({ init: true }, {
    loadAppCheck: async () => ({}), initAppCheck: () => ({}),
    firstToken: async () => { throw new Error("token blip"); },
    onTokenWarn: () => { warned = true; }, constructServices: () => { built = true; },
  });
  assert.equal(built, true, "initialized SDK retries per request → proceed and render");
  assert.equal(warned, true);
});

/* ---- push availability + the messaging-load gate ---- */

test("pushAvailability maps device state without importing messaging", () => {
  assert.equal(pushAvailability({ iosNeedsInstall: true }), "ios-needs-install");
  assert.equal(pushAvailability({ supported: false }), "unsupported");
  assert.equal(pushAvailability({ supported: true, hasVapid: false }), "not-configured");
  assert.equal(pushAvailability({ supported: true, hasVapid: true, permission: "granted" }), "granted");
});

test("pushEnabled requires VAPID + support + already-granted permission", () => {
  assert.equal(pushEnabled({ hasVapid: true, supported: true, permission: "granted" }), true);
  assert.equal(pushEnabled({ hasVapid: true, supported: true, permission: "default" }), false);
  assert.equal(pushEnabled({ hasVapid: true, supported: true, permission: "denied" }), false);
  assert.equal(pushEnabled({ hasVapid: false, supported: true, permission: "granted" }), false);
  assert.equal(pushEnabled({ hasVapid: true, supported: false, permission: "granted" }), false);
});

// Mirrors listenForeground exactly (pushEnabled gate → loadMessaging → subscribe),
// proving Board startup with default/denied permission never runs the loader.
test("Board startup with default/denied permission does NOT invoke the messaging loader", async () => {
  let loaderCalls = 0;
  const loadMessaging = async () => { loaderCalls++; return { getMessaging: () => ({}), onMessage: (_m, _cb) => () => {} }; };
  const listen = (permission, cb) => foregroundSubscription(async () => {
    if (!pushEnabled({ hasVapid: true, supported: true, permission })) return null; // no import
    const { getMessaging, onMessage } = await loadMessaging();
    return onMessage(getMessaging(), cb);
  });

  for (const perm of ["default", "denied"]) { const cleanup = listen(perm, () => {}); await tick(); cleanup(); }
  assert.equal(loaderCalls, 0, "messaging chunk must NOT load on mount without granted permission");

  // Granted → the loader runs and the subscription still cleans up.
  let unsubbed = 0;
  const loadG = async () => { loaderCalls++; return { getMessaging: () => ({}), onMessage: () => () => { unsubbed++; } }; };
  const cleanup = foregroundSubscription(async () => {
    if (!pushEnabled({ hasVapid: true, supported: true, permission: "granted" })) return null;
    const { getMessaging, onMessage } = await loadG();
    return onMessage(getMessaging(), () => {});
  });
  await tick(); cleanup();
  assert.equal(loaderCalls, 1);
  assert.equal(unsubbed, 1);
});

/* ---- foreground subscription cleanup across the deferred import ---- */

test("foregroundSubscription: cleanup unsubscribes once the async subscription is ready", async () => {
  let unsubbed = 0;
  const cleanup = foregroundSubscription(async () => () => { unsubbed++; });
  await tick();
  cleanup();
  assert.equal(unsubbed, 1);
});

test("foregroundSubscription: cleanup BEFORE the import resolves still tears it down (no leak)", async () => {
  let unsubbed = 0;
  const cleanup = foregroundSubscription(async () => { await tick(); return () => { unsubbed++; }; });
  cleanup();                       // unmounted while the messaging chunk was still loading
  await tick(); await tick();
  assert.equal(unsubbed, 1);       // torn down as soon as it became ready
});

test("foregroundSubscription: a no-op setup (unsupported) yields a safe cleanup", async () => {
  const cleanup = foregroundSubscription(async () => null);
  await tick();
  assert.doesNotThrow(cleanup);
});
