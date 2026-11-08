import type { ExecutionError } from "../executor";
import type { GraphRetry } from "../graph/nodes";

export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 60_000);
}

export function shouldRetry(error: ExecutionError, policy: GraphRetry): boolean {
  return error.code === "execution" || (error.code === "exit" && policy.retryOnExit);
}
