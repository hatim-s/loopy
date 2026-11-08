import { Effect } from "effect";

type PollOptions<T> = {
  timeoutMs: number;
  intervalMs: number;
  timeout: (last: T | undefined) => Error;
};

export async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  options: PollOptions<T>,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let last: T | undefined;

  while (Date.now() < deadline) {
    last = await read();

    if (accept(last)) {
      return last;
    }

    await Bun.sleep(options.intervalMs);
  }

  throw options.timeout(last);
}

export function untilEffect<T, E, R, F>(
  read: () => Effect.Effect<T, E, R>,
  accept: (value: T) => boolean,
  options: { timeoutMs: number; intervalMs: number; timeout: () => F },
) {
  return Effect.gen(function* () {
    const deadline = Date.now() + options.timeoutMs;

    while (Date.now() < deadline) {
      const value = yield* read();

      if (accept(value)) {
        return value;
      }

      yield* Effect.sleep(options.intervalMs);
    }

    return yield* Effect.fail(options.timeout());
  });
}
