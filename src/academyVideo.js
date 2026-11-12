/* IFC Creative Academy — video LINK handling (pure, DOM-free).

   The Academy never stores or uploads video files: a lesson holds a LINK to a
   video hosted on a supported provider. This module is the single place that
   knows how to recognise, validate and normalise those links, and what each
   provider lets us do at playback time. The React player (Academy.jsx) consumes
   the normalised record; nothing else parses video URLs.

   Supported providers (see docs/academy.md → "Video providers"):
     youtube  — watch / youtu.be / shorts / live / embed URLs. Embedded with the
                IFrame Player API, which reports playback position + ENDED, so
                the player can resume where the learner left off and record
                "video watched" when the video actually finishes.
     vimeo    — vimeo.com/{id} (optionally with an unlisted hash) and
                player.vimeo.com/video/{id}. Embedded via player.vimeo.com; the
                postMessage player API reports timeupdate + ended, so progress
                and resume work like YouTube.
     gdrive   — drive.google.com/file/d/{id}/… share links. Embedded via the
                /preview player, which exposes NO playback API: no position, no
                resume, no end event — the learner marks the video watched
                manually (the UI labels this explicitly).

   Every record returned by parseVideoLink is derived purely from the parsed id,
   never by echoing the input URL into an iframe src: the embed URL is BUILT from
   a fixed provider template + a validated id (so pasted HTML or odd query strings
   can never reach the DOM). */

export const VIDEO_PROVIDERS = {
  youtube: { label: "YouTube",      tracksProgress: true,  tracksEnded: true,  resumes: true  },
  vimeo:   { label: "Vimeo",        tracksProgress: true,  tracksEnded: true,  resumes: true  },
  gdrive:  { label: "Google Drive", tracksProgress: false, tracksEnded: false, resumes: false },
};

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{6,12}$/;
const VIMEO_HASH = /^[a-f0-9]{6,16}$/i;
const GDRIVE_ID = /^[A-Za-z0-9_-]{20,80}$/;

const hostIs = (u, ...names) => {
  const h = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  return names.includes(h);
};

/* parseVideoLink(raw) -> { ok:true, provider, id, hash?, url, embedUrl, capabilities }
                       |  { ok:false, reason } (reason is learner/editor-readable) */
export function parseVideoLink(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, reason: "Paste a video link." };
  if (/\s/.test(s) || /[<>"']/.test(s)) return { ok: false, reason: "That doesn't look like a plain link (no spaces, quotes or HTML)." };
  let u;
  try { u = new URL(s); } catch { return { ok: false, reason: "Enter a full link starting with https://." }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "Enter a full link starting with https://." };

  // ---- YouTube ----
  if (hostIs(u, "youtube.com", "youtube-nocookie.com", "music.youtube.com")) {
    let id = u.searchParams.get("v");
    if (!id) {
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/);
      if (m) id = m[1];
    }
    if (id && YT_ID.test(id)) return youtube(id);
    return { ok: false, reason: "That YouTube link has no video id. Use a watch, share or Shorts link." };
  }
  if (hostIs(u, "youtu.be")) {
    const id = u.pathname.split("/").filter(Boolean)[0] || "";
    if (YT_ID.test(id)) return youtube(id);
    return { ok: false, reason: "That youtu.be link has no video id." };
  }

  // ---- Vimeo ----
  if (hostIs(u, "vimeo.com", "player.vimeo.com")) {
    const parts = u.pathname.split("/").filter(Boolean);
    // vimeo.com/{id}, vimeo.com/{id}/{hash}, vimeo.com/channels/x/{id},
    // vimeo.com/manage/videos/{id}, player.vimeo.com/video/{id}?h={hash}
    const idx = parts.findIndex((p) => VIMEO_ID.test(p));
    if (idx >= 0) {
      const id = parts[idx];
      const after = parts[idx + 1];
      const hash = u.searchParams.get("h") || (after && VIMEO_HASH.test(after) ? after : null);
      return vimeo(id, hash && VIMEO_HASH.test(hash) ? hash.toLowerCase() : null);
    }
    return { ok: false, reason: "That Vimeo link has no video id. Use the video's page or share link." };
  }

  // ---- Google Drive ----
  if (hostIs(u, "drive.google.com", "docs.google.com")) {
    let id = null;
    const m = u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
    if (m) id = m[1];
    else if (u.pathname === "/open" || u.pathname === "/uc") id = u.searchParams.get("id");
    if (id && GDRIVE_ID.test(id)) return gdrive(id);
    return { ok: false, reason: "Use the Drive file's share link (drive.google.com/file/d/…)." };
  }

  return {
    ok: false,
    reason: "Unsupported provider. Lessons can link to YouTube, Vimeo or Google Drive videos.",
  };
}

function youtube(id) {
  return {
    ok: true, provider: "youtube", id,
    url: `https://www.youtube.com/watch?v=${id}`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&rel=0&modestbranding=1&playsinline=1`,
    capabilities: VIDEO_PROVIDERS.youtube,
  };
}
function vimeo(id, hash) {
  const q = hash ? `?h=${hash}&` : "?";
  return {
    ok: true, provider: "vimeo", id, hash: hash || null,
    url: hash ? `https://vimeo.com/${id}/${hash}` : `https://vimeo.com/${id}`,
    embedUrl: `https://player.vimeo.com/video/${id}${q}dnt=1&title=0&byline=0&portrait=0`,
    capabilities: VIDEO_PROVIDERS.vimeo,
  };
}
function gdrive(id) {
  return {
    ok: true, provider: "gdrive", id,
    url: `https://drive.google.com/file/d/${id}/view`,
    embedUrl: `https://drive.google.com/file/d/${id}/preview`,
    capabilities: VIDEO_PROVIDERS.gdrive,
  };
}

/* The compact record STORED on a lesson doc. Only provider + id (+ hash) are
   persisted; url/embedUrl are rebuilt on read so a stored record can never carry
   an arbitrary src. */
export function videoRecord(parsed) {
  if (!parsed || !parsed.ok) return null;
  const rec = { provider: parsed.provider, id: parsed.id };
  if (parsed.hash) rec.hash = parsed.hash;
  return rec;
}

/* Rebuild the full playable record from a stored { provider, id, hash? }. Returns
   null for anything malformed (an unknown provider, a bad id) so a tampered doc
   renders the "unsupported video" state rather than an iframe. */
export function videoFromRecord(rec) {
  if (!rec || typeof rec !== "object") return null;
  const { provider, id, hash } = rec;
  if (provider === "youtube" && YT_ID.test(String(id || ""))) return youtube(id);
  if (provider === "vimeo" && VIMEO_ID.test(String(id || ""))) return vimeo(id, hash && VIMEO_HASH.test(hash) ? String(hash).toLowerCase() : null);
  if (provider === "gdrive" && GDRIVE_ID.test(String(id || ""))) return gdrive(id);
  return null;
}

/* Allowed origins for provider postMessage traffic. The player only trusts
   messages whose origin is in this set for the lesson's provider. */
export const PROVIDER_ORIGINS = {
  youtube: ["https://www.youtube-nocookie.com", "https://www.youtube.com"],
  vimeo: ["https://player.vimeo.com"],
  gdrive: [],
};

/* Playback-position persistence policy (pure, shared by the player + tests).
   • Save at most every `minIntervalSec` seconds of playback, and only when the
     position moved by at least `minDeltaSec`, to keep Firestore writes bounded.
   • Never store a position in the final `tailSec` of the video: resuming there
     would just replay the outro, and it would read as "almost watched". */
export function shouldPersistPosition({ positionSec, durationSec, lastSavedSec, lastSavedAt, now, minIntervalSec = 15, minDeltaSec = 5, tailSec = 10 }) {
  if (!(positionSec >= 0)) return false;
  if (durationSec > 0 && positionSec >= durationSec - tailSec) return false;
  if (lastSavedAt != null && now - lastSavedAt < minIntervalSec * 1000) return false;
  if (lastSavedSec != null && Math.abs(positionSec - lastSavedSec) < minDeltaSec) return false;
  return true;
}

/* A stored position is only a RESUME HINT. Ignore it when it would start inside
   the tail (replaying the outro) or when it's nonsense for this duration. */
export function resumePosition(savedSec, durationSec, tailSec = 10) {
  const s = Number(savedSec);
  if (!(s > 5)) return 0;
  if (durationSec > 0 && s >= durationSec - tailSec) return 0;
  return Math.floor(s);
}

/* "Video watched" is only ever earned from a provider ENDED event — or from
   reaching the last `endWindowSec` of a known duration on a provider that
   reports time (some players fire ENDED late or not at all when autoplay-next
   is off). Seeking to the end counts: that's the provider's own definition of
   ended, documented in docs/academy.md as a known limitation. */
export function videoWatchedFromEvent({ ended, positionSec, durationSec, endWindowSec = 3 }) {
  if (ended) return true;
  if (durationSec > 0 && positionSec >= durationSec - endWindowSec) return true;
  return false;
}
