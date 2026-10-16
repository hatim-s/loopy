import type { Clock } from "./clock.js";

export class StepTimeoutError extends Error {
  constructor(key: string, milliseconds: number) {
    super(
      `Step '${key}' exceeded its ${milliseconds}ms timeout. Increase the timeout or reduce its work.`,
    );
    this.name = "StepTimeoutError";
  }
}

export async function withTimeout<T>(
  clock: Clock,
  options: { milliseconds: number; key: string },
  fn: () => T | Promise<T>,
): Promise<T> {
  const { key, milliseconds } = options;
  let cancel = () => {};

  const deadline = new Promise<StepTimeoutError>((resolve) => {
    cancel = clock.timeout(() => resolve(new StepTimeoutError(key, milliseconds)), milliseconds);
  }).then((error) => {
    throw error;
  });

  try {
    return await Promise.race([Promise.resolve().then(fn), deadline]);
  } finally {
    cancel();
  }
}

export async function withAbort<T>(signal: AbortSignal, fn: () => T | Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};

  const interrupted = new Promise<Error>((resolve) => {
    abort = () => resolve(new Error("Step interrupted. Resume the run to retry."));
    signal.addEventListener("abort", abort, { once: true });
  }).then((error) => {
    throw error;
  });

  try {
    return await Promise.race([Promise.resolve().then(fn), interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
