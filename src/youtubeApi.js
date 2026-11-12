/* Loads the official YouTube IFrame Player API once (shared by the learner
   player and the editor's duration probe). Resolves null if it can't load. */
let _ytApi = null;
export function loadYouTubeApi() {
  if (_ytApi) return _ytApi;
  _ytApi = new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(null);
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch {} resolve(window.YT); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api"; s.async = true;
    s.onerror = () => { _ytApi = null; resolve(null); };
    document.head.appendChild(s);
  });
  return _ytApi;
}
