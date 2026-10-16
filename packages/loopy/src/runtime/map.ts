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

  async function worker(): Promise<void> {
    for (let entry = entries.next(); !entry.done; entry = entries.next()) {
      const [index, item] = entry.value;
      results[index] = await fn(item, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, items.length) }, worker));

  return results;
}
