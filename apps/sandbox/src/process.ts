import { SANDBOX_MAX_CAPTURE_BYTES } from "@loopy/contract";
import { CommandExecutionError, type CommandResult } from "@loopy/core";
import { spawnCaptured } from "@loopy/runtime/local/execution-host";
import { Effect } from "effect";

export type ProcessOptions = {
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxBytes?: number;
  signal?: AbortSignal;
};

export type CommandRunner = (
  argv: string[],
  options: ProcessOptions,
) => Effect.Effect<CommandResult, CommandExecutionError>;

export const runCommand: CommandRunner = (argv, options) =>
  Effect.suspend(() => {
    const [program, ...args] = argv;

    if (!program) {
      return Effect.fail(
        new CommandExecutionError({
          reason: "unstarted",
          message: "Supply a command program.",
          output: { stdout: "", stderr: "", exitCode: -1, durationMs: 0 },
          cause: undefined,
        }),
      );
    }

    return spawnCaptured(
      {
        program,
        args,
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? {},
        stdin: options.stdin,
      },
      {
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxBytes ?? SANDBOX_MAX_CAPTURE_BYTES,
      },
      options.signal,
      performance.now(),
    );
  });
