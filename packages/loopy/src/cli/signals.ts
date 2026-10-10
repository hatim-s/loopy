const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Runs `handler` once on Ctrl+C or kill. Returns a function that removes it again. */
export function onTermination(handler: () => void): () => void {
  for (const signal of TERMINATION_SIGNALS) {
    process.once(signal, handler);
  }

  return () => {
    for (const signal of TERMINATION_SIGNALS) {
      process.removeListener(signal, handler);
    }
  };
}

/** Aborts the work on SIGINT/SIGTERM; the runtime then records where it stopped. */
export function untilSignalled<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const release = onTermination(() => controller.abort());

  return work(controller.signal).finally(release);
}
