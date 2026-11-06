import { Data } from "effect";
import type { CommandResult } from "./model";

/** A process boundary failure. Only timeout and output_limit are author evaluation limits. */
export class CommandExecutionError extends Data.TaggedError("CommandExecutionError")<{
  reason: "rejected" | "unstarted" | "timeout" | "output_limit" | "aborted" | "process";
  message: string;
  output: CommandResult;
  cause?: unknown;
}> {}

export type ResolvedCommand = {
  program: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
};
