/* IFC Creative Academy — the one-off confetti burst on "Finish course".

   Deliberately small: a single short burst (~1.8 s) drawn on a canvas that
   covers the celebration panel, never the page. The canvas is aria-hidden and
   pointer-events: none (CSS), so nothing can be clicked through or focused.
   No flashing: pieces keep a steady colour and fade out together at the end.
   Callers skip it entirely under prefers-reduced-motion. Returns a cleanup
   function that stops the animation and clears the canvas. */
const PALETTE = ["#5E6AD2", "#8790F0", "#4A54AC", "#C6CBF2", "#6E79E8", "#3B4290"];   // the app's indigo accent family
const DURATION_MS = 1800;
const FADE_MS = 450;

export function burstConfetti(canvas, { count = 70, palette = PALETTE, now = () => performance.now() } = {}) {
  if (!canvas || typeof window === "undefined") return () => {};
  const ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return () => {};
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // burst from the emblem area (upper middle of the panel), fanning upward
  const ox = w / 2, oy = Math.min(90, h * 0.3);
  const pieces = Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
    const speed = 260 + Math.random() * 260;
    return {
      x: ox, y: oy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 5, ratio: 0.45 + Math.random() * 0.4,
      rot: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 5,
      color: palette[i % palette.length],
    };
  });

  let raf = 0, last = now(), stopped = false;
  const start = last;
  const frame = () => {
    if (stopped) return;
    const t = now();
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    const age = t - start;
    ctx.clearRect(0, 0, w, h);
    if (age >= DURATION_MS) { stopped = true; return; }
    const alpha = age > DURATION_MS - FADE_MS ? Math.max(0, (DURATION_MS - age) / FADE_MS) : 1;
    ctx.globalAlpha = alpha;
    for (const p of pieces) {
      p.vy += 620 * dt;                 // gravity
      p.vx *= 1 - 1.2 * dt;             // air drag
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.spin * dt;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -(p.size * p.ratio) / 2, p.size, p.size * p.ratio);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    raf = window.requestAnimationFrame(frame);
  };
  raf = window.requestAnimationFrame(frame);
  return () => { stopped = true; window.cancelAnimationFrame(raf); ctx.clearRect(0, 0, w, h); };
}

export const CONFETTI_DURATION_MS = DURATION_MS;
