import { errorMessage, type Json, type StepBase, type StepRecord } from "../core/index.js";
import type { Activation } from "./activation.js";
import type { Clock } from "./clock.js";
import { assertJson } from "./json.js";
import type { RateLimits } from "./rate-limit.js";
import { type RetryPolicy, retryDelayMs, shouldRetry } from "./retry.js";
import type { RunStore } from "./store.js";
import { withAbort, withTimeout } from "./timeout.js";

export class StepFailedError extends Error {
  constructor(key: string, error: string) {
    super(`Step '${key}' failed: ${error.replace(/\.$/, "")}.`);
    this.name = "StepFailedError";
  }
}

export type Runner = {
  rateLimit?: string;
  rateLimits?: RateLimits;
  record: StepBase;
  stored?: StepRecord;
  store: RunStore;
  token: string;
  activation: Activation;
  clock: Clock;
  retry: RetryPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
};

async function put(options: Runner, step: StepRecord): Promise<void> {
  try {
    return await options.store.putStep(step.runId, options.token, step);
  } catch (cause) {
    options.activation.fail(new Error(errorMessage(cause), { cause }));
    throw cause;
  }
}

export async function failStep(options: Runner, cause: unknown): Promise<never> {
  const { record, activation, clock } = options;
  const error = errorMessage(cause);

  const order = await activation.terminal((finishOrder) =>
    put(options, {
      ...record,
      status: "failed",
      error,
      endedAt: new Date(clock.now()).toISOString(),
      finishOrder,
    }),
  );

  return activation.queue(order, "live", () => {
    throw new StepFailedError(record.key, error);
  });
}

async function failAttempt(options: Runner, cause: unknown): Promise<{ wakeAt: string }> {
  const { record, clock, activation } = options;

  if (activation.fatal) {
    throw cause;
  }

  if (options.signal?.aborted) {
    const at = new Date(clock.now()).toISOString();
    await put(options, {
      ...record,
      status: "retrying",
      error: "Step interrupted. Resume the run to retry.",
      endedAt: at,
      nextRetryAt: at,
    });

    return { wakeAt: at };
  }

  if (record.attempt >= record.maxAttempts || !shouldRetry(cause, options.retry)) {
    return failStep(options, cause);
  }

  const nextRetryAt = new Date(clock.now() + retryDelayMs(record.attempt)).toISOString();
  await put(options, {
    ...record,
    status: "retrying",
    error: errorMessage(cause),
    endedAt: new Date(clock.now()).toISOString(),
    nextRetryAt,
  });

  return { wakeAt: nextRetryAt };
}

async function invoke<T extends Json>(options: Runner, fn: () => T | Promise<T>) {
  const call = () =>
    options.timeoutMs === undefined
      ? fn()
      : withTimeout(
          options.clock,
          { milliseconds: options.timeoutMs, key: options.record.key },
          fn,
        );

  // Command cancellation waits for the executor to reap the child before releasing ownership.
  if (options.record.kind === "command" || !options.signal) {
    return call();
  }

  return withAbort(options.signal, call);
}

async function acquireLimit(options: Runner): Promise<{ wakeAt: string } | undefined> {
  const { rateLimit: key, rateLimits, record, store, clock } = options;

  if (key === undefined) {
    return undefined;
  }

  const limit = Object.hasOwn(rateLimits ?? {}, key) ? rateLimits?.[key] : undefined;

  if (!limit) {
    return failStep(
      options,
      new Error(`Rate limit '${key}' is not configured. Add it to rateLimits in config.json.`),
    );
  }

  const now = new Date(clock.now()).toISOString();
  const result = await store.acquireRateLimit(key, limit.count, limit.windowMs, now);

  if (result.ok) {
    return undefined;
  }

  await put(options, {
    ...record,
    attempt: options.stored?.attempt ?? 0,
    status: "retrying",
    error: `Rate limit '${key}' reached. Retrying at ${result.retryAt}.`,
    nextRetryAt: result.retryAt,
    endedAt: now,
  });

  return { wakeAt: result.retryAt };
}

async function execute<T extends Json>(
  options: Runner,
  fn: () => T | Promise<T>,
): Promise<{ output: T } | { wakeAt: string }> {
  const { record } = options;
  const limited = await acquireLimit(options);

  if (limited) {
    return limited;
  }

  await put(options, { ...record, status: "running" });
  let output: T;

  try {
    output = await invoke(options, fn);
  } catch (cause) {
    return failAttempt(options, cause);
  }

  if (options.signal?.aborted) {
    return failAttempt(options, options.signal.reason);
  }

  try {
    assertJson(output, `Output of step '${record.key}'`);
  } catch (cause) {
    return failStep(options, cause);
  }

  return { output };
}

export async function succeed<T extends Json>(options: Runner, output: T): Promise<T> {
  const { record, activation, clock } = options;

  const order = await activation.terminal((finishOrder) =>
    put(options, {
      ...record,
      status: "succeeded",
      output,
      endedAt: new Date(clock.now()).toISOString(),
      finishOrder,
    }),
  );

  return activation.queue(order, "live", () => output);
}

export async function runSleep(options: Runner, milliseconds: number): Promise<null> {
  const { stored, clock, activation } = options;
  const record = { ...options.record, attempt: 1 };

  const wakeAt =
    stored?.status === "sleeping"
      ? stored.wakeAt
      : new Date(clock.now() + milliseconds).toISOString();

  activation.start();

  try {
    if (Date.parse(wakeAt) <= clock.now()) {
      return await succeed({ ...options, record }, null);
    }

    await put(options, { ...record, status: "sleeping", wakeAt });
  } finally {
    activation.end();
  }

  return activation.block(wakeAt);
}

export async function runStep<T extends Json>(
  options: Runner,
  fn: () => T | Promise<T>,
): Promise<T> {
  const { stored, activation, clock } = options;

  const wakeAt = stored?.status === "retrying" ? stored.nextRetryAt : undefined;

  if (wakeAt !== undefined && Date.parse(wakeAt) > clock.now()) {
    return activation.block(wakeAt);
  }

  activation.start();

  try {
    const result = await execute(options, fn);

    if ("wakeAt" in result) {
      return activation.block(result.wakeAt);
    }

    return await succeed(options, result.output);
  } finally {
    activation.end();
  }
}
