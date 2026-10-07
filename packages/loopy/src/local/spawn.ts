import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import type { CommandOutput } from "../core/index.js";
import { errorMessage } from "../core/index.js";
import { CommandExecutionError } from "../runtime/index.js";

const KILL_GRACE_MS = 250;

export type Launch = {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
};
export type Limits = { timeoutMs: number; maxOutputBytes: number };

export function emptyOutput(): CommandOutput {
  return { stdout: "", stderr: "", exitCode: -1, durationMs: 0 };
}

/** An error raised before the process spawned, so retrying it is safe. */
export function unstarted(error: unknown): CommandExecutionError {
  return new CommandExecutionError(errorMessage(error), emptyOutput(), false, { cause: error });
}

function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
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

/** Appends up to the byte budget and reports whether the chunk overflowed it. */
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
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Runs the process in its own group, bounds output and time, and captures both streams. */
export function spawnCaptured(
  launch: Launch,
  limits: Limits,
  signal: AbortSignal | undefined,
  started: number,
): Promise<CommandOutput> {
  return new Promise((resolveOutput, rejectOutput) => {
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
    let settled = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const stop = (error: Error) => {
      if (failure) {
        return;
      }
      failure = error;
      killTree(child, "SIGTERM");
      if (!exited) {
        killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      }
    };
    const onAbort = () => stop(new Error("Command aborted.", { cause: signal?.reason }));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () => stop(new Error(`Command timed out after ${limits.timeoutMs} ms.`)),
      limits.timeoutMs,
    );
    timeout.unref();

    const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (!exited) {
        killTree(child, "SIGKILL");
      }
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener("abort", onAbort);
      const partial = Boolean(failure || error || exitSignal);
      const output: CommandOutput = {
        stdout: decodeCaptured(stdout, partial),
        stderr: decodeCaptured(stderr, partial),
        exitCode: exitCode ?? -1,
        durationMs: Math.round(performance.now() - started),
      };
      const reason =
        failure ??
        error ??
        (exitSignal ? new Error(`Command terminated by ${exitSignal}.`) : undefined);
      if (reason) {
        rejectOutput(
          new CommandExecutionError(reason.message, output, child.pid !== undefined, {
            cause: reason,
          }),
        );
        return;
      }
      resolveOutput(output);
    };

    const collect = (destination: Buffer[]) => (chunk: Buffer) => {
      if (capture(destination, budget, chunk, limits.maxOutputBytes)) {
        stop(new Error(`Command output exceeded ${limits.maxOutputBytes} bytes.`));
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
      }, KILL_GRACE_MS);
      drainTimer.unref();
    });
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (code, exitSignal) => finish(code, exitSignal));
    child.stdin.end(launch.stdin);
  });
}
