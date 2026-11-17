/* IFC Creative Academy — fetchVideoMetadata (callable).

   Editors paste a video LINK; the client parses/normalises it (src/academyVideo.js)
   and asks the server for display metadata (title, creator, thumbnail) so the
   editor can see a preview before saving and so the lesson can attribute the
   external creator. The browser can't call YouTube's oEmbed endpoint directly
   (no CORS), so this runs server-side. It only ever requests the official oEmbed
   endpoints listed in the oEmbed provider registry (https://oembed.com/providers.json):
   https://www.youtube.com/oembed and https://vimeo.com/api/oembed.json —
   with a URL BUILT from the validated provider + id. A user-supplied URL is never
   fetched. No API keys are involved. Google Drive exposes no public metadata
   endpoint; the client falls back to "no preview".

   Returned: { provider, id, title, author, authorUrl, thumbnailUrl, sourceUrl,
               available: true } or { available: false, reason } */
const { onCall, HttpsError } = require("firebase-functions/v2/https");

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{6,12}$/;
const VIMEO_HASH = /^[a-f0-9]{6,16}$/i;

/* Build the oEmbed request for a validated reference, or null if unsupported. */
function oembedRequest({ provider, id, hash }) {
  if (provider === "youtube" && YT_ID.test(String(id || ""))) {
    const sourceUrl = `https://www.youtube.com/watch?v=${id}`;
    return { sourceUrl, url: `https://www.youtube.com/oembed?url=${encodeURIComponent(sourceUrl)}&format=json`, fallbackThumb: null };
  }
  if (provider === "vimeo" && VIMEO_ID.test(String(id || ""))) {
    const h = hash && VIMEO_HASH.test(hash) ? `/${String(hash).toLowerCase()}` : "";
    const sourceUrl = `https://vimeo.com/${id}${h}`;
    return { sourceUrl, url: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(sourceUrl)}`, fallbackThumb: null };
  }
  return null;
}

/* Normalise an oEmbed payload into the small shape we store on a lesson. */
function normalizeOembed(provider, id, sourceUrl, body, fallbackThumb) {
  const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const httpsOnly = (u) => (/^https:\/\/[^\s"'<>]+$/.test(u) ? u : "");
  const thumb = httpsOnly(str(body && body.thumbnail_url, 500)) || fallbackThumb || "";
  return {
    provider, id, sourceUrl, available: true,
    title: str(body && body.title, 200),
    author: str(body && body.author_name, 120),
    authorUrl: httpsOnly(str(body && body.author_url, 300)),
    thumbnailUrl: thumb,
    // Vimeo's oEmbed includes `duration` (seconds); YouTube's does not — its
    // duration is measured in the editor with the IFrame Player API instead.
    durationSec: body && Number.isFinite(Number(body.duration)) && Number(body.duration) > 0 ? Math.round(Number(body.duration)) : null,
  };
}

const fetchVideoMetadata = onCall({ memory: "256MiB", timeoutSeconds: 15 }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  // Only Academy editors author lessons; learners never need this endpoint.
  const { db } = require("./lib");
  const { isEditorProfile } = require("./linkMetadata");
  const prof = await db.collection("users").doc(req.auth.uid).get();
  if (!isEditorProfile(prof.exists ? prof.data() : null)) throw new HttpsError("permission-denied", "Only Academy editors can fetch video previews.");
  const d = req.data || {};
  const reqd = oembedRequest({ provider: d.provider, id: d.id, hash: d.hash });
  if (!reqd) return { available: false, reason: "No preview is available for this provider." };
  let res;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    res = await fetch(reqd.url, { signal: ctl.signal, headers: { "User-Agent": "ifc-creatives-board/academy" } });
    clearTimeout(t);
  } catch {
    return { available: false, reason: "Couldn't reach the video provider. Try again.", retryable: true };
  }
  if (res.status === 401 || res.status === 403) return { available: false, reason: "This video is private or embedding is restricted." };
  if (res.status === 404) return { available: false, reason: "We couldn't find this video. Check the link." };
  if (!res.ok) return { available: false, reason: "The provider didn't return a preview.", retryable: true };
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return normalizeOembed(d.provider, d.id, reqd.sourceUrl, body, reqd.fallbackThumb);
});

module.exports = { fetchVideoMetadata, oembedRequest, normalizeOembed };
