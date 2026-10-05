import type { RuntimeIdentity, TenantScope } from "../application/ports.js";

export type DispatchDelivery = {
  kind: "start" | "cancel";
  id: string;
  runId: string;
  runtime: RuntimeIdentity;
  leaseToken: string;
};

/** Every claim uses a fresh token. Ack/retry reject expired or replaced leases. */
export interface OutboxStore {
  readonly scope: TenantScope;
  claimDispatch(token: string, ttlMs: number, limit: number): Promise<DispatchDelivery[]>;
  ackDispatch(id: string, token: string): Promise<boolean>;
  retryDispatch(id: string, token: string, error: string): Promise<boolean>;
}

/** The host reconciles an existing coordinator by tenant/run identity before starting one.
 * Cancellation must persist even if the coordinator has not started yet.
 */
export interface DurableDriver {
  ensureStarted(scope: TenantScope, runId: string, runtime: RuntimeIdentity): Promise<void>;
  cancel(scope: TenantScope, runId: string): Promise<void>;
}

/** Delivery can repeat after a lost acknowledgement. The driver owns start deduplication. */
export async function dispatchPending(
  store: OutboxStore,
  driver: DurableDriver,
  options: { limit?: number; ttlMs?: number } = {},
): Promise<{ delivered: number; retried: number; stale: number }> {
  const limit = options.limit ?? 20;
  const ttlMs = options.ttlMs ?? 30_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Dispatch limit must be between 1 and 100");
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000)
    throw new Error("Dispatch lease must be between 1 and 60000 milliseconds");
  const deliveries = await store.claimDispatch(crypto.randomUUID(), ttlMs, limit);
  let delivered = 0;
  let retried = 0;
  let stale = 0;
  for (const delivery of deliveries) {
    try {
      if (delivery.kind === "cancel") await driver.cancel(store.scope, delivery.runId);
      else await driver.ensureStarted(store.scope, delivery.runId, delivery.runtime);
    } catch {
      // Provider errors can contain command text or credentials. Persist a fixed error.
      if (
        await store.retryDispatch(delivery.id, delivery.leaseToken, "Coordinator dispatch failed")
      )
        retried++;
      else stale++;
      continue;
    }
    if (await store.ackDispatch(delivery.id, delivery.leaseToken)) delivered++;
    else stale++;
  }
  return { delivered, retried, stale };
}
