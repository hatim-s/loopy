import { setTimeout as delay } from "node:timers/promises";

interface WaitOptions {
  /** Generous by default: a passing test never waits this long, and a loaded machine needs headroom. */
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

type Settled<T> = Exclude<T, false | null | undefined>;

const isSettled = <T>(value: T): value is Settled<T> =>
  value !== false && value !== null && value !== undefined;

/**
 * Polls `check` until it returns a value other than false, null or undefined and returns that
 * value. Running out of time throws with the label, so a stuck condition names itself.
 */
export async function until<T>(
  label: string,
  check: () => T | Promise<T>,
  { timeoutMs = 15_000, intervalMs = 10 }: WaitOptions = {},
): Promise<Settled<T>> {
  const deadline = performance.now() + timeoutMs;

  for (;;) {
    const value = await check();

    if (isSettled(value)) {
      return value;
    }

    if (performance.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.`);
    }

    await delay(intervalMs);
  }
}

export function waitForFile(path: string, options?: WaitOptions) {
  return until(`${path} to exist`, () => Bun.file(path).exists(), options);
}

/** Settles with `promise`, or throws with the label once `ms` pass first. */
export async function bounded<T>(promise: Promise<T>, label: string, ms: number): Promise<T> {
  const timer = new AbortController();

  try {
    return await Promise.race([
      promise,
      delay(ms, undefined, { signal: timer.signal }).then(() => {
        throw new Error(`${label} exceeded ${ms} ms.`);
      }),
    ]);
  } finally {
    timer.abort();
  }
}
