import type { CSSProperties } from "react";

declare module "react" {
  interface CSSProperties {
    /** The reveal step that site.css multiplies by 140ms for the animation delay. */
    "--i"?: number;
  }
}

export const stagger = (i: number) => ({ "--i": i }) satisfies CSSProperties;
