import { SANDBOX_MAX_CAPTURE_BYTES } from "@loopy/contract";
import type { CommandExecutionError, CommandResult } from "@loopy/core";
import { spawnCaptured } from "@loopy/runtime/local/execution-host";
import { Effect } from "effect";

export type ProcessOptions = {
  stdin?: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBytes?: number;
  signal?: AbortSignal;
};

export type CommandRunner = (
  argv: [string, ...string[]],
  options: ProcessOptions,
) => Effect.Effect<CommandResult, CommandExecutionError>;

export const runCommand: CommandRunner = ([program, ...args], options) =>
  Effect.suspend(() =>
    spawnCaptured(
      { program, args, cwd: options.cwd, env: options.env, stdin: options.stdin },
      {
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxBytes ?? SANDBOX_MAX_CAPTURE_BYTES,
      },
      options.signal,
      performance.now(),
    ),
  );
