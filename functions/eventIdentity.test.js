/* Event identity — the token derivation + key composition contract.
   Pure; run with: node --test functions/eventIdentity.test.js */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { eventToken, notificationKeyBase, TOKEN_LEN } = require("./eventIdentity");

test("eventToken is a stable, safe, truncated hex token of the CloudEvent id", () => {
  const t = eventToken("evt-abc-123");
  assert.equal(t.length, TOKEN_LEN);
  assert.match(t, /^[0-9a-f]+$/);            // Firestore-doc-id safe
  assert.equal(eventToken("evt-abc-123"), t); // deterministic — a retry hashes identically
});

test("distinct event ids yield distinct tokens", () => {
  assert.notEqual(eventToken("evt-1"), eventToken("evt-2"));
});

test("falls back to updateTime when event.id is unavailable; still stable per version", () => {
  const ts = { toMillis: () => 1_700_000_000_000 };
  const a = eventToken(null, ts);
  const b = eventToken(undefined, { toMillis: () => 1_700_000_000_000 });
  assert.equal(a, b);                                  // same version → same token
  assert.notEqual(a, eventToken(null, { toMillis: () => 1_700_000_000_001 })); // newer version → new token
});

test("eventToken never silently invents an identity", () => {
  assert.throws(() => eventToken(null, null)); // no basis → loud failure, never Date.now()/random
});

test("notificationKeyBase is type_taskId_token; type disambiguates same-event notifications", () => {
  const token = eventToken("evt-x");
  assert.equal(notificationKeyBase("qa", "t1", token), `qa_t1_${token}`);
  // One write (one token) producing two types must not collide.
  assert.notEqual(notificationKeyBase("assigned", "t1", token), notificationKeyBase("qa", "t1", token));
});
