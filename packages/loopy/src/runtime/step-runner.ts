import {
  type EngineStep,
  errorMessage,
  isNumber,
  type Json,
  type StepBase,
} from "../core/index.js";
import type { Activation } from "./activation.js";
import type { Clock } from "./clock.js";
import { assertJson } from "./json.js";
import { type RetryPolicy, retryDelayMs, shouldRetry } from "./retry.js";
import type { RunStore } from "./store.js";
import { withTimeout } from "./timeout.js";

export class StepFailedError extends Error {
  constructor(key: string, error: string) {
    super(
      `Step '${key}' failed: ${error.replace(/\.$/, "")}. Fix the step before starting a new run.`,
    );
    this.name = "StepFailedError";
  }
}

type Runner = {
  record: StepBase;
  stored?: EngineStep;
  store: RunStore;
  token: string;
  activation: Activation;
  clock: Clock;
  retry: RetryPolicy;
  timeoutMs?: number;
};

async function put(options: Runner, step: EngineStep): Promise<void> {
  try {
    await options.store.putStep(step.runId, options.token, step);
  } catch (cause) {
    options.activation.fatal = new Error(errorMessage(cause), { cause });
    throw cause;
  }
}

async function fail(options: Runner, cause: unknown): Promise<never> {
  const { record, activation, clock } = options;
  const error = errorMessage(cause);
  await put(options, {
    ...record,
    status: "failed",
    error,
    endedAt: new Date(clock.now()).toISOString(),
    finishOrder: activation.finish(),
  });
  throw new StepFailedError(record.key, error);
}

async function failAttempt(options: Runner, cause: unknown): Promise<{ wakeAt: string }> {
  const { record, clock } = options;

  if (record.attempt >= record.maxAttempts || !shouldRetry(cause, options.retry)) {
    return fail(options, cause);
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

async function execute<T extends Json>(
  options: Runner,
  fn: () => T | Promise<T>,
): Promise<{ output: T } | { wakeAt: string }> {
  const { record, activation, clock } = options;
  await put(options, { ...record, status: "running" });
  let output: T;

  try {
    output =
      options.timeoutMs === undefined
        ? await fn()
        : await withTimeout(clock, { milliseconds: options.timeoutMs, key: record.key }, fn);
  } catch (cause) {
    return failAttempt(options, cause);
  }

  try {
    assertJson(output, `Output of step '${record.key}'`);
  } catch (cause) {
    return fail(options, cause);
  }

  await put(options, {
    ...record,
    status: "succeeded",
    output,
    endedAt: new Date(clock.now()).toISOString(),
    finishOrder: activation.finish(),
  });

  return { output };
}

async function sleep(options: Runner, milliseconds: number): Promise<string | undefined> {
  const { stored, clock, record } = options;

  const wakeAt =
    stored?.status === "sleeping"
      ? stored.wakeAt
      : new Date(clock.now() + milliseconds).toISOString();

  if (Date.parse(wakeAt) <= clock.now()) {
    return;
  }

  await put(options, { ...record, status: "sleeping", wakeAt });

  return wakeAt;
}

async function attempt<T extends Json>(options: Runner, fn: () => T | Promise<T>) {
  const { record } = options;

  if (record.kind === "sleep" && isNumber(record.input)) {
    const wakeAt = await sleep(options, record.input);

    if (wakeAt !== undefined) {
      return { wakeAt };
    }
  }

  return execute(options, fn);
}

export async function runStep<T extends Json>(
  options: Runner,
  fn: () => T | Promise<T>,
): Promise<T> {
  const { stored, activation, clock } = options;

  const wakeAt =
    stored?.status === "retrying"
      ? stored.nextRetryAt
      : stored?.status === "sleeping"
        ? stored.wakeAt
        : undefined;

  if (wakeAt !== undefined && Date.parse(wakeAt) > clock.now()) {
    return activation.block(wakeAt);
  }

  activation.running++;
  let result;

  try {
    result = await attempt(options, fn);
  } finally {
    activation.running--;
  }

  if ("wakeAt" in result) {
    return activation.block(result.wakeAt);
  }

  return result.output;
}
