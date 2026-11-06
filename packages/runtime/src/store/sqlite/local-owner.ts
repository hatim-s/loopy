import { hostname } from "node:os";
import { errnoCode } from "@loopy/core";
import type { SqlOwnerPolicy } from "./owner-policy";

export function localOwnerPolicy(): SqlOwnerPolicy {
  const host = hostname();

  return {
    identity: { pid: process.pid, host },
    isAlive(owner) {
      if (owner.pid === null || owner.host !== host) {
        return false;
      }

      try {
        process.kill(owner.pid, 0);

        return true;
      } catch (error) {
        return errnoCode(error) !== "ESRCH";
      }
    },
  };
}
