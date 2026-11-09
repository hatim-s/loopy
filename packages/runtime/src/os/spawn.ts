import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import type { ParserInput } from "@loopy/core";
import { errorMessage } from "@loopy/core";
import { Effect } from "effect";
import { CommandExecutionError } from "./command-error";

const KILL_GRACE_MS = 5000;

const PIPE_DRAIN_MS = 250;

export type Launch = {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
};

export type SpawnOptions = {
  timeoutMs: number;
  maxOutputBytes: number;
  killGraceMs?: number;
  signal?: AbortSignal;
};

export function emptyOutput(): ParserInput {
  return { stdout: "", stderr: "", exitCode: -1 };
}

/** An error raised before the process spawned, so retrying it is safe. */
export function unstarted(cause: unknown): CommandExecutionError {
  return new CommandExecutionError({
    message: errorMessage(cause),
    output: emptyOutput(),
    cause,
    reason: "unstarted",
  });
}

export function aborted(signal: AbortSignal): CommandExecutionError {
  return new CommandExecutionError({
    message: "Command aborted.",
    output: emptyOutput(),
    cause: signal.reason,
    reason: "aborted",
  });
}

/** Invalid author input has a known outcome and stays in durable command failure data. */
export function rejected(cause: unknown): CommandExecutionError {
  return new CommandExecutionError({
    message: errorMessage(cause),
    output: emptyOutput(),
    cause,
    reason: "rejected",
  });
}

function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

function ignoreStdinError(): void {
  // A child that exits without reading stdin raises EPIPE here; its exit code already tells the story.
}

/**
 * A byte limit or interruption may cut a UTF-8 code point. Leave it pending
 * rather than adding a replacement character that obscures a secret prefix.
 */
function decodeCaptured(chunks: Buffer[], partial: boolean): string {
  const buffer = Buffer.concat(chunks);

  return partial
    ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(buffer, { stream: true })
    : buffer.toString("utf8");
}

function capture(
  destination: Buffer[],
  budget: { bytes: number },
  chunk: Buffer,
  limit: number,
): boolean {
  const remaining = limit - budget.bytes;

  if (remaining > 0) {
    const kept = chunk.subarray(0, remaining);
    destination.push(kept);
    budget.bytes += kept.length;
  }

  return chunk.length > remaining;
}

function trySpawn(launch: Launch): ChildProcessWithoutNullStreams {
  return spawn(launch.program, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function spawnCaptured(
  launch: Launch,
  limits: SpawnOptions,
): Effect.Effect<ParserInput, CommandExecutionError> {
  const { signal } = limits;

  return Effect.callback((resume) => {
    if (signal?.aborted) {
      resume(Effect.fail(aborted(signal)));

      return;
    }

    let complete!: () => void;

    const closed = new Promise<void>((resolve) => {
      complete = resolve;
    });

    const resolveOutput = (value: ParserInput) => resume(Effect.succeed(value));
    const rejectOutput = (error: CommandExecutionError) => resume(Effect.fail(error));
    let child: ChildProcessWithoutNullStreams;

    try {
      child = trySpawn(launch);
    } catch (error) {
      rejectOutput(unstarted(error));

      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const budget = { bytes: 0 };
    let failure: Error | undefined;
    let failureReason: CommandExecutionError["reason"] = "process";
    let settled = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const stop = (error: Error, reason: CommandExecutionError["reason"]) => {
      if (failure) {
        return;
      }

      failure = error;
      failureReason = reason;
      killTree(child, "SIGTERM");

      if (!exited) {
        killTimer = setTimeout(
          () => killTree(child, "SIGKILL"),
          limits.killGraceMs ?? KILL_GRACE_MS,
        );
        killTimer.unref();
      }
    };

    const onAbort = () => stop(new Error("Command aborted.", { cause: signal?.reason }), "aborted");
    signal?.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(
      () => stop(new Error(`Command timed out after ${limits.timeoutMs} ms.`), "timeout"),
      limits.timeoutMs,
    );

    timeout.unref();

    const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null, error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      complete();

      if (!exited) {
        killTree(child, "SIGKILL");
      }

      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener("abort", onAbort);
      const partial = Boolean(failure || error || exitSignal);

      const output: ParserInput = {
        stdout: decodeCaptured(stdout, partial),
        stderr: decodeCaptured(stderr, partial),
        exitCode: exitCode ?? -1,
      };

      const reason =
        failure ??
        error ??
        (exitSignal ? new Error(`Command terminated by ${exitSignal}.`) : undefined);

      if (reason) {
        rejectOutput(
          new CommandExecutionError({
            message: reason.message,
            output,
            cause: reason,
            reason: child.pid === undefined ? "unstarted" : failureReason,
          }),
        );

        return;
      }

      resolveOutput(output);
    };

    const collect = (destination: Buffer[]) => (chunk: Buffer) => {
      if (capture(destination, budget, chunk, limits.maxOutputBytes)) {
        stop(new Error(`Command output exceeded ${limits.maxOutputBytes} bytes.`), "output_limit");
      }
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", ignoreStdinError);
    child.once("exit", (code, exitSignal) => {
      exited = true;
      // Kill the rest of the group; a grandchild holding the pipes must not keep us waiting.
      killTree(child, "SIGKILL");
      clearTimeout(killTimer);
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, exitSignal);
      }, PIPE_DRAIN_MS);
      drainTimer.unref();
    });
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (code, exitSignal) => finish(code, exitSignal));
    child.stdin.end(launch.stdin);

    if (signal?.aborted) {
      onAbort();
    }

    // Interrupting the fiber requests termination, then waits for group kill and pipe drain.
    // The caller may remove sandbox files only after this finalizer completes.
    return Effect.promise(() => {
      if (!settled) {
        stop(new Error("Command interrupted."), "aborted");
      }

      return closed;
    });
  });
}
