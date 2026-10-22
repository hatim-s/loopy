import { SANDBOX_MAX_CAPTURE_BYTES } from "../../../packages/loopy/src/contract/index.js";
import {
  CommandExecutionError,
  type CommandResult,
} from "../../../packages/loopy/src/core/index.js";
import { spawnCaptured } from "../../../packages/loopy/src/local/execution-host.js";

export type ProcessOptions = {
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxBytes?: number;
  signal?: AbortSignal;
};

export type CommandRunner = (argv: string[], options: ProcessOptions) => Promise<CommandResult>;

export class CaptureError extends Error {
  constructor(readonly reason: "timeout" | "output_limit") {
    super(reason === "timeout" ? "Process timed out." : "Process output exceeded its byte limit.");
  }
}

export const runCommand: CommandRunner = async (argv, options) => {
  options.signal?.throwIfAborted();
  const [program, ...args] = argv;

  if (!program) {
    throw new Error("Supply a command program.");
  }

  const controller = new AbortController();
  let timedOut = false;
  const interrupted = () => controller.abort();
  options.signal?.addEventListener("abort", interrupted, { once: true });

  if (options.signal?.aborted) {
    interrupted();
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    return await spawnCaptured(
      {
        program,
        args,
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? {},
        stdin: options.stdin,
      },
      {
        timeoutMs: options.timeoutMs + 1000,
        maxOutputBytes: options.maxBytes ?? SANDBOX_MAX_CAPTURE_BYTES,
      },
      controller.signal,
      performance.now(),
    );
  } catch (cause) {
    if (cause instanceof CommandExecutionError && cause.code === "output_limit") {
      throw new CaptureError("output_limit");
    }

    if (timedOut) {
      throw new CaptureError("timeout");
    }

    throw cause;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", interrupted);
  }
};
