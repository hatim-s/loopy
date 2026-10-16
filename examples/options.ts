import type { CommandOptions } from "loopy";

export const readOptions = {
  retry: { attempts: 3, retryOn: "exit" },
  timeout: "2m",
} as const satisfies CommandOptions;

export const writeOptions = {
  retry: { attempts: 1 },
  timeout: "10m",
} as const satisfies CommandOptions;
