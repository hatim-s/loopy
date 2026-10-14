export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/** Smoothstep from a to b. */
export const ss = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));

  return t * t * (3 - 2 * t);
};

/** Cubic ease-out from a to b. */
export const eo = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));

  return 1 - (1 - t) ** 3;
};

/** css cubic-bezier(x1,y1,x2,y2) as a function of progress, so svg motion can share the page ease. */
export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const A = (a: number, b: number) => 1 - 3 * b + 3 * a;
  const B = (a: number, b: number) => 3 * b - 6 * a;
  const C = (a: number) => 3 * a;
  const at = (t: number, a: number, b: number) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t: number, a: number, b: number) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);

  return (x: number) => {
    if (x <= 0) {
      return 0;
    }

    if (x >= 1) {
      return 1;
    }

    let t = x;

    for (let i = 0; i < 6; i++) {
      const s = slope(t, x1, x2);

      if (!s) {
        break;
      }

      t -= (at(t, x1, x2) - x) / s;
    }

    return at(t, y1, y2);
  };
}

export const EASE = bezier(0.2, 0.8, 0.2, 1);

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
