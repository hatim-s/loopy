import { CommandExitError } from "./executor.js";

export type RetryPolicy = { attempts?: number; backoff?: "exponential"; retryOn?: "exit" };

export function resolveRetry(policy: RetryPolicy = {}) {
  return { attempts: policy.attempts ?? 3, retryOn: policy.retryOn };
}

export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 60_000);
}

export function shouldRetry(cause: unknown, policy: RetryPolicy): boolean {
  return !(cause instanceof CommandExitError) || policy.retryOn === "exit";
}
