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
  limitExceeded?: "stdout" | "stderr" | "line" | "lines";
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

export type LiveJsonlSubprocess = {
  /** Lines are yielded as soon as a newline is received from stdout. */
  lines: AsyncIterable<string>;
  /** Resolves once the child has exited and all stream data has been drained. */
  done: Promise<JsonlSubprocessResult<never>>;
  cancel(): Promise<void>;
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

type Queue<T> = {
  push(value: T): void;
  close(): void;
  fail(error: unknown): void;
  iterable: AsyncIterable<T>;
};

function queue<T>(): Queue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let closed = false;
  let failure: unknown;
  const push = (value: T) => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else values.push(value);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    while (waiters.length) {
      const waiter = waiters.shift();
      if (failure !== undefined) waiter?.reject(failure);
      else waiter?.resolve({ value: undefined as never, done: true });
    }
  };
  const fail = (error: unknown) => {
    failure = error;
    close();
  };
  return {
    push,
    close,
    fail,
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            if (values.length) return Promise.resolve({ value: values.shift() as T, done: false });
            if (closed) {
              return failure !== undefined
                ? Promise.reject(failure)
                : Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
          },
        };
      },
    },
  };
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
  let aborted = false;
  let timedOut = false;
  let limitExceeded: SubprocessResult["limitExceeded"];
  let termination: Promise<void> | undefined;
  const abort = (timeout = false) => {
    aborted = true;
    timedOut ||= timeout;
    termination ??= terminate(child, gracefulMs);
  };
  const onAbort = () => abort();
  const onLimit = (which: NonNullable<SubprocessResult["limitExceeded"]>) => {
    limitExceeded ??= which;
    stdoutState.truncated ||= which === "stdout";
    stderrState.truncated ||= which === "stderr";
    termination ??= terminate(child, gracefulMs);
  };
  child.stdout?.on("data", (chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const before = stdoutState.bytes;
    appendBounded(stdoutChunks, stdoutState, value, maxStdoutBytes);
    if (stdoutState.truncated && before < maxStdoutBytes) onLimit("stdout");
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const before = stderrState.bytes;
    appendBounded(stderrChunks, stderrState, value, maxStderrBytes);
    if (stderrState.truncated && before < maxStderrBytes) onLimit("stderr");
  });
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
    ...(limitExceeded ? { limitExceeded } : {}),
    diagnostic: aborted
      ? timedOut
        ? "Subprocess timed out and was terminated."
        : "Subprocess was cancelled and terminated."
      : limitExceeded
        ? `Subprocess ${limitExceeded} limit was exceeded and the process was terminated.`
        : exit.code !== 0
          ? `Subprocess exited with ${exit.signal ? `signal ${exit.signal}` : `code ${String(exit.code)}`}.`
          : undefined,
  };
  if (stdoutState.truncated || stderrState.truncated)
    throw new SubprocessError("Subprocess output exceeded configured limits.", result);
  return result;
}

/**
 * Start a JSONL subprocess without waiting for its first or final record.
 * The returned handle is deliberately synchronous so ProviderAdapter.start can
 * hand the caller a live stream immediately.
 */
export function startJsonlSubprocess(options: JsonlSubprocessOptions): LiveJsonlSubprocess {
  if (!options.argv[0]) throw new SubprocessError("Subprocess argv must not be empty.");
  if (!options.cwd?.trim()) throw new SubprocessError("Subprocess cwd is required.");
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_OUTPUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_OUTPUT_BYTES;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_LINE_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_LINES;
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
  const lines = queue<string>();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };
  let lineBuffer = "";
  let lineCount = 0;
  let aborted = false;
  let timedOut = false;
  let limitExceeded: SubprocessResult["limitExceeded"];
  let termination: Promise<void> | undefined;
  const terminateFor = (reason: NonNullable<SubprocessResult["limitExceeded"]>) => {
    limitExceeded ??= reason;
    if (reason === "stdout") stdoutState.truncated = true;
    if (reason === "stderr") stderrState.truncated = true;
    termination ??= terminate(child, gracefulMs);
  };
  const emitLines = (chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const before = stdoutState.bytes;
    appendBounded(stdoutChunks, stdoutState, value, maxStdoutBytes);
    if (stdoutState.truncated && before < maxStdoutBytes) {
      terminateFor("stdout");
      return;
    }
    lineBuffer += value.toString("utf8");
    while (true) {
      const newline = lineBuffer.search(/\r?\n/);
      if (newline < 0) {
        if (Buffer.byteLength(lineBuffer, "utf8") > maxLineBytes) terminateFor("line");
        return;
      }
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(lineBuffer[newline] === "\r" ? newline + 2 : newline + 1);
      lineCount += 1;
      if (lineCount > maxLines) {
        terminateFor("lines");
        return;
      }
      if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
        terminateFor("line");
        return;
      }
      lines.push(line);
    }
  };
  child.stdout?.on("data", emitLines);
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const before = stderrState.bytes;
    appendBounded(stderrChunks, stderrState, value, maxStderrBytes);
    if (stderrState.truncated && before < maxStderrBytes) terminateFor("stderr");
  });
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
  const done = new Promise<JsonlSubprocessResult<never>>((resolve) => {
    child.once("error", (error) => {
      lines.fail(error);
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        argv: options.argv.map(redact) as unknown as readonly [string, ...string[]],
        stdout: redact(stdoutChunks.join("")),
        stderr: redact(stderrChunks.join("")),
        exitCode: null,
        signal: null,
        aborted: false,
        timedOut: false,
        truncated: { stdout: stdoutState.truncated, stderr: stderrState.truncated },
        durationMs: Date.now() - started,
        records: [],
        malformedLines: [],
        diagnostic: `Subprocess '${options.argv[0]}' failed: ${String(error)}`,
      });
    });
    child.once("exit", async (code, signal) => {
      if (lineBuffer && !limitExceeded) {
        lineCount += 1;
        if (lineCount > maxLines) terminateFor("lines");
        else if (Buffer.byteLength(lineBuffer, "utf8") > maxLineBytes) terminateFor("line");
        else lines.push(lineBuffer);
      }
      lines.close();
      if (termination) await termination;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      const result: JsonlSubprocessResult<never> = {
        argv: options.argv.map(redact) as unknown as readonly [string, ...string[]],
        stdout: redact(stdoutChunks.join("")),
        stderr: redact(stderrChunks.join("")),
        exitCode: code,
        signal,
        aborted,
        timedOut,
        truncated: { stdout: stdoutState.truncated, stderr: stderrState.truncated },
        durationMs: Date.now() - started,
        records: [],
        malformedLines: [],
        ...(limitExceeded ? { limitExceeded } : {}),
        diagnostic: aborted
          ? timedOut
            ? "Subprocess timed out and was terminated."
            : "Subprocess was cancelled and terminated."
          : limitExceeded
            ? `Subprocess ${limitExceeded} limit was exceeded and the process was terminated.`
            : code !== 0
              ? `Subprocess exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`
              : undefined,
      };
      resolve(result);
    });
  });
  return { lines: lines.iterable, done, cancel: async () => abort() };
}

export async function runJsonlSubprocess<T = unknown>(
  options: JsonlSubprocessOptions,
): Promise<JsonlSubprocessResult<T>> {
  const records: T[] = [];
  const malformedLines: Array<{ line: number; message: string }> = [];
  const live = startJsonlSubprocess(options);
  let lineNumber = 0;
  for await (const line of live.lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch (error) {
      malformedLines.push({ line: lineNumber, message: String(error) });
    }
  }
  const result = await live.done;
  if (result.limitExceeded || result.truncated.stdout || result.truncated.stderr)
    throw new SubprocessError(
      result.limitExceeded === "line"
        ? `JSONL line ${lineNumber + 1} exceeded the configured size.`
        : result.limitExceeded === "lines"
          ? "JSONL output exceeded the configured line limit."
          : "Subprocess output exceeded configured limits.",
      result,
    );
  return { ...result, records, malformedLines };
}
