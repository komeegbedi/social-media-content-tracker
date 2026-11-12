/* IFC Creative Academy — fetchLinkMetadata (callable, Academy editors only).

   Given a resource URL an editor pasted, return a safe, small description of
   it for a link card: { available, restricted, title, siteName, fileType,
   finalHost }. Never returns fetched HTML.

   Server-side request safety (SSRF):
   • http/https only, no credentials in the URL, default ports only (80/443).
   • Every DNS answer is checked at CONNECT time (custom `lookup`), so private,
     loopback, link-local, CGNAT, multicast, reserved and cloud-metadata
     addresses are refused — including after redirects and DNS rebinding.
   • At most 3 redirects, each re-validated; 6 s overall timeout; at most
     256 KB read; only text/html bodies are parsed (title / og tags).
   • 401/403 or a redirect to a sign-in page ⇒ `restricted: true` with no
     metadata (private documents stay private; nothing is bypassed). */
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const net = require("node:net");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;

/* ---- address classification (pure) ---- */
function ipv4ToInt(ip) { return ip.split(".").reduce((a, o) => (a << 8) + (Number(o) & 255), 0) >>> 0; }
const V4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([b, bits]) => [ipv4ToInt(b), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) { const n = ipv4ToInt(ip); return V4_BLOCKS.some(([base, mask]) => (n & mask) === (base & mask)); }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (s === "::" || s === "::1") return true;
    if (/^f[cd]/.test(s)) return true;                 // fc00::/7 unique local
    if (/^fe[89ab]/.test(s)) return true;              // fe80::/10 link local
    if (/^ff/.test(s)) return true;                    // multicast
    if (/^64:ff9b:/.test(s) || /^2001:db8:/.test(s) || /^100::/.test(s)) return true;
    return false;
  }
  return true;   // anything unparseable is refused
}

/* URL policy (pure). Returns { ok, url } or { ok:false, reason }. */
function checkUrl(raw, { allowedPorts = [80, 443] } = {}) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return { ok: false, reason: "invalid" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "scheme" };
  if (u.username || u.password) return { ok: false, reason: "credentials" };
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  if (!allowedPorts.includes(port)) return { ok: false, reason: "port" };
  if (!u.hostname || u.hostname === "localhost" || u.hostname.endsWith(".localhost") || u.hostname.endsWith(".internal")) return { ok: false, reason: "host" };
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ""))) return { ok: false, reason: "private" };
  return { ok: true, url: u };
}

/* ---- metadata extraction from HTML text (pure; regex over text, nothing rendered) ---- */
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; })
    .replace(/&#(\d+);/g, (_, d) => { const c = Number(d); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ""; })
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
const clean = (s, n) => decodeEntities(s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
function metaContent(html, attr, name) {
  const re = new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${name}["'][^>]*>`, "i");
  const tag = html.match(re);
  if (!tag) return "";
  const c = tag[0].match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
  return c ? (c[1] ?? c[2] ?? "") : "";
}
function parseHtmlMeta(html) {
  const h = String(html || "").slice(0, MAX_BYTES);
  const title = clean(metaContent(h, "property", "og:title") || metaContent(h, "name", "twitter:title") || (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "", 200);
  const siteName = clean(metaContent(h, "property", "og:site_name") || "", 80);
  return { title, siteName };
}
const TYPE_BY_MIME = { "application/pdf": "PDF", "application/msword": "Word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word", "application/vnd.ms-powerpoint": "PowerPoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint", "application/vnd.ms-excel": "Excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel", "application/zip": "ZIP", "text/csv": "CSV", "text/plain": "Text" };
const TYPE_BY_EXT = { pdf: "PDF", doc: "Word", docx: "Word", ppt: "PowerPoint", pptx: "PowerPoint", key: "Keynote", xls: "Excel", xlsx: "Excel", csv: "CSV", txt: "Text", zip: "ZIP", png: "Image", jpg: "Image", jpeg: "Image", gif: "Image", webp: "Image", svg: "Image", mp3: "Audio", wav: "Audio", mp4: "Video", mov: "Video", psd: "Photoshop", ai: "Illustrator", fig: "Figma", cube: "LUT", lut: "LUT" };
function fileTypeOf(contentType, url) {
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (TYPE_BY_MIME[mime]) return TYPE_BY_MIME[mime];
  if (mime.startsWith("image/")) return "Image";
  if (mime.startsWith("audio/")) return "Audio";
  if (mime.startsWith("video/")) return "Video";
  try { const ext = new URL(url).pathname.split(".").pop().toLowerCase(); if (TYPE_BY_EXT[ext]) return TYPE_BY_EXT[ext]; } catch {}
  return mime === "text/html" || !mime ? "" : "File";
}
const looksLikeSignIn = (u) => /(^|\.)accounts\.google\.com$/.test(u.hostname) || /\/(login|signin|sign-in|auth)(\/|$|\?)/i.test(u.pathname + u.search) || /ServiceLogin/i.test(u.pathname);

/* ---- guarded fetch ---- */
function fetchOnce(u, { resolve, isBlocked, deadline }) {
  return new Promise((resolveP, rejectP) => {
    const lib = u.protocol === "https:" ? https : http;
    const lookup = (hostname, opts, cb) => {
      resolve(hostname).then((addrs) => {
        const bad = addrs.find((a) => isBlocked(a.address));
        if (!addrs.length || bad) return cb(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }));
        if (opts && opts.all) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
      }, (e) => cb(e));
    };
    const req = lib.request(u, { method: "GET", lookup, timeout: Math.max(500, deadline - Date.now()),
      headers: { "User-Agent": "IFC-Creatives-Board-LinkPreview/1.0", Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Encoding": "identity" } }, (res) => {
      const chunks = []; let size = 0;
      const type = String(res.headers["content-type"] || "");
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return resolveP({ status: res.statusCode, location: res.headers.location || "", type, body: "" }); }
      if (!/text\/html|application\/xhtml/i.test(type)) { res.destroy(); return resolveP({ status: res.statusCode, type, body: "" }); }
      res.on("data", (c) => { size += c.length; if (size > MAX_BYTES) { chunks.push(c.subarray(0, Math.max(0, c.length - (size - MAX_BYTES)))); res.destroy(); resolveP({ status: res.statusCode, type, body: Buffer.concat(chunks).toString("utf8") }); } else chunks.push(c); });
      res.on("end", () => resolveP({ status: res.statusCode, type, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", rejectP);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", rejectP);
    req.end();
  });
}
const defaultResolve = (hostname) => new Promise((res, rej) => dns.lookup(hostname, { all: true, verbatim: true }, (e, a) => e ? rej(e) : res(a)));

async function fetchLinkMeta(raw, { resolve = defaultResolve, isBlocked = isPrivateAddress, allowedPorts = [80, 443], timeoutMs = TIMEOUT_MS } = {}) {
  const first = checkUrl(raw, { allowedPorts });
  if (!first.ok) return { available: false, reason: first.reason };
  const deadline = Date.now() + timeoutMs;
  let u = first.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let r;
    try { r = await fetchOnce(u, { resolve, isBlocked, deadline }); }
    catch (e) { return { available: false, reason: e.code === "EBLOCKED" ? "private" : e.code === "ETIMEDOUT" ? "timeout" : "unreachable", retryable: e.code !== "EBLOCKED" }; }
    if (r.status >= 300 && r.status < 400 && r.location) {
      let next; try { next = new URL(r.location, u); } catch { return { available: false, reason: "redirect" }; }
      if (looksLikeSignIn(next)) return { available: false, restricted: true, reason: "restricted", finalHost: u.hostname };
      const chk = checkUrl(next.href, { allowedPorts });
      if (!chk.ok) return { available: false, reason: chk.reason === "private" || chk.reason === "host" ? "private" : chk.reason };
      u = chk.url; continue;
    }
    if (r.status === 401 || r.status === 403) return { available: false, restricted: true, reason: "restricted", finalHost: u.hostname };
    if (r.status >= 400) return { available: false, reason: r.status === 404 ? "not-found" : "http-" + r.status, retryable: r.status >= 500 };
    const meta = r.body ? parseHtmlMeta(r.body) : { title: "", siteName: "" };
    return { available: true, restricted: false, title: meta.title, siteName: meta.siteName, fileType: fileTypeOf(r.type, u.href), finalHost: u.hostname };
  }
  return { available: false, reason: "too-many-redirects" };
}

/* Only Academy editors may use the server as a fetcher. */
function isEditorProfile(p) {
  return !!p && p.disabled !== true && (p.status === "approved" || p.role === "admin") && (p.role === "admin" || p.academyEditor === true);
}

const fetchLinkMetadata = onCall({ memory: "256MiB", timeoutSeconds: 15 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const { db } = require("./lib");
  const prof = await db.collection("users").doc(req.auth.uid).get();
  if (!isEditorProfile(prof.exists ? prof.data() : null)) throw new HttpsError("permission-denied", "Only Academy editors can fetch link previews.");
  const url = String((req.data && req.data.url) || "").slice(0, 2000);
  return fetchLinkMeta(url);
});

module.exports = { fetchLinkMetadata, fetchLinkMeta, isPrivateAddress, checkUrl, parseHtmlMeta, fileTypeOf, decodeEntities, isEditorProfile, looksLikeSignIn };
