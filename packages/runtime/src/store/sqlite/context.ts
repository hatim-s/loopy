import type { RuntimeEvent } from "@loopy/core";
import type { SqlDriver } from "./driver";
import type { SqlOwnerPolicy } from "./owner-policy";

export type SqlContext = {
  readonly db: SqlDriver;
  readonly owner: SqlOwnerPolicy;
  readonly leaseMs: number;
};

// One committed write. Every row and event it touches carries the same clock reading.
export type SqlWrite = SqlContext & {
  readonly txn: string;
  readonly now: number;
  readonly at: string;
  readonly events: RuntimeEvent[];
};
