import type { CSSProperties } from "react";

/** Sets the `--i` step the reveal keyframes multiply by 140ms. */
// SAFETY: React forwards custom properties to style untouched, CSSProperties just does not list them
export const stagger = (i: number) => ({ "--i": i }) as CSSProperties;
