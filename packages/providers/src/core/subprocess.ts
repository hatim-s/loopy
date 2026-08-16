import { type ChildProcess, spawn } from "node:child_process";

export type SubprocessOptions = {
  /** The first item is the executable; shell interpolation is never performed. */
  argv: readonly [string, ...string[]];
  cwd: string;
  /** Only these names are copied from `process.env`; the child receives no other environment. */
  envAllowlist?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  gracefulTerminationMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

export type SubprocessResult = {
  argv: readonly [string, ...string[]];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  timedOut: boolean;
  truncated: { stdout: boolean; stderr: boolean };
  durationMs: number;
  diagnostic?: string;
};

export type JsonlSubprocessOptions = SubprocessOptions & {
  maxLineBytes?: number;
  maxLines?: number;
};

export type JsonlSubprocessResult<T = unknown> = SubprocessResult & {
  records: T[];
  malformedLines: Array<{ line: number; message: string }>;
};

export class SubprocessError extends Error {
  readonly result?: SubprocessResult;
  constructor(message: string, result?: SubprocessResult) {
    super(message);
    this.name = "SubprocessError";
    this.result = result;
  }
}

const DEFAULT_GRACE_MS = 1_000;
const DEFAULT_OUTPUT_BYTES = 1_024 * 1_024;
const DEFAULT_LINE_BYTES = 256 * 1_024;
const DEFAULT_LINES = 100_000;

/** Extracts a semver-like CLI version without trusting arbitrary output. */
export function parseCliVersion(output: string): string | undefined {
  const match = output.match(
    /(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z])/m,
  );
  return match?.[1];
}

function environment(
  allowlist: readonly string[] | undefined,
  provided: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const source = provided ?? process.env;
  const result: Record<string, string> = {};
  for (const name of allowlist ?? []) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function redact(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s,"'}]+/gi, "$1=[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "[REDACTED]");
}

function appendBounded(
  chunks: string[],
  state: { bytes: number; truncated: boolean },
  chunk: Buffer,
  maxBytes: number,
): void {
  if (state.bytes >= maxBytes) {
    state.truncated = true;
    return;
  }
  const remaining = maxBytes - state.bytes;
  if (chunk.byteLength > remaining) {
    chunks.push(chunk.subarray(0, remaining).toString("utf8"));
    state.bytes = maxBytes;
    state.truncated = true;
  } else {
    chunks.push(chunk.toString("utf8"));
    state.bytes += chunk.byteLength;
  }
}

function terminate(child: ChildProcess, gracefulMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may have exited between the checks.
        }
      }
      resolve();
    }, gracefulMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function runSubprocess(options: SubprocessOptions): Promise<SubprocessResult> {
  if (!options.argv[0]) throw new SubprocessError("Subprocess argv must not be empty.");
  if (!options.cwd?.trim()) throw new SubprocessError("Subprocess cwd is required.");
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_OUTPUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_OUTPUT_BYTES;
  const gracefulMs = options.gracefulTerminationMs ?? DEFAULT_GRACE_MS;
  const started = Date.now();
  let child: ChildProcess;
  try {
    child = spawn(options.argv[0], options.argv.slice(1), {
      cwd: options.cwd,
      env: environment(options.envAllowlist, options.env),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new SubprocessError(`Unable to start '${options.argv[0]}': ${String(error)}`);
  }
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };
  child.stdout?.on("data", (chunk: Buffer | string) =>
    appendBounded(
      stdoutChunks,
      stdoutState,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      maxStdoutBytes,
    ),
  );
  child.stderr?.on("data", (chunk: Buffer | string) =>
    appendBounded(
      stderrChunks,
      stderrState,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      maxStderrBytes,
    ),
  );

  let aborted = false;
  let timedOut = false;
  let termination: Promise<void> | undefined;
  const abort = (timeout = false) => {
    aborted = true;
    timedOut ||= timeout;
    termination ??= terminate(child, gracefulMs);
  };
  const onAbort = () => abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs !== undefined) timeout = setTimeout(() => abort(true), options.timeoutMs);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  ).catch((error: unknown) => {
    throw new SubprocessError(`Subprocess '${options.argv[0]}' failed: ${String(error)}`);
  });
  if (termination) await termination;
  if (timeout) clearTimeout(timeout);
  options.signal?.removeEventListener("abort", onAbort);
  const result: SubprocessResult = {
    argv: options.argv.map(redact) as unknown as readonly [string, ...string[]],
    stdout: redact(stdoutChunks.join("")),
    stderr: redact(stderrChunks.join("")),
    exitCode: exit.code,
    signal: exit.signal,
    aborted,
    timedOut,
    truncated: { stdout: stdoutState.truncated, stderr: stderrState.truncated },
    durationMs: Date.now() - started,
    diagnostic: aborted
      ? timedOut
        ? "Subprocess timed out and was terminated."
        : "Subprocess was cancelled and terminated."
      : exit.code !== 0
        ? `Subprocess exited with ${exit.signal ? `signal ${exit.signal}` : `code ${String(exit.code)}`}.`
        : undefined,
  };
  if (stdoutState.truncated || stderrState.truncated)
    throw new SubprocessError("Subprocess output exceeded configured limits.", result);
  return result;
}

export async function runJsonlSubprocess<T = unknown>(
  options: JsonlSubprocessOptions,
): Promise<JsonlSubprocessResult<T>> {
  const result = await runSubprocess(options);
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_LINE_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_LINES;
  const records: T[] = [];
  const malformedLines: Array<{ line: number; message: string }> = [];
  const lines = result.stdout.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > maxLines)
    throw new SubprocessError("JSONL output exceeded the configured line limit.", result);
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line, "utf8") > maxLineBytes)
      throw new SubprocessError(`JSONL line ${index + 1} exceeded the configured size.`, result);
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch (error) {
      malformedLines.push({ line: index + 1, message: String(error) });
    }
  }
  return { ...result, records, malformedLines };
}
