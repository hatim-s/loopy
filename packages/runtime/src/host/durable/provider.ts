import type { ExecutionKey, ExecutionSpec, Receipt } from "@loopy/core";
import { Data, type Effect } from "effect";

export class DurableProviderError extends Data.TaggedError("DurableProviderError")<{
  operation: "lookup" | "start";
  reason: "transport" | "protocol";
  message: string;
  cause: unknown;
}> {}

/** Receipts are durable and keyed by the complete execution key and attempt.
 * start atomically deduplicates that identity and returns promptly, without waiting
 * for execution. lookup reports started while work lives, or a finished uncertain
 * result if its worker disappears. A transport failure fails with DurableProviderError instead of returning none.
 */
export interface DurableExecutionProvider {
  lookup(key: ExecutionKey, attempt: number): Effect.Effect<Receipt, DurableProviderError>;
  start(
    key: ExecutionKey,
    attempt: number,
    spec: ExecutionSpec,
  ): Effect.Effect<Receipt, DurableProviderError>;
}
