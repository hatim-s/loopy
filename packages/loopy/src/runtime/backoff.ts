export type RetryPolicy = { attempts?: number; backoff?: "exponential"; retryOn?: "exit" };

export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 60_000);
}
