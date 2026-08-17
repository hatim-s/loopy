declare namespace JSX {
  interface IntrinsicElements {
    [element: string]: Record<string, unknown>;
  }
}

declare module "react" {
  export type ReactNode = unknown;
}

declare module "react/jsx-runtime" {
  export const Fragment: unknown;
  export function jsx(...args: unknown[]): unknown;
  export function jsxs(...args: unknown[]): unknown;
}
