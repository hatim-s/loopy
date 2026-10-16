import type {
  Command,
  CommandResult,
  EngineRun,
  EngineStep,
  ExecutionMode,
  Json,
  LogLevel,
  StepKind,
} from "../core/index.js";
import { errorMessage } from "../core/index.js";
import { backoffMs, type RetryPolicy } from "./backoff.js";
import { type Duration, durationMs } from "./duration.js";
import { assertJson } from "./json.js";
import { OwnershipError, type RunStore } from "./store.js";

export interface Executor {
  execute(
    command: Command,
    options: { timeoutMs?: number; cwd: string; mode: ExecutionMode },
  ): Promise<CommandResult>;
}

export type EngineClock = {
  now: () => number;
  tick: () => Promise<void>;
  timeout: (callback: () => void, milliseconds: number) => () => void;
};

export const SYSTEM_CLOCK: EngineClock = {
  now: Date.now,
  tick: () =>
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    }),
  timeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);

    return () => clearTimeout(timer);
  },
};

export type StepOptions = { retry?: RetryPolicy; timeout?: Duration };

export type ContextOptions = {
  run: EngineRun;
  steps: EngineStep[];
  logSequences: number[];
  store: RunStore;
  executor: Executor;
  token: string;
  cwd: string;
  mode: ExecutionMode;
  clock: EngineClock;
};

export class NondeterminismError extends Error {
  constructor(seq: number, expected: string, actual: string) {
    super(
      `Step ${seq} expected key '${expected}' but received '${actual}'. Restore the original step order or start a new run.`,
    );
    this.name = "NondeterminismError";
  }
}

export class StepFailedError extends Error {
  constructor(key: string, cause: unknown) {
    super(`Step '${key}' failed: ${errorMessage(cause)}. Fix the step before starting a new run.`, {
      cause,
    });
    this.name = "StepFailedError";
  }
}

class ExitError extends Error {}

class TimeoutError extends Error {}

export class Context {
  private seq = 0;
  private logSeq = 0;
  private readonly steps: Map<number, EngineStep>;
  private readonly logSequences: Set<number>;
  private readonly wakeTimes: string[] = [];
  private logWrites = Promise.resolve();
  private notify = () => {};
  running = 0;
  blocked = 0;
  readonly input: Json;
  readonly log = {
    info: (message: string, data?: Json) => this.writeLog("info", message, data),
    warn: (message: string, data?: Json) => this.writeLog("warn", message, data),
    error: (message: string, data?: Json) => this.writeLog("error", message, data),
  };

  constructor(private readonly options: ContextOptions) {
    this.logSequences = new Set(options.logSequences);
    this.input = structuredClone(options.run.input);
    this.steps = new Map(options.steps.map((step) => [step.seq, step]));
  }

  get wakeAt(): string | undefined {
    return [...this.wakeTimes].sort()[0];
  }

  changed(): Promise<void> {
    return new Promise((resolve) => {
      this.notify = resolve;
    });
  }

  flushLogs(): Promise<void> {
    return this.logWrites;
  }

  step<T extends Json>(
    key: string,
    execute: () => Promise<T> | T,
    options?: StepOptions,
  ): Promise<T>;
  step(key: string, execute: () => Json | Promise<Json>, options: StepOptions = {}): Promise<Json> {
    return this.perform(key, "function", null, execute, options);
  }

  command(key: string, command: Command, options?: StepOptions): Promise<CommandResult>;
  command(key: string, command: Command, options: StepOptions = {}): Promise<Json> {
    const input: unknown = JSON.parse(JSON.stringify(command));
    assertJson(input, "Command input");

    const timeoutMs =
      options.timeout === undefined ? command.timeoutMs : durationMs(options.timeout);

    return this.perform(
      key,
      "command",
      input,
      async () => {
        const result = await this.options.executor.execute(command, {
          cwd: this.options.cwd,
          mode: this.options.mode,
          timeoutMs,
        });

        if (result.exitCode !== 0) {
          throw new ExitError(
            `Command exited with code ${result.exitCode}. Inspect stderr and correct the command.`,
          );
        }

        return result;
      },
      { ...options, timeout: timeoutMs },
    );
  }

  now(): Promise<number>;
  now(): Promise<Json> {
    return this.perform("now", "clock", null, () => this.options.clock.now(), {});
  }

  random(): Promise<number>;
  random(): Promise<Json> {
    return this.perform("random", "random", null, Math.random, {});
  }

  uuid(): Promise<string>;
  uuid(): Promise<Json> {
    return this.perform("uuid", "random", null, () => crypto.randomUUID(), {});
  }

  async sleep(duration: Duration): Promise<void> {
    const milliseconds = durationMs(duration);
    const { record, stored } = this.prepare("sleep", "sleep", milliseconds, {});

    if (stored?.status === "succeeded") {
      return;
    }

    const wakeAt =
      stored?.wakeAt ?? new Date(this.options.clock.now() + milliseconds).toISOString();

    this.running++;

    try {
      if (Date.parse(wakeAt) <= this.options.clock.now()) {
        await this.put({
          ...record,
          attempt: 1,
          status: "succeeded",
          output: null,
          endedAt: this.timestamp(),
        });

        return;
      }

      await this.put({ ...record, attempt: 1, status: "sleeping", wakeAt });

      return this.block(wakeAt);
    } finally {
      this.running--;
      this.notify();
    }
  }

  private prepare(key: string, kind: StepKind, input: Json, options: StepOptions) {
    const seq = ++this.seq;
    const stored = this.steps.get(seq);

    if (stored && stored.key !== key) {
      throw new NondeterminismError(seq, stored.key, key);
    }

    const record: EngineStep = stored ?? {
      runId: this.options.run.id,
      seq,
      key,
      kind,
      input,
      status: "running",
      attempt: 0,
      maxAttempts: options.retry?.attempts ?? 3,
      startedAt: this.timestamp(),
    };

    return { stored, record };
  }

  private async perform(
    key: string,
    kind: StepKind,
    input: Json,
    execute: () => Json | Promise<Json>,
    options: StepOptions,
  ): Promise<Json> {
    const { record, stored } = this.prepare(key, kind, input, options);

    if (stored?.status === "succeeded") {
      return structuredClone(stored.output ?? null);
    }

    if (stored?.status === "failed") {
      throw new StepFailedError(key, new Error(stored.error));
    }

    const wakeAt = stored?.nextRetryAt ?? stored?.wakeAt;

    if (wakeAt && Date.parse(wakeAt) > this.options.clock.now()) {
      return this.block(wakeAt);
    }

    if (stored?.status === "waiting" && !wakeAt) {
      return this.block();
    }

    this.running++;
    let result;

    try {
      result = await this.attempt(
        {
          ...record,
          status: "running",
          attempt: record.attempt + 1,
          startedAt: this.timestamp(),
          error: undefined,
          endedAt: undefined,
          nextRetryAt: undefined,
          wakeAt: undefined,
        },
        execute,
        options,
      );
    } finally {
      this.running--;
      this.notify();
    }

    if ("blocked" in result) {
      return this.block(result.wakeAt);
    }

    return result.output;
  }

  private async attempt(
    record: EngineStep,
    execute: () => Json | Promise<Json>,
    options: StepOptions,
  ): Promise<{ output: Json } | { blocked: true; wakeAt: string }> {
    await this.put(record);

    try {
      const output = await this.execute(execute, options.timeout);
      assertJson(output, `Output of step '${record.key}'`);
      await this.put({ ...record, status: "succeeded", output, endedAt: this.timestamp() });

      return { output };
    } catch (cause) {
      if (cause instanceof OwnershipError || cause instanceof NondeterminismError) {
        throw cause;
      }

      return this.failAttempt(record, cause, options);
    }
  }

  private async failAttempt(
    record: EngineStep,
    cause: unknown,
    options: StepOptions,
  ): Promise<{ blocked: true; wakeAt: string }> {
    const error = errorMessage(cause);

    const retry =
      record.attempt < record.maxAttempts &&
      (!(cause instanceof ExitError) || options.retry?.retryOn === "exit");

    if (!retry) {
      await this.put({ ...record, status: "failed", error, endedAt: this.timestamp() });
      throw new StepFailedError(record.key, cause);
    }

    const nextRetryAt = new Date(
      this.options.clock.now() + backoffMs(record.attempt),
    ).toISOString();

    await this.put({
      ...record,
      status: "retrying",
      error,
      nextRetryAt,
      endedAt: this.timestamp(),
    });

    return { blocked: true, wakeAt: nextRetryAt };
  }

  private async execute(execute: () => Json | Promise<Json>, timeout?: Duration): Promise<Json> {
    if (timeout === undefined) {
      return execute();
    }

    let cancel = () => {};

    const deadline = new Promise<TimeoutError>((resolve) => {
      cancel = this.options.clock.timeout(
        () => resolve(new TimeoutError("Step timed out. Increase its timeout or reduce its work.")),
        durationMs(timeout),
      );
    }).then((error) => {
      throw error;
    });

    try {
      return await Promise.race([Promise.resolve().then(execute), deadline]);
    } finally {
      cancel();
    }
  }

  private block(wakeAt?: string): Promise<never> {
    this.blocked++;

    if (wakeAt) {
      this.wakeTimes.push(wakeAt);
    }

    this.notify();

    return new Promise(() => {});
  }

  private put(record: EngineStep): Promise<void> {
    return this.options.store.putStep(this.options.run.id, this.options.token, record);
  }

  private timestamp(): string {
    return new Date(this.options.clock.now()).toISOString();
  }

  private writeLog(level: LogLevel, message: string, data?: Json): void {
    const seq = ++this.logSeq;

    if (this.logSequences.has(seq)) {
      return;
    }

    this.logSequences.add(seq);

    const log = {
      runId: this.options.run.id,
      seq,
      level,
      message,
      data,
      at: this.timestamp(),
    };

    this.logWrites = this.logWrites.then(() =>
      this.options.store.appendLog(log.runId, this.options.token, log),
    );
    // The engine awaits this chain before releasing ownership, even if user code does not await logs.
    void this.logWrites.catch(() => {});
  }
}
