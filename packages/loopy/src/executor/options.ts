import type { ExecutionMode } from "../core/index.js";

export type Options = {
  home: string;
  workspace: string;
  mode: ExecutionMode;
  secrets: Record<string, string>;
  bundlePath: (hash: string) => string;
};
