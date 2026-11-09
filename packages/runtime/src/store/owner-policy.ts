import type { RunRecord } from "@loopy/core";

type OwnerIdentity = Pick<NonNullable<RunRecord["owner"]>, "pid" | "host">;

export interface SqlOwnerPolicy {
  readonly identity: OwnerIdentity;
  // A live local process protects its lease. Cloud owners use () => false.
  isAlive(owner: OwnerIdentity): boolean;
}

export type SqlStoreOptions = { owner: SqlOwnerPolicy; leaseMs?: number };

/** The first millisecond at which an owner that is not alive has lost its lease. */
export function leaseExpiresAt(heartbeatAt: string, leaseMs: number): number {
  return Date.parse(heartbeatAt) + leaseMs + 1;
}
