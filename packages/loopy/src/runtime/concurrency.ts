export function parallel<const T extends readonly (() => Promise<unknown>)[]>(
  functions: T,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }>;
export function parallel<T>(functions: readonly (() => Promise<T>)[]): Promise<T[]> {
  return Promise.all(functions.map((fn) => fn()));
}

export async function map<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  options: { concurrency: number },
): Promise<R[]> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("Map concurrency must be a positive integer. Supply at least one worker.");
  }

  const results: R[] = [];
  const entries = items.entries();
  let rejected = false;

  async function worker(): Promise<void> {
    for (let entry = entries.next(); !entry.done && !rejected; entry = entries.next()) {
      const [index, item] = entry.value;

      try {
        results[index] = await fn(item, index);
      } catch (cause) {
        rejected = true;
        throw cause;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, items.length) }, () => worker()),
  );

  return results;
}

export function race<const T extends readonly (() => Promise<unknown>)[]>(
  functions: T,
): Promise<Awaited<ReturnType<T[number]>>>;
export function race<T>(functions: readonly (() => Promise<T>)[]): Promise<T> {
  return Promise.race(functions.map((fn) => fn()));
}
