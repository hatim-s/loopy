const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"] as const;

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
