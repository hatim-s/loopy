import type { CommandSpec, ParserInput } from "@loopy/core";
import { Data } from "effect";

/** A process boundary failure. Only timeout and output_limit are author evaluation limits. */
export class CommandExecutionError extends Data.TaggedError("CommandExecutionError")<{
  reason: "rejected" | "unstarted" | "timeout" | "output_limit" | "aborted" | "process";
  message: string;
  output: ParserInput;
  cause?: unknown;
}> {}

/** Settings and limits come from the decoded spec, whose schema holds the limits to positive integers. */
export type ResolvedCommand = Pick<
  CommandSpec,
  "cwd" | "env" | "stdin" | "timeoutMs" | "maxOutputBytes"
> & {
  program: string;
  args: string[];
};
