/* IFC Creative Academy — editor-side video link preview.
   Separate module (no App.jsx dependency) so it can be tested in isolation.

   For the CURRENT parsed link it shows:
   • provider metadata (title / creator / thumbnail) via the server-side
     oEmbed callable — a newer link always wins over an older in-flight request,
     and changing the link clears stale metadata;
   • a small embedded preview player (YouTube / Vimeo / Drive) so the editor can
     check it actually plays here;
   • the DURATION, from documented sources only:
       Vimeo  — oEmbed `duration` (returned by the callable)
       YouTube — IFrame Player API getDuration(), which the docs say is 0 until
                 metadata loads ("normally just after the video starts playing"),
                 so the preview plays MUTED for a moment, reads it, and stops.
                 For live streams getDuration() is elapsed time — if it keeps
                 growing the video is marked live and no duration is stored.
       Drive  — no API → unknown.
   Unknown stays unknown (never 0 or a guess) and never blocks saving. */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { PhotoIcon, ExclamationTriangleIcon, ArrowTopRightOnSquareIcon, ArrowPathIcon, ClockIcon } from "@heroicons/react/24/outline";
import { fetchVideoMetadata } from "./academyData.js";
import { sourceThumbUrl } from "./academyShared.jsx";
import { loadYouTubeApi } from "./youtubeApi.js";
import { isStale, STALE_MESSAGE } from "./appUpdate.js";
import { SaveAndReloadButton } from "./appUpdateUi.jsx";

/* What to say when the metadata request fails — never a raw module URL or MIME
   error. A stale tab (newer release live) can't recover by retrying: it gets
   the update message and a save-and-reload action instead of Retry. */
export function metadataFailure(e) {
  const code = String(e?.code || "");
  if (code === "app/stale") return { status: "stale", reason: STALE_MESSAGE, retryable: false };
  if (code === "app/offline" || code === "app/unreachable") return { status: "unavailable", reason: e.message, retryable: true };
  if (code === "functions/unavailable" || code === "functions/deadline-exceeded") return { status: "unavailable", reason: "The video details service didn't respond.", retryable: true };
  return { status: "unavailable", reason: "Couldn't load the video's details right now.", retryable: true };
}

const fmt = (s) => { const t = Math.round(s); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = t % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`; };

/* Measure a YouTube video's duration with the official IFrame API. Reports
   once per mount (keyed by video id by the caller). */
export function YouTubeProbe({ id, onResult, title = "Video preview" }) {
  const host = useRef(null);
  const done = useRef(false);
  const cb = useRef(onResult); cb.current = onResult;
  useEffect(() => {
    let player = null, cancelled = false, t1 = 0, t2 = 0;
    const mount = document.createElement("div");
    host.current?.appendChild(mount);
    const report = (r) => { if (!done.current && !cancelled) { done.current = true; cb.current(r); } };
    loadYouTubeApi().then((YT) => {
      if (cancelled) return;
      if (!YT) return report({ state: "unknown", reason: "The YouTube player couldn't load." });
      player = new YT.Player(mount, {
        host: "https://www.youtube-nocookie.com", videoId: id, width: "100%", height: "100%",
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: window.location.origin },
        events: {
          onReady: () => {
            const d0 = player.getDuration ? player.getDuration() : 0;
            if (d0 > 0) { // some players expose it before playing; still check for live
              t2 = setTimeout(() => { const d1 = player.getDuration(); report(d1 > d0 + 1.5 ? { state: "live" } : { state: "ok", sec: Math.round(d0) }); }, 2500);
              return;
            }
            try { player.mute(); player.playVideo(); } catch {}
            t1 = setTimeout(() => report({ state: "unknown", reason: "YouTube didn't report a duration. Play the preview to try again." }), 15000);
          },
          onStateChange: (e) => {
            if (done.current || e.data !== YT.PlayerState.PLAYING) return;
            const d1 = player.getDuration();
            clearTimeout(t1);
            t2 = setTimeout(() => {
              const d2 = player.getDuration();
              try { player.pauseVideo(); player.seekTo(0, true); player.unMute(); } catch {}
              if (d2 > d1 + 1.5) report({ state: "live" });
              else if (d1 > 0) report({ state: "ok", sec: Math.round(d1) });
              else report({ state: "unknown", reason: "YouTube didn't report a duration." });
            }, 2500);
          },
          onError: (e) => report({ state: "error", code: e.data, reason: e.data === 100 ? "YouTube says this video doesn't exist or is private." : (e.data === 101 || e.data === 150) ? "The owner doesn't allow this video to play on other sites, so learners will have to open it on YouTube." : "This video can't be played here." }),
        },
      });
    });
    return () => { cancelled = true; clearTimeout(t1); clearTimeout(t2); try { player && player.destroy && player.destroy(); } catch {} try { host.current && host.current.replaceChildren(); } catch {} };
  }, [id]);
  return <div className="ac-vprevplayer" ref={host} title={title} />;
}

export function VideoPreview({ parsed, meta, onMeta, fetcher = fetchVideoMetadata, probe = true, duration = true, staleAction = true }) {
  const key = parsed?.ok ? `${parsed.provider}:${parsed.id}:${parsed.hash || ""}` : "";
  const [state, setState] = useState({ key: "", status: "idle", reason: "" });
  const [dur, setDur] = useState({ key: "", state: "idle" });   // duration probe result for `key`
  const [showPlayer, setShowPlayer] = useState(false);
  const seq = useRef(0);
  const metaRef = useRef(meta); metaRef.current = meta;
  const [thumbErr, setThumbErr] = useState("");
  const parsedRef = useRef(parsed); parsedRef.current = parsed;

  const merge = (patch) => {
    const p = parsedRef.current; if (!p?.ok) return;
    const base = metaRef.current && metaRef.current.id === p.id ? metaRef.current : { id: p.id, title: "", author: "", authorUrl: "", thumbnailUrl: "", sourceUrl: p.url, fetchedAt: Date.now() };
    onMeta({ ...base, ...patch });
  };
  const load = useCallback(async () => {
    if (!parsed?.ok) return;
    const mySeq = ++seq.current;
    if (parsed.provider === "gdrive") { setState({ key, status: "unsupported", reason: "Google Drive doesn't publish a title, thumbnail or duration; the lesson can still be saved." }); return; }
    if (isStale()) { setState({ key, ...metadataFailure({ code: "app/stale" }) }); return; }   // no request that can't succeed
    setState({ key, status: "loading", reason: "" });
    try {
      const m = await fetcher(parsed);
      if (mySeq !== seq.current) return;                    // a newer link won
      if (m?.available) {
        merge({ title: m.title, author: m.author, authorUrl: m.authorUrl, thumbnailUrl: m.thumbnailUrl, sourceUrl: m.sourceUrl, fetchedAt: Date.now(), ...(m.durationSec ? { durationSec: m.durationSec } : {}) });
        setState({ key, status: "ok", reason: "" });
        if (m.durationSec) setDur({ key, state: "ok", sec: m.durationSec });
      } else setState({ key, status: "unavailable", reason: m?.reason || "No preview available.", retryable: m?.retryable });
    } catch (e) {
      if (mySeq !== seq.current) return;
      setState({ key, ...metadataFailure(e) });
    }
  }, [key, parsed, fetcher]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    seq.current++;                                           // invalidate any in-flight request
    setShowPlayer(false); setThumbErr("");
    if (!key) { if (metaRef.current) onMeta(null); setState({ key: "", status: "idle", reason: "" }); setDur({ key: "", state: "idle" }); return; }
    if (metaRef.current && metaRef.current.id !== parsed.id) onMeta(null);   // link changed → clear stale metadata + duration
    const have = metaRef.current && metaRef.current.id === parsed.id && (metaRef.current.title || metaRef.current.thumbnailUrl);
    setDur(metaRef.current && metaRef.current.id === parsed.id && (metaRef.current.durationSec || metaRef.current.isLive)
      ? { key, state: metaRef.current.isLive ? "live" : "ok", sec: metaRef.current.durationSec } : { key, state: parsed.provider === "youtube" && probe ? "measuring" : parsed.provider === "vimeo" ? "measuring" : "unknown" });
    if (have) setState({ key, status: "ok", reason: "" }); else load();
    if (parsed.provider === "youtube" && probe && !(metaRef.current && metaRef.current.id === parsed.id && (metaRef.current.durationSec || metaRef.current.isLive))) setShowPlayer(true);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Vimeo: if oEmbed returned no duration, it's unknown (not 0).
  useEffect(() => { if (parsed?.provider === "vimeo" && state.key === key && state.status !== "loading" && dur.state === "measuring") setDur({ key, state: "unknown" }); }, [state.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const onProbe = (r) => {
    if (!parsedRef.current?.ok || `${parsedRef.current.provider}:${parsedRef.current.id}:${parsedRef.current.hash || ""}` !== key) return;   // stale
    if (r.state === "ok") { setDur({ key, state: "ok", sec: r.sec }); merge({ durationSec: r.sec, isLive: false }); }
    else if (r.state === "live") { setDur({ key, state: "live" }); merge({ isLive: true, durationSec: null }); }
    else setDur({ key, state: r.state === "error" ? "error" : "unknown", reason: r.reason });
  };

  if (!parsed?.ok) return null;
  const thumb = sourceThumbUrl(parsed, meta);
  const thumbOk = !!thumb && thumbErr !== thumb;
  return (
    <div className="ac-vprev" aria-live="polite">
      <div className="ac-vprevthumb">
        {parsed.provider === "youtube" && showPlayer
          ? <YouTubeProbe key={parsed.id} id={parsed.id} onResult={onProbe} title={`Preview: ${meta?.title || "video"}`} />
          : thumbOk ? <img src={thumb} alt={meta?.title ? `Thumbnail: ${meta.title}` : "Video thumbnail"} referrerPolicy="no-referrer" onError={() => setThumbErr(thumb)} />
            : <div className="ac-img ac-img-empty" style={{ aspectRatio: "16 / 9" }}><PhotoIcon className="hi" aria-hidden="true" /></div>}
      </div>
      <div className="ac-vprevbody">
        {state.status === "loading" && <span className="ac-cardsub">Loading preview…</span>}
        {state.status === "ok" && meta && (meta.title || meta.author) && <><b className="ac-vprevtitle">{meta.title || "Untitled video"}</b>{meta.author && <span className="ac-cardsub">{meta.authorUrl ? <a href={meta.authorUrl} target="_blank" rel="noopener noreferrer">{meta.author}</a> : meta.author} · {parsed.capabilities.label}</span>}</>}
        {(state.status === "unavailable" || state.status === "unsupported") && <span className="ac-cardsub"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" /> {state.reason} The link itself is valid and can still be saved.</span>}
        {state.status === "stale" && <span className="ac-cardsub ac-vprevstale" role="status"><ExclamationTriangleIcon className="hi hi-xs" aria-hidden="true" /> {state.reason} The link itself is valid and is kept. {staleAction && <SaveAndReloadButton className="sb-btn compact" />}</span>}
        {duration && <span className="ac-vprevdur ac-cardsub">
          <ClockIcon className="hi hi-xs" aria-hidden="true" />
          {dur.state === "ok" ? `Duration ${fmt(dur.sec)}`
            : dur.state === "live" ? "Live stream, so there's no fixed length"
            : dur.state === "measuring" ? (parsed.provider === "youtube" ? "Measuring duration (the preview plays muted for a moment)…" : "Checking duration…")
            : dur.state === "error" ? dur.reason
            : (dur.reason || "Duration unknown")}
          {parsed.provider === "youtube" && (dur.state === "unknown" || dur.state === "error") && <button type="button" className="ac-link" onClick={() => { setShowPlayer(false); setDur({ key, state: "measuring" }); setTimeout(() => setShowPlayer(true), 30); }}>Measure again</button>}
        </span>}
        {state.status === "ok" && thumb && !thumbOk && <span className="ac-cardsub">The provider's thumbnail didn't load; a placeholder will be shown.</span>}
        <span className="ac-actions" style={{ marginTop: 6 }}>
          <a className="ac-ext" href={parsed.url} target="_blank" rel="noopener noreferrer"><ArrowTopRightOnSquareIcon className="hi hi-sm" aria-hidden="true" />Open on {parsed.capabilities.label}</a>
          {state.status === "unavailable" && state.retryable && <button type="button" className="ac-link" onClick={load}><ArrowPathIcon className="hi hi-xs" aria-hidden="true" />Retry</button>}
        </span>
        <span className="ac-hint">{parsed.provider === "youtube" && probe ? "If the player above plays, learners can watch it inside the Academy." : "Some videos can't play inside other sites; learners can still open them on the original site."}</span>
      </div>
    </div>
  );
}
