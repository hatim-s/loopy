import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";

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

// A real-time pause, so polling also makes progress while a TestClock holds Effect time still.
const pause = Effect.promise(() => delay(1));

/** The Effect form of `until` for a check that is itself an Effect. */
export const eventually = <E, R>(
  label: string,
  check: Effect.Effect<boolean, E, R>,
  { timeoutMs = 15_000 }: WaitOptions = {},
) =>
  Effect.gen(function* () {
    const deadline = performance.now() + timeoutMs;

    while (!(yield* check)) {
      if (performance.now() >= deadline) {
        return yield* Effect.die(
          new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.`),
        );
      }

      yield* pause;
    }
  });

export function waitForFile(path: string, options?: WaitOptions) {
  return until(`${path} to exist`, () => Bun.file(path).exists(), options);
}

/** Waits until no process has `pid`. EPERM means the process exists under another owner. */
export function waitForExit(pid: number, options?: WaitOptions) {
  return until(
    `process ${pid} to exit`,
    () => {
      try {
        process.kill(pid, 0);

        return false;
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "EPERM") {
          return false;
        }

        if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") {
          return true;
        }

        throw cause;
      }
    },
    options,
  );
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
