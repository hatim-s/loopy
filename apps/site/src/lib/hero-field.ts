import { reducedMotion } from "./motion";
import { onThemeChange } from "./theme";

// A grid of tiny mono glyphs on one canvas. Each cell swaps its glyph now
// and then, and a diagonal band sweeps across every 12 seconds and brightens
// what it passes over. Pixel ratio capped at 2, paused while the tab is
// hidden or the hero is off screen, one static frame under reduced motion.

const CW = 16;

const CH = 22;

const GLYPHS = ["0", "1", ".", "+", "·", "·", ".", "0"];

const PERIOD = 12;

type Cell = { x: number; y: number; g: string; base: number; next: number };

const pick = () => GLYPHS[(Math.random() * GLYPHS.length) | 0] ?? "0";

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export function mountHeroField(hero: HTMLElement, canvas: HTMLCanvasElement) {
  const maybeCtx = canvas.getContext("2d");

  if (!maybeCtx) {
    return () => {};
  }

  const ctx: CanvasRenderingContext2D = maybeCtx;
  const reduce = reducedMotion();
  let W = 0;
  let H = 0;
  let cells: Cell[] = [];
  let font = "";
  // the glyph colours come from CSS so the field follows the theme: ink for the
  // resting glyphs, a and b for the two ends of the brand tint across the band
  let ink = "150,162,185";
  let tintA = [143, 168, 255];
  let tintB = [110, 224, 210];
  let raf = 0;
  let running = false;
  let last = 0;
  let visible = true;
  const ptr = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4 };

  function setup() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.body);
    font = `500 11px ${css.getPropertyValue("--mono")}`;

    const rgb = (name: string, fallback: number[]) => {
      const parts = css.getPropertyValue(name).split(",").map(Number);

      return parts.length === 3 && parts.every(Number.isFinite) ? parts : fallback;
    };

    ink = css.getPropertyValue("--field-ink").trim() || ink;
    tintA = rgb("--field-a", tintA);
    tintB = rgb("--field-b", tintB);
    const cols = Math.ceil(W / CW) + 1;
    const rows = Math.ceil(H / CH) + 1;
    cells = [];

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        cells.push({
          x: i * CW + CW / 2,
          y: j * CH + CH / 2 + 4,
          g: pick(),
          base: 0.05 + 0.1 * Math.random() ** 2,
          next: rand(0, 10),
        });
      }
    }

    if (reduce) {
      draw(0);
    }
  }

  function draw(t: number) {
    ctx.clearRect(0, 0, W, H);
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // the band is the line x + y = c, and c sweeps from before the top left to past the bottom right
    const span = W + H;
    const c = -0.25 * span + ((t % PERIOD) / PERIOD) * 1.5 * span;
    const width = 0.11 * span;
    const R2 = 2 * 140 * 140;

    for (const s of cells) {
      const d = (s.x + s.y - c) / width;
      const band = Math.exp(-d * d);

      if (t >= s.next) {
        s.g = pick();
        s.next = t + (band > 0.3 ? rand(0.15, 0.6) : rand(3, 14));
      }

      const dx = s.x - ptr.x;
      const dy = s.y - ptr.y;
      const near = Math.exp(-(dx * dx + dy * dy) / R2);
      const a = s.base + 0.5 * band + 0.3 * near;

      if (a < 0.04) {
        continue;
      }

      // the tint runs accent to aqua left to right, so the band carries the brand gradient
      const u = s.x / W;
      const [ar = 0, ag = 0, ab = 0] = tintA;
      const [br = 0, bg = 0, bb = 0] = tintB;
      const r = (ar + (br - ar) * u) | 0;
      const g = (ag + (bg - ag) * u) | 0;
      const b = (ab + (bb - ab) * u) | 0;
      ctx.fillStyle =
        band > 0.08 || near > 0.08 ? `rgba(${r},${g},${b},${a})` : `rgba(${ink},${a})`;
      ctx.fillText(s.g, s.x, s.y);
    }
  }

  function tick(now: number) {
    if (!running) {
      return;
    }

    const t = now / 1000;
    const dt = Math.min(0.05, last ? t - last : 0.016);
    last = t;
    const k = 1 - Math.exp(-dt * 8);
    ptr.x += (ptr.tx - ptr.x) * k;
    ptr.y += (ptr.ty - ptr.y) * k;
    draw(t);
    raf = requestAnimationFrame(tick);
  }

  const start = () => {
    if (running || reduce || !visible || document.hidden) {
      return;
    }

    running = true;
    last = 0;
    raf = requestAnimationFrame(tick);
  };

  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };

  const onVisibility = () => (document.hidden ? stop() : start());

  const io = new IntersectionObserver(([e]) => {
    visible = e?.isIntersecting ?? false;

    if (visible) {
      start();
    } else {
      stop();
    }
  });

  let resizeTimer = 0;

  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(setup, 120);
  };

  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    ptr.tx = e.clientX - r.left;
    ptr.ty = e.clientY - r.top;

    if (ptr.x < -1000) {
      ptr.x = ptr.tx;
      ptr.y = ptr.ty;
    }
  };

  const onLeave = () => {
    ptr.tx = -1e4;
    ptr.ty = -1e4;
  };

  document.addEventListener("visibilitychange", onVisibility);
  io.observe(hero);
  addEventListener("resize", onResize, { passive: true });
  hero.addEventListener("pointermove", onMove);
  hero.addEventListener("pointerleave", onLeave);
  const offTheme = onThemeChange(setup);
  setup();
  start();

  return () => {
    stop();
    offTheme();
    io.disconnect();
    clearTimeout(resizeTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    removeEventListener("resize", onResize);
    hero.removeEventListener("pointermove", onMove);
    hero.removeEventListener("pointerleave", onLeave);
  };
}
