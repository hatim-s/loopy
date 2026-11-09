import { hostname } from "node:os";
import { processAlive } from "../../os";
import type { SqlOwnerPolicy } from "./owner-policy";

export function localOwnerPolicy(): SqlOwnerPolicy {
  const host = hostname();

  return {
    identity: { pid: process.pid, host },
    isAlive: (owner) => owner.pid !== null && owner.host === host && processAlive(owner.pid),
  };
}
