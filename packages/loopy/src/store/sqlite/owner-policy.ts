import type { RunRecord } from "../../core/index.js";

type OwnerIdentity = Pick<NonNullable<RunRecord["owner"]>, "pid" | "host">;

export interface SqlOwnerPolicy {
  readonly identity: OwnerIdentity;
  // A live local process protects its lease. Cloud owners use () => false.
  isAlive(owner: OwnerIdentity): boolean;
}

export type SqlStoreOptions = {
  owner: SqlOwnerPolicy;
  now?: () => number;
  leaseMs?: number;
};
