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
