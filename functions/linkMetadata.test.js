/* Link metadata: SSRF guards, redirects, size/timeout limits, parsing, and
   restricted links. Uses a local HTTP server with an injected resolver so the
   guard logic is exercised end-to-end without the public internet.
   Run: node --test functions/linkMetadata.test.js */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { fetchLinkMeta, isPrivateAddress, checkUrl, parseHtmlMeta, fileTypeOf, decodeEntities, isEditorProfile, looksLikeSignIn } = require("./linkMetadata");

let server, port;
before(async () => {
  server = http.createServer((req, res) => {
    const host = (req.headers.host || "").split(":")[0];
    if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(`<html><head><title>Fallback &amp; title</title><meta property="og:title" content="Lighting Cheat Sheet &#8212; v2"><meta property="og:site_name" content="Studio Notes"><script>alert(1)</script></head><body>hi</body></html>`); }
    if (req.url === "/doc.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); return res.end("%PDF-1.4"); }
    if (req.url === "/private") { res.writeHead(403, { "content-type": "text/html" }); return res.end("<title>Sign in required</title>"); }
    if (req.url === "/to-internal") { res.writeHead(302, { location: `http://internal.test:${port}/page` }); return res.end(); }
    if (req.url === "/to-login") { res.writeHead(302, { location: "https://accounts.google.com/ServiceLogin?continue=x" }); return res.end(); }
    if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); return res.end(); }
    if (req.url === "/big") { res.writeHead(200, { "content-type": "text/html" }); res.write("<title>Big</title>"); res.end("x".repeat(600 * 1024)); return; }
    if (req.url === "/slow") { return; /* never responds */ }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => server.close());

// "public.test" → the local server (treated as public); "internal.test" → a private address
const resolve = async (h) => h === "public.test" ? [{ address: "127.0.0.1", family: 4 }] : h === "internal.test" ? [{ address: "10.0.0.5", family: 4 }] : [];
const isBlocked = (ip) => ip !== "127.0.0.1" && isPrivateAddress(ip);
const opts = () => ({ resolve, isBlocked, allowedPorts: [port], timeoutMs: 1500 });
const U = (p) => `http://public.test:${port}${p}`;

test("address classification blocks private, loopback, link-local, CGNAT, metadata and IPv6 local ranges", () => {
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-ip"])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("URL policy: http(s) only, no credentials, default ports, no localhost/private literals", () => {
  assert.equal(checkUrl("https://example.com/a").ok, true);
  for (const bad of ["ftp://x.com", "javascript:alert(1)", "https://user:pw@x.com", "https://x.com:8443/", "http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest", "not a url"])
    assert.equal(checkUrl(bad).ok, false, bad);
});

test("HTML metadata: og:title preferred, entities decoded, scripts never returned", async () => {
  const r = await fetchLinkMeta(U("/page"), opts());
  assert.deepEqual([r.available, r.title, r.siteName, r.restricted], [true, "Lighting Cheat Sheet — v2", "Studio Notes", false]);
  assert.ok(!JSON.stringify(r).includes("<script"));
  assert.deepEqual(parseHtmlMeta("<title> A &amp; B </title>"), { title: "A & B", siteName: "" });
  assert.equal(decodeEntities("&lt;b&gt;&#x41;&#66;"), "<b>AB");
});

test("documents: file type from content type or extension, body not read", async () => {
  const r = await fetchLinkMeta(U("/doc.pdf"), opts());
  assert.deepEqual([r.available, r.fileType, r.title], [true, "PDF", ""]);
  assert.equal(fileTypeOf("", "https://x.com/presets/Film.cube"), "LUT");
  assert.equal(fileTypeOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "https://x.com/a"), "Word");
});

test("private / restricted: 403 and sign-in redirects return no metadata but are flagged restricted", async () => {
  const a = await fetchLinkMeta(U("/private"), opts());
  assert.deepEqual([a.available, a.restricted, a.title], [false, true, undefined]);
  const b = await fetchLinkMeta(U("/to-login"), opts());
  assert.equal(b.restricted, true);
  assert.equal(looksLikeSignIn(new URL("https://docs.google.com/ServiceLogin")), true);
});

test("SSRF: a redirect to an internal address is refused at connect time; redirect loops are capped", async () => {
  const r = await fetchLinkMeta(U("/to-internal"), opts());
  assert.deepEqual([r.available, r.reason], [false, "private"]);
  const loop = await fetchLinkMeta(U("/loop"), opts());
  assert.equal(loop.reason, "too-many-redirects");
  const direct = await fetchLinkMeta(`http://internal.test:${port}/page`, opts());
  assert.equal(direct.reason, "private");
});

test("limits: large bodies are truncated (title still found) and slow servers time out", async () => {
  const big = await fetchLinkMeta(U("/big"), opts());
  assert.equal(big.title, "Big");
  const slow = await fetchLinkMeta(U("/slow"), { ...opts(), timeoutMs: 700 });
  assert.deepEqual([slow.available, slow.reason, slow.retryable], [false, "timeout", true]);
  const nf = await fetchLinkMeta(U("/missing"), opts());
  assert.equal(nf.reason, "not-found");
});

test("only Academy editors may use the fetcher", () => {
  assert.equal(isEditorProfile({ role: "admin", status: "approved" }), true);
  assert.equal(isEditorProfile({ role: "member", status: "approved", academyEditor: true }), true);
  assert.equal(isEditorProfile({ role: "member", status: "approved" }), false);
  assert.equal(isEditorProfile({ role: "member", status: "pending", academyEditor: true }), false);
  assert.equal(isEditorProfile({ role: "admin", status: "approved", disabled: true }), false);
  assert.equal(isEditorProfile(null), false);
});
