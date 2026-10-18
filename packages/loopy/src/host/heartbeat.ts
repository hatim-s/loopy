import { type Store, StoreError, toError } from "../core/index.js";
import { type Clock, SYSTEM_CLOCK } from "./clock.js";

export async function withHeartbeat<T>(
  store: Store,
  runId: string,
  token: string,
  fn: () => Promise<T>,
  clock: Clock = SYSTEM_CLOCK,
): Promise<T> {
  const controller = new AbortController();
  const lost = Promise.withResolvers<never>();
  const interval = Math.max(250, store.leaseMs / 4);

  const heartbeat = (async () => {
    while (!controller.signal.aborted) {
      await clock.sleep(interval, controller.signal);

      if (controller.signal.aborted) {
        return;
      }

      if (!(await store.heartbeat(runId, token))) {
        throw new StoreError("owned_elsewhere");
      }
    }
  })().catch((cause) => lost.reject(toError(cause)));

  try {
    return await Promise.race([fn(), lost.promise]);
  } finally {
    controller.abort();
    await heartbeat;
  }
}
