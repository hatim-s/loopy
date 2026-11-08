import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultHome } from "@loopy/runtime/local";
import { Effect } from "effect";
import type { OptionSpec, OptionValues } from "./command";
import { cliIO } from "./errors";

export const GLOBAL_OPTIONS = {
  home: {
    type: "string",
    value: "directory",
    description: `Registry, bundles and runs.sqlite. Default: ${defaultHome()}`,
  },
  cwd: {
    type: "string",
    value: "directory",
    description: "Workspace for a new run. Default: current directory",
  },
  help: { type: "boolean", short: "h", description: "Show usage" },
} as const satisfies Record<string, OptionSpec>;

/** The global options resolved once for every command. */
export type Context = {
  readonly home: string;
  readonly cwd: string;
  readonly cwdExplicit: boolean;
};

export type Invocation<Values, Args> = Context & {
  readonly values: Values;
  readonly args: Args;
  readonly namedInput: Readonly<Record<string, string>> | undefined;
};

/** The slice of a run or schedule invocation that input parsing reads. */
export type CliContext = Pick<
  Invocation<{ readonly "input-json"?: string; readonly "input-file"?: string }, unknown>,
  "cwd" | "values" | "namedInput"
>;

export const resolveContext = Effect.fn(function* (globals: OptionValues<typeof GLOBAL_OPTIONS>) {
  const context: Context = {
    home: resolve(globals.home ?? defaultHome()),
    cwd: yield* cliIO(() => realpath(resolve(globals.cwd ?? process.cwd()))),
    cwdExplicit: globals.cwd !== undefined,
  };

  return context;
});
