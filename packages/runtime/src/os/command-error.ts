import type { CommandResult } from "@loopy/core";
import { Data } from "effect";

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
  cwd: string | null;
  env: Record<string, string>;
  stdin: string | null;
  timeoutMs: number;
  maxOutputBytes: number | null;
};
